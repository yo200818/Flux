import logging
import time
import webbrowser
from collections.abc import Sequence
from typing import Any

from pydantic import BaseModel

from app.actions.application import (
    is_windows_application_launch_available,
    launch_application,
)
from app.actions.definitions import (
    ApplicationParameters,
    DEFAULT_ACTION_REGISTRY,
    KeyboardShortcutParameters,
    OpenUrlParameters,
    RunCommandParameters,
    SystemControlParameters,
    WaitParameters,
)
from app.actions.registry import ActionRegistry, ActionValidationError
from app.actions.windows_input import (
    is_windows_input_available,
    send_keyboard_shortcut,
)
from app.actions.windows_system import (
    is_windows_system_control_available,
    perform_system_control,
)
from app.config.models import Configuration

logger = logging.getLogger(__name__)


class ActionExecutionError(Exception):
    def __init__(
        self,
        action_id: str,
        code: str,
        message: str,
        status_code: int,
        details: Sequence[dict[str, Any]] = (),
    ) -> None:
        super().__init__(message)
        self.action_id = action_id
        self.code = code
        self.status_code = status_code
        self.details = list(details)

    def as_dict(self) -> dict[str, Any]:
        return {
            "action_id": self.action_id,
            "success": False,
            "code": self.code,
            "message": str(self),
            "details": self.details,
        }


class ActionExecutionResult(BaseModel):
    action_id: str
    success: bool
    message: str


