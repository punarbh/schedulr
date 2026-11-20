import os
import csv
import io
import time
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field
from fastapi import FastAPI, HTTPException, UploadFile, File, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from .models import (
    TimetableDataset, ScheduleResponse, WhatIfRequest,
    Section, Room, Faculty, Student, TimeSlot, ConflictDetail,
    Enrolment, BacklogAuditLog, EnrolmentStatusUpdate
)
from .solver import TimetableSolver, ORTOOLS_AVAILABLE
from .sample_data import get_feasible_demo, get_impossible_demo, generate_large_simulation, get_backlog_resolution_demo

app = FastAPI(
    title="Schedulr API",
    description="Intelligent Timetable Clash Resolver API powered by Google OR-Tools CP-SAT with Dynamic Backlog Resolution",
    version="1.1.0"
)

# Enable CORS for local dev servers
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

class UpdateStatusPayload(BaseModel):
    enrolment_id: str = Field(alias="enrolmentId")
    status: str  # "Active", "Cleared", "Dropped", "Pending"
    updated_by: Optional[str] = Field(default="Admin (Academic Office)", alias="updatedBy")
    notes: Optional[str] = None
    dataset: Optional[TimetableDataset] = None

    class Config:
        populate_by_name = True

@app.get("/api/health")
def health_check():
    return {
        "status": "healthy",
        "ortools_available": ORTOOLS_AVAILABLE,
        "engine": "Google OR-Tools CP-SAT" if ORTOOLS_AVAILABLE else "Backtracking Heuristic Fallback",
        "timestamp": time.time()
    }

@app.get("/api/scenarios/feasible", response_model=TimetableDataset)
def get_feasible_scenario():
    """Retrieve the deterministic Feasible Demo dataset."""
    dataset = get_feasible_demo()
    CURRENT_SCHEDULE["dataset"] = dataset
    # Reset last response
    CURRENT_SCHEDULE["last_response"] = None
    return dataset

@app.get("/api/scenarios/impossible", response_model=TimetableDataset)
def get_impossible_scenario():
    """Retrieve the Impossible Conflict Demo dataset with explainable bottlenecks."""
    dataset = get_impossible_demo()
    CURRENT_SCHEDULE["dataset"] = dataset
    CURRENT_SCHEDULE["last_response"] = None
    return dataset

@app.get("/api/scenarios/large", response_model=TimetableDataset)
def get_large_scenario():
    """Retrieve the 1,500 students / 120 sections benchmark dataset."""
    dataset = generate_large_simulation()
    CURRENT_SCHEDULE["dataset"] = dataset
    CURRENT_SCHEDULE["last_response"] = None
    return dataset

@app.get("/api/scenarios/backlog-demo")
def get_backlog_demo_scenario():
    """
    Dedicated demo scenario for Dynamic Backlog Resolution.
    Returns student Alex Vance (2026CS104) with an active backlog CS201-A
    overlapping with elective EE204-A, with master timetable pre-computed.
    """
    demo_pack = get_backlog_resolution_demo()
    dataset = demo_pack["dataset"]
    schedule_data = demo_pack["schedule"]

    CURRENT_SCHEDULE["dataset"] = dataset
    CURRENT_SCHEDULE["last_response"] = ScheduleResponse(**schedule_data)

    return {
        "dataset": dataset,
        "schedule": schedule_data
    }

@app.post("/api/solve", response_model=ScheduleResponse)
def solve_schedule(dataset: TimetableDataset):
    """Run the CP-SAT solver on submitted dataset."""
    try:
        solver = TimetableSolver(dataset)
        response = solver.solve()
        CURRENT_SCHEDULE["dataset"] = dataset
        CURRENT_SCHEDULE["last_response"] = response
        return response
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Solver execution failed: {str(e)}")

