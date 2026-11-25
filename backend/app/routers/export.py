from __future__ import annotations

import csv
import io
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User
from ..permissions import module_allowed
from ..security import current_user, user_public
from .modules import CFG, serialize

router = APIRouter(prefix="/api/export", tags=["export"])


@router.get("")
def export_all(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    data = {"user": user_public(user), "exported_at": date.today().isoformat(), "modules": {}}
    for module, cfg in CFG.items():
        if not module_allowed(db, user, module):
            continue
        rows = list(
            db.scalars(
                select(cfg["model"]).where(
                    cfg["model"].user_id == user.id,
                    cfg["model"].deleted_at.is_(None),
                )
            )
        )
        data["modules"][module] = [serialize(item) for item in rows]
    return data


@router.get("/{module}.csv")
def export_csv(module: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> Response:
    if module not in CFG:
        raise HTTPException(status_code=404, detail="unknown_module")
    if not module_allowed(db, user, module):
        raise HTTPException(status_code=403, detail="module_forbidden")
    cfg = CFG[module]
    rows = list(
        db.scalars(
            select(cfg["model"]).where(
                cfg["model"].user_id == user.id,
                cfg["model"].deleted_at.is_(None),
            )
        )
    )
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    columns = [column.name for column in cfg["model"].__table__.columns if column.name != "deleted_at"]
    writer.writerow(columns)
    for row in rows:
        item = serialize(row)
        writer.writerow([item.get(column, "") for column in columns])
    payload = "\ufeff" + buffer.getvalue()
    return Response(
        payload,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="cike-{module}.csv"'},
    )
