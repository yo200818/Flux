from typing import Annotated, Literal
from pathlib import PureWindowsPath

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    StringConstraints,
    field_validator,
    model_validator,
)

from app.actions.registry import ActionDefinition, ActionRegistry
from app.actions.windows_input import normalize_shortcut


class OpenUrlParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    url: HttpUrl
    name: Annotated[str, StringConstraints(min_length=1, max_length=64)] | None = None


class ApplicationParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, StringConstraints(min_length=1, max_length=64)]
    path: Annotated[str, StringConstraints(min_length=3, max_length=32768)]

    @field_validator("path")
    @classmethod
    def validate_executable_path(cls, value: str) -> str:
        path = PureWindowsPath(value)
        if (
            "\x00" in value
            or '"' in value
            or not path.is_absolute()
            or path.suffix.casefold() != ".exe"
            or any(
                any(character in '<>"|?*' for character in component)
                for component in path.parts[1:]
            )
        ):
            raise ValueError(
                "Choose an absolute Windows path to an .exe file; do not include arguments or quotes."
            )
        return value


class SystemControlParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    control: Literal[
        "volume_up",
        "volume_down",
        "mute_toggle",
        "brightness_up",
        "brightness_down",
    ]


class SystemMonitorParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metric: Literal[
        "cpu_utilization",
        "memory_usage",
        "gpu_utilization",
        "gpu_temperature",
        "cpu_temperature",
    ]


class KeyboardShortcutParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    shortcut: Annotated[str, StringConstraints(min_length=1, max_length=64)] | None = None
    shortcut_id: Annotated[
        str,
        StringConstraints(
            min_length=1,
            max_length=64,
            pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$",
        ),
    ] | None = None

    @field_validator("shortcut")
    @classmethod
    def validate_shortcut(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return normalize_shortcut(value)

    @model_validator(mode="after")
    def validate_shortcut_reference(self) -> "KeyboardShortcutParameters":
        if (self.shortcut is None) == (self.shortcut_id is None):
            raise ValueError("Provide exactly one shortcut or shortcut_id.")
        return self


class RunCommandParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    command_id: Annotated[
        str,
        StringConstraints(
            min_length=1,
            max_length=64,
            pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]*$",
        ),
    ]


class WaitParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    milliseconds: int = Field(ge=0, le=10000)


def create_default_registry() -> ActionRegistry:
    registry = ActionRegistry()
    registry.register(
        ActionDefinition(
            action_type="open_url",
            description="Open a validated HTTP or HTTPS URL.",
            parameters_model=OpenUrlParameters,
        )
    )
    registry.register(
        ActionDefinition(
            action_type="application",
            description="Launch one explicitly selected Windows executable.",
            parameters_model=ApplicationParameters,
        )
    )
    registry.register(
        ActionDefinition(
            action_type="system_control",
            description="Perform one allowlisted Windows volume or brightness operation.",
            parameters_model=SystemControlParameters,
        )
    )
    registry.register(
        ActionDefinition(
            action_type="system_monitor",
            description="Display read-only local system telemetry.",
            parameters_model=SystemMonitorParameters,
        )
    )
    registry.register(
        ActionDefinition(
            action_type="keyboard_shortcut",
            description="Send a predefined keyboard shortcut to the active Windows window.",
            parameters_model=KeyboardShortcutParameters,
        )
    )
    registry.register(
        ActionDefinition(
            action_type="run_command",
            description="Run a saved, validated PocketDeck command definition.",
            parameters_model=RunCommandParameters,
        )
    )
    registry.register(
        ActionDefinition(
            action_type="wait",
            description="Wait for a bounded period within a saved command.",
            parameters_model=WaitParameters,
        )
    )
    return registry


DEFAULT_ACTION_REGISTRY = create_default_registry()