@app.post("/api/enrolments/update-status")
def update_enrolment_status(payload: UpdateStatusPayload):
    """
    Dynamic Backlog Resolution endpoint:
    Updates enrolment status (e.g. Active -> Cleared) non-destructively:
    - Automatically frees student's personal timetable slot
    - Preserves audit record
    - Keeps master timetable stable for all other students/rooms/faculty
    - Recalculates section active counts and room utilisation metrics
    - Removes resolved student conflicts from Conflict Lab
    - Offers optional re-optimisation CTA
    """
    dataset = payload.dataset or CURRENT_SCHEDULE.get("dataset")
    if not dataset:
        dataset = get_feasible_demo()
        CURRENT_SCHEDULE["dataset"] = dataset

    enrolment = next((e for e in dataset.enrolments if e.id == payload.enrolment_id), None)
    if not enrolment:
        raise HTTPException(status_code=404, detail=f"Enrolment with ID '{payload.enrolment_id}' not found.")

    prev_status = enrolment.status
    new_status = payload.status
    now_str = time.strftime("%Y-%m-%d %H:%M:%S")

    # Update enrolment record non-destructively
    enrolment.status = new_status
    enrolment.status_updated_at = now_str
    enrolment.updated_by = payload.updated_by or "Admin (Academic Office)"
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
    slot_info_str = "scheduled slot"
    freed_slot_data = None

    if last_resp and last_resp.assignments:
        sec_assignment = next((a for a in last_resp.assignments if a.section_id == enrolment.section_id), None)
        if sec_assignment:
            slot_info_str = f"{sec_assignment.day} {sec_assignment.start_time}-{sec_assignment.end_time}"
            freed_slot_data = {
                "day": sec_assignment.day,
                "start_time": sec_assignment.start_time,
                "end_time": sec_assignment.end_time,
                "slot_id": sec_assignment.slot_id,
                "room_name": sec_assignment.room_name,
                "course_code": course_code,
                "section_id": sec.id if sec else "",
                "status": "Freed",
                "label": f"Free after backlog cleared ({course_code})"
            }

    # Construct human-friendly confirmation message per specification
    if new_status == "Cleared":
        confirmation_msg = f"Backlog cleared. The student’s {slot_info_str} slot is now free. The master timetable remains unchanged."
    elif new_status == "Active":
        confirmation_msg = f"Backlog reactivated for {st_name} ({st_reg}) in {course_code}. Student timetable updated."
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
            # Check if this student had a conflict involving this section
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
                    # Remove or decrement conflict
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
            # If reactivated and student has another course in that slot, restore clash alert
            if freed_slot_data and last_resp.assignments:
                # Check what other active courses student has
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

        # Refresh metrics
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
def validate_dataset(dataset: TimetableDataset):
    """Validate timetable data integrity, foreign key references, enrolments, and basic feasibility."""
    errors = []
    warnings = []

    room_ids = {r.id for r in dataset.rooms}
    faculty_ids = {f.id for f in dataset.faculty}
    slot_ids = {s.id for s in dataset.time_slots}
    sec_ids = {s.id for s in dataset.sections}
    st_ids = {st.id for st in dataset.students}

    # Validate Sections
    for s in dataset.sections:
        if s.faculty_id not in faculty_ids:
            errors.append(f"Section {s.course_code} ({s.id}) references unknown faculty ID '{s.faculty_id}'.")
        if s.enrolment_count <= 0:
            errors.append(f"Section {s.course_code} has invalid enrolment count {s.enrolment_count}.")

    # Validate Students
    for st in dataset.students:
        for enrolled_id in st.enrolled_section_ids:
            if enrolled_id not in sec_ids:
                warnings.append(f"Student {st.name} ({st.id}) enrolled in nonexistent section '{enrolled_id}'.")

    # Validate Enrolments
    for enr in dataset.enrolments:
        if enr.student_id not in st_ids:
            errors.append(f"Enrolment {enr.id} references nonexistent student '{enr.student_id}'.")
        if enr.section_id not in sec_ids:
            errors.append(f"Enrolment {enr.id} references nonexistent section '{enr.section_id}'.")
        if enr.status not in ["Active", "Cleared", "Dropped", "Pending"]:
            errors.append(f"Enrolment {enr.id} has invalid status '{enr.status}'.")

    # Validate Rooms & Slots
    for r in dataset.rooms:
        for slot in r.unavailable_slots:
            if slot not in slot_ids:
                warnings.append(f"Room {r.name} references nonexistent unavailable slot '{slot}'.")

    for f in dataset.faculty:
        for slot in f.unavailable_slots:
            if slot not in slot_ids:
                warnings.append(f"Faculty {f.name} references nonexistent unavailable slot '{slot}'.")

    return {
        "is_valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "stats": {
            "sections": len(dataset.sections),
            "rooms": len(dataset.rooms),
            "faculty": len(dataset.faculty),
            "students": len(dataset.students),
            "slots": len(dataset.time_slots),
            "enrolments": len(dataset.enrolments),
            "active_backlogs": sum(1 for e in dataset.enrolments if e.enrolment_type == "Backlog" and e.status == "Active"),
            "cleared_backlogs": sum(1 for e in dataset.enrolments if e.enrolment_type == "Backlog" and e.status == "Cleared")
        }
    }

@app.post("/api/simulate-what-if", response_model=ScheduleResponse)
def simulate_what_if(req: WhatIfRequest):
    """
    Apply a proposed remedy to the dataset and re-solve.
    Simulates remedies:
    - ADD_ROOM: Adds a new room with given type & capacity
    - INCREASE_ROOM_CAPACITY: Increases capacity of a bottleneck room
    - OPEN_SLOT: Removes an unavailable slot from faculty or room
    - CHANGE_FACULTY_AVAILABILITY: Opens up slots for a faculty member
    - SPLIT_SECTION: Splits a large section into two halves
    """
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

            # Create second half
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

            # Re-distribute students enrolled in original section
            enrolled_students = [st for st in dataset.students if orig_sec.id in st.enrolled_section_ids]
            for idx, st in enumerate(enrolled_students):
                if idx >= half1:
                    st.enrolled_section_ids.remove(orig_sec.id)
                    st.enrolled_section_ids.append(sec_b.id)
                    # Update enrolment if present
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
    """Download template CSV for data entry."""
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
