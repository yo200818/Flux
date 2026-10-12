import ctypes
import logging
import os
from ctypes import wintypes
from typing import Any

from app.actions.windows_input import send_system_control_key

logger = logging.getLogger(__name__)

_VOLUME_CONTROLS = {
    "volume_up": "Volume up",
    "volume_down": "Volume down",
    "mute_toggle": "Mute toggled",
}


class _PhysicalMonitor(ctypes.Structure):
    _fields_ = [
        ("handle", wintypes.HANDLE),
        ("description", wintypes.WCHAR * 128),
    ]


def is_windows_system_control_available() -> bool:
    return os.name == "nt"


def _enumerate_physical_monitors() -> tuple[Any, list[Any]]:
    dxva2 = ctypes.WinDLL("dxva2", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    buffers: list[Any] = []
    dxva2.GetNumberOfPhysicalMonitorsFromHMONITOR.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.DWORD),
    )
    dxva2.GetNumberOfPhysicalMonitorsFromHMONITOR.restype = wintypes.BOOL
    dxva2.GetPhysicalMonitorsFromHMONITOR.argtypes = (
        wintypes.HANDLE,
        wintypes.DWORD,
        ctypes.POINTER(_PhysicalMonitor),
    )
    dxva2.GetPhysicalMonitorsFromHMONITOR.restype = wintypes.BOOL
    dxva2.GetMonitorBrightness.argtypes = (
        wintypes.HANDLE,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.DWORD),
    )
    dxva2.GetMonitorBrightness.restype = wintypes.BOOL
    dxva2.SetMonitorBrightness.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    dxva2.SetMonitorBrightness.restype = wintypes.BOOL
    dxva2.DestroyPhysicalMonitors.argtypes = (
        wintypes.DWORD,
        ctypes.POINTER(_PhysicalMonitor),
    )
    dxva2.DestroyPhysicalMonitors.restype = wintypes.BOOL

    callback_type = ctypes.WINFUNCTYPE(
        wintypes.BOOL,
        wintypes.HANDLE,
        wintypes.HDC,
        ctypes.POINTER(wintypes.RECT),
        wintypes.LPARAM,
    )

    def collect(hmonitor: int, _hdc: int, _rect: Any, _data: int) -> bool:
        count = wintypes.DWORD()
        if not dxva2.GetNumberOfPhysicalMonitorsFromHMONITOR(
            hmonitor, ctypes.byref(count)
        ):
            return True
        if count.value == 0:
            return True

        monitors = (_PhysicalMonitor * count.value)()
        if dxva2.GetPhysicalMonitorsFromHMONITOR(
            hmonitor, count.value, monitors
        ):
            buffers.append(monitors)
        return True

    callback = callback_type(collect)
    user32.EnumDisplayMonitors.argtypes = (
        wintypes.HDC,
        ctypes.POINTER(wintypes.RECT),
        callback_type,
        wintypes.LPARAM,
    )
    user32.EnumDisplayMonitors.restype = wintypes.BOOL
    if not user32.EnumDisplayMonitors(None, None, callback, 0):
        error_code = ctypes.get_last_error()
        raise OSError(error_code, "Windows could not enumerate connected displays.")
    return dxva2, buffers


def _change_brightness(direction: int) -> str:
    dxva2, monitor_buffers = _enumerate_physical_monitors()
    changed = 0
    unsupported = 0
    update_failed = 0
    try:
        for monitors in monitor_buffers:
            for monitor in monitors:
                minimum = wintypes.DWORD()
                maximum = wintypes.DWORD()
                current = wintypes.DWORD()
                if not dxva2.GetMonitorBrightness(
                    monitor.handle,
                    ctypes.byref(minimum),
                    ctypes.byref(maximum),
                    ctypes.byref(current),
                ):
                    unsupported += 1
                    continue

                span = maximum.value - minimum.value
                if span <= 0:
                    unsupported += 1
                    continue
                step = max(1, round(span * 0.1))
                target = max(
                    minimum.value,
                    min(maximum.value, current.value + direction * step),
                )
                if target == current.value:
                    update_failed += 1
                    continue
                if dxva2.SetMonitorBrightness(monitor.handle, target):
                    changed += 1
                else:
                    update_failed += 1
    finally:
        for monitors in monitor_buffers:
            if not dxva2.DestroyPhysicalMonitors(len(monitors), monitors):
                logger.warning("Windows could not close physical monitor handles.")

    if changed == 0:
        if unsupported and not update_failed:
            raise OSError(
                "No connected display exposed controllable brightness. "
                "The display driver or monitor may not support DDC/CI brightness control."
            )
        if not monitor_buffers:
            raise OSError(
                "No controllable display was detected. Windows did not expose a "
                "brightness API for the connected displays."
            )
        raise OSError(
            "Windows could not change display brightness. Check the display driver "
            "and whether brightness is already at its limit."
        )

    direction_text = "increased" if direction > 0 else "decreased"
    message = f"Brightness {direction_text} on {changed} display(s)."
    if unsupported:
        message += (
            f" {unsupported} other display(s) did not expose controllable brightness."
        )
    if update_failed:
        message += f" {update_failed} display(s) did not accept a brightness change."
    return message


def perform_system_control(control: str) -> str:
    if not is_windows_system_control_available():
        raise OSError("System controls are only supported on Windows.")
    if control in _VOLUME_CONTROLS:
        send_system_control_key(control)
        return _VOLUME_CONTROLS[control] + "."
    if control == "brightness_up":
        return _change_brightness(1)
    if control == "brightness_down":
        return _change_brightness(-1)
    raise ValueError(f"Unsupported Windows system control '{control}'.")
