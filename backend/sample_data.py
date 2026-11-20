import random
import time
from typing import List, Tuple, Dict, Any, Optional
from .models import Section, Room, Faculty, Student, TimeSlot, TimetableDataset, SolverPreferences, Enrolment, BacklogAuditLog, ScheduleAssignment, ScheduleResponse, ScheduleMetrics, ConflictDetail

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]
START_HOURS = [9, 10, 11, 12, 13, 14, 15, 16]

def generate_standard_time_slots() -> List[TimeSlot]:
    """Generate 40 standard weekly discrete 1-hour slots (Mon-Fri 09:00-17:00)."""
    slots = []
    for day in DAYS:
        day_prefix = day[:3].upper()
        for hour in START_HOURS:
            start_str = f"{hour:02d}:00"
            end_str = f"{hour+1:02d}:00"
            is_lunch = (hour == 13)
            slot_id = f"SLOT-{day_prefix}-{hour:02d}"
            name = f"{day} {start_str}-{end_str}" + (" (Lunch)" if is_lunch else "")
            slots.append(TimeSlot(
                id=slot_id,
                day=day,
                start_time=start_str,
                end_time=end_str,
                is_lunch=is_lunch,
                display_name=name
            ))
    return slots

def build_enrolments_for_students(students: List[Student], sections: List[Section]) -> List[Enrolment]:
    """
    Generate explicit Enrolment records for students and sections.
    Classifies enrolments as Regular, Elective, or Backlog.
    """
    enrolments = []
    sec_map = {s.id: s for s in sections}

    for st in students:
        for idx, sec_id in enumerate(st.enrolled_section_ids):
            sec = sec_map.get(sec_id)
            if not sec:
                continue

            enr_id = f"ENR-{st.id}-{sec.id}"
            
            # Determine enrolment type
            if st.is_backlog and (idx == len(st.enrolled_section_ids) - 1 or "201" in sec.course_code or "301" in sec.course_code):
                enr_type = "Backlog"
            elif "Lab" in sec.required_room_type or idx >= 2:
                enr_type = "Elective"
            else:
                enr_type = "Regular"

            enrolments.append(Enrolment(
                id=enr_id,
                student_id=st.id,
                section_id=sec.id,
                enrolment_type=enr_type,
                status="Active",
                status_updated_at="2026-11-15 09:00:00",
                cleared_at=None,
                updated_by="Academic Registrar",
                notes=f"Initial semester enrolment for {sec.course_code}"
            ))

    return enrolments

