from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import User
from ..oidc import consume_state, create_state, exchange_code, fetch_account, login_url, upsert_user
from ..permissions import allowed_modules
from ..security import (
    clear_session,
    create_session,
    current_user,
    is_admin,
    read_session,
    require_csrf,
    user_public,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/login-mode")
def login_mode() -> dict:
    return {
        "dev_auth": settings.dev_auth,
        "oidc": bool(settings.oidc_issuer and settings.oidc_client_id),
        "brand": settings.brand_default_name,
    }


@router.get("/session")
def session_info(request: Request, db: Session = Depends(get_db)) -> dict:
    session = read_session(request, db)
    if session is None:
        return {"user": None, "is_admin": False, "modules": []}
    user = db.get(User, session.user_id)
    if user is None or not user.is_active:
        return {"user": None, "is_admin": False, "modules": []}
    return {
        "user": user_public(user),
        "is_admin": is_admin(user),
        "modules": allowed_modules(db, user),
    }


@router.post("/dev-login")
def dev_login(payload: dict, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    if not settings.dev_auth:
        raise HTTPException(status_code=404, detail="not_found")
    role = str(payload.get("role") or "user")
    if role not in {"admin", "user"}:
        raise HTTPException(status_code=400, detail="invalid_role")
    sub = f"dev-{role}"
    user = db.scalars(select(User).where(User.idp_issuer == "dev", User.idp_sub == sub)).first()
    if user is None:
        user = User(
            idp_issuer="dev",
            idp_sub=sub,
            username=sub,
            display_name="管理员" if role == "admin" else "普通用户",
            roles=["admin"] if role == "admin" else ["user"],
            groups=[],
            is_admin=role == "admin",
        )
        db.add(user)
    else:
        user.roles = ["admin"] if role == "admin" else ["user"]
        user.is_admin = role == "admin"
        user.is_active = True
    db.commit()
    db.refresh(user)
    create_session(db, user, request, response)
    return {"user": user_public(user), "is_admin": is_admin(user), "modules": allowed_modules(db, user)}


@router.get("/oidc/login")
def oidc_login(request: Request, db: Session = Depends(get_db)) -> RedirectResponse:
    if not settings.oidc_issuer or not settings.oidc_client_id:
        raise HTTPException(status_code=503, detail="oidc_not_configured")
    state, verifier, nonce = create_state(db)
    return RedirectResponse(login_url(state, verifier, nonce), status_code=302)


@router.get("/oidc/callback")
def oidc_callback(
    request: Request,
    code: str = "",
    state: str = "",
    db: Session = Depends(get_db),
) -> RedirectResponse:
    try:
        if not code or not state:
            raise HTTPException(status_code=400, detail="oidc_callback_invalid")
        row = consume_state(db, state)
        token = exchange_code(code, row.verifier)
        claims = fetch_account(str(token["access_token"]))
        user = upsert_user(db, claims)
        response = RedirectResponse("/", status_code=303)
        create_session(
            db,
            user,
            request,
            response,
            access_token=str(token["access_token"]),
            idp_owner=str(claims.get("owner") or ""),
        )
        return response
    except HTTPException as exc:
        return RedirectResponse(f"/?login_error={exc.detail}", status_code=303)
    except Exception:
        return RedirectResponse("/?login_error=oidc_failed", status_code=303)


@router.post("/logout", dependencies=[Depends(require_csrf)])
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    clear_session(db, request, response)
    return {"ok": True}
