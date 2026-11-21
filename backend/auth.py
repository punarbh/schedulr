import os
import secrets
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, List, Callable
import bcrypt

# Compatibility patch for bcrypt 4.0+/5.0+ with passlib
if not hasattr(bcrypt, "__about__"):
    class About:
        __version__ = getattr(bcrypt, "__version__", "5.0.0")
    bcrypt.__about__ = About()

orig_hashpw = bcrypt.hashpw
def safe_hashpw(password, salt):
    if len(password) > 72:
        password = password[:72]
    return orig_hashpw(password, salt)
bcrypt.hashpw = safe_hashpw

orig_checkpw = bcrypt.checkpw
def safe_checkpw(password, hashed_password):
    if len(password) > 72:
        password = password[:72]
    return orig_checkpw(password, hashed_password)
bcrypt.checkpw = safe_checkpw

from passlib.context import CryptContext
from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status, Header
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from .database import User, get_db

logger = logging.getLogger("schedulr.auth")

# JWT Environment Configuration
ENV_JWT_SECRET = os.environ.get("JWT_SECRET", "").strip()
if not ENV_JWT_SECRET:
    # Ephemeral dev-only secret if not provided
    logger.warning("SECURITY WARNING: 'JWT_SECRET' environment variable is not configured. Generating temporary dev secret. For production on Render, set a strong 'JWT_SECRET'.")
    JWT_SECRET = secrets.token_urlsafe(32)
else:
    JWT_SECRET = ENV_JWT_SECRET

JWT_ALGORITHM = os.environ.get("JWT_ALGORITHM", "HS256").strip()
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.environ.get("ACCESS_TOKEN_EXPIRE_MINUTES", "480"))

# Password Hashing via passlib[bcrypt]
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Bearer Token Scheme (auto_error=False allows unified header extraction)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)

import re

EMAIL_REGEX = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

def is_valid_email(email: str) -> bool:
    """Validate email format without requiring external email-validator library."""
    return bool(email and EMAIL_REGEX.match(email.strip()))

# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------
class SignupRequest(BaseModel):
    full_name: str = Field(..., min_length=2, max_length=128)
    registration_number: Optional[str] = Field(None, max_length=64)
    department: Optional[str] = Field("Computer Science", max_length=128)
    email: str = Field(..., min_length=5, max_length=255)
    password: str = Field(..., min_length=8, max_length=128)
    confirm_password: str = Field(..., min_length=8, max_length=128)

class LoginRequest(BaseModel):
    email: str = Field(..., min_length=3, max_length=255)
    password: str = Field(..., min_length=1)

class UserResponse(BaseModel):
    id: str
    full_name: str
    registration_number: Optional[str] = None
    email: str
    role: str
    department: Optional[str] = None
    is_active: bool
    created_at: Optional[str] = None
    last_login_at: Optional[str] = None

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserResponse

# ---------------------------------------------------------------------------
# Core Crypto Functions
# ---------------------------------------------------------------------------
def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify raw password against bcrypt hash."""
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except Exception as e:
        logger.error(f"Password verification error: {e}")
        return False

def get_password_hash(password: str) -> str:
    """Compute bcrypt hash of raw password."""
    return pwd_context.hash(password)

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Generate signed JWT access token containing user claims."""
    to_encode = data.copy()
    now_utc = datetime.now(timezone.utc)
    if expires_delta:
        expire = now_utc + expires_delta
    else:
        expire = now_utc + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire, "iat": now_utc})
    encoded_jwt = jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return encoded_jwt

def decode_access_token(token: str) -> dict:
    """Decode and validate claims in signed JWT token."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except JWTError as e:
        logger.warning(f"JWT decode failure: {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials: token is invalid or expired",
            headers={"WWW-Authenticate": "Bearer"},
        )

# ---------------------------------------------------------------------------
# FastAPI Dependency Injection
# ---------------------------------------------------------------------------
async def get_current_user(
    token: Optional[str] = Depends(oauth2_scheme),
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db)
) -> User:
    """Retrieve and validate current authenticated user from Bearer token."""
    resolved_token = token
    if not resolved_token and authorization:
        parts = authorization.split()
        if len(parts) == 2 and parts[0].lower() == "bearer":
            resolved_token = parts[1]

    if not resolved_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication credentials were not provided. Please log in.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    payload = decode_access_token(resolved_token)
    user_id: Optional[str] = payload.get("sub")
    if user_id is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload: missing subject identifier",
            headers={"WWW-Authenticate": "Bearer"},
        )

    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        # Also attempt lookup by email if sub was email
        user = db.query(User).filter(User.email == user_id).first()

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authenticated user no longer exists",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not user.is_active:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Inactive user account. Contact administrator.",
        )

    return user

def require_roles(*allowed_roles: str) -> Callable:
    """Role-Based Access Control dependency factory enforcing user roles."""
    async def role_checker(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role not in allowed_roles:
            logger.warning(
                f"Unauthorized access attempt by {current_user.email} (Role: {current_user.role}) "
                f"to resource requiring {allowed_roles}"
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Access forbidden: requires one of {allowed_roles} role, current role is '{current_user.role}'",
            )
        return current_user
    return role_checker

# Role-specific dependency shortcuts
require_admin = require_roles("ADMIN")
require_faculty = require_roles("FACULTY", "ADMIN")
require_student = require_roles("STUDENT", "ADMIN")

# ---------------------------------------------------------------------------
# Synthetic Hackathon Demo Accounts Seeding
# ---------------------------------------------------------------------------
def seed_default_users(db: Session):
    """Seed synthetic hackathon accounts when not already present in the database."""
    demo_accounts = [
        {
            "id": "usr_demo_admin",
            "full_name": "System Administrator",
            "registration_number": "ADMIN-001",
            "email": "admin@schedulr.demo",
            "password": "Schedulr2026!",
            "role": "ADMIN",
            "department": "Academic Administration"
        },
        {
            "id": "usr_demo_faculty",
            "full_name": "Dr. Alan Turing",
            "registration_number": "FAC-TURING",
            "email": "faculty@schedulr.demo",
            "password": "Faculty2026!",
            "role": "FACULTY",
            "department": "Computer Science"
        },
        {
            "id": "usr_demo_student",
            "full_name": "Alex Vance",
            "registration_number": "2026CS104",
            "email": "student@schedulr.demo",
            "password": "Student2026!",
            "role": "STUDENT",
            "department": "Computer Science"
        }
    ]

    for acc in demo_accounts:
        existing = db.query(User).filter(User.email == acc["email"]).first()
        if not existing:
            hashed = get_password_hash(acc["password"])
            user = User(
                id=acc["id"],
                full_name=acc["full_name"],
                registration_number=acc["registration_number"],
                email=acc["email"],
                password_hash=hashed,
                role=acc["role"],
                department=acc["department"],
                is_active=True
            )
            db.add(user)
            logger.info(f"Seeded demo account: {acc['email']} ({acc['role']})")
    db.commit()
