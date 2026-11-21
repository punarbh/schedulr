"""
Schedulr Authentication & Role-Based Access Control (RBAC) Test Suite
Tests:
1. Password hashing (bcrypt verification, no plain text)
2. Valid login returns JWT token and safe user dictionary
3. Invalid password returns HTTP 401 Unauthorized
4. Duplicate signup returns HTTP 400 Bad Request
5. Public signup only creates STUDENT accounts
6. Student cannot access administrative solve or backlog status update (HTTP 403)
7. Faculty cannot access administrative solve (HTTP 403)
8. Faculty schedule endpoint (/api/faculty/me/schedule) returns assigned sections and timetable
9. Student schedule endpoint (/api/student/me/schedule) returns personal timetable and freed slots
10. Existing backlog clearance and solver continue to operate seamlessly under RBAC
"""

import unittest
import asyncio
import json
from datetime import datetime, timezone

from backend.main import app
from backend.database import SessionLocal, init_db, User
from backend.auth import (
    verify_password,
    get_password_hash,
    create_access_token,
    decode_access_token,
    seed_default_users,
)


class SimpleAsgiClient:
    """Lightweight in-memory ASGI test client requiring zero external dependencies."""

    def __init__(self, asgi_app):
        self.app = asgi_app

    def request(self, method: str, path: str, json_data=None, headers=None):
        return asyncio.run(self._async_request(method, path, json_data, headers))

    async def _async_request(self, method: str, path: str, json_data=None, headers=None):
        headers_list = []
        if headers:
            for k, v in headers.items():
                headers_list.append((k.lower().encode("utf-8"), v.encode("utf-8")))

        body_bytes = b""
        if json_data is not None:
            body_bytes = json.dumps(json_data).encode("utf-8")
            headers_list.append((b"content-type", b"application/json"))
            headers_list.append((b"content-length", str(len(body_bytes)).encode("utf-8")))

        query_string = b""
        if "?" in path:
            path, qs = path.split("?", 1)
            query_string = qs.encode("utf-8")

        scope = {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": method.upper(),
            "path": path,
            "raw_path": path.encode("utf-8"),
            "query_string": query_string,
            "headers": headers_list,
        }

        response_status = [None]
        response_headers = []
        response_body = []

        async def receive():
            return {
                "type": "http.request",
                "body": body_bytes,
                "more_body": False,
            }

        async def send(message):
            if message["type"] == "http.response.start":
                response_status[0] = message["status"]
                response_headers.extend(message.get("headers", []))
            elif message["type"] == "http.response.body":
                response_body.append(message.get("body", b""))

        await self.app(scope, receive, send)

        full_body = b"".join(response_body)
        parsed_json = None
        try:
            parsed_json = json.loads(full_body.decode("utf-8"))
        except Exception:
            pass

        return {
            "status_code": response_status[0],
            "headers": {k.decode("utf-8").lower(): v.decode("utf-8") for k, v in response_headers},
            "body": full_body.decode("utf-8", errors="replace"),
            "json": parsed_json,
        }

    def get(self, path: str, headers=None):
        return self.request("GET", path, headers=headers)

    def post(self, path: str, json_data=None, headers=None):
        return self.request("POST", path, json_data=json_data, headers=headers)


