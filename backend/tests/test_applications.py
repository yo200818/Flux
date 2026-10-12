import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from app.actions.application import launch_application


def test_launch_application_passes_a_single_spaced_path_without_a_shell() -> None:
    selected_path = r"C:\Program Files\Trusted App\Trusted.exe"
    with (
        patch(
            "app.actions.application.is_windows_application_launch_available",
            return_value=True,
        ),
        patch.object(Path, "is_absolute", return_value=True),
        patch.object(Path, "is_file", return_value=True),
        patch("app.actions.application.subprocess.Popen") as spawn,
    ):
        launch_application(selected_path)

    spawn.assert_called_once_with(
        [selected_path],
        shell=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def test_launch_application_rejects_a_missing_file_before_spawning() -> None:
    with (
        patch(
            "app.actions.application.is_windows_application_launch_available",
            return_value=True,
        ),
        patch.object(Path, "is_absolute", return_value=True),
        patch.object(Path, "is_file", return_value=False),
        patch("app.actions.application.subprocess.Popen") as spawn,
        pytest.raises(FileNotFoundError, match="no longer exists"),
    ):
        launch_application(r"C:\Apps\Missing.exe")

    spawn.assert_not_called()


def test_launch_application_surfaces_process_creation_failures() -> None:
    with (
        patch(
            "app.actions.application.is_windows_application_launch_available",
            return_value=True,
        ),
        patch.object(Path, "is_absolute", return_value=True),
        patch.object(Path, "is_file", return_value=True),
        patch(
            "app.actions.application.subprocess.Popen",
            side_effect=OSError("access denied"),
        ),
        pytest.raises(OSError, match="access denied"),
    ):
        launch_application(r"C:\Apps\Restricted.exe")


def test_launch_application_is_explicitly_unsupported_off_windows() -> None:
    with (
        patch(
            "app.actions.application.is_windows_application_launch_available",
            return_value=False,
        ),
        pytest.raises(OSError, match="only be launched on Windows"),
    ):
        launch_application(r"C:\Apps\App.exe")
