from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import DailyLog, FocusSession, Milestone, MoneyRecord, SleepRecord, Todo, User, WeeklyReview, Workout
from ..permissions import module_guard
from ..routers.modules import serialize

router = APIRouter(prefix="/api", tags=["overview"])


def _days_back(today: date, count: int) -> list[date]:
    return [today - timedelta(days=offset) for offset in range(count - 1, -1, -1)]


@router.get("/overview")
def overview(
    user: User = Depends(module_guard("dashboard")),
    db: Session = Depends(get_db),
) -> dict:
    today = date.today()
    monday = today - timedelta(days=today.weekday())
    month_start = today.replace(day=1)
    week_ago = today - timedelta(days=6)

    todos = list(
        db.scalars(
            select(Todo).where(Todo.user_id == user.id, Todo.deleted_at.is_(None)).order_by(Todo.created_at.desc())
        )
    )
    open_todos = [item for item in todos if item.status != "done"]
    overdue = [item for item in open_todos if item.due_date and item.due_date < today]
    done_today = [
        item
        for item in todos
        if item.completed_at and item.completed_at.date() == today
    ]
    top_todos = sorted(
        open_todos,
        key=lambda item: (
            item.due_date is None,
            item.due_date or date.max,
            {"P0": 0, "P1": 1, "P2": 2, "P3": 3}.get(item.priority, 9),
        ),
    )[:5]

    focus = list(
        db.scalars(
            select(FocusSession).where(
                FocusSession.user_id == user.id,
                FocusSession.deleted_at.is_(None),
                FocusSession.session_date >= week_ago,
            )
        )
    )
    focus_week = [item for item in focus if item.session_date >= monday]
    focus_today = [item for item in focus if item.session_date == today]
    focus_trend = []
    for day in _days_back(today, 7):
        focus_trend.append(
            {
                "date": day.isoformat(),
                "minutes": sum(item.minutes or 0 for item in focus if item.session_date == day),
            }
        )

    study = list(
        db.scalars(
            select(FocusSession).where(
                FocusSession.user_id == user.id,
                FocusSession.deleted_at.is_(None),
                FocusSession.session_date >= month_start,
                FocusSession.type == "学习输入",
            )
        )
    )

    sleep = list(
        db.scalars(
            select(SleepRecord).where(
                SleepRecord.user_id == user.id,
                SleepRecord.deleted_at.is_(None),
                SleepRecord.record_date >= week_ago,
            )
        )
    )
    wake_rows = [item for item in sleep if item.wake_time]
    wake_days = len(wake_rows)
    wake_hits = len([item for item in wake_rows if item.achieved])
    sleep_hours = [float(item.hours) for item in wake_rows if item.hours]
    sleep_trend = []
    by_day = {item.record_date: item for item in sleep}
    for day in _days_back(today, 7):
        row = by_day.get(day)
        sleep_trend.append({"date": day.isoformat(), "hours": float(row.hours) if row and row.hours else None})

    workouts = list(
        db.scalars(
            select(Workout).where(
                Workout.user_id == user.id,
                Workout.deleted_at.is_(None),
                Workout.workout_date >= month_start,
            )
        )
    )

    money = list(
        db.scalars(
            select(MoneyRecord).where(
                MoneyRecord.user_id == user.id,
                MoneyRecord.deleted_at.is_(None),
            )
        )
    )
    latest_month = max((item.month for item in money), default=None)
    latest_money = [item for item in money if item.month == latest_month] if latest_month else []
    money_total = sum(float(item.closing or 0) for item in latest_money)
    money_accounts = [
        {
            "account": item.account,
            "opening": float(item.opening or 0),
            "closing": float(item.closing or 0),
            "net": float(item.net or 0),
        }
        for item in sorted(latest_money, key=lambda item: item.account)
    ]

    milestones = list(
        db.scalars(
            select(Milestone).where(Milestone.user_id == user.id, Milestone.deleted_at.is_(None))
        )
    )
    active_milestones = [item for item in milestones if item.status not in {"已完成", "已放弃"}]
    done_milestones = [item for item in milestones if item.status == "已完成"]
    total_milestones = len(active_milestones) + len(done_milestones)
    milestone_rate = round(len(done_milestones) / total_milestones * 100) if total_milestones else None

    today_log = db.scalars(
        select(DailyLog).where(
            DailyLog.user_id == user.id,
            DailyLog.log_date == today,
            DailyLog.deleted_at.is_(None),
        )
    ).first()

    review = db.scalars(
        select(WeeklyReview).where(WeeklyReview.user_id == user.id, WeeklyReview.week_start == monday)
    ).first()

    return {
        "today": today.isoformat(),
        "week_start": monday.isoformat(),
        "kpi": {
            "todo_open": len(open_todos),
            "todo_overdue": len(overdue),
            "todo_done_today": len(done_today),
            "focus_week_minutes": sum(item.minutes or 0 for item in focus_week),
            "focus_today_minutes": sum(item.minutes or 0 for item in focus_today),
            "focus_7_minutes": sum(item.minutes or 0 for item in focus),
            "focus_week_sessions": len(focus_week),
            "wake_days": wake_days,
            "wake_rate": round(wake_hits / wake_days * 100) if wake_days else None,
            "sleep_avg_7": round(sum(sleep_hours) / len(sleep_hours), 1) if sleep_hours else None,
            "workout_month_count": len(workouts),
            "workout_month_minutes": sum(item.minutes or 0 for item in workouts),
            "study_month_minutes": sum(item.minutes or 0 for item in study),
            "money_total": round(money_total, 2) if latest_month else None,
            "money_month": latest_month.isoformat()[:7] if latest_month else "",
            "money_accounts": len(money_accounts),
            "milestone_open": len(active_milestones),
            "milestone_done": len(done_milestones),
            "milestone_rate": milestone_rate,
        },
        "focus_trend": focus_trend,
        "sleep_trend": sleep_trend,
        "todos": [serialize(item) for item in top_todos],
        "money_accounts": money_accounts,
        "milestones": [serialize(item) for item in active_milestones[:3]],
        "today_log": serialize(today_log) if today_log else None,
        "review": serialize(review) if review else None,
    }