def get_feasible_demo() -> TimetableDataset:
    """
    Feasible demo dataset:
    - 16 sections
    - 10 rooms (varied capacities & types)
    - 16 faculty members
    - 180 students with realistic overlapping electives & backlogs
    - Enrolment records with multiple backlog students and audit log entries
    """
    slots = generate_standard_time_slots()

    rooms = [
        Room(id="R-LH101", name="Turing Lecture Hall", building="Engineering Block A", capacity=120, room_type="Lecture"),
        Room(id="R-LH102", name="Babbage Auditorium", building="Engineering Block A", capacity=150, room_type="Lecture"),
        Room(id="R-CR201", name="Shannon Classroom 201", building="Science Complex", capacity=70, room_type="Lecture"),
        Room(id="R-CR202", name="Knuth Classroom 202", building="Science Complex", capacity=60, room_type="Lecture"),
        Room(id="R-CR203", name="Dijkstra Classroom 203", building="Science Complex", capacity=55, room_type="Lecture"),
        Room(id="R-LAB301", name="Ada Computing Lab 1", building="IT Wing", capacity=80, room_type="Lab"),
        Room(id="R-LAB302", name="von Neumann Systems Lab", building="IT Wing", capacity=75, room_type="Lab"),
        Room(id="R-LAB303", name="Tesla Hardware Lab", building="EE Building", capacity=60, room_type="Lab"),
        Room(id="R-SEM401", name="Hopper Seminar Hall", building="Management Block", capacity=45, room_type="Seminar"),
        Room(id="R-SEM402", name="Ramanujan Seminar Room", building="Math Wing", capacity=40, room_type="Seminar"),
    ]

    faculty = [
        Faculty(id="FAC-CS1", name="Dr. Alan Turing", department="Computer Science", email="a.turing@univ.edu", unavailable_slots=["SLOT-FRI-15", "SLOT-FRI-16"]),
        Faculty(id="FAC-CS2", name="Prof. Ada Lovelace", department="Computer Science", email="a.lovelace@univ.edu", unavailable_slots=["SLOT-MON-09", "SLOT-MON-10"]),
        Faculty(id="FAC-CS3", name="Dr. Donald Knuth", department="Computer Science", email="d.knuth@univ.edu", unavailable_slots=["SLOT-WED-14", "SLOT-WED-15"]),
        Faculty(id="FAC-CS4", name="Dr. Edsger Dijkstra", department="Computer Science", email="e.dijkstra@univ.edu", unavailable_slots=["SLOT-THU-09"]),
        Faculty(id="FAC-CS5", name="Dr. Grace Hopper", department="Computer Science", email="g.hopper@univ.edu", unavailable_slots=[]),
        Faculty(id="FAC-EE1", name="Dr. Nikola Tesla", department="Electrical Eng", email="n.tesla@univ.edu", unavailable_slots=["SLOT-TUE-16"]),
        Faculty(id="FAC-EE2", name="Dr. Claude Shannon", department="Electrical Eng", email="c.shannon@univ.edu", unavailable_slots=["SLOT-MON-11"]),
        Faculty(id="FAC-EE3", name="Prof. Michael Faraday", department="Electrical Eng", email="m.faraday@univ.edu", unavailable_slots=[]),
        Faculty(id="FAC-MTH1", name="Dr. Srinivasa Ramanujan", department="Mathematics", email="s.ramanujan@univ.edu", unavailable_slots=["SLOT-FRI-09"]),
        Faculty(id="FAC-MTH2", name="Dr. Katherine Johnson", department="Mathematics", email="k.johnson@univ.edu", unavailable_slots=[]),
        Faculty(id="FAC-MTH3", name="Dr. Carl Gauss", department="Mathematics", email="c.gauss@univ.edu", unavailable_slots=["SLOT-THU-15"]),
        Faculty(id="FAC-PHY1", name="Dr. Richard Feynman", department="Physics", email="r.feynman@univ.edu", unavailable_slots=["SLOT-WED-09"]),
        Faculty(id="FAC-PHY2", name="Dr. Marie Curie", department="Physics", email="m.curie@univ.edu", unavailable_slots=[]),
        Faculty(id="FAC-BIO1", name="Dr. Rosalind Franklin", department="Bioengineering", email="r.franklin@univ.edu", unavailable_slots=["SLOT-TUE-09"]),
        Faculty(id="FAC-HUM1", name="Prof. Noam Chomsky", department="Humanities", email="n.chomsky@univ.edu", unavailable_slots=[]),
        Faculty(id="FAC-MGT1", name="Dr. Peter Drucker", department="Management", email="p.drucker@univ.edu", unavailable_slots=["SLOT-MON-14"]),
    ]

    sections = [
        Section(id="SEC-CS301-A", course_code="CS301", course_name="Data Structures & Algorithms", department="Computer Science", section_label="A", enrolment_count=70, faculty_id="FAC-CS1", required_room_type="Lab", color="#facc15"),
        Section(id="SEC-CS301-B", course_code="CS301", course_name="Data Structures & Algorithms", department="Computer Science", section_label="B", enrolment_count=65, faculty_id="FAC-CS2", required_room_type="Lab", color="#eab308"),
        Section(id="SEC-CS402-A", course_code="CS402", course_name="Operating Systems & Concurrency", department="Computer Science", section_label="A", enrolment_count=60, faculty_id="FAC-CS3", required_room_type="Lecture", color="#fde047"),
        Section(id="SEC-CS410-A", course_code="CS410", course_name="Machine Learning Foundations", department="Computer Science", section_label="A", enrolment_count=85, faculty_id="FAC-CS5", required_room_type="Lecture", color="#fef08a"),
        
        Section(id="SEC-EE201-A", course_code="EE201", course_name="Signals & Continuous Systems", department="Electrical Eng", section_label="A", enrolment_count=55, faculty_id="FAC-EE2", required_room_type="Lecture", color="#fb923c"),
        Section(id="SEC-EE204-A", course_code="EE204", course_name="Embedded Microcontrollers Lab", department="Electrical Eng", section_label="A", enrolment_count=50, faculty_id="FAC-EE1", required_room_type="Lab", color="#f97316"),
        Section(id="SEC-EE315-A", course_code="EE315", course_name="Digital Signal Processing", department="Electrical Eng", section_label="A", enrolment_count=45, faculty_id="FAC-EE3", required_room_type="Lecture", color="#ea580c"),

        Section(id="SEC-MTH204-A", course_code="MTH204", course_name="Linear Algebra & Optimisation", department="Mathematics", section_label="A", enrolment_count=65, faculty_id="FAC-MTH1", required_room_type="Lecture", color="#38bdf8"),
        Section(id="SEC-MTH204-B", course_code="MTH204", course_name="Linear Algebra & Optimisation", department="Mathematics", section_label="B", enrolment_count=55, faculty_id="FAC-MTH2", required_room_type="Lecture", color="#0ea5e9"),
        Section(id="SEC-MTH310-A", course_code="MTH310", course_name="Probability & Stochastic Processes", department="Mathematics", section_label="A", enrolment_count=50, faculty_id="FAC-MTH3", required_room_type="Lecture", color="#0284c7"),

        Section(id="SEC-PHY110-A", course_code="PHY110", course_name="Quantum Physics & Devices", department="Physics", section_label="A", enrolment_count=60, faculty_id="FAC-PHY1", required_room_type="Lecture", color="#c084fc"),
        Section(id="SEC-PHY110-B", course_code="PHY110", course_name="Quantum Physics & Devices", department="Physics", section_label="B", enrolment_count=50, faculty_id="FAC-PHY2", required_room_type="Lecture", color="#a855f7"),

        Section(id="SEC-BIO201-A", course_code="BIO201", course_name="Computational Genomics", department="Bioengineering", section_label="A", enrolment_count=40, faculty_id="FAC-BIO1", required_room_type="Seminar", color="#f472b6"),
        Section(id="SEC-HUM102-A", course_code="HUM102", course_name="Ethics in Computing & AI", department="Humanities", section_label="A", enrolment_count=75, faculty_id="FAC-HUM1", required_room_type="Lecture", color="#ffffff"),
        Section(id="SEC-MGT301-A", course_code="MGT301", course_name="Technology Entrepreneurship", department="Management", section_label="A", enrolment_count=40, faculty_id="FAC-MGT1", required_room_type="Seminar", color="#e2e8f0"),
        Section(id="SEC-CS490-A", course_code="CS490", course_name="Senior Capstone Seminar", department="Computer Science", section_label="A", enrolment_count=35, faculty_id="FAC-CS4", required_room_type="Seminar", color="#fde047"),
    ]

    students = []
    student_id_counter = 1

    # First cohort: CS A
    for i in range(50):
        students.append(Student(
            id=f"STU-{student_id_counter:03d}",
            name=f"Student {student_id_counter}",
            reg_no=f"2026CS{student_id_counter:03d}",
            department="Computer Science",
            semester=5,
            is_backlog=False,
            enrolled_section_ids=["SEC-CS301-A", "SEC-CS402-A", "SEC-MTH204-A", "SEC-HUM102-A"]
        ))
        student_id_counter += 1

    # Second cohort: CS B
    for i in range(45):
        students.append(Student(
            id=f"STU-{student_id_counter:03d}",
            name=f"Student {student_id_counter}",
            reg_no=f"2026CS{student_id_counter:03d}",
            department="Computer Science",
            semester=5,
            is_backlog=False,
            enrolled_section_ids=["SEC-CS301-B", "SEC-CS410-A", "SEC-MTH204-B", "SEC-MGT301-A"]
        ))
        student_id_counter += 1

    # Third cohort: EE
    for i in range(35):
        students.append(Student(
            id=f"STU-{student_id_counter:03d}",
            name=f"Student {student_id_counter}",
            reg_no=f"2026EE{student_id_counter:03d}",
            department="Electrical Eng",
            semester=4,
            is_backlog=False,
            enrolled_section_ids=["SEC-EE201-A", "SEC-EE204-A", "SEC-MTH310-A", "SEC-PHY110-A"]
        ))
        student_id_counter += 1

    # Fourth cohort: Physics & Bio
    for i in range(30):
        students.append(Student(
            id=f"STU-{student_id_counter:03d}",
            name=f"Student {student_id_counter}",
            reg_no=f"2026SC{student_id_counter:03d}",
            department="Physics",
            semester=3,
            is_backlog=False,
            enrolled_section_ids=["SEC-PHY110-B", "SEC-BIO201-A", "SEC-MTH204-B", "SEC-CS490-A"]
        ))
        student_id_counter += 1

    # Fifth cohort: Backlog Students (20 students)
    for i in range(20):
        students.append(Student(
            id=f"STU-{student_id_counter:03d}",
            name=f"Backlog Student {student_id_counter}",
            reg_no=f"2026BL{student_id_counter:03d}",
            department="Computer Science",
            semester=6,
            is_backlog=True,
            enrolled_section_ids=["SEC-CS301-A", "SEC-EE315-A", "SEC-PHY110-A"]
        ))
        student_id_counter += 1

    enrolments = build_enrolments_for_students(students, sections)

    # Add a few realistic historic and diverse status enrolments for testing filters
    # Student 161 (First backlog student)
    st_demo_1 = next(s for s in students if s.id == "STU-161")
    # Add a cleared backlog
    enrolments.append(Enrolment(
        id=f"ENR-{st_demo_1.id}-SEC-MTH204-A",
        student_id=st_demo_1.id,
        section_id="SEC-MTH204-A",
        enrolment_type="Backlog",
        status="Cleared",
        status_updated_at="2026-11-18 14:30:00",
        cleared_at="2026-11-18 14:30:00",
        updated_by="Academic Registrar",
        notes="Special re-evaluation exam cleared with grade B+."
    ))

    # Student 162: Dropped backlog
    st_demo_2 = next(s for s in students if s.id == "STU-162")
    enrolments.append(Enrolment(
        id=f"ENR-{st_demo_2.id}-SEC-CS402-A",
        student_id=st_demo_2.id,
        section_id="SEC-CS402-A",
        enrolment_type="Backlog",
        status="Dropped",
        status_updated_at="2026-11-17 11:15:00",
        updated_by="Prof. Advisor Smith",
        notes="Student requested course drop due to heavy credit load."
    ))

    # Student 163: Pending backlog verification
    st_demo_3 = next(s for s in students if s.id == "STU-163")
    enrolments.append(Enrolment(
        id=f"ENR-{st_demo_3.id}-SEC-EE201-A",
        student_id=st_demo_3.id,
        section_id="SEC-EE201-A",
        enrolment_type="Backlog",
        status="Pending",
        status_updated_at="2026-11-20 16:45:00",
        updated_by="Student Affairs",
        notes="Grade recalculation pending review with examination committee."
    ))

    audit_logs = [
        BacklogAuditLog(
            id="LOG-001",
            timestamp="2026-11-18 14:30:00",
            student_id=st_demo_1.id,
            student_name=st_demo_1.name,
            course_code="MTH204",
            section_id="SEC-MTH204-A",
            previous_status="Active",
            new_status="Cleared",
            updated_by="Academic Registrar",
            notes="Backlog cleared via supplementary exam.",
            freed_slot_info="Freed slot: Thursday 11:00-12:00"
        ),
        BacklogAuditLog(
            id="LOG-002",
            timestamp="2026-11-17 11:15:00",
            student_id=st_demo_2.id,
            student_name=st_demo_2.name,
            course_code="CS402",
            section_id="SEC-CS402-A",
            previous_status="Active",
            new_status="Dropped",
            updated_by="Prof. Advisor Smith",
            notes="Credit limit adjustment requested by student.",
            freed_slot_info="Freed slot: Tuesday 14:00-15:00"
        )
    ]

    return TimetableDataset(
        sections=sections,
        rooms=rooms,
        faculty=faculty,
        students=students,
        time_slots=slots,
        enrolments=enrolments,
        audit_logs=audit_logs,
        preferences=SolverPreferences(
            protect_lunch=True,
            lunch_penalty=100,
            reduce_back_to_back=True,
            back_to_back_penalty=30,
            balance_faculty_workload=True,
            prefer_efficient_room_use=True
        )
    )

