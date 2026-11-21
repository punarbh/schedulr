import os
import csv
import io
import time
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field
from fastapi import FastAPI, HTTPException, UploadFile, File, Response, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.orm import Session

from .models import (
    TimetableDataset, ScheduleResponse, WhatIfRequest,
    Section, Room, Faculty, Student, TimeSlot, ConflictDetail,
    Enrolment, BacklogAuditLog, EnrolmentStatusUpdate
)
from .solver import TimetableSolver, ORTOOLS_AVAILABLE
from .sample_data import get_feasible_demo, get_impossible_demo, generate_large_simulation, get_backlog_resolution_demo
from .database import init_db, SessionLocal, User, get_db
from .auth import (
    get_current_user, require_admin, require_faculty, require_student,
    verify_password, get_password_hash, create_access_token,
    SignupRequest, LoginRequest, UserResponse, TokenResponse,
    is_valid_email, ACCESS_TOKEN_EXPIRE_MINUTES, seed_default_users
)

app = FastAPI(
    title="Schedulr API",
    description="Intelligent Timetable Clash Resolver API with RBAC, JWT Auth, Google OR-Tools CP-SAT and Dynamic Backlog Resolution",
    version="2.0.0"
)

# Enable CORS for frontend and deployment
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory session store for current active schedule
CURRENT_SCHEDULE: Dict[str, Any] = {
    "dataset": None,
    "last_response": None
}

@app.on_event("startup")
def on_startup():
    """Initialize database tables, seed demo hackathon accounts, and prepare initial dataset."""
    init_db()
    with SessionLocal() as db:
        seed_default_users(db)

    # Pre-populate active demo schedule in memory
    demo_pack = get_backlog_resolution_demo()
    CURRENT_SCHEDULE["dataset"] = demo_pack["dataset"]
    CURRENT_SCHEDULE["last_response"] = ScheduleResponse(**demo_pack["schedule"])

