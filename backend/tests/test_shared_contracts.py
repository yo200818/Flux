import json
import re
import uuid
from pathlib import Path
from typing import Any

import pytest

from app.actions.definitions import DEFAULT_ACTION_REGISTRY
from app.actions.registry import ActionValidationError


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SHARED_ROOT = REPOSITORY_ROOT / "shared"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def assert_identifier(value: Any) -> None:
    assert isinstance(value, str)
    assert re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value)


def assert_v2_configuration(configuration: dict[str, Any], schema: dict[str, Any]) -> None:
    assert set(schema["required"]) <= set(configuration)
    assert set(configuration) <= set(schema["properties"])
    assert configuration["schema_version"] == 2
    assert set(configuration["deck"]) == {"id", "name"}
    assert_identifier(configuration["deck"]["id"])
    assert 1 <= len(configuration["deck"]["name"]) <= 64

    known_ids: set[str] = {configuration["deck"]["id"]}
    shortcuts = configuration.get("shortcuts", [])
    assert len(shortcuts) <= 64
    shortcuts_by_id: dict[str, dict[str, Any]] = {}
    for shortcut in shortcuts:
        assert set(shortcut) == set(schema["$defs"]["savedShortcut"]["required"])
        assert_identifier(shortcut["id"])
        assert shortcut["id"] not in known_ids
        known_ids.add(shortcut["id"])
        DEFAULT_ACTION_REGISTRY.validate(
            "keyboard_shortcut", {"shortcut": shortcut["shortcut"]}
        )
        shortcuts_by_id[shortcut["id"]] = shortcut

    commands = configuration.get("commands", [])
    assert len(commands) <= 64
    commands_by_id: dict[str, dict[str, Any]] = {}
    for command in commands:
        assert set(command) <= set(schema["$defs"]["command"]["properties"])
        assert set(schema["$defs"]["command"]["required"]) <= set(command)
        assert_identifier(command["id"])
        assert command["id"] not in known_ids
        known_ids.add(command["id"])
        assert 1 <= len(command["steps"]) <= 20
        commands_by_id[command["id"]] = command

    settings = configuration.get("settings")
    if settings is not None:
        assert set(settings) <= {"confirm_commands"}
        if "confirm_commands" in settings:
            assert type(settings["confirm_commands"]) is bool

    actions = configuration["actions"]
    action_by_id: dict[str, dict[str, Any]] = {}
    for action in actions:
        assert set(action) == set(schema["$defs"]["action"]["required"])
        assert_identifier(action["id"])
        assert action["id"] not in known_ids
        known_ids.add(action["id"])
        assert action["target"] in schema["$defs"]["action"]["properties"]["target"]["enum"]
        assert action["type"] in schema["$defs"]["action"]["properties"]["type"]["enum"]
        DEFAULT_ACTION_REGISTRY.validate(action["type"], action["parameters"])
        if action["type"] in {
            "application",
            "keyboard_shortcut",
            "system_control",
            "system_monitor",
            "run_command",
        }:
            assert action["target"] == "windows_host"
        if action["type"] == "system_monitor":
            assert action["enabled_for_execution"] is False
        if action["type"] == "run_command":
            assert action["parameters"]["command_id"] in commands_by_id
        if action["type"] == "keyboard_shortcut":
            shortcut_id = action["parameters"].get("shortcut_id")
            if shortcut_id is not None:
                assert shortcut_id in shortcuts_by_id
        action_by_id[action["id"]] = action

    for command in commands:
        for step in command["steps"]:
            assert step["type"] in {"open_url", "keyboard_shortcut", "wait"}
            DEFAULT_ACTION_REGISTRY.validate(step["type"], step["parameters"])
            if step["type"] == "keyboard_shortcut":
                shortcut_id = step["parameters"].get("shortcut_id")
                if shortcut_id is not None:
                    assert shortcut_id in shortcuts_by_id

    for profile in configuration["profiles"]:
        assert set(profile) == set(schema["$defs"]["profile"]["required"])
        assert_identifier(profile["id"])
        assert profile["id"] not in known_ids
        known_ids.add(profile["id"])
        for page in profile["pages"]:
            assert set(page) == set(schema["$defs"]["page"]["required"])
            assert_identifier(page["id"])
            assert page["id"] not in known_ids
            known_ids.add(page["id"])
            rows = page["grid"]["rows"]
            columns = page["grid"]["columns"]
            assert 1 <= rows <= 8
            assert 1 <= columns <= 8
            assert len(page["buttons"]) <= rows * columns
            for button in page["buttons"]:
                assert set(button) <= set(schema["$defs"]["button"]["properties"])
                assert set(schema["$defs"]["button"]["required"]) <= set(button)
                assert_identifier(button["id"])
                assert button["id"] not in known_ids
                known_ids.add(button["id"])
                if button["action_id"] is not None:
                    assert button["action_id"] in action_by_id
                if button.get("color") is not None:
                    assert re.fullmatch(r"#[0-9A-Fa-f]{6}", button["color"])