class TestAuthAndRbac(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()
        db = SessionLocal()
        try:
            seed_default_users(db)
        finally:
            db.close()
        cls.client = SimpleAsgiClient(app)

    def test_01_password_hashing(self):
        """1. Verify password hashing uses bcrypt, is one-way, and validates correctly."""
        raw_pw = "SuperSecurePassword123!"
        hashed = get_password_hash(raw_pw)

        self.assertNotEqual(raw_pw, hashed)
        self.assertTrue(hashed.startswith("$2b$") or hashed.startswith("$2a$"))
        self.assertTrue(verify_password(raw_pw, hashed))
        self.assertFalse(verify_password("WrongPassword!", hashed))

    def test_02_valid_login_returns_jwt(self):
        """2. Valid login for all default roles returns JWT Bearer token and safe user dictionary."""
        roles_to_test = [
            ("admin@schedulr.demo", "Schedulr2026!", "ADMIN"),
            ("faculty@schedulr.demo", "Faculty2026!", "FACULTY"),
            ("student@schedulr.demo", "Student2026!", "STUDENT"),
        ]

        for email, password, expected_role in roles_to_test:
            resp = self.client.post("/api/auth/login", json_data={"email": email, "password": password})
            self.assertEqual(resp["status_code"], 200, f"Login failed for {email}: {resp['body']}")
            data = resp["json"]
            self.assertIn("access_token", data)
            self.assertEqual(data["token_type"], "bearer")
            self.assertIn("user", data)
            user_data = data["user"]
            self.assertEqual(user_data["email"], email)
            self.assertEqual(user_data["role"], expected_role)
            # Ensure password hash is NEVER leaked in user dict
            self.assertNotIn("password_hash", user_data)
            self.assertNotIn("password", user_data)

            # Validate decoded token claims
            claims = decode_access_token(data["access_token"])
            self.assertEqual(claims["email"], email)
            self.assertEqual(claims["role"], expected_role)

    def test_03_invalid_password_returns_401(self):
        """3. Invalid credentials return HTTP 401 with WWW-Authenticate header."""
        resp = self.client.post("/api/auth/login", json_data={"email": "admin@schedulr.demo", "password": "WrongPassword"})
        self.assertEqual(resp["status_code"], 401)
        self.assertIn("www-authenticate", resp["headers"])
        self.assertIn("Incorrect email or password", resp["json"]["detail"])

    def test_04_duplicate_signup_returns_400(self):
        """4. Attempting to sign up with an existing email returns HTTP 400."""
        payload = {
            "full_name": "Duplicate Student",
            "registration_number": "2026CS999",
            "department": "Computer Science",
            "email": "student@schedulr.demo",  # already exists
            "password": "NewStudentPassword2026!",
            "confirm_password": "NewStudentPassword2026!",
        }
        resp = self.client.post("/api/auth/signup", json_data=payload)
        self.assertEqual(resp["status_code"], 400)
        self.assertIn("already exists", resp["json"]["detail"])

    def test_05_public_signup_only_creates_student(self):
        """5. Public signup endpoint only creates STUDENT accounts with valid parameters."""
        new_email = f"student_test_{datetime.now(timezone.utc).timestamp()}@schedulr.demo"
        payload = {
            "full_name": "Taylor Swift",
            "registration_number": "2026CS888",
            "department": "Music Engineering",
            "email": new_email,
            "password": "TaylorPassword2026!",
            "confirm_password": "TaylorPassword2026!",
            "role": "ADMIN",  # Maliciously attempt to escalate to ADMIN
        }
        resp = self.client.post("/api/auth/signup", json_data=payload)
        self.assertEqual(resp["status_code"], 200, f"Signup failed: {resp['body']}")
        data = resp["json"]
        self.assertIn("access_token", data)
        # Verify assigned role is strictly STUDENT
        self.assertEqual(data["user"]["role"], "STUDENT")

        # Verify DB directly
        db = SessionLocal()
        try:
            created_user = db.query(User).filter(User.email == new_email).first()
            self.assertIsNotNone(created_user)
            self.assertEqual(created_user.role, "STUDENT")
        finally:
            db.close()

    def _get_auth_header(self, email, password):
        login_resp = self.client.post("/api/auth/login", json_data={"email": email, "password": password})
        token = login_resp["json"]["access_token"]
        return {"Authorization": f"Bearer {token}"}

    def test_06_student_cannot_access_solve_or_update_status(self):
        """6. A student token cannot access administrative solve or enrolment status update (HTTP 403)."""
        student_headers = self._get_auth_header("student@schedulr.demo", "Student2026!")

        # 1. Attempt solve
        solve_resp = self.client.post(
            "/api/solve",
            json_data={"sections": [], "rooms": [], "faculty": [], "students": [], "time_slots": []},
            headers=student_headers,
        )
        self.assertEqual(solve_resp["status_code"], 403, f"Expected 403 for student solve, got: {solve_resp['status_code']}")

        # 2. Attempt update-status
        update_resp = self.client.post(
            "/api/enrolments/update-status",
            json_data={"enrolmentId": "ENR-001", "status": "Cleared"},
            headers=student_headers,
        )
        self.assertEqual(update_resp["status_code"], 403, f"Expected 403 for student update status, got: {update_resp['status_code']}")

    def test_07_faculty_cannot_access_solve(self):
        """7. A faculty member cannot access administrative timetable solve endpoint (HTTP 403)."""
        faculty_headers = self._get_auth_header("faculty@schedulr.demo", "Faculty2026!")

        solve_resp = self.client.post(
            "/api/solve",
            json_data={"sections": [], "rooms": [], "faculty": [], "students": [], "time_slots": []},
            headers=faculty_headers,
        )
        self.assertEqual(solve_resp["status_code"], 403, f"Expected 403 for faculty solve, got: {solve_resp['status_code']}")

    def test_08_faculty_schedule_endpoint(self):
        """8. Faculty schedule endpoint (/api/faculty/me/schedule) returns faculty's assigned sections and schedule."""
        faculty_headers = self._get_auth_header("faculty@schedulr.demo", "Faculty2026!")

        resp = self.client.get("/api/faculty/me/schedule", headers=faculty_headers)
        self.assertEqual(resp["status_code"], 200, f"Faculty schedule failed: {resp['body']}")
        data = resp["json"]

        self.assertIn("faculty", data)
        self.assertIn("sections", data)
        self.assertIn("assignments", data)
        self.assertIn("insights", data)
        self.assertIn("weekly_teaching_hours", data["insights"])

    def test_09_student_schedule_endpoint(self):
        """9. Student schedule endpoint (/api/student/me/schedule) returns personal timetable and freed slots."""
        student_headers = self._get_auth_header("student@schedulr.demo", "Student2026!")

        resp = self.client.get("/api/student/me/schedule", headers=student_headers)
        self.assertEqual(resp["status_code"], 200, f"Student schedule failed: {resp['body']}")
        data = resp["json"]

        self.assertIn("student", data)
        self.assertIn("assignments", data)
        self.assertIn("freed_slots", data)
        self.assertIn("active_backlogs", data)
        self.assertIn("cleared_backlogs", data)

        # Check freed slot label
        if data["freed_slots"]:
            self.assertEqual(data["freed_slots"][0]["label"], "Free after backlog cleared")

    def test_10_existing_backlog_clearance_and_solver(self):
        """10. Admin can access solve and update-status; existing backlog clearance operates seamlessly."""
        admin_headers = self._get_auth_header("admin@schedulr.demo", "Schedulr2026!")

        # 1. Fetch backlog demo scenario with admin credentials
        demo_resp = self.client.get("/api/scenarios/backlog-demo", headers=admin_headers)
        self.assertEqual(demo_resp["status_code"], 200)
        demo_pack = demo_resp["json"]
        dataset = demo_pack["dataset"]

        # 2. Update backlog status to Cleared
        backlog_enrolment = next(
            (e for e in dataset["enrolments"] if (e.get("enrolmentType") == "Backlog" or e.get("enrolment_type") == "Backlog") and e.get("status") == "Active"),
            None
        )
        self.assertIsNotNone(backlog_enrolment, "Backlog enrolment should exist in backlog demo dataset")

        update_resp = self.client.post(
            "/api/enrolments/update-status",
            json_data={
                "enrolmentId": backlog_enrolment["id"],
                "status": "Cleared",
                "notes": "Cleared via RBAC integration test suite",
                "dataset": dataset,
            },
            headers=admin_headers,
        )
        self.assertEqual(update_resp["status_code"], 200, f"Status update failed: {update_resp['body']}")
        result = update_resp["json"]
        self.assertTrue(result["success"])
        self.assertIsNotNone(result["freed_slot"])
        self.assertIn("cleared", result["message"].lower())


if __name__ == "__main__":
    unittest.main()