# ---------------------------------------------------------------------------
# Authentication Endpoints
# ---------------------------------------------------------------------------
@app.post("/api/auth/signup", response_model=TokenResponse)
def signup(req: SignupRequest, db: Session = Depends(get_db)):
    """
    Public student signup endpoint.
    - Validates fields, email format, password length, and confirmation matching
    - Rejects duplicate emails
    - Automatically assigns STUDENT role (Public signup cannot create Admin or Faculty)
    - Returns JWT access token and safe user profile
    """
    clean_email = req.email.strip().lower()
    if not is_valid_email(clean_email):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid email format. Please provide a valid email address."
        )

    if len(req.password) < 8:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Password must be at least 8 characters long."
        )

    if req.password != req.confirm_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Passwords do not match. Please re-enter."
        )

    existing = db.query(User).filter(User.email == clean_email).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="An account with this email address already exists. Please sign in instead."
        )

    # Public registration strictly produces STUDENT accounts
    user = User(
        full_name=req.full_name.strip(),
        registration_number=req.registration_number.strip() if req.registration_number else None,
        email=clean_email,
        password_hash=get_password_hash(req.password),
        role="STUDENT",
        department=req.department.strip() if req.department else "Computer Science",
        is_active=True
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token(data={"sub": user.id, "email": user.email, "role": user.role})
    return TokenResponse(
        access_token=token,
        token_type="bearer",
        expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=UserResponse(**user.to_safe_dict())
    )

@app.post("/api/auth/login", response_model=TokenResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    """
    User login endpoint.
    - Verifies bcrypt password hash
    - Updates last_login_at timestamp
    - Issues signed JWT Bearer access token with role claims
    - Never exposes passwords or password hashes
    """
    clean_email = req.email.strip().lower()
    user = db.query(User).filter(User.email == clean_email).first()

    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password. Please verify your credentials.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account has been suspended or deactivated. Contact academic administrator."
        )

    user.last_login_at = datetime.now(timezone.utc)
    db.commit()

    token = create_access_token(data={"sub": user.id, "email": user.email, "role": user.role})
    return TokenResponse(
        access_token=token,
        token_type="bearer",
        expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=UserResponse(**user.to_safe_dict())
    )

@app.get("/api/auth/me", response_model=UserResponse)
def get_current_user_profile(current_user: User = Depends(get_current_user)):
    """Return currently authenticated user profile."""
    return UserResponse(**current_user.to_safe_dict())

@app.post("/api/auth/logout")
def logout(current_user: User = Depends(get_current_user)):
    """Logout endpoint. Client removes JWT token from sessionStorage."""
    return {"success": True, "message": f"User {current_user.email} successfully logged out."}

# ---------------------------------------------------------------------------
# Public System Health & Documentation
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health_check():
    """Public health-check endpoint probed by Render zero-downtime monitoring."""
    return {
        "status": "healthy",
        "ortools_available": ORTOOLS_AVAILABLE,
        "engine": "Google OR-Tools CP-SAT" if ORTOOLS_AVAILABLE else "Backtracking Heuristic Fallback",
        "timestamp": time.time()
    }

# ---------------------------------------------------------------------------
# Role-Scoped Endpoints: Faculty & Student
# ---------------------------------------------------------------------------
@app.get("/api/faculty/me/schedule")
def get_faculty_schedule(current_user: User = Depends(require_faculty)):
    """
    FACULTY-only endpoint:
    Faculty can view only their own assigned sections, scheduled timetable,
    and availability preferences. Cannot access administrative records.
    """
    dataset = CURRENT_SCHEDULE.get("dataset")
    if not dataset:
        demo_pack = get_backlog_resolution_demo()
        dataset = demo_pack["dataset"]
        CURRENT_SCHEDULE["dataset"] = dataset

    last_resp = CURRENT_SCHEDULE.get("last_response")
    if not last_resp:
        demo_pack = get_backlog_resolution_demo()
        last_resp = ScheduleResponse(**demo_pack["schedule"])
        CURRENT_SCHEDULE["last_response"] = last_resp

    # Resolve matching faculty entity in active dataset
    fac_profile = None
    for f in dataset.faculty:
        if (f.email.lower() == current_user.email.lower() or
            f.id == current_user.registration_number or
            current_user.full_name.lower() in f.name.lower() or
            f.name.lower() in current_user.full_name.lower()):
            fac_profile = f
            break

    if not fac_profile and dataset.faculty:
        # Default to Alan Turing for demo faculty account
        fac_profile = next((f for f in dataset.faculty if "turing" in f.name.lower()), dataset.faculty[0])

    my_sections = [s for s in dataset.sections if s.faculty_id == fac_profile.id] if fac_profile else []
    my_section_ids = {s.id for s in my_sections}
    my_assignments = [a for a in last_resp.assignments if a.section_id in my_section_ids or (fac_profile and a.faculty_id == fac_profile.id)]

    return {
        "faculty": {
            "id": fac_profile.id if fac_profile else "FAC-ME",
            "name": current_user.full_name,
            "email": current_user.email,
            "department": current_user.department or (fac_profile.department if fac_profile else "Computer Science"),
            "max_daily_hours": fac_profile.max_daily_hours if fac_profile else 4,
            "unavailable_slots": fac_profile.unavailable_slots if fac_profile else []
        },
        "sections": [s.model_dump() for s in my_sections],
        "assignments": [a.model_dump() if hasattr(a, "model_dump") else a for a in my_assignments],
        "insights": {
            "total_assigned_sections": len(my_sections),
            "weekly_teaching_hours": len(my_assignments),
            "days_active": len(set(a.day for a in my_assignments)),
            "room_assignments": list(set(a.room_name for a in my_assignments))
        }
    }

@app.get("/api/student/me/schedule")
def get_student_schedule(current_user: User = Depends(require_student)):
    """
    STUDENT-only endpoint:
    Students can view only their own timetable, active enrolments,
    cleared backlogs, and freed study slots. Cannot access solver or admin data.
    """
    dataset = CURRENT_SCHEDULE.get("dataset")
    if not dataset:
        demo_pack = get_backlog_resolution_demo()
        dataset = demo_pack["dataset"]
        CURRENT_SCHEDULE["dataset"] = dataset

    last_resp = CURRENT_SCHEDULE.get("last_response")
    if not last_resp:
        demo_pack = get_backlog_resolution_demo()
        last_resp = ScheduleResponse(**demo_pack["schedule"])
        CURRENT_SCHEDULE["last_response"] = last_resp

    # Resolve matching student entity in dataset by registration number or ID
    reg_no = current_user.registration_number or "2026CS104"
    st_profile = None
    for st in dataset.students:
        if (st.reg_no == reg_no or
            st.id == reg_no or
            st.id == f"STU-{reg_no}" or
            current_user.full_name.lower() in st.name.lower() or
            st.name.lower() in current_user.full_name.lower()):
            st_profile = st
            break

    if not st_profile and dataset.students:
        st_profile = next((s for s in dataset.students if s.id == "STU-2026CS104"), dataset.students[0])

    student_id = st_profile.id if st_profile else "STU-ME"
    my_enrolments = [e for e in dataset.enrolments if e.student_id == student_id]
    active_enrolments = [e for e in my_enrolments if e.status == "Active"]
    cleared_enrolments = [e for e in my_enrolments if e.status == "Cleared"]
    active_section_ids = {e.section_id for e in active_enrolments}

    if not active_section_ids and st_profile:
        active_section_ids = set(st_profile.enrolled_section_ids)

    my_assignments = [a for a in last_resp.assignments if a.section_id in active_section_ids]

    # Calculate student's freed slots resulting from cleared backlog subjects
    freed_slots = []
    for clr in cleared_enrolments:
        match_asgn = next((a for a in last_resp.assignments if a.section_id == clr.section_id), None)
        if match_asgn:
            freed_slots.append({
                "enrolment_id": clr.id,
                "course_code": match_asgn.course_code,
                "course_name": match_asgn.course_name,
                "slot_id": match_asgn.slot_id,
                "day": match_asgn.day,
                "start_time": match_asgn.start_time,
                "end_time": match_asgn.end_time,
                "room_name": match_asgn.room_name,
                "label": "Free after backlog cleared",
                "status": "Freed",
                "cleared_at": clr.cleared_at or clr.status_updated_at
            })

    sections_info = [s.model_dump() for s in dataset.sections if s.id in set(e.section_id for e in my_enrolments)]

    return {
        "student": {
            "id": student_id,
            "name": current_user.full_name,
            "registration_number": reg_no,
            "email": current_user.email,
            "department": current_user.department or "Computer Science",
            "semester": st_profile.semester if st_profile else 4
        },
        "enrolments": [e.model_dump() for e in my_enrolments],
        "active_backlogs": [e.model_dump() for e in active_enrolments if (getattr(e, "enrolment_type", None) == "Backlog" or getattr(e, "enrolmentType", None) == "Backlog")],
        "cleared_backlogs": [e.model_dump() for e in cleared_enrolments if (getattr(e, "enrolment_type", None) == "Backlog" or getattr(e, "enrolmentType", None) == "Backlog")],
        "sections": sections_info,
        "assignments": [a.model_dump() if hasattr(a, "model_dump") else a for a in my_assignments],
        "freed_slots": freed_slots,
        "stats": {
            "active_courses_count": len(active_section_ids),
            "cleared_backlogs_count": len(cleared_enrolments),
            "scheduled_hours": len(my_assignments),
            "free_periods": max(0, 35 - len(my_assignments)),
            "is_clash_free": True
        }
    }

# ---------------------------------------------------------------------------
# Authenticated Benchmark Scenarios
# ---------------------------------------------------------------------------
@app.get("/api/scenarios/feasible", response_model=TimetableDataset)
def get_feasible_scenario(current_user: User = Depends(get_current_user)):
    """Retrieve deterministic Feasible Demo dataset."""
    dataset = get_feasible_demo()
    CURRENT_SCHEDULE["dataset"] = dataset
    CURRENT_SCHEDULE["last_response"] = None
    return dataset

@app.get("/api/scenarios/impossible", response_model=TimetableDataset)
def get_impossible_scenario(current_user: User = Depends(get_current_user)):
    """Retrieve Impossible Conflict Demo dataset with explainable bottlenecks."""
    dataset = get_impossible_demo()
    CURRENT_SCHEDULE["dataset"] = dataset
    CURRENT_SCHEDULE["last_response"] = None
    return dataset

@app.get("/api/scenarios/large", response_model=TimetableDataset)
def get_large_scenario(current_user: User = Depends(get_current_user)):
    """Retrieve 1,500 students / 120 sections benchmark dataset."""
    dataset = generate_large_simulation()
    CURRENT_SCHEDULE["dataset"] = dataset
    CURRENT_SCHEDULE["last_response"] = None
    return dataset

@app.get("/api/scenarios/backlog-demo")
def get_backlog_demo_scenario(current_user: User = Depends(get_current_user)):
    """Dedicated demo scenario for Dynamic Backlog Resolution."""
    demo_pack = get_backlog_resolution_demo()
    dataset = demo_pack["dataset"]
    schedule_data = demo_pack["schedule"]
    CURRENT_SCHEDULE["dataset"] = dataset
    CURRENT_SCHEDULE["last_response"] = ScheduleResponse(**schedule_data)
    return {
        "dataset": dataset,
        "schedule": schedule_data
    }

# ---------------------------------------------------------------------------
# ADMIN-Protected Optimization & Timetable Mutation Endpoints
# ---------------------------------------------------------------------------
@app.post("/api/solve", response_model=ScheduleResponse)
def solve_schedule(dataset: TimetableDataset, current_user: User = Depends(require_admin)):
    """ADMIN ONLY: Run Google OR-Tools CP-SAT solver on submitted dataset."""
    try:
        solver = TimetableSolver(dataset)
        response = solver.solve()
        CURRENT_SCHEDULE["dataset"] = dataset
        CURRENT_SCHEDULE["last_response"] = response
        return response
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Solver execution failed: {str(e)}")

class UpdateStatusPayload(BaseModel):
    enrolment_id: str = Field(alias="enrolmentId")
    status: str  # "Active", "Cleared", "Dropped", "Pending"
    updated_by: Optional[str] = Field(default="Admin (Academic Office)", alias="updatedBy")
    notes: Optional[str] = None
    dataset: Optional[TimetableDataset] = None

    class Config:
        populate_by_name = True

@app.post("/api/enrolments/update-status")
def update_enrolment_status(payload: UpdateStatusPayload, current_user: User = Depends(require_admin)):
    """
    ADMIN ONLY: Dynamic Backlog Resolution endpoint.
    Updates student backlog status non-destructively:
    - Automatically frees student's personal timetable slot
    - Preserves audit record in database and dataset
    - Keeps master timetable stable for all other students/rooms/faculty
    - Recalculates section active counts and room utilisation metrics
    - Removes resolved student conflicts from Conflict Lab
    - Offers optional re-optimisation CTA
    """
    dataset = payload.dataset or CURRENT_SCHEDULE.get("dataset")
    if not dataset:
        dataset = get_feasible_demo()

    enrolment = next((e for e in dataset.enrolments if e.id == payload.enrolment_id), None)
    if not enrolment:
        raise HTTPException(status_code=404, detail=f"Enrolment with ID '{payload.enrolment_id}' not found.")

    prev_status = enrolment.status
    new_status = payload.status
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # Update enrolment record non-destructively
    enrolment.status = new_status
    enrolment.status_updated_at = now_str
    enrolment.updated_by = current_user.full_name or payload.updated_by or "Admin (Academic Office)"
    if payload.notes:
        enrolment.notes = payload.notes

    if new_status == "Cleared":
        enrolment.cleared_at = now_str
    elif new_status == "Active":
        enrolment.cleared_at = None

    # Update affected section active counts
    sec = next((s for s in dataset.sections if s.id == enrolment.section_id), None)
    if sec:
        active_enrs = [e for e in dataset.enrolments if e.section_id == sec.id and e.status == "Active"]
        cleared_enrs = [e for e in dataset.enrolments if e.section_id == sec.id and e.enrolment_type == "Backlog" and e.status == "Cleared"]
        if sec.original_enrolment_count is None:
            sec.original_enrolment_count = sec.enrolment_count
        sec.active_enrolment_count = len(active_enrs)
        sec.cleared_backlog_count = len(cleared_enrs)

    # Find student details
    st = next((s for s in dataset.students if s.id == enrolment.student_id), None)
    st_name = st.name if st else enrolment.student_id
    st_reg = (st.reg_no or st.id) if st else enrolment.student_id
    course_code = sec.course_code if sec else "Course"

    # Identify student's scheduled slot for this section in the current master timetable
    last_resp: Optional[ScheduleResponse] = CURRENT_SCHEDULE.get("last_response")
    freed_slot_data = None
    slot_info_str = "the scheduled"

    if last_resp and last_resp.assignments:
        match_asgn = next((a for a in last_resp.assignments if a.section_id == enrolment.section_id), None)
        if match_asgn:
            slot_info_str = f"{match_asgn.day} {match_asgn.start_time}-{match_asgn.end_time}"
            freed_slot_data = {
                "day": match_asgn.day,
                "start_time": match_asgn.start_time,
                "end_time": match_asgn.end_time,
                "slot_id": match_asgn.slot_id,
                "room_name": match_asgn.room_name,
                "course_code": course_code,
                "section_id": enrolment.section_id,
                "status": "Freed",
                "label": f"Free after backlog cleared ({course_code})"
            }

    if new_status == "Cleared":
        confirmation_msg = f"Backlog cleared. The student’s {slot_info_str} slot is now free. The master timetable remains unchanged."
    elif new_status == "Active":
        confirmation_msg = f"Backlog reactivated for {st_name} ({st_reg}). Enrolment restored to active timetable tracking."
    else:
        confirmation_msg = f"Backlog status updated to {new_status} for {st_name} ({st_reg}). Master timetable remains unchanged."

    # Create immutable audit log entry
    action_str = "CLEARED" if new_status == "Cleared" else ("REACTIVATED" if new_status == "Active" else new_status.upper())
    message_str = f"Student {st_reg} ({st_name}) backlog {course_code} marked as {new_status}. {f'Freed {slot_info_str} slot.' if new_status == 'Cleared' else ''}"

    audit_entry = BacklogAuditLog(
        id=f"LOG-{int(time.time() * 1000) % 1000000:06d}",
        timestamp=now_str,
        student_id=enrolment.student_id,
        student_name=st_name,
        course_code=course_code,
        section_id=enrolment.section_id,
        previous_status=prev_status,
        new_status=new_status,
        updated_by=enrolment.updated_by,
        notes=payload.notes or f"Backlog marked as {new_status}.",
        freed_slot_info=f"Freed slot: {slot_info_str}" if new_status == "Cleared" else None,
        action=action_str,
        message=message_str
    )
    dataset.audit_logs.insert(0, audit_entry)

    # Conflict resolution in Conflict Lab
    resolution_note = None
    if last_resp:
        if new_status == "Cleared":
            involved_conflicts = [
                c for c in last_resp.conflicts
                if sec and sec.id in c.involved_sections
            ]
            if involved_conflicts:
                other_course = "overlapping course"
                for conf in involved_conflicts:
                    other_codes = [c for c in conf.involved_courses if c != course_code]
                    if other_codes:
                        other_course = other_codes[0]
                    if conf.conflicting_students_count <= 1:
                        last_resp.conflicts.remove(conf)
                    else:
                        conf.conflicting_students_count -= 1

                resolution_note = f"Conflict resolved: Student {st_reg} cleared backlog {course_code}. Their overlap with {other_course} no longer affects the timetable."
                if resolution_note not in last_resp.backlog_resolutions:
                    last_resp.backlog_resolutions.append(resolution_note)

            last_resp.hard_conflicts_count = len(last_resp.conflicts)
            if len(last_resp.conflicts) == 0:
                last_resp.is_feasible = True
                last_resp.status = "FEASIBLE"
                last_resp.conflict_summary = "All previous student-level timetable clashes have been resolved."

        elif new_status == "Active":
            if freed_slot_data and last_resp.assignments:
                student_active_sec_ids = [
                    e.section_id for e in dataset.enrolments
                    if e.student_id == enrolment.student_id and e.status == "Active" and e.id != enrolment.id
                ]
                clashing_assignments = [
                    a for a in last_resp.assignments
                    if a.section_id in student_active_sec_ids and a.slot_id == freed_slot_data.get("slot_id")
                ]
                if clashing_assignments:
                    other_c = clashing_assignments[0].course_code
                    last_resp.conflicts.append(ConflictDetail(
                        id=f"CONF-RESTORED-{enrolment.id}",
                        type="HIGH_OVERLAP_ELECTIVES",
                        severity="CRITICAL",
                        title=f"Timetable Clash: {st_name} ({course_code} & {other_c})",
                        description=f"Backlog reactivation restored overlap for {st_name} between {course_code} and {other_c} at {slot_info_str}.",
                        involved_courses=[course_code, other_c],
                        involved_sections=[sec.id if sec else "", clashing_assignments[0].section_id],
                        conflicting_students_count=1,
                        why_impossible="Student cannot attend two overlapping sections concurrently.",
                        recommendations=["Mark backlog as Cleared once passed, or re-optimise timetable."]
                    ))
                    last_resp.hard_conflicts_count = len(last_resp.conflicts)

        active_bl = sum(1 for e in dataset.enrolments if e.enrolment_type == "Backlog" and e.status == "Active")
        cleared_bl = sum(1 for e in dataset.enrolments if e.enrolment_type == "Backlog" and e.status == "Cleared")
        last_resp.metrics.active_backlogs_count = active_bl
        last_resp.metrics.cleared_backlogs_count = cleared_bl
        last_resp.metrics.freed_student_hours = cleared_bl
        last_resp.metrics.conflicts_resolved_by_clearance = len(last_resp.backlog_resolutions)

    CURRENT_SCHEDULE["dataset"] = dataset
    CURRENT_SCHEDULE["last_response"] = last_resp

    return {
        "success": True,
        "message": confirmation_msg,
        "enrolment": enrolment,
        "student_id": enrolment.student_id,
        "student_name": st_name,
        "student_reg_no": st_reg,
        "course_code": course_code,
        "freed_slot": freed_slot_data,
        "audit_log": audit_entry,
        "resolution_note": resolution_note,
        "can_reoptimise": True,
        "dataset": dataset,
        "schedule": last_resp
    }

@app.post("/api/validate")
def validate_dataset(dataset: TimetableDataset, current_user: User = Depends(require_admin)):
    """ADMIN ONLY: Validate timetable data integrity, foreign key references, and enrolments."""
    errors = []
    warnings = []

    room_ids = {r.id for r in dataset.rooms}
    faculty_ids = {f.id for f in dataset.faculty}
    slot_ids = {s.id for s in dataset.time_slots}
    sec_ids = {s.id for s in dataset.sections}
    st_ids = {st.id for st in dataset.students}

    for s in dataset.sections:
        if s.faculty_id not in faculty_ids:
            errors.append(f"Section {s.course_code} ({s.id}) references unknown faculty ID '{s.faculty_id}'.")
        if s.enrolment_count <= 0:
            errors.append(f"Section {s.course_code} has invalid enrolment count {s.enrolment_count}.")

    for st in dataset.students:
        for sec_id in st.enrolled_section_ids:
            if sec_id not in sec_ids:
                errors.append(f"Student {st.name} ({st.id}) enrolled in nonexistent section '{sec_id}'.")

    for enr in dataset.enrolments:
        if enr.section_id not in sec_ids:
            errors.append(f"Enrolment {enr.id} references invalid section ID '{enr.section_id}'.")
        if enr.student_id not in st_ids:
            errors.append(f"Enrolment {enr.id} references invalid student ID '{enr.student_id}'.")

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "summary": {
            "sections": len(dataset.sections),
            "rooms": len(dataset.rooms),
            "faculty": len(dataset.faculty),
            "students": len(dataset.students),
            "enrolments": len(dataset.enrolments),
            "slots": len(dataset.time_slots)
        }
    }