def test_v2_configuration_example_matches_shared_contract() -> None:
    schema = read_json(SHARED_ROOT / "schemas" / "v2" / "config.schema.json")
    example = read_json(SHARED_ROOT / "examples" / "config.v2.json")

    assert schema["$schema"].endswith("/draft/2020-12/schema")
    assert schema["properties"]["schema_version"]["const"] == 2
    assert set(schema["required"]) == {
        "schema_version",
        "deck",
        "profiles",
        "actions",
    }
    assert {"commands", "shortcuts", "settings"} <= set(schema["properties"])
    assert schema["additionalProperties"] is False
    assert_v2_configuration(example, schema)


def test_v2_configuration_allows_unassigned_buttons() -> None:
    schema = read_json(SHARED_ROOT / "schemas" / "v2" / "config.schema.json")
    configuration = read_json(SHARED_ROOT / "examples" / "config.v2.json")
    button = configuration["profiles"][0]["pages"][0]["buttons"][0]
    action_id_schema = schema["$defs"]["button"]["properties"]["action_id"]

    assert {"type": "null"} in action_id_schema["anyOf"]
    button["action_id"] = None
    assert_v2_configuration(configuration, schema)

    button["action_id"] = "missing-action"
    with pytest.raises(AssertionError):
        assert_v2_configuration(configuration, schema)


@pytest.mark.parametrize("step_type", ["run_command", "system_monitor", "application"])
def test_v2_command_steps_reject_nested_or_unsupported_actions(step_type: str) -> None:
    schema = read_json(SHARED_ROOT / "schemas" / "v2" / "config.schema.json")
    configuration = read_json(SHARED_ROOT / "examples" / "config.v2.json")
    configuration["commands"][0]["steps"][0] = {
        "type": step_type,
        "parameters": {"command_id": "prepare-copy-command"},
    }

    with pytest.raises(AssertionError):
        assert_v2_configuration(configuration, schema)


def test_v2_command_step_parameters_must_match_the_step_type() -> None:
    schema = read_json(SHARED_ROOT / "schemas" / "v2" / "config.schema.json")
    configuration = read_json(SHARED_ROOT / "examples" / "config.v2.json")
    configuration["commands"][0]["steps"][0] = {
        "type": "wait",
        "parameters": {"url": "https://example.com/"},
    }

    with pytest.raises(ActionValidationError):
        assert_v2_configuration(configuration, schema)


