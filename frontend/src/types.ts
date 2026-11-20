export interface TimeSlot {
  id: string;
  day: string;
  start_time: string;
  end_time: string;
  is_lunch: boolean;
  display_name?: string;
}

export interface Room {
  id: string;
  name: string;
  building: string;
  capacity: int;
  room_type: "Lecture" | "Lab" | "Seminar" | "Auditorium";
  unavailable_slots: string[];
}

export interface Faculty {
  id: string;
  name: string;
  department: string;
  email: string;
  unavailable_slots: string[];
  max_daily_hours?: number;
}

export interface Student {
  id: string;
  name: string;
  department?: string;
  semester?: number;
  is_backlog: boolean;
  enrolled_section_ids: string[];
}

export interface Section {
  id: string;
  course_code: string;
  course_name: string;
  department: string;
  section_label: string;
  enrolment_count: number;
  faculty_id: string;
  required_room_type: string;
  duration_slots?: number;
  color?: string;
}

export interface SolverPreferences {
  protect_lunch: boolean;
  lunch_penalty: number;
  reduce_back_to_back: boolean;
  back_to_back_penalty: number;
  balance_faculty_workload: boolean;
  faculty_gap_penalty: number;
  prefer_efficient_room_use: boolean;
  room_waste_penalty: number;
  timeout_seconds: number;
}

export interface ScheduleAssignment {
  section_id: string;
  course_code: string;
  course_name: string;
  department: string;
  section_label: string;
  faculty_id: string;
  faculty_name: string;
  room_id: string;
  room_name: string;
  room_capacity: number;
  enrolment_count: number;
  slot_id: string;
  day: string;
  start_time: string;
  end_time: string;
  is_lunch: boolean;
}

export interface ConflictDetail {
  id: string;
  type: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM";
  title: string;
  description: string;
  involved_courses: string[];
  involved_sections: string[];
  involved_faculty: string[];
  involved_rooms: string[];
  conflicting_students_count: number;
  why_impossible: string;
  recommendations: string[];
  suggested_action?: Record<string, any>;
}

export interface ScheduleMetrics {
  room_utilization_percent: number;
  students_protected_count: number;
  faculty_with_gaps_count: number;
  lunch_period_assignments_count: number;
  back_to_back_violations_count: number;
  average_room_waste: number;
  day_distribution: Record<string, number>;
  hour_distribution: Record<string, number>;
  department_load: Record<string, number>;
}

export interface ScheduleResponse {
  status: "FEASIBLE" | "OPTIMAL" | "INFEASIBLE" | "TIMEOUT" | "ERROR";
  is_feasible: boolean;
  solve_time_seconds: number;
  hard_conflicts_count: number;
  soft_constraint_score: number;
  assignments_count: number;
  total_sections: number;
  assignments: ScheduleAssignment[];
  conflicts: ConflictDetail[];
  is_minimal_conflict_set: boolean;
  conflict_summary?: string;
  metrics: ScheduleMetrics;
}

export interface TimetableDataset {
  sections: Section[];
  rooms: Room[];
  faculty: Faculty[];
  students: Student[];
  time_slots: TimeSlot[];
  preferences: SolverPreferences;
}