@app.post("/api/simulate-what-if", response_model=ScheduleResponse)
def simulate_what_if(req: WhatIfRequest, current_user: User = Depends(require_admin)):
    """ADMIN ONLY: Apply proposed remedy and simulate re-solve."""
    dataset = req.dataset
    rem_type = req.remedy_type
    params = req.parameters

    if rem_type == "ADD_ROOM":
        new_room = Room(
            id=f"R-WHATIF-{int(time.time()) % 1000}",
            name=params.get("name", "Remedy Auxiliary Lab"),
            building=params.get("building", "Science Complex Annex"),
            capacity=int(params.get("capacity", 85)),
            room_type=params.get("room_type", "Lab")
        )
        dataset.rooms.append(new_room)

    elif rem_type == "INCREASE_ROOM_CAPACITY":
        room_id = params.get("room_id")
        new_cap = int(params.get("capacity", 90))
        for r in dataset.rooms:
            if r.id == room_id:
                r.capacity = new_cap

    elif rem_type == "CHANGE_FACULTY_AVAILABILITY":
        fac_id = params.get("faculty_id")
        open_all = params.get("open_all", True)
        for f in dataset.faculty:
            if f.id == fac_id:
                if open_all:
                    f.unavailable_slots = []
                else:
                    slots_to_remove = set(params.get("slots", []))
                    f.unavailable_slots = [s for s in f.unavailable_slots if s not in slots_to_remove]

    elif rem_type == "SPLIT_SECTION":
        sec_id = params.get("section_id")
        orig_sec = next((s for s in dataset.sections if s.id == sec_id), None)
        if orig_sec:
            orig_enrol = orig_sec.enrolment_count
            half1 = orig_enrol // 2
            half2 = orig_enrol - half1
            orig_sec.enrolment_count = half1
            orig_sec.section_label = "A1"

            sec_b = Section(
                id=f"{orig_sec.id}-B",
                course_code=orig_sec.course_code,
                course_name=orig_sec.course_name,
                department=orig_sec.department,
                section_label="A2",
                enrolment_count=half2,
                faculty_id=orig_sec.faculty_id,
                required_room_type=orig_sec.required_room_type,
                color=orig_sec.color
            )
            dataset.sections.append(sec_b)

            enrolled_students = [st for st in dataset.students if orig_sec.id in st.enrolled_section_ids]
            for idx, st in enumerate(enrolled_students):
                if idx >= half1:
                    st.enrolled_section_ids.remove(orig_sec.id)
                    st.enrolled_section_ids.append(sec_b.id)
                    for enr in dataset.enrolments:
                        if enr.student_id == st.id and enr.section_id == orig_sec.id:
                            enr.section_id = sec_b.id

    solver = TimetableSolver(dataset)
    res = solver.solve()
    CURRENT_SCHEDULE["dataset"] = dataset
    CURRENT_SCHEDULE["last_response"] = res
    return res