def execute_configured_action(
    configuration: Configuration,
    action_id: str,
    registry: ActionRegistry = DEFAULT_ACTION_REGISTRY,
) -> ActionExecutionResult:
    """Execute one explicitly enabled action referenced by a configured button."""
    action = next(
        (item for item in configuration.actions if item.id == action_id),
        None,
    )
    is_referenced = any(
        button.action_id == action_id
        for profile in configuration.profiles
        for page in profile.pages
        for button in page.buttons
    )
    if action is None or not is_referenced:
        raise ActionExecutionError(
            action_id=action_id,
            code="unknown_action_id",
            message="The requested action is not assigned to a configured button.",
            status_code=404,
        )

    if action.type == "system_monitor":
        raise ActionExecutionError(
            action_id=action_id,
            code="read_only_action",
            message="System monitor actions are read-only and cannot be executed.",
            status_code=409,
        )

    if not action.enabled_for_execution:
        raise ActionExecutionError(
            action_id=action_id,
            code="action_not_enabled",
            message="This action is not enabled for execution.",
            status_code=409,
        )

    try:
        parameters = registry.validate(action.type, action.parameters)
    except ActionValidationError as error:
        raise ActionExecutionError(
            action_id=action_id,
            code=error.code,
            message=str(error),
            status_code=422,
            details=[detail.as_dict() for detail in error.details],
        ) from error

    if action.type == "open_url":
        if not isinstance(parameters, OpenUrlParameters):
            raise ActionExecutionError(
                action_id=action_id,
                code="invalid_action_parameters",
                message="The registered URL action parameters are invalid.",
                status_code=422,
            )
        return _open_url(action_id, parameters)

    if action.type == "application":
        if not isinstance(parameters, ApplicationParameters):
            raise ActionExecutionError(
                action_id=action_id,
                code="invalid_action_parameters",
                message="The registered application parameters are invalid.",
                status_code=422,
            )
        if not is_windows_application_launch_available():
            raise ActionExecutionError(
                action_id=action_id,
                code="unsupported_platform",
                message="Application actions can only be launched on Windows.",
                status_code=409,
            )
        try:
            launch_application(parameters.path)
        except FileNotFoundError as error:
            logger.warning(
                "Selected executable for application action %s is missing: %s",
                action_id,
                error,
            )
            return ActionExecutionResult(
                action_id=action_id,
                success=False,
                message=f"The selected application '{parameters.name}' is no longer available. Choose it again in the button editor.",
            )
        except (OSError, ValueError) as error:
            logger.warning(
                "Could not launch application action %s: %s",
                action_id,
                error,
            )
            return ActionExecutionResult(
                action_id=action_id,
                success=False,
                message=f"Windows could not launch '{parameters.name}': {error}",
            )
        return ActionExecutionResult(
            action_id=action_id,
            success=True,
            message=f"Launched '{parameters.name}'.",
        )

    if action.type == "system_control":
        if not isinstance(parameters, SystemControlParameters):
            raise ActionExecutionError(
                action_id=action_id,
                code="invalid_action_parameters",
                message="The registered system control parameters are invalid.",
                status_code=422,
            )
        if not is_windows_system_control_available():
            raise ActionExecutionError(
                action_id=action_id,
                code="unsupported_platform",
                message="System controls are only supported on Windows.",
                status_code=409,
            )
        try:
            message = perform_system_control(parameters.control)
        except (OSError, ValueError) as error:
            logger.warning(
                "Could not execute system control %s for action %s: %s",
                parameters.control,
                action_id,
                error,
            )
            return ActionExecutionResult(
                action_id=action_id,
                success=False,
                message=str(error),
            )
        return ActionExecutionResult(
            action_id=action_id,
            success=True,
            message=message,
        )

    if action.type == "keyboard_shortcut":
        if not isinstance(parameters, KeyboardShortcutParameters):
            raise ActionExecutionError(
                action_id=action_id,
                code="invalid_action_parameters",
                message="The registered keyboard shortcut parameters are invalid.",
                status_code=422,
            )
        if not is_windows_input_available():
            raise ActionExecutionError(
                action_id=action_id,
                code="unsupported_platform",
                message="Keyboard shortcuts can only be executed on Windows.",
                status_code=409,
            )
        shortcut = parameters.shortcut
        if parameters.shortcut_id is not None:
            saved_shortcut = next(
                (
                    item
                    for item in configuration.shortcuts
                    if item.id == parameters.shortcut_id
                ),
                None,
            )
            if saved_shortcut is None:
                raise ActionExecutionError(
                    action_id=action_id,
                    code="unknown_shortcut_id",
                    message="The saved shortcut is no longer available.",
                    status_code=409,
                )
            shortcut = saved_shortcut.shortcut
        if shortcut is None:
            raise ActionExecutionError(
                action_id=action_id,
                code="invalid_action_parameters",
                message="No keyboard shortcut was provided.",
                status_code=422,
            )
        try:
            send_keyboard_shortcut(shortcut)
        except OSError as error:
            logger.warning(
                "Could not send keyboard shortcut for action %s: %s",
                action_id,
                error,
            )
            return ActionExecutionResult(
                action_id=action_id,
                success=False,
                message=(
                    "Windows could not send this shortcut. Make sure PocketDeck "
                    "and the active application run at the same privilege level."
                ),
            )
        return ActionExecutionResult(
            action_id=action_id,
            success=True,
            message=f"Sent the {shortcut.replace('_', ' ')} shortcut to the active window.",
        )

    if action.type == "run_command":
        if not isinstance(parameters, RunCommandParameters):
            raise ActionExecutionError(
                action_id=action_id,
                code="invalid_action_parameters",
                message="The registered command parameters are invalid.",
                status_code=422,
            )
        command = next(
            (
                item
                for item in configuration.commands
                if item.id == parameters.command_id
            ),
            None,
        )
        if command is None:
            raise ActionExecutionError(
                action_id=action_id,
                code="unknown_command_id",
                message="The saved command is no longer available.",
                status_code=404,
            )
        if not command.enabled:
            raise ActionExecutionError(
                action_id=action_id,
                code="command_not_enabled",
                message="This saved command is not enabled.",
                status_code=409,
            )
        for index, step in enumerate(command.steps, start=1):
            try:
                step_parameters = registry.validate(step.type, step.parameters)
            except ActionValidationError as error:
                raise ActionExecutionError(
                    action_id=action_id,
                    code=error.code,
                    message=f"Command step {index} failed validation.",
                    status_code=422,
                    details=[
                        {
                            **detail.as_dict(),
                            "location": ["steps", index - 1, *detail.location],
                        }
                        for detail in error.details
                    ],
                ) from error
            result = _execute_step(
                action_id,
                step.type,
                step_parameters,
                configuration,
            )
            if result is not None and not result.success:
                return ActionExecutionResult(
                    action_id=action_id,
                    success=False,
                    message=f"Command stopped at step {index}: {result.message}",
                )
        return ActionExecutionResult(
            action_id=action_id,
            success=True,
            message=f"Completed command '{command.name}' ({len(command.steps)} steps).",
        )

    raise ActionExecutionError(
        action_id=action_id,
        code="unsupported_action",
        message=f"Action type '{action.type}' cannot be executed.",
        status_code=409,
    )


