from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StringConstraints,
    ValidationError,
    field_validator,
)

from app.actions.definitions import DEFAULT_ACTION_REGISTRY
from app.actions.registry import ActionRegistry, ActionValidationError
from app.actions.windows_input import normalize_shortcut

PocketDeckId = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$",
    ),
]
ShortName = Annotated[str, StringConstraints(min_length=1, max_length=64)]
IconReference = Annotated[str, StringConstraints(min_length=1, max_length=128)]
ButtonColor = Annotated[
    str,
    StringConstraints(pattern=r"^#[0-9A-Fa-f]{6}$"),
]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Grid(StrictModel):
    columns: int = Field(ge=1, le=8)
    rows: int = Field(ge=1, le=8)


class Button(StrictModel):
    id: PocketDeckId
    label: ShortName
    icon: IconReference | None = None
    color: ButtonColor | None = None
    action_id: PocketDeckId | None


class Page(StrictModel):
    id: PocketDeckId
    name: ShortName
    grid: Grid
    buttons: list[Button] = Field(max_length=64)


class Profile(StrictModel):
    id: PocketDeckId
    name: ShortName
    pages: list[Page] = Field(min_length=1, max_length=32)


class ActionInstance(StrictModel):
    id: PocketDeckId
    type: str
    parameters: dict[str, Any]
    enabled_for_execution: StrictBool = False


class SavedShortcut(StrictModel):
    id: PocketDeckId
    name: ShortName
    shortcut: str

    @field_validator("shortcut")
    @classmethod
    def normalize_value(cls, value: str) -> str:
        return normalize_shortcut(value)


class CommandStep(StrictModel):
    type: str
    parameters: dict[str, Any]


class CustomCommand(StrictModel):
    id: PocketDeckId
    definition_version: Literal[1] = 1
    name: ShortName
    description: Annotated[str, StringConstraints(max_length=256)] = ""
    category: Annotated[str, StringConstraints(min_length=1, max_length=32)] = "General"
    enabled: StrictBool = True
    steps: list[CommandStep] = Field(min_length=1, max_length=20)


class ApplicationSettings(StrictModel):
    confirm_commands: StrictBool = False


class Configuration(StrictModel):
    schema_version: Literal[1]
    profiles: list[Profile] = Field(min_length=1, max_length=32)
    actions: list[ActionInstance] = Field(min_length=1, max_length=128)
    commands: list[CustomCommand] = Field(default_factory=list, max_length=64)
    shortcuts: list[SavedShortcut] = Field(default_factory=list, max_length=64)
    settings: ApplicationSettings = Field(default_factory=ApplicationSettings)


class ConfigurationValidationError(ValueError):
    def __init__(self, details: list[dict[str, object]]) -> None:
        super().__init__("Configuration validation failed.")
        self.code = "invalid_configuration"
        self.details = details

    def as_dict(self) -> dict[str, object]:
        return {
            "code": self.code,
            "message": str(self),
            "details": self.details,
        }


def _pydantic_details(error: ValidationError) -> list[dict[str, object]]:
    return [
        {
            "location": list(item["loc"]),
            "message": item["msg"],
            "type": item["type"],
        }
        for item in error.errors()
    ]


