from __future__ import annotations

import ctypes
import logging
import sys
import threading
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

logger = logging.getLogger(__name__)

_UNSUPPORTED_SENSOR_MESSAGES = {
    "gpu_utilization": "GPU utilization telemetry is not available from a generic Windows API.",
    "gpu_temperature": "GPU temperature requires a supported hardware-specific telemetry provider.",
    "cpu_temperature": "CPU temperature requires a trustworthy hardware sensor provider.",
}


class SystemMetricsSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    cpu_status: Literal["sampling", "available", "unavailable"]
    cpu_usage_percent: float | None = Field(ge=0, le=100)
    memory_used_bytes: int | None = Field(ge=0)
    memory_total_bytes: int | None = Field(gt=0)
    unavailable_metrics: dict[str, str]

    @model_validator(mode="after")
    def validate_measurements(self) -> "SystemMetricsSnapshot":
        if (self.cpu_status == "available") != (
            self.cpu_usage_percent is not None
        ):
            raise ValueError(
                "CPU utilization must be present only when its status is available."
            )
        if (self.memory_used_bytes is None) != (self.memory_total_bytes is None):
            raise ValueError(
                "Used and total physical memory must both be present or absent."
            )
        if (
            self.memory_used_bytes is not None
            and self.memory_total_bytes is not None
            and self.memory_used_bytes > self.memory_total_bytes
        ):
            raise ValueError("Used physical memory cannot exceed total memory.")
        return self


class _FileTime(ctypes.Structure):
    _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]

    def as_integer(self) -> int:
        return (self.high << 32) | self.low


class _MemoryStatusEx(ctypes.Structure):
    _fields_ = [
        ("length", ctypes.c_uint32),
        ("memory_load", ctypes.c_uint32),
        ("total_physical", ctypes.c_uint64),
        ("available_physical", ctypes.c_uint64),
        ("total_page_file", ctypes.c_uint64),
        ("available_page_file", ctypes.c_uint64),
        ("total_virtual", ctypes.c_uint64),
        ("available_virtual", ctypes.c_uint64),
        ("available_extended_virtual", ctypes.c_uint64),
    ]


def _read_system_times() -> tuple[int, int, int]:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    idle = _FileTime()
    kernel = _FileTime()
    user = _FileTime()
    get_system_times = kernel32.GetSystemTimes
    get_system_times.argtypes = (
        ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime),
        ctypes.POINTER(_FileTime),
    )
    get_system_times.restype = ctypes.c_int
    if not get_system_times(
        ctypes.byref(idle),
        ctypes.byref(kernel),
        ctypes.byref(user),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return idle.as_integer(), kernel.as_integer(), user.as_integer()


def _read_memory_status() -> tuple[int, int]:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    status = _MemoryStatusEx()
    status.length = ctypes.sizeof(status)
    global_memory_status = kernel32.GlobalMemoryStatusEx
    global_memory_status.argtypes = (ctypes.POINTER(_MemoryStatusEx),)
    global_memory_status.restype = ctypes.c_int
    if not global_memory_status(ctypes.byref(status)):
        raise ctypes.WinError(ctypes.get_last_error())
    return (
        status.total_physical - status.available_physical,
        status.total_physical,
    )


class WindowsSystemMetrics:
    """Read-only, low-frequency Windows CPU and physical-memory telemetry."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._previous_times: tuple[int, int, int] | None = None

    def snapshot(self) -> SystemMetricsSnapshot:
        unavailable = dict(_UNSUPPORTED_SENSOR_MESSAGES)
        cpu_status: Literal["sampling", "available", "unavailable"] = "unavailable"
        cpu_usage: float | None = None
        used_memory: int | None = None
        total_memory: int | None = None

        if sys.platform != "win32":
            unavailable["cpu_utilization"] = (
                "CPU utilization telemetry is only available on Windows."
            )
            unavailable["memory_usage"] = (
                "Physical memory telemetry is only available on Windows."
            )
            return SystemMetricsSnapshot(
                cpu_status=cpu_status,
                cpu_usage_percent=cpu_usage,
                memory_used_bytes=used_memory,
                memory_total_bytes=total_memory,
                unavailable_metrics=unavailable,
            )

        with self._lock:
            try:
                current_times = _read_system_times()
            except OSError:
                logger.exception("Windows could not read CPU utilization counters.")
                unavailable["cpu_utilization"] = (
                    "Windows could not read CPU utilization counters."
                )
                self._previous_times = None
            else:
                previous_times = self._previous_times
                self._previous_times = current_times
                if previous_times is None:
                    cpu_status = "sampling"
                else:
                    idle_delta = current_times[0] - previous_times[0]
                    kernel_delta = current_times[1] - previous_times[1]
                    user_delta = current_times[2] - previous_times[2]
                    total_delta = kernel_delta + user_delta
                    if total_delta <= 0 or idle_delta < 0:
                        cpu_status = "sampling"
                    else:
                        busy_delta = max(0, total_delta - idle_delta)
                        cpu_usage = round(
                            min(100.0, busy_delta * 100.0 / total_delta),
                            1,
                        )
                        cpu_status = "available"

        try:
            used_memory, total_memory = _read_memory_status()
        except OSError:
            logger.exception("Windows could not read physical memory status.")
            unavailable["memory_usage"] = (
                "Windows could not read physical memory status."
            )

        return SystemMetricsSnapshot(
            cpu_status=cpu_status,
            cpu_usage_percent=cpu_usage,
            memory_used_bytes=used_memory,
            memory_total_bytes=total_memory,
            unavailable_metrics=unavailable,
        )
