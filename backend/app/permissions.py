from __future__ import annotations

from fastapi import Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from .db import get_db
from .models import AccessRule, User
from .security import current_user, is_admin

MODULES: list[dict[str, str]] = [
    {"key": "dashboard", "label": "驾驶舱"},
    {"key": "todos", "label": "待办"},
    {"key": "milestones", "label": "里程碑"},
    {"key": "daily", "label": "每日日志"},
    {"key": "sleep", "label": "睡眠"},
    {"key": "focus", "label": "专注学习"},
    {"key": "workouts", "label": "健身"},
    {"key": "money", "label": "资金"},
]
MODULE_KEYS = {item["key"] for item in MODULES}


def subject_pairs(user: User) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = [("user", user.id)]
    for role in user.roles or []:
        pairs.append(("role", str(role)))
    for group in user.groups or []:
        pairs.append(("group", str(group)))
    return pairs


def matching_rules(db: Session, user: User, module: str) -> list[AccessRule]:
    pairs = subject_pairs(user)
    if not pairs:
        return []
    conditions = [
        (AccessRule.subject_type == kind) & (AccessRule.subject == value)
        for kind, value in pairs
    ]
    stmt = select(AccessRule).where(AccessRule.module == module, or_(*conditions))
    return list(db.scalars(stmt))


def module_allowed(db: Session, user: User, module: str, *, write: bool = False) -> bool:
    if is_admin(user):
        return True
    rules = matching_rules(db, user, module)
    if not rules:
        return True
    if write:
        return all(rule.can_edit for rule in rules)
    return all(rule.can_view for rule in rules)


def allowed_modules(db: Session, user: User) -> list[str]:
    if is_admin(user):
        return [item["key"] for item in MODULES]
    return [item["key"] for item in MODULES if module_allowed(db, user, item["key"])]


def module_guard(module: str, *, write: bool = False):
    if module not in MODULE_KEYS:
        raise ValueError(f"unknown module: {module}")

    def dependency(
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ) -> User:
        if not module_allowed(db, user, module, write=write):
            raise HTTPException(status_code=403, detail="module_forbidden")
        return user

    return dependency