def validate_configuration(
    data: object, registry: ActionRegistry = DEFAULT_ACTION_REGISTRY
) -> Configuration:
    """Validate structure, references, IDs, limits, and registry parameters."""
    try:
        configuration = Configuration.model_validate(data)
    except ValidationError as error:
        raise ConfigurationValidationError(_pydantic_details(error)) from error

    details: list[dict[str, object]] = []
    ids: dict[str, tuple[str | int, ...]] = {}
    declared_action_ids = {action.id for action in configuration.actions}
    commands_by_id = {command.id: command for command in configuration.commands}
    shortcuts_by_id = {shortcut.id: shortcut for shortcut in configuration.shortcuts}

    def add_id(identifier: str, location: tuple[str | int, ...]) -> None:
        first_location = ids.get(identifier)
        if first_location is not None:
            details.append(
                {
                    "location": list(location),
                    "message": (
                        f"ID '{identifier}' duplicates the entity at "
                        f"{list(first_location)}."
                    ),
                    "type": "duplicate_id",
                }
            )
        else:
            ids[identifier] = location

    for profile_index, profile in enumerate(configuration.profiles):
        profile_location = ("profiles", profile_index, "id")
        add_id(profile.id, profile_location)
        for page_index, page in enumerate(profile.pages):
            page_location = ("profiles", profile_index, "pages", page_index)
            add_id(page.id, (*page_location, "id"))
            capacity = page.grid.columns * page.grid.rows
            if len(page.buttons) > capacity:
                details.append(
                    {
                        "location": [*page_location, "buttons"],
                        "message": (
                            f"Page grid holds {capacity} buttons but "
                            f"{len(page.buttons)} were provided."
                        ),
                        "type": "grid_capacity",
                    }
                )
            for button_index, button in enumerate(page.buttons):
                button_location = (*page_location, "buttons", button_index)
                add_id(button.id, (*button_location, "id"))
                if (
                    button.action_id is not None
                    and button.action_id not in declared_action_ids
                ):
                    details.append(
                        {
                            "location": [*button_location, "action_id"],
                            "message": (
                                f"Action ID '{button.action_id}' is not declared."
                            ),
                            "type": "unknown_action_id",
                        }
                    )

    for action_index, action in enumerate(configuration.actions):
        action_location = ("actions", action_index)
        add_id(action.id, (*action_location, "id"))
        if action.type == "system_monitor" and action.enabled_for_execution:
            details.append(
                {
                    "location": [*action_location, "enabled_for_execution"],
                    "message": "System monitor actions are read-only and must be disabled for execution.",
                    "type": "read_only_action",
                }
            )
        if action.type == "wait":
            details.append(
                {
                    "location": [*action_location, "type"],
                    "message": "Wait steps can only be used inside saved commands.",
                    "type": "sequence_only_action",
                }
            )
        try:
            registry.validate(action.type, action.parameters)
        except ActionValidationError as error:
            for item in error.details:
                details.append(
                    {
                        "location": [*action_location, *item.location],
                        "message": item.message,
                        "type": item.error_type,
                    }
                )

        if action.type == "run_command":
            command_id = action.parameters.get("command_id")
            if command_id not in commands_by_id:
                details.append(
                    {
                        "location": [*action_location, "parameters", "command_id"],
                        "message": f"Command ID '{command_id}' is not declared.",
                        "type": "unknown_command_id",
                    }
                )
        if action.type == "keyboard_shortcut":
            shortcut_id = action.parameters.get("shortcut_id")
            if shortcut_id is not None and shortcut_id not in shortcuts_by_id:
                details.append(
                    {
                        "location": [*action_location, "parameters", "shortcut_id"],
                        "message": f"Shortcut ID '{shortcut_id}' is not declared.",
                        "type": "unknown_shortcut_id",
                    }
                )

    for shortcut_index, shortcut in enumerate(configuration.shortcuts):
        shortcut_location = ("shortcuts", shortcut_index)
        add_id(shortcut.id, (*shortcut_location, "id"))
        try:
            registry.validate("keyboard_shortcut", {"shortcut": shortcut.shortcut})
        except ActionValidationError as error:
            for item in error.details:
                details.append(
                    {
                        "location": [*shortcut_location, *item.location],
                        "message": item.message,
                        "type": item.error_type,
                    }
                )

    for command_index, command in enumerate(configuration.commands):
        command_location = ("commands", command_index)
        add_id(command.id, (*command_location, "id"))
        for step_index, step in enumerate(command.steps):
            step_location = (*command_location, "steps", step_index)
            if step.type == "system_monitor":
                details.append(
                    {
                        "location": [*step_location, "type"],
                        "message": "System monitor metrics cannot be used as command steps.",
                        "type": "read_only_action",
                    }
                )
                continue
            try:
                registry.validate(step.type, step.parameters)
            except ActionValidationError as error:
                for item in error.details:
                    details.append(
                        {
                            "location": [*step_location, *item.location],
                            "message": item.message,
                            "type": item.error_type,
                        }
                    )
                continue
            if step.type == "run_command":
                details.append(
                    {
                        "location": [*step_location, "type"],
                        "message": "Nested commands are not supported.",
                        "type": "nested_command",
                    }
                )
            if step.type == "keyboard_shortcut":
                shortcut_id = step.parameters.get("shortcut_id")
                if shortcut_id is not None and shortcut_id not in shortcuts_by_id:
                    details.append(
                        {
                            "location": [*step_location, "parameters", "shortcut_id"],
                            "message": f"Shortcut ID '{shortcut_id}' is not declared.",
                            "type": "unknown_shortcut_id",
                        }
                    )

    if details:
        raise ConfigurationValidationError(details)
    return configuration
