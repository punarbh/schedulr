import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Generator
from sqlalchemy import create_engine, Column, String, Boolean, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker, Session

logger = logging.getLogger("schedulr.database")

# Database URL resolution:
# - Uses PostgreSQL when DATABASE_URL is configured (e.g. Render production)
# - Automatically adapts legacy "postgres://" schemes to "postgresql://" for SQLAlchemy compatibility
# - Falls back to local SQLite database when DATABASE_URL is not set
RAW_DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

if RAW_DATABASE_URL:
    if RAW_DATABASE_URL.startswith("postgres://"):
        DATABASE_URL = RAW_DATABASE_URL.replace("postgres://", "postgresql://", 1)
    else:
        DATABASE_URL = RAW_DATABASE_URL
    logger.info("Using PostgreSQL database from DATABASE_URL environment variable.")
    engine = create_engine(DATABASE_URL, pool_pre_ping=True)
else:
    DB_FILE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "schedulr.db"))
    DATABASE_URL = f"sqlite:///{DB_FILE}"
    logger.info(f"DATABASE_URL not set; using local development SQLite database: {DATABASE_URL}")
    engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class User(Base):
    """Persistent user model for authentication and role-based access control."""
    __tablename__ = "users"

    id = Column(String(64), primary_key=True, default=lambda: f"usr_{uuid.uuid4().hex[:12]}")
    full_name = Column(String(128), nullable=False)
    registration_number = Column(String(64), nullable=True, index=True)
    email = Column(String(255), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    role = Column(String(32), nullable=False)  # Must be "ADMIN", "FACULTY", or "STUDENT"
    department = Column(String(128), nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    last_login_at = Column(DateTime, nullable=True)

    def to_safe_dict(self):
        """Return user fields excluding sensitive authentication secrets."""
        return {
            "id": self.id,
            "full_name": self.full_name,
            "registration_number": self.registration_number,
            "email": self.email,
            "role": self.role,
            "department": self.department,
            "is_active": self.is_active,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "last_login_at": self.last_login_at.isoformat() if self.last_login_at else None,
        }

def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency yielding database session with automatic closure."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def init_db():
    """Create all required tables and seed demo accounts if missing."""
    Base.metadata.create_all(bind=engine)
    logger.info("Database schema initialized.")
