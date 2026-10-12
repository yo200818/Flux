import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.config import defaults
from app.config.models import validate_configuration
from app.config.storage import ConfigurationStorageError
from app.config.storage import get_default_configuration_path
from app.main import create_app

EXAMPLE_PATH = (
    Path(__file__).resolve().parents[2]
    / "shared"
    / "examples"
    / "config.v1.json"
)
WEBSITE_ACTION_ID = "action-open-pocketdeck-site"
TEST_ADMIN_TOKEN = "test-admin-token-with-at-least-32-characters"
ADMIN_HEADERS = {"Authorization": f"Bearer {TEST_ADMIN_TOKEN}"}


def authorized_client(app: Any) -> TestClient:
    return TestClient(app, headers=ADMIN_HEADERS)


def load_example() -> dict[str, Any]:
    return json.loads(EXAMPLE_PATH.read_text(encoding="utf-8"))


def test_default_configuration_path_uses_repository_layout_not_working_directory(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.chdir(tmp_path)

    assert defaults.get_default_configuration_path() == EXAMPLE_PATH
    assert defaults.load_default_configuration() == validate_configuration(
        load_example()
    )


def test_packaged_default_configuration_loads_from_pyinstaller_resources(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    packaged_example = tmp_path / "shared" / "examples" / "config.v1.json"
    packaged_example.parent.mkdir(parents=True)
    packaged_example.write_text(
        EXAMPLE_PATH.read_text(encoding="utf-8"), encoding="utf-8"
    )
    monkeypatch.setattr(defaults.sys, "frozen", True, raising=False)
    monkeypatch.setattr(defaults.sys, "_MEIPASS", str(tmp_path), raising=False)
    app_data = tmp_path / "app-data"
    config_path = app_data / "PocketDeck" / "configuration.json"
    monkeypatch.setenv("APPDATA", str(app_data))
    monkeypatch.delenv("POCKETDECK_CONFIG_PATH", raising=False)
    monkeypatch.setenv(
        "POCKETDECK_DEVICE_STORE_PATH",
        str(app_data / "PocketDeck" / "devices.json"),
    )

    assert defaults.get_default_configuration_path() == packaged_example
    assert defaults.load_default_configuration() == validate_configuration(
        load_example()
    )
    response = authorized_client(create_app(admin_token=TEST_ADMIN_TOKEN)).get(
        "/api/config"
    )

    assert response.status_code == 200
    assert response.json()["configuration"] == validate_configuration(
        load_example()
    ).model_dump(mode="json")
    assert json.loads(config_path.read_text(encoding="utf-8")) == response.json()


def test_default_storage_location_uses_windows_appdata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("POCKETDECK_CONFIG_PATH", raising=False)
    monkeypatch.setenv("APPDATA", str(tmp_path))

    assert get_default_configuration_path() == (
        tmp_path / "PocketDeck" / "configuration.json"
    )


def test_environment_variable_selects_configuration_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "custom-config.json"
    monkeypatch.setenv("POCKETDECK_CONFIG_PATH", str(config_path))

    response = authorized_client(create_app(admin_token=TEST_ADMIN_TOKEN)).get(
        "/api/config"
    )

    assert response.status_code == 200
    assert config_path.exists()


def test_first_run_creates_default_configuration_file(tmp_path: Path) -> None:
    config_path = tmp_path / "data" / "configuration.json"

    client = authorized_client(
        create_app(config_path, admin_token=TEST_ADMIN_TOKEN)
    )
    response = client.get("/api/config")

    assert response.status_code == 200
    assert response.json()["revision"] == 0
    assert response.json()["configuration"] == validate_configuration(
        load_example()
    ).model_dump(mode="json")
    saved = json.loads(config_path.read_text(encoding="utf-8"))
    assert saved == response.json()


def test_persisted_configuration_and_revision_load_after_restart(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "configuration.json"
    first_client = authorized_client(
        create_app(config_path, admin_token=TEST_ADMIN_TOKEN)
    )
    configuration = load_example()
    configuration["profiles"][0]["name"] = "Persisted Profile"

    update = first_client.put(
        "/api/config",
        json=configuration,
        params={"expected_revision": 0},
    )
    restarted_client = authorized_client(
        create_app(config_path, admin_token=TEST_ADMIN_TOKEN)
    )

    assert update.status_code == 200
    assert update.json()["revision"] == 1
    assert restarted_client.get("/api/config").json() == update.json()


def test_system_monitor_configuration_persists_across_restart(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "configuration.json"
    client = authorized_client(
        create_app(
            config_path,
            device_store_path=tmp_path / "devices.json",
            admin_token=TEST_ADMIN_TOKEN,
        )
    )
    configuration = load_example()
    configuration["actions"].append(
        {
            "id": "ram-monitor",
            "type": "system_monitor",
            "enabled_for_execution": False,
            "parameters": {"metric": "memory_usage"},
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        "ram-monitor"
    )

    update = client.put(
        "/api/config",
        json=configuration,
        params={"expected_revision": 0},
    )
    restarted_client = authorized_client(
        create_app(
            config_path,
            device_store_path=tmp_path / "devices.json",
            admin_token=TEST_ADMIN_TOKEN,
        )
    )

    assert update.status_code == 200
    assert restarted_client.get("/api/config").json() == update.json()
    saved_action = update.json()["configuration"]["actions"][-1]
    assert saved_action["id"] == "ram-monitor"
    assert saved_action["enabled_for_execution"] is False
    assert saved_action["parameters"] == {"metric": "memory_usage"}


def test_revision_conflict_does_not_replace_configuration(tmp_path: Path) -> None:
    client = authorized_client(
        create_app(
            tmp_path / "configuration.json",
            admin_token=TEST_ADMIN_TOKEN,
        )
    )
    initial = client.get("/api/config").json()
    configuration = load_example()
    configuration["profiles"][0]["name"] = "Stale Update"

    response = client.put(
        "/api/config",
        json=configuration,
        params={"expected_revision": 4},
    )

    assert response.status_code == 409
    assert response.json()["error"] == {
        "code": "configuration_revision_conflict",
        "message": "Expected configuration revision 4, but the current revision is 0.",
        "expected_revision": 4,
        "current_revision": 0,
    }
    assert client.get("/api/config").json() == initial


def test_revision_increments_only_after_successful_persist(tmp_path: Path) -> None:
    client = authorized_client(
        create_app(
            tmp_path / "configuration.json",
            admin_token=TEST_ADMIN_TOKEN,
        )
    )

    first = client.put(
        "/api/config", json=load_example(), params={"expected_revision": 0}
    )
    second = client.put(
        "/api/config", json=load_example(), params={"expected_revision": 1}
    )

    assert first.status_code == 200
    assert first.json()["revision"] == 1
    assert second.status_code == 200
    assert second.json()["revision"] == 2


@pytest.mark.parametrize(
    "saved_bytes",
    [
        b"{ definitely not json",
        json.dumps(
            {
                "revision": 7,
                "configuration": {**load_example(), "schema_version": 77},
            }
        ).encode("utf-8"),
    ],
)
def test_invalid_saved_file_is_preserved_and_startup_fails(
    tmp_path: Path, saved_bytes: bytes
) -> None:
    config_path = tmp_path / "configuration.json"
    config_path.write_bytes(saved_bytes)

    with pytest.raises(
        ConfigurationStorageError, match="left unchanged|repair or move"
    ) as error:
        create_app(config_path)

    assert error.value.code == "invalid_saved_configuration"
    assert config_path.read_bytes() == saved_bytes


def test_atomic_write_failure_keeps_active_and_saved_configuration(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "configuration.json"
    client = authorized_client(
        create_app(config_path, admin_token=TEST_ADMIN_TOKEN)
    )
    initial = client.get("/api/config").json()
    saved_bytes = config_path.read_bytes()
    updated_configuration = load_example()
    updated_configuration["profiles"][0]["name"] = "Not Persisted"

    with patch(
        "app.config.storage.os.replace",
        side_effect=OSError("replacement failed"),
    ):
        response = client.put(
            "/api/config",
            json=updated_configuration,
            params={"expected_revision": 0},
        )

    assert response.status_code == 500
    assert response.json()["error"]["code"] == "configuration_storage_error"
    assert client.get("/api/config").json() == initial
    assert config_path.read_bytes() == saved_bytes
    assert list(tmp_path.glob(".*.tmp")) == []


def test_action_execution_uses_configuration_loaded_from_latest_saved_file(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "configuration.json"
    first_client = authorized_client(
        create_app(config_path, admin_token=TEST_ADMIN_TOKEN)
    )
    updated_configuration = load_example()
    updated_configuration["actions"][0]["parameters"]["url"] = (
        "https://pocketdeck.dev/"
    )
    update_response = first_client.put(
        "/api/config",
        json=updated_configuration,
        params={"expected_revision": 0},
    )
    restarted_client = authorized_client(
        create_app(config_path, admin_token=TEST_ADMIN_TOKEN)
    )

    with patch(
        "app.actions.execution.webbrowser.open", return_value=True
    ) as open_url:
        execution_response = restarted_client.post(
            f"/api/actions/{WEBSITE_ACTION_ID}/execute"
        )

    assert update_response.status_code == 200
    assert update_response.json()["revision"] == 1
    assert execution_response.status_code == 200
    assert execution_response.json()["success"] is True
    open_url.assert_called_once_with("https://pocketdeck.dev/", new=2)


def test_application_configuration_round_trips_without_changing_existing_assignments(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "configuration.json"
    first_client = authorized_client(
        create_app(config_path, admin_token=TEST_ADMIN_TOKEN)
    )
    configuration = load_example()
    original_assignments = [
        (button["id"], button["action_id"])
        for button in configuration["profiles"][0]["pages"][0]["buttons"]
    ]
    configuration["actions"].append(
        {
            "id": "application-code-editor",
            "type": "application",
            "enabled_for_execution": True,
            "parameters": {
                "name": "Code Editor",
                "path": r"C:\Program Files\Vendor Suite\Editor.exe",
            },
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"].append(
        {
            "id": "button-code-editor",
            "label": "Code Editor",
            "icon": "application",
            "color": None,
            "action_id": "application-code-editor",
        }
    )

    response = first_client.put(
        "/api/config",
        json=configuration,
        params={"expected_revision": 0},
    )
    restarted_client = authorized_client(
        create_app(config_path, admin_token=TEST_ADMIN_TOKEN)
    )
    reloaded = restarted_client.get("/api/config").json()["configuration"]

    assert response.status_code == 200
    assert [
        (button["id"], button["action_id"])
        for button in reloaded["profiles"][0]["pages"][0]["buttons"][:3]
    ] == original_assignments
    assert reloaded["actions"][-1] == configuration["actions"][-1]
    assert reloaded["profiles"][0]["pages"][0]["buttons"][-1] == {
        "id": "button-code-editor",
        "label": "Code Editor",
        "icon": "application",
        "color": None,
        "action_id": "application-code-editor",
    }
