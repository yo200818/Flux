from __future__ import annotations

import copy
import json
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest

from app.actions.definitions import DEFAULT_ACTION_REGISTRY


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SHARED_ROOT = REPOSITORY_ROOT / "shared"
PROTOCOL_SCHEMA_PATH = SHARED_ROOT / "schemas" / "v2" / "protocol.schema.json"
CONFIG_SCHEMA_PATH = SHARED_ROOT / "schemas" / "v2" / "config.schema.json"
EXAMPLES_PATH = SHARED_ROOT / "examples" / "protocol.v2.json"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def payload_schemas(schema: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        branch["properties"]["type"]["const"]: schema["$defs"][
            branch["properties"]["payload"]["$ref"].removeprefix("#/$defs/")
        ]
        for branch in schema["oneOf"]
    }


def local_operation_schemas(schema: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        schema["$defs"][reference["$ref"].removeprefix("#/$defs/")][
            "properties"
        ]["op"]["const"]: schema["$defs"][
            reference["$ref"].removeprefix("#/$defs/")
        ]
        for reference in schema["$defs"]["configOperation"]["oneOf"]
    }


def assert_run_command_reference(
    action: dict[str, Any], configuration: dict[str, Any]
) -> None:
    assert action["target"] == "windows_host"
    assert set(action["parameters"]) == {"command_id"}
    assert action["parameters"]["command_id"] in {
        command["id"] for command in configuration["commands"]
    }


