import os
import subprocess
from pathlib import Path


def is_windows_application_launch_available() -> bool:
    return os.name == "nt"


def launch_application(executable_path: str) -> None:
    """Launch only the configured executable, with no shell or arguments."""
    if not is_windows_application_launch_available():
        raise OSError("Application actions can only be launched on Windows.")

    executable = Path(executable_path)
    if not executable.is_absolute() or executable.suffix.casefold() != ".exe":
        raise ValueError("The application path is not an absolute Windows executable path.")
    if not executable.is_file():
        raise FileNotFoundError(
            f"The selected application executable no longer exists: {executable}"
        )

    subprocess.Popen(
        [str(executable)],
        shell=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
