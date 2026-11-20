from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field, ConfigDict

class TimeSlot(BaseModel):
    id: str
    day: str  # "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"
    start_time: str  # "09:00", "10:00", etc.
    end_time: str  # "10:00", "11:00", etc.
    is_lunch: bool = False
    display_name: Optional[str] = None

class Room(BaseModel):
    id: str
    name: str
    building: str
    capacity: int
    room_type: str = "Lecture"  # "Lecture", "Lab", "Seminar", "Auditorium"
    unavailable_slots: List[str] = Field(default_factory=list)  # list of slot IDs

class Faculty(BaseModel):
    id: str
    name: str
    department: str
    email: str
    unavailable_slots: List[str] = Field(default_factory=list)  # list of slot IDs
    max_daily_hours: int = 4

class Student(BaseModel):
    id: str
    name: str
    department: Optional[str] = "Computer Science"
    semester: Optional[int] = 4
    is_backlog: bool = False
    reg_no: Optional[str] = None
    enrolled_section_ids: List[str] = Field(default_factory=list)

class Enrolment(BaseModel):
    """
    Explicit student-to-section enrolment record.
    Supports Dynamic Backlog Resolution: only Active enrolments participate
    in scheduling, room capacity, and student clash checks.
    """
    model_config = ConfigDict(populate_by_name=True)

    id: str
    student_id: str = Field(alias="studentId")
    section_id: str = Field(alias="sectionId")
    enrolment_type: str = Field("Regular", alias="enrolmentType")  # "Regular", "Elective", "Backlog"
    status: str = "Active"  # "Active", "Cleared", "Dropped", "Pending"
    status_updated_at: str = Field(default="", alias="statusUpdatedAt")
    cleared_at: Optional[str] = Field(default=None, alias="clearedAt")
    updated_by: Optional[str] = Field(default="Admin (Academic Office)", alias="updatedBy")
    notes: Optional[str] = None

class Section(BaseModel):
    id: str
    course_code: str  # e.g. "CS301"
    course_name: str  # e.g. "Data Structures & Algorithms"
    department: str  # e.g. "Computer Science"
    section_label: str = "A"  # "A", "B", "C"
    enrolment_count: int  # Master / original nominal count
    original_enrolment_count: Optional[int] = None
    active_enrolment_count: Optional[int] = None
    cleared_backlog_count: Optional[int] = 0
    faculty_id: str
    required_room_type: str = "Lecture"
    duration_slots: int = 1
    color: Optional[str] = None  # UI tag color

class SolverPreferences(BaseModel):
    protect_lunch: bool = True
    lunch_penalty: int = 100
    reduce_back_to_back: bool = True
    back_to_back_penalty: int = 35
    balance_faculty_workload: bool = True
    faculty_gap_penalty: int = 15
    prefer_efficient_room_use: bool = True
    room_waste_penalty: int = 2
    timeout_seconds: int = 30

class ScheduleAssignment(BaseModel):
    section_id: str
    course_code: str
    course_name: str
    department: str
    section_label: str
    faculty_id: str
    faculty_name: str
    room_id: str
    room_name: str
    room_capacity: int
    enrolment_count: int
    slot_id: str
    day: str
    start_time: str
    end_time: str
    is_lunch: bool = False

class ConflictDetail(BaseModel):
    id: str
    type: str  # "ROOM_CAPACITY", "FACULTY_COLLISION", "HIGH_OVERLAP_ELECTIVES", "LUNCH_BOTTLENECK", "FACULTY_UNAVAILABLE", "ROOM_UNAVAILABLE", "UNSATISFIABLE_CORE"
    severity: str  # "CRITICAL", "HIGH", "MEDIUM"
    title: str
    description: str
    involved_courses: List[str] = Field(default_factory=list)
    involved_sections: List[str] = Field(default_factory=list)
    involved_faculty: List[str] = Field(default_factory=list)
    involved_rooms: List[str] = Field(default_factory=list)
    conflicting_students_count: int = 0
    why_impossible: str
    recommendations: List[str] = Field(default_factory=list)
    suggested_action: Optional[Dict[str, Any]] = None

class BacklogAuditLog(BaseModel):
    """Immutable audit trail entry for backlog status transitions."""
    id: str
    timestamp: str
    student_id: str
    student_name: str
    course_code: str
    section_id: str
    previous_status: str
    new_status: str
    updated_by: str
    notes: Optional[str] = None
    freed_slot_info: Optional[str] = None
    action: Optional[str] = None
    message: Optional[str] = None

class ScheduleMetrics(BaseModel):
    room_utilization_percent: float = 0.0
    students_protected_count: int = 0
    faculty_with_gaps_count: int = 0
    lunch_period_assignments_count: int = 0
    back_to_back_violations_count: int = 0
    average_room_waste: float = 0.0
    day_distribution: Dict[str, int] = Field(default_factory=dict)
    hour_distribution: Dict[str, int] = Field(default_factory=dict)
    department_load: Dict[str, int] = Field(default_factory=dict)
    # Dynamic Backlog Resolution metrics
    active_backlogs_count: int = 0
    cleared_backlogs_count: int = 0
    conflicts_resolved_by_clearance: int = 0
    freed_student_hours: int = 0
    reduced_sections_count: int = 0

class ScheduleResponse(BaseModel):
    status: str  # "FEASIBLE", "OPTIMAL", "INFEASIBLE", "TIMEOUT", "ERROR"
    is_feasible: bool
    solve_time_seconds: float
    hard_conflicts_count: int = 0
    soft_constraint_score: int = 0
    assignments_count: int = 0
    total_sections: int = 0
    assignments: List[ScheduleAssignment] = Field(default_factory=list)
    conflicts: List[ConflictDetail] = Field(default_factory=list)
    is_minimal_conflict_set: bool = False
    conflict_summary: Optional[str] = None
    metrics: ScheduleMetrics = Field(default_factory=ScheduleMetrics)
    backlog_resolutions: List[str] = Field(default_factory=list)

class TimetableDataset(BaseModel):
    sections: List[Section]
    rooms: List[Room]
    faculty: List[Faculty]
    students: List[Student]
    time_slots: List[TimeSlot]
    enrolments: List[Enrolment] = Field(default_factory=list)
    audit_logs: List[BacklogAuditLog] = Field(default_factory=list)
    preferences: SolverPreferences = Field(default_factory=SolverPreferences)

class EnrolmentStatusUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    enrolment_id: str = Field(alias="enrolmentId")
    status: str  # "Active", "Cleared", "Dropped", "Pending"
    updated_by: Optional[str] = Field(default="Admin (Academic Office)", alias="updatedBy")
    notes: Optional[str] = None

class WhatIfRequest(BaseModel):
    dataset: TimetableDataset
    remedy_type: str  # "ADD_ROOM", "INCREASE_ROOM_CAPACITY", "OPEN_SLOT", "CHANGE_FACULTY_AVAILABILITY", "SPLIT_SECTION"
    parameters: Dict[str, Any] = Field(default_factory=dict)