def test_v2_protocol_examples_match_message_definitions() -> None:
    schema = read_json(SHARED_ROOT / "schemas" / "v2" / "protocol.schema.json")
    config_schema = read_json(SHARED_ROOT / "schemas" / "v2" / "config.schema.json")
    examples = read_json(SHARED_ROOT / "examples" / "protocol.v2.json")
    branches = {
        branch["properties"]["type"]["const"]: branch["properties"]["payload"]["$ref"]
        for branch in schema["oneOf"]
    }
    allowed_types = set(schema["properties"]["type"]["enum"])

    assert set(branches) == allowed_types
    assert {"pairing.claim", "pairing.pending", "pairing.approved", "config.snapshot", "config.delta"} <= {
        message["type"] for message in examples
    }
    for message in examples:
        assert set(message) <= {"protocol_version", "message_id", "in_reply_to", "type", "payload"}
        assert {"protocol_version", "message_id", "type", "payload"} <= set(message)
        assert message["protocol_version"] == 2
        assert message["type"] in allowed_types
        uuid.UUID(message["message_id"])
        if "in_reply_to" in message:
            uuid.UUID(message["in_reply_to"])

        reference = branches[message["type"]]
        definition_name = reference.removeprefix("#/$defs/")
        payload_schema = schema["$defs"][definition_name]
        assert set(payload_schema.get("required", [])) <= set(message["payload"])
        if payload_schema.get("additionalProperties") is False:
            assert set(message["payload"]) <= set(payload_schema.get("properties", {}))

        if message["type"] == "config.snapshot":
            assert_v2_configuration(message["payload"]["configuration"], config_schema)
        elif message["type"] == "config.delta":
            payload = message["payload"]
            assert type(payload["base_revision"]) is int
            assert type(payload["revision"]) is int
            assert payload["revision"] == payload["base_revision"] + 1
            operation_schemas = schema["$defs"]["configOperation"]["oneOf"]
            for operation in payload["operations"]:
                matching_schema = next(
                    schema["$defs"][branch["$ref"].removeprefix("#/$defs/")]
                    for branch in operation_schemas
                    if schema["$defs"][branch["$ref"].removeprefix("#/$defs/")][
                        "properties"
                    ]["op"]["const"]
                    == operation["op"]
                )
                assert set(matching_schema["required"]) <= set(operation)
                assert set(operation) <= set(matching_schema["properties"])
        elif message["type"] == "action.execute":
            action = message["payload"]["action"]
            assert set(action) == {"id", "target", "type", "parameters"}
            assert action["target"] == "windows_host"
            DEFAULT_ACTION_REGISTRY.validate(action["type"], action["parameters"])
            configuration = read_json(SHARED_ROOT / "examples" / "config.v2.json")
            configured_action = next(
                entry
                for entry in configuration["actions"]
                if entry["id"] == action["id"]
            )
            assert {
                key: action[key]
                for key in ("id", "target", "type", "parameters")
            } == {
                key: configured_action[key]
                for key in ("id", "target", "type", "parameters")
            }
            referenced_buttons = [
                button
                for profile in configuration["profiles"]
                for page in profile["pages"]
                for button in page["buttons"]
                if button["id"] == message["payload"]["button_id"]
            ]
            assert len(referenced_buttons) == 1
            assert referenced_buttons[0]["action_id"] == action["id"]
            if action["type"] == "run_command":
                assert action["parameters"]["command_id"] in {
                    command["id"]
                    for command in configuration.get("commands", [])
                }
        elif message["type"] == "message.ack":
            stage = message["payload"]["stage"]
            if stage == "configuration.persisted":
                assert {"config_epoch", "revision"} <= set(message["payload"])
                assert "request_id" not in message["payload"]
            elif stage == "action.accepted":
                assert "request_id" in message["payload"]
                assert "config_epoch" not in message["payload"]
                assert "revision" not in message["payload"]


def test_empty_v2_deck_configuration_is_representable() -> None:
    schema = read_json(SHARED_ROOT / "schemas" / "v2" / "config.schema.json")
    empty_configuration = {
        "schema_version": 2,
        "deck": {"id": "empty-deck", "name": "Empty"},
        "profiles": [],
        "actions": [],
    }

    assert schema["properties"]["profiles"]["minItems"] == 0
    assert schema["properties"]["actions"]["minItems"] == 0
    assert schema["$defs"]["profile"]["properties"]["pages"]["minItems"] == 0
    assert_v2_configuration(empty_configuration, schema)
    assert_v2_configuration(
        {
            **empty_configuration,
            "profiles": [{"id": "empty-profile", "name": "Empty profile", "pages": []}],
        },
        schema,
    )


