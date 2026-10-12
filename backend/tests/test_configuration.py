import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel, ConfigDict

from app.actions.definitions import DEFAULT_ACTION_REGISTRY
from app.actions.registry import (
    ActionDefinition,
    ActionRegistry,
    ActionValidationError,
)
from app.config.models import (
    Configuration,
    ConfigurationValidationError,
    validate_configuration,
)
from fastapi.testclient import TestClient
from app.main import create_app

EXAMPLE_PATH = (
    Path(__file__).resolve().parents[2]
    / "shared"
    / "examples"
    / "config.v1.json"
)
TEST_ADMIN_TOKEN = "test-admin-token-with-at-least-32-characters"
ADMIN_HEADERS = {"Authorization": f"Bearer {TEST_ADMIN_TOKEN}"}


def create_authorized_client(app: Any) -> TestClient:
    return TestClient(app, headers=ADMIN_HEADERS)


def load_example() -> dict[str, Any]:
    return json.loads(EXAMPLE_PATH.read_text(encoding="utf-8"))


def test_example_configuration_is_valid() -> None:
    result = validate_configuration(load_example())

    assert isinstance(result, Configuration)
    assert result.schema_version == 1
    assert len(result.profiles[0].pages[0].buttons) == 3


def test_system_monitor_configuration_is_read_only() -> None:
    data = load_example()
    data["actions"].append(
        {
            "id": "cpu-monitor",
            "type": "system_monitor",
            "enabled_for_execution": False,
            "parameters": {"metric": "cpu_utilization"},
        }
    )
    data["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = "cpu-monitor"

    result = validate_configuration(data)
    assert result.actions[-1].type == "system_monitor"

    data["actions"][-1]["enabled_for_execution"] = True
    with pytest.raises(ConfigurationValidationError) as error:
        validate_configuration(data)
    assert any(detail["type"] == "read_only_action" for detail in error.value.details)


def test_system_monitor_cannot_be_used_as_a_command_step() -> None:
    data = load_example()
    data["commands"] = [
        {
            "id": "monitor-command",
            "definition_version": 1,
            "name": "Read metrics",
            "category": "General",
            "enabled": True,
            "steps": [
                {
                    "type": "system_monitor",
                    "parameters": {"metric": "cpu_utilization"},
                }
            ],
        }
    ]

    with pytest.raises(ConfigurationValidationError) as error:
        validate_configuration(data)

    assert any(detail["type"] == "read_only_action" for detail in error.value.details)


def test_configuration_requires_supported_version() -> None:
    data = load_example()
    data["schema_version"] = 2

    with pytest.raises(ConfigurationValidationError) as error:
        validate_configuration(data)

    assert error.value.details[0]["location"] == ["schema_version"]


def test_duplicate_ids_across_entity_types_are_rejected() -> None:
    data = load_example()
    data["profiles"][0]["pages"][0]["buttons"][0]["id"] = "default"

    with pytest.raises(ConfigurationValidationError) as error:
        validate_configuration(data)

    assert any(item["type"] == "duplicate_id" for item in error.value.details)


def test_button_must_reference_a_declared_action() -> None:
    data = load_example()
    data["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = "missing"

    with pytest.raises(ConfigurationValidationError) as error:
        validate_configuration(data)

    assert any(
        item["type"] == "unknown_action_id" for item in error.value.details
    )


@pytest.mark.parametrize(
    "control",
    [
        "volume_up",
        "volume_down",
        "mute_toggle",
        "brightness_up",
        "brightness_down",
    ],
)
def test_system_control_accepts_each_allowlisted_operation(control: str) -> None:
    parameters = DEFAULT_ACTION_REGISTRY.validate(
        "system_control", {"control": control}
    )

    assert parameters.control == control


@pytest.mark.parametrize(
    "control",
    ["run_command", "power_off", "set_volume:100", ""],
)
def test_system_control_rejects_unlisted_operations(control: str) -> None:
    with pytest.raises(ActionValidationError):
        DEFAULT_ACTION_REGISTRY.validate(
            "system_control", {"control": control}
        )


@pytest.mark.parametrize(
    "metric",
    [
        "cpu_utilization",
        "memory_usage",
        "gpu_utilization",
        "gpu_temperature",
        "cpu_temperature",
    ],
)
def test_system_monitor_accepts_supported_metrics(metric: str) -> None:
    parameters = DEFAULT_ACTION_REGISTRY.validate(
        "system_monitor", {"metric": metric}
    )

    assert parameters.metric == metric


@pytest.mark.parametrize("metric", ["power_off", "temperature_guess", ""])
def test_system_monitor_rejects_unlisted_metrics(metric: str) -> None:
    with pytest.raises(ActionValidationError):
        DEFAULT_ACTION_REGISTRY.validate("system_monitor", {"metric": metric})


def test_application_action_accepts_absolute_executable_paths_with_spaces() -> None:
    application = DEFAULT_ACTION_REGISTRY.validate(
        "application",
        {
            "name": "Code Editor",
            "path": r"C:\Program Files\Example Editor\Editor.exe",
        },
    )

    assert application.name == "Code Editor"
    assert application.path == r"C:\Program Files\Example Editor\Editor.exe"


@pytest.mark.parametrize(
    "path",
    [
        "Editor.exe",
        r"C:\Apps\Editor.exe --unsafe",
        r"C:\Apps\Editor.bat",
        r"C:\Apps\Editor.exe\"",
        r"C:\Apps\*Editor.exe",
    ],
)
def test_application_action_rejects_non_executable_or_argument_paths(
    path: str,
) -> None:
    with pytest.raises(ActionValidationError):
        DEFAULT_ACTION_REGISTRY.validate(
            "application",
            {"name": "Editor", "path": path},
        )


def test_grid_must_have_capacity_for_all_buttons() -> None:
    data = load_example()
    page = data["profiles"][0]["pages"][0]
    page["grid"] = {"columns": 1, "rows": 1}

    with pytest.raises(ConfigurationValidationError) as error:
        validate_configuration(data)

    assert any(item["type"] == "grid_capacity" for item in error.value.details)


@pytest.mark.parametrize("color", ["red", "#abc", "#12abef00", ""])
def test_button_color_must_be_a_six_digit_hex_value(color: str) -> None:
    data = load_example()
    data["profiles"][0]["pages"][0]["buttons"][0]["color"] = color

    with pytest.raises(ConfigurationValidationError) as error:
        validate_configuration(data)

    assert any(
        item["location"][-1] == "color" for item in error.value.details
    )


def test_unknown_action_type_is_rejected_with_structured_error() -> None:
    data = load_example()
    data["actions"][0]["type"] = "unsupported_future_action"

    with pytest.raises(ConfigurationValidationError) as error:
        validate_configuration(data)

    action_error = next(
        item for item in error.value.details if item["location"][-1] == "type"
    )
    assert action_error["type"] == "unknown_action_type"
    assert error.value.as_dict()["code"] == "invalid_configuration"


@pytest.mark.parametrize(
    "url",
    [
        "file:///C:/Windows/notepad.exe",
        "javascript:alert(1)",
        "not-a-url",
    ],
)
def test_open_url_rejects_non_http_or_invalid_urls(url: str) -> None:
    with pytest.raises(ActionValidationError) as error:
        DEFAULT_ACTION_REGISTRY.validate("open_url", {"url": url})

    assert error.value.code == "invalid_action_parameters"
    assert error.value.details[0].location == ("parameters", "url")


def test_open_url_accepts_an_optional_friendly_name_and_legacy_url_only() -> None:
    website = DEFAULT_ACTION_REGISTRY.validate(
        "open_url",
        {"url": "https://example.com/path", "name": "Example portal"},
    )
    legacy = DEFAULT_ACTION_REGISTRY.validate(
        "open_url", {"url": "https://example.com/path"}
    )

    assert website.name == "Example portal"
    assert str(website.url) == "https://example.com/path"
    assert legacy.name is None


def test_open_url_friendly_name_is_bounded_and_non_empty() -> None:
    for name in ("", "x" * 65):
        with pytest.raises(ActionValidationError):
            DEFAULT_ACTION_REGISTRY.validate(
                "open_url",
                {"url": "https://example.com/", "name": name},
            )


def test_keyboard_shortcut_rejects_values_outside_allowlist() -> None:
    with pytest.raises(ActionValidationError) as error:
        DEFAULT_ACTION_REGISTRY.validate(
            "keyboard_shortcut", {"shortcut": "launch_terminal"}
        )

    assert error.value.code == "invalid_action_parameters"
    assert error.value.details[0].location == ("parameters", "shortcut")


def test_registry_lists_and_looks_up_registered_definitions() -> None:
    definitions = DEFAULT_ACTION_REGISTRY.list_actions()

    assert [definition.action_type for definition in definitions] == [
        "application",
        "keyboard_shortcut",
        "open_url",
        "run_command",
        "system_control",
        "system_monitor",
        "wait",
    ]
    assert (
        DEFAULT_ACTION_REGISTRY.lookup("open_url").description
        == "Open a validated HTTP or HTTPS URL."
    )
    assert str(
        DEFAULT_ACTION_REGISTRY.validate(
            "open_url", {"url": "https://example.com/"}
        ).url
    ) == "https://example.com/"


def test_registry_is_extensible_and_rejects_duplicate_registration() -> None:
    class FutureParameters(BaseModel):
        model_config = ConfigDict(extra="forbid")

        value: int

    registry = ActionRegistry()
    definition = ActionDefinition(
        action_type="future_example",
        description="Test-only future action.",
        parameters_model=FutureParameters,
    )
    registry.register(definition)

    assert registry.lookup("future_example") is definition
    assert registry.validate("future_example", {"value": 3}).value == 3
    with pytest.raises(ValueError, match="already registered"):
        registry.register(definition)


def test_unknown_action_lookup_is_structured() -> None:
    with pytest.raises(ActionValidationError) as error:
        DEFAULT_ACTION_REGISTRY.lookup("unknown")

    assert error.value.as_dict() == {
        "code": "unknown_action_type",
        "message": "Unsupported action type 'unknown'.",
        "details": [
            {
                "location": ["type"],
                "message": "Action type is not registered.",
                "type": "unknown_action_type",
            }
        ],
    }


def test_get_configuration_returns_valid_initial_configuration(
    tmp_path: Path,
) -> None:
    client = create_authorized_client(
        create_app(tmp_path / "configuration.json", admin_token=TEST_ADMIN_TOKEN)
    )

    response = client.get("/api/config")

    assert response.status_code == 200
    assert response.json()["revision"] == 0
    configuration = validate_configuration(response.json()["configuration"])
    assert configuration.schema_version == 1
    assert [button.label for button in configuration.profiles[0].pages[0].buttons] == [
        "Open Website",
        "Copy",
        "Save",
    ]


def test_put_configuration_updates_persisted_configuration(
    tmp_path: Path,
) -> None:
    client = create_authorized_client(
        create_app(tmp_path / "configuration.json", admin_token=TEST_ADMIN_TOKEN)
    )
    configuration = load_example()
    configuration["profiles"][0]["name"] = "Updated Profile"

    response = client.put(
        "/api/config", json=configuration, params={"expected_revision": 0}
    )

    assert response.status_code == 200
    assert response.json()["revision"] == 1
    assert response.json()["configuration"]["profiles"][0]["name"] == "Updated Profile"
    assert client.get("/api/config").json() == response.json()


def test_put_configuration_rejects_structural_errors(tmp_path: Path) -> None:
    client = create_authorized_client(
        create_app(tmp_path / "configuration.json", admin_token=TEST_ADMIN_TOKEN)
    )
    invalid_configuration = load_example()
    invalid_configuration["schema_version"] = 2

    response = client.put("/api/config", json=invalid_configuration)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_configuration"
    assert any(
        detail["location"] == ["schema_version"]
        for detail in response.json()["error"]["details"]
    )


def test_put_configuration_rejects_invalid_configuration_without_replacing_state(
    tmp_path: Path,
) -> None:
    client = create_authorized_client(
        create_app(tmp_path / "configuration.json", admin_token=TEST_ADMIN_TOKEN)
    )
    initial_configuration = client.get("/api/config").json()
    invalid_configuration = load_example()
    invalid_configuration["profiles"][0]["pages"][0]["buttons"][0][
        "action_id"
    ] = "missing-action"

    response = client.put("/api/config", json=invalid_configuration)

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "invalid_configuration"
    assert any(
        detail["type"] == "unknown_action_id" for detail in error["details"]
    )
    assert client.get("/api/config").json() == initial_configuration


def test_v1_configuration_without_extensions_loads_with_empty_defaults() -> None:
    data = load_example()

    result = validate_configuration(data)

    assert result.commands == []
    assert result.shortcuts == []
    assert result.settings.confirm_commands is False


def test_custom_command_steps_and_saved_shortcuts_are_validated() -> None:
    data = load_example()
    data["shortcuts"] = [
        {"id": "shortcut-review", "name": "Review", "shortcut": "ctrl+shift+r"}
    ]
    data["commands"] = [
        {
            "id": "command-review",
            "name": "Review",
            "category": "Writing",
            "enabled": True,
            "steps": [
                {
                    "type": "keyboard_shortcut",
                    "parameters": {"shortcut_id": "shortcut-review"},
                },
                {"type": "wait", "parameters": {"milliseconds": 400}},
                {
                    "type": "open_url",
                    "parameters": {"url": "https://example.com/"},
                },
            ],
        }
    ]

    configuration = validate_configuration(data)

    assert configuration.shortcuts[0].shortcut == "CTRL+SHIFT+R"
    assert configuration.commands[0].steps[1].parameters == {"milliseconds": 400}


def test_none_button_assignment_is_valid_and_existing_id_assignments_are_unchanged() -> None:
    data = load_example()
    assigned_action_id = data["profiles"][0]["pages"][0]["buttons"][0]["action_id"]
    data["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = None

    configuration = validate_configuration(data)

    assert configuration.profiles[0].pages[0].buttons[0].action_id is None

    data["profiles"][0]["pages"][0]["buttons"][0]["action_id"] = assigned_action_id
    reloaded = validate_configuration(data)
    assert (
        reloaded.profiles[0].pages[0].buttons[0].action_id
        == assigned_action_id
    )


@pytest.mark.parametrize(
    ("shortcut", "canonical"),
    [
        ("shift+ctrl+win+F24", "CTRL+SHIFT+WIN+F24"),
        ("ALT+ARROWRIGHT", "ALT+RIGHT"),
        ("CTRL+NUMPAD2", "CTRL+NUMPAD2"),
    ],
)
def test_saved_shortcut_normalizes_extended_keys_on_load(
    shortcut: str,
    canonical: str,
) -> None:
    data = load_example()
    data["shortcuts"] = [
        {"id": "shortcut-extended", "name": "Extended", "shortcut": shortcut}
    ]

    configuration = validate_configuration(data)

    assert configuration.shortcuts[0].shortcut == canonical


def test_custom_command_description_is_persisted_and_backward_compatible() -> None:
    data = load_example()
    data["commands"] = [
        {
            "id": "command-described",
            "name": "Described command",
            "description": "Open the research workspace.",
            "steps": [
                {"type": "wait", "parameters": {"milliseconds": 100}},
            ],
        }
    ]

    configuration = validate_configuration(data)

    command = configuration.commands[0]
    assert command.description == "Open the research workspace."
    assert command.model_dump(mode="json")["description"] == (
        "Open the research workspace."
    )

    del data["commands"][0]["description"]
    legacy_configuration = validate_configuration(data)
    assert legacy_configuration.commands[0].description == ""


@pytest.mark.parametrize(
    ("mutate", "expected_type"),
    [
        (
            lambda data: data["commands"][0]["steps"][0].update(
                parameters={"shortcut": "ALT+WIN+R"}
            ),
            "value_error",
        ),
        (
            lambda data: data["commands"][0]["steps"][0].update(
                parameters={"shortcut_id": "deleted-shortcut"}
            ),
            "unknown_shortcut_id",
        ),
        (
            lambda data: data["commands"][0]["steps"][0].update(
                type="run_command", parameters={"command_id": "command-a"}
            ),
            "nested_command",
        ),
        (
            lambda data: data["commands"][0]["steps"][0].update(
                type="wait", parameters={"milliseconds": 10001}
            ),
            "less_than_equal",
        ),
    ],
)
def test_invalid_command_steps_are_rejected(
    mutate: Any, expected_type: str
) -> None:
    data = load_example()
    data["commands"] = [
        {
            "id": "command-a",
            "name": "Test command",
            "steps": [
                {
                    "type": "keyboard_shortcut",
                    "parameters": {"shortcut": "CTRL+A"},
                }
            ],
        }
    ]
    data["actions"].append(
        {
            "id": "action-command-a",
            "type": "run_command",
            "parameters": {"command_id": "command-a"},
            "enabled_for_execution": True,
        }
    )
    mutate(data)

    with pytest.raises(ConfigurationValidationError) as error:
        validate_configuration(data)

    assert any(detail["type"] == expected_type for detail in error.value.details)


def test_command_definition_cannot_be_deleted_while_action_references_it() -> None:
    data = load_example()
    data["commands"] = [
        {
            "id": "command-kept",
            "name": "Kept command",
            "steps": [
                {"type": "wait", "parameters": {"milliseconds": 0}}
            ],
        }
    ]
    data["actions"].append(
        {
            "id": "action-command-kept",
            "type": "run_command",
            "parameters": {"command_id": "command-kept"},
            "enabled_for_execution": True,
        }
    )
    validate_configuration(data)
    data["commands"] = []

    with pytest.raises(ConfigurationValidationError) as error:
        validate_configuration(data)

    assert any(detail["type"] == "unknown_command_id" for detail in error.value.details)
