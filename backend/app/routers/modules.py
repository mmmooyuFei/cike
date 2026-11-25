from __future__ import annotations

import json
import re
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import DailyLog, FocusSession, Milestone, MoneyRecord, SleepRecord, Todo, User, Workout, utcnow
from ..permissions import module_guard
from ..security import current_user, require_csrf
from ..timeutil import app_now, app_today

router = APIRouter(prefix="/api/data", tags=["modules"])
TIME_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")

CFG: dict[str, dict[str, Any]] = {
    "todos": {
        "model": Todo,
        "fields": {
            "title": ("str", 300),
            "status": ("str", 16),
            "priority": ("str", 8),
            "category": ("str", 32),
            "due_date": ("date", None),
            "note": ("text", None),
        },
        "required": ["title"],
        "order": [Todo.due_date.is_(None), Todo.due_date.asc(), Todo.created_at.desc()],
        "search": [Todo.title, Todo.note],
        "date_field": "due_date",
    },
    "milestones": {
        "model": Milestone,
        "fields": {
            "title": ("str", 300),
            "category": ("str", 32),
            "quarter": ("str", 8),
            "target_date": ("date", None),
            "metric": ("text", None),
            "status": ("str", 16),
            "progress": ("int", None),
            "next_step": ("text", None),
            "review": ("text", None),
        },
        "required": ["title"],
        "order": [Milestone.target_date.is_(None), Milestone.target_date.asc(), Milestone.created_at.desc()],
        "search": [Milestone.title],
        "date_field": "target_date",
    },
    "daily": {
        "model": DailyLog,
        "fields": {
            "log_date": ("date", None),
            "content": ("text", None),
            "tomorrow_plan": ("text", None),
            "blockers": ("text", None),
        },
        "required": [],
        "order": [DailyLog.log_date.desc()],
        "search": [DailyLog.content],
        "date_field": "log_date",
    },
    "sleep": {
        "model": SleepRecord,
        "fields": {
            "record_date": ("date", None),
            "bed_time": ("time", None),
            "wake_time": ("time", None),
            "target_time": ("time", None),
            "achieved": ("bool", None),
            "hours": ("float", None),
        },
        "required": [],
        "order": [SleepRecord.record_date.desc()],
        "search": [],
        "date_field": "record_date",
    },
    "focus": {
        "model": FocusSession,
        "fields": {
            "session_date": ("date", None),
            "item": ("str", 300),
            "type": ("str", 32),
            "category": ("str", 32),
            "minutes": ("int", None),
            "start_time": ("time", None),
            "source": ("str", 200),
            "done": ("bool", None),
            "interruptions": ("int", None),
            "takeaway": ("text", None),
            "action": ("text", None),
            "note": ("text", None),
        },
        "required": ["item"],
        "order": [FocusSession.session_date.desc(), FocusSession.created_at.desc()],
        "search": [FocusSession.item, FocusSession.takeaway],
        "date_field": "session_date",
    },
    "workouts": {
        "model": Workout,
        "fields": {
            "workout_date": ("date", None),
            "items": ("json", None),
            "minutes": ("int", None),
            "intensity": ("str", 8),
            "calories": ("int", None),
            "note": ("text", None),
        },
        "required": [],
        "order": [Workout.workout_date.desc()],
        "search": [],
        "date_field": "workout_date",
    },
    "money": {
        "model": MoneyRecord,
        "fields": {
            "month": ("date", None),
            "account": ("str", 32),
            "opening": ("float", None),
            "closing": ("float", None),
            "note": ("text", None),
        },
        "required": [],
        "order": [MoneyRecord.month.desc(), MoneyRecord.account.asc()],
        "search": [MoneyRecord.account],
        "date_field": "month",
    },
}


def today() -> date:
    return app_today()


def coerce(kind: str, value: Any, limit: int | None = None) -> Any:
    if value is None:
        return None
    if kind == "str":
        text = str(value).strip()
        return text[:limit] if limit else text
    if kind == "text":
        text = str(value)
        return text or None
    if kind == "date":
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="invalid_date") from exc
    if kind == "time":
        text = str(value).strip()[:5]
        if not TIME_RE.match(text):
            raise HTTPException(status_code=422, detail="invalid_time")
        hour, minute = text.split(":")
        return f"{int(hour):02d}:{minute}"
    if kind == "int":
        try:
            return int(float(value))
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="invalid_number") from exc
    if kind == "float":
        try:
            return float(value)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=422, detail="invalid_number") from exc
    if kind == "bool":
        if isinstance(value, bool):
            return value
        return str(value).lower() in {"1", "true", "yes", "on"}
    if kind == "json":
        if isinstance(value, (list, dict)):
            return value
        if isinstance(value, str):
            try:
                return json.loads(value)
            except ValueError as exc:
                raise HTTPException(status_code=422, detail="invalid_json") from exc
        raise HTTPException(status_code=422, detail="invalid_json")
    return value