def get_backlog_resolution_demo() -> Dict[str, Any]:
    """
    Dedicated Dynamic Backlog Resolution Demo Scenario:
    1. Student 2026CS104 (Alex Vance) enrolled in:
       - CS301-A (Data Structures, Regular) -> Scheduled Monday 09:00 in Turing Hall
       - EE204-A (Embedded Systems Lab, Elective) -> Scheduled Monday 10:00 in Tesla Lab
       - CS201-A (Discrete Structures, Backlog) -> Scheduled Monday 10:00 in Shannon Classroom 201
    2. Alex Vance has a DIRECT visible clash at Monday 10:00 AM between CS201-A (Backlog) and EE204-A (Elective).
    3. Other 35 students are enrolled in CS201-A, and 40 students in EE204-A.
    4. Admin can 1-click "Mark as Cleared" on Alex Vance's CS201-A backlog.
    5. CS201-A immediately disappears from Alex's timetable, leaving Monday 10:00 free of clash (or free period).
    6. Master timetable remains completely stable for other students, rooms, and faculty.
    7. Optional re-optimisation is available but not forced.
    """
    slots = generate_standard_time_slots()

    rooms = [
        Room(id="R-LH101", name="Turing Lecture Hall", building="Engineering Block A", capacity=120, room_type="Lecture"),
        Room(id="R-CR201", name="Shannon Classroom 201", building="Science Complex", capacity=70, room_type="Lecture"),
        Room(id="R-LAB303", name="Tesla Hardware Lab", building="EE Building", capacity=60, room_type="Lab"),
        Room(id="R-CR202", name="Knuth Classroom 202", building="Science Complex", capacity=60, room_type="Lecture"),
        Room(id="R-LAB301", name="Ada Computing Lab 1", building="IT Wing", capacity=80, room_type="Lab"),
    ]

    faculty = [
        Faculty(id="FAC-CS1", name="Dr. Alan Turing", department="Computer Science", email="a.turing@univ.edu", unavailable_slots=[]),
        Faculty(id="FAC-EE1", name="Dr. Nikola Tesla", department="Electrical Eng", email="n.tesla@univ.edu", unavailable_slots=[]),
        Faculty(id="FAC-CS4", name="Dr. Edsger Dijkstra", department="Computer Science", email="e.dijkstra@univ.edu", unavailable_slots=[]),
        Faculty(id="FAC-MTH1", name="Dr. Srinivasa Ramanujan", department="Mathematics", email="s.ramanujan@univ.edu", unavailable_slots=[]),
        Faculty(id="FAC-CS3", name="Dr. Donald Knuth", department="Computer Science", email="d.knuth@univ.edu", unavailable_slots=[]),
    ]

    sections = [
        Section(
            id="SEC-CS301-A",
            course_code="CS301",
            course_name="Data Structures & Algorithms",
            department="Computer Science",
            section_label="A",
            enrolment_count=70,
            faculty_id="FAC-CS1",
            required_room_type="Lecture",
            color="#facc15"
        ),
        Section(
            id="SEC-EE204-A",
            course_code="EE204",
            course_name="Embedded Microcontrollers Lab",
            department="Electrical Eng",
            section_label="A",
            enrolment_count=40,
            faculty_id="FAC-EE1",
            required_room_type="Lab",
            color="#fb923c"
        ),
        Section(
            id="SEC-CS201-A",
            course_code="CS201",
            course_name="Discrete Mathematics & Logic",
            department="Computer Science",
            section_label="A",
            enrolment_count=36,
            faculty_id="FAC-CS4",
            required_room_type="Lecture",
            color="#ef4444"
        ),
        Section(
            id="SEC-MTH204-A",
            course_code="MTH204",
            course_name="Linear Algebra & Optimisation",
            department="Mathematics",
            section_label="A",
            enrolment_count=50,
            faculty_id="FAC-MTH1",
            required_room_type="Lecture",
            color="#38bdf8"
        ),
        Section(
            id="SEC-CS402-A",
            course_code="CS402",
            course_name="Operating Systems & Concurrency",
            department="Computer Science",
            section_label="A",
            enrolment_count=45,
            faculty_id="FAC-CS3",
            required_room_type="Lecture",
            color="#fde047"
        ),
    ]

    # Target Student: Alex Vance (2026CS104)
    target_student = Student(
        id="STU-2026CS104",
        name="Alex Vance",
        reg_no="2026CS104",
        department="Computer Science",
        semester=6,
        is_backlog=True,
        enrolled_section_ids=["SEC-CS301-A", "SEC-EE204-A", "SEC-CS201-A", "SEC-MTH204-A"]
    )

    students = [target_student]

    # 35 other students in CS201-A (so CS201 remains on master timetable)
    for i in range(1, 36):
        students.append(Student(
            id=f"STU-CS201-COHORT-{i:02d}",
            name=f"CS Junior Student {i}",
            reg_no=f"2027CS{i:03d}",
            department="Computer Science",
            semester=3,
            is_backlog=False,
            enrolled_section_ids=["SEC-CS201-A", "SEC-CS301-A"]
        ))

    # 39 other students in EE204-A
    for i in range(1, 40):
        students.append(Student(
            id=f"STU-EE204-COHORT-{i:02d}",
            name=f"EE Sophomore Student {i}",
            reg_no=f"2026EE{i:03d}",
            department="Electrical Eng",
            semester=4,
            is_backlog=False,
            enrolled_section_ids=["SEC-EE204-A", "SEC-MTH204-A"]
        ))

    # Additional backlog test students
    students.append(Student(
        id="STU-2026CS105",
        name="Sarah Connor",
        reg_no="2026CS105",
        department="Computer Science",
        semester=6,
        is_backlog=True,
        enrolled_section_ids=["SEC-CS301-A", "SEC-CS402-A"]
    ))
    students.append(Student(
        id="STU-2026EE102",
        name="David Miller",
        reg_no="2026EE102",
        department="Electrical Eng",
        semester=5,
        is_backlog=True,
        enrolled_section_ids=["SEC-EE204-A", "SEC-MTH204-A"]
    ))

    # Explicit Enrolments
    enrolments = []

    # Alex Vance enrolments
    enrolments.append(Enrolment(
        id="ENR-2026CS104-CS301",
        student_id="STU-2026CS104",
        section_id="SEC-CS301-A",
        enrolment_type="Regular",
        status="Active",
        status_updated_at="2026-11-10 09:00:00",
        updated_by="Academic Office",
        notes="Core 6th Semester Course"
    ))
    enrolments.append(Enrolment(
        id="ENR-2026CS104-EE204",
        student_id="STU-2026CS104",
        section_id="SEC-EE204-A",
        enrolment_type="Elective",
        status="Active",
        status_updated_at="2026-11-10 09:00:00",
        updated_by="Academic Office",
        notes="Interdisciplinary Open Elective"
    ))
    # CRITICAL: Alex's active backlog enrolment in CS201-A that creates the clash!
    enrolments.append(Enrolment(
        id="ENR-2026CS104-CS201",
        student_id="STU-2026CS104",
        section_id="SEC-CS201-A",
        enrolment_type="Backlog",
        status="Active",
        status_updated_at="2026-11-10 09:00:00",
        cleared_at=None,
        updated_by="Academic Registrar",
        notes="Semester 3 Backlog Course (Re-examination pending)"
    ))
    enrolments.append(Enrolment(
        id="ENR-2026CS104-MTH204",
        student_id="STU-2026CS104",
        section_id="SEC-MTH204-A",
        enrolment_type="Regular",
        status="Active",
        status_updated_at="2026-11-10 09:00:00",
        updated_by="Academic Office"
    ))

    # Cohort enrolments
    for i in range(1, 36):
        st_id = f"STU-CS201-COHORT-{i:02d}"
        enrolments.append(Enrolment(
            id=f"ENR-{st_id}-CS201",
            student_id=st_id,
            section_id="SEC-CS201-A",
            enrolment_type="Regular",
            status="Active",
            status_updated_at="2026-11-10 09:00:00"
        ))
        enrolments.append(Enrolment(
            id=f"ENR-{st_id}-CS301",
            student_id=st_id,
            section_id="SEC-CS301-A",
            enrolment_type="Regular",
            status="Active",
            status_updated_at="2026-11-10 09:00:00"
        ))

    for i in range(1, 40):
        st_id = f"STU-EE204-COHORT-{i:02d}"
        enrolments.append(Enrolment(
            id=f"ENR-{st_id}-EE204",
            student_id=st_id,
            section_id="SEC-EE204-A",
            enrolment_type="Regular",
            status="Active",
            status_updated_at="2026-11-10 09:00:00"
        ))
        enrolments.append(Enrolment(
            id=f"ENR-{st_id}-MTH204",
            student_id=st_id,
            section_id="SEC-MTH204-A",
            enrolment_type="Regular",
            status="Active",
            status_updated_at="2026-11-10 09:00:00"
        ))

    # Sarah Connor: Active backlog in CS402
    enrolments.append(Enrolment(
        id="ENR-2026CS105-CS402",
        student_id="STU-2026CS105",
        section_id="SEC-CS402-A",
        enrolment_type="Backlog",
        status="Active",
        status_updated_at="2026-11-12 10:00:00",
        notes="Semester 4 Backlog"
    ))
    # David Miller: Cleared backlog in MTH204
    enrolments.append(Enrolment(
        id="ENR-2026EE102-MTH204",
        student_id="STU-2026EE102",
        section_id="SEC-MTH204-A",
        enrolment_type="Backlog",
        status="Cleared",
        status_updated_at="2026-11-16 15:30:00",
        cleared_at="2026-11-16 15:30:00",
        updated_by="Academic Registrar",
        notes="Passed re-examination with 74%"
    ))

    audit_logs = [
        BacklogAuditLog(
            id="LOG-DEMO-001",
            timestamp="2026-11-16 15:30:00",
            student_id="STU-2026EE102",
            student_name="David Miller",
            course_code="MTH204",
            section_id="SEC-MTH204-A",
            previous_status="Active",
            new_status="Cleared",
            updated_by="Academic Registrar",
            notes="Passed re-examination with 74%.",
            freed_slot_info="Freed slot: Tuesday 11:00-12:00",
            action="CLEARED",
            message="Student 2026EE102 (David Miller) cleared backlog MTH204. Freed slot: Tuesday 11:00-12:00."
        )
    ]

    dataset = TimetableDataset(
        sections=sections,
        rooms=rooms,
        faculty=faculty,
        students=students,
        time_slots=slots,
        enrolments=enrolments,
        audit_logs=audit_logs,
        preferences=SolverPreferences()
    )

    # Pre-computed stable assignments where EE204-A and CS201-A both sit at Monday 10:00 AM!
    # This demonstrates the exact scenario:
    # Alex Vance has a conflict between CS201-A and EE204-A at Monday 10:00 AM.
    # Other students in CS201-A and EE204-A are happily attending their respective class.
    assignments = [
        ScheduleAssignment(
            section_id="SEC-CS301-A",
            course_code="CS301",
            course_name="Data Structures & Algorithms",
            department="Computer Science",
            section_label="A",
            faculty_id="FAC-CS1",
            faculty_name="Dr. Alan Turing",
            room_id="R-LH101",
            room_name="Turing Lecture Hall",
            room_capacity=120,
            enrolment_count=70,
            slot_id="SLOT-MON-09",
            day="Monday",
            start_time="09:00",
            end_time="10:00",
            is_lunch=False
        ),
        # Overlapping slot: EE204-A in Tesla Hardware Lab at Monday 10:00
        ScheduleAssignment(
            section_id="SEC-EE204-A",
            course_code="EE204",
            course_name="Embedded Microcontrollers Lab",
            department="Electrical Eng",
            section_label="A",
            faculty_id="FAC-EE1",
            faculty_name="Dr. Nikola Tesla",
            room_id="R-LAB303",
            room_name="Tesla Hardware Lab",
            room_capacity=60,
            enrolment_count=40,
            slot_id="SLOT-MON-10",
            day="Monday",
            start_time="10:00",
            end_time="11:00",
            is_lunch=False
        ),
        # Overlapping slot: CS201-A in Shannon Classroom at Monday 10:00
        ScheduleAssignment(
            section_id="SEC-CS201-A",
            course_code="CS201",
            course_name="Discrete Mathematics & Logic",
            department="Computer Science",
            section_label="A",
            faculty_id="FAC-CS4",
            faculty_name="Dr. Edsger Dijkstra",
            room_id="R-CR201",
            room_name="Shannon Classroom 201",
            room_capacity=70,
            enrolment_count=36,
            slot_id="SLOT-MON-10",
            day="Monday",
            start_time="10:00",
            end_time="11:00",
            is_lunch=False
        ),
        ScheduleAssignment(
            section_id="SEC-MTH204-A",
            course_code="MTH204",
            course_name="Linear Algebra & Optimisation",
            department="Mathematics",
            section_label="A",
            faculty_id="FAC-MTH1",
            faculty_name="Dr. Srinivasa Ramanujan",
            room_id="R-CR202",
            room_name="Knuth Classroom 202",
            room_capacity=60,
            enrolment_count=50,
            slot_id="SLOT-TUE-11",
            day="Tuesday",
            start_time="11:00",
            end_time="12:00",
            is_lunch=False
        ),
        ScheduleAssignment(
            section_id="SEC-CS402-A",
            course_code="CS402",
            course_name="Operating Systems & Concurrency",
            department="Computer Science",
            section_label="A",
            faculty_id="FAC-CS3",
            faculty_name="Dr. Donald Knuth",
            room_id="R-LAB301",
            room_name="Ada Computing Lab 1",
            room_capacity=80,
            enrolment_count=45,
            slot_id="SLOT-WED-14",
            day="Wednesday",
            start_time="14:00",
            end_time="15:00",
            is_lunch=False
        ),
    ]

    conflicts = [
        ConflictDetail(
            id="CONF-DEMO-ALEX",
            type="HIGH_OVERLAP_ELECTIVES",
            severity="CRITICAL",
            title="Student Timetable Clash: Alex Vance (2026CS104)",
            description="Alex Vance (2026CS104) is simultaneously enrolled in EE204-A (Elective) and CS201-A (Backlog), both scheduled on Monday 10:00–11:00.",
            involved_courses=["EE204", "CS201"],
            involved_sections=["SEC-EE204-A", "SEC-CS201-A"],
            involved_faculty=["Dr. Nikola Tesla", "Dr. Edsger Dijkstra"],
            involved_rooms=["Tesla Hardware Lab", "Shannon Classroom 201"],
            conflicting_students_count=1,
            why_impossible="Hard Constraint #1: Student cannot attend two overlapping sections concurrently.",
            recommendations=[
                "Mark Alex Vance's backlog in CS201 as Cleared in Backlog Management if examination was passed.",
                "Or re-optimise timetable to separate EE204 and CS201 if student must still attend both."
            ]
        )
    ]

    return {
        "dataset": dataset,
        "schedule": {
            "status": "FEASIBLE_WITH_STUDENT_CLASH",
            "is_feasible": True,
            "solve_time_seconds": 0.042,
            "hard_conflicts_count": 1,
            "soft_constraint_score": 15,
            "assignments_count": len(assignments),
            "total_sections": len(sections),
            "assignments": [a.model_dump() for a in assignments],
            "conflicts": [c.model_dump() for c in conflicts],
            "is_minimal_conflict_set": False,
            "conflict_summary": "1 student-level timetable clash detected between an elective and an active backlog subject.",
            "metrics": {
                "room_utilization_percent": 2.5,
                "students_protected_count": len(students) - 1,
                "lunch_period_assignments_count": 0,
                "average_room_waste": 25.0,
                "day_distribution": {"Monday": 3, "Tuesday": 1, "Wednesday": 1},
                "hour_distribution": {"09:00": 1, "10:00": 2, "11:00": 1, "14:00": 1},
                "department_load": {"Computer Science": 3, "Electrical Eng": 1, "Mathematics": 1},
                "active_backlogs_count": 2,
                "cleared_backlogs_count": 1,
                "conflicts_resolved_by_clearance": 1,
                "freed_student_hours": 1,
                "reduced_sections_count": 0
            },
            "backlog_resolutions": []
        }
    }

