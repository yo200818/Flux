from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError


@dataclass(frozen=True)
class ActionErrorDetail:
    location: tuple[str | int, ...]
    message: str
    error_type: str

    def as_dict(self) -> dict[str, object]:
        return {
            "location": list(self.location),
            "message": self.message,
            "type": self.error_type,
        }


class ActionValidationError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        details: tuple[ActionErrorDetail, ...] = (),
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details

    def as_dict(self) -> dict[str, object]:
        return {
            "code": self.code,
            "message": str(self),
            "details": [detail.as_dict() for detail in self.details],
        }


@dataclass(frozen=True)
class ActionDefinition:
    action_type: str
    description: str
    parameters_model: type[BaseModel]


class ActionRegistry:
    """Registers allowlisted action types and validates their parameters."""

    def __init__(self) -> None:
        self._definitions: dict[str, ActionDefinition] = {}

    def register(self, definition: ActionDefinition) -> None:
        if not definition.action_type:
            raise ValueError("Action type must not be empty.")
        if definition.action_type in self._definitions:
            raise ValueError(
                f"Action type '{definition.action_type}' is already registered."
            )
        if not issubclass(definition.parameters_model, BaseModel):
            raise TypeError("Action parameter models must inherit from BaseModel.")
        self._definitions[definition.action_type] = definition

    def list_actions(self) -> tuple[ActionDefinition, ...]:
        return tuple(
            self._definitions[action_type]
            for action_type in sorted(self._definitions)
        )

    def lookup(self, action_type: str) -> ActionDefinition:
        definition = self._definitions.get(action_type)
        if definition is None:
            raise ActionValidationError(
                code="unknown_action_type",
                message=f"Unsupported action type '{action_type}'.",
                details=(
                    ActionErrorDetail(
                        location=("type",),
                        message="Action type is not registered.",
                        error_type="unknown_action_type",
                    ),
                ),
            )
        return definition

    def validate(
        self, action_type: str, parameters: Mapping[str, Any]
    ) -> BaseModel:
        definition = self.lookup(action_type)
        if not isinstance(parameters, Mapping):
            raise ActionValidationError(
                code="invalid_action_parameters",
                message="Action parameters must be a JSON object.",
                details=(
                    ActionErrorDetail(
                        location=("parameters",),
                        message="Input must be a JSON object.",
                        error_type="model_type",
                    ),
                ),
            )

        try:
            return definition.parameters_model.model_validate(parameters)
        except ValidationError as error:
            details = tuple(
                ActionErrorDetail(
                    location=("parameters", *item["loc"]),
                    message=item["msg"],
                    error_type=item["type"],
                )
                for item in error.errors()
            )
            raise ActionValidationError(
                code="invalid_action_parameters",
                message=f"Invalid parameters for action '{action_type}'.",
                details=details,
            ) from error
