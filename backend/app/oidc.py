from __future__ import annotations

import base64
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
import jwt
from fastapi import HTTPException
from jwt import PyJWKClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models import AuthSession, OidcState, User, utcnow
from .security import decrypt_secret, encrypt_secret

_DISCOVERY: dict[str, dict] = {}
_JWK_CLIENTS: dict[str, PyJWKClient] = {}
_ADMIN_TOKEN: dict[str, object] = {"token": "", "expires_at": utcnow()}
_ROLES_CACHE: dict[str, tuple[datetime, list[dict]]] = {}
logger = logging.getLogger(__name__)


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


def _admin_token() -> str | None:
    if not settings.casdoor_admin_user or not settings.casdoor_admin_password:
        return None
    cached = str(_ADMIN_TOKEN.get("token") or "")
    expires_at = _ADMIN_TOKEN.get("expires_at")
    if cached and isinstance(expires_at, datetime) and expires_at > utcnow():
        return cached
    application = settings.casdoor_application or "app-built-in"
    try:
        with httpx.Client(timeout=15) as client:
            login = client.post(
                f"{issuer()}/api/login",
                json={
                    "organization": "built-in",
                    "username": settings.casdoor_admin_user,
                    "password": settings.casdoor_admin_password,
                    "autoSignin": True,
                    "application": application,
                    "type": "login",
                },
            )
            login.raise_for_status()
            payload = login.json()
            if payload.get("status") != "ok":
                logger.warning("casdoor admin login rejected")
                return None
            account = client.get(f"{issuer()}/api/get-account")
            account.raise_for_status()
            data = (account.json() or {}).get("data") or {}
            token = str(data.get("accessToken") or "").strip()
    except Exception as exc:
        logger.warning("casdoor admin login failed: %s", type(exc).__name__)
        return None
    if not token:
        return None
    _ADMIN_TOKEN["token"] = token
    _ADMIN_TOKEN["expires_at"] = utcnow() + timedelta(minutes=8)
    return token