def serialize(obj: Any) -> dict:
    out: dict[str, Any] = {}
    for column in obj.__table__.columns:
        if column.name == "deleted_at":
            continue
        value = getattr(obj, column.name)
        if isinstance(value, Decimal):
            value = float(value)
        elif isinstance(value, datetime):
            value = value.isoformat()
        elif isinstance(value, date):
            value = value.isoformat()
        out[column.name] = value
    return out


def cfg_for(module: str) -> dict[str, Any]:
    if module not in CFG:
        raise HTTPException(status_code=404, detail="unknown_module")
    return CFG[module]


def defaults(module: str) -> dict[str, Any]:
    if module == "todos":
        return {"status": "todo", "priority": "P1", "category": "工作"}
    if module == "milestones":
        return {"status": "进行中", "progress": 0, "category": "事业"}
    if module == "daily":
        return {"log_date": today()}
    if module == "sleep":
        return {"record_date": today(), "achieved": False}
    if module == "focus":
        return {"session_date": today(), "type": "深度工作", "minutes": 0, "done": True, "interruptions": 0}
    if module == "workouts":
        return {"workout_date": today(), "items": [], "minutes": 0, "intensity": "中"}
    if module == "money":
        return {"month": today().replace(day=1), "account": "支付宝", "opening": 0, "closing": 0}
    return {}


def build_values(module: str, payload: dict, *, creating: bool) -> dict[str, Any]:
    cfg = cfg_for(module)
    values: dict[str, Any] = defaults(module) if creating else {}
    for field, (kind, limit) in cfg["fields"].items():
        if field in payload:
            values[field] = coerce(kind, payload[field], limit)
    if creating:
        for field in ("log_date", "record_date", "session_date", "workout_date"):
            if field in values and values[field] is None:
                values[field] = today()
        if module == "money" and values.get("month") is None:
            values["month"] = today().replace(day=1)
        for field in cfg["required"]:
            if not values.get(field):
                raise HTTPException(status_code=422, detail=f"missing_{field}")
    if module == "todos" and "status" in values:
        values["completed_at"] = utcnow() if values["status"] == "done" else None
    return values


def find_owned(db: Session, module: str, user: User, item_id: int, *, include_deleted: bool = False) -> Any:
    model = cfg_for(module)["model"]
    stmt = select(model).where(model.id == item_id, model.user_id == user.id)
    if not include_deleted:
        stmt = stmt.where(model.deleted_at.is_(None))
    obj = db.scalars(stmt).first()
    if obj is None:
        raise HTTPException(status_code=404, detail="record_not_found")
    return obj


def apply_completed_at(module: str, values: dict, existing: Any = None) -> None:
    """里程碑的完成时间：只在状态真的变化时写入/清除，重复保存不会刷新它。"""
    if module != "milestones" or "status" not in values:
        return
    status = values.get("status")
    if status == "已完成":
        if existing is None or existing.completed_at is None:
            values["completed_at"] = utcnow()
    else:
        values["completed_at"] = None


def apply_money_totals(module: str, values: dict, existing: Any = None) -> None:
    """月份归一 + 净变动自动算；只改备注时不动余额。"""
    if module != "money":
        return
    month = values.get("month")
    if isinstance(month, date):
        values["month"] = month.replace(day=1)
    if "opening" not in values and "closing" not in values and existing is not None:
        return
    opening = float(values.get("opening", getattr(existing, "opening", 0)) or 0)
    closing = float(values.get("closing", getattr(existing, "closing", 0)) or 0)
    values["opening"] = opening
    values["closing"] = closing
    values["net"] = round(closing - opening, 2)


