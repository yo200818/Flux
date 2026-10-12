from __future__ import annotations

import copy
import json
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from uuid import UUID, uuid5

from app.actions.windows_input import normalize_shortcut
from app.config.models import ConfigurationValidationError, validate_configuration


V2_SCHEMA_RELATIVE_PATH = (
    Path("shared") / "schemas" / "v2" / "config.schema.json"
)
LEGACY_DECK_KEY = "pocketdeck/legacy-primary-deck"


def get_v2_schema_path() -> Path:
    """Resolve the shared v2 schema in source and PyInstaller distributions."""
    if getattr(sys, "frozen", False):
        bundle_directory = getattr(sys, "_MEIPASS", None)
        if not isinstance(bundle_directory, str):
            raise RuntimeError(
                "The packaged backend is missing its PyInstaller resource directory."
            )
        root = Path(bundle_directory)
    else:
        root = Path(__file__).resolve().parents[3]
    return root / V2_SCHEMA_RELATIVE_PATH


class ConfigurationMigrationError(ValueError):
    """Raised when a v1 configuration cannot be represented safely in v2."""


def migrate_v1_to_v2(
    source: object,
    installation_namespace: UUID | str,
) -> dict[str, Any]:
    """Convert a validated v1 document without mutating or persisting its source."""
    try:
        namespace = (
            installation_namespace
            if isinstance(installation_namespace, UUID)
            else UUID(installation_namespace)
        )
    except (AttributeError, TypeError, ValueError) as error:
        raise ConfigurationMigrationError(
            "A persisted Windows installation UUID namespace is required."
        ) from error

    try:
        validated_source = validate_configuration(copy.deepcopy(source))
    except ConfigurationValidationError as error:
        details = "; ".join(
            f"{'.'.join(str(part) for part in detail['location'])}: {detail['message']}"
            for detail in error.details
        )
        raise ConfigurationMigrationError(
            "The v1 configuration is invalid and was not migrated"
            f"{': ' + details if details else '.'}"
        ) from error

    legacy_data = validated_source.model_dump(mode="json")
    _canonicalize_inline_shortcuts(legacy_data)
    candidate: dict[str, Any] = {
        "schema_version": 2,
        "deck": {
            "id": str(uuid5(namespace, LEGACY_DECK_KEY)),
            "name": "PocketDeck",
        },
        "profiles": legacy_data["profiles"],
        "actions": [
            {**action, "target": "windows_host"}
            for action in legacy_data["actions"]
        ],
        "commands": legacy_data["commands"],
        "shortcuts": legacy_data["shortcuts"],
        "settings": legacy_data["settings"],
    }
    validate_v2_migration_candidate(candidate)
    return candidate


