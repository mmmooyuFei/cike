"""更新管理：查看运行版本、仓库状态、最近提交，并在挂载了仓库时执行「拉取 → 自动安全重建」。

本项目的部署模型是「构建镜像 → 重建容器」（`scripts/update.sh`）。重建不能由应用容器自己
执行：`docker compose up -d` 会重建应用所在的容器，把它自己的执行进程一起杀掉。所以这里
采用「宿主执行器」模型：

1. 应用只负责 `git pull`，然后在数据目录落一个唤醒文件 `update-wake/request.json`；
2. 宿主机的 systemd path 单元（`scripts/install-update-runner.sh` 安装）发现唤醒文件，
   由 `scripts/update-dispatch.sh` 在容器之外执行 `scripts/update.sh`：
   备份数据库 → 构建镜像 → 重建容器 → 健康检查，失败回滚上一镜像；
3. 执行器把过程写进 `update-status.json` / `update.log`，页面轮询它显示进度与结果。

没有安装宿主执行器时（数据目录里没有 `update-runner.json`），页面只保留只读状态与拉取，
并提示安装命令——不会假装能重建。

安全约定：
- 全部接口要求管理员会话；写操作额外要求 CSRF。
- git 只以参数列表调用，不经过 shell；提交号先做十六进制校验。
- 回给页面的 git 文本统一抹掉 URL 里的凭据（`https://user:token@host`）。
- 应用不接触 docker socket：重建权限留在宿主机，应用最多只能落一个唤醒文件。
- 「重启服务」默认关闭：必须显式设置 `UPDATE_ALLOW_RESTART=true` 才开放。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

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

# 宿主执行器约定（都在数据目录里，容器与宿主机通过挂载共享）
WAKE_DIR = "update-wake"
STATUS_NAME = "update-status.json"
RUNNER_NAME = "update-runner.json"
LOG_NAME = "update.log"
STATUS_STATES = {"queued", "running", "success", "failed"}


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


def _ahead_rows(root: Path, upstream: str, limit: int = 10) -> list[dict[str, Any]]:
    """本地领先远端的提交：部署机上出现这种提交通常意味着有人直接改了服务器。"""
    code, out, _ = _git(
        root,
        "log",
        f"-n{limit}",
        "--date=short",
        "--pretty=format:%h%x1f%H%x1f%ad%x1f%an%x1f%s",
        f"{upstream}..HEAD",
    )
    if code != 0:
        return []
    rows: list[dict[str, Any]] = []
    for line in out.splitlines():
        if not line.strip():
            continue
        fields = line.split("\x1f")
        if len(fields) < 5:
            continue
        short, full, day, author, subject = fields[:5]
        rows.append(
            {
                "hash": full,
                "short": short,
                "date": day,
                "author": author,
                "subject": _redact(subject, 200),
            }
        )
    return rows


def _data_dir() -> Path:
    return settings.data_path


def _data_file(name: str) -> Path:
    return _data_dir() / name


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_json(path: Path, payload: dict[str, Any]) -> bool:
    tmp = path.with_name(f".{path.name}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        return False
    return True


def _redact_log(text: str, limit: int = 2000) -> str:
    cleaned = URL_CREDENTIALS.sub(r"\1", (text or "").replace("\r\n", "\n"))
    return cleaned[-limit:]


def _runner_state() -> dict[str, Any]:
    """宿主机侧的重建执行器是否已安装（安装脚本会写 update-runner.json）。"""
    marker = _data_file(RUNNER_NAME)
    payload = _read_json(marker)
    return {
        "installed": marker.is_file() and bool(payload),
        "name": _redact(str(payload.get("runner") or ""), 60),
        "installed_at": str(payload.get("installed_at") or ""),
    }


def _rebuild_available() -> bool:
    return bool(settings.update_allow_rebuild) and _runner_state()["installed"] and os.access(_data_dir(), os.W_OK)


def _rebuild_state() -> dict[str, Any]:
    """执行器写下的进度；服务重启后仍然可读，页面据此显示结果。"""
    payload = _read_json(_data_file(STATUS_NAME))
    state = str(payload.get("state") or "idle")
    if state not in STATUS_STATES:
        state = "idle"
    duration = payload.get("duration_s")
    return {
        "state": state,
        "from": _redact(str(payload.get("from") or ""), 40),
        "to": _redact(str(payload.get("to") or ""), 40),
        "trigger": _redact(str(payload.get("trigger") or ""), 40),
        "requested_at": str(payload.get("requested_at") or ""),
        "started_at": str(payload.get("started_at") or ""),
        "finished_at": str(payload.get("finished_at") or ""),
        "duration_s": duration if isinstance(duration, (int, float)) else None,
        "error": _redact(str(payload.get("error") or ""), 200),
        "log_tail": _redact_log(_tail(_data_file(LOG_NAME))),
    }


def _tail(path: Path, limit: int = 2000) -> str:
    try:
        if not path.is_file():
            return ""
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit * 4))
            return handle.read().decode("utf-8", errors="replace")[-limit:]
    except OSError:
        return ""


def _queue_rebuild(reason: str, target: str, source_commit: str) -> dict[str, Any]:
    """落唤醒文件，交给宿主机执行器重建；应用本身不碰 docker。"""
    if not _rebuild_available():
        return {"queued": False, "reason": "rebuild_unavailable"}
    stamp = app_now().isoformat(timespec="seconds")
    request = {
        "state": "queued",
        "from": source_commit[:8],
        "to": target[:8],
        "trigger": "web",
        "reason": reason,
        "requested_at": stamp,
    }
    if not _write_json(_data_file(STATUS_NAME), request):
        return {"queued": False, "reason": "status_write_failed"}
    wake = _write_json(_data_dir() / WAKE_DIR / "request.json", request)
    if not wake:
        return {"queued": False, "reason": "wake_write_failed"}
    return {"queued": True, "reason": reason}


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
    sync = _ahead_behind(root, upstream)
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
        "sync": sync,
        # 部署机上不该出现本地提交：领先远端时列出来，页面据此提示「先推回仓库」或「对齐远端」
        "local_commits": _ahead_rows(root, upstream) if (sync or {}).get("ahead") else [],
        "diverged": bool((sync or {}).get("ahead") and (sync or {}).get("behind")),
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
        "rebuild": {**_rebuild_state(), "available": _rebuild_available(), "runner": _runner_state()},
        "capabilities": {
            "fetch": bool(repo.get("available")) and writable and shutil.which("git") is not None,
            "pull": bool(repo.get("available")) and writable and shutil.which("git") is not None,
            "rebuild": _rebuild_available(),
            "restart": bool(settings.update_allow_restart),
        },
        "commands": {
            "update": "bash scripts/update.sh",
            "install_runner": "sudo bash scripts/install-update-runner.sh",
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


def _outdated(repo_commit: str, running_commit: str) -> bool:
    if not repo_commit:
        return False
    return not (bool(running_commit) and repo_commit.startswith(running_commit))


class PullRequest(BaseModel):
    """ff：只快进（默认）；rebase：保留本地提交并变基；reset：直接对齐远端。"""

    mode: str = "ff"


def _diverged_result(root: Path, upstream: str, output: str) -> dict[str, Any]:
    """分叉不是错误，是一个要人来决定的状态：本地提交要保留还是丢。"""
    sync = _ahead_behind(root, upstream) or {}
    return {
        "ok": False,
        "reason": "diverged",
        "ahead": sync.get("ahead", 0),
        "behind": sync.get("behind", 0),
        "local_commits": _ahead_rows(root, upstream),
        "output": _redact(output, 400),
        "status": _status_payload(),
    }


@router.post("/pull", dependencies=[Depends(require_csrf)])
def pull(payload: PullRequest | None = None, admin: User = Depends(require_admin)) -> dict:
    """拉取代码；只要仓库 HEAD 与运行版本不一致就自动排队重建。

    默认只允许快进。分叉（本地有未推送提交）时不擅自 reset，而是把两边的情况回给页面，
    由人选择 rebase（保留本地提交）或 reset（以远端为准）。
    """
    mode = ((payload.mode if payload else "") or "ff").strip().lower()
    if mode not in {"ff", "rebase", "reset"}:
        raise HTTPException(status_code=400, detail="invalid_pull_mode")
    root = _repo_root()
    if root is None:
        raise HTTPException(status_code=409, detail="repo_not_mounted")
    branch, _ = _branch(root)
    upstream = _upstream(root, branch)
    before = _git_ok(root, "rev-parse", "HEAD")

    if mode == "reset":
        code, out, stderr = _git(root, "fetch", "--prune", "origin", timeout=FETCH_TIMEOUT)
        if code != 0:
            raise HTTPException(status_code=409, detail=f"fetch_failed: {_redact(stderr or out)}")
        discarded = _ahead_rows(root, upstream)
        code, out2, stderr2 = _git(root, "reset", "--hard", upstream)
        if code != 0:
            raise HTTPException(status_code=409, detail=f"reset_failed: {_redact(stderr2 or out2)}")
        out = f"{out}\n{out2}"
        if discarded:
            dropped = "、".join(row["short"] for row in discarded)
            out = f"{out}\n已丢弃本地提交：{dropped}"
    elif mode == "rebase":
        code, out, stderr = _git(root, "pull", "--rebase", "--autostash", timeout=FETCH_TIMEOUT)
        if code != 0:
            _git(root, "rebase", "--abort")
            return {
                "ok": False,
                "reason": "rebase_conflict",
                "output": _redact(stderr or out, 400),
                "status": _status_payload(),
            }
    else:
        code, out, stderr = _git(root, "pull", "--ff-only", timeout=FETCH_TIMEOUT)
        if code != 0:
            # 先刷新远端引用，再看看到底是分叉还是别的原因
            _git(root, "fetch", "--prune", "origin", timeout=FETCH_TIMEOUT)
            sync = _ahead_behind(root, upstream) or {}
            if sync.get("ahead") and sync.get("behind"):
                return _diverged_result(root, upstream, stderr or out)
            raise HTTPException(status_code=409, detail=f"pull_failed: {_redact(stderr or out)}")

    after = _git_ok(root, "rev-parse", "HEAD")
    running = (settings.app_git_commit or "").strip()
    rebuild: dict[str, Any] = {"queued": False, "reason": "already_running"}
    if _outdated(after, running):
        rebuild = _queue_rebuild("pull", after, running)
    return {
        "ok": True,
        "mode": mode,
        "before": before[:8],
        "after": after[:8],
        "changed": before != after,
        "output": _redact(out, 800),
        "restart_required": _outdated(after, running),
        "rebuild": rebuild,
        "status": _status_payload(),
    }


@router.post("/rebuild", dependencies=[Depends(require_csrf)])
def rebuild(admin: User = Depends(require_admin)) -> dict:
    """仓库已是最新但镜像仍旧时，单独排一次安全重建。"""
    root = _repo_root()
    if root is None:
        raise HTTPException(status_code=409, detail="repo_not_mounted")
    head = _git_ok(root, "rev-parse", "HEAD")
    running = (settings.app_git_commit or "").strip()
    if not _outdated(head, running):
        return {
            "ok": True,
            "queued": False,
            "reason": "already_running",
            "rebuild": {"queued": False, "reason": "already_running"},
            "status": _status_payload(),
        }
    result = _queue_rebuild("manual", head, running)
    return {"ok": bool(result.get("queued")), "queued": result.get("queued", False), **result, "status": _status_payload()}


@router.post("/restart", dependencies=[Depends(require_csrf)])
def restart(admin: User = Depends(require_admin)) -> dict:
    if not settings.update_allow_restart:
        raise HTTPException(status_code=409, detail="restart_disabled")

    def _exit() -> None:
        time.sleep(1.0)
        os._exit(0)

    threading.Thread(target=_exit, daemon=True).start()
    return {"ok": True, "message": "服务将在 1 秒后退出，依赖 restart 策略自动拉起"}
