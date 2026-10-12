from collections.abc import Iterator
import os
import tempfile
from pathlib import Path

import pytest

_TEST_DATA_DIRECTORY = tempfile.TemporaryDirectory(prefix="pocketdeck-tests-")
os.environ["POCKETDECK_CONFIG_PATH"] = str(
    Path(_TEST_DATA_DIRECTORY.name) / "configuration.json"
)


@pytest.fixture(scope="session", autouse=True)
def clean_test_data_directory() -> Iterator[None]:
    yield
    _TEST_DATA_DIRECTORY.cleanup()
