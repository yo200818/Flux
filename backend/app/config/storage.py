import json
import logging
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from threading import RLock

from app.config.models import Configuration, validate_configuration

logger = logging.getLogger(__name__)
CONFIG_PATH_ENV = "POCKETDECK_CONFIG_PATH"


class ConfigurationStorageError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code

    def as_dict(self) -> dict[str, str]:
        return {"code": self.code, "message": str(self)}


class ConfigurationRevisionConflict(Exception):
    def __init__(self, expected_revision: int, current_revision: int) -> None:
        super().__init__(
            f"Expected configuration revision {expected_revision}, "
            f"but the current revision is {current_revision}."
        )
        self.expected_revision = expected_revision
        self.current_revision = current_revision

    def as_dict(self) -> dict[str, object]:
        return {
            "code": "configuration_revision_conflict",
            "message": str(self),
            "expected_revision": self.expected_revision,
            "current_revision": self.current_revision,
        }


@dataclass(frozen=True)
class ConfigurationSnapshot:
    revision: int
    configuration: Configuration


def get_default_configuration_path() -> Path:
    configured_path = os.environ.get(CONFIG_PATH_ENV)
    if configured_path:
        return Path(configured_path).expanduser()

    app_data = os.environ.get("APPDATA")
    if app_data:
        data_directory = Path(app_data)
    else:
        data_directory = Path.home() / "AppData" / "Roaming"
    return data_directory / "PocketDeck" / "configuration.json"


class ConfigurationStore:
    """Persist validated configuration snapshots using atomic file replacement."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def load_or_create(
        self, default_configuration: Configuration
    ) -> ConfigurationSnapshot:
        if not self.path.exists():
            snapshot = ConfigurationSnapshot(
                revision=0, configuration=default_configuration
            )
            self.save(snapshot)
            return snapshot

        try:
            saved_data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise ConfigurationStorageError(
                "invalid_saved_configuration",
                f"Saved configuration at '{self.path}' could not be read as valid JSON. "
                "The file was left unchanged; repair or move it to recover.",
            ) from error

        if not isinstance(saved_data, dict):
            raise self._invalid_saved_file()
        revision = saved_data.get("revision")
        if type(revision) is not int or revision < 0:
            raise self._invalid_saved_file(
                "Saved configuration has an invalid revision number."
            )
        if "configuration" not in saved_data:
            raise self._invalid_saved_file()
        try:
            configuration = validate_configuration(saved_data["configuration"])
        except ValueError as error:
            raise self._invalid_saved_file(
                "Saved configuration failed validation. "
                "The file was left unchanged; repair or move it to recover."
            ) from error
        return ConfigurationSnapshot(revision, configuration)

    def save(self, snapshot: ConfigurationSnapshot) -> None:
        temporary_path: Path | None = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)
                json.dump(
                    {
                        "revision": snapshot.revision,
                        "configuration": snapshot.configuration.model_dump(
                            mode="json"
                        ),
                    },
                    temporary_file,
                    indent=2,
                )
                temporary_file.write("\n")
                temporary_file.flush()
                os.fsync(temporary_file.fileno())
            os.replace(temporary_path, self.path)
        except (OSError, TypeError, ValueError) as error:
            raise ConfigurationStorageError(
                "configuration_storage_error",
                f"Could not persist configuration at '{self.path}'. "
                "The active configuration was not changed.",
            ) from error
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning(
                        "Could not remove temporary configuration file %s.",
                        temporary_path,
                        exc_info=True,
                    )

    def _invalid_saved_file(
        self, message: str | None = None
    ) -> ConfigurationStorageError:
        return ConfigurationStorageError(
            "invalid_saved_configuration",
            message
            or (
                f"Saved configuration at '{self.path}' has an invalid format. "
                "The file was left unchanged; repair or move it to recover."
            ),
        )


class ConfigurationManager:
    """Provide synchronized access and persist-before-publish configuration updates."""

    def __init__(
        self,
        store: ConfigurationStore,
        default_configuration: Configuration,
    ) -> None:
        self._store = store
        self._lock = RLock()
        self._snapshot = store.load_or_create(default_configuration)

    def get_snapshot(self) -> ConfigurationSnapshot:
        with self._lock:
            return self._snapshot

    def update(
        self,
        configuration: Configuration,
        expected_revision: int | None,
    ) -> ConfigurationSnapshot:
        with self._lock:
            current_revision = self._snapshot.revision
            if (
                expected_revision is not None
                and expected_revision != current_revision
            ):
                raise ConfigurationRevisionConflict(
                    expected_revision, current_revision
                )
            updated_snapshot = ConfigurationSnapshot(
                revision=current_revision + 1,
                configuration=configuration,
            )
            self._store.save(updated_snapshot)
            self._snapshot = updated_snapshot
            return updated_snapshot

    def get_configuration(self) -> Configuration:
        return self.get_snapshot().configuration
