from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    database_url: str = "sqlite:///./cike.db"
    session_secret: str = "dev-only-change-me"
    cookie_secure: bool = True
    dev_auth: bool = False

    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_redirect_uri: str = ""
    oidc_scopes: str = "openid profile email"
    oidc_pkce: bool = True
    oidc_display_name: str = "统一登录"
    oidc_auto_login: bool = True
    oidc_post_logout_redirect_uri: str = ""
    idp_check_interval_seconds: int = 300
    admin_role: str = "admin"

    casdoor_admin_user: str = ""
    casdoor_admin_password: str = ""
    casdoor_application: str = ""

    brand_default_name: str = "此刻"
    brand_default_subtitle: str = "笔记 · 备忘录"
    app_timezone: str = "Asia/Shanghai"
    data_dir: str = "data"

    # 更新管理：``app_git_commit`` 由构建参数写入；``update_repo_dir`` 挂载仓库后才可在线拉取
    app_git_commit: str = ""
    update_repo_dir: str = ""
    update_allow_restart: bool = False

    @property
    def data_path(self) -> Path:
        path = Path(self.data_dir)
        if not path.is_absolute():
            path = Path.cwd() / path
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def avatar_path(self) -> Path:
        path = self.data_path / "avatars"
        path.mkdir(parents=True, exist_ok=True)
        return path

    @property
    def brand_path(self) -> Path:
        path = self.data_path / "brand"
        path.mkdir(parents=True, exist_ok=True)
        return path


settings = Settings()
