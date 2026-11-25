from io import BytesIO

from conftest import login
from PIL import Image


def test_dev_login_and_isolation(client):
    headers = login(client, "user")
    created = client.post(
        "/api/data/todos",
        json={"title": "只属于用户一的事", "priority": "P0"},
        headers=headers,
    )
    assert created.status_code == 200, created.text
    todo_id = created.json()["item"]["id"]
    assert client.get("/api/data/todos").json()["total"] == 1

    admin_headers = login(client, "admin")
    assert client.get("/api/data/todos").json()["total"] == 0
    assert client.patch(f"/api/data/todos/{todo_id}", json={"title": "越权"}, headers=admin_headers).status_code == 404
    assert client.delete(f"/api/data/todos/{todo_id}", headers=admin_headers).status_code == 404


def test_soft_delete_and_restore(client):
    headers = login(client)
    item = client.post("/api/data/todos", json={"title": "可撤销"}, headers=headers).json()["item"]
    assert client.delete(f"/api/data/todos/{item['id']}", headers=headers).status_code == 200
    assert client.get("/api/data/todos").json()["total"] == 0
    restored = client.post(f"/api/data/todos/{item['id']}/restore", headers=headers)
    assert restored.status_code == 200
    assert client.get("/api/data/todos").json()["total"] == 1


def test_money_upsert_and_net(client):
    headers = login(client)
    first = client.post(
        "/api/data/money",
        json={"month": "2026-11-01", "account": "支付宝", "opening": 100, "closing": 150},
        headers=headers,
    )
    assert first.status_code == 200, first.text
    assert first.json()["item"]["net"] == 50
    second = client.post(
        "/api/data/money",
        json={"month": "2026-11-15", "account": "支付宝", "opening": 100, "closing": 180},
        headers=headers,
    )
    assert second.status_code == 200, second.text
    assert second.json()["merged"] is True
    assert second.json()["item"]["net"] == 80
    assert client.get("/api/data/money").json()["total"] == 1


def test_csrf_required(client):
    login(client)
    blocked = client.post("/api/data/todos", json={"title": "缺少 CSRF"})
    assert blocked.status_code == 403


def test_access_rule_denies_module(client):
    admin = login(client, "admin")
    rules = [
        {
            "module": "todos",
            "subject_type": "role",
            "subject": "user",
            "can_view": False,
            "can_edit": False,
        }
    ]
    assert client.put("/api/access", json={"rules": rules}, headers=admin).status_code == 200

    user = login(client, "user")
    assert client.get("/api/data/todos").status_code == 403
    session = client.get("/api/auth/session").json()
    assert "todos" not in session["modules"]
    assert "dashboard" in session["modules"]


def test_overview_empty(client):
    login(client)
    response = client.get("/api/overview")
    assert response.status_code == 200
    body = response.json()
    assert body["kpi"]["todo_open"] == 0
    assert len(body["focus_trend"]) == 7
    assert len(body["sleep_trend"]) == 7


def test_sleep_punch(client):
    headers = login(client)
    wake = client.post(
        "/api/data/sleep/punch",
        json={"kind": "wake", "time": "06:20", "date": "2026-11-25", "target": "06:30"},
        headers=headers,
    )
    assert wake.status_code == 200, wake.text
    assert wake.json()["achieved"] is True
    assert wake.json()["item"]["wake_time"] == "06:20"


def test_create_with_blank_fields(client):
    """前端表单会把没填的下拉 / 数字发成 null；非空列必须回落到默认值。"""
    headers = login(client)
    todo = client.post(
        "/api/data/todos",
        json={"title": "没填优先级", "priority": None, "category": None, "due_date": None, "note": None},
        headers=headers,
    )
    assert todo.status_code == 200, todo.text
    assert todo.json()["item"]["priority"] == "P1"

    sleep = client.post(
        "/api/data/sleep",
        json={"record_date": "2026-11-25", "bed_time": None, "wake_time": None, "target_time": None, "achieved": None, "hours": None},
        headers=headers,
    )
    assert sleep.status_code == 200, sleep.text
    assert sleep.json()["item"]["achieved"] is False

    workout = client.post(
        "/api/data/workouts",
        json={"workout_date": "2026-11-25", "items": [], "minutes": None, "intensity": None, "calories": None, "note": None},
        headers=headers,
    )
    assert workout.status_code == 200, workout.text
    assert workout.json()["item"]["intensity"] == "中"


