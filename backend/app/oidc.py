from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import timedelta
from urllib.parse import urlencode

import httpx
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models import OidcState, User, utcnow

_DISCOVERY: dict[str, dict] = {}


def issuer() -> str:
    return settings.oidc_issuer.rstrip("/")


def _discovery() -> dict:
    base = issuer()
    if not base:
        raise HTTPException(status_code=503, detail="oidc_not_configured")
    if base in _DISCOVERY:
        return _DISCOVERY[base]
    try:
        response = httpx.get(f"{base}/.well-known/openid-configuration", timeout=12)
        response.raise_for_status()
        data = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="oidc_discovery_failed") from exc
    _DISCOVERY[base] = data
    return data


def _names(value) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        if isinstance(item, dict):
            name = item.get("name") or item.get("displayName") or item.get("id")
            if name:
                result.append(str(name))
        elif item:
            result.append(str(item))
    return result


def create_state(db: Session) -> tuple[str, str, str]:
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    nonce = secrets.token_urlsafe(32)
    db.add(
        OidcState(
            state=state,
            verifier=verifier,
            nonce=nonce,
            expires_at=utcnow() + timedelta(minutes=10),
        )
    )
    db.commit()
    return state, verifier, nonce


def consume_state(db: Session, state: str) -> OidcState:
    row = db.get(OidcState, state)
    if row is None or row.expires_at < utcnow():
        raise HTTPException(status_code=400, detail="oidc_state_invalid")
    db.delete(row)
    db.commit()
    return row


def login_url(state: str, verifier: str, nonce: str) -> str:
    data = _discovery()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    query = {
        "response_type": "code",
        "client_id": settings.oidc_client_id,
        "redirect_uri": settings.oidc_redirect_uri,
        "scope": settings.oidc_scopes,
        "state": state,
        "nonce": nonce,
    }
    if settings.oidc_pkce:
        query["code_challenge"] = challenge
        query["code_challenge_method"] = "S256"
    separator = "&" if "?" in data["authorization_endpoint"] else "?"
    return f"{data['authorization_endpoint']}{separator}{urlencode(query)}"


def exchange_code(code: str, verifier: str) -> dict:
    data = _discovery()
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.oidc_redirect_uri,
        "client_id": settings.oidc_client_id,
    }
    if settings.oidc_pkce:
        payload["code_verifier"] = verifier
    if settings.oidc_client_secret:
        payload["client_secret"] = settings.oidc_client_secret
    try:
        response = httpx.post(data["token_endpoint"], data=payload, timeout=15)
        response.raise_for_status()
        token = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="oidc_token_exchange_failed") from exc
    if not token.get("access_token"):
        raise HTTPException(status_code=502, detail="oidc_token_exchange_failed")
    return token


def fetch_account(access_token: str) -> dict:
    base = issuer()
    headers = {"Authorization": f"Bearer {access_token}", "Accept-Language": "zh"}
    try:
        response = httpx.get(f"{base}/api/get-account", headers=headers, timeout=12)
        if response.status_code == 200:
            payload = response.json()
            if isinstance(payload, dict) and payload.get("status") == "ok" and isinstance(payload.get("data"), dict):
                return payload["data"]
            if isinstance(payload, dict) and payload.get("sub"):
                return payload
    except Exception:
        pass
    data = _discovery()
    try:
        response = httpx.get(data["userinfo_endpoint"], headers=headers, timeout=12)
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, dict):
            return payload
    except Exception as exc:
        raise HTTPException(status_code=502, detail="oidc_userinfo_failed") from exc
    raise HTTPException(status_code=502, detail="oidc_userinfo_failed")


def upsert_user(db: Session, claims: dict) -> User:
    sub = str(claims.get("sub") or claims.get("id") or "").strip()
    if not sub:
        raise HTTPException(status_code=502, detail="oidc_subject_missing")
    owner = str(claims.get("owner") or "").strip()
    roles = _names(claims.get("roles"))
    groups = _names(claims.get("groups"))
    is_admin = any(
        role == settings.admin_role or role.rsplit("/", 1)[-1] == settings.admin_role
        for role in roles
    )
    username = str(
        claims.get("preferred_username")
        or claims.get("name")
        or claims.get("email")
        or sub
    ).strip()[:120]
    display_name = str(claims.get("displayName") or claims.get("name") or username).strip()[:120]

    stmt = select(User).where(User.idp_issuer == issuer(), User.idp_sub == sub)
    user = db.scalars(stmt).first()
    created = False
    if user is None:
        user = User(
            idp_issuer=issuer(),
            idp_sub=sub,
            username=username,
            display_name=display_name,
            email=str(claims.get("email") or "").strip() or None,
            phone=str(claims.get("phone") or "").strip() or None,
            avatar_url=str(claims.get("avatar") or claims.get("picture") or "").strip() or None,
            roles=roles,
            groups=groups,
            is_admin=is_admin,
        )
        db.add(user)
        created = True
    else:
        if not user.display_name:
            user.display_name = display_name
        user.email = str(claims.get("email") or "").strip() or user.email
        user.phone = str(claims.get("phone") or "").strip() or user.phone
        if claims.get("avatar") or claims.get("picture"):
            user.avatar_url = str(claims.get("avatar") or claims.get("picture"))
        user.roles = roles
        user.groups = groups
        user.is_admin = is_admin
    user.last_login_at = utcnow()
    db.commit()
    db.refresh(user)
    return user


def set_password(access_token: str, owner: str, username: str, old_password: str, new_password: str) -> None:
    base = issuer()
    try:
        response = httpx.post(
            f"{base}/api/set-password",
            headers={"Authorization": f"Bearer {access_token}", "Accept-Language": "zh"},
            data={
                "userOwner": owner,
                "userName": username,
                "oldPassword": old_password,
                "newPassword": new_password,
            },
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="idp_password_change_failed") from exc
    if payload.get("status") != "ok":
        message = str(payload.get("msg") or "").lower()
        if "old password" in message or "oldpassword" in message:
            raise HTTPException(status_code=400, detail="invalid_old_password")
        raise HTTPException(status_code=400, detail="password_rejected")
