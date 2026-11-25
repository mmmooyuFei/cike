from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta

from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import AuthSession, User, utcnow

SESSION_COOKIE = "cike_session"
CSRF_COOKIE = "cike_csrf"
SESSION_DAYS = 7


def hash_token(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(48)


def _fernet() -> Fernet:
    key = hashlib.sha256(settings.session_secret.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError):
        return None


def create_session(
    db: Session,
    user: User,
    request: Request,
    response: Response,
    *,
    access_token: str | None = None,
    refresh_token: str | None = None,
    token_expires_at: datetime | None = None,
    idp_owner: str | None = None,
) -> AuthSession:
    token = new_token()
    csrf = new_token()
    session = AuthSession(
        id=hash_token(token),
        user_id=user.id,
        csrf_hash=hash_token(csrf),
        idp_access_token=encrypt_secret(access_token) if access_token else None,
        idp_refresh_token=encrypt_secret(refresh_token) if refresh_token else None,
        idp_token_expires_at=token_expires_at,
        idp_checked_at=utcnow(),
        idp_owner=idp_owner,
        expires_at=utcnow() + timedelta(days=SESSION_DAYS),
        ip=request.client.host if request.client else None,
        user_agent=(request.headers.get("user-agent") or "")[:500],
    )
    db.add(session)
    user.last_login_at = utcnow()
    db.commit()

    secure = settings.cookie_secure
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/",
    )
    response.set_cookie(
        CSRF_COOKIE,
        csrf,
        max_age=SESSION_DAYS * 86400,
        httponly=False,
        secure=secure,
        samesite="lax",
        path="/",
    )
    return session


def clear_session(db: Session, request: Request, response: Response) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        row = db.get(AuthSession, hash_token(token))
        if row:
            db.delete(row)
            db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")


def read_session(request: Request, db: Session) -> AuthSession | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    row = db.get(AuthSession, hash_token(token))
    if row is None:
        return None
    if row.expires_at < utcnow():
        db.delete(row)
        db.commit()
        return None
    return row


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    session = read_session(request, db)
    if session is None:
        raise HTTPException(status_code=401, detail="authentication_required")
    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        raise HTTPException(status_code=401, detail="account_unavailable")
    from .oidc import ensure_idp_session

    if not ensure_idp_session(db, session, user):
        raise HTTPException(status_code=401, detail="session_expired")
    request.state.session = session
    return user


def require_csrf(request: Request, db: Session = Depends(get_db)) -> None:
    session = read_session(request, db)
    if session is None:
        raise HTTPException(status_code=401, detail="authentication_required")
    header = request.headers.get("x-csrf-token", "")
    if not header or hash_token(header) != session.csrf_hash:
        raise HTTPException(status_code=403, detail="csrf_validation_failed")


def is_admin(user: User) -> bool:
    if user.is_admin:
        return True
    roles = [str(item) for item in (user.roles or [])]
    target = settings.admin_role
    return any(role == target or role.rsplit("/", 1)[-1] == target for role in roles)


def require_admin(user: User = Depends(current_user)) -> User:
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="admin_required")
    return user


def user_public(user: User) -> dict:
    local_avatar = settings.avatar_path / f"{user.id}.png"
    if local_avatar.exists():
        avatar_url = f"/api/account/avatar?v={int(local_avatar.stat().st_mtime)}"
    elif user.avatar_url:
        avatar_url = "/api/account/avatar"
    else:
        avatar_url = None
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name or user.username,
        "email": user.email,
        "phone": user.phone,
        "avatar_url": avatar_url,
        "gender": user.gender,
        "birthday": user.birthday.isoformat() if user.birthday else None,
        "roles": user.roles or [],
        "groups": user.groups or [],
        "is_admin": is_admin(user),
        "last_login_at": user.last_login_at.isoformat() if user.last_login_at else None,
    }


def touch_now() -> datetime:
    return utcnow()
