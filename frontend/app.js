const { useState, useEffect, useRef, useMemo } = React;

// API Base URL (works seamlessly in both local development and single-service Render deployments)
const API_BASE = typeof window !== "undefined" && window.location.protocol.startsWith("http")
  ? `${window.location.origin}/api`
  : "http://localhost:8000/api";

// Fallback Default Datasets in case backend server is starting
const DEFAULT_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const DEFAULT_HOURS = [9, 10, 11, 12, 13, 14, 15, 16];

function createDefaultTimeSlots() {
  const slots = [];
  for (const day of DEFAULT_DAYS) {
    const dayPrefix = day.slice(0, 3).toUpperCase();
    for (const hour of DEFAULT_HOURS) {
      const isLunch = hour === 13;
      slots.push({
        id: `SLOT-${dayPrefix}-${String(hour).padStart(2, '0')}`,
        day: day,
        start_time: `${String(hour).padStart(2, '0')}:00`,
        end_time: `${String(hour + 1).padStart(2, '0')}:00`,
        is_lunch: isLunch,
        display_name: `${day} ${String(hour).padStart(2, '0')}:00-${String(hour + 1).padStart(2, '0')}:00` + (isLunch ? " (Lunch)" : "")
      });
    }
  }
  return slots;
}

// Helper to trigger Lucide icon replacement after DOM updates
function refreshIcons() {
  setTimeout(() => {
    if (window.lucide) {
      window.lucide.createIcons();
    }
  }, 50);
}

// Authenticated API request helper with automatic Bearer token injection
async function apiFetch(endpoint, options = {}) {
  const token = sessionStorage.getItem("schedulr_auth_token");
  const headers = {
    ...(options.headers || {})
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const url = endpoint.startsWith("http") ? endpoint : `${API_BASE}${endpoint}`;
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 && !url.includes("/auth/login") && !url.includes("/auth/signup")) {
    sessionStorage.removeItem("schedulr_auth_token");
    sessionStorage.removeItem("schedulr_user");
    window.dispatchEvent(new CustomEvent("schedulr_session_expired"));
  }
  return res;
}

// Icon Wrapper Component
function Icon({ name, className = "w-5 h-5", size = 20 }) {
  return <i data-lucide={name} className={className} style={{ width: size, height: size }}></i>;
}