def _execute_step(
    action_id: str,
    action_type: str,
    parameters: BaseModel,
    configuration: Configuration,
) -> ActionExecutionResult | None:
    if action_type == "open_url" and isinstance(parameters, OpenUrlParameters):
        return _open_url(action_id, parameters)
    if action_type == "wait" and isinstance(parameters, WaitParameters):
        time.sleep(parameters.milliseconds / 1000)
        return None
    if action_type != "keyboard_shortcut" or not isinstance(
        parameters, KeyboardShortcutParameters
    ):
        raise ActionExecutionError(
            action_id=action_id,
            code="unsupported_action",
            message=f"Action type '{action_type}' cannot be executed in a command.",
            status_code=409,
        )
    if not is_windows_input_available():
        raise ActionExecutionError(
            action_id=action_id,
            code="unsupported_platform",
            message="Keyboard shortcuts can only be executed on Windows.",
            status_code=409,
        )
    shortcut = parameters.shortcut
    if parameters.shortcut_id is not None:
        saved_shortcut = next(
            (
                item
                for item in configuration.shortcuts
                if item.id == parameters.shortcut_id
            ),
            None,
        )
        if saved_shortcut is None:
            raise ActionExecutionError(
                action_id=action_id,
                code="unknown_shortcut_id",
                message="The saved shortcut is no longer available.",
                status_code=409,
            )
        shortcut = saved_shortcut.shortcut
    if shortcut is None:
        raise ActionExecutionError(
            action_id=action_id,
            code="invalid_action_parameters",
            message="No keyboard shortcut was provided.",
            status_code=422,
        )
    try:
        send_keyboard_shortcut(shortcut)
    except OSError as error:
        logger.warning(
            "Could not send keyboard shortcut for command step on action %s: %s",
            action_id,
            error,
        )
        return ActionExecutionResult(
            action_id=action_id,
            success=False,
            message=(
                "Windows could not send this shortcut. Make sure PocketDeck "
                "and the active application run at the same privilege level."
            ),
        )
    return ActionExecutionResult(
        action_id=action_id,
        success=True,
        message=f"Sent the {shortcut.replace('_', ' ')} shortcut to the active window.",
    )


def _open_url(
    action_id: str, parameters: OpenUrlParameters
) -> ActionExecutionResult:
    url = str(parameters.url)
    try:
        opened = webbrowser.open(url, new=2)
    except Exception:
        logger.exception("Could not open URL for action %s.", action_id)
        return ActionExecutionResult(
            action_id=action_id,
            success=False,
            message="The operating system could not open the URL in a browser.",
        )

    if not opened:
        return ActionExecutionResult(
            action_id=action_id,
            success=False,
            message="The operating system could not open the URL in a browser.",
        )
    return ActionExecutionResult(
        action_id=action_id,
        success=True,
        message="Opened the URL in the default browser.",
    )
