from __future__ import annotations

import io
import time

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import FileResponse
from PIL import Image, ImageOps
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import AppSetting, User
from ..security import require_admin, require_csrf

router = APIRouter(prefix="/api/settings", tags=["settings"])


def get_brand(db: Session) -> dict:
    row = db.get(AppSetting, "brand")
    value = row.value if row and isinstance(row.value, dict) else {}
    subtitle = value.get("subtitle")
    return {
        "name": str(value.get("name") or settings.brand_default_name),
        "subtitle": settings.brand_default_subtitle if subtitle is None else str(subtitle),
        "logo_url": str(value.get("logo_url") or ""),
        "default_name": settings.brand_default_name,
        "default_subtitle": settings.brand_default_subtitle,
    }


def save_brand(db: Session, value: dict) -> dict:
    row = db.get(AppSetting, "brand")
    if row is None:
        row = AppSetting(key="brand", value=value)
        db.add(row)
    else:
        row.value = value
    db.commit()
    return get_brand(db)


@router.get("/brand")
def brand(db: Session = Depends(get_db)) -> dict:
    return get_brand(db)


@router.put("/brand", dependencies=[Depends(require_csrf)])
def update_brand(payload: dict, admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict:
    name = str(payload.get("name") or "").strip()
    if not name or len(name) > 12:
        raise HTTPException(status_code=422, detail="invalid_brand_name")
    subtitle = str(payload.get("subtitle") or "").strip()
    if len(subtitle) > 24:
        raise HTTPException(status_code=422, detail="invalid_brand_subtitle")
    current = get_brand(db)
    return save_brand(db, {"name": name, "subtitle": subtitle, "logo_url": current["logo_url"]})


@router.post("/brand/logo", dependencies=[Depends(require_csrf)])
async def upload_brand_logo(
    file: UploadFile,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    data = await file.read()
    if not data or len(data) > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="logo_too_large")
    try:
        image = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
        # 保留 alpha 通道：透明底 LOGO 不要压成黑底或白底
        image = image.convert("RGBA")
        image.thumbnail((512, 512))
        target = settings.brand_path / "logo.png"
        image.save(target, "PNG")
    except Exception as exc:
        raise HTTPException(status_code=422, detail="invalid_image") from exc
    current = get_brand(db)
    current["logo_url"] = f"/api/settings/brand/logo?v={int(time.time())}"
    return save_brand(db, current)


@router.get("/brand/logo")
def brand_logo() -> FileResponse:
    target = settings.brand_path / "logo.png"
    if not target.exists():
        raise HTTPException(status_code=404, detail="logo_not_found")
    return FileResponse(target, media_type="image/png", headers={"Cache-Control": "public, max-age=300"})