def test_merge_only_updates_submitted_fields(client):
    headers = login(client)
    first = client.post(
        "/api/data/daily",
        json={"log_date": "2026-11-25", "content": "今天谈定了排产", "tomorrow_plan": "明天跟进样品"},
        headers=headers,
    )
    assert first.status_code == 200, first.text
    assert first.json()["merged"] is False

    second = client.post("/api/data/daily", json={"log_date": "2026-11-25", "blockers": "物流报价没回"}, headers=headers)
    assert second.status_code == 200, second.text
    assert second.json()["merged"] is True
    item = second.json()["item"]
    assert item["content"] == "今天谈定了排产"
    assert item["tomorrow_plan"] == "明天跟进样品"
    assert item["blockers"] == "物流报价没回"


def test_update_cleared_select_falls_back_to_default(client):
    headers = login(client)
    created = client.post("/api/data/todos", json={"title": "改优先级", "priority": "P0"}, headers=headers).json()["item"]
    patched = client.patch(f"/api/data/todos/{created['id']}", json={"priority": None}, headers=headers)
    assert patched.status_code == 200, patched.text
    assert patched.json()["item"]["priority"] == "P1"


def test_milestone_completed_at_not_reset(client):
    headers = login(client)
    created = client.post("/api/data/milestones", json={"title": "做成一件", "status": "已完成"}, headers=headers).json()["item"]
    assert created["completed_at"]
    again = client.patch(
        f"/api/data/milestones/{created['id']}",
        json={"status": "已完成", "progress": 80},
        headers=headers,
    )
    assert again.status_code == 200, again.text
    assert again.json()["item"]["completed_at"] == created["completed_at"]
    reopened = client.patch(f"/api/data/milestones/{created['id']}", json={"status": "进行中"}, headers=headers)
    assert reopened.json()["item"]["completed_at"] is None


def test_money_note_only_keeps_totals(client):
    headers = login(client)
    created = client.post(
        "/api/data/money",
        json={"month": "2026-11-01", "account": "支付宝", "opening": 100, "closing": 150},
        headers=headers,
    ).json()["item"]
    patched = client.patch(f"/api/data/money/{created['id']}", json={"note": "大额支出：房租"}, headers=headers)
    assert patched.status_code == 200, patched.text
    item = patched.json()["item"]
    assert (item["opening"], item["closing"], item["net"]) == (100, 150, 50)


def test_access_rule_matches_username(client):
    admin = login(client, "admin")
    rules = [
        {
            "module": "todos",
            "subject_type": "user",
            "subject": "dev-user",
            "can_view": False,
            "can_edit": False,
        }
    ]
    assert client.put("/api/access", json={"rules": rules}, headers=admin).status_code == 200
    user = login(client, "user")
    assert client.get("/api/data/todos").status_code == 403


def test_export_json_is_attachment(client):
    login(client)
    response = client.get("/api/export")
    assert response.status_code == 200
    assert "attachment" in response.headers.get("content-disposition", "")
    assert "modules" in response.json()


