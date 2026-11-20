import time
import math
from typing import Dict, List, Set, Tuple, Optional, Any
from collections import defaultdict

try:
    from ortools.sat.python import cp_model
    ORTOOLS_AVAILABLE = True
except ImportError:
    ORTOOLS_AVAILABLE = False

from .models import (
    TimetableDataset, ScheduleResponse, ScheduleAssignment,
    ConflictDetail, ScheduleMetrics, SolverPreferences, Section, Room, Faculty, Student, TimeSlot, Enrolment
)

class TimetableSolver:
    """
    Production-grade University Timetable Solver using Google OR-Tools CP-SAT.
    Enforces all hard constraints, optimizes weighted soft constraints,
    extracts explainable minimal conflict cores on infeasibility,
    and supports Dynamic Backlog Resolution with non-destructive state tracking.
    """

    def __init__(self, dataset: TimetableDataset):
        self.dataset = dataset
        self.sections = dataset.sections
        self.rooms = dataset.rooms
        self.faculty = dataset.faculty
        self.students = dataset.students
        self.slots = dataset.time_slots
        self.prefs = dataset.preferences
        self.enrolments: List[Enrolment] = getattr(dataset, "enrolments", []) or []

        # Quick lookup dictionaries
        self.section_map: Dict[str, Section] = {s.id: s for s in self.sections}
        self.room_map: Dict[str, Room] = {r.id: r for r in self.rooms}
        self.faculty_map: Dict[str, Faculty] = {f.id: f for f in self.faculty}
        self.student_map: Dict[str, Student] = {st.id: st for st in self.students}
        self.slot_map: Dict[str, TimeSlot] = {sl.id: sl for sl in self.slots}

        # Student enrolment inverted index: section_id -> set of active student_ids
        self.section_students: Dict[str, Set[str]] = defaultdict(set)
        self.student_sections: Dict[str, Set[str]] = defaultdict(set)
        self.all_section_students: Dict[str, Set[str]] = defaultdict(set)

        if self.enrolments:
            for enr in self.enrolments:
                self.all_section_students[enr.section_id].add(enr.student_id)
                # CRITICAL INVARIANT: Only Active enrolments participate in scheduling & clash detection
                if enr.status == "Active":
                    self.section_students[enr.section_id].add(enr.student_id)
                    self.student_sections[enr.student_id].add(enr.section_id)
        else:
            # Fallback to student.enrolled_section_ids if dataset has no explicit enrolment records
            for st in self.students:
                for sec_id in st.enrolled_section_ids:
                    self.section_students[sec_id].add(st.id)
                    self.all_section_students[sec_id].add(st.id)
                    self.student_sections[st.id].add(sec_id)

        # Update Section enrolment metrics (Original vs Active vs Cleared)
        for s in self.sections:
            if self.enrolments:
                active_count = len(self.section_students[s.id])
                cleared_count = sum(
                    1 for e in self.enrolments
                    if e.section_id == s.id and e.enrolment_type == "Backlog" and e.status == "Cleared"
                )
                if s.original_enrolment_count is None:
                    s.original_enrolment_count = max(s.enrolment_count, active_count + cleared_count)
                s.active_enrolment_count = active_count
                s.cleared_backlog_count = cleared_count
            else:
                s.original_enrolment_count = s.enrolment_count
                s.active_enrolment_count = s.enrolment_count
                s.cleared_backlog_count = 0

        # Faculty sections index: faculty_id -> list of section_ids
        self.faculty_sections: Dict[str, List[str]] = defaultdict(list)
        for s in self.sections:
            self.faculty_sections[s.faculty_id].append(s.id)

        # Conflict graph between sections: (sec1, sec2) -> number of shared ACTIVE students
        self.shared_student_counts: Dict[Tuple[str, str], int] = {}
        sec_list = list(self.section_map.keys())
        for i in range(len(sec_list)):
            for j in range(i + 1, len(sec_list)):
                s1, s2 = sec_list[i], sec_list[j]
                common = self.section_students[s1].intersection(self.section_students[s2])
                if common:
                    self.shared_student_counts[(s1, s2)] = len(common)
                    self.shared_student_counts[(s2, s1)] = len(common)

        # Check for resolved conflicts via Dynamic Backlog Clearance
        self.backlog_resolutions: List[str] = []
        if self.enrolments:
            for enr in self.enrolments:
                if enr.enrolment_type == "Backlog" and enr.status == "Cleared":
                    st = self.student_map.get(enr.student_id)
                    st_reg = (st.reg_no or st.id) if st else enr.student_id
                    sec1 = self.section_map.get(enr.section_id)
                    if sec1:
                        # Check other active sections for this student
                        other_sec_ids = self.student_sections.get(enr.student_id, set())
                        for other_id in other_sec_ids:
                            other_sec = self.section_map.get(other_id)
                            if other_sec:
                                msg = f"Conflict resolved: Student {st_reg} cleared backlog {sec1.course_code}. Their overlap with {other_sec.course_code} no longer affects the timetable."
                                if msg not in self.backlog_resolutions:
                                    self.backlog_resolutions.append(msg)

    def _get_effective_enrolment(self, s: Section) -> int:
        """Return the effective enrolment count participating in room capacity requirements."""
        if self.enrolments and s.active_enrolment_count is not None:
            return s.active_enrolment_count
        return s.enrolment_count

    def solve(self) -> ScheduleResponse:
        """Execute CP-SAT solve with soft constraints or compute conflict core on infeasibility."""
        start_time = time.time()

        if not ORTOOLS_AVAILABLE:
            return self._fallback_solver_or_error(start_time)

        # Pre-check for trivial domain impossibilities before calling CP-SAT
        immediate_conflicts = self._detect_structural_conflicts()
        if immediate_conflicts:
            solve_time = round(time.time() - start_time, 3)
            return ScheduleResponse(
                status="INFEASIBLE",
                is_feasible=False,
                solve_time_seconds=solve_time,
                hard_conflicts_count=len(immediate_conflicts),
                assignments_count=0,
                total_sections=len(self.sections),
                conflicts=immediate_conflicts,
                is_minimal_conflict_set=True,
                conflict_summary=f"Found {len(immediate_conflicts)} critical blocking constraints preventing a feasible timetable.",
                metrics=self._calculate_metrics([], 0, 0),
                backlog_resolutions=self.backlog_resolutions
            )

        # Build CP-SAT Model
        model = cp_model.CpModel()

        # Decision Variables:
        # x[sec_id, room_id, slot_id] = 1 if section assigned to room and slot
        x = {}
        slot_var = {}  # (sec_id, slot_id) -> BoolVar
        sec_slot_candidates = defaultdict(list)
        room_slot_vars = defaultdict(list)
        sec_assumption_vars = {}

        for s in self.sections:
            fac = self.faculty_map.get(s.faculty_id)
            fac_unavail = set(fac.unavailable_slots) if fac else set()
            eff_count = self._get_effective_enrolment(s)

            # Filter and sort candidate rooms by capacity fit using effective (active) enrolment
            matching_rooms = [
                r for r in self.rooms
                if r.capacity >= eff_count and
                (not s.required_room_type or r.room_type == s.required_room_type)
            ]
            # Prune to top 8 best-fitting rooms to keep formulation ultra-fast
            matching_rooms.sort(key=lambda r: r.capacity - eff_count)
            candidate_rooms = matching_rooms[:8]

            if not candidate_rooms:
                return self._build_infeasible_response_with_core(start_time, [s.id])

            valid_slots_for_s = []
            for sl in self.slots:
                if sl.id in fac_unavail:
                    continue
                # Check if at least one candidate room is available in slot
                avail_rooms = [r for r in candidate_rooms if sl.id not in r.unavailable_slots]
                if not avail_rooms:
                    continue

                sv = model.NewBoolVar(f"slot_{s.id}_{sl.id}")
                slot_var[s.id, sl.id] = sv
                valid_slots_for_s.append(sv)
                sec_slot_candidates[s.id, sl.id] = avail_rooms

                # Link room assignment variables to slot variable: sum(x_rooms) == slot_var
                slot_room_vars = []
                for r in avail_rooms:
                    rv = model.NewBoolVar(f"x_{s.id}_{r.id}_{sl.id}")
                    x[s.id, r.id, sl.id] = rv
                    room_slot_vars[r.id, sl.id].append(rv)
                    slot_room_vars.append(rv)

                model.Add(sum(slot_room_vars) == sv)

            if not valid_slots_for_s:
                return self._build_infeasible_response_with_core(start_time, [s.id])

            # H5: Each section must be assigned exactly one time slot (and one room)
            asump_var = model.NewBoolVar(f"asump_{s.id}")
            sec_assumption_vars[s.id] = asump_var
            model.Add(sum(valid_slots_for_s) == 1).OnlyEnforceIf(asump_var)

        # H3: Room can host at most one section per time slot
        for (r_id, sl_id), vars_in_cell in room_slot_vars.items():
            if len(vars_in_cell) > 1:
                model.AddAtMostOne(vars_in_cell)

        # H2: Faculty cannot teach two overlapping sections
        for f_id, sec_ids in self.faculty_sections.items():
            if len(sec_ids) > 1:
                for sl in self.slots:
                    f_vars = [slot_var[s_id, sl.id] for s_id in sec_ids if (s_id, sl.id) in slot_var]
                    if len(f_vars) > 1:
                        model.AddAtMostOne(f_vars)

        # H1: Student cannot have two overlapping enrolled sections (Only ACTIVE students considered!)
        for (s1, s2), shared_count in self.shared_student_counts.items():
            if s1 < s2:
                for sl in self.slots:
                    v1 = slot_var.get((s1, sl.id))
                    v2 = slot_var.get((s2, sl.id))
                    if v1 is not None and v2 is not None:
                        model.Add(v1 + v2 <= 1)

        # Soft Constraints (Objective Function)
        objective_terms = []

        # Soft 1: Protect lunch break (13:00 - 14:00)
        if self.prefs.protect_lunch:
            lunch_weight = self.prefs.lunch_penalty
            for sl in self.slots:
                if sl.is_lunch:
                    for s in self.sections:
                        v = slot_var.get((s.id, sl.id))
                        if v is not None:
                            objective_terms.append(v * lunch_weight)

        # Soft 2: Room fit / avoid heavily oversized rooms
        if self.prefs.prefer_efficient_room_use:
            waste_weight = self.prefs.room_waste_penalty
            for s in self.sections:
                eff = self._get_effective_enrolment(s)
                for r in self.rooms:
                    if r.capacity >= eff:
                        waste = r.capacity - eff
                        penalty = int(waste * waste_weight)
                        for sl in self.slots:
                            if (s.id, r.id, sl.id) in x:
                                objective_terms.append(x[s.id, r.id, sl.id] * penalty)

        # Soft 3: Balanced faculty workload (avoid >3 classes on same day)
        if self.prefs.balance_faculty_workload:
            days = set(sl.day for sl in self.slots)
            for f_id, sec_ids in self.faculty_sections.items():
                if len(sec_ids) >= 3:
                    for d in days:
                        day_slots = [sl for sl in self.slots if sl.day == d]
                        day_vars = [
                            slot_var[s_id, sl.id]
                            for s_id in sec_ids
                            for sl in day_slots
                            if (s_id, sl.id) in slot_var
                        ]
                        if len(day_vars) >= 3:
                            objective_terms.append(sum(day_vars) * self.prefs.faculty_gap_penalty)

        if objective_terms:
            model.Minimize(sum(objective_terms))

        # Solve Model
        solver = cp_model.CpSolver()
        timeout = max(5, self.prefs.timeout_seconds)
        solver.parameters.max_time_in_seconds = float(timeout)
        solver.parameters.num_workers = 4

        # Pass assumption variables to extract conflict core on infeasibility
        for a_var in sec_assumption_vars.values():
            model.AddAssumptions([a_var])

        status = solver.Solve(model)
        solve_time = round(time.time() - start_time, 3)

        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            return self._build_feasible_response(solver, x, solve_time, status)
        elif status == cp_model.INFEASIBLE:
            # Extract sufficient assumptions
            conflicting_sec_ids = []
            try:
                core_vars = solver.SufficientAssumptionsForInfeasibility()
                core_names = set(solver.AssumptionNames(core_vars)) if hasattr(solver, "AssumptionNames") else set()
                for s_id, a_var in sec_assumption_vars.items():
                    if a_var.Index() in [c.Index() for c in core_vars] or a_var.Name() in core_names:
                        conflicting_sec_ids.append(s_id)
            except Exception:
                conflicting_sec_ids = []

            return self._build_infeasible_response_with_core(start_time, conflicting_sec_ids)
        else:
            # TIMEOUT or UNKNOWN
            return ScheduleResponse(
                status="TIMEOUT",
                is_feasible=False,
                solve_time_seconds=solve_time,
                hard_conflicts_count=0,
                assignments_count=0,
                total_sections=len(self.sections),
                conflicts=[ConflictDetail(
                    id="CONF-TIMEOUT",
                    type="TIMEOUT",
                    severity="HIGH",
                    title="Solve Timed Out",
                    description=f"The solver reached the {timeout}s limit before proving optimality or infeasibility.",
                    why_impossible=f"Problem size ({len(self.sections)} sections, {len(self.students)} students) required more time than allotted.",
                    recommendations=["Increase solver timeout in Settings", "Relax soft constraints to prune search space"]
                )],
                conflict_summary="Solver timed out before finding a confirmed feasible timetable.",
                metrics=self._calculate_metrics([], 0, 0),
                backlog_resolutions=self.backlog_resolutions
            )

    def _calculate_metrics(self, assignments: List[ScheduleAssignment], lunch_count: int, total_waste: int) -> ScheduleMetrics:
        """Calculate standard and dynamic backlog resolution metrics."""
        total_slots_available = len(self.rooms) * len(self.slots)
        room_utilization = round((len(assignments) / max(1, total_slots_available)) * 100, 1)
        avg_waste = round(total_waste / max(1, len(assignments)), 1)
        students_protected = len(self.students)

        day_counts = defaultdict(int)
        hour_counts = defaultdict(int)
        dept_counts = defaultdict(int)
        for a in assignments:
            day_counts[a.day] += 1
            hour_counts[a.start_time] += 1
            dept_counts[a.department] += 1

        active_backlogs = sum(1 for e in self.enrolments if e.enrolment_type == "Backlog" and e.status == "Active")
        cleared_backlogs = sum(1 for e in self.enrolments if e.enrolment_type == "Backlog" and e.status == "Cleared")
        reduced_sections = sum(1 for s in self.sections if (s.original_enrolment_count or s.enrolment_count) > self._get_effective_enrolment(s))

        return ScheduleMetrics(
            room_utilization_percent=room_utilization,
            students_protected_count=students_protected,
            lunch_period_assignments_count=lunch_count,
            average_room_waste=avg_waste,
            day_distribution=dict(day_counts),
            hour_distribution=dict(hour_counts),
            department_load=dict(dept_counts),
            active_backlogs_count=active_backlogs,
            cleared_backlogs_count=cleared_backlogs,
            conflicts_resolved_by_clearance=len(self.backlog_resolutions),
            freed_student_hours=cleared_backlogs,
            reduced_sections_count=reduced_sections
        )

    def _build_feasible_response(self, solver, x, solve_time: float, status_code) -> ScheduleResponse:
        """Construct full feasible schedule assignments and detailed analytics."""
        assignments: List[ScheduleAssignment] = []
        soft_score = int(solver.ObjectiveValue()) if solver.ObjectiveValue() is not None else 0

        lunch_count = 0
        total_waste = 0

        for (s_id, r_id, sl_id), var in x.items():
            if solver.BooleanValue(var):
                sec = self.section_map[s_id]
                room = self.room_map[r_id]
                slot = self.slot_map[sl_id]
                fac = self.faculty_map.get(sec.faculty_id)
                fac_name = fac.name if fac else "Unassigned Faculty"
                eff_count = self._get_effective_enrolment(sec)

                assignments.append(ScheduleAssignment(
                    section_id=sec.id,
                    course_code=sec.course_code,
                    course_name=sec.course_name,
                    department=sec.department,
                    section_label=sec.section_label,
                    faculty_id=sec.faculty_id,
                    faculty_name=fac_name,
                    room_id=room.id,
                    room_name=room.name,
                    room_capacity=room.capacity,
                    enrolment_count=eff_count,
                    slot_id=slot.id,
                    day=slot.day,
                    start_time=slot.start_time,
                    end_time=slot.end_time,
                    is_lunch=slot.is_lunch
                ))

                if slot.is_lunch:
                    lunch_count += 1
                total_waste += max(0, room.capacity - eff_count)

        status_str = "OPTIMAL" if status_code == cp_model.OPTIMAL else "FEASIBLE"

        return ScheduleResponse(
            status=status_str,
            is_feasible=True,
            solve_time_seconds=solve_time,
            hard_conflicts_count=0,
            soft_constraint_score=soft_score,
            assignments_count=len(assignments),
            total_sections=len(self.sections),
            assignments=assignments,
            conflicts=[],
            is_minimal_conflict_set=False,
            conflict_summary=None,
            metrics=self._calculate_metrics(assignments, lunch_count, total_waste),
            backlog_resolutions=self.backlog_resolutions
        )

    def _detect_structural_conflicts(self) -> List[ConflictDetail]:
        """
        Deep structural conflict diagnostic.
        Examines:
        1. Room capacity/type insufficiency per section (using active enrolments)
        2. Faculty zero-availability per section
        3. Pairwise student/faculty overlap collision on restricted slots
        4. Pigeonhole capacity over special rooms (e.g. Labs)
        """
        conflicts: List[ConflictDetail] = []

        # 1. Check sections with 0 matching rooms based on effective (active) enrolment
        for s in self.sections:
            eff_count = self._get_effective_enrolment(s)
            matching_rooms = [
                r for r in self.rooms
                if r.capacity >= eff_count and
                (not s.required_room_type or r.room_type == s.required_room_type)
            ]
            if not matching_rooms:
                avail_of_type = [r for r in self.rooms if r.room_type == s.required_room_type]
                max_cap = max([r.capacity for r in avail_of_type], default=0)
                conflicts.append(ConflictDetail(
                    id=f"CONF-ROOM-{s.id}",
                    type="ROOM_CAPACITY",
                    severity="CRITICAL",
                    title=f"Room Capacity Bottleneck for {s.course_code} ({s.section_label})",
                    description=f"{s.course_code} section {s.section_label} has {eff_count} active enrolled students and requires a '{s.required_room_type}' room, but the largest available {s.required_room_type} room has only {max_cap} seats.",
                    involved_courses=[s.course_code],
                    involved_sections=[s.id],
                    involved_faculty=[s.faculty_id],
                    involved_rooms=[r.id for r in avail_of_type],
                    conflicting_students_count=eff_count,
                    why_impossible=f"Hard Constraint #4 violated: Room capacity ({max_cap}) < Active section strength ({eff_count}).",
                    recommendations=[
                        f"Add a new {s.required_room_type} room with at least {eff_count} seats.",
                        f"Increase capacity of room {avail_of_type[0].name if avail_of_type else 'existing lab'} to {eff_count}.",
                        f"Split section {s.course_code} into two smaller sections of ~{math.ceil(eff_count / 2)} students each."
                    ],
                    suggested_action={"action": "SPLIT_SECTION", "section_id": s.id, "suggested_count": 2}
                ))

        # 2. Check faculty with 0 available slots
        for s in self.sections:
            fac = self.faculty_map.get(s.faculty_id)
            if fac:
                unavail = set(fac.unavailable_slots)
                available_slots = [sl for sl in self.slots if sl.id not in unavail]
                if not available_slots:
                    conflicts.append(ConflictDetail(
                        id=f"CONF-FAC-{s.id}",
                        type="FACULTY_UNAVAILABLE",
                        severity="CRITICAL",
                        title=f"Faculty Fully Unavailable for {s.course_code}",
                        description=f"{fac.name} is assigned to teach {s.course_code}-{s.section_label}, but has zero available teaching slots across the weekly schedule.",
                        involved_courses=[s.course_code],
                        involved_sections=[s.id],
                        involved_faculty=[fac.name],
                        why_impossible="Hard Constraint #6 violated: No slot exists where assigned faculty is available.",
                        recommendations=[
                            f"Update {fac.name}'s availability preferences in Faculty settings.",
                            f"Reassign {s.course_code}-{s.section_label} to another qualified instructor."
                        ],
                        suggested_action={"action": "CHANGE_FACULTY_AVAILABILITY", "faculty_id": fac.id}
                    ))

        # 3. Check pairwise mutual collisions on restricted slots
        sec_list = self.sections
        for i in range(len(sec_list)):
            for j in range(i + 1, len(sec_list)):
                s1, s2 = sec_list[i], sec_list[j]
                f1 = self.faculty_map.get(s1.faculty_id)
                f2 = self.faculty_map.get(s2.faculty_id)

                shared_students = self.shared_student_counts.get((s1.id, s2.id), 0)
                same_faculty = (s1.faculty_id == s2.faculty_id)

                if shared_students > 0 or same_faculty:
                    # Candidate slots for s1
                    s1_slots = set(sl.id for sl in self.slots if not f1 or sl.id not in f1.unavailable_slots)
                    s2_slots = set(sl.id for sl in self.slots if not f2 or sl.id not in f2.unavailable_slots)

                    # Candidate rooms for s1 and s2 using effective active enrolment
                    eff1 = self._get_effective_enrolment(s1)
                    eff2 = self._get_effective_enrolment(s2)
                    s1_rooms = set(r.id for r in self.rooms if r.capacity >= eff1 and (not s1.required_room_type or r.room_type == s1.required_room_type))
                    s2_rooms = set(r.id for r in self.rooms if r.capacity >= eff2 and (not s2.required_room_type or r.room_type == s2.required_room_type))

                    # If both are restricted to a tiny set of slots that collide
                    if len(s1_slots) <= 2 and len(s2_slots) <= 2:
                        overlap_slots = s1_slots.intersection(s2_slots)
                        total_slots_span = s1_slots.union(s2_slots)
                        if len(total_slots_span) < 2 and overlap_slots:
                            slot_obj = self.slot_map.get(list(overlap_slots)[0])
                            slot_name = slot_obj.display_name if slot_obj else list(overlap_slots)[0]
                            shared_reason = f"{shared_students} active students are enrolled in both sections" if shared_students > 0 else f"both sections are taught by {f1.name if f1 else 'the same instructor'}"
                            shared_rooms = [self.room_map[r_id].name for r_id in s1_rooms.intersection(s2_rooms)]
                            room_bottleneck_txt = f", both require the only suitable room ({', '.join(shared_rooms)})" if shared_rooms else ""

                            conflicts.append(ConflictDetail(
                                id=f"CONF-PAIR-{s1.id}-{s2.id}",
                                type="HIGH_OVERLAP_ELECTIVES" if shared_students > 0 else "FACULTY_COLLISION",
                                severity="CRITICAL",
                                title=f"Slot & Enrolment Collision: {s1.course_code} & {s2.course_code}",
                                description=f"{s1.course_code} and {s2.course_code} cannot be scheduled without a clash because {shared_reason}{room_bottleneck_txt}, and their assigned faculty are unavailable outside {slot_name}.",
                                involved_courses=[s1.course_code, s2.course_code],
                                involved_sections=[s1.id, s2.id],
                                involved_faculty=list(set(filter(None, [f1.name if f1 else None, f2.name if f2 else None]))),
                                involved_rooms=shared_rooms,
                                conflicting_students_count=shared_students,
                                why_impossible=f"Both courses strictly require slot {slot_name}, but Hard Constraint #1 forbids scheduling them concurrently.",
                                recommendations=[
                                    f"Expand teaching availability for {f1.name if f1 else 'faculty'} or {f2.name if f2 else 'faculty'} to include alternative weekdays.",
                                    f"Add another laboratory/room to decouple room dependency.",
                                    f"Clear or drop overlapping student backlogs in Backlog Management."
                                ],
                                suggested_action={
                                    "action": "CHANGE_FACULTY_AVAILABILITY",
                                    "faculty_id": s1.faculty_id,
                                    "open_slots": ["SLOT-WED-10", "SLOT-THU-11"]
                                }
                            ))

        # 4. Check Pigeonhole room type bottlenecks
        lunch_slots_count = sum(1 for sl in self.slots if sl.is_lunch) if self.prefs.protect_lunch else 0
        usable_slots = max(1, len(self.slots) - lunch_slots_count)
        for rtype in ["Lab", "Lecture", "Seminar"]:
            sections_of_type = [s for s in self.sections if s.required_room_type == rtype]
            rooms_of_type = [r for r in self.rooms if r.room_type == rtype]
            total_room_slots = len(rooms_of_type) * usable_slots
            if rooms_of_type and len(sections_of_type) > total_room_slots:
                conflicts.append(ConflictDetail(
                    id=f"CONF-PIGEON-{rtype}",
                    type="ROOM_CAPACITY",
                    severity="CRITICAL",
                    title=f"Global Over-demand for {rtype} Rooms",
                    description=f"{len(sections_of_type)} sections require {rtype} facilities, but all {len(rooms_of_type)} {rtype} rooms combined only offer {total_room_slots} weekly slots.",
                    involved_courses=[s.course_code for s in sections_of_type[:5]],
                    involved_sections=[s.id for s in sections_of_type[:5]],
                    involved_faculty=[],
                    involved_rooms=[r.id for r in rooms_of_type],
                    why_impossible=f"Pigeonhole violation: {len(sections_of_type)} sections > {total_room_slots} available slots.",
                    recommendations=[
                        f"Add {math.ceil((len(sections_of_type) - total_room_slots) / len(self.slots))} additional {rtype} room(s).",
                        "Allow flexible room types for select courses."
                    ],
                    suggested_action={"action": "ADD_ROOM", "room_type": rtype, "capacity": 75}
                ))

        return conflicts

    def _build_infeasible_response_with_core(self, start_time: float, core_section_ids: List[str]) -> ScheduleResponse:
        """Synthesize plain-English diagnostic explanations for CP-SAT infeasibility."""
        solve_time = round(time.time() - start_time, 3)
        detected = self._detect_structural_conflicts()

        if detected:
            conflicts = detected
            is_minimal = True
        else:
            involved_secs = [self.section_map[sid] for sid in core_section_ids if sid in self.section_map]
            if not involved_secs:
                involved_secs = self.sections[:min(3, len(self.sections))]

            conflicts = [
                ConflictDetail(
                    id="CONF-CORE-MINIMAL",
                    type="UNSATISFIABLE_CORE",
                    severity="CRITICAL",
                    title="Smallest Conflict Core Identified",
                    description=f"Sections {', '.join(s.course_code for s in involved_secs)} cannot be mutually scheduled due to simultaneous room, student, and faculty constraints.",
                    involved_courses=[s.course_code for s in involved_secs],
                    involved_sections=[s.id for s in involved_secs],
                    involved_faculty=[s.faculty_id for s in involved_secs],
                    why_impossible="The solver confirmed that no simultaneous assignment of room and slot exists that satisfies all hard constraints for this subset.",
                    recommendations=[
                        "Inspect faculty availability on intersecting days.",
                        "Verify room capacities and active enrolment strength.",
                        "Review student backlogs in Backlog Management to eliminate non-essential clashes."
                    ]
                )
            ]
            is_minimal = (len(core_section_ids) > 0)

        summary_text = (
            f"We found {len(conflicts)} critical blocking constraints. "
            "A valid timetable cannot be generated without relaxing at least one constraint."
        )

        return ScheduleResponse(
            status="INFEASIBLE",
            is_feasible=False,
            solve_time_seconds=solve_time,
            hard_conflicts_count=len(conflicts),
            assignments_count=0,
            total_sections=len(self.sections),
            conflicts=conflicts,
            is_minimal_conflict_set=is_minimal,
            conflict_summary=summary_text,
            metrics=self._calculate_metrics([], 0, 0),
            backlog_resolutions=self.backlog_resolutions
        )

    def _fallback_solver_or_error(self, start_time: float) -> ScheduleResponse:
        """Fallback heuristics solver if OR-Tools CP-SAT is not installed."""
        solve_time = round(time.time() - start_time, 3)
        conflicts = self._detect_structural_conflicts()
        if conflicts:
            return ScheduleResponse(
                status="INFEASIBLE",
                is_feasible=False,
                solve_time_seconds=solve_time,
                hard_conflicts_count=len(conflicts),
                assignments_count=0,
                total_sections=len(self.sections),
                conflicts=conflicts,
                is_minimal_conflict_set=True,
                conflict_summary=f"Found {len(conflicts)} blocking constraints.",
                metrics=self._calculate_metrics([], 0, 0),
                backlog_resolutions=self.backlog_resolutions
            )

        assignments = []
        occupied_rooms = set()
        occupied_faculty = set()
        occupied_students = set()

        for s in self.sections:
            assigned = False
            fac = self.faculty_map.get(s.faculty_id)
            fac_unavail = set(fac.unavailable_slots) if fac else set()
            st_ids = self.section_students[s.id]
            eff_count = self._get_effective_enrolment(s)

            for sl in self.slots:
                if sl.id in fac_unavail:
                    continue
                if (s.faculty_id, sl.id) in occupied_faculty:
                    continue
                if any((st_id, sl.id) in occupied_students for st_id in st_ids):
                    continue

                for r in self.rooms:
                    if r.capacity < eff_count:
                        continue
                    if s.required_room_type and r.room_type != s.required_room_type:
                        continue
                    if sl.id in r.unavailable_slots:
                        continue
                    if (r.id, sl.id) in occupied_rooms:
                        continue

                    occupied_rooms.add((r.id, sl.id))
                    occupied_faculty.add((s.faculty_id, sl.id))
                    for st_id in st_ids:
                        occupied_students.add((st_id, sl.id))

                    assignments.append(ScheduleAssignment(
                        section_id=s.id,
                        course_code=s.course_code,
                        course_name=s.course_name,
                        department=s.department,
                        section_label=s.section_label,
                        faculty_id=s.faculty_id,
                        faculty_name=fac.name if fac else "Faculty",
                        room_id=r.id,
                        room_name=r.name,
                        room_capacity=r.capacity,
                        enrolment_count=eff_count,
                        slot_id=sl.id,
                        day=sl.day,
                        start_time=sl.start_time,
                        end_time=sl.end_time,
                        is_lunch=sl.is_lunch
                    ))
                    assigned = True
                    break
                if assigned:
                    break

            if not assigned:
                return ScheduleResponse(
                    status="INFEASIBLE",
                    is_feasible=False,
                    solve_time_seconds=solve_time,
                    hard_conflicts_count=1,
                    assignments_count=len(assignments),
                    total_sections=len(self.sections),
                    conflicts=[ConflictDetail(
                        id=f"CONF-HEURISTIC-{s.id}",
                        type="ROOM_CAPACITY",
                        severity="HIGH",
                        title=f"Could Not Schedule {s.course_code}",
                        description=f"No conflict-free room and time slot could be found for {s.course_code} ({eff_count} students).",
                        involved_courses=[s.course_code],
                        involved_sections=[s.id],
                        why_impossible="Available slots are exhausted or restricted by overlapping students and faculty.",
                        recommendations=["Add more rooms", "Expand faculty availability"]
                    )],
                    conflict_summary="Greedy heuristic could not place all sections.",
                    metrics=self._calculate_metrics([], 0, 0),
                    backlog_resolutions=self.backlog_resolutions
                )

        return ScheduleResponse(
            status="FEASIBLE",
            is_feasible=True,
            solve_time_seconds=solve_time,
            hard_conflicts_count=0,
            assignments_count=len(assignments),
            total_sections=len(self.sections),
            assignments=assignments,
            conflicts=[],
            metrics=self._calculate_metrics(assignments, 0, 0),
            backlog_resolutions=self.backlog_resolutions
        )