def get_impossible_demo() -> TimetableDataset:
    """
    Impossible Conflict Scenario:
    Demonstrates a realistic university bottleneck:
    1. CS301-A (75 students) and EE204-A (70 students) both require the ONLY 80-seat Lab (R-LAB101).
    2. 42 students are enrolled in BOTH (backlogs + dual degree).
    3. Dr. Alan Turing (CS301-A) is a visiting scholar only available on Tuesday 10:00-11:00.
    4. Prof. Ada Lovelace (EE204-A) is only available on Tuesday 10:00-11:00.
    """
    slots = generate_standard_time_slots()

    rooms = [
        Room(id="R-LAB101", name="Turing Computing Lab", building="IT Block", capacity=80, room_type="Lab"),
        Room(id="R-LAB102", name="Hardware Workshop", building="EE Block", capacity=40, room_type="Lab"),
        Room(id="R-LH201", name="Main Auditorium", building="Science Block", capacity=120, room_type="Lecture"),
        Room(id="R-CR101", name="Small Classroom 101", building="Science Block", capacity=40, room_type="Lecture"),
        Room(id="R-CR102", name="Small Classroom 102", building="Science Block", capacity=45, room_type="Lecture"),
    ]

    faculty = [
        Faculty(
            id="FAC-TURING",
            name="Dr. Alan Turing",
            department="Computer Science",
            email="a.turing@univ.edu",
            unavailable_slots=[s.id for s in slots if s.id != "SLOT-TUE-10"]
        ),
        Faculty(
            id="FAC-LOVELACE",
            name="Prof. Ada Lovelace",
            department="Electrical Eng",
            email="a.lovelace@univ.edu",
            unavailable_slots=[s.id for s in slots if s.id != "SLOT-TUE-10"]
        ),
        Faculty(
            id="FAC-GAUSS",
            name="Dr. Carl Gauss",
            department="Mathematics",
            email="c.gauss@univ.edu",
            unavailable_slots=[s.id for s in slots if s.day in ["Wednesday", "Thursday", "Friday"]]
        ),
        Faculty(
            id="FAC-FEYNMAN",
            name="Dr. Richard Feynman",
            department="Physics",
            email="r.feynman@univ.edu",
            unavailable_slots=[]
        ),
    ]

    sections = [
        Section(
            id="SEC-CS301-A",
            course_code="CS301",
            course_name="Advanced Systems Lab",
            department="Computer Science",
            section_label="A",
            enrolment_count=75,
            faculty_id="FAC-TURING",
            required_room_type="Lab",
            color="#ef4444"
        ),
        Section(
            id="SEC-EE204-A",
            course_code="EE204",
            course_name="Embedded Microcontrollers Lab",
            department="Electrical Eng",
            section_label="A",
            enrolment_count=70,
            faculty_id="FAC-LOVELACE",
            required_room_type="Lab",
            color="#f97316"
        ),
        Section(
            id="SEC-MTH204-A",
            course_code="MTH204",
            course_name="Applied Linear Algebra",
            department="Mathematics",
            section_label="A",
            enrolment_count=65,
            faculty_id="FAC-GAUSS",
            required_room_type="Lecture",
            color="#10b981"
        ),
        Section(
            id="SEC-PHY101-A",
            course_code="PHY101",
            course_name="Modern Physics",
            department="Physics",
            section_label="A",
            enrolment_count=50,
            faculty_id="FAC-FEYNMAN",
            required_room_type="Lecture",
            color="#8b5cf6"
        ),
    ]

    students = []
    # 42 shared students between CS301-A and EE204-A
    for i in range(1, 43):
        students.append(Student(
            id=f"STU-CLASH-{i:03d}",
            name=f"Dual-Degree Student {i}",
            reg_no=f"2026DD{i:03d}",
            department="Computer Science",
            semester=5,
            is_backlog=True,
            enrolled_section_ids=["SEC-CS301-A", "SEC-EE204-A", "SEC-MTH204-A"]
        ))
    for i in range(43, 76):
        students.append(Student(
            id=f"STU-CS-{i:03d}",
            name=f"CS Student {i}",
            reg_no=f"2026CS{i:03d}",
            department="Computer Science",
            semester=5,
            is_backlog=False,
            enrolled_section_ids=["SEC-CS301-A", "SEC-PHY101-A"]
        ))
    for i in range(76, 104):
        students.append(Student(
            id=f"STU-EE-{i:03d}",
            name=f"EE Student {i}",
            reg_no=f"2026EE{i:03d}",
            department="Electrical Eng",
            semester=4,
            is_backlog=False,
            enrolled_section_ids=["SEC-EE204-A", "SEC-PHY101-A"]
        ))

    enrolments = build_enrolments_for_students(students, sections)

    return TimetableDataset(
        sections=sections,
        rooms=rooms,
        faculty=faculty,
        students=students,
        time_slots=slots,
        enrolments=enrolments,
        preferences=SolverPreferences()
    )

