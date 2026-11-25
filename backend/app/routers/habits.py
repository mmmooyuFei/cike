"""坚持打卡：坚持事项的增删改，加上按天的打卡与月度进度、连续天数计算。

语义与参考项目 v33 对齐：

- 频率「每天」→ 当月目标 = 当月天数
- 频率「每周」→ 当月目标 = 每周次数 × 当月天数 / 7（四舍五入，至少 1）
- 频率「每月」→ 当月目标 = 设定次数（至少 1）
- 进度 = 当月打卡数 / 当月目标，封顶 100
- 连续天数：从今天（今天没打就从昨天）往前数连续有打卡的天数
- 同一事项同一天只保留一条打卡；取消打卡是软删除，可以重新打
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Habit, HabitLog, User, utcnow
from ..permissions import module_guard
from ..security import require_csrf
from ..timeutil import app_today

router = APIRouter(prefix="/api/habits", tags=["habits"])

FREQUENCIES = {"每天", "每周", "每月"}
STATUSES = {"进行中", "已暂停"}
STREAK_DAYS = 370


def month_goal(frequency: str, target_count: int, day: date) -> int:
    days = calendar.monthrange(day.year, day.month)[1]
    if frequency == "每天":
        return days
    if frequency == "每周":
        per_week = target_count if target_count and target_count > 0 else 3
        return max(1, round(per_week * days / 7))
    per_month = target_count if target_count and target_count > 0 else 1
    return max(1, per_month)


def streak_of(log_dates: set[date], today: date) -> int:
    cursor = today if today in log_dates else today - timedelta(days=1)
    count = 0
    while cursor in log_dates and count < STREAK_DAYS:
        count += 1
        cursor -= timedelta(days=1)
    return count


def load_logs(db: Session, user: User, habit_ids: list[int], since: date) -> dict[int, list[HabitLog]]:
    if not habit_ids:
        return {}
    rows = db.scalars(
        select(HabitLog).where(
            HabitLog.user_id == user.id,
            HabitLog.habit_id.in_(habit_ids),
            HabitLog.deleted_at.is_(None),
            HabitLog.log_date >= since,
        )
    )
    grouped: dict[int, list[HabitLog]] = {}
    for row in rows:
        grouped.setdefault(row.habit_id, []).append(row)
    return grouped


def habit_summary(habit: Habit, logs: list[HabitLog], today: date) -> dict:
    month_start = today.replace(day=1)
    month_logs = [row for row in logs if row.log_date >= month_start]
    dates = {row.log_date for row in logs}
    today_log = next((row for row in logs if row.log_date == today), None)
    goal = month_goal(habit.frequency, habit.target_count or 0, today)
    done = len(month_logs)
    last_done = max(dates) if dates else None
    return {
        "id": habit.id,
        "title": habit.title,
        "frequency": habit.frequency,
        "target_count": habit.target_count or 0,
        "status": habit.status,
        "start_date": habit.start_date.isoformat() if habit.start_date else None,
        "note": habit.note,
        "month_done": done,
        "month_goal": goal,
        "progress": min(100, round(done / goal * 100)) if goal else 0,
        "streak": streak_of(dates, today),
        "today_done": today_log is not None,
        "today_log_id": today_log.id if today_log else None,
        "last_done": last_done.isoformat() if last_done else None,
    }


def habit_summaries(db: Session, user: User, today: date | None = None, *, active_only: bool = False) -> list[dict]:
    day = today or app_today()
    stmt = select(Habit).where(Habit.user_id == user.id, Habit.deleted_at.is_(None)).order_by(Habit.created_at)
    habits = list(db.scalars(stmt))
    if active_only:
        habits = [habit for habit in habits if habit.status != "已暂停"]
    since = day - timedelta(days=STREAK_DAYS)
    logs = load_logs(db, user, [habit.id for habit in habits], since)
    return [habit_summary(habit, logs.get(habit.id, []), day) for habit in habits]


def find_habit(db: Session, user: User, habit_id: int) -> Habit:
    habit = db.scalars(
        select(Habit).where(Habit.id == habit_id, Habit.user_id == user.id, Habit.deleted_at.is_(None))
    ).first()
    if habit is None:
        raise HTTPException(status_code=404, detail="habit_not_found")
    return habit


def coerce_habit_values(payload: dict, *, creating: bool) -> dict:
    values: dict = {}
    if "title" in payload or creating:
        title = str(payload.get("title") or "").strip()
        if not title or len(title) > 200:
            raise HTTPException(status_code=422, detail="invalid_habit_title")
        values["title"] = title
    if "frequency" in payload or creating:
        frequency = str(payload.get("frequency") or "每天").strip()
        if frequency not in FREQUENCIES:
            raise HTTPException(status_code=422, detail="invalid_habit_frequency")
        values["frequency"] = frequency
    if "target_count" in payload or creating:
        raw = payload.get("target_count")
        try:
            count = int(float(raw)) if raw not in (None, "") else 0
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="invalid_habit_target") from exc
        values["target_count"] = max(0, min(99, count))
    if "status" in payload or creating:
        status = str(payload.get("status") or "进行中").strip()
        if status not in STATUSES:
            raise HTTPException(status_code=422, detail="invalid_habit_status")
        values["status"] = status
    if "start_date" in payload:
        raw = str(payload.get("start_date") or "").strip()[:10]
        if raw:
            try:
                values["start_date"] = date.fromisoformat(raw)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail="invalid_date") from exc
        else:
            values["start_date"] = None
    if "note" in payload:
        note = str(payload.get("note") or "").strip()
        values["note"] = note or None
    return values


@router.get("")
def list_habits(
    user: User = Depends(module_guard("habits")),
    db: Session = Depends(get_db),
) -> dict:
    today = app_today()
    return {"today": today.isoformat(), "items": habit_summaries(db, user, today)}


@router.post("", dependencies=[Depends(require_csrf)])
def create_habit(
    payload: dict,
    user: User = Depends(module_guard("habits", write=True)),
    db: Session = Depends(get_db),
) -> dict:
    values = coerce_habit_values(payload, creating=True)
    if "start_date" not in values:
        values["start_date"] = app_today()
    habit = Habit(user_id=user.id, **values)
    db.add(habit)
    db.commit()
    db.refresh(habit)
    today = app_today()
    return {"item": habit_summary(habit, [], today)}


@router.patch("/{habit_id}", dependencies=[Depends(require_csrf)])
def update_habit(
    habit_id: int,
    payload: dict,
    user: User = Depends(module_guard("habits", write=True)),
    db: Session = Depends(get_db),
) -> dict:
    habit = find_habit(db, user, habit_id)
    for key, value in coerce_habit_values(payload, creating=False).items():
        setattr(habit, key, value)
    db.commit()
    db.refresh(habit)
    today = app_today()
    logs = load_logs(db, user, [habit.id], today - timedelta(days=STREAK_DAYS)).get(habit.id, [])
    return {"item": habit_summary(habit, logs, today)}


@router.delete("/{habit_id}", dependencies=[Depends(require_csrf)])
def delete_habit(
    habit_id: int,
    user: User = Depends(module_guard("habits", write=True)),
    db: Session = Depends(get_db),
) -> dict:
    habit = find_habit(db, user, habit_id)
    habit.deleted_at = utcnow()
    for log in db.scalars(select(HabitLog).where(HabitLog.habit_id == habit.id, HabitLog.deleted_at.is_(None))):
        log.deleted_at = utcnow()
    db.commit()
    return {"ok": True, "id": habit_id}


@router.post("/{habit_id}/check", dependencies=[Depends(require_csrf)])
def check_habit(
    habit_id: int,
    payload: dict | None = None,
    user: User = Depends(module_guard("habits", write=True)),
    db: Session = Depends(get_db),
) -> dict:
    habit = find_habit(db, user, habit_id)
    raw = str((payload or {}).get("date") or "")[:10]
    try:
        day = date.fromisoformat(raw) if raw else app_today()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="invalid_date") from exc
    existing = db.scalars(
        select(HabitLog).where(
            HabitLog.habit_id == habit.id,
            HabitLog.log_date == day,
            HabitLog.deleted_at.is_(None),
        )
    ).first()
    if existing is None:
        db.add(HabitLog(user_id=user.id, habit_id=habit.id, log_date=day))
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(status_code=409, detail="habit_conflict") from exc
    today = app_today()
    logs = load_logs(db, user, [habit.id], today - timedelta(days=STREAK_DAYS)).get(habit.id, [])
    return {"item": habit_summary(habit, logs, today)}


@router.delete("/{habit_id}/check", dependencies=[Depends(require_csrf)])
def uncheck_habit(
    habit_id: int,
    date_: str = Query("", alias="date"),
    user: User = Depends(module_guard("habits", write=True)),
    db: Session = Depends(get_db),
) -> dict:
    habit = find_habit(db, user, habit_id)
    try:
        day = date.fromisoformat(date_[:10]) if date_ else app_today()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="invalid_date") from exc
    row = db.scalars(
        select(HabitLog).where(
            HabitLog.habit_id == habit.id,
            HabitLog.log_date == day,
            HabitLog.deleted_at.is_(None),
        )
    ).first()
    if row is not None:
        row.deleted_at = utcnow()
        db.commit()
    today = app_today()
    logs = load_logs(db, user, [habit.id], today - timedelta(days=STREAK_DAYS)).get(habit.id, [])
    return {"item": habit_summary(habit, logs, today)}
