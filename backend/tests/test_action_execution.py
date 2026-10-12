import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

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


def load_example() -> dict[str, Any]:
    return json.loads(EXAMPLE_PATH.read_text(encoding="utf-8"))


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    return TestClient(
        create_app(
            tmp_path / "configuration.json",
            admin_token=TEST_ADMIN_TOKEN,
        ),
        headers=ADMIN_HEADERS,
    )


def test_executes_enabled_configured_website_action(client: TestClient) -> None:
    with patch("app.actions.execution.webbrowser.open", return_value=True) as open_url:
        response = client.post(
            f"/api/actions/{WEBSITE_ACTION_ID}/execute"
        )

    assert response.status_code == 200
    assert response.json() == {
        "action_id": WEBSITE_ACTION_ID,
        "success": True,
        "message": "Opened the URL in the default browser.",
    }
    open_url.assert_called_once_with("https://example.com/", new=2)


def test_executes_new_inline_website_using_its_saved_url(client: TestClient) -> None:
    configuration = load_example()
    configuration["actions"].append(
        {
            "id": "action-inline-website",
            "type": "open_url",
            "enabled_for_execution": True,
            "parameters": {
                "url": "https://docs.example.net/custom/path?topic=pocketdeck",
                "name": "Custom docs",
            },
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        "action-inline-website"
    )
    assert client.put("/api/config", json=configuration).status_code == 200

    with patch("app.actions.execution.webbrowser.open", return_value=True) as open_url:
        response = client.post("/api/actions/action-inline-website/execute")

    assert response.status_code == 200
    assert response.json()["success"] is True
    open_url.assert_called_once_with(
        "https://docs.example.net/custom/path?topic=pocketdeck",
        new=2,
    )


def test_system_monitor_is_not_executable(client: TestClient) -> None:
    configuration = load_example()
    configuration["actions"].append(
        {
            "id": "cpu-monitor",
            "type": "system_monitor",
            "enabled_for_execution": False,
            "parameters": {"metric": "cpu_utilization"},
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        "cpu-monitor"
    )
    assert client.put("/api/config", json=configuration).status_code == 200

    response = client.post("/api/actions/cpu-monitor/execute")

    assert response.status_code == 409
    assert response.json()["error"]["message"] == (
        "System monitor actions are read-only and cannot be executed."
    )


def test_launches_only_configured_application_path_with_spaces(
    client: TestClient,
) -> None:
    configuration = load_example()
    configuration["actions"].append(
        {
            "id": "action-application",
            "type": "application",
            "enabled_for_execution": True,
            "parameters": {
                "name": "Code Editor",
                "path": r"C:\Program Files\Example Editor\Editor.exe",
            },
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        "action-application"
    )
    assert client.put("/api/config", json=configuration).status_code == 200

    with (
        patch(
            "app.actions.execution.is_windows_application_launch_available",
            return_value=True,
        ),
        patch("app.actions.execution.launch_application") as launch,
    ):
        response = client.post("/api/actions/action-application/execute")

    assert response.status_code == 200
    assert response.json() == {
        "action_id": "action-application",
        "success": True,
        "message": "Launched 'Code Editor'.",
    }
    launch.assert_called_once_with(r"C:\Program Files\Example Editor\Editor.exe")


def test_application_action_reports_missing_executable(client: TestClient) -> None:
    configuration = load_example()
    configuration["actions"].append(
        {
            "id": "action-missing-application",
            "type": "application",
            "enabled_for_execution": True,
            "parameters": {
                "name": "Missing app",
                "path": r"C:\Apps\Missing.exe",
            },
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        "action-missing-application"
    )
    assert client.put("/api/config", json=configuration).status_code == 200

    with (
        patch(
            "app.actions.execution.is_windows_application_launch_available",
            return_value=True,
        ),
        patch(
            "app.actions.execution.launch_application",
            side_effect=FileNotFoundError("file is gone"),
        ) as launch,
    ):
        response = client.post("/api/actions/action-missing-application/execute")

    assert response.status_code == 200
    assert response.json()["success"] is False
    assert "no longer available" in response.json()["message"]
    launch.assert_called_once_with(r"C:\Apps\Missing.exe")


def test_application_action_reports_process_creation_failure(
    client: TestClient,
) -> None:
    configuration = load_example()
    configuration["actions"].append(
        {
            "id": "action-failed-launch",
            "type": "application",
            "enabled_for_execution": True,
            "parameters": {
                "name": "Restricted app",
                "path": r"C:\Program Files\Restricted\app.exe",
            },
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        "action-failed-launch"
    )
    assert client.put("/api/config", json=configuration).status_code == 200

    with (
        patch(
            "app.actions.execution.is_windows_application_launch_available",
            return_value=True,
        ),
        patch(
            "app.actions.execution.launch_application",
            side_effect=OSError("access denied"),
        ),
    ):
        response = client.post("/api/actions/action-failed-launch/execute")

    assert response.status_code == 200
    assert response.json()["success"] is False
    assert "Windows could not launch 'Restricted app'" in response.json()["message"]


@pytest.mark.parametrize(
    ("control", "expected_message"),
    [
        ("volume_up", "Volume up."),
        ("volume_down", "Volume down."),
        ("mute_toggle", "Mute toggled."),
        ("brightness_up", "Brightness increased on 1 display(s)."),
        ("brightness_down", "Brightness decreased on 1 display(s)."),
    ],
)
def test_dispatches_each_configured_system_control(
    client: TestClient,
    control: str,
    expected_message: str,
) -> None:
    configuration = load_example()
    configuration["actions"].append(
        {
            "id": f"control-{control}",
            "type": "system_control",
            "enabled_for_execution": True,
            "parameters": {"control": control},
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        f"control-{control}"
    )
    assert client.put("/api/config", json=configuration).status_code == 200

    with (
        patch(
            "app.actions.execution.is_windows_system_control_available",
            return_value=True,
        ),
        patch(
            "app.actions.execution.perform_system_control",
            return_value=expected_message,
        ) as perform,
    ):
        response = client.post(f"/api/actions/control-{control}/execute")

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert response.json()["message"] == expected_message
    perform.assert_called_once_with(control)


def test_brightness_control_reports_unsupported_device_without_success(
    client: TestClient,
) -> None:
    configuration = load_example()
    configuration["actions"].append(
        {
            "id": "control-brightness",
            "type": "system_control",
            "enabled_for_execution": True,
            "parameters": {"control": "brightness_up"},
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        "control-brightness"
    )
    assert client.put("/api/config", json=configuration).status_code == 200

    with (
        patch(
            "app.actions.execution.is_windows_system_control_available",
            return_value=True,
        ),
        patch(
            "app.actions.execution.perform_system_control",
            side_effect=OSError("No connected display exposed controllable brightness."),
        ),
    ):
        response = client.post("/api/actions/control-brightness/execute")

    assert response.status_code == 200
    assert response.json()["success"] is False
    assert "No connected display" in response.json()["message"]


def test_system_controls_are_rejected_off_windows(client: TestClient) -> None:
    configuration = load_example()
    configuration["actions"].append(
        {
            "id": "control-volume",
            "type": "system_control",
            "enabled_for_execution": True,
            "parameters": {"control": "volume_up"},
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        "control-volume"
    )
    assert client.put("/api/config", json=configuration).status_code == 200

    with (
        patch(
            "app.actions.execution.is_windows_system_control_available",
            return_value=False,
        ),
        patch("app.actions.execution.perform_system_control") as perform,
    ):
        response = client.post("/api/actions/control-volume/execute")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "unsupported_platform"
    perform.assert_not_called()


def test_unknown_action_id_is_rejected(client: TestClient) -> None:

    with patch("app.actions.execution.webbrowser.open") as open_url:
        response = client.post("/api/actions/not-configured/execute")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "unknown_action_id"
    assert response.json()["error"]["action_id"] == "not-configured"
    assert response.json()["error"]["success"] is False
    open_url.assert_not_called()


def test_malformed_action_id_returns_structured_validation_error(
    client: TestClient,
) -> None:

    with patch("app.actions.execution.webbrowser.open") as open_url:
        response = client.post("/api/actions/%20invalid/execute")

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"
    open_url.assert_not_called()


def test_action_must_be_explicitly_enabled_for_execution(
    client: TestClient,
) -> None:
    configuration = load_example()
    configuration["actions"][0]["enabled_for_execution"] = False
    assert client.put("/api/config", json=configuration).status_code == 200

    with patch("app.actions.execution.webbrowser.open") as open_url:
        response = client.post(
            f"/api/actions/{WEBSITE_ACTION_ID}/execute"
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "action_not_enabled"
    open_url.assert_not_called()


def test_missing_execution_permission_defaults_to_disabled(
    client: TestClient,
) -> None:
    configuration = load_example()
    del configuration["actions"][0]["enabled_for_execution"]
    update_response = client.put("/api/config", json=configuration)

    assert update_response.status_code == 200
    assert (
        update_response.json()["configuration"]["actions"][0][
            "enabled_for_execution"
        ]
        is False
    )
    with patch("app.actions.execution.webbrowser.open") as open_url:
        response = client.post(
            f"/api/actions/{WEBSITE_ACTION_ID}/execute"
        )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "action_not_enabled"
    open_url.assert_not_called()


def test_non_boolean_execution_permission_is_rejected(
    client: TestClient,
) -> None:
    initial_configuration = client.get("/api/config").json()
    configuration = load_example()
    configuration["actions"][0]["enabled_for_execution"] = "true"

    with patch("app.actions.execution.webbrowser.open") as open_url:
        response = client.put("/api/config", json=configuration)
        execute_response = client.post(
            f"/api/actions/{WEBSITE_ACTION_ID}/execute"
        )

    assert response.status_code == 422
    assert client.get("/api/config").json() == initial_configuration
    assert execute_response.status_code == 200
    assert execute_response.json()["success"] is True
    open_url.assert_called_once_with("https://example.com/", new=2)


def test_keyboard_shortcut_is_not_dispatched_off_windows(
    client: TestClient,
) -> None:
    configuration = load_example()
    configuration["actions"][1]["enabled_for_execution"] = True
    assert client.put("/api/config", json=configuration).status_code == 200

    with (
        patch("app.actions.execution.is_windows_input_available", return_value=False),
        patch("app.actions.execution.send_keyboard_shortcut") as send_shortcut,
    ):
        response = client.post("/api/actions/action-copy-shortcut/execute")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "unsupported_platform"
    send_shortcut.assert_not_called()


def test_executes_enabled_configured_keyboard_shortcut(client: TestClient) -> None:
    configuration = load_example()
    configuration["actions"][1]["enabled_for_execution"] = True
    assert client.put("/api/config", json=configuration).status_code == 200

    with (
        patch("app.actions.execution.is_windows_input_available", return_value=True),
        patch("app.actions.execution.send_keyboard_shortcut") as send_shortcut,
    ):
        response = client.post("/api/actions/action-copy-shortcut/execute")

    assert response.status_code == 200
    assert response.json() == {
        "action_id": "action-copy-shortcut",
        "success": True,
        "message": "Sent the copy shortcut to the active window.",
    }
    send_shortcut.assert_called_once_with("copy")


def test_reports_keyboard_input_failure_without_claiming_success(
    client: TestClient,
) -> None:
    configuration = load_example()
    configuration["actions"][1]["enabled_for_execution"] = True
    assert client.put("/api/config", json=configuration).status_code == 200

    with (
        patch("app.actions.execution.is_windows_input_available", return_value=True),
        patch(
            "app.actions.execution.send_keyboard_shortcut",
            side_effect=OSError("Windows rejected input."),
        ),
    ):
        response = client.post("/api/actions/action-copy-shortcut/execute")

    assert response.status_code == 200
    assert response.json()["success"] is False
    assert "same privilege level" in response.json()["message"]


def test_invalid_shortcut_parameters_are_rejected_before_dispatch(
    client: TestClient,
) -> None:
    configuration = load_example()
    configuration["actions"][1]["enabled_for_execution"] = True
    configuration["actions"][1]["parameters"]["shortcut"] = "run_command"
    response = client.put("/api/config", json=configuration)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_configuration"
    with patch("app.actions.execution.send_keyboard_shortcut") as send_shortcut:
        action_response = client.post("/api/actions/action-copy-shortcut/execute")

    assert action_response.status_code == 409
    assert action_response.json()["error"]["code"] == "action_not_enabled"
    send_shortcut.assert_not_called()


def test_invalid_url_configuration_is_rejected_without_replacing_state(
    client: TestClient,
) -> None:
    initial_configuration = client.get("/api/config").json()
    configuration = load_example()
    configuration["actions"][0]["parameters"]["url"] = "javascript:alert(1)"

    with patch("app.actions.execution.webbrowser.open") as open_url:
        update_response = client.put("/api/config", json=configuration)

    assert update_response.status_code == 422
    assert client.get("/api/config").json() == initial_configuration
    open_url.assert_not_called()


def test_reports_browser_open_returning_false_as_failure(
    client: TestClient,
) -> None:

    with patch("app.actions.execution.webbrowser.open", return_value=False):
        response = client.post(
            f"/api/actions/{WEBSITE_ACTION_ID}/execute"
        )

    assert response.status_code == 200
    assert response.json() == {
        "action_id": WEBSITE_ACTION_ID,
        "success": False,
        "message": "The operating system could not open the URL in a browser.",
    }


def test_reports_browser_open_exception_as_failure(
    client: TestClient,
) -> None:

    with patch(
        "app.actions.execution.webbrowser.open",
        side_effect=OSError("No browser is registered."),
    ):
        response = client.post(
            f"/api/actions/{WEBSITE_ACTION_ID}/execute"
        )

    assert response.status_code == 200
    assert response.json()["success"] is False
    assert response.json()["action_id"] == WEBSITE_ACTION_ID


def test_runs_saved_command_steps_sequentially(client: TestClient) -> None:
    configuration = load_example()
    configuration["commands"] = [
        {
            "id": "command-sequence",
            "name": "Review and open",
            "category": "Work",
            "steps": [
                {"type": "wait", "parameters": {"milliseconds": 125}},
                {
                    "type": "open_url",
                    "parameters": {"url": "https://example.com/review"},
                },
                {
                    "type": "keyboard_shortcut",
                    "parameters": {"shortcut": "CTRL+SHIFT+R"},
                },
            ],
        }
    ]
    configuration["actions"].append(
        {
            "id": "action-review-sequence",
            "type": "run_command",
            "parameters": {"command_id": "command-sequence"},
            "enabled_for_execution": True,
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        "action-review-sequence"
    )
    assert client.put("/api/config", json=configuration).status_code == 200
    events: list[object] = []

    with (
        patch("app.actions.execution.time.sleep", side_effect=lambda n: events.append(("wait", n))),
        patch(
            "app.actions.execution.webbrowser.open",
            side_effect=lambda url, new: events.append(("url", url, new)) or True,
        ),
        patch("app.actions.execution.is_windows_input_available", return_value=True),
        patch(
            "app.actions.execution.send_keyboard_shortcut",
            side_effect=lambda shortcut: events.append(("shortcut", shortcut)),
        ),
    ):
        response = client.post("/api/actions/action-review-sequence/execute")

    assert response.status_code == 200
    assert response.json()["success"] is True
    assert events == [
        ("wait", 0.125),
        ("url", "https://example.com/review", 2),
        ("shortcut", "CTRL+SHIFT+R"),
    ]


def test_command_stops_on_step_failure_and_reports_step_number(
    client: TestClient,
) -> None:
    configuration = load_example()
    configuration["commands"] = [
        {
            "id": "command-fails",
            "name": "Failure test",
            "steps": [
                {"type": "wait", "parameters": {"milliseconds": 0}},
                {
                    "type": "open_url",
                    "parameters": {"url": "https://example.com/"},
                },
            ],
        }
    ]
    configuration["actions"].append(
        {
            "id": "action-command-fails",
            "type": "run_command",
            "parameters": {"command_id": "command-fails"},
            "enabled_for_execution": True,
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        "action-command-fails"
    )
    assert client.put("/api/config", json=configuration).status_code == 200

    with (
        patch("app.actions.execution.time.sleep"),
        patch("app.actions.execution.webbrowser.open", return_value=False) as open_url,
    ):
        response = client.post("/api/actions/action-command-fails/execute")

    assert response.status_code == 200
    assert response.json()["success"] is False
    assert "step 2" in response.json()["message"]
    open_url.assert_called_once()


def test_disabled_command_cannot_run_even_if_action_is_enabled(
    client: TestClient,
) -> None:
    configuration = load_example()
    configuration["commands"] = [
        {
            "id": "command-disabled",
            "name": "Disabled",
            "enabled": False,
            "steps": [{"type": "wait", "parameters": {"milliseconds": 0}}],
        }
    ]
    configuration["actions"].append(
        {
            "id": "action-command-disabled",
            "type": "run_command",
            "parameters": {"command_id": "command-disabled"},
            "enabled_for_execution": True,
        }
    )
    configuration["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = (
        "action-command-disabled"
    )
    assert client.put("/api/config", json=configuration).status_code == 200

    with patch("app.actions.execution.time.sleep") as wait:
        response = client.post("/api/actions/action-command-disabled/execute")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "command_not_enabled"
    wait.assert_not_called()
