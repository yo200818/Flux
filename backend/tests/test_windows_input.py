import ctypes

import pytest

from app.actions import windows_input


@pytest.mark.parametrize(
    ("shortcut", "modifier", "key"),
    [
        ("copy", windows_input.VK_CONTROL, 0x43),
        ("paste", windows_input.VK_CONTROL, 0x56),
        ("cut", windows_input.VK_CONTROL, 0x58),
        ("undo", windows_input.VK_CONTROL, 0x5A),
        ("redo", windows_input.VK_CONTROL, 0x59),
        ("save", windows_input.VK_CONTROL, 0x53),
        ("select_all", windows_input.VK_CONTROL, 0x41),
        ("switch_app", windows_input.VK_ALT, windows_input.VK_TAB),
    ],
)
def test_shortcut_sequences_press_and_release_allowlisted_keys(
    shortcut: str,
    modifier: int,
    key: int,
) -> None:
    events = windows_input._shortcut_events(shortcut)

    assert [(event.virtual_key, event.key_up) for event in events] == [
        (modifier, False),
        (key, False),
        (key, True),
        (modifier, True),
    ]


def test_sends_the_complete_input_sequence_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(windows_input, "is_windows_input_available", lambda: True)
    captured: list[windows_input._KeyEvent] = []

    def send(events: list[windows_input._KeyEvent]) -> int:
        captured.extend(events)
        return len(events)

    monkeypatch.setattr(
        windows_input,
        "_send_input_events",
        send,
    )

    windows_input.send_keyboard_shortcut("save")
    assert captured == windows_input._shortcut_events("save")


@pytest.mark.parametrize(
    ("control", "virtual_key"),
    [
        ("volume_up", 0xAF),
        ("volume_down", 0xAE),
        ("mute_toggle", 0xAD),
    ],
)
def test_system_volume_controls_send_only_the_allowlisted_media_key(
    monkeypatch: pytest.MonkeyPatch,
    control: str,
    virtual_key: int,
) -> None:
    monkeypatch.setattr(windows_input, "is_windows_input_available", lambda: True)
    captured: list[windows_input._KeyEvent] = []

    def send(events: list[windows_input._KeyEvent]) -> int:
        captured.extend(events)
        return len(events)

    monkeypatch.setattr(windows_input, "_send_input_events", send)
    windows_input.send_system_control_key(control)

    assert captured == [
        windows_input._KeyEvent(virtual_key),
        windows_input._KeyEvent(virtual_key, key_up=True),
    ]


def test_input_structure_matches_the_native_windows_abi() -> None:
    expected_size = 40 if ctypes.sizeof(ctypes.c_void_p) == 8 else 28
    assert ctypes.sizeof(windows_input._Input) == expected_size


def test_incomplete_input_batch_releases_pressed_keys_and_reports_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(windows_input, "is_windows_input_available", lambda: True)
    monkeypatch.setattr(ctypes, "get_last_error", lambda: 0)
    sent_counts = iter((1, 2))
    calls: list[list[windows_input._KeyEvent]] = []

    def send(events: list[windows_input._KeyEvent]) -> int:
        calls.append(events)
        return next(sent_counts)

    monkeypatch.setattr(windows_input, "_send_input_events", send)
    with pytest.raises(OSError, match="accepted only 1 of 4"):
        windows_input.send_keyboard_shortcut("copy")
    assert calls[1] == [
        windows_input._KeyEvent(0x43, key_up=True),
        windows_input._KeyEvent(windows_input.VK_CONTROL, key_up=True),
    ]


def test_non_windows_platform_is_rejected_before_input(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(windows_input, "is_windows_input_available", lambda: False)
    monkeypatch.setattr(
        windows_input,
        "_send_input_events",
        lambda _events: pytest.fail("Input API must not be called."),
    )

    with pytest.raises(OSError, match="only be sent on Windows"):
        windows_input.send_keyboard_shortcut("copy")


@pytest.mark.parametrize(
    ("shortcut", "expected"),
    [
        ("SHIFT+CONTROL+WIN+F24", "CTRL+SHIFT+WIN+F24"),
        ("ALT+F13", "ALT+F13"),
        ("CTRL+ARROWLEFT", "CTRL+LEFT"),
        ("CTRL+INSERT", "CTRL+INSERT"),
        ("WIN+NUMPAD7", "WIN+NUMPAD7"),
        ("SHIFT+;", "SHIFT+SEMICOLON"),
        ("CTRL+PAGE_DOWN", "CTRL+PAGEDOWN"),
        ("ctrl+shift+r", "CTRL+SHIFT+R"),
    ],
)
def test_shortcuts_normalize_supported_keys_and_modifier_order(
    shortcut: str,
    expected: str,
) -> None:
    assert windows_input.normalize_shortcut(shortcut) == expected


@pytest.mark.parametrize(
    "shortcut",
    [
        "CTRL+CTRL+A",
        "CTRL+CONTROL+A",
        "WIN+L",
        "ALT+WIN+R",
        "F25+CTRL",
        "CTRL+F25",
        "CTRL+UNKNOWN",
        "CTRL+A++SHIFT",
        "A",
        "CTRL+!",
    ],
)
def test_malformed_duplicate_reserved_and_unsupported_shortcuts_are_rejected(
    shortcut: str,
) -> None:
    with pytest.raises(ValueError):
        windows_input.normalize_shortcut(shortcut)


@pytest.mark.parametrize(
    ("shortcut", "expected"),
    [
        ("CTRL+WIN+F24", [(0x11, False), (0x5B, False), (0x87, False), (0x87, True), (0x5B, True), (0x11, True)]),
        ("CTRL+NUMPAD7", [(0x11, False), (0x67, False), (0x67, True), (0x11, True)]),
        ("SHIFT+SEMICOLON", [(0x10, False), (0xBA, False), (0xBA, True), (0x10, True)]),
    ],
)
def test_supported_keys_map_to_expected_windows_virtual_key_events(
    shortcut: str,
    expected: list[tuple[int, bool]],
) -> None:
    events = windows_input._shortcut_key_events(shortcut)
    assert [(event.virtual_key, event.key_up) for event in events] == expected
