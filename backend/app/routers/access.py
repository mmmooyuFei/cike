from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AccessRule, User
from ..permissions import MODULES, MODULE_KEYS
from ..security import require_admin, require_csrf

router = APIRouter(prefix="/api/access", tags=["access"])


@router.get("")
def get_access(admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    users = list(db.scalars(select(User).order_by(User.created_at)))
    roles = sorted({str(role) for user in users for role in (user.roles or [])})
    groups = sorted({str(group) for user in users for group in (user.groups or [])})
    rules = list(db.scalars(select(AccessRule).order_by(AccessRule.module, AccessRule.subject_type, AccessRule.subject)))
    return {
        "modules": MODULES,
        "roles": roles,
        "groups": groups,
        "users": [
            {"id": user.id, "username": user.username, "display_name": user.display_name or user.username}
            for user in users
        ],
        "rules": [
            {
                "id": rule.id,
                "module": rule.module,
                "subject_type": rule.subject_type,
                "subject": rule.subject,
                "can_view": rule.can_view,
                "can_edit": rule.can_edit,
            }
            for rule in rules
        ],
    }


@router.put("", dependencies=[Depends(require_csrf)])
def put_access(payload: dict, admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    rules = payload.get("rules")
    if not isinstance(rules, list):
        raise HTTPException(status_code=422, detail="invalid_rules")
    cleaned: list[AccessRule] = []
    seen: set[tuple[str, str, str]] = set()
    for item in rules:
        if not isinstance(item, dict):
            raise HTTPException(status_code=422, detail="invalid_rules")
        module = str(item.get("module") or "")
        subject_type = str(item.get("subject_type") or "")
        subject = str(item.get("subject") or "").strip()
        if module not in MODULE_KEYS or subject_type not in {"role", "group", "user"} or not subject:
            raise HTTPException(status_code=422, detail="invalid_rules")
        key = (module, subject_type, subject)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(
            AccessRule(
                module=module,
                subject_type=subject_type,
                subject=subject[:160],
                can_view=bool(item.get("can_view", True)),
                can_edit=bool(item.get("can_edit", True)),
            )
        )
    db.execute(delete(AccessRule))
    db.add_all(cleaned)
    db.commit()
    return {"ok": True, "count": len(cleaned)}
