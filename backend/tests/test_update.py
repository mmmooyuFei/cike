"""更新管理：拉取后自动重建的排队、执行器标记与状态解析。

重建本身由宿主机 systemd 执行器完成，这里只覆盖应用侧的约定：
唤醒文件格式、执行器未安装时不假装能重建、状态文件读回，
以及「部署机上有本地提交」导致的分叉要交给人决定，而不是静默 reset。
"""

import json
import subprocess
from pathlib import Path

IDENTITY = ["-c", "user.name=cike-test", "-c", "user.email=cike@test.local"]


def _module():
    from app.routers import update as module

    return module


def _use_data_dir(monkeypatch, tmp_path):
    module = _module()
    monkeypatch.setattr(module.settings, "data_dir", str(tmp_path))
    monkeypatch.setattr(module.settings, "update_allow_rebuild", True)
    return module


def _git(cwd, *args):
    done = subprocess.run(
        ["git", *IDENTITY, *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert done.returncode == 0, f"git {' '.join(args)} failed: {done.stderr}"
    return done.stdout


def test_rebuild_unavailable_without_runner_marker(tmp_path, monkeypatch):
    module = _use_data_dir(monkeypatch, tmp_path)

    assert module._runner_state()["installed"] is False
    assert module._rebuild_available() is False
    result = module._queue_rebuild("pull", "abcdef123456", "1234567")
    assert result == {"queued": False, "reason": "rebuild_unavailable"}
    assert not (tmp_path / "update-wake").exists()


def test_rebuild_disabled_by_setting(tmp_path, monkeypatch):
    module = _use_data_dir(monkeypatch, tmp_path)
    (tmp_path / "update-runner.json").write_text(json.dumps({"runner": "systemd-path"}), encoding="utf-8")
    monkeypatch.setattr(module.settings, "update_allow_rebuild", False)

    assert module._rebuild_available() is False


def test_queue_rebuild_writes_wake_and_status(tmp_path, monkeypatch):
    module = _use_data_dir(monkeypatch, tmp_path)
    (tmp_path / "update-runner.json").write_text(
        json.dumps({"runner": "systemd-path", "installed_at": "2026-11-26T20:00:00+08:00"}),
        encoding="utf-8",
    )

    result = module._queue_rebuild("pull", "abcdef123456", "dab2914")

    assert result["queued"] is True
    wake = json.loads((tmp_path / "update-wake" / "request.json").read_text(encoding="utf-8"))
    assert wake["from"] == "dab2914"
    assert wake["to"] == "abcdef12"
    state = module._rebuild_state()
    assert state["state"] == "queued"
    assert state["trigger"] == "web"


def test_rebuild_state_reads_runner_report(tmp_path, monkeypatch):
    module = _use_data_dir(monkeypatch, tmp_path)
    (tmp_path / "update-status.json").write_text(
        json.dumps(
            {
                "state": "failed",
                "from": "dab2914",
                "to": "5b4752f",
                "trigger": "web",
                "finished_at": "2026-11-26T20:10:00+08:00",
                "duration_s": 91.2,
                "error": "healthcheck_failed",
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "update.log").write_text("line-1\nline-2\n", encoding="utf-8")

    state = module._rebuild_state()

    assert state["state"] == "failed"
    assert state["error"] == "healthcheck_failed"
    assert state["duration_s"] == 91.2
    assert "line-1" in state["log_tail"]


def test_rebuild_state_ignores_unknown_state(tmp_path, monkeypatch):
    module = _use_data_dir(monkeypatch, tmp_path)
    (tmp_path / "update-status.json").write_text(json.dumps({"state": "exploded"}), encoding="utf-8")

    assert module._rebuild_state()["state"] == "idle"


def test_redact_log_keeps_lines_and_hides_credentials():
    module = _module()
    text = "Cloning into 'https://user:token@example.com/repo.git'...\nDone\n"
    cleaned = module._redact_log(text)

    assert "token" not in cleaned
    assert "https://example.com/repo.git" in cleaned
    assert "Done" in cleaned


def test_outdated_compares_short_running_commit():
    module = _module()

    assert module._outdated("abcdef123456", "abcdef12") is False
    assert module._outdated("abcdef123456", "9999999") is True
    assert module._outdated("abcdef123456", "") is True
    assert module._outdated("", "dab2914") is False


def test_update_status_exposes_rebuild_block(client, tmp_path, monkeypatch):
    from conftest import login

    _use_data_dir(monkeypatch, tmp_path)
    login(client, "admin")

    body = client.get("/api/update/status").json()

    assert body["rebuild"]["available"] is False
    assert body["rebuild"]["state"] == "idle"
    assert body["rebuild"]["runner"]["installed"] is False
    assert body["capabilities"]["rebuild"] is False
    assert "install-update-runner.sh" in body["commands"]["install_runner"]


def test_update_status_requires_admin(client):
    response = client.get("/api/update/status")

    assert response.status_code in (401, 403)


def _diverged_repo(tmp_path: Path) -> Path:
    """部署机上一个本地提交 + 远端一个新提交的典型分叉现场。"""
    origin = tmp_path / "origin.git"
    work = tmp_path / "work"
    other = tmp_path / "other"
    _git(tmp_path, "init", "--bare", "-b", "main", str(origin))
    _git(tmp_path, "clone", str(origin), str(work))
    (work / "base.txt").write_text("base", encoding="utf-8")
    _git(work, "add", "-A")
    _git(work, "commit", "-m", "base commit")
    _git(work, "push", "origin", "HEAD:main")

    (work / "local.txt").write_text("直接在服务器上改的", encoding="utf-8")
    _git(work, "add", "-A")
    _git(work, "commit", "-m", "local-only change")

    _git(tmp_path, "clone", str(origin), str(other))
    (other / "remote.txt").write_text("remote", encoding="utf-8")
    _git(other, "add", "-A")
    _git(other, "commit", "-m", "remote-only change")
    _git(other, "push", "origin", "HEAD:main")

    _git(work, "fetch", "origin")
    return work


def test_pull_reports_diverged_instead_of_failing_raw(client, tmp_path, monkeypatch):
    from conftest import login

    work = _diverged_repo(tmp_path)
    module = _use_data_dir(monkeypatch, tmp_path / "data")
    monkeypatch.setattr(module.settings, "update_repo_dir", str(work))
    headers = login(client, "admin")

    response = client.post("/api/update/pull", headers=headers, json={"mode": "ff"})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is False
    assert body["reason"] == "diverged"
    assert body["ahead"] == 1
    assert body["behind"] == 1
    assert body["local_commits"][0]["subject"] == "local-only change"
    assert "fatal" not in body["output"].lower() or "diverg" in body["output"].lower()
    # 分叉时不能擅自改历史：工作树还留着本地提交
    assert _git(work, "log", "-1", "--pretty=%s").strip() == "local-only change"


def test_pull_reset_aligns_to_remote_and_reports_discarded(client, tmp_path, monkeypatch):
    from conftest import login

    work = _diverged_repo(tmp_path)
    module = _use_data_dir(monkeypatch, tmp_path / "data")
    monkeypatch.setattr(module.settings, "update_repo_dir", str(work))
    headers = login(client, "admin")

    body = client.post("/api/update/pull", headers=headers, json={"mode": "reset"}).json()

    assert body["ok"] is True
    assert "已丢弃本地提交" in body["output"]
    assert _git(work, "log", "-1", "--pretty=%s").strip() == "remote-only change"
    # 部署机按执行器的报告判断是否需要重建，这里执行器没装所以只排队失败
    assert body["rebuild"]["queued"] is False


def test_pull_rejects_unknown_mode(client, tmp_path, monkeypatch):
    from conftest import login

    work = _diverged_repo(tmp_path)
    module = _use_data_dir(monkeypatch, tmp_path / "data")
    monkeypatch.setattr(module.settings, "update_repo_dir", str(work))
    headers = login(client, "admin")

    response = client.post("/api/update/pull", headers=headers, json={"mode": "force"})

    assert response.status_code == 400
