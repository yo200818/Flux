from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import create_app
from app.system_metrics import SystemMetricsSnapshot, WindowsSystemMetrics

ADMIN_TOKEN = "system-metrics-admin-token-with-at-least-32-bytes"
ADMIN_HEADERS = {"Authorization": f"Bearer {ADMIN_TOKEN}"}


def test_cpu_usage_uses_counter_deltas_and_reports_sampling_baseline(
    monkeypatch,
) -> None:
    readings = iter(((100, 200, 300), (110, 240, 330)))
    monkeypatch.setattr("app.system_metrics.sys.platform", "win32")
    monkeypatch.setattr(
        "app.system_metrics._read_system_times",
        lambda: next(readings),
    )
    monkeypatch.setattr(
        "app.system_metrics._read_memory_status",
        lambda: (4_000, 8_000),
    )
    metrics = WindowsSystemMetrics()

    baseline = metrics.snapshot()
    sample = metrics.snapshot()

    assert baseline.cpu_status == "sampling"
    assert baseline.cpu_usage_percent is None
    assert sample.cpu_status == "available"
    assert sample.cpu_usage_percent == 85.7
    assert sample.memory_used_bytes == 4_000
    assert sample.memory_total_bytes == 8_000
    assert set(sample.unavailable_metrics) == {
        "gpu_utilization",
        "gpu_temperature",
        "cpu_temperature",
    }


def test_unsupported_platform_metrics_are_explicit_and_have_no_fake_values(
    monkeypatch,
) -> None:
    monkeypatch.setattr("app.system_metrics.sys.platform", "linux")

    snapshot = WindowsSystemMetrics().snapshot()

    assert snapshot.cpu_status == "unavailable"
    assert snapshot.cpu_usage_percent is None
    assert snapshot.memory_used_bytes is None
    assert snapshot.memory_total_bytes is None
    assert "cpu_utilization" in snapshot.unavailable_metrics
    assert "memory_usage" in snapshot.unavailable_metrics
    assert "gpu_temperature" in snapshot.unavailable_metrics


def test_metrics_endpoint_requires_authorized_client(tmp_path: Path) -> None:
    app = create_app(
        tmp_path / "configuration.json",
        device_store_path=tmp_path / "devices.json",
        admin_token=ADMIN_TOKEN,
    )
    client = TestClient(app)
    app.state.system_metrics.snapshot = lambda: SystemMetricsSnapshot(
        cpu_status="sampling",
        cpu_usage_percent=None,
        memory_used_bytes=10,
        memory_total_bytes=20,
        unavailable_metrics={},
    )

    assert client.get("/api/system/metrics").status_code == 401
    response = client.get("/api/system/metrics", headers=ADMIN_HEADERS)

    assert response.status_code == 200
    assert response.json()["memory_used_bytes"] == 10
    assert response.json()["cpu_status"] == "sampling"