def generate_large_simulation(num_students: int = 1500, num_sections: int = 120) -> TimetableDataset:
    """
    Generate synthetic dataset simulating 1,500 students and 120 sections across 8 departments.
    Deterministic random seed (42) for reproducible benchmarking.
    """
    rng = random.Random(42)
    slots = generate_standard_time_slots()

    departments = [
        ("Computer Science", "CS", ["CS101", "CS201", "CS202", "CS301", "CS305", "CS401", "CS410", "CS420", "CS450"]),
        ("Electrical Eng", "EE", ["EE101", "EE201", "EE204", "EE301", "EE315", "EE401", "EE420"]),
        ("Mechanical Eng", "ME", ["ME101", "ME201", "ME205", "ME301", "ME310", "ME401"]),
        ("Civil Eng", "CE", ["CE101", "CE201", "CE204", "CE301", "CE312"]),
        ("Mathematics", "MTH", ["MTH101", "MTH102", "MTH201", "MTH204", "MTH310", "MTH401"]),
        ("Physics", "PHY", ["PHY101", "PHY110", "PHY201", "PHY301"]),
        ("Chemistry & Bio", "CHM", ["CHM101", "BIO201", "BIO301"]),
        ("Humanities & Mgt", "HSS", ["HUM101", "HUM102", "MGT201", "MGT301", "MGT401"])
    ]

    rooms = []
    for i in range(1, 36):
        if i <= 10:
            rtype = "Lab"
            cap = rng.choice([95, 100, 110, 120])
        elif i <= 30:
            rtype = "Lecture"
            cap = rng.choice([100, 120, 150, 180, 200, 250])
        else:
            rtype = "Seminar"
            cap = rng.choice([50, 60, 75])
        rooms.append(Room(
            id=f"R-SIM-{i:03d}",
            name=f"Hall {i} ({rtype})",
            building=f"Block {chr(65 + (i % 6))}",
            capacity=cap,
            room_type=rtype,
            unavailable_slots=[]
        ))

    faculty = []
    faculty_by_dept = {}
    for i in range(1, 61):
        dept_name, dept_code, _ = departments[i % len(departments)]
        fac_id = f"FAC-SIM-{i:03d}"
        f = Faculty(
            id=fac_id,
            name=f"Prof. Faculty {i}",
            department=dept_name,
            email=f"faculty{i}@univ.edu",
            unavailable_slots=rng.sample([s.id for s in slots], k=rng.randint(0, 2)),
            max_daily_hours=4
        )
        faculty.append(f)
        faculty_by_dept.setdefault(dept_name, []).append(fac_id)

    sections = []
    dept_colors = ["#facc15", "#fb923c", "#38bdf8", "#c084fc", "#f472b6", "#eab308", "#ffffff", "#e2e8f0"]
    sec_counter = 1
    while len(sections) < num_sections:
        for d_idx, (dept_name, dept_code, course_list) in enumerate(departments):
            if len(sections) >= num_sections:
                break
            color = dept_colors[d_idx % len(dept_colors)]
            fac_pool = faculty_by_dept.get(dept_name, [faculty[0].id])
            for c_code in course_list:
                if len(sections) >= num_sections:
                    break
                label = chr(65 + (len([s for s in sections if s.course_code == c_code]) % 3))
                enrol = rng.randint(40, 85)
                is_lab = ("Lab" in c_code or "204" in c_code or rng.random() < 0.2)
                rtype = "Lab" if is_lab else "Lecture"
                assigned_fac = rng.choice(fac_pool)

                sections.append(Section(
                    id=f"SEC-SIM-{sec_counter:03d}",
                    course_code=c_code,
                    course_name=f"{c_code} {dept_name} Core",
                    department=dept_name,
                    section_label=label,
                    enrolment_count=enrol,
                    faculty_id=assigned_fac,
                    required_room_type=rtype,
                    color=color
                ))
                sec_counter += 1

    students = []
    sec_ids_by_dept = {}
    for s in sections:
        sec_ids_by_dept.setdefault(s.department, []).append(s.id)

    all_dept_names = [d[0] for d in departments]
    for s_idx in range(1, num_students + 1):
        primary_dept = rng.choice(all_dept_names)
        dept_secs = sec_ids_by_dept.get(primary_dept, [])
        is_backlog = (rng.random() < 0.1)

        enrolled = set()
        if len(dept_secs) >= 3:
            cohort_idx = (s_idx % max(1, len(dept_secs) - 2))
            enrolled.update(dept_secs[cohort_idx:cohort_idx + 3])
        elif dept_secs:
            enrolled.update(dept_secs)

        other_depts = [d for d in all_dept_names if d != primary_dept]
        if other_depts and rng.random() < 0.7:
            elective_dept = rng.choice(other_depts)
            el_secs = sec_ids_by_dept.get(elective_dept, [])
            if el_secs:
                enrolled.add(rng.choice(el_secs))
                enrolled.add(rng.choice(el_secs))

        students.append(Student(
            id=f"STU-SIM-{s_idx:04d}",
            name=f"Student {s_idx}",
            reg_no=f"2026SIM{s_idx:04d}",
            department=primary_dept,
            semester=rng.choice([1, 3, 5, 7]),
            is_backlog=is_backlog,
            enrolled_section_ids=list(enrolled)
        ))

    enrolments = build_enrolments_for_students(students, sections)

    return TimetableDataset(
        sections=sections,
        rooms=rooms,
        faculty=faculty,
        students=students,
        time_slots=slots,
        enrolments=enrolments,
        preferences=SolverPreferences(
            timeout_seconds=45,
            protect_lunch=True,
            reduce_back_to_back=True,
            balance_faculty_workload=True,
            prefer_efficient_room_use=True
        )
    )
