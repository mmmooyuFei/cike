import os
import pathlib

os.environ["DATABASE_URL"] = f"sqlite:///{pathlib.Path(__file__).parent / 'test.db'}"
os.environ["DEV_AUTH"] = "true"
os.environ["COOKIE_SECURE"] = "false"
os.environ["SESSION_SECRET"] = "test-secret-only"
os.environ["DATA_DIR"] = str(pathlib.Path(__file__).parent / "data")

import pytest
from fastapi.testclient import TestClient

from app.db import Base, engine
from app.main import app


@pytest.fixture()
def client():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with TestClient(app) as test_client:
        yield test_client


def login(client: TestClient, role: str = "user") -> dict:
    response = client.post("/api/auth/dev-login", json={"role": role})
    assert response.status_code == 200, response.text
    token = client.cookies.get("cike_csrf")
    assert token
    return {"X-CSRF-Token": token}