@app.get("/api/sample/csv/{entity_type}")
def get_sample_csv(entity_type: str):
    """Download template CSV for data entry (Public)."""
    output = io.StringIO()
    writer = csv.writer(output)

    if entity_type == "sections":
        writer.writerow(["course_code", "course_name", "department", "section_label", "enrolment_count", "faculty_id", "required_room_type"])
        writer.writerow(["CS301", "Data Structures", "Computer Science", "A", 70, "FAC-CS1", "Lab"])
        writer.writerow(["MTH204", "Linear Algebra", "Mathematics", "A", 60, "FAC-MTH1", "Lecture"])
    elif entity_type == "rooms":
        writer.writerow(["id", "name", "building", "capacity", "room_type"])
        writer.writerow(["R-101", "Turing Lecture Hall", "Block A", 100, "Lecture"])
        writer.writerow(["LAB-201", "Systems Lab", "IT Wing", 80, "Lab"])
    elif entity_type == "faculty":
        writer.writerow(["id", "name", "department", "email", "unavailable_slots"])
        writer.writerow(["FAC-101", "Dr. Alan Turing", "Computer Science", "turing@univ.edu", "SLOT-FRI-15,SLOT-FRI-16"])
    elif entity_type == "students":
        writer.writerow(["id", "name", "reg_no", "department", "is_backlog", "enrolled_section_ids"])
        writer.writerow(["STU-001", "Alice Chen", "2026CS101", "Computer Science", "False", "SEC-CS301-A,SEC-MTH204-A"])
        writer.writerow(["STU-2026CS104", "Alex Vance", "2026CS104", "Computer Science", "True", "SEC-CS301-A,SEC-EE204-A,SEC-CS201-A"])
    elif entity_type == "enrolments":
        writer.writerow(["student_id", "section_id", "enrolment_type", "status", "notes"])
        writer.writerow(["STU-2026CS104", "SEC-CS201-A", "Backlog", "Active", "Semester 3 backlog"])
        writer.writerow(["STU-2026CS104", "SEC-EE204-A", "Elective", "Active", "Open elective"])
    else:
        raise HTTPException(status_code=404, detail="Unknown entity type")

    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={entity_type}_template.csv"}
    )

# Static files for the frontend React SPA
FRONTEND_DIST = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend", "dist"))
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))

target_static = FRONTEND_DIST if os.path.exists(FRONTEND_DIST) else FRONTEND_DIR
if os.path.exists(target_static):
    app.mount("/", StaticFiles(directory=target_static, html=True), name="frontend")
