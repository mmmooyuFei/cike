from __future__ import annotations

from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db, init_db
from .models import AppSetting
from .routers import access, account, auth, export, modules, overview, reviews, settings as settings_router

APP_DIR = Path(__file__).resolve().parents[2]
DIST_DIR = APP_DIR / "frontend" / "dist"


def seed_defaults() -> None:
    db = next(get_db())
    try:
        row = db.get(AppSetting, "brand")
        if row is None:
            db.add(AppSetting(key="brand", value={"name": settings.brand_default_name, "logo_url": ""}))
            db.commit()
    finally:
        db.close()


def create_app() -> FastAPI:
    app = FastAPI(title="此刻 API", version="1.0.0", docs_url=None, redoc_url=None)

    app.include_router(auth.router)
    app.include_router(account.router)
    app.include_router(settings_router.router)
    app.include_router(access.router)
    app.include_router(overview.router)
    app.include_router(reviews.router)
    app.include_router(modules.router)
    app.include_router(export.router)

    @app.get("/api/health")
    def health(db: Session = Depends(get_db)) -> dict:
        db.execute(text("SELECT 1"))
        return {"status": "ok"}

    @app.on_event("startup")
    def on_startup() -> None:
        init_db()
        seed_defaults()

    if DIST_DIR.exists():
        app.mount("/assets", StaticFiles(directory=DIST_DIR / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str) -> FileResponse:
            if full_path.startswith("api/"):
                raise HTTPException(status_code=404, detail="not_found")
            target = DIST_DIR / full_path
            if full_path and target.is_file():
                return FileResponse(target)
            return FileResponse(DIST_DIR / "index.html")

    else:

        @app.get("/", include_in_schema=False)
        def root() -> dict:
            return {"app": "cike", "status": "frontend_not_built"}

    return app


app = create_app()
