from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def uid() -> str:
    return uuid.uuid4().hex


def utcnow() -> datetime:
    """Naive UTC: SQLite and PostgreSQL compare consistently."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    idp_issuer: Mapped[str | None] = mapped_column(String(255), index=True)
    idp_sub: Mapped[str | None] = mapped_column(String(255), index=True)
    username: Mapped[str] = mapped_column(String(120), index=True)
    display_name: Mapped[str] = mapped_column(String(120), default="")
    email: Mapped[str | None] = mapped_column(String(255))
    phone: Mapped[str | None] = mapped_column(String(64))
    avatar_url: Mapped[str | None] = mapped_column(String(500))
    gender: Mapped[str | None] = mapped_column(String(16))
    birthday: Mapped[date | None] = mapped_column(Date)
    roles: Mapped[list] = mapped_column(JSON, default=list)
    groups: Mapped[list] = mapped_column(JSON, default=list)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)

    __table_args__ = (
        UniqueConstraint("idp_issuer", "idp_sub", name="uq_user_idp"),
        Index("ix_user_username", "username"),
    )


class AuthSession(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    csrf_hash: Mapped[str] = mapped_column(String(64))
    idp_access_token: Mapped[str | None] = mapped_column(Text)
    idp_owner: Mapped[str | None] = mapped_column(String(120))
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    ip: Mapped[str | None] = mapped_column(String(64))
    user_agent: Mapped[str | None] = mapped_column(String(500))


class OidcState(Base):
    __tablename__ = "oidc_states"

    state: Mapped[str] = mapped_column(String(64), primary_key=True)
    verifier: Mapped[str] = mapped_column(String(128))
    nonce: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class AccessRule(Base):
    __tablename__ = "access_rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    module: Mapped[str] = mapped_column(String(32), index=True)
    subject_type: Mapped[str] = mapped_column(String(16), index=True)
    subject: Mapped[str] = mapped_column(String(160), index=True)
    can_view: Mapped[bool] = mapped_column(Boolean, default=True)
    can_edit: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    __table_args__ = (
        UniqueConstraint("module", "subject_type", "subject", name="uq_access_rule"),
    )


class Todo(Base):
    __tablename__ = "todos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    status: Mapped[str] = mapped_column(String(16), default="todo")
    priority: Mapped[str] = mapped_column(String(8), default="P1")
    category: Mapped[str] = mapped_column(String(32), default="工作")
    due_date: Mapped[date | None] = mapped_column(Date)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    __table_args__ = (Index("ix_todo_user_due", "user_id", "due_date"),)


class Milestone(Base):
    __tablename__ = "milestones"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(300))
    category: Mapped[str] = mapped_column(String(32), default="事业")
    quarter: Mapped[str | None] = mapped_column(String(8))
    target_date: Mapped[date | None] = mapped_column(Date)
    metric: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="进行中")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    next_step: Mapped[str | None] = mapped_column(Text)
    review: Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)


class DailyLog(Base):
    __tablename__ = "daily_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    log_date: Mapped[date] = mapped_column(Date)
    content: Mapped[str | None] = mapped_column(Text)
    tomorrow_plan: Mapped[str | None] = mapped_column(Text)
    blockers: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    __table_args__ = (
        Index(
            "uq_daily_user_date",
            "user_id",
            "log_date",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
    )


class SleepRecord(Base):
    __tablename__ = "sleep_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    record_date: Mapped[date] = mapped_column(Date)
    bed_time: Mapped[str | None] = mapped_column(String(5))
    wake_time: Mapped[str | None] = mapped_column(String(5))
    target_time: Mapped[str | None] = mapped_column(String(5))
    achieved: Mapped[bool] = mapped_column(Boolean, default=False)
    hours: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    __table_args__ = (
        Index(
            "uq_sleep_user_date",
            "user_id",
            "record_date",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
    )


class FocusSession(Base):
    __tablename__ = "focus_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    session_date: Mapped[date] = mapped_column(Date)
    item: Mapped[str] = mapped_column(String(300))
    type: Mapped[str] = mapped_column(String(32), default="深度工作")
    category: Mapped[str | None] = mapped_column(String(32))
    minutes: Mapped[int] = mapped_column(Integer, default=0)
    start_time: Mapped[str | None] = mapped_column(String(5))
    source: Mapped[str | None] = mapped_column(String(200))
    done: Mapped[bool] = mapped_column(Boolean, default=True)
    interruptions: Mapped[int] = mapped_column(Integer, default=0)
    takeaway: Mapped[str | None] = mapped_column(Text)
    action: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    __table_args__ = (Index("ix_focus_user_date", "user_id", "session_date"),)


class Workout(Base):
    __tablename__ = "workouts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    workout_date: Mapped[date] = mapped_column(Date)
    items: Mapped[list] = mapped_column(JSON, default=list)
    minutes: Mapped[int] = mapped_column(Integer, default=0)
    intensity: Mapped[str] = mapped_column(String(8), default="中")
    calories: Mapped[int | None] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    __table_args__ = (Index("ix_workout_user_date", "user_id", "workout_date"),)


class MoneyRecord(Base):
    __tablename__ = "money_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    month: Mapped[date] = mapped_column(Date)
    account: Mapped[str] = mapped_column(String(32))
    opening: Mapped[float] = mapped_column(Numeric(14, 2), default=0)
    closing: Mapped[float] = mapped_column(Numeric(14, 2), default=0)
    net: Mapped[float] = mapped_column(Numeric(14, 2), default=0)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    __table_args__ = (
        Index(
            "uq_money_user_month_account",
            "user_id",
            "month",
            "account",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
            sqlite_where=text("deleted_at IS NULL"),
        ),
    )


class WeeklyReview(Base):
    __tablename__ = "weekly_reviews"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    week_start: Mapped[date] = mapped_column(Date)
    wins: Mapped[str | None] = mapped_column(Text)
    blockers: Mapped[str | None] = mapped_column(Text)
    next_focus: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    __table_args__ = (
        UniqueConstraint("user_id", "week_start", name="uq_review_user_week"),
    )
