import ctypes
from ctypes import wintypes
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from app.actions.windows_system import perform_system_control


class FakeDxva2:
    def __init__(self, displays: dict[int, tuple[int, int, int] | None]) -> None:
        self.displays = displays
        self.updated: dict[int, int] = {}
        self.destroyed: list[int] = []

    def GetMonitorBrightness(self, handle, minimum, maximum, current):
        levels = self.displays[handle]
        if levels is None:
            return 0
        for pointer, value in zip((minimum, maximum, current), levels, strict=True):
            ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD)).contents.value = value
        return 1

    def SetMonitorBrightness(self, handle, target):
        self.updated[handle] = target
        return 1

    def DestroyPhysicalMonitors(self, count, monitors):
        self.destroyed.append(count)
        return 1


@pytest.mark.parametrize(
    ("control", "expected"),
    [
        ("volume_up", "Volume up."),
        ("volume_down", "Volume down."),
        ("mute_toggle", "Mute toggled."),
    ],
)
def test_volume_controls_send_only_the_expected_allowlisted_key(
    control: str,
    expected: str,
) -> None:
    with (
        patch(
            "app.actions.windows_system.is_windows_system_control_available",
            return_value=True,
        ),
        patch("app.actions.windows_system.send_system_control_key") as send_key,
    ):
        assert perform_system_control(control) == expected

    send_key.assert_called_once_with(control)


@pytest.mark.parametrize(
    ("control", "expected"),
    [
        ("brightness_up", 50),
        ("brightness_down", 30),
    ],
)
def test_brightness_updates_controllable_monitors_by_ten_percent(
    control: str,
    expected: int,
) -> None:
    dxva2 = FakeDxva2({1: (0, 100, 40)})
    monitors = [[SimpleNamespace(handle=1)]]
    with (
        patch(
            "app.actions.windows_system.is_windows_system_control_available",
            return_value=True,
        ),
        patch(
            "app.actions.windows_system._enumerate_physical_monitors",
            return_value=(dxva2, monitors),
        ),
    ):
        message = perform_system_control(control)

    assert dxva2.updated == {1: expected}
    assert dxva2.destroyed == [1]
    assert "1 display(s)" in message


def test_brightness_changes_supported_displays_and_reports_unsupported_ones() -> None:
    dxva2 = FakeDxva2({1: (0, 100, 40), 2: None})
    monitors = [[SimpleNamespace(handle=1), SimpleNamespace(handle=2)]]
    with (
        patch(
            "app.actions.windows_system.is_windows_system_control_available",
            return_value=True,
        ),
        patch(
            "app.actions.windows_system._enumerate_physical_monitors",
            return_value=(dxva2, monitors),
        ),
    ):
        message = perform_system_control("brightness_up")

    assert dxva2.updated == {1: 50}
    assert "1 other display(s) did not expose controllable brightness" in message


def test_brightness_reports_unsupported_display_and_releases_monitor_handles() -> None:
    dxva2 = FakeDxva2({1: None})
    monitors = [[SimpleNamespace(handle=1)]]
    with (
        patch(
            "app.actions.windows_system.is_windows_system_control_available",
            return_value=True,
        ),
        patch(
            "app.actions.windows_system._enumerate_physical_monitors",
            return_value=(dxva2, monitors),
        ),
        pytest.raises(OSError, match="may not support DDC/CI brightness control"),
    ):
        perform_system_control("brightness_down")

    assert dxva2.destroyed == [1]


def test_unknown_system_control_never_dispatches() -> None:
    with (
        patch(
            "app.actions.windows_system.is_windows_system_control_available",
            return_value=True,
        ),
        patch("app.actions.windows_system.send_system_control_key") as send_key,
        pytest.raises(ValueError, match="Unsupported Windows system control"),
    ):
        perform_system_control("set_volume:100")

    send_key.assert_not_called()
