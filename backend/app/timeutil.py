"""应用时区：所有“今天”都按 APP_TIMEZONE 计算，不依赖容器 TZ。

数据库时间仍以 naive UTC 存储（见 models.utcnow），只有面向用户的“今天/现在”走这里。
"""

from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

from .config import settings


def app_zone() -> ZoneInfo:
    try:
        return ZoneInfo(settings.app_timezone)
    except Exception:  # 时区名写错时退回上海，避免整个应用启动失败
        return ZoneInfo("Asia/Shanghai")


def app_now() -> datetime:
    return datetime.now(app_zone())


def app_today() -> date:
    return app_now().date()
