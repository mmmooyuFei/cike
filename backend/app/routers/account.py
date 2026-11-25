from __future__ import annotations

import io
import time
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import User
from ..oidc import set_password, update_user_admin, update_user_with_token, upload_avatar_with_token
from ..security import clear_session, current_user, decrypt_secret, is_admin, read_session, require_csrf, user_public

router = APIRouter(prefix="/api/account", tags=["account"])
MAX_AVATAR_BYTES = 5 * 1024 * 1024


@router.patch("/profile", dependencies=[Depends(require_csrf)])
def update_profile(payload: dict, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    display_name = str(payload.get("display_name") or "").strip()
    if not display_name or len(display_name) > 40:
        raise HTTPException(status_code=422, detail="invalid_display_name")
    gender = str(payload.get("gender") or "").strip()
    if gender not in {"", "male", "female"}:
        raise HTTPException(status_code=422, detail="invalid_gender")
    birthday_raw = str(payload.get("birthday") or "").strip()
    birthday: date | None = None
    if birthday_raw:
        try:
            birthday = date.fromisoformat(birthday_raw[:10])
        except ValueError as exc:
            raise HTTPException(status_code=422, detail="invalid_birthday") from exc
        if birthday > date.today():
            raise HTTPException(status_code=422, detail="invalid_birthday")
    user.display_name = display_name
    user.gender = gender or None
    user.birthday = birthday
    if not settings.dev_auth:
        session = read_session(request, db)
        owner = (session.idp_owner if session else "") or ""
        if not owner:
            raise HTTPException(status_code=409, detail="reauthorize_required")
        update_user_admin(f"{owner}/{user.username}", "displayName", display_name)
        update_user_admin(f"{owner}/{user.username}", "gender", {"male": "Male", "female": "Female"}.get(gender, ""))
        update_user_admin(f"{owner}/{user.username}", "birthday", birthday_raw)
    db.commit()
    db.refresh(user)
    return user_public(user)


@router.post("/avatar", dependencies=[Depends(require_csrf)])
async def upload_avatar(
    file: UploadFile,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    data = await file.read()
    if not data or len(data) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="avatar_too_large")
    try:
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image)
        image = image.convert("RGB")
        image.thumbnail((512, 512))
        buffer = io.BytesIO()
        image.save(buffer, "PNG")
        content = buffer.getvalue()
    except Exception as exc:
        raise HTTPException(status_code=422, detail="invalid_image") from exc
    if not settings.dev_auth:
        session = read_session(request, db)
        access = decrypt_secret(session.idp_access_token) if session else None
        owner = (session.idp_owner if session else "") or ""
        if not access or not owner:
            raise HTTPException(status_code=409, detail="reauthorize_required")
        avatar_url = upload_avatar_with_token(access, owner, user.username, content)
        update_user_with_token(access, f"{owner}/{user.username}", "avatar", avatar_url)
    target = settings.avatar_path / f"{user.id}.png"
    target.write_bytes(content)
    user.avatar_url = f"/api/account/avatar?v={int(time.time())}"
    db.commit()
    return {"avatar_url": user.avatar_url}


@router.get("/avatar")
def get_avatar(user: User = Depends(current_user)) -> FileResponse:
    target = settings.avatar_path / f"{user.id}.png"
    if not target.exists():
        raise HTTPException(status_code=404, detail="avatar_not_found")
    return FileResponse(target, media_type="image/png", headers={"Cache-Control": "private, max-age=300"})


@router.post("/password", dependencies=[Depends(require_csrf)])
def change_password(
    payload: dict,
    request: Request,
    response: Response,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    if settings.dev_auth:
        raise HTTPException(status_code=400, detail="dev_mode")
    old_password = str(payload.get("old_password") or "")
    new_password = str(payload.get("new_password") or "")
    if not old_password or len(new_password) < 12:
        raise HTTPException(status_code=422, detail="invalid_password")
    session = read_session(request, db)
    token = decrypt_secret(session.idp_access_token) if session else None
    if not token:
        raise HTTPException(status_code=409, detail="reauthorize_required")
    owner = (session.idp_owner if session else "") or ""
    if not owner:
        raise HTTPException(status_code=409, detail="reauthorize_required")
    set_password(token, owner, user.username, old_password, new_password)
    clear_session(db, request, response)
    return {"ok": True, "reauthorize_required": True}


@router.get("/capabilities")
def capabilities(user: User = Depends(current_user)) -> dict:
    return {
        "password": not settings.dev_auth,
        "avatar": True,
        "display_name": True,
        "gender": True,
        "birthday": True,
        "admin": is_admin(user),
    }