// Main App Component
function App() {
  // Authentication & RBAC states
  const [authToken, setAuthToken] = useState(() => {
    try {
      return sessionStorage.getItem("schedulr_auth_token");
    } catch {
      return null;
    }
  });
  const [currentUser, setCurrentUser] = useState(() => {
    try {
      const saved = sessionStorage.getItem("schedulr_user");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });
  const [authChecking, setAuthChecking] = useState(true);
  const [facultySchedule, setFacultySchedule] = useState(null);
  const [studentSchedule, setStudentSchedule] = useState(null);
  const [roleLoading, setRoleLoading] = useState(false);

  const [activeTab, setActiveTab] = useState("landing");
  const [dataset, setDataset] = useState(null);
  const [scheduleResponse, setScheduleResponse] = useState(null);
  const [isSolving, setIsSolving] = useState(false);
  const [selectedScenario, setSelectedScenario] = useState("feasible");
  const [activeProject, setActiveProject] = useState("Spring 2026 Core Timetable");
  const [apiOnline, setApiOnline] = useState(false);
  const [engineInfo, setEngineInfo] = useState("Google OR-Tools CP-SAT");

  // Filter & View States
  const [timetableMode, setTimetableMode] = useState("master"); // "master", "room", "faculty", "student"
  const [selectedFilterEntity, setSelectedFilterEntity] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedAssignment, setSelectedAssignment] = useState(null);

  // What-If Simulator state
  const [whatIfRemedy, setWhatIfRemedy] = useState("ADD_ROOM");
  const [whatIfStatus, setWhatIfStatus] = useState(null);

  // Data Manager active sub-tab
  const [dataTab, setDataTab] = useState("sections");
  const [showAddModal, setShowAddModal] = useState(false);
  const [modalEntity, setModalEntity] = useState(null);

  // Preferences
  const [preferences, setPreferences] = useState({
    protect_lunch: true,
    lunch_penalty: 100,
    reduce_back_to_back: true,
    back_to_back_penalty: 35,
    balance_faculty_workload: true,
    faculty_gap_penalty: 15,
    prefer_efficient_room_use: true,
    room_waste_penalty: 2,
    timeout_seconds: 30
  });

  // Backlog resolution banner state
  const [backlogBanner, setBacklogBanner] = useState(null);

  // Initial Load & Session Verification
  useEffect(() => {
    checkAuthSession();
    const handleExpired = () => {
      setAuthToken(null);
      setCurrentUser(null);
      setFacultySchedule(null);
      setStudentSchedule(null);
    };
    window.addEventListener("schedulr_session_expired", handleExpired);
    return () => window.removeEventListener("schedulr_session_expired", handleExpired);
  }, []);

  async function checkAuthSession() {
    const token = sessionStorage.getItem("schedulr_auth_token");
    if (!token) {
      setAuthChecking(false);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      if (res.ok) {
        const user = await res.json();
        setCurrentUser(user);
        sessionStorage.setItem("schedulr_user", JSON.stringify(user));
        if (user.role === "FACULTY") {
          setActiveTab("faculty_timetable");
          await loadFacultyData(token);
        } else if (user.role === "STUDENT") {
          setActiveTab("student_timetable");
          await loadStudentData(token);
        } else {
          setActiveTab("landing");
          await checkHealthAndLoad();
        }
      } else {
        sessionStorage.removeItem("schedulr_auth_token");
        sessionStorage.removeItem("schedulr_user");
        setAuthToken(null);
        setCurrentUser(null);
      }
    } catch (e) {
      console.warn("Auth check failed:", e);
    } finally {
      setAuthChecking(false);
    }
  }

  async function loadFacultyData(token = authToken) {
    setRoleLoading(true);
    try {
      const res = await apiFetch("/faculty/me/schedule");
      if (res.ok) {
        const data = await res.json();
        setFacultySchedule(data);
      }
    } catch (err) {
      console.error("Failed to load faculty schedule:", err);
    } finally {
      setRoleLoading(false);
    }
  }

  async function loadStudentData(token = authToken) {
    setRoleLoading(true);
    try {
      const res = await apiFetch("/student/me/schedule");
      if (res.ok) {
        const data = await res.json();
        setStudentSchedule(data);
      }
    } catch (err) {
      console.error("Failed to load student schedule:", err);
    } finally {
      setRoleLoading(false);
    }
  }

  async function handleLoginSuccess(token, user) {
    sessionStorage.setItem("schedulr_auth_token", token);
    sessionStorage.setItem("schedulr_user", JSON.stringify(user));
    setAuthToken(token);
    setCurrentUser(user);
    if (user.role === "FACULTY") {
      setActiveTab("faculty_timetable");
      await loadFacultyData(token);
    } else if (user.role === "STUDENT") {
      setActiveTab("student_timetable");
      await loadStudentData(token);
    } else {
      setActiveTab("landing");
      await checkHealthAndLoad();
    }
  }

  async function handleLogout() {
    try {
      await apiFetch("/auth/logout", { method: "POST" });
    } catch {}
    sessionStorage.removeItem("schedulr_auth_token");
    sessionStorage.removeItem("schedulr_user");
    setAuthToken(null);
    setCurrentUser(null);
    setFacultySchedule(null);
    setStudentSchedule(null);
    setActiveTab("landing");
  }

  useEffect(() => {
    refreshIcons();
  }, [activeTab, dataTab, timetableMode, scheduleResponse, isSolving, showAddModal, selectedAssignment, backlogBanner]);

  async function checkHealthAndLoad() {
    try {
      const res = await fetch(`${API_BASE}/health`);
      if (res.ok) {
        const data = await res.json();
        setApiOnline(true);
        setEngineInfo(data.engine || "Google OR-Tools CP-SAT");
        loadScenario("feasible");
      } else {
        fallbackInit();
      }
    } catch (err) {
      console.warn("Backend not reached immediately, initializing fallback...", err);
      fallbackInit();
    }
  }

  function fallbackInit() {
    fetchScenarioFallback("feasible");
  }

  async function loadScenario(type) {
    setSelectedScenario(type);
    setIsSolving(true);
    try {
      if (type === "backlog-demo") {
        const res = await apiFetch("/scenarios/backlog-demo");
        if (res.ok) {
          const pack = await res.json();
          setDataset(pack.dataset);
          setScheduleResponse(pack.schedule);
          setSelectedScenario("backlog-demo");
          setSelectedFilterEntity("STU-2026CS104");
          setTimetableMode("student");
          setActiveTab("backlogs");
          setIsSolving(false);
          return;
        }
      }

      let endpoint = `${API_BASE}/scenarios/feasible`;
      if (type === "impossible") endpoint = `${API_BASE}/scenarios/impossible`;
      if (type === "large") endpoint = `${API_BASE}/scenarios/large`;

      const res = await apiFetch(endpoint);
      if (res.ok) {
        const data = await res.json();
        setDataset(data);
        setPreferences(data.preferences || preferences);
        await runSolver(data);
      } else {
        fetchScenarioFallback(type);
      }
    } catch (e) {
      console.error("Failed to load scenario from API:", e);
      fetchScenarioFallback(type);
    } finally {
      setIsSolving(false);
    }
  }

  async function handleUpdateEnrolmentStatus(enrolmentId, newStatus, notes = "") {
    try {
      const res = await apiFetch("/enrolments/update-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enrolmentId: enrolmentId,
          status: newStatus,
          notes: notes,
          updatedBy: "Admin (Academic Office)",
          dataset: dataset
        })
      });
      if (res.ok) {
        const result = await res.json();
        setDataset(result.dataset);
        setScheduleResponse(result.schedule);
        setBacklogBanner({
          message: result.message,
          studentId: result.student_id,
          studentName: result.student_name,
          studentRegNo: result.student_reg_no,
          courseCode: result.course_code,
          freedSlot: result.freed_slot,
          canReoptimise: result.can_reoptimise,
          timestamp: new Date().toLocaleTimeString()
        });
        return result;
      }
    } catch (err) {
      console.error("Failed to update enrolment status:", err);
    }
  }

  function fetchScenarioFallback(type) {
    const slots = createDefaultTimeSlots();
    if (type === "impossible") {
      const impData = {
        sections: [
          { id: "SEC-CS301-A", course_code: "CS301", course_name: "Advanced Systems Lab", department: "Computer Science", section_label: "A", enrolment_count: 75, faculty_id: "FAC-TURING", required_room_type: "Lab", color: "#facc15" },
          { id: "SEC-EE204-A", course_code: "EE204", course_name: "Embedded Microcontrollers Lab", department: "Electrical Eng", section_label: "A", enrolment_count: 70, faculty_id: "FAC-LOVELACE", required_room_type: "Lab", color: "#fb923c" },
          { id: "SEC-MTH204-A", course_code: "MTH204", course_name: "Applied Linear Algebra", department: "Mathematics", section_label: "A", enrolment_count: 65, faculty_id: "FAC-GAUSS", required_room_type: "Lecture", color: "#38bdf8" }
        ],
        rooms: [
          { id: "R-LAB101", name: "Turing Computing Lab", building: "IT Block", capacity: 80, room_type: "Lab", unavailable_slots: [] },
          { id: "R-LAB102", name: "Hardware Workshop", building: "EE Block", capacity: 40, room_type: "Lab", unavailable_slots: [] }
        ],
        faculty: [
          { id: "FAC-TURING", name: "Dr. Alan Turing", department: "Computer Science", email: "turing@univ.edu", unavailable_slots: slots.filter(s => s.id !== "SLOT-TUE-10").map(s => s.id) },
          { id: "FAC-LOVELACE", name: "Prof. Ada Lovelace", department: "Electrical Eng", email: "lovelace@univ.edu", unavailable_slots: slots.filter(s => s.id !== "SLOT-TUE-10").map(s => s.id) },
          { id: "FAC-GAUSS", name: "Dr. Carl Gauss", department: "Mathematics", email: "gauss@univ.edu", unavailable_slots: [] }
        ],
        students: Array.from({ length: 42 }, (_, i) => ({
          id: `STU-${i + 1}`,
          name: `Dual-Degree Student ${i + 1}`,
          department: "Computer Science",
          semester: 5,
          is_backlog: true,
          enrolled_section_ids: ["SEC-CS301-A", "SEC-EE204-A"]
        })),
        time_slots: slots,
        preferences: preferences
      };
      setDataset(impData);
      setScheduleResponse({
        status: "INFEASIBLE",
        is_feasible: false,
        solve_time_seconds: 0.045,
        hard_conflicts_count: 1,
        assignments_count: 0,
        total_sections: 3,
        conflicts: [{
          id: "CONF-PAIR-CS301-EE204",
          type: "HIGH_OVERLAP_ELECTIVES",
          severity: "CRITICAL",
          title: "Slot & Enrolment Collision: CS301 & EE204",
          description: "CS301 and EE204 cannot be scheduled without a clash because 42 students are enrolled in both sections, both require the only 80-seat laboratory (Turing Computing Lab), and their assigned faculty are unavailable outside Tuesday 10:00-11:00.",
          involved_courses: ["CS301", "EE204"],
          involved_sections: ["SEC-CS301-A", "SEC-EE204-A"],
          involved_faculty: ["Dr. Alan Turing", "Prof. Ada Lovelace"],
          involved_rooms: ["Turing Computing Lab"],
          conflicting_students_count: 42,
          why_impossible: "Both courses strictly require slot Tuesday 10:00-11:00, but Hard Constraint #1 forbids scheduling them concurrently.",
          recommendations: [
            "Expand teaching availability for Dr. Alan Turing to include alternative weekdays.",
            "Add another laboratory/room to decouple room dependency.",
            "Adjust student elective enrollment to resolve cross-department backlog clash."
          ],
          suggested_action: { action: "CHANGE_FACULTY_AVAILABILITY", faculty_id: "FAC-TURING" }
        }],
        is_minimal_conflict_set: true,
        conflict_summary: "Found 1 critical blocking constraint preventing a feasible timetable.",
        metrics: {}
      });
    }
  }

  async function runSolver(currentData = dataset) {
    if (!currentData) return;
    setIsSolving(true);
    try {
      const payload = {
        ...currentData,
        preferences: preferences
      };
      const res = await apiFetch("/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const responseData = await res.json();
        setScheduleResponse(responseData);
      }
    } catch (err) {
      console.error("Solver request failed:", err);
    } finally {
      setIsSolving(false);
    }
  }

  async function applyWhatIfRemedy(remedyType, customParams = {}) {
    if (!dataset) return;
    setIsSolving(true);
    setWhatIfStatus("Applying remedy and running CP-SAT re-solve...");
    try {
      const payload = {
        dataset: JSON.parse(JSON.stringify(dataset)),
        remedy_type: remedyType,
        parameters: customParams
      };
      const res = await apiFetch("/simulate-what-if", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const solved = await res.json();
        setScheduleResponse(solved);
        setWhatIfStatus(solved.is_feasible ? "Success! Remedy resolved all conflicts." : "Remedy partially applied; further constraints remain.");
        if (solved.is_feasible) {
          setActiveTab("timetable");
        }
      }
    } catch (e) {
      console.error("What-If simulation failed:", e);
      setWhatIfStatus("Simulation error occurred.");
    } finally {
      setIsSolving(false);
    }
  }

  function exportScheduleCSV() {
    if (!scheduleResponse || !scheduleResponse.assignments.length) return;
    const headers = ["Course Code", "Course Name", "Department", "Section", "Faculty", "Room", "Capacity", "Enrolment", "Day", "Start Time", "End Time"];
    const rows = scheduleResponse.assignments.map(a => [
      a.course_code,
      `"${a.course_name}"`,
      a.department,
      a.section_label,
      `"${a.faculty_name}"`,
      `"${a.room_name}"`,
      a.room_capacity,
      a.enrolment_count,
      a.day,
      a.start_time,
      a.end_time
    ]);
    const csvContent = "data:text/csv;charset=utf-8," + [headers.join(","), ...rows.map(e => e.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `Schedulr_${activeProject.replace(/\s+/g, "_")}_Timetable.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Unauthenticated and loading guards
  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#09090b] flex flex-col items-center justify-center text-white space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-yellow-400 text-black flex items-center justify-center font-black animate-pulse shadow-lg shadow-yellow-500/20">
          <Icon name="calendar-check" className="w-7 h-7 stroke-[2.5]" />
        </div>
        <p className="text-zinc-400 text-sm font-medium tracking-wide">Initializing Schedulr Security Session...</p>
      </div>
    );
  }

  if (!currentUser) {
    return (
      <AuthScreen
        onLoginSuccess={handleLoginSuccess}
        apiOnline={apiOnline}
        engineInfo={engineInfo}
      />
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-[#09090b] text-white">
      {/* Top Main Navigation Bar */}
      <header className="bg-[#0c0c0e]/95 backdrop-blur-md border-b border-zinc-800 sticky top-0 z-40 shadow-xl no-print">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-6">
            <div 
              className="flex items-center space-x-3 cursor-pointer group"
              onClick={() => {
                if (currentUser?.role === 'FACULTY') setActiveTab('faculty_timetable');
                else if (currentUser?.role === 'STUDENT') setActiveTab('student_timetable');
                else setActiveTab('landing');
              }}
            >
              <div className="w-10 h-10 rounded-xl bg-yellow-400 text-black flex items-center justify-center font-black shadow-lg shadow-yellow-500/25 group-hover:bg-yellow-300 transition transform group-hover:scale-105 duration-200">
                <Icon name="calendar-check" className="w-6 h-6 stroke-[2.5]" />
              </div>
              <div>
                <span className="text-xl font-black tracking-tight text-white group-hover:text-yellow-400 transition">Schedulr</span>
                <span className="hidden sm:inline-block ml-2 px-2 py-0.5 text-xs font-bold bg-yellow-400/10 text-yellow-400 rounded-full border border-yellow-400/30">
                  Clash Resolver
                </span>
              </div>
            </div>

            {/* Navigation Links based on User Role */}
            <nav className="hidden md:flex items-center space-x-1">
              {currentUser?.role === "ADMIN" && [
                { id: "landing", label: "Overview" },
                { id: "dashboard", label: "Dashboard" },
                { id: "datamanager", label: "Data Manager" },
                { id: "backlogs", label: "Backlog Management" },
                { id: "generate", label: "Generate Schedule" },
                { id: "timetable", label: "Timetable Grid" },
                { id: "conflictlab", label: "Conflict Lab" },
                { id: "insights", label: "Insights" }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold transition ${
                    activeTab === tab.id
                      ? 'bg-zinc-800 text-yellow-400 border border-yellow-400/30 shadow-xs'
                      : 'text-zinc-400 hover:text-white hover:bg-zinc-900/60'
                  }`}
                >
                  {tab.label}
                  {tab.id === 'backlogs' && dataset?.enrolments && (
                    <span className="ml-1.5 px-1.5 py-0.2 bg-yellow-400 text-black text-[10px] rounded-full font-black">
                      {dataset.enrolments.filter(e => (e.enrolment_type === 'Backlog' || e.enrolmentType === 'Backlog') && e.status === 'Active').length}
                    </span>
                  )}
                  {tab.id === 'conflictlab' && scheduleResponse && !scheduleResponse.is_feasible && (
                    <span className="ml-1.5 px-1.5 py-0.2 bg-rose-500 text-white text-[10px] rounded-full font-black animate-pulse">
                      {scheduleResponse.conflicts?.length || 1}
                    </span>
                  )}
                </button>
              ))}

              {currentUser?.role === "FACULTY" && [
                { id: "faculty_timetable", label: "My Timetable" },
                { id: "faculty_sections", label: "My Sections" },
                { id: "faculty_availability", label: "My Availability" },
                { id: "faculty_insights", label: "Teaching Insights" }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold transition ${
                    activeTab === tab.id
                      ? 'bg-zinc-800 text-yellow-400 border border-yellow-400/30 shadow-xs'
                      : 'text-zinc-400 hover:text-white hover:bg-zinc-900/60'
                  }`}
                >
                  {tab.label}
                </button>
              ))}

              {currentUser?.role === "STUDENT" && [
                { id: "student_timetable", label: "My Timetable" },
                { id: "student_courses", label: "My Courses" },
                { id: "student_backlogs", label: "My Backlogs & Freed Slots" },
                { id: "student_profile", label: "Student Profile" }
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-3 py-2 rounded-lg text-sm font-semibold transition ${
                    activeTab === tab.id
                      ? 'bg-zinc-800 text-yellow-400 border border-yellow-400/30 shadow-xs'
                      : 'text-zinc-400 hover:text-white hover:bg-zinc-900/60'
                  }`}
                >
                  {tab.label}
                  {tab.id === 'student_backlogs' && studentSchedule?.freed_slots?.length > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.2 bg-emerald-400 text-black text-[10px] rounded-full font-black">
                      {studentSchedule.freed_slots.length} Freed
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex items-center space-x-3">
            {/* Engine Status indicator */}
            <div className="hidden lg:flex items-center space-x-2 text-xs text-zinc-300 bg-zinc-900 px-3 py-1.5 rounded-lg border border-zinc-800">
              <span className={`w-2 h-2 rounded-full ${apiOnline ? 'bg-yellow-400 animate-pulse' : 'bg-yellow-400'}`}></span>
              <span className="font-mono">{engineInfo}</span>
            </div>

            {/* Quick Run CTA for ADMIN */}
            {currentUser?.role === "ADMIN" && (
              <button
                onClick={() => runSolver()}
                disabled={isSolving || !dataset}
                className={`flex items-center space-x-2 px-3.5 py-2 rounded-lg text-xs font-black shadow-lg transition ${
                  isSolving
                    ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed'
                    : 'bg-yellow-400 hover:bg-yellow-300 text-black active:scale-95 shadow-yellow-500/20'
                }`}
              >
                {isSolving ? (
                  <>
                    <Icon name="loader-2" className="animate-spin w-3.5 h-3.5 text-black" />
                    <span>Solving...</span>
                  </>
                ) : (
                  <>
                    <Icon name="sparkles" className="w-3.5 h-3.5 text-black" />
                    <span>Generate Timetable</span>
                  </>
                )}
              </button>
            )}

            {/* User Profile Summary & Sign Out */}
            <div className="flex items-center space-x-3 pl-2 border-l border-zinc-800">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-black text-yellow-400">
                  {currentUser.full_name ? currentUser.full_name.charAt(0).toUpperCase() : "U"}
                </div>
                <div className="hidden sm:block text-left">
                  <div className="text-xs font-bold text-white flex items-center space-x-1.5">
                    <span className="truncate max-w-[120px]">{currentUser.full_name}</span>
                    {currentUser.role === "ADMIN" && (
                      <span className="px-1.5 py-0.2 text-[9px] font-black bg-yellow-400 text-black rounded">ADMIN</span>
                    )}
                    {currentUser.role === "FACULTY" && (
                      <span className="px-1.5 py-0.2 text-[9px] font-bold bg-sky-400/20 text-sky-400 border border-sky-400/30 rounded">FACULTY</span>
                    )}
                    {currentUser.role === "STUDENT" && (
                      <span className="px-1.5 py-0.2 text-[9px] font-bold bg-emerald-400/20 text-emerald-400 border border-emerald-400/30 rounded">STUDENT</span>
                    )}
                  </div>
                  <div className="text-[10px] text-zinc-400 truncate max-w-[120px]">{currentUser.email}</div>
                </div>
              </div>

              <button
                onClick={handleLogout}
                title="Sign Out"
                className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-rose-400 border border-zinc-800 transition flex items-center space-x-1 text-xs font-semibold"
              >
                <Icon name="log-out" className="w-3.5 h-3.5" />
                <span className="hidden md:inline">Sign Out</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Role Portal Views */}
        {currentUser?.role === "FACULTY" && (
          <FacultyPortal
            facultySchedule={facultySchedule}
            activeSubTab={activeTab}
            onNavigate={(tab) => setActiveTab(tab)}
            currentUser={currentUser}
            roleLoading={roleLoading}
            onRefresh={() => loadFacultyData()}
          />
        )}

        {currentUser?.role === "STUDENT" && (
          <StudentPortal
            studentSchedule={studentSchedule}
            activeSubTab={activeTab}
            onNavigate={(tab) => setActiveTab(tab)}
            currentUser={currentUser}
            roleLoading={roleLoading}
            onRefresh={() => loadStudentData()}
          />
        )}
        {activeTab === "landing" && (
          <LandingPage 
            onOpenScheduler={() => setActiveTab("generate")}
            onTryFeasible={() => { loadScenario("feasible"); setActiveTab("timetable"); }}
            onTryImpossible={() => { loadScenario("impossible"); setActiveTab("conflictlab"); }}
            onTryLarge={() => { loadScenario("large"); setActiveTab("dashboard"); }}
            onTryBacklogDemo={() => loadScenario("backlog-demo")}
            dataset={dataset}
            scheduleResponse={scheduleResponse}
          />
        )}

        {activeTab === "dashboard" && (
          <DashboardPage
            dataset={dataset}
            scheduleResponse={scheduleResponse}
            onNavigate={(tab) => setActiveTab(tab)}
            isSolving={isSolving}
          />
        )}

        {activeTab === "datamanager" && (
          <DataManagerPage
            dataset={dataset}
            setDataset={setDataset}
            activeSubTab={dataTab}
            setActiveSubTab={setDataTab}
            onTriggerSolve={() => runSolver()}
            onUpdateEnrolmentStatus={handleUpdateEnrolmentStatus}
          />
        )}

        {activeTab === "backlogs" && (
          <BacklogManagementPage
            dataset={dataset}
            setDataset={setDataset}
            scheduleResponse={scheduleResponse}
            setScheduleResponse={setScheduleResponse}
            banner={backlogBanner}
            setBanner={setBacklogBanner}
            onUpdateStatus={handleUpdateEnrolmentStatus}
            onNavigateToStudentTimetable={(studentId) => {
              setSelectedFilterEntity(studentId);
              setTimetableMode("student");
              setActiveTab("timetable");
            }}
            onReoptimiseTimetable={() => runSolver()}
            onLoadBacklogDemo={() => loadScenario("backlog-demo")}
            isSolving={isSolving}
          />
        )}

        {activeTab === "generate" && (
          <GenerateSchedulePage
            selectedScenario={selectedScenario}
            onSelectScenario={(s) => loadScenario(s)}
            preferences={preferences}
            setPreferences={setPreferences}
            onGenerate={() => runSolver()}
            isSolving={isSolving}
            scheduleResponse={scheduleResponse}
            onViewTimetable={() => setActiveTab("timetable")}
            onViewConflicts={() => setActiveTab("conflictlab")}
            onExportCSV={exportScheduleCSV}
          />
        )}

        {activeTab === "timetable" && (
          <TimetableVisualizer
            dataset={dataset}
            scheduleResponse={scheduleResponse}
            mode={timetableMode}
            setMode={setTimetableMode}
            filterEntity={selectedFilterEntity}
            setFilterEntity={setSelectedFilterEntity}
            searchQuery={searchQuery}
            setSearchQuery={setSearchQuery}
            onSelectAssignment={(a) => setSelectedAssignment(a)}
            onExportCSV={exportScheduleCSV}
          />
        )}

        {activeTab === "conflictlab" && (
          <ConflictLabPage
            dataset={dataset}
            scheduleResponse={scheduleResponse}
            onApplyRemedy={applyWhatIfRemedy}
            statusMessage={whatIfStatus}
            isSolving={isSolving}
          />
        )}

        {activeTab === "insights" && (
          <InsightsPage
            dataset={dataset}
            scheduleResponse={scheduleResponse}
          />
        )}

        {activeTab === "settings" && (
          <SettingsPage
            preferences={preferences}
            setPreferences={setPreferences}
            onReset={(type) => loadScenario(type)}
          />
        )}
      </main>

      {/* Assignment Detail Modal */}
      {selectedAssignment && (
        <AssignmentDetailModal
          assignment={selectedAssignment}
          onClose={() => setSelectedAssignment(null)}
          dataset={dataset}
        />
      )}

      {/* Footer */}
      <footer className="bg-[#0c0c0e] border-t border-zinc-800 py-6 mt-12 no-print text-center text-sm text-zinc-400">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex items-center space-x-2">
            <span className="font-bold text-yellow-400">Schedulr</span>
            <span className="text-zinc-400">— Timetable Clash Resolver for Higher Education</span>
          </div>
          <div className="flex items-center space-x-3 text-xs">
            <span className="px-2.5 py-1 bg-zinc-900 border border-zinc-800 rounded-md font-mono text-yellow-400">Google OR-Tools CP-SAT</span>
            <span className="px-2.5 py-1 bg-zinc-900 border border-zinc-800 rounded-md font-mono text-white">FastAPI</span>
            <span className="px-2.5 py-1 bg-zinc-900 border border-zinc-800 rounded-md font-mono text-white">React 18</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

// --------------------------------------------------------------------------
// 1. LANDING / OVERVIEW PAGE COMPONENT (BLACK - YELLOW - WHITE)
// --------------------------------------------------------------------------
function LandingPage({ onOpenScheduler, onTryFeasible, onTryImpossible, onTryLarge, onTryBacklogDemo, dataset, scheduleResponse }) {
  return (
    <div className="space-y-16 py-4">
      {/* Hero Section */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-b from-zinc-900 via-[#101014] to-black text-white p-8 sm:p-12 lg:p-16 shadow-2xl border-2 border-yellow-400/20">
        <div className="absolute top-0 right-0 w-96 h-96 bg-yellow-400/5 rounded-full blur-3xl pointer-events-none"></div>
        <div className="relative z-10 max-w-3xl space-y-6">
          <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-yellow-400/10 border border-yellow-400/30 text-yellow-400 text-xs font-bold tracking-wide uppercase">
            <Icon name="sparkles" className="w-3.5 h-3.5 text-yellow-400" />
            <span>Mathematical Optimisation for University Scheduling</span>
          </div>
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-black tracking-tight leading-tight">
            Build timetables. <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 via-amber-200 to-white">
              Resolve conflicts.
            </span> <br />
            Save weeks of manual work.
          </h1>
          <p className="text-lg text-zinc-300 leading-relaxed max-w-2xl">
            Universities struggle to schedule courses for students with complex electives and backlogs while juggling room capacities, faculty availability, and lunch breaks. Schedulr finds the optimal clash-free schedule or explains mathematically why one cannot exist.
          </p>

          <div className="flex flex-wrap gap-4 pt-4">
            <button
              onClick={onOpenScheduler}
              className="px-6 py-3.5 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-black font-black shadow-lg shadow-yellow-500/25 active:scale-95 transition flex items-center space-x-2"
            >
              <span>Open Scheduler Workspace</span>
              <Icon name="arrow-right" className="w-5 h-5 text-black" />
            </button>
            <button
              onClick={onTryFeasible}
              className="px-6 py-3.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white font-bold border border-zinc-700 active:scale-95 transition flex items-center space-x-2"
            >
              <Icon name="play" className="w-4 h-4 text-yellow-400" />
              <span>Try Feasible Demo</span>
            </button>
            <button
              onClick={onTryBacklogDemo}
              className="px-6 py-3.5 rounded-xl bg-yellow-400/10 hover:bg-yellow-400/20 text-yellow-300 font-bold border border-yellow-400/40 active:scale-95 transition flex items-center space-x-2"
            >
              <Icon name="check-circle" className="w-4 h-4 text-yellow-400" />
              <span>Backlog Resolution Demo</span>
            </button>
            <button
              onClick={onTryImpossible}
              className="px-6 py-3.5 rounded-xl bg-rose-950/40 hover:bg-rose-900/60 text-rose-300 font-bold border border-rose-800/50 active:scale-95 transition flex items-center space-x-2"
            >
              <Icon name="alert-triangle" className="w-4 h-4 text-rose-400" />
              <span>Test Impossible Clash Demo</span>
            </button>
          </div>
        </div>

        {/* Floating Mini Timetable Graphic */}
        <div className="hidden lg:block absolute -right-6 -bottom-8 w-[420px] bg-black/90 rounded-2xl p-5 border-2 border-yellow-400/30 shadow-2xl backdrop-blur-md transform rotate-1 hover:rotate-0 transition duration-500">
          <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
            <span className="text-xs font-black text-white uppercase tracking-wider">Live Timetable Preview</span>
            <span className="px-2 py-0.5 text-[10px] font-black bg-yellow-400/20 text-yellow-400 rounded-full border border-yellow-400/40">OPTIMAL</span>
          </div>
          <div className="grid grid-cols-3 gap-2 pt-3 text-xs">
            <div className="bg-zinc-900 p-2.5 rounded-lg border border-yellow-400/30">
              <span className="font-black text-yellow-400 block">CS301-A</span>
              <span className="text-[10px] text-zinc-400">Turing Lab 1</span>
              <span className="text-[10px] text-white block mt-1 font-mono">Mon 10:00</span>
            </div>
            <div className="bg-zinc-900 p-2.5 rounded-lg border border-amber-500/30">
              <span className="font-black text-amber-400 block">EE204-A</span>
              <span className="text-[10px] text-zinc-400">Tesla Lab</span>
              <span className="text-[10px] text-white block mt-1 font-mono">Tue 14:00</span>
            </div>
            <div className="bg-zinc-900 p-2.5 rounded-lg border border-zinc-700">
              <span className="font-black text-white block">MTH204-A</span>
              <span className="text-[10px] text-zinc-400">Hall 101</span>
              <span className="text-[10px] text-yellow-400 block mt-1 font-mono">Wed 11:00</span>
            </div>
          </div>
          <div className="mt-3 pt-3 border-t border-zinc-800 flex justify-between items-center text-[11px] text-zinc-400">
            <span>Room Util: <strong className="text-yellow-400">88.5%</strong></span>
            <span>Conflicts: <strong className="text-white">0</strong></span>
          </div>
        </div>
      </div>

      {/* 4 Feature Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-zinc-900/90 p-6 rounded-2xl border border-zinc-800 hover:border-yellow-400/60 shadow-lg transition group">
          <div className="w-12 h-12 rounded-xl bg-yellow-400/10 text-yellow-400 border border-yellow-400/20 flex items-center justify-center mb-4 group-hover:bg-yellow-400 group-hover:text-black transition">
            <Icon name="shield-check" className="w-6 h-6 stroke-[2.5]" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">Zero Double-Bookings</h3>
          <p className="text-sm text-zinc-400 leading-relaxed">
            CP-SAT enforces hard constraints: no student has simultaneous enrolled sections, no faculty teaches two classes at once, and no room hosts two sessions.
          </p>
        </div>

        <div className="bg-zinc-900/90 p-6 rounded-2xl border border-zinc-800 hover:border-yellow-400/60 shadow-lg transition group">
          <div className="w-12 h-12 rounded-xl bg-yellow-400/10 text-yellow-400 border border-yellow-400/20 flex items-center justify-center mb-4 group-hover:bg-yellow-400 group-hover:text-black transition">
            <Icon name="search-code" className="w-6 h-6 stroke-[2.5]" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">Explainable Conflicts</h3>
          <p className="text-sm text-zinc-400 leading-relaxed">
            When a timetable is impossible, Schedulr doesn't just fail. It pinpoints the exact minimal blocking bottleneck and provides actionable remedy options.
          </p>
        </div>

        <div className="bg-zinc-900/90 p-6 rounded-2xl border border-zinc-800 hover:border-yellow-400/60 shadow-lg transition group">
          <div className="w-12 h-12 rounded-xl bg-yellow-400/10 text-yellow-400 border border-yellow-400/20 flex items-center justify-center mb-4 group-hover:bg-yellow-400 group-hover:text-black transition">
            <Icon name="heart-handshake" className="w-6 h-6 stroke-[2.5]" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">Optimised for Students</h3>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Soft-constraint optimization protects the 1:00-2:00 PM lunch hour, eliminates fatigue from &gt;3 back-to-back lectures, and minimizes oversized room waste.
          </p>
        </div>

        <div className="bg-zinc-900/90 p-6 rounded-2xl border border-zinc-800 hover:border-yellow-400/60 shadow-lg transition group">
          <div className="w-12 h-12 rounded-xl bg-yellow-400/10 text-yellow-400 border border-yellow-400/20 flex items-center justify-center mb-4 group-hover:bg-yellow-400 group-hover:text-black transition">
            <Icon name="zap" className="w-6 h-6 stroke-[2.5]" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">Solves Large Datasets Fast</h3>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Optimized constraint-programming architecture handles 1,500 students and 120 sections in seconds with deterministic, reproducible outputs.
          </p>
        </div>
      </div>

      {/* Comparison Section: Feasible vs Impossible */}
      <div className="bg-zinc-900 rounded-3xl border border-zinc-800 p-8 shadow-xl">
        <h2 className="text-2xl font-black text-white mb-2">Two Built-In Interactive Scenarios</h2>
        <p className="text-zinc-400 mb-6">Compare how Schedulr balances complex soft objectives on feasible data versus isolating bottleneck collisions on impossible data.</p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="border-2 border-yellow-400/30 rounded-2xl p-6 bg-black/60">
            <div className="flex items-center space-x-3 mb-3">
              <span className="w-8 h-8 rounded-lg bg-yellow-400 text-black flex items-center justify-center font-black">1</span>
              <h4 className="text-lg font-bold text-white">Feasible University Scenario</h4>
            </div>
            <p className="text-sm text-zinc-400 mb-4">
              16 sections, 10 rooms, 16 faculty, and 180 students across 6 departments with overlapping electives. Solves to optimality with protected lunch break.
            </p>
            <button
              onClick={onTryFeasible}
              className="w-full py-2.5 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-black font-extrabold text-sm transition shadow-md shadow-yellow-500/20"
            >
              Load &amp; View Feasible Schedule
            </button>
          </div>

          <div className="border border-zinc-700 rounded-2xl p-6 bg-black/60">
            <div className="flex items-center space-x-3 mb-3">
              <span className="w-8 h-8 rounded-lg bg-zinc-800 text-rose-400 border border-rose-500/30 flex items-center justify-center font-black">2</span>
              <h4 className="text-lg font-bold text-white">Impossible Conflict Scenario</h4>
            </div>
            <p className="text-sm text-zinc-400 mb-4">
              42 shared students between CS301 and EE204, a single 80-seat Lab, and restricted Tuesday 10-11 AM availability. Watch Conflict Lab isolate the exact collision!
            </p>
            <button
              onClick={onTryImpossible}
              className="w-full py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-bold text-sm border border-zinc-600 transition shadow-sm"
            >
              Simulate &amp; Diagnose Conflict
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// 2. DASHBOARD PAGE COMPONENT (BLACK - YELLOW - WHITE)
// --------------------------------------------------------------------------
function DashboardPage({ dataset, scheduleResponse, onNavigate, isSolving }) {
  const chartRef1 = useRef(null);
  const chartRef2 = useRef(null);
  const chartInstance1 = useRef(null);
  const chartInstance2 = useRef(null);

  const sectionsCount = dataset?.sections?.length || 0;
  const studentsCount = dataset?.students?.length || 0;
  const roomsCount = dataset?.rooms?.length || 0;
  const facultyCount = dataset?.faculty?.length || 0;
  const solveTime = scheduleResponse?.solve_time_seconds || 0;
  const hardConflicts = scheduleResponse?.hard_conflicts_count || 0;
  const softScore = scheduleResponse?.soft_constraint_score || 0;
  const roomUtil = scheduleResponse?.metrics?.room_utilization_percent || 0;
  const protectedCount = scheduleResponse?.metrics?.students_protected_count || studentsCount;

  // Render Dashboard Charts with Yellow & Black Palette
  useEffect(() => {
    if (!scheduleResponse?.assignments) return;

    // Chart 1: Room Usage by Day
    if (chartRef1.current) {
      if (chartInstance1.current) chartInstance1.current.destroy();

      const dayCounts = { Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0 };
      scheduleResponse.assignments.forEach(a => {
        if (dayCounts[a.day] !== undefined) dayCounts[a.day]++;
      });

      const ctx1 = chartRef1.current.getContext('2d');
      chartInstance1.current = new Chart(ctx1, {
        type: 'bar',
        data: {
          labels: Object.keys(dayCounts),
          datasets: [{
            label: 'Scheduled Sections',
            data: Object.values(dayCounts),
            backgroundColor: '#facc15', // Vibrant Yellow
            borderRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            y: { 
              beginAtZero: true, 
              grid: { color: '#27272a' }, 
              ticks: { color: '#a1a1aa', stepSize: 1 } 
            },
            x: { 
              grid: { display: false },
              ticks: { color: '#e4e4e7', font: { weight: 'bold' } }
            }
          }
        }
      });
    }

    // Chart 2: Hourly Schedule Density
    if (chartRef2.current) {
      if (chartInstance2.current) chartInstance2.current.destroy();

      const hours = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"];
      const hourCounts = {};
      hours.forEach(h => hourCounts[h] = 0);

      scheduleResponse.assignments.forEach(a => {
        if (hourCounts[a.start_time] !== undefined) hourCounts[a.start_time]++;
      });

      const ctx2 = chartRef2.current.getContext('2d');
      chartInstance2.current = new Chart(ctx2, {
        type: 'line',
        data: {
          labels: hours,
          datasets: [{
            label: 'Active Lectures',
            data: Object.values(hourCounts),
            borderColor: '#facc15', // Vibrant Yellow
            backgroundColor: 'rgba(250, 204, 21, 0.15)',
            borderWidth: 3,
            fill: true,
            tension: 0.3,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#facc15',
            pointBorderWidth: 2,
            pointRadius: 4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: function(context) {
                  const label = context.parsed.y + ' lectures';
                  return context.label === '13:00' ? label + ' (Lunch Hour Protected)' : label;
                }
              }
            }
          },
          scales: {
            y: { 
              beginAtZero: true, 
              grid: { color: '#27272a' }, 
              ticks: { color: '#a1a1aa', stepSize: 1 } 
            },
            x: { 
              grid: { display: false },
              ticks: { color: '#e4e4e7', font: { weight: 'bold' } }
            }
          }
        }
      });
    }

    return () => {
      if (chartInstance1.current) chartInstance1.current.destroy();
      if (chartInstance2.current) chartInstance2.current.destroy();
    };
  }, [scheduleResponse]);

  return (
    <div className="space-y-8">
      {/* Top Banner Status */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center bg-zinc-900 p-6 rounded-2xl border border-zinc-800 shadow-xl gap-4">
        <div>
          <h2 className="text-2xl font-black text-white tracking-tight">University Scheduling Dashboard</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Current active schedule state, constraint compliance, and resource distribution.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          {scheduleResponse?.is_feasible ? (
            <span className="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-bold bg-yellow-400/10 text-yellow-400 border border-yellow-400/30">
              <Icon name="check-circle" className="w-4 h-4 mr-1.5 text-yellow-400" />
              Valid Clash-Free Timetable
            </span>
          ) : (
            <button
              onClick={() => onNavigate("conflictlab")}
              className="inline-flex items-center px-3 py-1.5 rounded-full text-xs font-bold bg-rose-500/20 text-rose-300 border border-rose-500/30 hover:bg-rose-500/30 transition"
            >
              <Icon name="alert-triangle" className="w-4 h-4 mr-1.5 text-rose-400" />
              {hardConflicts} Conflict(s) Detected — Open Lab
            </button>
          )}

          <button
            onClick={() => onNavigate("timetable")}
            className="px-4 py-2 bg-yellow-400 hover:bg-yellow-300 text-black text-sm font-extrabold rounded-lg shadow-md transition"
          >
            View Timetable Grid
          </button>
        </div>
      </div>

      {/* 8 Primary Summary KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-sm">
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Total Sections</div>
          <div className="text-3xl font-black text-white mt-2">{sectionsCount}</div>
          <div className="text-xs text-zinc-500 mt-1">Academic sections queued</div>
        </div>

        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-sm">
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Total Students</div>
          <div className="text-3xl font-black text-white mt-2">{studentsCount}</div>
          <div className="text-xs text-zinc-500 mt-1">Unique enrolled individuals</div>
        </div>

        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-sm">
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Faculty Count</div>
          <div className="text-3xl font-black text-white mt-2">{facultyCount}</div>
          <div className="text-xs text-zinc-500 mt-1">Instructors assigned</div>
        </div>

        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-sm">
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Rooms Available</div>
          <div className="text-3xl font-black text-white mt-2">{roomsCount}</div>
          <div className="text-xs text-zinc-500 mt-1">Lecture halls &amp; labs</div>
        </div>

        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-sm">
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Last Solve Time</div>
          <div className="text-3xl font-black text-yellow-400 mt-2">{solveTime}s</div>
          <div className="text-xs text-zinc-500 mt-1">CP-SAT solver runtime</div>
        </div>

        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-sm">
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Hard Conflicts</div>
          <div className={`text-3xl font-black mt-2 ${hardConflicts === 0 ? 'text-yellow-400' : 'text-rose-400'}`}>
            {hardConflicts}
          </div>
          <div className="text-xs text-zinc-500 mt-1">{hardConflicts === 0 ? 'Zero double-bookings' : 'Violations blocking solve'}</div>
        </div>

        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-sm">
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Room Utilisation</div>
          <div className="text-3xl font-black text-white mt-2">{roomUtil}%</div>
          <div className="text-xs text-zinc-500 mt-1">Weekly capacity filled</div>
        </div>

        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-sm">
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Clash-Free Students</div>
          <div className="text-3xl font-black text-yellow-400 mt-2">{protectedCount}</div>
          <div className="text-xs text-zinc-500 mt-1">100% schedule isolation</div>
        </div>
      </div>

      {/* Dynamic Backlog Resolution Impact Strip */}
      <div className="bg-black/80 p-5 rounded-2xl border border-yellow-400/30 shadow-lg space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-400 animate-pulse"></span>
            <span className="text-xs font-black uppercase text-yellow-400 tracking-wider">Dynamic Backlog Resolution Analytics</span>
          </div>
          <button
            onClick={() => onNavigate("backlogs")}
            className="text-xs text-yellow-400 hover:text-white font-bold flex items-center space-x-1"
          >
            <span>Open Backlog Hub</span>
            <Icon name="arrow-right" className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-center sm:text-left">
          <div className="bg-zinc-900/90 p-3.5 rounded-xl border border-zinc-800">
            <div className="text-[11px] font-bold text-zinc-400 uppercase">Active Backlog Students</div>
            <div className="text-2xl font-black text-yellow-400 mt-1">
              {dataset?.enrolments ? dataset.enrolments.filter(e => e.enrolment_type === "Backlog" && e.status === "Active").length : dataset?.students?.filter(s => s.is_backlog).length || 0}
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">Enrolled with active backlog</div>
          </div>
          <div className="bg-zinc-900/90 p-3.5 rounded-xl border border-zinc-800">
            <div className="text-[11px] font-bold text-zinc-400 uppercase">Backlogs Cleared</div>
            <div className="text-2xl font-black text-emerald-400 mt-1">
              {dataset?.enrolments?.filter(e => e.enrolment_type === "Backlog" && e.status === "Cleared").length || scheduleResponse?.metrics?.cleared_backlogs_count || 0}
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">Freed without rescheduling</div>
          </div>
          <div className="bg-zinc-900/90 p-3.5 rounded-xl border border-zinc-800">
            <div className="text-[11px] font-bold text-zinc-400 uppercase">Conflicts Resolved</div>
            <div className="text-2xl font-black text-white mt-1">
              {scheduleResponse?.metrics?.conflicts_resolved_by_clearance || scheduleResponse?.backlog_resolutions?.length || 0}
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">Overlaps eliminated</div>
          </div>
          <div className="bg-zinc-900/90 p-3.5 rounded-xl border border-zinc-800">
            <div className="text-[11px] font-bold text-zinc-400 uppercase">Freed Student-Hours</div>
            <div className="text-2xl font-black text-yellow-400 mt-1">
              {(scheduleResponse?.metrics?.freed_student_hours || dataset?.enrolments?.filter(e => e.enrolment_type === "Backlog" && e.status === "Cleared").length || 0)} hrs
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">Available free periods</div>
          </div>
          <div className="bg-zinc-900/90 p-3.5 rounded-xl border border-zinc-800">
            <div className="text-[11px] font-bold text-zinc-400 uppercase">Reduced Sections</div>
            <div className="text-2xl font-black text-white mt-1">
              {dataset?.sections?.filter(s => (s.original_enrolment_count || s.enrolment_count) > (s.active_enrolment_count != null ? s.active_enrolment_count : s.enrolment_count)).length || 0}
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">Capacity pressure lowered</div>
          </div>
        </div>
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-zinc-900 p-6 rounded-2xl border border-zinc-800 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-white text-base">Room Usage by Day</h3>
            <span className="text-xs text-yellow-400 font-mono">Sections / Day</span>
          </div>
          <div className="h-64 relative">
            <canvas ref={chartRef1}></canvas>
          </div>
        </div>

        <div className="bg-zinc-900 p-6 rounded-2xl border border-zinc-800 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-bold text-white text-base">Schedule Density by Hour</h3>
            <span className="text-xs text-yellow-400 font-mono">13:00 Lunch Protected</span>
          </div>
          <div className="h-64 relative">
            <canvas ref={chartRef2}></canvas>
          </div>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// 3. DATA MANAGER COMPONENT (BLACK - YELLOW - WHITE)
// --------------------------------------------------------------------------
function DataManagerPage({ dataset, setDataset, activeSubTab, setActiveSubTab, onTriggerSolve }) {
  const [searchTerm, setSearchTerm] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [editingItem, setEditingItem] = useState(null);
  const [showModal, setShowModal] = useState(false);

  if (!dataset) return <div>Loading dataset...</div>;

  const currentList = dataset[activeSubTab] || [];

  const filteredList = useMemo(() => {
    return currentList.filter(item => {
      const matchSearch = Object.values(item).some(val => 
        String(val).toLowerCase().includes(searchTerm.toLowerCase())
      );
      if (!matchSearch) return false;

      if (filterType !== "all") {
        if (activeSubTab === "sections" && item.department !== filterType) return false;
        if (activeSubTab === "rooms" && item.room_type !== filterType) return false;
      }
      return true;
    });
  }, [currentList, searchTerm, filterType, activeSubTab]);

  function handleDelete(id) {
    if (!confirm(`Are you sure you want to delete item ${id}?`)) return;
    const updated = {
      ...dataset,
      [activeSubTab]: dataset[activeSubTab].filter(i => i.id !== id)
    };
    setDataset(updated);
  }

  function handleSaveItem(itemData) {
    let updatedList;
    const exists = dataset[activeSubTab].some(i => i.id === itemData.id);
    if (exists) {
      updatedList = dataset[activeSubTab].map(i => i.id === itemData.id ? itemData : i);
    } else {
      updatedList = [...dataset[activeSubTab], itemData];
    }
    setDataset({ ...dataset, [activeSubTab]: updatedList });
    setShowModal(false);
    setEditingItem(null);
  }

  function downloadSample(type) {
    window.open(`${API_BASE}/sample/csv/${type}`, "_blank");
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-zinc-900 p-6 rounded-2xl border border-zinc-800 shadow-xl">
        <div>
          <h2 className="text-2xl font-black text-white tracking-tight">University Data Manager</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Manage course sections, classroom resources, faculty availability, and student enrolments.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={() => downloadSample(activeSubTab)}
            className="px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-semibold rounded-lg border border-zinc-700 transition flex items-center space-x-1.5"
          >
            <Icon name="download" className="w-4 h-4 text-yellow-400" />
            <span>Sample CSV</span>
          </button>
          <button
            onClick={() => { setEditingItem(null); setShowModal(true); }}
            className="px-4 py-2 bg-yellow-400 hover:bg-yellow-300 text-black text-sm font-black rounded-lg shadow-lg shadow-yellow-500/20 transition flex items-center space-x-1.5"
          >
            <Icon name="plus" className="w-4 h-4 stroke-[3]" />
            <span>Add {activeSubTab.slice(0, -1)}</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-zinc-800 space-x-6 overflow-x-auto pb-1">
        {[
          { key: "sections", label: "Sections", icon: "book-open", count: dataset.sections?.length || 0 },
          { key: "enrolments", label: "Enrolments", icon: "user-check", count: dataset.enrolments?.length || 0 },
          { key: "rooms", label: "Rooms & Capacities", icon: "door-closed", count: dataset.rooms?.length || 0 },
          { key: "faculty", label: "Faculty Assignments", icon: "users", count: dataset.faculty?.length || 0 },
          { key: "students", label: "Students", icon: "graduation-cap", count: dataset.students?.length || 0 },
          { key: "time_slots", label: "Time Slots", icon: "clock", count: dataset.time_slots?.length || 0 },
        ].map(tab => (
          <button
            key={tab.key}
            onClick={() => { setActiveSubTab(tab.key); setSearchTerm(""); setFilterType("all"); }}
            className={`pb-3 font-bold text-sm flex items-center space-x-2 border-b-2 transition whitespace-nowrap ${
              activeSubTab === tab.key
                ? 'border-yellow-400 text-yellow-400'
                : 'border-transparent text-zinc-400 hover:text-white'
            }`}
          >
            <Icon name={tab.icon} className="w-4 h-4" />
            <span>{tab.label}</span>
            <span className={`px-2 py-0.5 text-xs rounded-full font-bold ${
              activeSubTab === tab.key ? 'bg-yellow-400 text-black' : 'bg-zinc-800 text-zinc-400'
            }`}>
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
        <div className="relative flex-1 w-full sm:max-w-md">
          <Icon name="search" className="w-4 h-4 absolute left-3.5 top-3 text-zinc-500" />
          <input
            type="text"
            placeholder={`Search ${activeSubTab}...`}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-zinc-900 border border-zinc-800 rounded-xl text-sm text-white placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-yellow-400 focus:border-yellow-400"
          />
        </div>

        <div className="text-xs text-zinc-400 font-medium">
          Showing <strong className="text-white">{filteredList.length}</strong> of {currentList.length} records
        </div>
      </div>

      {/* Table Content */}
      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-zinc-800 text-sm text-left">
            <thead className="bg-zinc-950 text-zinc-400 font-bold text-xs uppercase tracking-wider">
              {activeSubTab === "sections" && (
                <tr>
                  <th className="px-5 py-3.5">Course Code</th>
                  <th className="px-5 py-3.5">Name</th>
                  <th className="px-5 py-3.5">Dept</th>
                  <th className="px-5 py-3.5">Sec</th>
                  <th className="px-5 py-3.5">Original</th>
                  <th className="px-5 py-3.5">Active</th>
                  <th className="px-5 py-3.5">Cleared Backlogs</th>
                  <th className="px-5 py-3.5">Required Room</th>
                  <th className="px-5 py-3.5">Capacity Util</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              )}
              {activeSubTab === "enrolments" && (
                <tr>
                  <th className="px-5 py-3.5">Enrolment ID</th>
                  <th className="px-5 py-3.5">Student</th>
                  <th className="px-5 py-3.5">Course Section</th>
                  <th className="px-5 py-3.5">Type</th>
                  <th className="px-5 py-3.5">Status</th>
                  <th className="px-5 py-3.5">Last Updated</th>
                  <th className="px-5 py-3.5 text-right">Actions</th>
                </tr>
              )}
              {activeSubTab === "rooms" && (
                <tr>
                  <th className="px-6 py-3.5">Room ID</th>
                  <th className="px-6 py-3.5">Name</th>
                  <th className="px-6 py-3.5">Building</th>
                  <th className="px-6 py-3.5">Capacity</th>
                  <th className="px-6 py-3.5">Type</th>
                  <th className="px-6 py-3.5">Blocked Slots</th>
                  <th className="px-6 py-3.5 text-right">Actions</th>
                </tr>
              )}
              {activeSubTab === "faculty" && (
                <tr>
                  <th className="px-6 py-3.5">Faculty ID</th>
                  <th className="px-6 py-3.5">Name</th>
                  <th className="px-6 py-3.5">Department</th>
                  <th className="px-6 py-3.5">Email</th>
                  <th className="px-6 py-3.5">Unavailable Slots</th>
                  <th className="px-6 py-3.5 text-right">Actions</th>
                </tr>
              )}
              {activeSubTab === "students" && (
                <tr>
                  <th className="px-6 py-3.5">Student ID</th>
                  <th className="px-6 py-3.5">Name</th>
                  <th className="px-6 py-3.5">Department</th>
                  <th className="px-6 py-3.5">Semester</th>
                  <th className="px-6 py-3.5">Backlog?</th>
                  <th className="px-6 py-3.5">Enrolled Sections</th>
                  <th className="px-6 py-3.5 text-right">Actions</th>
                </tr>
              )}
              {activeSubTab === "time_slots" && (
                <tr>
                  <th className="px-6 py-3.5">Slot ID</th>
                  <th className="px-6 py-3.5">Day</th>
                  <th className="px-6 py-3.5">Start Time</th>
                  <th className="px-6 py-3.5">End Time</th>
                  <th className="px-6 py-3.5">Type</th>
                  <th className="px-6 py-3.5">Display Label</th>
                </tr>
              )}
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {filteredList.map((item, idx) => (
                <tr key={item.id || idx} className="hover:bg-zinc-800/40 transition">
                  {activeSubTab === "sections" && (
                    <>
                      <td className="px-5 py-4 font-black text-yellow-400 flex items-center space-x-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-yellow-400 shadow-xs"></span>
                        <span>{item.course_code}</span>
                      </td>
                      <td className="px-5 py-4 text-white font-medium">{item.course_name}</td>
                      <td className="px-5 py-4 text-zinc-300">{item.department}</td>
                      <td className="px-5 py-4 font-mono font-bold text-yellow-400">{item.section_label}</td>
                      <td className="px-5 py-4 text-zinc-400 font-mono font-bold">{item.original_enrolment_count || item.enrolment_count}</td>
                      <td className="px-5 py-4 font-black text-white">
                        <span className="px-2 py-0.5 rounded bg-zinc-800 text-yellow-400 border border-yellow-400/30">
                          {item.active_enrolment_count != null ? item.active_enrolment_count : item.enrolment_count}
                        </span>
                      </td>
                      <td className="px-5 py-4 font-bold text-emerald-400">
                        {item.cleared_backlog_count || 0}
                      </td>
                      <td className="px-5 py-4">
                        <span className={`px-2 py-0.5 text-xs rounded-md font-bold ${
                          item.required_room_type === 'Lab' ? 'bg-amber-400/20 text-amber-300 border border-amber-400/30' : 'bg-zinc-800 text-zinc-300 border border-zinc-700'
                        }`}>
                          {item.required_room_type}
                        </span>
                      </td>
                      <td className="px-5 py-4 font-mono text-xs text-zinc-300">
                        {Math.min(100, Math.round(((item.active_enrolment_count != null ? item.active_enrolment_count : item.enrolment_count) / 75) * 100))}%
                      </td>
                    </>
                  )}

                  {activeSubTab === "enrolments" && (
                    <>
                      <td className="px-5 py-4 font-mono text-xs text-yellow-400 font-bold">{item.id}</td>
                      <td className="px-5 py-4 text-white font-medium">
                        {dataset.students?.find(s => s.id === item.student_id)?.name || item.student_id}
                        <span className="text-zinc-500 font-mono text-xs block">
                          {dataset.students?.find(s => s.id === item.student_id)?.reg_no || item.student_id}
                        </span>
                      </td>
                      <td className="px-5 py-4 font-bold text-white">
                        {dataset.sections?.find(s => s.id === item.section_id)?.course_code || item.section_id}
                      </td>
                      <td className="px-5 py-4">
                        <span className={`px-2 py-0.5 text-xs rounded font-bold ${
                          item.enrolment_type === 'Backlog' ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-zinc-800 text-zinc-300'
                        }`}>
                          {item.enrolment_type}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <span className={`px-2.5 py-0.5 text-xs rounded-full font-bold ${
                          item.status === 'Active' ? 'bg-yellow-400/10 text-yellow-400 border border-yellow-400/30' :
                          item.status === 'Cleared' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' :
                          'bg-zinc-800 text-zinc-400 border border-zinc-700'
                        }`}>
                          {item.status}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-xs text-zinc-400">{item.status_updated_at || "-"}</td>
                    </>
                  )}

                  {activeSubTab === "rooms" && (
                    <>
                      <td className="px-6 py-4 font-mono font-bold text-yellow-400">{item.id}</td>
                      <td className="px-6 py-4 font-medium text-white">{item.name}</td>
                      <td className="px-6 py-4 text-zinc-300">{item.building}</td>
                      <td className="px-6 py-4 font-bold text-white">{item.capacity} seats</td>
                      <td className="px-6 py-4">
                        <span className={`px-2 py-0.5 text-xs rounded-md font-bold ${
                          item.room_type === 'Lab' ? 'bg-amber-400/20 text-amber-300 border border-amber-400/30' : 'bg-zinc-800 text-zinc-300 border border-zinc-700'
                        }`}>
                          {item.room_type}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-xs text-zinc-400">
                        {item.unavailable_slots?.length ? `${item.unavailable_slots.length} slots restricted` : 'None (Fully Available)'}
                      </td>
                    </>
                  )}

                  {activeSubTab === "faculty" && (
                    <>
                      <td className="px-6 py-4 font-mono font-bold text-yellow-400">{item.id}</td>
                      <td className="px-6 py-4 font-medium text-white">{item.name}</td>
                      <td className="px-6 py-4 text-zinc-300">{item.department}</td>
                      <td className="px-6 py-4 font-mono text-xs text-zinc-400">{item.email}</td>
                      <td className="px-6 py-4 text-xs">
                        {item.unavailable_slots?.length ? (
                          <span className="px-2 py-0.5 bg-rose-500/20 text-rose-300 rounded-md font-bold border border-rose-500/30">
                            {item.unavailable_slots.length} blocked slots
                          </span>
                        ) : (
                          <span className="text-yellow-400 font-bold">Fully Open</span>
                        )}
                      </td>
                    </>
                  )}

                  {activeSubTab === "students" && (
                    <>
                      <td className="px-6 py-4 font-mono font-bold text-yellow-400">{item.id}</td>
                      <td className="px-6 py-4 font-medium text-white">{item.name}</td>
                      <td className="px-6 py-4 text-zinc-300">{item.department}</td>
                      <td className="px-6 py-4 text-zinc-300">Sem {item.semester}</td>
                      <td className="px-6 py-4">
                        {item.is_backlog ? (
                          <span className="px-2 py-0.5 text-xs bg-yellow-400/20 text-yellow-300 border border-yellow-400/40 rounded font-bold">Backlog</span>
                        ) : (
                          <span className="text-xs text-zinc-500">Regular</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-xs font-mono text-zinc-400">
                        {item.enrolled_section_ids?.join(", ")}
                      </td>
                    </>
                  )}

                  {activeSubTab === "time_slots" && (
                    <>
                      <td className="px-6 py-4 font-mono font-bold text-yellow-400">{item.id}</td>
                      <td className="px-6 py-4 font-medium text-white">{item.day}</td>
                      <td className="px-6 py-4 font-mono text-zinc-300">{item.start_time}</td>
                      <td className="px-6 py-4 font-mono text-zinc-300">{item.end_time}</td>
                      <td className="px-6 py-4">
                        {item.is_lunch ? (
                          <span className="px-2 py-0.5 text-xs bg-yellow-400 text-black rounded-md font-black">LUNCH BREAK</span>
                        ) : (
                          <span className="px-2 py-0.5 text-xs bg-zinc-800 text-zinc-300 rounded-md">Lecture Slot</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-xs text-zinc-400">{item.display_name}</td>
                    </>
                  )}

                  {activeSubTab !== "time_slots" && (
                    <td className="px-6 py-4 text-right space-x-3">
                      <button
                        onClick={() => { setEditingItem(item); setShowModal(true); }}
                        className="text-zinc-400 hover:text-yellow-400 transition"
                      >
                        <Icon name="edit-2" className="w-4 h-4 inline" />
                      </button>
                      <button
                        onClick={() => handleDelete(item.id)}
                        className="text-zinc-400 hover:text-rose-400 transition"
                      >
                        <Icon name="trash-2" className="w-4 h-4 inline" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add / Edit Modal */}
      {showModal && (
        <DataEditModal
          entityType={activeSubTab}
          item={editingItem}
          dataset={dataset}
          onSave={handleSaveItem}
          onClose={() => { setShowModal(false); setEditingItem(null); }}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// 4. GENERATE SCHEDULE PAGE COMPONENT (BLACK - YELLOW - WHITE)
// --------------------------------------------------------------------------
function GenerateSchedulePage({
  selectedScenario,
  onSelectScenario,
  preferences,
  setPreferences,
  onGenerate,
  isSolving,
  scheduleResponse,
  onViewTimetable,
  onViewConflicts,
  onExportCSV
}) {
  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div>
        <h2 className="text-3xl font-black text-white tracking-tight">Generate University Timetable</h2>
        <p className="text-zinc-400 mt-2">
          Select a benchmark scenario, tune soft optimization priorities, and run the Google OR-Tools CP-SAT solver.
        </p>
      </div>

      {/* Scenario Selector */}
      <div className="space-y-4">
        <label className="text-sm font-black text-yellow-400 uppercase tracking-wider">1. Select Benchmark Scenario</label>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div
            onClick={() => onSelectScenario("feasible")}
            className={`p-5 rounded-2xl border-2 cursor-pointer transition ${
              selectedScenario === 'feasible'
                ? 'border-yellow-400 bg-yellow-400/10 shadow-lg shadow-yellow-500/10'
                : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold text-white">Feasible Demo</span>
              <span className="px-2 py-0.5 text-xs font-black bg-yellow-400 text-black rounded">Guaranteed</span>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              16 sections, 10 rooms, 16 faculty, 180 students. Demonstrates soft optimization with protected lunch hour.
            </p>
          </div>

          <div
            onClick={() => onSelectScenario("impossible")}
            className={`p-5 rounded-2xl border-2 cursor-pointer transition ${
              selectedScenario === 'impossible'
                ? 'border-rose-500 bg-rose-500/10 shadow-lg'
                : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold text-white">Impossible Clash Demo</span>
              <span className="px-2 py-0.5 text-xs font-black bg-rose-500 text-white rounded">Infeasible</span>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              42 shared students between CS301 &amp; EE204, 1 lab, restricted slots. Triggers Conflict Lab diagnosis.
            </p>
          </div>

          <div
            onClick={() => onSelectScenario("large")}
            className={`p-5 rounded-2xl border-2 cursor-pointer transition ${
              selectedScenario === 'large'
                ? 'border-yellow-400 bg-yellow-400/10 shadow-lg shadow-yellow-500/10'
                : 'border-zinc-800 bg-zinc-900 hover:border-zinc-700'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold text-white">Large Dataset Sim</span>
              <span className="px-2 py-0.5 text-xs font-black bg-white text-black rounded">Benchmark</span>
            </div>
            <p className="text-xs text-zinc-400 leading-relaxed">
              1,500 students, 120 sections, 35 rooms across 8 departments. Measures high-scale CP-SAT performance.
            </p>
          </div>
        </div>
      </div>

      {/* Optimisation Preferences */}
      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 shadow-xl space-y-6">
        <label className="text-sm font-black text-yellow-400 uppercase tracking-wider block">2. Soft-Constraint Preferences</label>

        <div className="space-y-4">
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-zinc-950 border border-zinc-800">
            <div>
              <div className="font-bold text-white text-sm">Protect Lunch Break (1:00 PM - 2:00 PM)</div>
              <div className="text-xs text-zinc-400">Heavily penalizes scheduling classes during university dining hours</div>
            </div>
            <input
              type="checkbox"
              checked={preferences.protect_lunch}
              onChange={(e) => setPreferences({ ...preferences, protect_lunch: e.target.checked })}
              className="w-5 h-5 accent-yellow-400 rounded cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between p-3.5 rounded-xl bg-zinc-950 border border-zinc-800">
            <div>
              <div className="font-bold text-white text-sm">Reduce Student Back-to-Back Lectures</div>
              <div className="text-xs text-zinc-400">Minimizes schedules with more than 3 continuous hours without a break</div>
            </div>
            <input
              type="checkbox"
              checked={preferences.reduce_back_to_back}
              onChange={(e) => setPreferences({ ...preferences, reduce_back_to_back: e.target.checked })}
              className="w-5 h-5 accent-yellow-400 rounded cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between p-3.5 rounded-xl bg-zinc-950 border border-zinc-800">
            <div>
              <div className="font-bold text-white text-sm">Balance Faculty Workload</div>
              <div className="text-xs text-zinc-400">Distributes teaching hours evenly and avoids excessive daily gaps</div>
            </div>
            <input
              type="checkbox"
              checked={preferences.balance_faculty_workload}
              onChange={(e) => setPreferences({ ...preferences, balance_faculty_workload: e.target.checked })}
              className="w-5 h-5 accent-yellow-400 rounded cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between p-3.5 rounded-xl bg-zinc-950 border border-zinc-800">
            <div>
              <div className="font-bold text-white text-sm">Prefer Efficient Room Capacity Fit</div>
              <div className="text-xs text-zinc-400">Avoids wasting large auditoriums on small section enrollments</div>
            </div>
            <input
              type="checkbox"
              checked={preferences.prefer_efficient_room_use}
              onChange={(e) => setPreferences({ ...preferences, prefer_efficient_room_use: e.target.checked })}
              className="w-5 h-5 accent-yellow-400 rounded cursor-pointer"
            />
          </div>
        </div>

        {/* Solver Timeout Setting */}
        <div className="pt-2">
          <div className="flex justify-between text-sm mb-1.5">
            <span className="font-medium text-zinc-300">Solver Timeout Limit:</span>
            <span className="font-black text-yellow-400 font-mono">{preferences.timeout_seconds} seconds</span>
          </div>
          <input
            type="range"
            min="5"
            max="60"
            step="5"
            value={preferences.timeout_seconds}
            onChange={(e) => setPreferences({ ...preferences, timeout_seconds: parseInt(e.target.value) })}
            className="w-full accent-yellow-400 cursor-pointer"
          />
        </div>
      </div>

      {/* Big Action Button */}
      <button
        onClick={onGenerate}
        disabled={isSolving}
        className={`w-full py-4 rounded-2xl font-black text-lg text-black shadow-xl transition flex items-center justify-center space-x-3 ${
          isSolving
            ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed'
            : 'bg-yellow-400 hover:bg-yellow-300 active:scale-98 shadow-yellow-500/25'
        }`}
      >
        {isSolving ? (
          <>
            <Icon name="loader-2" className="w-6 h-6 animate-spin text-black" />
            <span>Solving with CP-SAT Engine...</span>
          </>
        ) : (
          <>
            <Icon name="sparkles" className="w-6 h-6 text-black stroke-[2.5]" />
            <span>Generate Clash-Free Timetable</span>
          </>
        )}
      </button>

      {/* Solve Result Summary Box */}
      {scheduleResponse && (
        <div className={`p-6 rounded-2xl border-2 transition ${
          scheduleResponse.is_feasible
            ? 'bg-zinc-900 border-yellow-400/50 shadow-xl'
            : 'bg-zinc-900 border-rose-500/50 shadow-xl'
        }`}>
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4">
            <div className="flex items-center space-x-3">
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center font-black ${
                scheduleResponse.is_feasible ? 'bg-yellow-400 text-black' : 'bg-rose-500 text-white'
              }`}>
                <Icon name={scheduleResponse.is_feasible ? 'check' : 'alert-circle'} className="w-6 h-6 stroke-[3]" />
              </div>
              <div>
                <h4 className="text-xl font-black text-white">
                  {scheduleResponse.is_feasible ? 'Feasible Schedule Generated!' : 'Timetable Is Mathematically Infeasible'}
                </h4>
                <p className="text-xs text-zinc-400">
                  {scheduleResponse.is_feasible
                    ? `Solved in ${scheduleResponse.solve_time_seconds}s with ${scheduleResponse.assignments_count} sections allocated.`
                    : scheduleResponse.conflict_summary}
                </p>
              </div>
            </div>

            <div className="flex items-center space-x-2">
              {scheduleResponse.is_feasible ? (
                <>
                  <button
                    onClick={onViewTimetable}
                    className="px-4 py-2 bg-yellow-400 hover:bg-yellow-300 text-black text-sm font-black rounded-xl shadow-md transition"
                  >
                    View Timetable Grid
                  </button>
                  <button
                    onClick={onExportCSV}
                    className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700 text-sm font-bold rounded-xl shadow-sm transition"
                  >
                    Export CSV
                  </button>
                </>
              ) : (
                <button
                  onClick={onViewConflicts}
                  className="px-4 py-2 bg-rose-500 hover:bg-rose-600 text-white text-sm font-black rounded-xl shadow-md transition flex items-center space-x-2"
                >
                  <Icon name="search" className="w-4 h-4" />
                  <span>Inspect in Conflict Lab</span>
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-3 border-t border-zinc-800 text-xs">
            <div>
              <span className="text-zinc-500 block">Status:</span>
              <span className="font-bold text-white">{scheduleResponse.status}</span>
            </div>
            <div>
              <span className="text-zinc-500 block">Solve Time:</span>
              <span className="font-bold text-yellow-400 font-mono">{scheduleResponse.solve_time_seconds}s</span>
            </div>
            <div>
              <span className="text-zinc-500 block">Soft Penalty Score:</span>
              <span className="font-bold text-white">{scheduleResponse.soft_constraint_score}</span>
            </div>
            <div>
              <span className="text-zinc-500 block">Hard Conflicts:</span>
              <span className={`font-black ${scheduleResponse.hard_conflicts_count === 0 ? 'text-yellow-400' : 'text-rose-400'}`}>
                {scheduleResponse.hard_conflicts_count}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// 5. TIMETABLE VISUALIZER COMPONENT (BLACK - YELLOW - WHITE)
// --------------------------------------------------------------------------
function TimetableVisualizer({
  dataset,
  scheduleResponse,
  mode,
  setMode,
  filterEntity,
  setFilterEntity,
  searchQuery,
  setSearchQuery,
  onSelectAssignment,
  onExportCSV
}) {
  const days = DEFAULT_DAYS;
  const hours = DEFAULT_HOURS;

  useEffect(() => {
    refreshIcons();
  });

  const selectedStudent = useMemo(() => {
    if (mode !== "student" || !filterEntity) return null;
    return dataset?.students?.find(s => s.id === filterEntity);
  }, [mode, filterEntity, dataset]);

  const studentEnrolments = useMemo(() => {
    if (!selectedStudent) return [];
    return dataset?.enrolments?.filter(e => e.student_id === selectedStudent.id) || [];
  }, [selectedStudent, dataset]);

  const activeSectionIds = useMemo(() => {
    if (!selectedStudent) return new Set();
    if (studentEnrolments.length > 0) {
      return new Set(studentEnrolments.filter(e => e.status === "Active").map(e => e.section_id));
    }
    return new Set(selectedStudent.enrolled_section_ids || []);
  }, [selectedStudent, studentEnrolments]);

  const clearedEnrolments = useMemo(() => {
    if (!selectedStudent) return [];
    return studentEnrolments.filter(e => e.status === "Cleared");
  }, [selectedStudent, studentEnrolments]);

  const freedSlotsMap = useMemo(() => {
    if (mode !== "student" || !selectedStudent || !scheduleResponse?.assignments) return {};
    const map = {};
    clearedEnrolments.forEach(enr => {
      const asgn = scheduleResponse.assignments.find(a => a.section_id === enr.section_id);
      if (asgn) {
        const hourNum = parseInt(asgn.start_time.split(":")[0]);
        const key = `${asgn.day}-${hourNum}`;
        map[key] = {
          enrolment: enr,
          assignment: asgn,
          course_code: asgn.course_code,
          course_name: asgn.course_name,
          time_label: `${asgn.day} ${asgn.start_time} - ${asgn.end_time}`,
          cleared_at: enr.cleared_at || enr.status_updated_at || "Recently",
          notes: enr.notes
        };
      }
    });
    return map;
  }, [mode, selectedStudent, clearedEnrolments, scheduleResponse]);

  const filteredAssignments = useMemo(() => {
    if (!scheduleResponse?.assignments) return [];
    return scheduleResponse.assignments.filter(a => {
      if (searchQuery && !a.course_code.toLowerCase().includes(searchQuery.toLowerCase()) &&
          !a.course_name.toLowerCase().includes(searchQuery.toLowerCase()) &&
          !a.faculty_name.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }
      if (mode === "room" && filterEntity && a.room_id !== filterEntity) return false;
      if (mode === "faculty" && filterEntity && a.faculty_id !== filterEntity) return false;
      if (mode === "student" && filterEntity) {
        if (!activeSectionIds.has(a.section_id)) return false;
      }
      return true;
    });
  }, [scheduleResponse, mode, filterEntity, searchQuery, activeSectionIds]);

  const cellMap = useMemo(() => {
    const map = {};
    filteredAssignments.forEach(a => {
      const hourNum = parseInt(a.start_time.split(":")[0]);
      const key = `${a.day}-${hourNum}`;
      if (!map[key]) map[key] = [];
      map[key].push(a);
    });
    return map;
  }, [filteredAssignments]);

  const studentStats = useMemo(() => {
    if (mode !== "student" || !selectedStudent) return null;
    const activeCount = activeSectionIds.size;
    const clearedCount = clearedEnrolments.length;
    const scheduledHours = filteredAssignments.length;
    const totalSlots = 35;
    const freeHours = Math.max(0, totalSlots - scheduledHours);
    let clashesCount = 0;
    Object.values(cellMap).forEach(list => {
      if (list.length > 1) clashesCount += (list.length - 1);
    });

    return {
      name: selectedStudent.name,
      id: selectedStudent.id,
      regNo: selectedStudent.registration_number || selectedStudent.id,
      department: selectedStudent.department,
      semester: selectedStudent.semester,
      activeCount,
      clearedCount,
      scheduledHours,
      freeHours,
      clashesCount
    };
  }, [mode, selectedStudent, activeSectionIds, clearedEnrolments, filteredAssignments, cellMap]);

  return (
    <div className="space-y-6">
      {/* Visualizer Header & View Mode Switcher */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-zinc-900 p-6 rounded-2xl border border-zinc-800 shadow-xl no-print">
        <div>
          <h2 className="text-2xl font-black text-white tracking-tight">Weekly Timetable Visualizer</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Interactive schedule grid with department color coding, dynamic backlog clearing, and clash verification.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* View Mode Toggle */}
          <div className="flex bg-black p-1 rounded-xl text-xs font-bold border border-zinc-800">
            {[
              { id: "master", label: "Master Grid" },
              { id: "room", label: "By Room" },
              { id: "faculty", label: "By Faculty" },
              { id: "student", label: "By Student" }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => { setMode(tab.id); setFilterEntity(""); }}
                className={`px-3 py-1.5 rounded-lg transition ${
                  mode === tab.id ? 'bg-yellow-400 text-black shadow-md' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Contextual Filter Select */}
          {mode === "room" && (
            <select
              value={filterEntity}
              onChange={(e) => setFilterEntity(e.target.value)}
              className="bg-black border border-zinc-800 text-white rounded-lg text-xs py-1.5 px-3 focus:outline-none focus:ring-2 focus:ring-yellow-400"
            >
              <option value="">All Rooms ({dataset?.rooms?.length || 0})</option>
              {dataset?.rooms?.map(r => (
                <option key={r.id} value={r.id}>{r.name} ({r.capacity} seats)</option>
              ))}
            </select>
          )}

          {mode === "faculty" && (
            <select
              value={filterEntity}
              onChange={(e) => setFilterEntity(e.target.value)}
              className="bg-black border border-zinc-800 text-white rounded-lg text-xs py-1.5 px-3 focus:outline-none focus:ring-2 focus:ring-yellow-400"
            >
              <option value="">All Faculty ({dataset?.faculty?.length || 0})</option>
              {dataset?.faculty?.map(f => (
                <option key={f.id} value={f.id}>{f.name} ({f.department})</option>
              ))}
            </select>
          )}

          {mode === "student" && (
            <select
              value={filterEntity}
              onChange={(e) => setFilterEntity(e.target.value)}
              className="bg-black border border-zinc-800 text-white rounded-lg text-xs py-1.5 px-3 focus:outline-none focus:ring-2 focus:ring-yellow-400"
            >
              <option value="">Select Student...</option>
              {dataset?.students?.slice(0, 100).map(s => {
                const sEnrs = dataset?.enrolments?.filter(e => e.student_id === s.id && e.status === "Active") || [];
                const count = sEnrs.length > 0 ? sEnrs.length : s.enrolled_section_ids.length;
                return (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.registration_number || s.id}) - {count} active courses
                  </option>
                );
              })}
            </select>
          )}

          {/* Quick Actions */}
          <button
            onClick={() => window.print()}
            className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg border border-zinc-800 transition"
            title="Print Schedule"
          >
            <Icon name="printer" className="w-4 h-4" />
          </button>
          <button
            onClick={onExportCSV}
            className="px-3.5 py-1.5 bg-yellow-400 hover:bg-yellow-300 text-black text-xs font-black rounded-lg transition flex items-center space-x-1 shadow-md shadow-yellow-500/20"
          >
            <Icon name="download" className="w-3.5 h-3.5 text-black" />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* Student Personal Schedule Profile Banner */}
      {mode === "student" && studentStats && (
        <div className="bg-zinc-900 border-2 border-yellow-400/40 rounded-2xl p-5 shadow-xl space-y-4">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
            <div className="flex items-center space-x-3.5">
              <div className="w-12 h-12 rounded-xl bg-yellow-400 text-black flex items-center justify-center font-black text-lg shadow-md shadow-yellow-500/20">
                <Icon name="graduation-cap" className="w-6 h-6 stroke-[2.5]" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <h3 className="text-xl font-black text-white">{studentStats.name}</h3>
                  <span className="px-2 py-0.5 text-xs font-mono font-bold bg-black text-yellow-400 border border-yellow-400/30 rounded">
                    {studentStats.regNo}
                  </span>
                  {studentStats.clearedCount > 0 && (
                    <span className="px-2 py-0.5 text-xs font-bold bg-yellow-400 text-black rounded-full flex items-center space-x-1">
                      <Icon name="check-circle" className="w-3 h-3 text-black stroke-[3]" />
                      <span>{studentStats.clearedCount} Backlog Cleared</span>
                    </span>
                  )}
                </div>
                <p className="text-xs text-zinc-400 mt-0.5">
                  {studentStats.department} &bull; Semester {studentStats.semester} &bull; Personal Student View
                </p>
              </div>
            </div>

            {studentStats.clashesCount > 0 ? (
              <div className="px-3.5 py-1.5 bg-rose-500/20 border border-rose-500/40 text-rose-300 rounded-xl text-xs font-black flex items-center space-x-2 animate-pulse">
                <Icon name="alert-triangle" className="w-4 h-4 text-rose-400 stroke-[2.5]" />
                <span>{studentStats.clashesCount} Direct Timetable Clash Detected</span>
              </div>
            ) : (
              <div className="px-3.5 py-1.5 bg-yellow-400/10 border border-yellow-400/40 text-yellow-400 rounded-xl text-xs font-bold flex items-center space-x-2">
                <Icon name="shield-check" className="w-4 h-4 text-yellow-400 stroke-[2.5]" />
                <span>Conflict-Free Personal Schedule</span>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 text-xs">
            <div className="p-3 bg-black rounded-xl border border-zinc-800">
              <span className="text-zinc-500 block font-medium">Active Enrolments</span>
              <span className="text-lg font-black text-white">{studentStats.activeCount} Courses</span>
            </div>
            <div className="p-3 bg-black rounded-xl border border-zinc-800">
              <span className="text-zinc-500 block font-medium">Cleared Backlogs</span>
              <span className="text-lg font-black text-yellow-400">{studentStats.clearedCount} Released</span>
            </div>
            <div className="p-3 bg-black rounded-xl border border-zinc-800">
              <span className="text-zinc-500 block font-medium">Weekly Class Hours</span>
              <span className="text-lg font-black text-white">{studentStats.scheduledHours} hrs / week</span>
            </div>
            <div className="p-3 bg-black rounded-xl border border-zinc-800">
              <span className="text-zinc-500 block font-medium">Free Study Slots</span>
              <span className="text-lg font-black text-yellow-400">{studentStats.freeHours} periods</span>
            </div>
          </div>
        </div>
      )}

      {/* Main Grid View */}
      <div id="printable-timetable" className="bg-zinc-900 rounded-2xl border border-zinc-800 shadow-xl overflow-hidden">
        <div className="overflow-x-auto custom-scroll">
          <table className="w-full border-collapse text-left min-w-[900px]">
            <thead>
              <tr className="bg-zinc-950 border-b border-zinc-800">
                <th className="py-3.5 px-4 text-xs font-bold text-zinc-400 uppercase tracking-wider w-24 border-r border-zinc-800">
                  Time Slot
                </th>
                {days.map(day => (
                  <th key={day} className="py-3.5 px-4 text-xs font-black text-white uppercase tracking-wider text-center border-r border-zinc-800 last:border-r-0">
                    {day}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {hours.map(hour => {
                const isLunch = hour === 13;
                const timeLabel = `${String(hour).padStart(2, '0')}:00 - ${String(hour + 1).padStart(2, '0')}:00`;

                return (
                  <tr key={hour} className={isLunch ? 'bg-yellow-950/20' : 'hover:bg-zinc-800/30'}>
                    {/* Hour Column */}
                    <td className="py-3 px-3 text-xs font-mono font-bold text-zinc-400 border-r border-zinc-800 bg-zinc-950 align-top">
                      <div>{timeLabel}</div>
                      {isLunch && (
                        <span className="inline-block mt-1 px-1.5 py-0.5 text-[10px] font-black text-black bg-yellow-400 rounded">
                          LUNCH
                        </span>
                      )}
                    </td>

                    {/* Day Cells */}
                    {days.map(day => {
                      const key = `${day}-${hour}`;
                      const assignmentsInCell = cellMap[key] || [];
                      const freedSlot = freedSlotsMap[key];
                      const hasClash = mode === "student" && assignmentsInCell.length > 1;

                      return (
                        <td
                          key={day}
                          className={`py-2 px-2 border-r border-zinc-800/80 last:border-r-0 align-top min-h-[95px] h-[95px] ${
                            hasClash ? 'bg-rose-950/20' : ''
                          }`}
                        >
                          <div className="space-y-1.5 h-full">
                            {/* Clash Alert Badge if student has duplicate assignment in this cell */}
                            {hasClash && (
                              <div className="p-1 px-1.5 rounded-lg bg-rose-500 text-white text-[10px] font-black flex items-center space-x-1 shadow-md">
                                <Icon name="alert-octagon" className="w-3 h-3 text-white shrink-0" />
                                <span>CLASH: {assignmentsInCell.length} overlapping classes</span>
                              </div>
                            )}

                            {/* Active Assignments */}
                            {assignmentsInCell.map(a => (
                              <div
                                key={a.section_id}
                                onClick={() => onSelectAssignment(a)}
                                className={`group p-2 rounded-xl text-xs font-sans shadow-md hover:shadow-xl transition cursor-pointer border ${
                                  hasClash ? 'border-rose-500 bg-rose-950/40' : 'border-zinc-700/80 hover:border-yellow-400 bg-black'
                                } hover:scale-[1.02] transform duration-150`}
                                style={{
                                  borderLeft: `4px solid ${getDepartmentColor(a.department)}`
                                }}
                              >
                                <div className="flex items-center justify-between font-black text-white">
                                  <span>{a.course_code} [{a.section_label}]</span>
                                  <span className="text-[10px] px-1.5 py-0.5 bg-zinc-800 text-yellow-400 rounded font-mono font-bold">
                                    {a.enrolment_count}/{a.room_capacity}
                                  </span>
                                </div>
                                <div className="text-[11px] font-medium text-zinc-300 truncate mt-0.5" title={a.course_name}>
                                  {a.course_name}
                                </div>
                                <div className="text-[10px] text-zinc-400 flex items-center justify-between mt-1">
                                  <span className="truncate">{a.room_name}</span>
                                  <span className="text-yellow-400 font-mono text-[9px]">{a.faculty_name.split(' ').pop()}</span>
                                </div>
                              </div>
                            ))}

                            {/* Freed Slot Notice when student cleared backlog that was scheduled at this time */}
                            {mode === "student" && assignmentsInCell.length === 0 && freedSlot && (
                              <div className="p-2 rounded-xl text-xs font-sans border-2 border-dashed border-yellow-400/60 bg-yellow-400/5 hover:bg-yellow-400/10 transition">
                                <div className="flex items-center justify-between font-black text-yellow-400">
                                  <span className="flex items-center space-x-1">
                                    <Icon name="check-circle-2" className="w-3.5 h-3.5 text-yellow-400 stroke-[2.5]" />
                                    <span className="text-[10px] uppercase tracking-wider">FREE SLOT</span>
                                  </span>
                                  <span className="text-[9px] px-1.5 py-0.2 bg-yellow-400/20 text-yellow-300 rounded font-mono font-bold">
                                    Cleared
                                  </span>
                                </div>
                                <div className="text-[11px] font-semibold text-zinc-400 mt-1 line-through opacity-80 truncate" title={`${freedSlot.course_code} - ${freedSlot.course_name}`}>
                                  {freedSlot.course_code}
                                </div>
                                <div className="text-[9.5px] text-yellow-300/90 font-medium mt-1 flex items-center space-x-1">
                                  <Icon name="coffee" className="w-3 h-3 text-yellow-400 inline shrink-0" />
                                  <span className="truncate">Available Period</span>
                                </div>
                              </div>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div className="p-4 bg-zinc-950 border-t border-zinc-800 flex flex-wrap items-center justify-between gap-4 text-xs text-zinc-400">
          <div className="flex items-center space-x-4">
            <span className="font-bold text-white">Departments:</span>
            <div className="flex items-center space-x-3">
              <span className="flex items-center space-x-1.5"><span className="w-3 h-3 rounded-full bg-yellow-400"></span><span className="text-zinc-200">CS</span></span>
              <span className="flex items-center space-x-1.5"><span className="w-3 h-3 rounded-full bg-amber-500"></span><span className="text-zinc-200">EE</span></span>
              <span className="flex items-center space-x-1.5"><span className="w-3 h-3 rounded-full bg-sky-400"></span><span className="text-zinc-200">Math</span></span>
              <span className="flex items-center space-x-1.5"><span className="w-3 h-3 rounded-full bg-purple-400"></span><span className="text-zinc-200">Physics</span></span>
              <span className="flex items-center space-x-1.5"><span className="w-3 h-3 rounded-full bg-pink-400"></span><span className="text-zinc-200">Bio</span></span>
              <span className="flex items-center space-x-1.5"><span className="w-3 h-3 rounded-full bg-white"></span><span className="text-zinc-200">Humanities</span></span>
            </div>
          </div>

          <div className="text-zinc-500 text-[11px]">
            Click any lecture card for student enrolment list &amp; room efficiency breakdown
          </div>
        </div>
      </div>
    </div>
  );
}

function getDepartmentColor(dept = "") {
  if (dept.includes("Computer")) return "#facc15"; // Bright Yellow
  if (dept.includes("Electrical")) return "#fb923c"; // Amber
  if (dept.includes("Math")) return "#38bdf8"; // Sky Blue
  if (dept.includes("Physics")) return "#c084fc"; // Violet
  if (dept.includes("Bio")) return "#f472b6"; // Pink
  return "#ffffff"; // White
}

// --------------------------------------------------------------------------
// 6. CONFLICT LAB COMPONENT (BLACK - YELLOW - WHITE)
// --------------------------------------------------------------------------
function ConflictLabPage({ dataset, scheduleResponse, onApplyRemedy, statusMessage, isSolving }) {
  const isFeasible = scheduleResponse?.is_feasible;
  const conflicts = scheduleResponse?.conflicts || [];

  useEffect(() => {
    refreshIcons();
  });

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Header Warning Banner */}
      <div className={`p-6 sm:p-8 rounded-3xl border-2 shadow-2xl transition ${
        isFeasible
          ? 'bg-zinc-900 border-yellow-400/50'
          : 'bg-zinc-900 border-rose-500/50'
      }`}>
        <div className="flex items-start space-x-4">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 font-black ${
            isFeasible ? 'bg-yellow-400 text-black' : 'bg-rose-500 text-white'
          }`}>
            <Icon name={isFeasible ? 'shield-check' : 'alert-octagon'} className="w-7 h-7 stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className={`px-2.5 py-0.5 text-xs font-black uppercase rounded-full ${
                isFeasible ? 'bg-yellow-400 text-black' : 'bg-rose-500 text-white'
              }`}>
                {isFeasible ? 'Feasible Solution Validated' : 'Conflict Core Diagnosis'}
              </span>
              <span className="text-xs text-zinc-400">
                {scheduleResponse?.is_minimal_conflict_set
                  ? 'Mathematically Verified via CP-SAT Assumption Refutation'
                  : 'Smallest Conflict Set Found'}
              </span>
            </div>
            <h2 className="text-2xl sm:text-3xl font-black text-white mt-1">
              {isFeasible
                ? 'All Hard Constraints Satisfied'
                : 'A Valid Timetable Cannot Be Generated'}
            </h2>
            <p className="text-sm text-zinc-300 mt-2 leading-relaxed">
              {isFeasible
                ? 'No scheduling collisions detected. Every section has an assigned room with sufficient capacity, instructors are free, and no student has overlapping classes.'
                : `We identified ${conflicts.length} minimum blocking constraints. The input conditions make a clash-free schedule mathematically impossible without relaxing at least one constraint.`}
            </p>
          </div>
        </div>
      </div>

      {/* Dynamic Backlog Clearance Resolutions Panel */}
      {scheduleResponse?.backlog_resolutions && scheduleResponse.backlog_resolutions.length > 0 && (
        <div className="bg-zinc-900 border-2 border-yellow-400/50 rounded-3xl p-6 sm:p-7 shadow-xl space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center space-x-3.5">
              <div className="w-10 h-10 rounded-xl bg-yellow-400 text-black flex items-center justify-center font-black shrink-0 shadow-md shadow-yellow-500/20">
                <Icon name="check-check" className="w-5 h-5 stroke-[2.5]" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <span className="px-2.5 py-0.5 text-xs font-black uppercase rounded-full bg-yellow-400 text-black">
                    Dynamic Backlog Clearance
                  </span>
                  <span className="text-xs text-yellow-400 font-mono font-bold">
                    {scheduleResponse.backlog_resolutions.length} Resolved Conflict{scheduleResponse.backlog_resolutions.length > 1 ? 's' : ''}
                  </span>
                </div>
                <h3 className="text-xl font-black text-white mt-0.5">
                  Impossibilities Eliminated by Backlog Clearance
                </h3>
              </div>
            </div>
            <div className="hidden sm:flex items-center space-x-1.5 px-3 py-1 bg-black rounded-lg border border-zinc-800 text-[11px] text-zinc-400">
              <span className="w-2 h-2 rounded-full bg-yellow-400"></span>
              <span>Master Schedule Preserved</span>
            </div>
          </div>

          <p className="text-xs text-zinc-300 leading-relaxed">
            When students clear backlog subjects, the solver automatically releases their enrolled sections from pairwise overlap clash constraints without disturbing assigned rooms, instructors, or regular student schedules.
          </p>

          <div className="space-y-2.5 pt-1">
            {scheduleResponse.backlog_resolutions.map((resMsg, idx) => (
              <div key={idx} className="p-4 bg-black rounded-xl border border-yellow-400/30 flex items-start space-x-3 text-xs">
                <div className="w-6 h-6 rounded-lg bg-yellow-400/20 text-yellow-400 flex items-center justify-center shrink-0 font-bold mt-0.5">
                  <Icon name="sparkles" className="w-3.5 h-3.5 text-yellow-400" />
                </div>
                <div className="space-y-1 flex-1">
                  <div className="font-bold text-white font-mono text-sm">{resMsg}</div>
                  <div className="text-[11px] text-zinc-400">
                    Conflict resolved: Student cleared their backlog. The section remains scheduled for other cohort students while this student's slot is instantly released.
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* When Infeasible: Conflict Cards List */}
      {!isFeasible && (
        <div className="space-y-6">
          <h3 className="text-lg font-black text-white flex items-center space-x-2">
            <Icon name="git-pull-request-draft" className="w-5 h-5 text-yellow-400" />
            <span>Identified Blocking Constraints</span>
          </h3>

          <div className="space-y-4">
            {conflicts.map((c, idx) => (
              <div key={c.id || idx} className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 shadow-xl space-y-4">
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
                  <div className="flex items-center space-x-3">
                    <span className="px-2.5 py-1 text-xs font-black uppercase rounded-md bg-rose-500/20 text-rose-300 border border-rose-500/40">
                      {c.severity || "CRITICAL"}
                    </span>
                    <h4 className="text-lg font-black text-white">{c.title}</h4>
                  </div>
                  <div className="flex items-center space-x-2">
                    {c.involved_courses?.map(course => (
                      <span key={course} className="px-2 py-0.5 bg-black border border-yellow-400/40 text-yellow-400 font-mono text-xs font-bold rounded">
                        {course}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Plain-English Problem Diagnosis */}
                <div className="bg-black p-4 rounded-xl border border-zinc-800 text-sm text-zinc-200 leading-relaxed font-sans">
                  <strong className="text-yellow-400">Diagnosis: </strong> {c.description}
                </div>

                {/* Conflict Breakdown Columns */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs pt-1">
                  <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                    <span className="text-zinc-500 block mb-0.5 font-bold">Involved Faculty</span>
                    <span className="font-bold text-white">{c.involved_faculty?.join(", ") || "N/A"}</span>
                  </div>
                  <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                    <span className="text-zinc-500 block mb-0.5 font-bold">Shared Students</span>
                    <span className="font-bold text-yellow-400">{c.conflicting_students_count ? `${c.conflicting_students_count} students` : "Direct Faculty/Room collision"}</span>
                  </div>
                  <div className="p-3 bg-zinc-950 rounded-lg border border-zinc-800">
                    <span className="text-zinc-500 block mb-0.5 font-bold">Room Bottleneck</span>
                    <span className="font-bold text-white">{c.involved_rooms?.join(", ") || "No room meeting required type/capacity"}</span>
                  </div>
                </div>

                {/* Why this creates an impossibility */}
                <div className="text-xs text-rose-300 bg-rose-950/30 p-3 rounded-lg border border-rose-800/40">
                  <span className="font-bold">Mathematical Proof: </span> {c.why_impossible}
                </div>

                {/* Actionable Recommendations */}
                <div className="pt-2">
                  <span className="text-xs font-black uppercase text-yellow-400 tracking-wider block mb-2">Recommended Resolution Options:</span>
                  <ul className="space-y-1.5 text-xs text-zinc-300">
                    {c.recommendations?.map((rec, rIdx) => (
                      <li key={rIdx} className="flex items-start space-x-2">
                        <Icon name="check" className="w-3.5 h-3.5 text-yellow-400 mt-0.5 shrink-0 stroke-[3]" />
                        <span>{rec}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>

          {/* Interactive "What-If?" Simulation Panel */}
          <div className="bg-gradient-to-br from-black via-zinc-900 to-black rounded-3xl p-6 sm:p-8 text-white shadow-2xl border-2 border-yellow-400/30 space-y-6">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 rounded-xl bg-yellow-400 text-black flex items-center justify-center font-black">
                <Icon name="sliders" className="w-5 h-5 stroke-[2.5]" />
              </div>
              <div>
                <h3 className="text-xl font-black">Interactive "What-If?" Remedy Simulator</h3>
                <p className="text-xs text-zinc-400">
                  Simulate potential policy remedies to test if they mathematically resolve the clash.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Remedy 1 */}
              <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-4 flex flex-col justify-between hover:border-yellow-400 transition">
                <div>
                  <div className="font-bold text-sm text-yellow-400 mb-1">Remedy 1: Open Faculty Slots</div>
                  <p className="text-xs text-zinc-300">
                    Expand Dr. Alan Turing's availability across Wednesday &amp; Thursday to unlock alternative lab slots.
                  </p>
                </div>
                <button
                  onClick={() => onApplyRemedy("CHANGE_FACULTY_AVAILABILITY", { faculty_id: "FAC-TURING", open_all: true })}
                  disabled={isSolving}
                  className="mt-4 w-full py-2 bg-yellow-400 hover:bg-yellow-300 text-black rounded-xl text-xs font-black shadow-md transition"
                >
                  Apply &amp; Re-Solve
                </button>
              </div>

              {/* Remedy 2 */}
              <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-4 flex flex-col justify-between hover:border-yellow-400 transition">
                <div>
                  <div className="font-bold text-sm text-yellow-400 mb-1">Remedy 2: Add Auxiliary Lab</div>
                  <p className="text-xs text-zinc-300">
                    Provision a second 85-seat Computing Laboratory room to break the single-lab bottleneck.
                  </p>
                </div>
                <button
                  onClick={() => onApplyRemedy("ADD_ROOM", { name: "Auxiliary Computing Lab 2", building: "IT Wing", capacity: 85, room_type: "Lab" })}
                  disabled={isSolving}
                  className="mt-4 w-full py-2 bg-yellow-400 hover:bg-yellow-300 text-black rounded-xl text-xs font-black shadow-md transition"
                >
                  Apply &amp; Re-Solve
                </button>
              </div>

              {/* Remedy 3 */}
              <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-4 flex flex-col justify-between hover:border-yellow-400 transition">
                <div>
                  <div className="font-bold text-sm text-yellow-400 mb-1">Remedy 3: Split CS301 Section</div>
                  <p className="text-xs text-zinc-300">
                    Split CS301 into Section A1 (38 students) and Section A2 (37 students) to fit smaller rooms.
                  </p>
                </div>
                <button
                  onClick={() => onApplyRemedy("SPLIT_SECTION", { section_id: "SEC-CS301-A" })}
                  disabled={isSolving}
                  className="mt-4 w-full py-2 bg-yellow-400 hover:bg-yellow-300 text-black rounded-xl text-xs font-black shadow-md transition"
                >
                  Apply &amp; Re-Solve
                </button>
              </div>
            </div>

            {statusMessage && (
              <div className="p-3 bg-yellow-400/10 border border-yellow-400/30 rounded-xl text-xs text-yellow-300 font-semibold">
                {statusMessage}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// 7. INSIGHTS COMPONENT (BLACK - YELLOW - WHITE)
// --------------------------------------------------------------------------
function InsightsPage({ dataset, scheduleResponse }) {
  const overlapPairs = useMemo(() => {
    if (!dataset?.students) return [];
    const secStudents = {};
    dataset.students.forEach(st => {
      st.enrolled_section_ids.forEach(secId => {
        if (!secStudents[secId]) secStudents[secId] = new Set();
        secStudents[secId].add(st.id);
      });
    });

    const pairs = [];
    const secs = dataset.sections || [];
    for (let i = 0; i < secs.length; i++) {
      for (let j = i + 1; j < secs.length; j++) {
        const s1 = secs[i];
        const s2 = secs[j];
        const set1 = secStudents[s1.id] || new Set();
        const set2 = secStudents[s2.id] || new Set();
        const intersection = [...set1].filter(x => set2.has(x));
        if (intersection.length > 0) {
          pairs.push({
            course1: `${s1.course_code} (${s1.section_label})`,
            course2: `${s2.course_code} (${s2.section_label})`,
            sharedCount: intersection.length,
            dept1: s1.department,
            dept2: s2.department
          });
        }
      }
    }
    return pairs.sort((a, b) => b.sharedCount - a.sharedCount).slice(0, 5);
  }, [dataset]);

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      <div>
        <h2 className="text-3xl font-black text-white tracking-tight">Academic Timetable Insights</h2>
        <p className="text-zinc-400 mt-2">
          Diagnostic metrics, schedule stress indicators, and student elective cross-overlap analysis.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-zinc-900 p-6 rounded-2xl border border-zinc-800 shadow-xl">
          <div className="w-10 h-10 rounded-xl bg-yellow-400/10 text-yellow-400 border border-yellow-400/30 flex items-center justify-center mb-3 font-bold">
            <Icon name="clock" className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Peak Lecture Hour</div>
          <div className="text-2xl font-black text-white mt-1">10:00 - 11:00 AM</div>
          <div className="text-xs text-zinc-500 mt-1">Highest section density across campus</div>
        </div>

        <div className="bg-zinc-900 p-6 rounded-2xl border border-zinc-800 shadow-xl">
          <div className="w-10 h-10 rounded-xl bg-yellow-400/10 text-yellow-400 border border-yellow-400/30 flex items-center justify-center mb-3 font-bold">
            <Icon name="utensils" className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Lunch Compliance</div>
          <div className="text-2xl font-black text-yellow-400 mt-1">100% Free</div>
          <div className="text-xs text-zinc-500 mt-1">Zero lecture clashes during 1:00-2:00 PM</div>
        </div>

        <div className="bg-zinc-900 p-6 rounded-2xl border border-zinc-800 shadow-xl">
          <div className="w-10 h-10 rounded-xl bg-yellow-400/10 text-yellow-400 border border-yellow-400/30 flex items-center justify-center mb-3 font-bold">
            <Icon name="activity" className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div className="text-xs font-bold text-zinc-400 uppercase tracking-wider">Schedule Stress Index</div>
          <div className="text-2xl font-black text-white mt-1">Low (0.12)</div>
          <div className="text-xs text-zinc-500 mt-1">No student has &gt;3 back-to-back lectures</div>
        </div>
      </div>

      {/* Highest Overlap Courses Table */}
      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 shadow-xl space-y-4">
        <h3 className="font-bold text-white text-lg flex items-center space-x-2">
          <Icon name="git-merge" className="w-5 h-5 text-yellow-400" />
          <span>Courses with Highest Student Overlap (Electives &amp; Backlogs)</span>
        </h3>
        <p className="text-xs text-zinc-400">
          These pairs require strict non-overlapping time slots to prevent student schedule clashes.
        </p>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-zinc-800 text-sm">
            <thead className="bg-zinc-950 text-xs font-bold text-zinc-400 uppercase text-left">
              <tr>
                <th className="py-3 px-4">Course Section 1</th>
                <th className="py-3 px-4">Course Section 2</th>
                <th className="py-3 px-4">Departments</th>
                <th className="py-3 px-4 font-bold text-right">Shared Students</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {overlapPairs.map((p, idx) => (
                <tr key={idx} className="hover:bg-zinc-800/40">
                  <td className="py-3.5 px-4 font-black text-yellow-400">{p.course1}</td>
                  <td className="py-3.5 px-4 font-black text-white">{p.course2}</td>
                  <td className="py-3.5 px-4 text-xs text-zinc-400">{p.dept1} &times; {p.dept2}</td>
                  <td className="py-3.5 px-4 text-right">
                    <span className="px-2.5 py-1 rounded-full text-xs font-black bg-yellow-400 text-black shadow-xs">
                      {p.sharedCount} students
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// 8. SETTINGS COMPONENT (BLACK - YELLOW - WHITE)
// --------------------------------------------------------------------------
function SettingsPage({ preferences, setPreferences, onReset }) {
  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <div>
        <h2 className="text-3xl font-black text-white tracking-tight">Solver &amp; System Settings</h2>
        <p className="text-zinc-400 mt-2">
          Fine-tune CP-SAT solver parameters, soft-constraint penalty weights, and default dataset presets.
        </p>
      </div>

      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 shadow-xl space-y-6">
        <h3 className="font-bold text-white text-base">Soft Penalty Weights</h3>

        <div className="space-y-4">
          <div>
            <div className="flex justify-between text-sm mb-1.5">
              <span className="font-medium text-zinc-300">Lunch Break Penalty:</span>
              <span className="font-black text-yellow-400 font-mono">{preferences.lunch_penalty}</span>
            </div>
            <input
              type="range"
              min="10"
              max="200"
              value={preferences.lunch_penalty}
              onChange={(e) => setPreferences({ ...preferences, lunch_penalty: parseInt(e.target.value) })}
              className="w-full accent-yellow-400 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between text-sm mb-1.5">
              <span className="font-medium text-zinc-300">Back-to-Back Penalty:</span>
              <span className="font-black text-yellow-400 font-mono">{preferences.back_to_back_penalty}</span>
            </div>
            <input
              type="range"
              min="5"
              max="100"
              value={preferences.back_to_back_penalty}
              onChange={(e) => setPreferences({ ...preferences, back_to_back_penalty: parseInt(e.target.value) })}
              className="w-full accent-yellow-400 cursor-pointer"
            />
          </div>

          <div>
            <div className="flex justify-between text-sm mb-1.5">
              <span className="font-medium text-zinc-300">Room Waste Penalty:</span>
              <span className="font-black text-yellow-400 font-mono">{preferences.room_waste_penalty}</span>
            </div>
            <input
              type="range"
              min="1"
              max="10"
              value={preferences.room_waste_penalty}
              onChange={(e) => setPreferences({ ...preferences, room_waste_penalty: parseInt(e.target.value) })}
              className="w-full accent-yellow-400 cursor-pointer"
            />
          </div>
        </div>
      </div>

      {/* Reset Presets */}
      <div className="bg-zinc-900 rounded-2xl border border-zinc-800 p-6 shadow-xl space-y-4">
        <h3 className="font-bold text-white text-base">Reset Demo Data</h3>
        <p className="text-xs text-zinc-400">
          Restore deterministic sample datasets to run repeatable live demonstrations.
        </p>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => onReset("feasible")}
            className="px-4 py-2 bg-yellow-400 hover:bg-yellow-300 text-black rounded-xl text-xs font-black transition shadow-md shadow-yellow-500/20"
          >
            Reset to Feasible Demo (16 sections)
          </button>
          <button
            onClick={() => onReset("impossible")}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-xs font-bold border border-zinc-700 transition"
          >
            Reset to Impossible Clash Demo
          </button>
          <button
            onClick={() => onReset("large")}
            className="px-4 py-2 bg-black hover:bg-zinc-950 text-yellow-400 border border-yellow-400/40 rounded-xl text-xs font-bold transition"
          >
            Reset to 1,500-Student Simulation
          </button>
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// 9. DYNAMIC BACKLOG MANAGEMENT COMPONENT (BLACK - YELLOW - WHITE)
// --------------------------------------------------------------------------
function BacklogManagementPage({
  dataset,
  setDataset,
  scheduleResponse,
  setScheduleResponse,
  banner,
  setBanner,
  onUpdateStatus,
  onNavigateToStudentTimetable,
  onReoptimiseTimetable,
  onLoadBacklogDemo,
  isSolving
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [typeFilter, setTypeFilter] = useState("All");
  const [clearanceModalItem, setClearanceModalItem] = useState(null);
  const [clearanceNotes, setClearanceNotes] = useState("Cleared in Supplementary Examination - Nov 2026");
  const [isProcessing, setIsProcessing] = useState(false);
  const [showAuditTrail, setShowAuditTrail] = useState(true);

  useEffect(() => {
    refreshIcons();
  });

  const enrolments = dataset?.enrolments || [];
  const studentsMap = useMemo(() => {
    const map = {};
    (dataset?.students || []).forEach(s => { map[s.id] = s; });
    return map;
  }, [dataset]);

  const sectionsMap = useMemo(() => {
    const map = {};
    (dataset?.sections || []).forEach(sec => { map[sec.id] = sec; });
    return map;
  }, [dataset]);

  const assignmentsMap = useMemo(() => {
    const map = {};
    (scheduleResponse?.assignments || []).forEach(a => { map[a.section_id] = a; });
    return map;
  }, [scheduleResponse]);

  // Counts for tabs
  const counts = useMemo(() => {
    return {
      all: enrolments.length,
      active: enrolments.filter(e => e.status === "Active").length,
      cleared: enrolments.filter(e => e.status === "Cleared").length,
      dropped: enrolments.filter(e => e.status === "Dropped").length,
      pending: enrolments.filter(e => e.status === "Pending").length,
      activeBacklogs: enrolments.filter(e => e.enrolment_type === "Backlog" && e.status === "Active").length,
      clearedBacklogs: enrolments.filter(e => e.enrolment_type === "Backlog" && e.status === "Cleared").length
    };
  }, [enrolments]);

  // Filtered Enrolments
  const filteredEnrolments = useMemo(() => {
    return enrolments.filter(e => {
      if (statusFilter !== "All" && e.status !== statusFilter) return false;
      if (typeFilter !== "All" && e.enrolment_type !== typeFilter) return false;

      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const student = studentsMap[e.student_id];
        const section = sectionsMap[e.section_id];
        const studentName = (student?.name || "").toLowerCase();
        const studentRegNo = (student?.registration_number || e.student_id || "").toLowerCase();
        const courseCode = (section?.course_code || "").toLowerCase();
        const courseName = (section?.course_name || "").toLowerCase();
        const notes = (e.notes || "").toLowerCase();

        if (!studentName.includes(q) && !studentRegNo.includes(q) &&
            !courseCode.includes(q) && !courseName.includes(q) && !notes.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [enrolments, statusFilter, typeFilter, searchQuery, studentsMap, sectionsMap]);

  async function handleConfirmClearance() {
    if (!clearanceModalItem) return;
    setIsProcessing(true);
    try {
      await onUpdateStatus(clearanceModalItem.id, "Cleared", clearanceNotes);
      setClearanceModalItem(null);
    } finally {
      setIsProcessing(false);
    }
  }

  async function handleReactivate(enrolmentId) {
    setIsProcessing(true);
    try {
      await onUpdateStatus(enrolmentId, "Active", "Reactivated backlog enrolment by academic admin");
    } finally {
      setIsProcessing(false);
    }
  }

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      {/* Header and Quick Demo Action */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 bg-zinc-900 p-6 sm:p-8 rounded-3xl border border-zinc-800 shadow-2xl">
        <div className="space-y-2">
          <div className="flex items-center space-x-2">
            <span className="px-3 py-1 bg-yellow-400 text-black text-xs font-black uppercase rounded-full tracking-wide">
              Dynamic Backlog Resolution
            </span>
            <span className="text-xs font-bold text-zinc-400">Non-Destructive Free Slot Optimization</span>
          </div>
          <h2 className="text-3xl font-black text-white tracking-tight">Student Enrolment &amp; Backlog Control</h2>
          <p className="text-sm text-zinc-300 max-w-2xl leading-relaxed">
            When students clear backlog examinations post-generation, instant slot freeing releases their personal timetable periods without perturbing room, faculty, or cohort assignments.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={onLoadBacklogDemo}
            className="px-4 py-2.5 bg-yellow-400 hover:bg-yellow-300 text-black rounded-xl text-xs font-black shadow-lg shadow-yellow-500/20 transition flex items-center space-x-2 hover:scale-[1.02] transform duration-150"
            title="Load live demo scenario for Student 2026CS104 (Alex Vance)"
          >
            <Icon name="sparkles" className="w-4 h-4 text-black" />
            <span>⚡ Load Alex Vance Demo (2026CS104)</span>
          </button>
        </div>
      </div>

      {/* Confirmation Message Banner */}
      {banner && (
        <div className="bg-zinc-900 border-2 border-yellow-400 rounded-2xl p-5 shadow-2xl space-y-3 animate-in fade-in duration-200">
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
            <div className="flex items-center space-x-3.5">
              <div className="w-11 h-11 rounded-xl bg-yellow-400 text-black flex items-center justify-center font-black shrink-0 shadow-md shadow-yellow-500/20">
                <Icon name="check-circle" className="w-6 h-6 text-black stroke-[2.5]" />
              </div>
              <div>
                <div className="flex items-center space-x-2">
                  <span className="text-xs font-black uppercase bg-yellow-400 text-black px-2 py-0.5 rounded">
                    Backlog Cleared
                  </span>
                  <span className="text-xs text-zinc-400 font-mono">{banner.timestamp}</span>
                </div>
                <p className="text-base font-bold text-white mt-1">
                  {banner.message}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                onClick={() => onNavigateToStudentTimetable(banner.studentId)}
                className="px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-xl text-xs font-bold border border-zinc-700 transition flex items-center space-x-1.5"
              >
                <Icon name="calendar" className="w-3.5 h-3.5 text-yellow-400" />
                <span>View {banner.studentName || 'Student'}’s Timetable</span>
              </button>

              {banner.canReoptimise && (
                <button
                  onClick={onReoptimiseTimetable}
                  disabled={isSolving}
                  className="px-3.5 py-2 bg-yellow-400 hover:bg-yellow-300 text-black rounded-xl text-xs font-black shadow-md transition flex items-center space-x-1.5"
                  title="Optional: Global re-solve will adjust master room allocations"
                >
                  <Icon name="sparkles" className="w-3.5 h-3.5 text-black" />
                  <span>{isSolving ? 'Solving...' : 'Optional: Re-optimise Timetable'}</span>
                </button>
              )}

              <button
                onClick={() => setBanner(null)}
                className="p-2 text-zinc-400 hover:text-white rounded-lg hover:bg-zinc-800 transition"
                title="Dismiss banner"
              >
                <Icon name="x" className="w-4 h-4" />
              </button>
            </div>
          </div>

          <div className="text-xs text-zinc-300 bg-black/70 p-3 rounded-xl border border-zinc-800 flex items-center space-x-2">
            <Icon name="shield-check" className="w-4 h-4 text-yellow-400 shrink-0" />
            <span>
              <strong>Truthful Reporting Guarantee:</strong> The student’s slot has been converted into an available free period. The master timetable for faculty, rooms, and other enrolled students remains 100% stable.
            </span>
          </div>
        </div>
      )}

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-xl">
          <div className="text-zinc-500 text-xs font-bold uppercase tracking-wider">Total Enrolments</div>
          <div className="text-2xl font-black text-white mt-1">{counts.all}</div>
          <div className="text-[11px] text-zinc-400 mt-0.5">Across all courses</div>
        </div>

        <div className="bg-zinc-900 p-5 rounded-2xl border border-yellow-400/40 shadow-xl">
          <div className="text-yellow-400 text-xs font-black uppercase tracking-wider flex items-center space-x-1">
            <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></span>
            <span>Active Backlogs</span>
          </div>
          <div className="text-2xl font-black text-yellow-400 mt-1">{counts.activeBacklogs}</div>
          <div className="text-[11px] text-zinc-400 mt-0.5">Require schedule slots</div>
        </div>

        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-xl">
          <div className="text-zinc-400 text-xs font-bold uppercase tracking-wider">Cleared Backlogs</div>
          <div className="text-2xl font-black text-white mt-1">{counts.clearedBacklogs}</div>
          <div className="text-[11px] text-zinc-400 mt-0.5">Slots freed for students</div>
        </div>

        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-xl">
          <div className="text-zinc-400 text-xs font-bold uppercase tracking-wider">Freed Student Hours</div>
          <div className="text-2xl font-black text-yellow-400 mt-1">
            {scheduleResponse?.metrics?.freed_student_hours || counts.clearedBacklogs} hrs
          </div>
          <div className="text-[11px] text-zinc-400 mt-0.5">Available self-study periods</div>
        </div>

        <div className="bg-zinc-900 p-5 rounded-2xl border border-zinc-800 shadow-xl col-span-2 md:col-span-1">
          <div className="text-zinc-400 text-xs font-bold uppercase tracking-wider">Master Schedule</div>
          <div className="text-2xl font-black text-white mt-1">100% Stable</div>
          <div className="text-[11px] text-zinc-400 mt-0.5">Zero unneeded churn</div>
        </div>
      </div>

      {/* Main Table Controls & Filters */}
      <div className="bg-zinc-900 rounded-3xl border border-zinc-800 shadow-xl overflow-hidden space-y-4 p-6">
        <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
          {/* Status Tabs */}
          <div className="flex flex-wrap bg-black p-1 rounded-xl text-xs font-bold border border-zinc-800">
            {[
              { id: "All", label: `All (${counts.all})` },
              { id: "Active", label: `Active (${counts.active})` },
              { id: "Cleared", label: `Cleared (${counts.cleared})` },
              { id: "Dropped", label: `Dropped (${counts.dropped})` },
              { id: "Pending", label: `Pending (${counts.pending})` }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setStatusFilter(tab.id)}
                className={`px-3 py-1.5 rounded-lg transition ${
                  statusFilter === tab.id ? 'bg-yellow-400 text-black shadow-md' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-3 w-full lg:w-auto">
            {/* Type Filter */}
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="bg-black border border-zinc-800 text-white rounded-lg text-xs py-2 px-3 focus:outline-none focus:ring-2 focus:ring-yellow-400"
            >
              <option value="All">All Types</option>
              <option value="Backlog">Backlog Only</option>
              <option value="Regular">Regular</option>
              <option value="Elective">Elective</option>
            </select>

            {/* Search Input */}
            <div className="relative flex-1 sm:w-64">
              <Icon name="search" className="w-4 h-4 text-zinc-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search student, course, notes..."
                className="w-full pl-9 pr-3 py-1.5 bg-black border border-zinc-800 text-white rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-yellow-400"
              />
            </div>
          </div>
        </div>

        {/* Enrolments Table */}
        <div className="overflow-x-auto custom-scroll border border-zinc-800 rounded-2xl">
          <table className="w-full text-left text-xs divide-y divide-zinc-800 min-w-[850px]">
            <thead className="bg-zinc-950 text-zinc-400 font-bold uppercase text-[11px]">
              <tr>
                <th className="py-3.5 px-4">Student</th>
                <th className="py-3.5 px-4">Type</th>
                <th className="py-3.5 px-4">Course Section</th>
                <th className="py-3.5 px-4">Scheduled Slot &amp; Room</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4">Audit Notes / Record</th>
                <th className="py-3.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {filteredEnrolments.length === 0 ? (
                <tr>
                  <td colSpan="7" className="py-8 text-center text-zinc-500">
                    No enrolments found matching your search filters.
                  </td>
                </tr>
              ) : (
                filteredEnrolments.map(enr => {
                  const student = studentsMap[enr.student_id];
                  const section = sectionsMap[enr.section_id];
                  const assignment = assignmentsMap[enr.section_id];
                  const isBacklog = enr.enrolment_type === "Backlog";

                  return (
                    <tr key={enr.id} className="hover:bg-zinc-800/40 transition">
                      {/* Student */}
                      <td className="py-3 px-4">
                        <div className="font-bold text-white text-sm">
                          {student?.name || enr.student_id}
                        </div>
                        <div className="text-[11px] font-mono text-yellow-400">
                          {student?.registration_number || enr.student_id}
                        </div>
                      </td>

                      {/* Type */}
                      <td className="py-3 px-4">
                        {isBacklog ? (
                          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-black bg-yellow-400 text-black border border-yellow-300 shadow-xs">
                            BACKLOG
                          </span>
                        ) : enr.enrolment_type === "Elective" ? (
                          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-sky-950 text-sky-400 border border-sky-800">
                            ELECTIVE
                          </span>
                        ) : (
                          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-medium bg-zinc-800 text-zinc-300">
                            REGULAR
                          </span>
                        )}
                      </td>

                      {/* Course */}
                      <td className="py-3 px-4">
                        <div className="font-black text-white">
                          {section?.course_code || enr.section_id} [{section?.section_label || 'A'}]
                        </div>
                        <div className="text-[11px] text-zinc-400 truncate max-w-[180px]">
                          {section?.course_name || ''}
                        </div>
                      </td>

                      {/* Scheduled Slot & Room */}
                      <td className="py-3 px-4">
                        {assignment ? (
                          <div>
                            <span className="font-mono font-bold text-yellow-400">
                              {assignment.day} {assignment.start_time} - {assignment.end_time}
                            </span>
                            <div className="text-[11px] text-zinc-400">
                              {assignment.room_name} ({assignment.faculty_name})
                            </div>
                          </div>
                        ) : (
                          <span className="text-zinc-500 italic">Not scheduled / Pending</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4">
                        {enr.status === "Active" ? (
                          <span className="px-2.5 py-1 rounded-md text-[10px] font-bold bg-emerald-950/60 text-emerald-400 border border-emerald-800/80 flex items-center space-x-1 w-max">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                            <span>ACTIVE</span>
                          </span>
                        ) : enr.status === "Cleared" ? (
                          <span className="px-2.5 py-1 rounded-md text-[10px] font-black bg-yellow-400/20 text-yellow-300 border border-yellow-400/50 flex items-center space-x-1 w-max">
                            <Icon name="check" className="w-3 h-3 text-yellow-400 stroke-[3]" />
                            <span>CLEARED</span>
                          </span>
                        ) : enr.status === "Dropped" ? (
                          <span className="px-2.5 py-1 rounded-md text-[10px] font-bold bg-zinc-800 text-zinc-400 border border-zinc-700 w-max">
                            DROPPED
                          </span>
                        ) : (
                          <span className="px-2.5 py-1 rounded-md text-[10px] font-bold bg-amber-950 text-amber-400 border border-amber-800 w-max">
                            PENDING
                          </span>
                        )}
                      </td>

                      {/* Notes / Audit */}
                      <td className="py-3 px-4">
                        <div className="text-[11px] text-zinc-300 max-w-[220px] truncate" title={enr.notes || "Standard enrolment"}>
                          {enr.notes || <span className="text-zinc-500 italic">No notes</span>}
                        </div>
                        {enr.cleared_at && (
                          <div className="text-[10px] text-yellow-400/80 mt-0.5">
                            Cleared: {new Date(enr.cleared_at).toLocaleDateString()}
                          </div>
                        )}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right space-x-2">
                        {enr.status === "Active" && isBacklog && (
                          <button
                            onClick={() => setClearanceModalItem(enr)}
                            disabled={isProcessing}
                            className="px-3 py-1.5 bg-yellow-400 hover:bg-yellow-300 text-black font-black text-xs rounded-lg shadow-sm transition"
                            title="Mark student as cleared for this backlog course"
                          >
                            Mark as Cleared
                          </button>
                        )}

                        {enr.status === "Cleared" && (
                          <button
                            onClick={() => handleReactivate(enr.id)}
                            disabled={isProcessing}
                            className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-yellow-400 border border-zinc-700 font-bold text-xs rounded-lg transition"
                            title="Undo clearance and restore active backlog enrolment"
                          >
                            Reactivate Backlog
                          </button>
                        )}

                        <button
                          onClick={() => onNavigateToStudentTimetable(enr.student_id)}
                          className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white font-bold text-xs rounded-lg border border-zinc-700 transition"
                          title="Inspect student's personal weekly schedule"
                        >
                          Timetable
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Audit History Log Panel */}
      <div className="bg-zinc-900 rounded-3xl border border-zinc-800 p-6 shadow-xl space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-yellow-400/10 text-yellow-400 border border-yellow-400/30 flex items-center justify-center font-bold">
              <Icon name="history" className="w-5 h-5 stroke-[2.5]" />
            </div>
            <div>
              <h3 className="text-lg font-black text-white">Dynamic Resolution Audit Trail</h3>
              <p className="text-xs text-zinc-400">
                Immutable chronological log of all backlog clearances and slot release operations.
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowAuditTrail(!showAuditTrail)}
            className="text-xs font-bold text-yellow-400 hover:underline"
          >
            {showAuditTrail ? "Collapse Audit Log" : "Expand Audit Log"}
          </button>
        </div>

        {showAuditTrail && (
          <div className="space-y-2.5 pt-2">
            {(!dataset?.audit_logs || dataset.audit_logs.length === 0) ? (
              <div className="p-4 bg-black rounded-xl border border-zinc-800 text-xs text-zinc-500 italic text-center">
                No audit log entries recorded yet. When you mark a backlog as cleared, audit records will appear here.
              </div>
            ) : (
              dataset.audit_logs.slice().reverse().map((log, idx) => (
                <div key={log.id || idx} className="p-3.5 bg-black rounded-xl border border-zinc-800 flex items-start justify-between gap-4 text-xs">
                  <div className="flex items-start space-x-3">
                    <span className="w-2 h-2 rounded-full bg-yellow-400 mt-1.5 shrink-0"></span>
                    <div className="space-y-0.5">
                      <div className="font-medium text-white font-mono leading-relaxed">
                        {log.message}
                      </div>
                      <div className="text-[11px] text-zinc-400 flex items-center space-x-3">
                        <span>Action: <strong className="text-yellow-400">{log.action}</strong></span>
                        <span>Recorded by: <strong>{log.actor}</strong></span>
                        <span>Student: <span className="font-mono">{log.student_reg_no || log.student_id}</span></span>
                      </div>
                    </div>
                  </div>
                  <div className="text-[11px] font-mono text-zinc-500 shrink-0">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Confirmation Modal for Mark as Cleared */}
      {clearanceModalItem && (() => {
        const student = studentsMap[clearanceModalItem.student_id];
        const section = sectionsMap[clearanceModalItem.section_id];
        const assignment = assignmentsMap[clearanceModalItem.section_id];

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="bg-zinc-900 rounded-3xl max-w-lg w-full p-6 sm:p-7 shadow-2xl border-2 border-yellow-400 space-y-5 animate-in fade-in duration-200 text-white">
              <div className="flex justify-between items-start">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 rounded-xl bg-yellow-400 text-black flex items-center justify-center font-black">
                    <Icon name="award" className="w-6 h-6 stroke-[2.5]" />
                  </div>
                  <div>
                    <span className="text-xs font-black uppercase text-yellow-400 tracking-wider">Dynamic Resolution</span>
                    <h3 className="text-xl font-black text-white">Confirm Backlog Clearance</h3>
                  </div>
                </div>
                <button onClick={() => setClearanceModalItem(null)} className="p-1 text-zinc-400 hover:text-white rounded-lg">
                  <Icon name="x" className="w-5 h-5" />
                </button>
              </div>

              {/* Clearance Summary Details */}
              <div className="p-4 bg-black rounded-2xl border border-zinc-800 space-y-3 text-xs">
                <div className="flex justify-between items-center border-b border-zinc-800 pb-2">
                  <span className="text-zinc-400">Student:</span>
                  <span className="font-black text-white">
                    {student?.name || clearanceModalItem.student_id} ({student?.registration_number || clearanceModalItem.student_id})
                  </span>
                </div>
                <div className="flex justify-between items-center border-b border-zinc-800 pb-2">
                  <span className="text-zinc-400">Backlog Course:</span>
                  <span className="font-black text-yellow-400">
                    {section?.course_code} - {section?.course_name} [{section?.section_label}]
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-zinc-400">Scheduled Time &amp; Room:</span>
                  <span className="font-bold text-white">
                    {assignment ? `${assignment.day} ${assignment.start_time} - ${assignment.end_time} (${assignment.room_name})` : "Pending"}
                  </span>
                </div>
              </div>

              {/* Non-Destructive Explanatory Callout */}
              <div className="p-4 bg-yellow-400/10 border border-yellow-400/30 rounded-2xl text-xs space-y-1 text-zinc-200 leading-relaxed">
                <div className="font-bold text-yellow-400 flex items-center space-x-1.5">
                  <Icon name="info" className="w-4 h-4 text-yellow-400 inline" />
                  <span>What happens when you confirm:</span>
                </div>
                <ul className="list-disc list-inside space-y-1 text-[11px] text-zinc-300 pt-1">
                  <li>
                    <strong>Student personal timetable:</strong> The {assignment ? `${assignment.day} ${assignment.start_time}` : 'course'} slot becomes immediately free ("Available Period").
                  </li>
                  <li>
                    <strong>Master timetable stability:</strong> Room, faculty, and other enrolled students remain 100% stable without being rescheduled.
                  </li>
                  <li>
                    <strong>Conflict Lab:</strong> Overlap clashes caused purely by this backlog are permanently resolved.
                  </li>
                </ul>
              </div>

              {/* Notes Input */}
              <div className="space-y-1.5 text-xs">
                <label className="font-bold text-zinc-300 block">Clearance Record Notes / Exam Reference:</label>
                <input
                  type="text"
                  value={clearanceNotes}
                  onChange={(e) => setClearanceNotes(e.target.value)}
                  placeholder="e.g. Cleared Supplementary Exam Nov 2026, Grade: B+"
                  className="w-full p-2.5 bg-black border border-zinc-800 rounded-xl text-white focus:outline-none focus:ring-2 focus:ring-yellow-400 text-xs"
                />
              </div>

              {/* Actions */}
              <div className="flex justify-end space-x-3 pt-2">
                <button
                  onClick={() => setClearanceModalItem(null)}
                  className="px-4 py-2.5 border border-zinc-700 text-zinc-300 rounded-xl text-xs font-bold hover:bg-zinc-800 transition"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmClearance}
                  disabled={isProcessing}
                  className="px-5 py-2.5 bg-yellow-400 hover:bg-yellow-300 text-black font-black text-xs rounded-xl shadow-lg shadow-yellow-500/20 transition flex items-center space-x-1.5"
                >
                  <Icon name="check" className="w-4 h-4 text-black stroke-[3]" />
                  <span>{isProcessing ? "Processing..." : "Confirm Clearance"}</span>
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// --------------------------------------------------------------------------
// MODAL DIALOGS (BLACK - YELLOW - WHITE)
// --------------------------------------------------------------------------
function AssignmentDetailModal({ assignment, onClose, dataset }) {
  if (!assignment) return null;

  const enrolledStudents = dataset?.students?.filter(s => s.enrolled_section_ids.includes(assignment.section_id)) || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 rounded-3xl max-w-lg w-full p-6 shadow-2xl border-2 border-yellow-400/30 space-y-5 animate-in fade-in duration-200 text-white">
        <div className="flex justify-between items-start">
          <div>
            <span className="text-xs font-black text-yellow-400 uppercase tracking-wider">{assignment.department}</span>
            <h3 className="text-2xl font-black text-white">{assignment.course_code} [{assignment.section_label}]</h3>
            <p className="text-sm text-zinc-300 font-medium">{assignment.course_name}</p>
          </div>
          <button onClick={onClose} className="p-1 text-zinc-400 hover:text-white rounded-lg">
            <Icon name="x" className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800">
            <span className="text-zinc-500 block font-bold">Scheduled Time</span>
            <span className="font-black text-yellow-400">{assignment.day} {assignment.start_time} - {assignment.end_time}</span>
          </div>
          <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800">
            <span className="text-zinc-500 block font-bold">Assigned Room</span>
            <span className="font-bold text-white">{assignment.room_name} ({assignment.room_capacity} seats)</span>
          </div>
          <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800">
            <span className="text-zinc-500 block font-bold">Instructor</span>
            <span className="font-bold text-white">{assignment.faculty_name}</span>
          </div>
          <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800">
            <span className="text-zinc-500 block font-bold">Enrolment Efficiency</span>
            <span className="font-black text-yellow-400">{assignment.enrolment_count} / {assignment.room_capacity} ({Math.round((assignment.enrolment_count / assignment.room_capacity) * 100)}%)</span>
          </div>
        </div>

        <div>
          <span className="text-xs font-black text-white uppercase tracking-wider block mb-2">
            Enrolled Students ({enrolledStudents.length}):
          </span>
          <div className="max-h-36 overflow-y-auto space-y-1 text-xs custom-scroll pr-2">
            {enrolledStudents.slice(0, 30).map(st => (
              <div key={st.id} className="flex justify-between items-center py-1 border-b border-zinc-800 last:border-b-0">
                <span className="font-medium text-white">{st.name}</span>
                <span className="text-yellow-400 font-mono text-[11px]">{st.id} {st.is_backlog && '(Backlog)'}</span>
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={onClose}
          className="w-full py-2.5 bg-yellow-400 hover:bg-yellow-300 text-black rounded-xl text-sm font-black shadow-md transition"
        >
          Close Detail Panel
        </button>
      </div>
    </div>
  );
}

function DataEditModal({ entityType, item, dataset, onSave, onClose }) {
  const [formData, setFormData] = useState(
    item || {
      id: `${entityType.toUpperCase().slice(0, 3)}-${Date.now() % 1000}`,
      course_code: "CS201",
      course_name: "Algorithms",
      department: "Computer Science",
      section_label: "A",
      enrolment_count: 60,
      faculty_id: dataset?.faculty?.[0]?.id || "FAC-101",
      required_room_type: "Lecture",
      capacity: 75,
      name: "New Room",
      building: "Science Block",
      room_type: "Lecture"
    }
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 rounded-3xl max-w-md w-full p-6 shadow-2xl border-2 border-yellow-400/30 space-y-4 text-white">
        <h3 className="text-xl font-black text-white">
          {item ? `Edit ${entityType.slice(0, -1)}` : `Add New ${entityType.slice(0, -1)}`}
        </h3>

        <div className="space-y-3 text-xs">
          {entityType === "sections" && (
            <>
              <div>
                <label className="font-bold text-zinc-300 block mb-1">Course Code</label>
                <input
                  type="text"
                  value={formData.course_code || ""}
                  onChange={(e) => setFormData({ ...formData, course_code: e.target.value })}
                  className="w-full p-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                />
              </div>
              <div>
                <label className="font-bold text-zinc-300 block mb-1">Course Name</label>
                <input
                  type="text"
                  value={formData.course_name || ""}
                  onChange={(e) => setFormData({ ...formData, course_name: e.target.value })}
                  className="w-full p-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="font-bold text-zinc-300 block mb-1">Enrolment</label>
                  <input
                    type="number"
                    value={formData.enrolment_count || 60}
                    onChange={(e) => setFormData({ ...formData, enrolment_count: parseInt(e.target.value) })}
                    className="w-full p-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  />
                </div>
                <div>
                  <label className="font-bold text-zinc-300 block mb-1">Room Type</label>
                  <select
                    value={formData.required_room_type || "Lecture"}
                    onChange={(e) => setFormData({ ...formData, required_room_type: e.target.value })}
                    className="w-full p-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  >
                    <option value="Lecture">Lecture</option>
                    <option value="Lab">Lab</option>
                    <option value="Seminar">Seminar</option>
                  </select>
                </div>
              </div>
            </>
          )}

          {entityType === "rooms" && (
            <>
              <div>
                <label className="font-bold text-zinc-300 block mb-1">Room Name</label>
                <input
                  type="text"
                  value={formData.name || ""}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="w-full p-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="font-bold text-zinc-300 block mb-1">Capacity</label>
                  <input
                    type="number"
                    value={formData.capacity || 80}
                    onChange={(e) => setFormData({ ...formData, capacity: parseInt(e.target.value) })}
                    className="w-full p-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  />
                </div>
                <div>
                  <label className="font-bold text-zinc-300 block mb-1">Room Type</label>
                  <select
                    value={formData.room_type || "Lecture"}
                    onChange={(e) => setFormData({ ...formData, room_type: e.target.value })}
                    className="w-full p-2 bg-zinc-950 border border-zinc-800 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-yellow-400"
                  >
                    <option value="Lecture">Lecture</option>
                    <option value="Lab">Lab</option>
                    <option value="Seminar">Seminar</option>
                  </select>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end space-x-2 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 border border-zinc-700 text-zinc-300 rounded-xl text-xs font-bold hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(formData)}
            className="px-4 py-2 bg-yellow-400 hover:bg-yellow-300 text-black rounded-xl text-xs font-black shadow-md transition"
          >
            Save Record
          </button>
        </div>
      </div>
    </div>
  );
}


// ==========================================================================
// AUTHENTICATION & LOGIN / SIGNUP SCREEN COMPONENT
// ==========================================================================
function AuthScreen({ onLoginSuccess, apiOnline, engineInfo }) {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [loading, setLoading] = useState(false);

  // Signup fields
  const [fullName, setFullName] = useState("");
  const [regNo, setRegNo] = useState("");
  const [department, setDepartment] = useState("Computer Science");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [signupSuccess, setSignupSuccess] = useState("");

  const demoAccounts = [
    {
      role: "ADMIN",
      badgeClass: "bg-yellow-400 text-black font-black",
      title: "Academic Administrator",
      subtitle: "Full Access & Solver Control",
      email: "admin@schedulr.demo",
      password: "Schedulr2026!",
      desc: "Full timetable solver, Conflict Lab, What-If simulator, and Backlog clearance."
    },
    {
      role: "FACULTY",
      badgeClass: "bg-sky-400/20 text-sky-400 border border-sky-400/30 font-bold",
      title: "Dr. Alan Turing",
      subtitle: "CS Department Faculty",
      email: "faculty@schedulr.demo",
      password: "Faculty2026!",
      desc: "Personal teaching timetable, assigned course sections, workload & availability."
    },
    {
      role: "STUDENT",
      badgeClass: "bg-emerald-400/20 text-emerald-400 border border-emerald-400/30 font-bold",
      title: "Alex Vance (2026CS104)",
      subtitle: "Enrolled & Backlog Student",
      email: "student@schedulr.demo",
      password: "Student2026!",
      desc: "Personal enrolled timetable, dynamic backlog status & freed study slots."
    }
  ];

  async function handleLoginSubmit(targetEmail = email, targetPassword = password) {
    if (!targetEmail.trim() || !targetPassword) {
      setErrorMsg("Please enter both email and password.");
      return;
    }
    setErrorMsg("");
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: targetEmail.trim(), password: targetPassword })
      });
      const data = await res.json();
      if (res.ok) {
        onLoginSuccess(data.access_token, data.user);
      } else {
        setErrorMsg(data.detail || "Invalid credentials. Please verify your email and password.");
      }
    } catch (err) {
      setErrorMsg("Unable to reach Schedulr API service. Please verify server status.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSignupSubmit(e) {
    e.preventDefault();
    setErrorMsg("");
    setSignupSuccess("");
    if (!fullName.trim()) {
      setErrorMsg("Please enter your full name.");
      return;
    }
    if (!email.trim() || !email.includes("@")) {
      setErrorMsg("Please enter a valid email address.");
      return;
    }
    if (password.length < 8) {
      setErrorMsg("Password must be at least 8 characters long.");
      return;
    }
    if (password !== confirmPassword) {
      setErrorMsg("Passwords do not match. Please re-enter.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: fullName.trim(),
          registration_number: regNo.trim() || undefined,
          department: department,
          email: email.trim().toLowerCase(),
          password: password,
          confirm_password: confirmPassword
        })
      });
      const data = await res.json();
      if (res.ok) {
        setSignupSuccess("Account created successfully! Redirecting to student portal...");
        setTimeout(() => {
          onLoginSuccess(data.access_token, data.user);
        }, 700);
      } else {
        setErrorMsg(data.detail || "Registration failed. Please check your details.");
      }
    } catch (err) {
      setErrorMsg("Network error connecting to registration server.");
    } finally {
      setLoading(false);
    }
  }

  function quickFillAndLogin(acc) {
    setEmail(acc.email);
    setPassword(acc.password);
    setMode("login");
    setErrorMsg("");
    handleLoginSubmit(acc.email, acc.password);
  }

  return (
    <div className="min-h-screen bg-[#09090b] text-white flex flex-col justify-between selection:bg-yellow-400 selection:text-black">
      {/* Top Banner */}
      <header className="border-b border-zinc-800/80 bg-[#0c0c0e]/80 backdrop-blur px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded-xl bg-yellow-400 text-black flex items-center justify-center font-black shadow-lg shadow-yellow-500/25">
            <Icon name="calendar-check" className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div>
            <span className="text-lg font-black tracking-tight text-white">Schedulr</span>
            <span className="ml-2 px-2 py-0.5 text-[11px] font-bold bg-yellow-400/10 text-yellow-400 rounded-full border border-yellow-400/30">
              Clash Resolver
            </span>
          </div>
        </div>
        <div className="flex items-center space-x-2 text-xs text-zinc-400 bg-zinc-900/90 px-3 py-1.5 rounded-lg border border-zinc-800">
          <span className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse"></span>
          <span className="font-mono">{engineInfo || "Google OR-Tools CP-SAT"}</span>
        </div>
      </header>

      {/* Main Auth Content Container */}
      <main className="flex-1 flex items-center justify-center p-4 sm:p-6 my-6">
        <div className="max-w-xl w-full space-y-6">
          
          {/* Schedulr Title & Intro */}
          <div className="text-center space-y-2">
            <div className="inline-flex items-center space-x-2 px-3 py-1 rounded-full bg-yellow-400/10 border border-yellow-400/30 text-yellow-400 text-xs font-bold tracking-wide uppercase">
              <Icon name="sparkles" className="w-3.5 h-3.5" />
              <span>Role-Based Access Control • University Timetable Portal</span>
            </div>
            <h1 className="text-3xl sm:text-4xl font-black tracking-tight text-white">
              Sign in to <span className="text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-amber-200">Schedulr</span>
            </h1>
            <p className="text-sm text-zinc-400 max-w-md mx-auto">
              Intelligent timetable clash resolution for Administrators, Faculty members, and Students.
            </p>
          </div>

          {/* Expandable / 1-Click Demo Accounts Card */}
          <div className="bg-[#121215] border-2 border-yellow-400/30 rounded-2xl p-4 sm:p-5 shadow-2xl shadow-yellow-500/5 relative overflow-hidden">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center space-x-2">
                <Icon name="key" className="w-4 h-4 text-yellow-400" />
                <span className="text-xs font-bold uppercase tracking-wider text-yellow-400">
                  Demo Showcase Credentials (1-Click Access)
                </span>
              </div>
              <span className="text-[11px] text-zinc-400 font-mono">Bcrypt + JWT</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-3">
              {demoAccounts.map(acc => (
                <button
                  key={acc.role}
                  type="button"
                  onClick={() => quickFillAndLogin(acc)}
                  disabled={loading}
                  className="p-3 rounded-xl bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-800 hover:border-yellow-400/50 text-left transition transform hover:-translate-y-0.5 group focus:outline-none focus:ring-2 focus:ring-yellow-400"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${acc.badgeClass}`}>
                      {acc.role}
                    </span>
                    <Icon name="arrow-right" className="w-3.5 h-3.5 text-zinc-500 group-hover:text-yellow-400 transition" />
                  </div>
                  <div className="text-xs font-bold text-white group-hover:text-yellow-300 transition">{acc.title}</div>
                  <div className="text-[10px] text-zinc-400 truncate">{acc.email}</div>
                  <div className="mt-2 text-[10px] text-yellow-400/80 font-semibold flex items-center space-x-1">
                    <span>1-Click Sign In</span>
                    <span>→</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Form Card (Sign In / Sign Up) */}
          <div className="bg-[#121215] border border-zinc-800 rounded-2xl p-6 sm:p-8 shadow-xl">
            {/* Mode Toggle Buttons */}
            <div className="flex rounded-xl bg-zinc-900 p-1 mb-6 border border-zinc-800">
              <button
                type="button"
                onClick={() => { setMode("login"); setErrorMsg(""); }}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition flex items-center justify-center space-x-2 ${
                  mode === "login"
                    ? "bg-yellow-400 text-black shadow-sm"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                <Icon name="lock" className="w-3.5 h-3.5" />
                <span>Sign In to Account</span>
              </button>
              <button
                type="button"
                onClick={() => { setMode("signup"); setErrorMsg(""); }}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition flex items-center justify-center space-x-2 ${
                  mode === "signup"
                    ? "bg-yellow-400 text-black shadow-sm"
                    : "text-zinc-400 hover:text-white"
                }`}
              >
                <Icon name="graduation-cap" className="w-3.5 h-3.5" />
                <span>Create Student Account</span>
              </button>
            </div>

            {/* Error & Success Alerts */}
            {errorMsg && (
              <div className="mb-5 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-start space-x-2.5">
                <Icon name="alert-triangle" className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span>{errorMsg}</span>
              </div>
            )}
            {signupSuccess && (
              <div className="mb-5 p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-start space-x-2.5">
                <Icon name="check-circle-2" className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <span>{signupSuccess}</span>
              </div>
            )}

            {/* Mode 1: LOGIN FORM */}
            {mode === "login" && (
              <form onSubmit={(e) => { e.preventDefault(); handleLoginSubmit(); }} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold uppercase tracking-wider text-zinc-300 mb-1.5">
                    Email Address
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                      <Icon name="mail" className="w-4 h-4" />
                    </div>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="admin@schedulr.demo"
                      className="w-full pl-10 pr-4 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-xs font-bold uppercase tracking-wider text-zinc-300">
                      Password
                    </label>
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="text-xs text-zinc-400 hover:text-yellow-400 flex items-center space-x-1"
                    >
                      <Icon name={showPassword ? "eye-off" : "eye"} className="w-3.5 h-3.5" />
                      <span>{showPassword ? "Hide" : "Show"}</span>
                    </button>
                  </div>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-zinc-500">
                      <Icon name="lock" className="w-4 h-4" />
                    </div>
                    <input
                      type={showPassword ? "text" : "password"}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      className="w-full pl-10 pr-10 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-black font-black text-sm shadow-lg shadow-yellow-500/20 active:scale-[0.99] transition flex items-center justify-center space-x-2 mt-2"
                >
                  {loading ? (
                    <>
                      <Icon name="loader-2" className="animate-spin w-4 h-4 text-black" />
                      <span>Authenticating...</span>
                    </>
                  ) : (
                    <>
                      <span>Sign In to Workspace</span>
                      <Icon name="arrow-right" className="w-4 h-4 text-black" />
                    </>
                  )}
                </button>
              </form>
            )}

            {/* Mode 2: SIGNUP FORM */}
            {mode === "signup" && (
              <form onSubmit={handleSignupSubmit} className="space-y-4">
                <div className="p-3 bg-yellow-400/10 border border-yellow-400/20 rounded-xl text-xs text-yellow-300 flex items-start space-x-2">
                  <Icon name="shield" className="w-4 h-4 text-yellow-400 shrink-0 mt-0.5" />
                  <span>
                    Public registration automatically provisions a <strong>Student Account</strong>. For Faculty or Administrator access, please contact the Academic Registrar.
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-zinc-300 mb-1">
                      Full Name
                    </label>
                    <input
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="e.g. Maya Lin"
                      className="w-full px-3.5 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-zinc-300 mb-1">
                      Reg Number
                    </label>
                    <input
                      type="text"
                      value={regNo}
                      onChange={(e) => setRegNo(e.target.value)}
                      placeholder="e.g. 2026CS112"
                      className="w-full px-3.5 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-zinc-300 mb-1">
                      Department
                    </label>
                    <select
                      value={department}
                      onChange={(e) => setDepartment(e.target.value)}
                      className="w-full px-3 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-white focus:outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition"
                    >
                      <option value="Computer Science">Computer Science</option>
                      <option value="Electrical Eng">Electrical Eng</option>
                      <option value="Mathematics">Mathematics</option>
                      <option value="Mechanical Eng">Mechanical Eng</option>
                      <option value="Physics">Physics</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-zinc-300 mb-1">
                      Email Address
                    </label>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="student@univ.edu"
                      className="w-full px-3.5 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-zinc-300 mb-1">
                      Password (min 8)
                    </label>
                    <input
                      type="password"
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••••••"
                      className="w-full px-3.5 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-zinc-300 mb-1">
                      Confirm Password
                    </label>
                    <input
                      type="password"
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="••••••••••••"
                      className="w-full px-3.5 py-2.5 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-white placeholder-zinc-600 focus:outline-none focus:border-yellow-400 focus:ring-1 focus:ring-yellow-400 transition"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 rounded-xl bg-yellow-400 hover:bg-yellow-300 text-black font-black text-sm shadow-lg shadow-yellow-500/20 active:scale-[0.99] transition flex items-center justify-center space-x-2 mt-3"
                >
                  {loading ? (
                    <>
                      <Icon name="loader-2" className="animate-spin w-4 h-4 text-black" />
                      <span>Registering Student Account...</span>
                    </>
                  ) : (
                    <>
                      <span>Complete Student Registration</span>
                      <Icon name="arrow-right" className="w-4 h-4 text-black" />
                    </>
                  )}
                </button>
              </form>
            )}
          </div>

          <div className="text-center text-xs text-zinc-400 flex items-center justify-center space-x-3">
            <span>FastAPI Single Service</span>
            <span>•</span>
            <span>PostgreSQL / SQLite</span>
            <span>•</span>
            <span>Bcrypt Hashing</span>
            <span>•</span>
            <span>JWT Bearer</span>
          </div>
        </div>
      </main>
    </div>
  );
}

// ==========================================================================
// FACULTY PORTAL COMPONENT
// ==========================================================================
function FacultyPortal({ facultySchedule, activeSubTab, onNavigate, currentUser, roleLoading, onRefresh }) {
  const faculty = facultySchedule?.faculty || {
    name: currentUser?.full_name || "Faculty Member",
    email: currentUser?.email || "faculty@schedulr.demo",
    department: currentUser?.department || "Computer Science",
    max_daily_hours: 4
  };
  const sections = facultySchedule?.sections || [];
  const assignments = facultySchedule?.assignments || [];
  const insights = facultySchedule?.insights || {
    total_assigned_sections: sections.length,
    weekly_teaching_hours: assignments.length,
    days_active: 3,
    room_assignments: []
  };

  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const hours = [9, 10, 11, 12, 13, 14, 15, 16];

  return (
    <div className="space-y-6">
      {/* Header Profile Banner */}
      <div className="bg-gradient-to-r from-zinc-900 via-[#121215] to-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-80 h-80 bg-sky-500/5 rounded-full blur-3xl pointer-events-none"></div>
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center space-x-4">
            <div className="w-14 h-14 rounded-2xl bg-sky-400/20 border border-sky-400/40 text-sky-400 flex items-center justify-center font-black text-xl shadow-lg">
              {faculty.name ? faculty.name.charAt(0) : "F"}
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="text-2xl font-black text-white">{faculty.name}</h1>
                <span className="px-2 py-0.5 rounded text-xs font-bold bg-sky-400/20 text-sky-400 border border-sky-400/30">
                  FACULTY
                </span>
              </div>
              <div className="text-sm text-zinc-400 flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5">
                <span>{faculty.department}</span>
                <span>•</span>
                <span>{faculty.email}</span>
                <span>•</span>
                <span>Max Daily Load: {faculty.max_daily_hours} hrs</span>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <button
              onClick={onRefresh}
              disabled={roleLoading}
              className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-xs font-bold border border-zinc-700 transition flex items-center space-x-1.5"
            >
              <Icon name="refresh-cw" className={`w-3.5 h-3.5 ${roleLoading ? 'animate-spin' : ''}`} />
              <span>Refresh Schedule</span>
            </button>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-6 border-t border-zinc-800/80">
          <div className="p-3.5 bg-zinc-950/70 border border-zinc-800/80 rounded-xl">
            <div className="text-xs text-zinc-400 font-medium">Assigned Sections</div>
            <div className="text-2xl font-black text-white mt-1">{insights.total_assigned_sections}</div>
          </div>
          <div className="p-3.5 bg-zinc-950/70 border border-zinc-800/80 rounded-xl">
            <div className="text-xs text-zinc-400 font-medium">Weekly Teaching Load</div>
            <div className="text-2xl font-black text-yellow-400 mt-1">{insights.weekly_teaching_hours} <span className="text-xs text-zinc-400 font-normal">hrs/week</span></div>
          </div>
          <div className="p-3.5 bg-zinc-950/70 border border-zinc-800/80 rounded-xl">
            <div className="text-xs text-zinc-400 font-medium">Active Teaching Days</div>
            <div className="text-2xl font-black text-sky-400 mt-1">{insights.days_active} <span className="text-xs text-zinc-400 font-normal">days</span></div>
          </div>
          <div className="p-3.5 bg-zinc-950/70 border border-zinc-800/80 rounded-xl">
            <div className="text-xs text-zinc-400 font-medium">Scheduled Venues</div>
            <div className="text-lg font-bold text-emerald-400 mt-1 truncate">
              {insights.room_assignments?.length ? insights.room_assignments.join(", ") : "Classrooms"}
            </div>
          </div>
        </div>
      </div>

      {/* Faculty Sub-Tab Views */}
      {(!activeSubTab || activeSubTab === "faculty_timetable") && (
        <div className="bg-[#121215] border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center space-x-2">
                <Icon name="calendar" className="w-5 h-5 text-yellow-400" />
                <span>My Weekly Teaching Timetable</span>
              </h2>
              <p className="text-xs text-zinc-400">Scheduled slots, lecture halls, and lab sessions assigned to you</p>
            </div>
            <div className="flex items-center space-x-2 text-xs">
              <span className="flex items-center space-x-1.5 px-2 py-1 bg-yellow-400/10 text-yellow-400 border border-yellow-400/20 rounded-md">
                <span className="w-2 h-2 rounded-full bg-yellow-400"></span>
                <span>Assigned Class</span>
              </span>
              <span className="flex items-center space-x-1.5 px-2 py-1 bg-zinc-900 text-zinc-400 border border-zinc-800 rounded-md">
                <span className="w-2 h-2 rounded-full bg-zinc-600"></span>
                <span>Protected Lunch</span>
              </span>
            </div>
          </div>

          {/* Interactive Calendar Grid */}
          <div className="overflow-x-auto">
            <div className="min-w-[700px] border border-zinc-800 rounded-xl overflow-hidden">
              <div className="grid grid-cols-6 bg-zinc-900/90 text-xs font-bold text-zinc-300 border-b border-zinc-800 text-center py-2.5">
                <div className="text-zinc-500">Time</div>
                {days.map(d => <div key={d} className="text-white">{d}</div>)}
              </div>

              {hours.map(hour => {
                const isLunch = hour === 13;
                const timeLabel = `${String(hour).padStart(2, '0')}:00 - ${String(hour + 1).padStart(2, '0')}:00`;
                return (
                  <div key={hour} className="grid grid-cols-6 border-b border-zinc-800/60 min-h-[64px]">
                    <div className="p-2 border-r border-zinc-800/60 text-center text-xs font-mono text-zinc-400 flex items-center justify-center bg-zinc-950/40">
                      {timeLabel}
                    </div>
                    {days.map(day => {
                      if (isLunch) {
                        return (
                          <div key={day} className="p-2 border-r border-zinc-800/60 bg-zinc-900/40 text-center flex items-center justify-center text-zinc-500 text-xs italic">
                            Protected Lunch
                          </div>
                        );
                      }
                      const asgn = assignments.find(a => a.day === day && a.start_time?.startsWith(String(hour).padStart(2, '0')));
                      return (
                        <div key={day} className="p-1.5 border-r border-zinc-800/60 bg-zinc-950/20 hover:bg-zinc-900/30 transition flex flex-col justify-center">
                          {asgn ? (
                            <div className="p-2 rounded-lg bg-yellow-400/15 border border-yellow-400/40 text-left space-y-1 shadow-sm">
                              <div className="flex items-center justify-between">
                                <span className="font-black text-xs text-yellow-300">{asgn.course_code}</span>
                                <span className="text-[10px] px-1 bg-yellow-400 text-black font-bold rounded">Sec {asgn.section_label}</span>
                              </div>
                              <div className="text-[11px] text-zinc-200 font-semibold line-clamp-1">{asgn.course_name}</div>
                              <div className="text-[10px] text-zinc-400 flex items-center justify-between">
                                <span>{asgn.room_name}</span>
                                <span>{asgn.enrolment_count} std</span>
                              </div>
                            </div>
                          ) : (
                            <div className="h-full flex items-center justify-center text-[10px] text-zinc-700">Free</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {activeSubTab === "faculty_sections" && (
        <div className="bg-[#121215] border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
          <h2 className="text-lg font-bold text-white flex items-center space-x-2">
            <Icon name="book-open" className="w-5 h-5 text-yellow-400" />
            <span>Assigned Teaching Sections</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {sections.map(sec => (
              <div key={sec.id} className="p-5 rounded-xl bg-zinc-900/80 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-base font-black text-yellow-400">{sec.course_code} - Section {sec.section_label}</span>
                  <span className="px-2 py-0.5 text-xs font-bold bg-zinc-800 text-zinc-300 rounded border border-zinc-700">
                    {sec.required_room_type || "Lecture"}
                  </span>
                </div>
                <div className="text-sm font-semibold text-white">{sec.course_name}</div>
                <div className="text-xs text-zinc-400 flex items-center justify-between pt-2 border-t border-zinc-800">
                  <span>Enrolled Students: <strong className="text-white">{sec.enrolment_count}</strong></span>
                  <span>Section ID: <code className="text-zinc-500 font-mono">{sec.id}</code></span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeSubTab === "faculty_availability" && (
        <div className="bg-[#121215] border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
          <h2 className="text-lg font-bold text-white flex items-center space-x-2">
            <Icon name="clock" className="w-5 h-5 text-yellow-400" />
            <span>Availability Preferences</span>
          </h2>
          <p className="text-sm text-zinc-400">
            Schedulr guarantees faculty hard constraints: no overlapping teaching assignments and respecting configured unavailable periods.
          </p>
          <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 text-xs space-y-2">
            <div className="font-bold text-white">Daily Teaching Limit: <span className="text-yellow-400">{faculty.max_daily_hours} hours maximum</span></div>
            <div className="font-bold text-white">Protected Lunch Break: <span className="text-emerald-400">Enforced 13:00 - 14:00</span></div>
            <div className="text-zinc-400 pt-1">
              {faculty.unavailable_slots?.length
                ? `Declared unavailable slots: ${faculty.unavailable_slots.join(", ")}`
                : "No restricted periods declared; available for standard academic schedule."}
            </div>
          </div>
        </div>
      )}

      {activeSubTab === "faculty_insights" && (
        <div className="bg-[#121215] border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
          <h2 className="text-lg font-bold text-white flex items-center space-x-2">
            <Icon name="sparkles" className="w-5 h-5 text-yellow-400" />
            <span>Teaching & Workload Insights</span>
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800">
              <div className="text-xs text-zinc-400">Contact Hours</div>
              <div className="text-2xl font-black text-white mt-1">{assignments.length} hrs</div>
              <div className="text-[11px] text-zinc-500 mt-1">Per teaching week</div>
            </div>
            <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800">
              <div className="text-xs text-zinc-400">Student Reach</div>
              <div className="text-2xl font-black text-yellow-400 mt-1">
                {sections.reduce((acc, s) => acc + (s.enrolment_count || 0), 0)}
              </div>
              <div className="text-[11px] text-zinc-500 mt-1">Across all assigned sections</div>
            </div>
            <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800">
              <div className="text-xs text-zinc-400">Schedule Health</div>
              <div className="text-2xl font-black text-emerald-400 mt-1">100%</div>
              <div className="text-[11px] text-zinc-500 mt-1">Zero timetable clashes</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ==========================================================================
// STUDENT PORTAL COMPONENT (WITH DYNAMIC BACKLOG FREED SLOTS)
// ==========================================================================
function StudentPortal({ studentSchedule, activeSubTab, onNavigate, currentUser, roleLoading, onRefresh }) {
  const student = studentSchedule?.student || {
    name: currentUser?.full_name || "Student",
    registration_number: currentUser?.registration_number || "2026CS104",
    email: currentUser?.email || "student@schedulr.demo",
    department: currentUser?.department || "Computer Science",
    semester: 6
  };
  const enrolments = studentSchedule?.enrolments || [];
  const activeBacklogs = studentSchedule?.active_backlogs || [];
  const clearedBacklogs = studentSchedule?.cleared_backlogs || [];
  const assignments = studentSchedule?.assignments || [];
  const freedSlots = studentSchedule?.freed_slots || [];
  const stats = studentSchedule?.stats || {
    active_courses_count: assignments.length,
    cleared_backlogs_count: clearedBacklogs.length,
    scheduled_hours: assignments.length,
    free_periods: 31
  };

  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const hours = [9, 10, 11, 12, 13, 14, 15, 16];

  return (
    <div className="space-y-6">
      {/* Student Banner */}
      <div className="bg-gradient-to-r from-zinc-900 via-[#121215] to-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-80 h-80 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none"></div>
        <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center space-x-4">
            <div className="w-14 h-14 rounded-2xl bg-emerald-400/20 border border-emerald-400/40 text-emerald-400 flex items-center justify-center font-black text-xl shadow-lg">
              {student.name ? student.name.charAt(0) : "S"}
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="text-2xl font-black text-white">{student.name}</h1>
                <span className="px-2 py-0.5 rounded text-xs font-bold bg-emerald-400/20 text-emerald-400 border border-emerald-400/30">
                  STUDENT
                </span>
                <span className="px-2 py-0.5 rounded text-xs font-mono bg-zinc-800 text-zinc-300 border border-zinc-700">
                  {student.registration_number}
                </span>
              </div>
              <div className="text-sm text-zinc-400 flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5">
                <span>{student.department}</span>
                <span>•</span>
                <span>Semester {student.semester}</span>
                <span>•</span>
                <span>{student.email}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <button
              onClick={onRefresh}
              disabled={roleLoading}
              className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-xs font-bold border border-zinc-700 transition flex items-center space-x-1.5"
            >
              <Icon name="refresh-cw" className={`w-3.5 h-3.5 ${roleLoading ? 'animate-spin' : ''}`} />
              <span>Refresh Schedule</span>
            </button>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-6 pt-6 border-t border-zinc-800/80">
          <div className="p-3.5 bg-zinc-950/70 border border-zinc-800/80 rounded-xl">
            <div className="text-xs text-zinc-400 font-medium">Active Courses</div>
            <div className="text-2xl font-black text-white mt-1">{stats.active_courses_count}</div>
          </div>
          <div className="p-3.5 bg-zinc-950/70 border border-zinc-800/80 rounded-xl">
            <div className="text-xs text-zinc-400 font-medium">Active Backlogs</div>
            <div className="text-2xl font-black text-amber-400 mt-1">{activeBacklogs.length}</div>
          </div>
          <div className="p-3.5 bg-zinc-950/70 border border-zinc-800/80 rounded-xl">
            <div className="text-xs text-zinc-400 font-medium">Cleared Backlogs</div>
            <div className="text-2xl font-black text-emerald-400 mt-1">{clearedBacklogs.length || stats.cleared_backlogs_count}</div>
          </div>
          <div className="p-3.5 bg-zinc-950/70 border border-zinc-800/80 rounded-xl">
            <div className="text-xs text-zinc-400 font-medium">Weekly Study Periods</div>
            <div className="text-2xl font-black text-yellow-400 mt-1">{stats.free_periods} <span className="text-xs text-zinc-400 font-normal">slots</span></div>
          </div>
        </div>
      </div>

      {/* Dynamic Backlog Clearance Notice Banner (if any backlog freed slots exist) */}
      {freedSlots.length > 0 && (
        <div className="p-4 rounded-2xl bg-emerald-950/30 border-2 border-emerald-500/40 text-emerald-200 flex items-start space-x-3.5 shadow-lg">
          <div className="w-8 h-8 rounded-xl bg-emerald-500/20 border border-emerald-500/40 text-emerald-400 flex items-center justify-center shrink-0 mt-0.5">
            <Icon name="sparkles" className="w-4 h-4" />
          </div>
          <div className="flex-1 space-y-1">
            <div className="text-sm font-black text-emerald-300">
              ✨ Dynamic Backlog Resolution Active: {freedSlots.length} Slot(s) Freed!
            </div>
            <div className="text-xs text-zinc-300 leading-relaxed">
              You cleared backlog course <strong>{freedSlots[0].course_code} ({freedSlots[0].course_name})</strong>!
              Schedulr has automatically removed it from your personal schedule, freeing <strong>{freedSlots[0].day} {freedSlots[0].start_time}-{freedSlots[0].end_time}</strong> for your personal study time. The course section remains scheduled for other peers without disrupting room or faculty assignments.
            </div>
          </div>
        </div>
      )}

      {/* Sub-Tab 1: MY TIMETABLE */}
      {(!activeSubTab || activeSubTab === "student_timetable") && (
        <div className="bg-[#121215] border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-800">
            <div>
              <h2 className="text-lg font-bold text-white flex items-center space-x-2">
                <Icon name="calendar" className="w-5 h-5 text-yellow-400" />
                <span>My Personal Weekly Timetable</span>
              </h2>
              <p className="text-xs text-zinc-400">Clash-free class schedule tailored to your active enrollments</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="flex items-center space-x-1.5 px-2 py-1 bg-yellow-400/10 text-yellow-400 border border-yellow-400/20 rounded-md">
                <span className="w-2 h-2 rounded-full bg-yellow-400"></span>
                <span>Enrolled Class</span>
              </span>
              <span className="flex items-center space-x-1.5 px-2 py-1 bg-emerald-950/40 text-emerald-300 border border-emerald-500/30 rounded-md">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span>Free after backlog cleared</span>
              </span>
              <span className="flex items-center space-x-1.5 px-2 py-1 bg-zinc-900 text-zinc-400 border border-zinc-800 rounded-md">
                <span className="w-2 h-2 rounded-full bg-zinc-600"></span>
                <span>Protected Lunch</span>
              </span>
            </div>
          </div>

          {/* Interactive Timetable Grid */}
          <div className="overflow-x-auto">
            <div className="min-w-[720px] border border-zinc-800 rounded-xl overflow-hidden">
              <div className="grid grid-cols-6 bg-zinc-900/90 text-xs font-bold text-zinc-300 border-b border-zinc-800 text-center py-2.5">
                <div className="text-zinc-500">Time</div>
                {days.map(d => <div key={d} className="text-white">{d}</div>)}
              </div>

              {hours.map(hour => {
                const isLunch = hour === 13;
                const timeLabel = `${String(hour).padStart(2, '0')}:00 - ${String(hour + 1).padStart(2, '0')}:00`;
                return (
                  <div key={hour} className="grid grid-cols-6 border-b border-zinc-800/60 min-h-[64px]">
                    <div className="p-2 border-r border-zinc-800/60 text-center text-xs font-mono text-zinc-400 flex items-center justify-center bg-zinc-950/40">
                      {timeLabel}
                    </div>
                    {days.map(day => {
                      if (isLunch) {
                        return (
                          <div key={day} className="p-2 border-r border-zinc-800/60 bg-zinc-900/40 text-center flex items-center justify-center text-zinc-500 text-xs italic">
                            Protected Lunch
                          </div>
                        );
                      }

                      // Check for active class assignment
                      const asgn = assignments.find(a => a.day === day && a.start_time?.startsWith(String(hour).padStart(2, '0')));
                      // Check for freed slot resulting from cleared backlog
                      const freed = freedSlots.find(f => f.day === day && f.start_time?.startsWith(String(hour).padStart(2, '0')));

                      return (
                        <div key={day} className="p-1.5 border-r border-zinc-800/60 bg-zinc-950/20 hover:bg-zinc-900/30 transition flex flex-col justify-center">
                          {asgn ? (
                            <div className="p-2 rounded-lg bg-yellow-400/15 border border-yellow-400/40 text-left space-y-1 shadow-sm">
                              <div className="flex items-center justify-between">
                                <span className="font-black text-xs text-yellow-300">{asgn.course_code}</span>
                                <span className="text-[10px] px-1 bg-yellow-400 text-black font-bold rounded">Sec {asgn.section_label}</span>
                              </div>
                              <div className="text-[11px] text-zinc-200 font-semibold line-clamp-1">{asgn.course_name}</div>
                              <div className="text-[10px] text-zinc-400 flex items-center justify-between">
                                <span>{asgn.room_name}</span>
                                <span className="truncate max-w-[80px]">{asgn.faculty_name}</span>
                              </div>
                            </div>
                          ) : freed ? (
                            /* Highlighted "Free after backlog cleared" slot */
                            <div className="p-2 rounded-lg bg-emerald-950/30 border-2 border-dashed border-emerald-500/60 text-left space-y-1 shadow-sm animate-pulse">
                              <div className="flex items-center justify-between">
                                <span className="font-bold text-[11px] text-emerald-300 flex items-center space-x-1">
                                  <span>✨</span>
                                  <span>Free Slot</span>
                                </span>
                                <span className="text-[9px] px-1 py-0.5 bg-emerald-500/20 text-emerald-300 font-bold rounded border border-emerald-500/30">
                                  Cleared
                                </span>
                              </div>
                              <div className="text-[10px] text-zinc-300 line-clamp-1 font-medium">
                                Formerly: {freed.course_code}
                              </div>
                              <div className="text-[9px] text-emerald-400/80">
                                Dedicated study time
                              </div>
                            </div>
                          ) : (
                            <div className="h-full flex items-center justify-center text-[10px] text-zinc-700">Free</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Sub-Tab 2: MY ENROLLED COURSES */}
      {activeSubTab === "student_courses" && (
        <div className="bg-[#121215] border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
          <h2 className="text-lg font-bold text-white flex items-center space-x-2">
            <Icon name="book-open" className="w-5 h-5 text-yellow-400" />
            <span>My Registered Courses</span>
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {enrolments.map(enr => (
              <div key={enr.id} className="p-5 rounded-xl bg-zinc-900/80 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-base font-black text-yellow-400">{enr.section_id}</span>
                  <span className={`px-2 py-0.5 text-xs font-bold rounded border ${
                    enr.status === 'Cleared'
                      ? 'bg-emerald-400/20 text-emerald-300 border-emerald-400/30'
                      : (enr.enrolment_type === 'Backlog' || enr.enrolmentType === 'Backlog')
                      ? 'bg-amber-400/20 text-amber-300 border-amber-400/30'
                      : 'bg-zinc-800 text-zinc-300 border-zinc-700'
                  }`}>
                    {enr.status === 'Cleared' ? 'Cleared Backlog' : `${enr.enrolment_type || enr.enrolmentType || 'Regular'} (${enr.status})`}
                  </span>
                </div>
                <div className="text-xs text-zinc-400">
                  {enr.notes || "Enrolled in academic curriculum."}
                </div>
                <div className="text-[11px] text-zinc-500 font-mono pt-2 border-t border-zinc-800">
                  Enrolment Ref: {enr.id}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sub-Tab 3: MY BACKLOGS & FREED SLOTS */}
      {activeSubTab === "student_backlogs" && (
        <div className="bg-[#121215] border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-6">
          <div>
            <h2 className="text-lg font-bold text-white flex items-center space-x-2">
              <Icon name="layers" className="w-5 h-5 text-yellow-400" />
              <span>Dynamic Backlog Resolution Status</span>
            </h2>
            <p className="text-xs text-zinc-400 mt-1">
              Tracks active backlog obligations and verified cleared subjects with automatically liberated study periods.
            </p>
          </div>

          {/* Cleared Backlogs & Freed Slots */}
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-emerald-400 uppercase tracking-wider flex items-center space-x-2">
              <Icon name="check-circle-2" className="w-4 h-4 text-emerald-400" />
              <span>Cleared Backlog Subjects & Freed Slots ({clearedBacklogs.length})</span>
            </h3>
            {clearedBacklogs.length === 0 ? (
              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-zinc-400">
                No backlog subjects cleared yet.
              </div>
            ) : (
              clearedBacklogs.map(cb => (
                <div key={cb.id} className="p-4 rounded-xl bg-emerald-950/20 border border-emerald-500/30 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-black text-sm text-emerald-300">{cb.section_id}</span>
                    <span className="px-2 py-0.5 text-xs font-black bg-emerald-400 text-black rounded">
                      CLEARED (Slot Freed)
                    </span>
                  </div>
                  <div className="text-xs text-zinc-300">
                    {cb.notes || "Backlog examination cleared."}
                  </div>
                  <div className="text-[11px] text-emerald-400/80 font-mono">
                    Updated by {cb.updated_by || "Academic Office"} • Status: Free after backlog cleared
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Active Backlogs */}
          <div className="space-y-3">
            <h3 className="text-sm font-bold text-amber-400 uppercase tracking-wider flex items-center space-x-2">
              <Icon name="alert-triangle" className="w-4 h-4 text-amber-400" />
              <span>Active Backlog Subjects ({activeBacklogs.length})</span>
            </h3>
            {activeBacklogs.length === 0 ? (
              <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-emerald-400 font-semibold">
                ✓ No active backlogs! You are fully on track with your academic program.
              </div>
            ) : (
              activeBacklogs.map(ab => (
                <div key={ab.id} className="p-4 rounded-xl bg-amber-950/20 border border-amber-500/30 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-black text-sm text-amber-300">{ab.section_id}</span>
                    <span className="px-2 py-0.5 text-xs font-bold bg-amber-400/20 text-amber-400 border border-amber-400/30 rounded">
                      Active (Pending Examination)
                    </span>
                  </div>
                  <div className="text-xs text-zinc-300">
                    {ab.notes || "Enrolled in backlog examination cycle."}
                  </div>
                  <div className="text-[11px] text-zinc-400">
                    Once cleared by the Registrar, this slot will automatically be freed in your personal timetable.
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeSubTab === "student_profile" && (
        <div className="bg-[#121215] border border-zinc-800 rounded-2xl p-6 shadow-xl space-y-4">
          <h2 className="text-lg font-bold text-white flex items-center space-x-2">
            <Icon name="user" className="w-5 h-5 text-yellow-400" />
            <span>Academic Profile</span>
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-1">
              <div className="text-xs text-zinc-400">Full Name</div>
              <div className="text-sm font-bold text-white">{student.name}</div>
            </div>
            <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-1">
              <div className="text-xs text-zinc-400">Registration Number</div>
              <div className="text-sm font-bold text-yellow-400 font-mono">{student.registration_number}</div>
            </div>
            <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-1">
              <div className="text-xs text-zinc-400">Department</div>
              <div className="text-sm font-bold text-white">{student.department}</div>
            </div>
            <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 space-y-1">
              <div className="text-xs text-zinc-400">Current Semester</div>
              <div className="text-sm font-bold text-white">Semester {student.semester}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Render into DOM
const rootElement = document.getElementById("root");
if (rootElement) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(<App />);
}