def assert_envelope(message: dict[str, Any], schema: dict[str, Any]) -> None:
    assert set(message) <= {"protocol_version", "message_id", "in_reply_to", "type", "payload"}
    assert {"protocol_version", "message_id", "type", "payload"} <= set(message)
    assert type(message["protocol_version"]) is int
    assert message["protocol_version"] == schema["properties"]["protocol_version"]["const"]
    assert message["type"] in schema["properties"]["type"]["enum"]
    UUID(message["message_id"])
    if "in_reply_to" in message:
        UUID(message["in_reply_to"])
    assert isinstance(message["payload"], dict)
    encoded_size = len(
        json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    config_message = message["type"] in {"config.snapshot", "config.delta"}
    assert encoded_size <= (4 * 1024 * 1024 if config_message else 16 * 1024)

    payload_schema = payload_schemas(schema)[message["type"]]
    if "$ref" in payload_schema:
        payload_schema = schema["$defs"][payload_schema["$ref"].removeprefix("#/$defs/")]
    assert set(payload_schema.get("required", [])) <= set(message["payload"])
    if payload_schema.get("additionalProperties") is False:
        assert set(message["payload"]) <= set(payload_schema.get("properties", {}))
    for name, property_schema in payload_schema.get("properties", {}).items():
        if "const" in property_schema and name in message["payload"]:
            assert message["payload"][name] == property_schema["const"]

    if message["type"] == "server.welcome":
        assert message["payload"]["selected_protocol_version"] == 2
        assert message["payload"]["selected_configuration_version"] == 2
    elif message["type"] == "config.delta":
        payload = message["payload"]
        assert type(payload["base_revision"]) is int
        assert type(payload["revision"]) is int
        assert 0 <= payload["base_revision"] <= 9007199254740991
        assert 1 <= payload["revision"] <= 9007199254740991
        assert payload["revision"] == payload["base_revision"] + 1
        assert payload["revision"] <= 9007199254740991
        operation_schemas = local_operation_schemas(schema)
        for operation in payload["operations"]:
            operation_schema = operation_schemas[operation["op"]]
            assert set(operation_schema["required"]) <= set(operation)
            assert set(operation) <= set(operation_schema["properties"])
    elif message["type"] == "action.execute":
        action = message["payload"]["action"]
        action_schema = schema["$defs"]["windowsAction"]
        assert action["target"] == action_schema["properties"]["target"]["const"]
        assert action["type"] in action_schema["properties"]["type"]["enum"]
        DEFAULT_ACTION_REGISTRY.validate(action["type"], action["parameters"])
    elif message["type"] == "action.result":
        assert message["payload"]["outcome"] in {"succeeded", "failed", "unknown"}
        if message["payload"]["outcome"] in {"failed", "unknown"}:
            assert message["payload"].get("code")
    elif message["type"] == "action.status.result":
        assert message["payload"]["outcome"] in {
            "accepted",
            "succeeded",
            "failed",
            "unknown",
        }
        if message["payload"]["outcome"] in {"failed", "unknown"}:
            assert message["payload"].get("code")
    elif message["type"] == "telemetry.update":
        metrics = message["payload"]["metrics"]
        cpu = metrics["cpu_utilization"]
        if cpu["status"] == "available":
            assert type(cpu["value"]) in (int, float)
            assert 0 <= cpu["value"] <= 100
        else:
            assert cpu["value"] is None
        if cpu["status"] == "unavailable":
            assert cpu.get("reason")
        memory = metrics["memory_usage"]
        if memory["status"] == "available":
            assert type(memory["used_bytes"]) is int
            assert type(memory["total_bytes"]) is int
            assert 0 <= memory["used_bytes"] <= memory["total_bytes"]
        else:
            assert memory["used_bytes"] is None
            assert memory["total_bytes"] is None
            assert memory.get("reason")
        for metric in ("gpu_utilization", "gpu_temperature", "cpu_temperature"):
            assert metrics[metric]["status"] == "unavailable"
            assert metrics[metric]["code"] == "unsupported"


def test_all_protocol_examples_match_the_v2_message_contract() -> None:
    schema = read_json(PROTOCOL_SCHEMA_PATH)
    examples = read_json(EXAMPLES_PATH)
    message_types = {message["type"] for message in examples}
    allowed_types = set(schema["properties"]["type"]["enum"])
    branches = payload_schemas(schema)

    assert set(branches) == allowed_types
    assert {
        "action.status.query",
        "action.status.result",
        "telemetry.subscribe",
        "telemetry.update",
        "pairing.status.result",
    } <= message_types
    for message in examples:
        assert_envelope(message, schema)


def test_protocol_negotiation_fails_closed_without_revision_duplication() -> None:
    schema = read_json(PROTOCOL_SCHEMA_PATH)
    examples = read_json(EXAMPLES_PATH)
    hello = next(message for message in examples if message["type"] == "client.hello")
    welcome = next(message for message in examples if message["type"] == "server.welcome")

    assert "last_accepted" not in schema["$defs"]["hello"]["properties"]
    assert "last_accepted" in schema["$defs"]["sync"]["properties"]
    assert_envelope(hello, schema)
    assert_envelope(welcome, schema)

    invalid_welcome = copy.deepcopy(welcome)
    invalid_welcome["payload"]["selected_configuration_version"] = 1
    with pytest.raises(AssertionError):
        assert_envelope(invalid_welcome, schema)

    invalid_protocol = copy.deepcopy(hello)
    invalid_protocol["protocol_version"] = 1
    with pytest.raises(AssertionError):
        assert_envelope(invalid_protocol, schema)


def test_configuration_delta_is_contiguous_and_uses_only_closed_operations() -> None:
    schema = read_json(PROTOCOL_SCHEMA_PATH)
    examples = read_json(EXAMPLES_PATH)
    delta = next(message for message in examples if message["type"] == "config.delta")
    operation_schemas = local_operation_schemas(schema)

    assert set(operation_schemas) == {
        "deck.replace",
        "profile.upsert",
        "profile.remove",
        "page.upsert",
        "page.remove",
        "button.upsert",
        "button.remove",
        "action.upsert",
        "action.remove",
        "command.upsert",
        "command.remove",
        "shortcut.upsert",
        "shortcut.remove",
        "settings.replace",
    }
    assert_envelope(delta, schema)

    bad_revision = copy.deepcopy(delta)
    bad_revision["payload"]["revision"] += 1
    with pytest.raises(AssertionError):
        assert_envelope(bad_revision, schema)

    boolean_revision = copy.deepcopy(delta)
    boolean_revision["payload"]["base_revision"] = True
    with pytest.raises(AssertionError):
        assert_envelope(boolean_revision, schema)

    unsafe_revision = copy.deepcopy(delta)
    unsafe_revision["payload"]["revision"] = 9007199254740992
    with pytest.raises(AssertionError):
        assert_envelope(unsafe_revision, schema)

    arbitrary_patch = copy.deepcopy(delta)
    arbitrary_patch["payload"]["operations"][0]["path"] = "/anything/exec"
    with pytest.raises(AssertionError):
        assert_envelope(arbitrary_patch, schema)


def test_run_command_is_a_windows_action_with_a_published_command_reference() -> None:
    schema = read_json(PROTOCOL_SCHEMA_PATH)
    config_schema = read_json(CONFIG_SCHEMA_PATH)
    config = read_json(SHARED_ROOT / "examples" / "config.v2.json")
    examples = read_json(EXAMPLES_PATH)
    request = next(
        message
        for message in examples
        if message["type"] == "action.execute"
        and message["payload"]["action"]["type"] == "run_command"
    )
    action = request["payload"]["action"]

    assert_envelope(request, schema)
    assert action["parameters"]["command_id"] in {
        command["id"] for command in config["commands"]
    }
    button = next(
        button
        for profile in config["profiles"]
        for page in profile["pages"]
        for button in page["buttons"]
        if button["id"] == request["payload"]["button_id"]
    )
    assert button["action_id"] == action["id"]
    assert_run_command_reference(action, config)

    unsupported_target = copy.deepcopy(request)
    unsupported_target["payload"]["action"]["target"] = "android_local"
    with pytest.raises(AssertionError):
        assert_envelope(unsupported_target, schema)

    unknown_command = copy.deepcopy(action)
    unknown_command["parameters"]["command_id"] = "missing-command"
    with pytest.raises(AssertionError):
        assert_run_command_reference(unknown_command, config)

    command_step_types = set(
        config_schema["$defs"]["commandStep"]["properties"]["type"]["enum"]
    )
    assert command_step_types == {"open_url", "keyboard_shortcut", "wait"}
    assert not {"run_command", "system_monitor", "application"} & command_step_types


def test_action_status_is_idempotent_and_unknown_is_not_failure() -> None:
    schema = read_json(PROTOCOL_SCHEMA_PATH)
    examples = read_json(EXAMPLES_PATH)
    request = next(
        message
        for message in examples
        if message["type"] == "action.execute"
        and message["payload"]["action"]["type"] == "run_command"
    )
    accepted = next(
        message
        for message in examples
        if message["type"] == "message.ack"
        and message["payload"].get("stage") == "action.accepted"
        and message["payload"].get("request_id") == request["message_id"]
    )
    query = next(
        message
        for message in examples
        if message["type"] == "action.status.query"
        and message["payload"]["request_id"] == request["message_id"]
    )
    result = next(
        message
        for message in examples
        if message["type"] == "action.status.result"
        and message["payload"]["request_id"] == request["message_id"]
    )

    assert accepted["payload"]["request_id"] == request["message_id"]
    assert query["payload"]["request_id"] == request["message_id"]
    assert result["payload"]["request_id"] == request["message_id"]
    assert result["payload"]["outcome"] == "unknown"
    assert result["payload"]["outcome"] != "failed"
    assert_envelope(result, schema)

    duplicate = copy.deepcopy(request)
    assert duplicate["message_id"] == request["message_id"]
    assert "message_id" not in schema["$defs"]["actionRequest"]["properties"]
    key_description = schema["$defs"]["actionRequest"]["$comment"]
    assert "authenticated device ID and message_id" in key_description
    assert duplicate["payload"] == request["payload"]
    error_codes = set(schema["$defs"]["error"]["properties"]["code"]["enum"])
    assert {"idempotency_conflict", "request_not_found", "request_expired"} <= error_codes

    malformed_unknown = copy.deepcopy(result)
    del malformed_unknown["payload"]["code"]
    with pytest.raises(AssertionError):
        assert_envelope(malformed_unknown, schema)


def test_telemetry_has_bounded_lifetime_and_explicit_sensor_availability() -> None:
    schema = read_json(PROTOCOL_SCHEMA_PATH)
    examples = read_json(EXAMPLES_PATH)
    subscription = next(
        message for message in examples if message["type"] == "telemetry.subscribe"
    )
    subscribed = next(
        message for message in examples if message["type"] == "telemetry.subscribed"
    )
    update = next(message for message in examples if message["type"] == "telemetry.update")

    interval_ms = subscribed["payload"]["interval_ms"]
    assert interval_ms == subscription["payload"]["interval_ms"]
    assert subscribed["payload"]["expires_after_ms"] == interval_ms * 3
    sampled_at = datetime.fromisoformat(update["payload"]["sampled_at"].replace("Z", "+00:00"))
    expires_at = datetime.fromisoformat(update["payload"]["expires_at"].replace("Z", "+00:00"))
    assert (expires_at - sampled_at).total_seconds() * 1000 == interval_ms * 3
    assert_envelope(update, schema)

    sampling_metric = copy.deepcopy(update["payload"]["metrics"]["cpu_utilization"])
    sampling_metric.update({"status": "sampling", "value": None})
    assert sampling_metric["value"] is None

    unavailable_cpu = copy.deepcopy(update)
    unavailable_cpu["payload"]["metrics"]["cpu_utilization"] = {
        "status": "unavailable",
        "value": None,
    }
    with pytest.raises(AssertionError):
        assert_envelope(unavailable_cpu, schema)

    invalid_gpu = copy.deepcopy(update)
    invalid_gpu["payload"]["metrics"]["gpu_utilization"]["status"] = "available"
    with pytest.raises(AssertionError):
        assert_envelope(invalid_gpu, schema)
    error_codes = set(schema["$defs"]["error"]["properties"]["code"]["enum"])
    assert "invalid_telemetry_subscription" in error_codes

    invalid_interval = copy.deepcopy(subscription)
    invalid_interval["payload"]["interval_ms"] = 100
    assert not (
        schema["$defs"]["telemetrySubscribe"]["properties"]["interval_ms"]["minimum"]
        <= invalid_interval["payload"]["interval_ms"]
        <= schema["$defs"]["telemetrySubscribe"]["properties"]["interval_ms"]["maximum"]
    )
