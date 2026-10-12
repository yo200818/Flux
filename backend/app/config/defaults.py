import json
import sys
from pathlib import Path

from app.config.models import Configuration, validate_configuration

DEFAULT_CONFIGURATION_RELATIVE_PATH = (
    Path("shared") / "examples" / "config.v1.json"
)


def get_default_configuration_path() -> Path:
    """Resolve the checked-in example or its bundled PyInstaller resource."""
    if getattr(sys, "frozen", False):
        bundle_directory = getattr(sys, "_MEIPASS", None)
        if not isinstance(bundle_directory, str):
            raise RuntimeError(
                "The packaged backend is missing its PyInstaller resource directory."
            )
        root = Path(bundle_directory)
    else:
        root = Path(__file__).resolve().parents[3]
    return root / DEFAULT_CONFIGURATION_RELATIVE_PATH


def load_default_configuration() -> Configuration:
    """Load and validate the checked-in initial configuration example."""
    raw_configuration = json.loads(
        get_default_configuration_path().read_text(encoding="utf-8")
    )
    return validate_configuration(raw_configuration)