def test_system_monitor_is_a_read_only_shared_configuration_action() -> None:
    v1 = read_json(SHARED_ROOT / "schemas" / "v1" / "config.schema.json")
    v2 = read_json(SHARED_ROOT / "schemas" / "v2" / "config.schema.json")
    expected_metrics = {
        "cpu_utilization",
        "memory_usage",
        "gpu_utilization",
        "gpu_temperature",
        "cpu_temperature",
    }

    for schema in (v1, v2):
        action = schema["$defs"]["action"]
        assert "system_monitor" in action["properties"]["type"]["enum"]
        assert set(
            schema["$defs"]["systemMonitorParameters"]["properties"]["metric"][
                "enum"
            ]
        ) == expected_metrics
        monitor_guard = next(
            condition
            for condition in action["allOf"]
            if condition["if"]["properties"]["type"]["const"] == "system_monitor"
        )
        assert monitor_guard["then"]["properties"]["enabled_for_execution"][
            "const"
        ] is False
        DEFAULT_ACTION_REGISTRY.validate(
            "system_monitor", {"metric": "cpu_utilization"}
        )


def test_v2_protocol_schema_keeps_pairing_and_action_guards_explicit() -> None:
    schema = read_json(SHARED_ROOT / "schemas" / "v2" / "protocol.schema.json")
    pairing_approved = schema["$defs"]["pairingApproved"]
    action = schema["$defs"]["windowsAction"]
    action_result = schema["$defs"]["actionResult"]
    ack = schema["$defs"]["ack"]

    assert pairing_approved["properties"]["credential"]["writeOnly"] is True
    assert pairing_approved["properties"]["credential"]["minLength"] >= 32
    assert action["properties"]["target"]["const"] == "windows_host"
    assert {
        branch["properties"]["type"]["const"]: branch["properties"]["parameters"]["$ref"]
        for branch in action["oneOf"]
    } == {
        "open_url": "https://pocketdeck.dev/schemas/config/v2/config.schema.json#/$defs/openUrlParameters",
        "application": "https://pocketdeck.dev/schemas/config/v2/config.schema.json#/$defs/applicationParameters",
        "system_control": "https://pocketdeck.dev/schemas/config/v2/config.schema.json#/$defs/systemControlParameters",
        "keyboard_shortcut": "https://pocketdeck.dev/schemas/config/v2/config.schema.json#/$defs/keyboardShortcutParameters",
        "run_command": "https://pocketdeck.dev/schemas/config/v2/config.schema.json#/$defs/runCommandParameters",
    }
    assert action_result["properties"]["outcome"]["enum"] == [
        "succeeded",
        "failed",
        "unknown",
    ]
    assert action_result["allOf"][0]["then"]["required"] == ["code"]
    assert len(ack["allOf"]) == 2


def test_v1_example_remains_on_legacy_schema_version() -> None:
    schema = read_json(SHARED_ROOT / "schemas" / "v1" / "config.schema.json")
    example = read_json(SHARED_ROOT / "examples" / "config.v1.json")

    assert schema["properties"]["schema_version"]["const"] == 1
    assert example["schema_version"] == 1


def test_v1_and_v2_schemas_share_extended_shortcut_rules_and_unassigned_buttons() -> None:
    v1 = read_json(SHARED_ROOT / "schemas" / "v1" / "config.schema.json")
    v2 = read_json(SHARED_ROOT / "schemas" / "v2" / "config.schema.json")
    v1_shortcut = v1["$defs"]["keyboardShortcutValue"]
    v2_shortcut = v2["$defs"]["keyboardShortcutValue"]
    assert v1_shortcut == v2_shortcut

    pattern = re.compile(v1_shortcut["pattern"])
    assert pattern.fullmatch("CTRL+ALT+SHIFT+WIN+F24")
    assert pattern.fullmatch("CTRL+NUMPAD7")
    assert pattern.fullmatch("SHIFT+SEMICOLON")
    assert not pattern.fullmatch("CTRL+F25")

    for schema in (v1, v2):
        action_id = schema["$defs"]["button"]["properties"]["action_id"]
        assert {"type": "null"} in action_id["anyOf"]

    duplicate_modifier_patterns = [
        re.compile(item["not"]["pattern"]) for item in v1_shortcut["allOf"]
    ]
    assert any(pattern.search("CTRL+CTRL+A") for pattern in duplicate_modifier_patterns)
    assert any(pattern.search("WIN+L") for pattern in duplicate_modifier_patterns)
