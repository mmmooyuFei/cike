from conftest import login


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