def validate_v2_migration_candidate(candidate: object) -> None:
    """Validate migrated data against the shared v2 shape and v1 domain rules."""
    if not isinstance(candidate, dict):
        raise ConfigurationMigrationError("The v2 configuration must be an object.")
    if any(not isinstance(key, str) for key in candidate):
        raise ConfigurationMigrationError("V2 configuration field names must be strings.")

    try:
        schema = json.loads(get_v2_schema_path().read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ConfigurationMigrationError(
            "The shared v2 configuration schema could not be loaded."
        ) from error

    required_keys = set(schema["required"])
    allowed_keys = set(schema["properties"])
    if not required_keys <= candidate.keys():
        missing = sorted(required_keys - candidate.keys())
        raise ConfigurationMigrationError(
            f"The migrated v2 configuration is missing required fields: {missing}."
        )
    if not candidate.keys() <= allowed_keys:
        unknown = sorted(candidate.keys() - allowed_keys)
        raise ConfigurationMigrationError(
            f"The migrated v2 configuration has unsupported fields: {unknown}."
        )
    if type(candidate["schema_version"]) is not int or candidate["schema_version"] != schema[
        "properties"]["schema_version"]["const"]:
        raise ConfigurationMigrationError("The migrated configuration is not schema v2.")

    deck = candidate["deck"]
    deck_schema = schema["properties"]["deck"]
    if not isinstance(deck, dict) or set(deck) != set(deck_schema["required"]):
        raise ConfigurationMigrationError("The migrated v2 deck identity is malformed.")
    identifier = deck["id"]
    identifier_schema = schema["$defs"]["id"]
    if (
        not isinstance(identifier, str)
        or not identifier_schema["minLength"] <= len(identifier) <= identifier_schema["maxLength"]
        or re.fullmatch(identifier_schema["pattern"], identifier) is None
    ):
        raise ConfigurationMigrationError("The migrated v2 deck ID is invalid.")
    deck_name = deck["name"]
    name_schema = deck_schema["properties"]["name"]
    if (
        not isinstance(deck_name, str)
        or not name_schema["minLength"] <= len(deck_name) <= name_schema["maxLength"]
    ):
        raise ConfigurationMigrationError("The migrated v2 deck name is invalid.")

    action_schema = schema["$defs"]["action"]
    allowed_targets = set(action_schema["properties"]["target"]["enum"])
    allowed_types = set(action_schema["properties"]["type"]["enum"])
    windows_only_types = {
        guard["if"]["properties"]["type"]["const"]
        for guard in action_schema["allOf"]
        if "target" in guard.get("then", {}).get("properties", {})
        and guard["then"]["properties"]["target"].get("const") == "windows_host"
    }
    action_required = set(action_schema["required"])
    actions = candidate.get("actions")
    if not isinstance(actions, list):
        raise ConfigurationMigrationError("The migrated v2 actions must be an array.")
    for index, action in enumerate(actions):
        if not isinstance(action, dict) or set(action) != action_required:
            raise ConfigurationMigrationError(
                f"The migrated action at index {index} does not match the v2 action fields."
            )
        if (
            not isinstance(action["type"], str)
            or not isinstance(action["target"], str)
            or action["type"] not in allowed_types
            or action["target"] not in allowed_targets
        ):
            raise ConfigurationMigrationError(
                f"The migrated action at index {index} has an unsupported type or target."
            )
        if action["type"] in windows_only_types and action["target"] != "windows_host":
            raise ConfigurationMigrationError(
                f"The migrated {action['type']} action must target windows_host."
            )

    legacy_candidate = copy.deepcopy(candidate)
    legacy_candidate.pop("deck")
    legacy_candidate["schema_version"] = 1
    for action in legacy_candidate["actions"]:
        action.pop("target")

    try:
        validated_legacy = validate_configuration(legacy_candidate)
    except ConfigurationValidationError as error:
        details = "; ".join(
            f"{'.'.join(str(part) for part in detail['location'])}: {detail['message']}"
            for detail in error.details
        )
        raise ConfigurationMigrationError(
            "The migrated v2 configuration failed semantic validation"
            f"{': ' + details if details else '.'}"
        ) from error

    if identifier in _legacy_entity_ids(validated_legacy.model_dump(mode="json")):
        raise ConfigurationMigrationError(
            "The deterministic v2 deck ID conflicts with a preserved v1 entity ID."
        )

    _validate_v2_specific_parameters(candidate, schema)


def _canonicalize_inline_shortcuts(configuration: dict[str, Any]) -> None:
    for action in configuration["actions"]:
        if action["type"] == "keyboard_shortcut":
            parameters = action["parameters"]
            if "shortcut" in parameters:
                parameters["shortcut"] = normalize_shortcut(parameters["shortcut"])

    for command in configuration["commands"]:
        for step in command["steps"]:
            if step["type"] == "keyboard_shortcut":
                parameters = step["parameters"]
                if "shortcut" in parameters:
                    parameters["shortcut"] = normalize_shortcut(parameters["shortcut"])


def _validate_v2_specific_parameters(
    configuration: Mapping[str, Any], schema: Mapping[str, Any]
) -> None:
    shortcut_schema = schema["$defs"]["keyboardShortcutValue"]

    def validate_url(parameters: Mapping[str, Any], path: str) -> None:
        url_schema = schema["$defs"]["openUrlParameters"]["properties"]["url"]
        url = parameters["url"]
        if not isinstance(url, str) or len(url) > url_schema["maxLength"]:
            raise ConfigurationMigrationError(f"{path}.url is not representable in v2.")
        if "name" in parameters:
            name_schema = schema["$defs"]["openUrlParameters"]["properties"]["name"]
            name = parameters["name"]
            if (
                not isinstance(name, str)
                or not name_schema["minLength"] <= len(name) <= name_schema["maxLength"]
            ):
                raise ConfigurationMigrationError(
                    f"{path}.name is not representable in v2."
                )

    def validate_shortcut(value: object, path: str) -> None:
        if (
            not isinstance(value, str)
            or len(value) > shortcut_schema["maxLength"]
            or re.fullmatch(shortcut_schema["pattern"], value) is None
            or any(
                re.search(rule["not"]["pattern"], value)
                for rule in shortcut_schema["allOf"]
            )
        ):
            raise ConfigurationMigrationError(f"{path} is not representable in v2.")

    for index, action in enumerate(configuration["actions"]):
        parameters = action["parameters"]
        if action["type"] == "open_url":
            validate_url(parameters, f"actions[{index}].parameters")
        elif action["type"] == "keyboard_shortcut" and "shortcut" in parameters:
            validate_shortcut(parameters["shortcut"], f"actions[{index}].parameters.shortcut")

    for shortcut_index, shortcut in enumerate(configuration.get("shortcuts", [])):
        validate_shortcut(
            shortcut["shortcut"], f"shortcuts[{shortcut_index}].shortcut"
        )

    for command_index, command in enumerate(configuration.get("commands", [])):
        for step_index, step in enumerate(command["steps"]):
            parameters = step["parameters"]
            path = f"commands[{command_index}].steps[{step_index}].parameters"
            if step["type"] == "open_url":
                validate_url(parameters, path)
            elif step["type"] == "keyboard_shortcut" and "shortcut" in parameters:
                validate_shortcut(parameters["shortcut"], f"{path}.shortcut")
            elif step["type"] == "wait" and type(parameters["milliseconds"]) is not int:
                raise ConfigurationMigrationError(
                    f"{path}.milliseconds must be an integer in v2."
                )


def _legacy_entity_ids(configuration: Mapping[str, Any]) -> set[str]:
    identifiers = {action["id"] for action in configuration["actions"]}
    for profile in configuration["profiles"]:
        identifiers.add(profile["id"])
        for page in profile["pages"]:
            identifiers.add(page["id"])
            identifiers.update(button["id"] for button in page["buttons"])
    identifiers.update(command["id"] for command in configuration["commands"])
    identifiers.update(shortcut["id"] for shortcut in configuration["shortcuts"])
    return identifiers
