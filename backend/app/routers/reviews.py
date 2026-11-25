from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User, WeeklyReview
from ..permissions import module_guard
from ..security import require_csrf
from .modules import serialize

router = APIRouter(prefix="/api/reviews", tags=["reviews"])


def monday_of(day: date) -> date:
    return day - timedelta(days=day.weekday())


@router.get("")
def list_reviews(user: User = Depends(module_guard("dashboard")), db: Session = Depends(get_db)) -> dict:
    rows = list(
        db.scalars(
            select(WeeklyReview)
            .where(WeeklyReview.user_id == user.id)
            .order_by(WeeklyReview.week_start.desc())
            .limit(12)
        )
    )
    return {"items": [serialize(item) for item in rows]}


@router.post("", dependencies=[Depends(require_csrf)])
def save_review(
    payload: dict,
    user: User = Depends(module_guard("dashboard", write=True)),
    db: Session = Depends(get_db),
) -> dict:
    raw = str(payload.get("week_start") or "")[:10]
    try:
        week_start = date.fromisoformat(raw) if raw else monday_of(date.today())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="invalid_week_start") from exc
    week_start = monday_of(week_start)
    row = db.scalars(
        select(WeeklyReview).where(WeeklyReview.user_id == user.id, WeeklyReview.week_start == week_start)
    ).first()
    if row is None:
        row = WeeklyReview(user_id=user.id, week_start=week_start)
        db.add(row)
    row.wins = str(payload.get("wins") or "").strip() or None
    row.blockers = str(payload.get("blockers") or "").strip() or None
    row.next_focus = str(payload.get("next_focus") or "").strip() or None
    db.commit()
    db.refresh(row)
    return {"item": serialize(row)}
