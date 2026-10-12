import json
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
TAURI_CONFIG_PATH = (
    REPOSITORY_ROOT / "frontend" / "src-tauri" / "tauri.conf.json"
)
TAURI_WINDOWS_CONFIG_PATH = (
    REPOSITORY_ROOT / "frontend" / "src-tauri" / "tauri.windows.conf.json"
)
BACKEND_BUILD_SCRIPT_PATH = REPOSITORY_ROOT / "scripts" / "build-backend.ps1"
TAURI_ENTRY_PATH = REPOSITORY_ROOT / "frontend" / "src-tauri" / "src" / "lib.rs"


def test_tauri_csp_allows_only_the_required_loopback_backend_connections() -> None:
    config = json.loads(TAURI_CONFIG_PATH.read_text(encoding="utf-8"))
    csp = config["app"]["security"]["csp"]
    directives = {
        name: value.strip().split()
        for name, value in (
            directive.strip().split(" ", 1)
            for directive in csp.rstrip(";").split(";")
        )
    }

    connect_sources = directives["connect-src"]
    assert "http://127.0.0.1:8000" in connect_sources
    assert "ws://127.0.0.1:8000" in connect_sources
    assert not any(
        source in {"*", "http:", "https:", "ws:", "wss:"}
        for source in connect_sources
    )
    assert directives["default-src"] == ["'self'"]
    assert directives["img-src"] == [
        "'self'",
        "asset:",
        "http://asset.localhost",
        "data:",
    ]


def test_windows_build_bundles_the_backend_and_builds_it_before_packaging() -> None:
    config = json.loads(TAURI_WINDOWS_CONFIG_PATH.read_text(encoding="utf-8"))
    build_script = BACKEND_BUILD_SCRIPT_PATH.read_text(encoding="utf-8")

    assert config["build"]["beforeBuildCommand"] == "npm run build:windows"
    assert config["bundle"]["resources"] == {
        "target/backend-dist/pocketdeck-backend/": "pocketdeck-backend/"
    }
    assert (
        '$defaultConfiguration = Join-Path $repositoryRoot '
        '"shared\\examples\\config.v1.json"'
    ) in build_script
    assert '--add-data "$defaultConfiguration;shared\\examples" `' in build_script


def test_packaged_windows_backend_explicitly_enables_authenticated_wifi() -> None:
    tauri_entry = TAURI_ENTRY_PATH.read_text(encoding="utf-8")

    assert 'const WIFI_ENABLE_ENV: &str = "POCKETDECK_ENABLE_WIFI";' in tauri_entry
    assert "command.env(WIFI_ENABLE_ENV, \"1\");" in tauri_entry
    assert "#[cfg(all(not(debug_assertions), target_os = \"windows\"))]" in tauri_entry
