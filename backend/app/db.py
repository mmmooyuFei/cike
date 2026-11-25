from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings

connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, pool_pre_ping=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from . import models  # noqa: F401

    Base.metadata.create_all(engine)
    _ensure_session_columns()


def _ensure_session_columns() -> None:
    """Add OIDC lifecycle columns to an existing sessions table."""
    inspector = inspect(engine)
    if "sessions" not in inspector.get_table_names():
        return
    existing = {column["name"] for column in inspector.get_columns("sessions")}
    additions = {
        "idp_refresh_token": "ALTER TABLE sessions ADD COLUMN idp_refresh_token TEXT",
        "idp_token_expires_at": "ALTER TABLE sessions ADD COLUMN idp_token_expires_at TIMESTAMP",
        "idp_checked_at": "ALTER TABLE sessions ADD COLUMN idp_checked_at TIMESTAMP",
    }
    with engine.begin() as connection:
        for name, statement in additions.items():
            if name not in existing:
                connection.execute(text(statement))