def drop_null_required(module: str, values: dict) -> None:
    """SELECT / 数字被清空时不要给非空列写 NULL。

    列默认值只在 INSERT 生效，UPDATE 写 NULL 会触发 IntegrityError 并被误报成“记录冲突”。
    这里把空值换成该字段的默认值；没有默认值的保留原值（从 values 移除）。
    """
    model = cfg_for(module)["model"]
    fallback = defaults(module)
    for field, value in list(values.items()):
        if value is not None:
            continue
        column = model.__table__.columns.get(field)
        if column is not None and not column.nullable:
            if field in fallback and fallback[field] is not None:
                values[field] = fallback[field]
            else:
                values.pop(field)


def find_merge_target(db: Session, module: str, user: User, values: dict) -> Any:
    model = cfg_for(module)["model"]
    if module == "daily":
        return db.scalars(
            select(model).where(
                model.user_id == user.id,
                model.log_date == values.get("log_date", today()),
                model.deleted_at.is_(None),
            )
        ).first()
    if module == "sleep":
        return db.scalars(
            select(model).where(
                model.user_id == user.id,
                model.record_date == values.get("record_date", today()),
                model.deleted_at.is_(None),
            )
        ).first()
    if module == "money":
        return db.scalars(
            select(model).where(
                model.user_id == user.id,
                model.month == values.get("month", today().replace(day=1)),
                model.account == values.get("account", "支付宝"),
                model.deleted_at.is_(None),
            )
        ).first()
    return None