def _admin_request(path: str, *, params=None, json_body=None) -> dict:
    token = _admin_token()
    if not token:
        raise HTTPException(status_code=503, detail="idp_admin_unavailable")
    try:
        response = httpx.post(
            f"{issuer()}{path}",
            params=params,
            json=json_body,
            headers={"Authorization": f"Bearer {token}", "Accept-Language": "zh"},
            timeout=15,
        )
        response.raise_for_status()
        return response.json()
    except Exception as exc:
        logger.warning("casdoor admin request failed: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="idp_admin_request_failed") from exc


def _list_roles(owner: str) -> list[dict] | None:
    cached = _ROLES_CACHE.get(owner)
    if cached and (utcnow() - cached[0]).total_seconds() < 60:
        return cached[1]
    token = _admin_token()
    if not token:
        return None
    try:
        response = httpx.get(
            f"{issuer()}/api/get-roles",
            params={"owner": owner},
            headers={"Authorization": f"Bearer {token}", "Accept-Language": "zh"},
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
        roles = payload.get("data")
        if payload.get("status") != "ok" or not isinstance(roles, list):
            return None
    except Exception:
        return None
    _ROLES_CACHE[owner] = (utcnow(), roles)
    return roles


def _resolved_roles(claims: dict) -> list[str]:
    roles = _names(claims.get("roles"))
    owner = str(claims.get("owner") or "").strip()
    username = str(claims.get("name") or claims.get("preferred_username") or "").strip()
    groups = _names(claims.get("groups"))
    if not owner or not username:
        return roles
    definitions = _list_roles(owner)
    if definitions is None:
        return roles
    user_ref = f"{owner}/{username}"
    short_groups = {group.rsplit("/", 1)[-1] for group in groups}
    resolved: list[str] = []
    for definition in definitions:
        users = [str(value) for value in (definition.get("users") or [])]
        role_groups = [str(value) for value in (definition.get("groups") or [])]
        if user_ref in users or any(group.rsplit("/", 1)[-1] in short_groups for group in role_groups):
            name = str(definition.get("name") or "")
            if name:
                resolved.append(name)
    return resolved if resolved else roles


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


def exchange_code(code: str, verifier: str, nonce: str = "") -> dict:
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
    except httpx.HTTPStatusError as exc:
        body = (exc.response.text or "")[:500]
        logger.warning(
            "oidc token exchange failed: status=%s body=%s",
            exc.response.status_code,
            body,
        )
        if "invalid_grant" in body:
            raise HTTPException(status_code=400, detail="oidc_code_expired") from exc
        raise HTTPException(status_code=502, detail="oidc_token_exchange_failed") from exc
    except Exception as exc:
        logger.warning("oidc token exchange failed: %s: %s", type(exc).__name__, exc)
        raise HTTPException(status_code=502, detail="oidc_token_exchange_failed") from exc
    if not token.get("access_token"):
        raise HTTPException(status_code=502, detail="oidc_token_exchange_failed")
    id_token = str(token.get("id_token") or "")
    if not id_token:
        raise HTTPException(status_code=502, detail="oidc_id_token_invalid")
    validate_id_token(id_token, nonce)
    return token


def validate_id_token(id_token: str, nonce: str = "") -> dict:
    data = _discovery()
    jwks_uri = str(data.get("jwks_uri") or "")
    if not jwks_uri:
        raise HTTPException(status_code=502, detail="oidc_id_token_invalid")
    client = _JWK_CLIENTS.get(jwks_uri)
    if client is None:
        client = PyJWKClient(jwks_uri, cache_jwk_set=True, lifespan=300, timeout=15)
        _JWK_CLIENTS[jwks_uri] = client
    try:
        signing_key = client.get_signing_key_from_jwt(id_token).key
        claims = jwt.decode(
            id_token,
            signing_key,
            algorithms=["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
            audience=settings.oidc_client_id,
            issuer=issuer(),
            options={"require": ["exp", "iat", "sub", "aud", "iss"]},
        )
    except Exception as exc:
        logger.warning("oidc id_token validation failed: %s: %s", type(exc).__name__, exc)
        raise HTTPException(status_code=502, detail="oidc_id_token_invalid") from exc
    if nonce and str(claims.get("nonce") or "") != nonce:
        logger.warning("oidc id_token nonce mismatch")
        raise HTTPException(status_code=502, detail="oidc_id_token_invalid")
    return claims


def token_expires_at(token: dict) -> datetime | None:
    expires_in = token.get("expires_in")
    if isinstance(expires_in, (int, float)) and expires_in > 0:
        return utcnow() + timedelta(seconds=int(expires_in))
    access = str(token.get("access_token") or "")
    if access:
        try:
            claims = jwt.decode(access, options={"verify_signature": False})
            exp = claims.get("exp")
            if isinstance(exp, (int, float)):
                return datetime.fromtimestamp(exp, tz=timezone.utc).replace(tzinfo=None)
        except Exception:
            pass
    return utcnow() + timedelta(hours=1)


def refresh_tokens(refresh_token: str) -> dict | None:
    if not refresh_token:
        return None
    data = _discovery()
    payload = {
        "grant_type": "refresh_token",
        "client_id": settings.oidc_client_id,
        "refresh_token": refresh_token,
    }
    if settings.oidc_client_secret:
        payload["client_secret"] = settings.oidc_client_secret
    try:
        response = httpx.post(data["token_endpoint"], data=payload, timeout=15)
        response.raise_for_status()
        token = response.json()
    except Exception as exc:
        logger.warning("oidc refresh failed: %s", type(exc).__name__)
        return None
    if not token.get("access_token"):
        return None
    return token


def logout_url() -> str:
    try:
        data = _discovery()
    except HTTPException:
        return ""
    endpoint = str(data.get("end_session_endpoint") or "")
    if not endpoint:
        return ""
    query = {"client_id": settings.oidc_client_id}
    if settings.oidc_post_logout_redirect_uri:
        query["post_logout_redirect_uri"] = settings.oidc_post_logout_redirect_uri
    separator = "&" if "?" in endpoint else "?"
    return f"{endpoint}{separator}{urlencode(query)}"


def _sync_avatar(user: User, claims: dict) -> None:
    source = str(claims.get("avatar") or claims.get("picture") or "").strip()
    if not source or source == user.avatar_url:
        return
    user.avatar_url = source
    try:
        (settings.avatar_path / f"{user.id}.png").unlink(missing_ok=True)
    except OSError:
        pass


def _apply_claims(user: User, claims: dict) -> None:
    # 身份字段缺失说明拿到的不是用户资料（例如 IdP 的错误信封），不要覆盖已有角色。
    if not (claims.get("sub") or claims.get("name") or claims.get("preferred_username")):
        return
    roles = _resolved_roles(claims)
    groups = _names(claims.get("groups"))
    user.roles = roles
    user.groups = groups
    user.is_admin = any(
        role == settings.admin_role or role.rsplit("/", 1)[-1] == settings.admin_role
        for role in roles
    )
    _sync_avatar(user, claims)


def _drop_session(db: Session, session: AuthSession) -> None:
    db.delete(session)
    db.commit()


def _refresh_session(db: Session, session: AuthSession) -> str | None:
    refresh = decrypt_secret(session.idp_refresh_token)
    token = refresh_tokens(refresh or "")
    if token is None:
        return None
    session.idp_access_token = encrypt_secret(str(token["access_token"]))
    if token.get("refresh_token"):
        session.idp_refresh_token = encrypt_secret(str(token["refresh_token"]))
    session.idp_token_expires_at = token_expires_at(token)
    db.commit()
    return str(token["access_token"])


def ensure_idp_session(db: Session, session: AuthSession, user: User) -> bool:
    """校验 IdP 会话；access token 过期时用 refresh token 续期。"""
    if user.idp_issuer == "dev":
        return True
    now = utcnow()
    access = decrypt_secret(session.idp_access_token)
    if not access and not decrypt_secret(session.idp_refresh_token):
        return False
    if session.idp_checked_at and (now - session.idp_checked_at).total_seconds() < settings.idp_check_interval_seconds:
        if not session.idp_token_expires_at or session.idp_token_expires_at > now + timedelta(seconds=60):
            return True
    if not access:
        access = _refresh_session(db, session)
        if not access:
            _drop_session(db, session)
            return False
    elif session.idp_token_expires_at and session.idp_token_expires_at <= now + timedelta(seconds=60):
        access = _refresh_session(db, session)
        if not access:
            _drop_session(db, session)
            return False
    try:
        claims = fetch_account(access)
    except HTTPException as exc:
        if exc.status_code == 401:
            access = _refresh_session(db, session)
            if not access:
                _drop_session(db, session)
                return False
            try:
                claims = fetch_account(access)
            except HTTPException:
                _drop_session(db, session)
                return False
        else:
            # IdP 暂时不可用时不强退本站会话，避免网络抖动导致全员掉线。
            session.idp_checked_at = utcnow()
            db.commit()
            return True
    _apply_claims(user, claims)
    if claims.get("owner"):
        session.idp_owner = str(claims.get("owner"))
    session.idp_checked_at = utcnow()
    db.commit()
    return True


def _account_payload(payload) -> dict | None:
    """Casdoor 的账号响应可能是 {status,msg,data} 信封，也可能直接是用户对象。"""
    if not isinstance(payload, dict):
        return None
    if payload.get("status") == "ok" and isinstance(payload.get("data"), dict):
        return payload["data"]
    if payload.get("sub"):
        return payload
    return None


def _is_auth_error(payload) -> bool:
    """Casdoor 有时用 HTTP 200 + status=error 表示 token 过期，需要按未认证处理。"""
    if not isinstance(payload, dict):
        return False
    message = str(payload.get("msg") or "").lower()
    return payload.get("status") == "error" and ("expired" in message or "login" in message or "token" in message)


def fetch_account(access_token: str) -> dict:
    base = issuer()
    headers = {"Authorization": f"Bearer {access_token}", "Accept-Language": "zh"}
    try:
        response = httpx.get(f"{base}/api/get-account", headers=headers, timeout=12)
        if response.status_code == 401:
            raise HTTPException(status_code=401, detail="idp_session_expired")
        if response.status_code == 200:
            payload = response.json()
            account = _account_payload(payload)
            if account is not None:
                return account
            if _is_auth_error(payload):
                # 200 + status=error 也是 token 失效：交给调用方刷新或重新登录，
                # 绝不能把错误包当成用户资料写库（会把角色/群组清空）。
                raise HTTPException(status_code=401, detail="idp_session_expired")
    except HTTPException:
        raise
    except Exception:
        pass
    data = _discovery()
    try:
        response = httpx.get(data["userinfo_endpoint"], headers=headers, timeout=12)
        if response.status_code == 401:
            raise HTTPException(status_code=401, detail="idp_session_expired")
        response.raise_for_status()
        payload = response.json()
        account = _account_payload(payload)
        if account is not None:
            return account
        if _is_auth_error(payload):
            raise HTTPException(status_code=401, detail="idp_session_expired")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail="oidc_userinfo_failed") from exc
    raise HTTPException(status_code=502, detail="oidc_userinfo_failed")


def upsert_user(db: Session, claims: dict) -> User:
    sub = str(claims.get("sub") or claims.get("id") or "").strip()
    if not sub:
        raise HTTPException(status_code=502, detail="oidc_subject_missing")
    owner = str(claims.get("owner") or "").strip()
    roles = _resolved_roles(claims)
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
        _sync_avatar(user, claims)
        user.roles = roles
        user.groups = groups
        user.is_admin = is_admin
    user.last_login_at = utcnow()
    db.commit()
    db.refresh(user)
    return user


def update_user_admin(user_ref: str, column: str, value: str) -> None:
    payload = _admin_request(
        "/api/update-user",
        params={"id": user_ref, "columns": column},
        json_body={column: value},
    )
    if payload.get("status") != "ok":
        message = str(payload.get("msg") or "").lower()
        if "unauthor" in message:
            raise HTTPException(status_code=403, detail="idp_forbidden")
        raise HTTPException(status_code=502, detail="idp_update_failed")


def update_user_with_token(access_token: str, user_ref: str, column: str, value: str) -> None:
    try:
        response = httpx.post(
            f"{issuer()}/api/update-user",
            params={"id": user_ref, "columns": column},
            json={column: value},
            headers={"Authorization": f"Bearer {access_token}", "Accept-Language": "zh"},
            timeout=15,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="idp_update_failed") from exc
    if payload.get("status") != "ok":
        message = str(payload.get("msg") or "").lower()
        if "unauthor" in message:
            raise HTTPException(status_code=403, detail="idp_forbidden")
        raise HTTPException(status_code=502, detail="idp_update_failed")


def upload_avatar_with_token(
    access_token: str,
    owner: str,
    username: str,
    content: bytes,
    content_type: str = "image/png",
) -> str:
    try:
        response = httpx.post(
            f"{issuer()}/api/upload-resource",
            params={
                "owner": owner,
                "user": username,
                "fullFilePath": f"avatar/{owner}/{username}.png",
                "tag": "avatar",
            },
            files={"file": (f"{username}.png", content, content_type)},
            headers={"Authorization": f"Bearer {access_token}", "Accept-Language": "zh"},
            timeout=20,
        )
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        raise HTTPException(status_code=502, detail="idp_avatar_upload_failed") from exc
    url = payload.get("data")
    if payload.get("status") != "ok" or not isinstance(url, str) or not url.strip():
        raise HTTPException(status_code=502, detail="idp_avatar_upload_failed")
    if url.startswith("/"):
        url = f"{issuer()}{url}"
    return url


def resolve_roles(claims: dict) -> list[str]:
    return _resolved_roles(claims)


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
