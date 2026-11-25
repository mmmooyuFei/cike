"""更新管理：查看运行版本、仓库状态、最近提交，并在挂载了仓库时执行拉取更新。

本项目的部署模型是「构建镜像 → 重建容器」（`scripts/update.sh`）。因此这个页面默认只做
**只读状态展示**：镜像里没有 git 仓库时，也能看到构建时写入的提交号；把仓库目录通过
`UPDATE_REPO_DIR` 挂进容器后，才会多出「检查远端」「拉取更新」两个动作。

安全约定：
- 全部接口要求管理员会话；写操作额外要求 CSRF。
- git 只以参数列表调用，不经过 shell；提交号先做十六进制校验。
- 回给页面的 git 文本统一抹掉 URL 里的凭据（`https://user:token@host`）。
- 「重启服务」默认关闭：容器没有 docker socket，进程退出能否回来取决于 restart 策略，
  必须显式设置 `UPDATE_ALLOW_RESTART=true` 才开放。
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..config import settings
from ..models import User
from ..security import require_admin, require_csrf
from ..timeutil import app_now

router = APIRouter(prefix="/api/update", tags=["update"])

GIT_TIMEOUT = 20.0
FETCH_TIMEOUT = 40.0
MAX_COMMITS = 30
COMMIT_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")
URL_CREDENTIALS = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@]+@")
SAFE_DIRECTORY = "safe.directory"


def _repo_root() -> Path | None:
    raw = (settings.update_repo_dir or "").strip()
    if not raw:
        return None
    path = Path(raw).expanduser()
    try:
        if not (path / ".git").exists():
            return None
    except OSError:
        return None
    return path


def _redact(text: str, limit: int = 400) -> str:
    cleaned = URL_CREDENTIALS.sub(r"\1", text or "").strip()
    cleaned = " ".join(cleaned.split())
    return cleaned[:limit]


def _git(root: Path, *args: str, timeout: float = GIT_TIMEOUT) -> tuple[int, str, str]:
    if shutil.which("git") is None:
        return 127, "", "git_not_available"
    argv = [
        "git",
        "-c",
        f"{SAFE_DIRECTORY}={root.as_posix()}",
        "-c",
        "core.quotepath=false",
        *args,
    ]
    try:
        done = subprocess.run(
            argv,
            cwd=str(root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return 1, "", str(exc)
    return done.returncode, done.stdout or "", done.stderr or ""


def _git_ok(root: Path, *args: str) -> str:
    code, out, _ = _git(root, *args)
    return out.strip() if code == 0 else ""


def _branch(root: Path) -> tuple[str, bool]:
    branch = _git_ok(root, "rev-parse", "--abbrev-ref", "HEAD")
    if branch and branch != "HEAD":
        return branch, False
    remote_head = _git_ok(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
    if remote_head.startswith("origin/"):
        return remote_head[len("origin/") :], True
    return "main", True


def _upstream(root: Path, branch: str) -> str:
    name = _git_ok(root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    return name or f"origin/{branch}"


def _ahead_behind(root: Path, upstream: str) -> dict[str, int] | None:
    code, out, _ = _git(root, "rev-list", "--left-right", "--count", f"HEAD...{upstream}")
    if code != 0:
        return None
    parts = out.split()
    if len(parts) != 2:
        return None
    try:
        return {"ahead": int(parts[0]), "behind": int(parts[1])}
    except ValueError:
        return None


def _commit_row(root: Path, raw: str, current: str) -> dict[str, Any] | None:
    fields = raw.split("\x1f")
    if len(fields) < 5:
        return None
    short, full, day, author, subject = fields[:5]
    return {
        "hash": full,
        "short": short,
        "date": day,
        "author": author,
        "subject": _redact(subject, 200),
        "current": full.startswith(current) if current else False,
    }


def _repo_state() -> dict[str, Any]:
    root = _repo_root()
    if root is None:
        return {
            "available": False,
            "path": "",
            "reason": "repo_not_mounted" if not (settings.update_repo_dir or "").strip() else "repo_path_invalid",
        }
    code, _, stderr = _git(root, "rev-parse", "--show-toplevel")
    if code != 0:
        return {
            "available": False,
            "path": str(root),
            "reason": "not_a_git_repository",
            "output": _redact(stderr),
        }
    branch, detached = _branch(root)
    commit = _git_ok(root, "rev-parse", "HEAD")
    subject = _git_ok(root, "log", "-1", "--pretty=format:%s")
    commit_date = _git_ok(root, "log", "-1", "--date=short", "--pretty=format:%ad")
    author = _git_ok(root, "log", "-1", "--pretty=format:%an")
    status_text = _git_ok(root, "status", "--porcelain")
    remote = _git_ok(root, "remote", "get-url", "origin")
    upstream = _upstream(root, branch)
    return {
        "available": True,
        "path": str(root),
        "branch": branch,
        "detached": detached,
        "commit": commit,
        "commit_short": commit[:8],
        "subject": _redact(subject, 200),
        "date": commit_date,
        "author": author,
        "dirty": bool(status_text),
        "dirty_files": len([line for line in status_text.splitlines() if line.strip()]),
        "remote": _redact(remote),
        "upstream": upstream,
        "sync": _ahead_behind(root, upstream),
    }


def _status_payload() -> dict[str, Any]:
    repo = _repo_state()
    running = (settings.app_git_commit or "").strip()
    hint: str | None = None
    if repo.get("available") and running and repo.get("commit"):
        if not str(repo["commit"]).startswith(running):
            hint = "running_commit_differs"
    elif not repo.get("available"):
        hint = "repo_not_mounted"
    root = _repo_root()
    writable = bool(root is not None and os.access(root / ".git", os.W_OK))
    if repo.get("available") and not writable:
        hint = "repo_readonly"
    return {
        "running": {
            "commit": running,
            "commit_short": running[:8],
            "deployment": "docker" if Path("/.dockerenv").exists() else "host",
        },
        "repo": repo,
        "hint": hint,
        "capabilities": {
            "fetch": bool(repo.get("available")) and writable and shutil.which("git") is not None,
            "pull": bool(repo.get("available")) and writable and shutil.which("git") is not None,
            "restart": bool(settings.update_allow_restart),
        },
        "commands": {
            "update": "bash scripts/update.sh",
            "health": "curl -fsS http://127.0.0.1:9543/api/health",
            "enable_repo": "在 docker-compose.yml 里挂载仓库并设置 UPDATE_REPO_DIR",
        },
        "checked_at": app_now().isoformat(timespec="seconds"),
    }


@router.get("/status")
def status(admin: User = Depends(require_admin)) -> dict:
    return _status_payload()


@router.get("/commits")
def commits(limit: int = 15, admin: User = Depends(require_admin)) -> dict:
    root = _repo_root()
    if root is None:
        raise HTTPException(status_code=409, detail="repo_not_mounted")
    if not 1 <= limit <= MAX_COMMITS:
        limit = MAX_COMMITS
    branch, _ = _branch(root)
    upstream = _upstream(root, branch)
    current = _git_ok(root, "rev-parse", "HEAD")
    code, out, stderr = _git(
        root,
        "log",
        f"-n{limit}",
        "--date=short",
        "--pretty=format:%h%x1f%H%x1f%ad%x1f%an%x1f%s",
        upstream,
    )
    if code != 0:
        raise HTTPException(status_code=409, detail=f"git_log_failed: {_redact(stderr, 200)}")
    items = [row for row in (_commit_row(root, line, current) for line in out.splitlines() if line.strip()) if row]
    return {"branch": branch, "upstream": upstream, "current": current[:8], "items": items}


@router.post("/fetch", dependencies=[Depends(require_csrf)])
def fetch(admin: User = Depends(require_admin)) -> dict:
    root = _repo_root()
    if root is None:
        raise HTTPException(status_code=409, detail="repo_not_mounted")
    started = time.time()
    code, _, stderr = _git(root, "fetch", "--prune", "origin", timeout=FETCH_TIMEOUT)
    if code != 0:
        raise HTTPException(status_code=409, detail=f"fetch_failed: {_redact(stderr)}")
    branch, _ = _branch(root)
    upstream = _upstream(root, branch)
    return {
        "ok": True,
        "seconds": round(time.time() - started, 1),
        "sync": _ahead_behind(root, upstream),
        "status": _status_payload(),
    }


@router.post("/pull", dependencies=[Depends(require_csrf)])
def pull(admin: User = Depends(require_admin)) -> dict:
    root = _repo_root()
    if root is None:
        raise HTTPException(status_code=409, detail="repo_not_mounted")
    before = _git_ok(root, "rev-parse", "HEAD")
    code, out, stderr = _git(root, "pull", "--ff-only", timeout=FETCH_TIMEOUT)
    if code != 0:
        raise HTTPException(status_code=409, detail=f"pull_failed: {_redact(stderr or out)}")
    after = _git_ok(root, "rev-parse", "HEAD")
    return {
        "ok": True,
        "before": before[:8],
        "after": after[:8],
        "changed": before != after,
        "output": _redact(out, 800),
        "restart_required": before != after,
        "status": _status_payload(),
    }


@router.post("/restart", dependencies=[Depends(require_csrf)])
def restart(admin: User = Depends(require_admin)) -> dict:
    if not settings.update_allow_restart:
        raise HTTPException(status_code=409, detail="restart_disabled")

    def _exit() -> None:
        time.sleep(1.0)
        os._exit(0)

    threading.Thread(target=_exit, daemon=True).start()
    return {"ok": True, "message": "服务将在 1 秒后退出，依赖 restart 策略自动拉起"}
