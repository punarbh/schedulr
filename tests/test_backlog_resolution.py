import unittest
import time
from backend.models import (
    TimetableDataset, Section, Room, Faculty, Student, TimeSlot, Enrolment, SolverPreferences
)
from backend.solver import TimetableSolver

class TestDynamicBacklogResolution(unittest.TestCase):
    """
    Unit test suite verifying Dynamic Backlog Resolution invariants:
    1. Active backlog creates a clash
    2. Cleared backlog no longer creates a clash
    3. Cleared enrolment no longer contributes to room capacity
    4. Reactivating a backlog restores its clash checks
    """

    def setUp(self):
        # 1 slot schedule to force temporal collision if students/faculty overlap
        self.single_slot = [
            TimeSlot(id="SLOT-MON-10", day="Monday", start_time="10:00", end_time="11:00", is_lunch=False, display_name="Mon 10:00-11:00")
        ]

        # 2 rooms
        self.two_rooms = [
            Room(id="R-101", name="Lecture Room 101", building="Main", capacity=50, room_type="Lecture"),
            Room(id="R-102", name="Lecture Room 102", building="Main", capacity=50, room_type="Lecture")
        ]

        # 2 distinct faculty (both available in SLOT-MON-10)
        self.two_faculty = [
            Faculty(id="FAC-A", name="Prof. A", department="CS", email="a@univ.edu", unavailable_slots=[]),
            Faculty(id="FAC-B", name="Prof. B", department="EE", email="b@univ.edu", unavailable_slots=[])
        ]

        # 2 sections needing 1 slot each
        self.section_a = Section(
            id="SEC-CS201",
            course_code="CS201",
            course_name="Discrete Math",
            department="CS",
            section_label="A",
            enrolment_count=10,
            faculty_id="FAC-A",
            required_room_type="Lecture"
        )
        self.section_b = Section(
            id="SEC-EE204",
            course_code="EE204",
            course_name="Embedded Systems",
            department="EE",
            section_label="A",
            enrolment_count=10,
            faculty_id="FAC-B",
            required_room_type="Lecture"
        )

        # Target student Alex Vance
        self.student_alex = Student(
            id="STU-ALEX",
            name="Alex Vance",
            reg_no="2026CS104",
            department="CS",
            is_backlog=True,
            enrolled_section_ids=["SEC-CS201", "SEC-EE204"]
        )

    def test_1_active_backlog_creates_clash(self):
        """Active backlog creates a student clash constraint and makes 1-slot schedule infeasible."""
        enrolments = [
            Enrolment(
                id="ENR-ALEX-CS201",
                student_id="STU-ALEX",
                section_id="SEC-CS201",
                enrolment_type="Backlog",
                status="Active",
                status_updated_at="2026-11-20 10:00:00"
            ),
            Enrolment(
                id="ENR-ALEX-EE204",
                student_id="STU-ALEX",
                section_id="SEC-EE204",
                enrolment_type="Regular",
                status="Active",
                status_updated_at="2026-11-20 10:00:00"
            )
        ]

        dataset = TimetableDataset(
            sections=[self.section_a, self.section_b],
            rooms=self.two_rooms,
            faculty=self.two_faculty,
            students=[self.student_alex],
            time_slots=self.single_slot,
            enrolments=enrolments,
            preferences=SolverPreferences(timeout_seconds=5)
        )

        solver = TimetableSolver(dataset)
        # Verify solver identified shared active student
        self.assertEqual(solver.shared_student_counts.get(("SEC-CS201", "SEC-EE204")), 1)

        response = solver.solve()
        # Infeasible because Alex is enrolled in both sections and only 1 slot exists
        self.assertFalse(response.is_feasible)
        self.assertIn(response.status, ["INFEASIBLE", "ERROR"])

    def test_2_cleared_backlog_removes_clash(self):
        """Cleared backlog removes the student clash, allowing both sections to be scheduled concurrently."""
        enrolments = [
            # Alex CLEARS CS201
            Enrolment(
                id="ENR-ALEX-CS201",
                student_id="STU-ALEX",
                section_id="SEC-CS201",
                enrolment_type="Backlog",
                status="Cleared",
                status_updated_at="2026-11-20 10:00:00",
                cleared_at="2026-11-20 10:00:00"
            ),
            Enrolment(
                id="ENR-ALEX-EE204",
                student_id="STU-ALEX",
                section_id="SEC-EE204",
                enrolment_type="Regular",
                status="Active",
                status_updated_at="2026-11-20 10:00:00"
            )
        ]

        dataset = TimetableDataset(
            sections=[self.section_a, self.section_b],
            rooms=self.two_rooms,
            faculty=self.two_faculty,
            students=[self.student_alex],
            time_slots=self.single_slot,
            enrolments=enrolments,
            preferences=SolverPreferences(timeout_seconds=5)
        )

        solver = TimetableSolver(dataset)
        # Shared active student count must be 0 because cleared enrolment is excluded
        self.assertEqual(solver.shared_student_counts.get(("SEC-CS201", "SEC-EE204"), 0), 0)

        response = solver.solve()
        # Schedule is now FEASIBLE because both sections can use R-101 and R-102 at the same slot
        self.assertTrue(response.is_feasible)
        self.assertEqual(len(response.assignments), 2)
        self.assertEqual(len(response.backlog_resolutions), 1)
        self.assertIn("2026CS104", response.backlog_resolutions[0])
        self.assertIn("CS201", response.backlog_resolutions[0])

    def test_3_cleared_enrolment_does_not_inflate_room_capacity(self):
        """Cleared enrolments decrement active count so section fits in smaller available room."""
        # Small room with capacity 30
        small_room = [
            Room(id="R-SMALL", name="Small Room", building="Main", capacity=30, room_type="Lecture")
        ]

        # Section originally had nominal enrolment count 45 (which wouldn't fit capacity 30)
        large_section = Section(
            id="SEC-MATH",
            course_code="MTH201",
            course_name="Calculus",
            department="Math",
            section_label="A",
            enrolment_count=45,
            faculty_id="FAC-A",
            required_room_type="Lecture"
        )

        # Create 40 students: 25 Active, 15 Cleared backlogs
        students = []
        enrolments = []
        for i in range(1, 41):
            st_id = f"STU-{i:03d}"
            students.append(Student(id=st_id, name=f"Student {i}", enrolled_section_ids=["SEC-MATH"]))
            status = "Cleared" if i <= 15 else "Active"
            enrolments.append(Enrolment(
                id=f"ENR-{st_id}-MATH",
                student_id=st_id,
                section_id="SEC-MATH",
                enrolment_type="Backlog" if i <= 15 else "Regular",
                status=status,
                status_updated_at="2026-11-20 10:00:00"
            ))

        dataset = TimetableDataset(
            sections=[large_section],
            rooms=small_room,
            faculty=[self.two_faculty[0]],
            students=students,
            time_slots=self.single_slot,
            enrolments=enrolments,
            preferences=SolverPreferences(timeout_seconds=5)
        )

        solver = TimetableSolver(dataset)
        # Active enrolment should be exactly 25 (40 - 15)
        self.assertEqual(large_section.active_enrolment_count, 25)
        self.assertEqual(large_section.cleared_backlog_count, 15)

        response = solver.solve()
        # 25 active students fit into room with capacity 30!
        self.assertTrue(response.is_feasible)
        self.assertEqual(len(response.assignments), 1)
        self.assertEqual(response.assignments[0].room_id, "R-SMALL")

    def test_4_reactivating_backlog_restores_clash(self):
        """Reactivating a previously cleared backlog restores its clash checks and refutes feasibility."""
        # 1. Start with Cleared backlog (Feasible)
        enrolment_cs = Enrolment(
            id="ENR-ALEX-CS201",
            student_id="STU-ALEX",
            section_id="SEC-CS201",
            enrolment_type="Backlog",
            status="Cleared",
            status_updated_at="2026-11-20 10:00:00"
        )
        enrolment_ee = Enrolment(
            id="ENR-ALEX-EE204",
            student_id="STU-ALEX",
            section_id="SEC-EE204",
            enrolment_type="Regular",
            status="Active",
            status_updated_at="2026-11-20 10:00:00"
        )

        dataset = TimetableDataset(
            sections=[self.section_a, self.section_b],
            rooms=self.two_rooms,
            faculty=self.two_faculty,
            students=[self.student_alex],
            time_slots=self.single_slot,
            enrolments=[enrolment_cs, enrolment_ee],
            preferences=SolverPreferences(timeout_seconds=5)
        )

        solver_cleared = TimetableSolver(dataset)
        self.assertTrue(solver_cleared.solve().is_feasible)

        # 2. Reactivate the backlog (Active)
        enrolment_cs.status = "Active"
        solver_reactivated = TimetableSolver(dataset)

        # Student clash constraint is restored
        self.assertEqual(solver_reactivated.shared_student_counts.get(("SEC-CS201", "SEC-EE204")), 1)
        response_reactivated = solver_reactivated.solve()
        self.assertFalse(response_reactivated.is_feasible)

if __name__ == "__main__":
    unittest.main()
