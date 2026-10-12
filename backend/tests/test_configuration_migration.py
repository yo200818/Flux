from __future__ import annotations

import copy
import json
from pathlib import Path
from uuid import UUID, uuid5

import pytest

from app.config import migration
from app.config.migration import (
    ConfigurationMigrationError,
    LEGACY_DECK_KEY,
    V2_SCHEMA_RELATIVE_PATH,
    migrate_v1_to_v2,
    validate_v2_migration_candidate,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
V1_EXAMPLE_PATH = REPOSITORY_ROOT / "shared" / "examples" / "config.v1.json"
INSTALLATION_NAMESPACE = UUID("8aa8ce90-35fa-4ab2-9c49-5d4732cb3267")


def load_v1_example() -> dict[str, object]:
    return json.loads(V1_EXAMPLE_PATH.read_text(encoding="utf-8"))


def representative_v1_configuration() -> dict[str, object]:
    configuration = load_v1_example()
    profile = configuration["profiles"][0]
    page = profile["pages"][0]
    page["buttons"][1]["action_id"] = "saved-shortcut-action"
    page["buttons"][2]["action_id"] = None
    page["buttons"].extend(
        [
            {
                "id": "command-button",
                "label": "Run setup",
                "icon": "play",
                "color": "#12AB34",
                "action_id": "saved-command-action",
            },
            {
                "id": "monitor-button",
                "label": "CPU",
                "action_id": "cpu-monitor-action",
            },
        ]
    )
    configuration["actions"][1]["parameters"] = {
        "shortcut": "shift+ctrl+win+F24"
    }
    configuration["actions"].extend(
        [
            {
                "id": "saved-shortcut-action",
                "type": "keyboard_shortcut",
                "enabled_for_execution": True,
                "parameters": {"shortcut_id": "saved-copy-shortcut"},
            },
            {
                "id": "saved-command-action",
                "type": "run_command",
                "enabled_for_execution": True,
                "parameters": {"command_id": "prepare-copy-command"},
            },
            {
                "id": "cpu-monitor-action",
                "type": "system_monitor",
                "enabled_for_execution": False,
                "parameters": {"metric": "cpu_utilization"},
            },
        ]
    )
    configuration["commands"] = [
        {
            "id": "prepare-copy-command",
            "definition_version": 1,
            "name": "Prepare Copy",
            "description": "Open, copy, then pause.",
            "category": "General",
            "enabled": True,
            "steps": [
                {
                    "type": "open_url",
                    "parameters": {"url": "https://example.com/"},
                },
                {
                    "type": "keyboard_shortcut",
                    "parameters": {"shortcut_id": "saved-copy-shortcut"},
                },
                {"type": "wait", "parameters": {"milliseconds": 250}},
                {
                    "type": "keyboard_shortcut",
                    "parameters": {"shortcut": "shift+ctrl+win+F24"},
                },
            ],
        }
    ]
    configuration["shortcuts"] = [
        {"id": "saved-copy-shortcut", "name": "Copy", "shortcut": "copy"}
    ]
    configuration["settings"] = {"confirm_commands": True}
    return configuration


def test_migration_preserves_v1_data_and_assigns_windows_targets() -> None:
    source = representative_v1_configuration()
    original = copy.deepcopy(source)

    migrated = migrate_v1_to_v2(source, INSTALLATION_NAMESPACE)

    assert source == original
    assert migrated["schema_version"] == 2
    assert migrated["deck"] == {
        "id": str(uuid5(INSTALLATION_NAMESPACE, LEGACY_DECK_KEY)),
        "name": "PocketDeck",
    }
    assert [profile["id"] for profile in migrated["profiles"]] == [
        profile["id"] for profile in source["profiles"]
    ]

    source_page = source["profiles"][0]["pages"][0]
    migrated_page = migrated["profiles"][0]["pages"][0]
    assert migrated_page["id"] == source_page["id"]
    assert migrated_page["name"] == source_page["name"]
    assert migrated_page["grid"] == source_page["grid"]
    assert [button["id"] for button in migrated_page["buttons"]] == [
        button["id"] for button in source_page["buttons"]
    ]
    assert [button["label"] for button in migrated_page["buttons"]] == [
        button["label"] for button in source_page["buttons"]
    ]
    assert [button["action_id"] for button in migrated_page["buttons"]] == [
        button["action_id"] for button in source_page["buttons"]
    ]
    assert migrated_page["buttons"][2]["action_id"] is None
    assert migrated_page["buttons"][0]["icon"] == source_page["buttons"][0]["icon"]
    assert migrated_page["buttons"][3]["color"] == "#12AB34"

    assert [action["id"] for action in migrated["actions"]] == [
        action["id"] for action in source["actions"]
    ]
    assert all(action["target"] == "windows_host" for action in migrated["actions"])
    expected_commands = copy.deepcopy(source["commands"])
    expected_commands[0]["steps"][3]["parameters"]["shortcut"] = (
        "CTRL+SHIFT+WIN+F24"
    )
    assert migrated["commands"] == expected_commands
    assert migrated["shortcuts"] == source["shortcuts"]
    assert migrated["settings"] == source["settings"]
    assert migrated["actions"][-2]["parameters"] == {
        "command_id": "prepare-copy-command"
    }
    assert migrated["actions"][1]["parameters"]["shortcut"] == (
        "CTRL+SHIFT+WIN+F24"
    )
    assert migrated["commands"][0]["steps"][3]["parameters"]["shortcut"] == (
        "CTRL+SHIFT+WIN+F24"
    )
    assert migrated["profiles"][0]["pages"][0]["buttons"][-1]["action_id"] == (
        "cpu-monitor-action"
    )
    assert migrated["actions"][-1]["enabled_for_execution"] is False


def test_migration_loads_schema_from_pyinstaller_resources(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    packaged_schema = tmp_path / V2_SCHEMA_RELATIVE_PATH
    packaged_schema.parent.mkdir(parents=True)
    packaged_schema.write_text(
        (REPOSITORY_ROOT / V2_SCHEMA_RELATIVE_PATH).read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    monkeypatch.setattr(migration.sys, "frozen", True, raising=False)
    monkeypatch.setattr(migration.sys, "_MEIPASS", str(tmp_path), raising=False)

    assert migration.get_v2_schema_path() == packaged_schema
    assert migrate_v1_to_v2(
        load_v1_example(), INSTALLATION_NAMESPACE
    )["schema_version"] == 2


def test_migration_is_deterministic_and_does_not_mutate_source() -> None:
    source = representative_v1_configuration()
    original = copy.deepcopy(source)

    first = migrate_v1_to_v2(source, str(INSTALLATION_NAMESPACE))
    second = migrate_v1_to_v2(source, str(INSTALLATION_NAMESPACE))

    assert first == second
    assert source == original


def test_migration_rejects_monitor_and_nested_command_steps() -> None:
    source = representative_v1_configuration()
    original = copy.deepcopy(source)
    source["commands"][0]["steps"][0] = {
        "type": "system_monitor",
        "parameters": {"metric": "cpu_utilization"},
    }
    invalid_monitor = copy.deepcopy(source)

    with pytest.raises(ConfigurationMigrationError, match="v1 configuration is invalid"):
        migrate_v1_to_v2(source, INSTALLATION_NAMESPACE)
    assert source == invalid_monitor

    nested_command = copy.deepcopy(original)
    nested_command["commands"][0]["steps"][0] = {
        "type": "run_command",
        "parameters": {"command_id": "prepare-copy-command"},
    }
    before = copy.deepcopy(nested_command)
    with pytest.raises(ConfigurationMigrationError, match="v1 configuration is invalid"):
        migrate_v1_to_v2(nested_command, INSTALLATION_NAMESPACE)
    assert nested_command == before


def test_migration_rejects_unsupported_source_fields_without_data_loss() -> None:
    source = representative_v1_configuration()
    source["unsupported_extension"] = {"value": 1}
    original = copy.deepcopy(source)

    with pytest.raises(ConfigurationMigrationError, match="v1 configuration is invalid"):
        migrate_v1_to_v2(source, INSTALLATION_NAMESPACE)

    assert source == original


def test_invalid_v2_candidate_is_rejected() -> None:
    candidate = migrate_v1_to_v2(
        representative_v1_configuration(), INSTALLATION_NAMESPACE
    )
    candidate["actions"][-2]["target"] = "android_local"

    with pytest.raises(ConfigurationMigrationError, match="must target windows_host"):
        validate_v2_migration_candidate(candidate)


def test_unrepresentable_v1_value_is_rejected_without_mutation() -> None:
    source = representative_v1_configuration()
    source["actions"][0]["parameters"]["name"] = None
    original = copy.deepcopy(source)

    with pytest.raises(
        ConfigurationMigrationError,
        match=r"actions\[0\]\.parameters\.name",
    ):
        migrate_v1_to_v2(source, INSTALLATION_NAMESPACE)

    assert source == original


def test_v2_candidate_rejects_boolean_wait_duration_without_mutating_source() -> None:
    source = representative_v1_configuration()
    source["commands"][0]["steps"][2]["parameters"]["milliseconds"] = True
    original = copy.deepcopy(source)

    with pytest.raises(ConfigurationMigrationError, match="must be an integer"):
        migrate_v1_to_v2(source, INSTALLATION_NAMESPACE)

    assert source == original


def test_invalid_installation_namespace_is_rejected() -> None:
    source = representative_v1_configuration()
    original = copy.deepcopy(source)

    with pytest.raises(ConfigurationMigrationError, match="persisted Windows installation UUID"):
        migrate_v1_to_v2(source, "not-a-uuid")

    assert source == original