def test_brand_subtitle_editable(client):
    admin = login(client, "admin")
    brand = client.get("/api/settings/brand").json()
    assert brand["name"] == "此刻"
    assert brand["subtitle"] == "笔记 · 备忘录"
    assert brand["default_subtitle"] == "笔记 · 备忘录"

    saved = client.put(
        "/api/settings/brand",
        json={"name": "此刻", "subtitle": "笔记 · 备忘录"},
        headers=admin,
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["subtitle"] == "笔记 · 备忘录"

    assert client.put("/api/settings/brand", json={"name": "", "subtitle": ""}, headers=admin).status_code == 422
    assert client.put(
        "/api/settings/brand",
        json={"name": "此刻", "subtitle": "x" * 25},
        headers=admin,
    ).status_code == 422

    user = login(client, "user")
    assert client.put("/api/settings/brand", json={"name": "别人改的"}, headers=user).status_code == 403


def test_habits_check_and_summary(client):
    headers = login(client)
    created = client.post(
        "/api/habits",
        json={"title": "读书 30 分钟", "frequency": "每周", "target_count": 3},
        headers=headers,
    )
    assert created.status_code == 200, created.text
    habit = created.json()["item"]
    assert habit["month_goal"] > 0
    assert habit["today_done"] is False

    today = client.get("/api/habits").json()["today"]
    checked = client.post(f"/api/habits/{habit['id']}/check", json={}, headers=headers)
    assert checked.status_code == 200, checked.text
    assert checked.json()["item"]["today_done"] is True
    assert checked.json()["item"]["month_done"] == 1
    assert checked.json()["item"]["streak"] == 1

    overview = client.get("/api/overview").json()
    assert len(overview["habits"]) == 1
    assert overview["habits"][0]["today_done"] is True

    unchecked = client.delete(f"/api/habits/{habit['id']}/check?date={today}", headers=headers)
    assert unchecked.status_code == 200, unchecked.text
    assert unchecked.json()["item"]["today_done"] is False
    assert unchecked.json()["item"]["month_done"] == 0

    paused = client.patch(f"/api/habits/{habit['id']}", json={"status": "已暂停"}, headers=headers)
    assert paused.status_code == 200
    assert client.get("/api/overview").json()["habits"] == []
    assert len(client.get("/api/habits").json()["items"]) == 1

    assert client.delete(f"/api/habits/{habit['id']}", headers=headers).status_code == 200
    assert client.get("/api/habits").json()["items"] == []


def test_habits_validation_and_permission(client):
    headers = login(client)
    assert client.post("/api/habits", json={"title": ""}, headers=headers).status_code == 422
    assert client.post("/api/habits", json={"title": "x", "frequency": "每周三次"}, headers=headers).status_code == 422
    assert client.delete("/api/habits/999999", headers=headers).status_code == 404

    admin = login(client, "admin")
    rule = [{"module": "habits", "subject_type": "role", "subject": "user", "can_view": False, "can_edit": False}]
    assert client.put("/api/access", json={"rules": rule}, headers=admin).status_code == 200
    user = login(client, "user")
    assert client.get("/api/habits").status_code == 403


def test_update_status_admin_only(client):
    user = login(client)
    assert client.get("/api/update/status").status_code == 403

    admin = login(client, "admin")
    payload = client.get("/api/update/status").json()
    assert payload["running"]["deployment"] in {"docker", "host"}
    assert "capabilities" in payload
    assert payload["repo"]["available"] is False
    assert payload["capabilities"]["fetch"] is False
    assert client.post("/api/update/restart", headers=admin).status_code == 409


def test_avatar_and_logo_keep_alpha(client):
    headers = login(client, "admin")
    transparent = Image.new("RGBA", (12, 12), (255, 0, 0, 0))
    transparent.putpixel((0, 0), (30, 81, 56, 255))
    buffer = BytesIO()
    transparent.save(buffer, "PNG")
    payload = buffer.getvalue()

    uploaded = client.post(
        "/api/account/avatar",
        files={"file": ("avatar.png", payload, "image/png")},
        headers=headers,
    )
    assert uploaded.status_code == 200, uploaded.text
    avatar = client.get("/api/account/avatar")
    assert avatar.status_code == 200
    served = Image.open(BytesIO(avatar.content))
    assert served.mode == "RGBA"
    assert served.getpixel((6, 6))[3] == 0

    logo = client.post(
        "/api/settings/brand/logo",
        files={"file": ("logo.png", payload, "image/png")},
        headers=headers,
    )
    assert logo.status_code == 200, logo.text
    served_logo = Image.open(BytesIO(client.get("/api/settings/brand/logo").content))
    assert served_logo.mode == "RGBA"
    assert served_logo.getpixel((6, 6))[3] == 0