@router.get("/{module}")
def list_items(
    module: str,
    q: str = "",
    limit: int = 200,
    offset: int = 0,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    if module not in CFG:
        raise HTTPException(status_code=404, detail="unknown_module")
    if not _allowed(db, user, module):
        raise HTTPException(status_code=403, detail="module_forbidden")
    cfg = cfg_for(module)
    model = cfg["model"]
    where = [model.user_id == user.id, model.deleted_at.is_(None)]
    if q.strip() and cfg["search"]:
        like = f"%{q.strip()}%"
        from sqlalchemy import or_

        where.append(or_(*[column.like(like) for column in cfg["search"]]))
    total = db.scalar(select(func.count()).select_from(model).where(*where)) or 0
    stmt = select(model).where(*where).order_by(*cfg["order"]).limit(max(1, min(limit, 200))).offset(max(0, offset))
    items = [serialize(item) for item in db.scalars(stmt)]
    return {"items": items, "total": total}


def _allowed(db: Session, user: User, module: str) -> bool:
    from ..permissions import module_allowed

    return module_allowed(db, user, module)


@router.post("/{module}", dependencies=[Depends(require_csrf)])
def create_item(
    module: str,
    payload: dict,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    if module not in CFG:
        raise HTTPException(status_code=404, detail="unknown_module")
    if not _allowed(db, user, module):
        raise HTTPException(status_code=403, detail="module_forbidden")
    values = build_values(module, payload, creating=True)
    drop_null_required(module, values)
    apply_money_totals(module, values)
    target = find_merge_target(db, module, user, values)
    if target is not None:
        # 同一天/同月已有记录：只覆盖本次明确提交的字段，其余保持原值
        explicit = [field for field in cfg_for(module)["fields"] if field in payload]
        for field in explicit:
            if field in values:
                setattr(target, field, values[field])
        if module == "milestones":
            apply_completed_at(module, values, existing=target)
            if "completed_at" in values:
                target.completed_at = values["completed_at"]
        if module == "money":
            opening = float(values["opening"]) if "opening" in explicit else float(target.opening or 0)
            closing = float(values["closing"]) if "closing" in explicit else float(target.closing or 0)
            if "opening" in explicit:
                target.opening = opening
            if "closing" in explicit:
                target.closing = closing
            target.net = round(closing - opening, 2)
        try:
            db.commit()
        except IntegrityError as exc:
            db.rollback()
            raise HTTPException(status_code=409, detail="record_conflict") from exc
        db.refresh(target)
        return {"item": serialize(target), "merged": True}
    apply_completed_at(module, values)
    obj = cfg_for(module)["model"](user_id=user.id, **values)
    db.add(obj)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="record_conflict") from exc
    db.refresh(obj)
    return {"item": serialize(obj), "merged": False}


@router.patch("/{module}/{item_id}", dependencies=[Depends(require_csrf)])
def update_item(
    module: str,
    item_id: int,
    payload: dict,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    if module not in CFG:
        raise HTTPException(status_code=404, detail="unknown_module")
    if not _allowed(db, user, module):
        raise HTTPException(status_code=403, detail="module_forbidden")
    obj = find_owned(db, module, user, item_id)
    values = build_values(module, payload, creating=False)
    drop_null_required(module, values)
    apply_money_totals(module, values, existing=obj)
    apply_completed_at(module, values, existing=obj)
    for key, value in values.items():
        setattr(obj, key, value)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="record_conflict") from exc
    db.refresh(obj)
    return {"item": serialize(obj)}


@router.delete("/{module}/{item_id}", dependencies=[Depends(require_csrf)])
def delete_item(
    module: str,
    item_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    if module not in CFG:
        raise HTTPException(status_code=404, detail="unknown_module")
    if not _allowed(db, user, module):
        raise HTTPException(status_code=403, detail="module_forbidden")
    obj = find_owned(db, module, user, item_id)
    obj.deleted_at = utcnow()
    db.commit()
    return {"ok": True, "id": item_id}


@router.post("/{module}/{item_id}/restore", dependencies=[Depends(require_csrf)])
def restore_item(
    module: str,
    item_id: int,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    if module not in CFG:
        raise HTTPException(status_code=404, detail="unknown_module")
    if not _allowed(db, user, module):
        raise HTTPException(status_code=403, detail="module_forbidden")
    obj = find_owned(db, module, user, item_id, include_deleted=True)
    obj.deleted_at = None
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail="restore_conflict") from exc
    db.refresh(obj)
    return {"item": serialize(obj)}


@router.post("/todos/{item_id}/toggle", dependencies=[Depends(require_csrf)])
def toggle_todo(
    item_id: int,
    payload: dict,
    user: User = Depends(module_guard("todos", write=True)),
    db: Session = Depends(get_db),
) -> dict:
    obj = find_owned(db, "todos", user, item_id)
    done = bool(payload.get("done"))
    obj.status = "done" if done else "todo"
    obj.completed_at = utcnow() if done else None
    db.commit()
    db.refresh(obj)
    return {"item": serialize(obj)}


def minutes_of(value: str | None) -> int | None:
    if not value or not TIME_RE.match(value):
        return None
    hour, minute = value.split(":")
    return int(hour) * 60 + int(minute)


def hours_between(bed: str | None, wake: str | None) -> float | None:
    start = minutes_of(bed)
    end = minutes_of(wake)
    if start is None or end is None:
        return None
    diff = end - start
    if diff <= 0:
        diff += 24 * 60
    return round(diff / 60, 1)


@router.post("/sleep/punch", dependencies=[Depends(require_csrf)])
def punch_sleep(
    payload: dict,
    user: User = Depends(module_guard("sleep", write=True)),
    db: Session = Depends(get_db),
) -> dict:
    kind = "sleep" if str(payload.get("kind")) == "sleep" else "wake"
    time_value = coerce("time", payload.get("time") or app_now().strftime("%H:%M"))
    raw_date = str(payload.get("date") or "")[:10]
    try:
        day = date.fromisoformat(raw_date) if raw_date else today()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="invalid_date") from exc
    target = coerce("time", payload.get("target") or "06:30")
    shifted = False
    if kind == "sleep" and time_value < "06:00":
        day = day - timedelta(days=1)
        shifted = True
    obj = db.scalars(
        select(SleepRecord).where(
            SleepRecord.user_id == user.id,
            SleepRecord.record_date == day,
            SleepRecord.deleted_at.is_(None),
        )
    ).first()
    if obj is None:
        obj = SleepRecord(user_id=user.id, record_date=day)
        db.add(obj)
    achieved = False
    hours = None
    if kind == "wake":
        achieved = time_value <= target
        obj.wake_time = time_value
        obj.target_time = target
        obj.achieved = achieved
        same_day = obj.bed_time if obj.bed_time and minutes_of(obj.bed_time) < minutes_of(time_value) else None
        if same_day:
            hours = hours_between(same_day, time_value)
        else:
            previous = db.scalars(
                select(SleepRecord).where(
                    SleepRecord.user_id == user.id,
                    SleepRecord.record_date == day - timedelta(days=1),
                    SleepRecord.deleted_at.is_(None),
                )
            ).first()
            if previous and previous.bed_time:
                hours = hours_between(previous.bed_time, time_value)
        obj.hours = hours if hours is not None and 0 < hours <= 16 else None
    else:
        obj.bed_time = time_value
    db.commit()
    db.refresh(obj)
    return {"item": serialize(obj), "shifted": shifted, "achieved": achieved}
