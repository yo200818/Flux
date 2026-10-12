import ctypes
import logging
import os
from ctypes import wintypes
from dataclasses import dataclass

logger = logging.getLogger(__name__)

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
VK_ALT = 0x12
VK_CONTROL = 0x11
VK_LWIN = 0x5B
VK_SHIFT = 0x10
VK_TAB = 0x09


class _KeyboardInput(ctypes.Structure):
    _fields_ = [
        ("virtual_key", wintypes.WORD),
        ("scan_code", wintypes.WORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("extra_info", ctypes.c_size_t),
    ]


class _MouseInput(ctypes.Structure):
    _fields_ = [
        ("x", wintypes.LONG),
        ("y", wintypes.LONG),
        ("mouse_data", wintypes.DWORD),
        ("flags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("extra_info", ctypes.c_size_t),
    ]


class _HardwareInput(ctypes.Structure):
    _fields_ = [
        ("message", wintypes.DWORD),
        ("parameter_low", wintypes.WORD),
        ("parameter_high", wintypes.WORD),
    ]


class _InputUnion(ctypes.Union):
    _fields_ = [
        ("mouse", _MouseInput),
        ("keyboard", _KeyboardInput),
        ("hardware", _HardwareInput),
    ]


class _Input(ctypes.Structure):
    _fields_ = [("input_type", wintypes.DWORD), ("value", _InputUnion)]


@dataclass(frozen=True)
class _KeyEvent:
    virtual_key: int
    key_up: bool = False


_SHORTCUT_KEYS: dict[str, tuple[tuple[int, ...], int]] = {
    "copy": ((VK_CONTROL,), 0x43),
    "paste": ((VK_CONTROL,), 0x56),
    "cut": ((VK_CONTROL,), 0x58),
    "undo": ((VK_CONTROL,), 0x5A),
    "redo": ((VK_CONTROL,), 0x59),
    "save": ((VK_CONTROL,), 0x53),
    "select_all": ((VK_CONTROL,), 0x41),
    "switch_app": ((VK_ALT,), VK_TAB),
}
_SYSTEM_CONTROL_KEYS = {
    "volume_up": 0xAF,
    "volume_down": 0xAE,
    "mute_toggle": 0xAD,
}

_MODIFIERS = {
    "CTRL": VK_CONTROL,
    "ALT": VK_ALT,
    "SHIFT": VK_SHIFT,
    "WIN": VK_LWIN,
}
_MODIFIER_ALIASES = {
    "CTRL": "CTRL",
    "CONTROL": "CTRL",
    "ALT": "ALT",
    "SHIFT": "SHIFT",
    "WIN": "WIN",
    "WINDOWS": "WIN",
}
_MODIFIER_ORDER = ("CTRL", "ALT", "SHIFT", "WIN")
_NAMED_KEYS = {
    "ENTER": 0x0D,
    "TAB": VK_TAB,
    "ESC": 0x1B,
    "SPACE": 0x20,
    "BACKSPACE": 0x08,
    "DELETE": 0x2E,
    "INSERT": 0x2D,
    "HOME": 0x24,
    "END": 0x23,
    "PAGEUP": 0x21,
    "PAGEDOWN": 0x22,
    "UP": 0x26,
    "DOWN": 0x28,
    "LEFT": 0x25,
    "RIGHT": 0x27,
    "BACKQUOTE": 0xC0,
    "MINUS": 0xBD,
    "EQUAL": 0xBB,
    "BRACKETLEFT": 0xDB,
    "BRACKETRIGHT": 0xDD,
    "BACKSLASH": 0xDC,
    "SEMICOLON": 0xBA,
    "QUOTE": 0xDE,
    "COMMA": 0xBC,
    "PERIOD": 0xBE,
    "SLASH": 0xBF,
    "NUMPADADD": 0x6B,
    "NUMPADSUBTRACT": 0x6D,
    "NUMPADMULTIPLY": 0x6A,
    "NUMPADDIVIDE": 0x6F,
    "NUMPADDECIMAL": 0x6E,
    "NUMPADENTER": 0x0D,
}
_KEY_ALIASES = {
    "ESCAPE": "ESC",
    "ARROWUP": "UP",
    "ARROWDOWN": "DOWN",
    "ARROWLEFT": "LEFT",
    "ARROWRIGHT": "RIGHT",
    "PAGE_UP": "PAGEUP",
    "PAGE_DOWN": "PAGEDOWN",
    "BACKTICK": "BACKQUOTE",
    "TILDE": "BACKQUOTE",
    "EQUALS": "EQUAL",
    "`": "BACKQUOTE",
    "-": "MINUS",
    "=": "EQUAL",
    "[": "BRACKETLEFT",
    "]": "BRACKETRIGHT",
    "\\": "BACKSLASH",
    ";": "SEMICOLON",
    "'": "QUOTE",
    ",": "COMMA",
    ".": "PERIOD",
    "/": "SLASH",
}


def _normalize_key(value: str) -> str | None:
    key = _KEY_ALIASES.get(value, value)
    if len(key) == 1 and key.isascii() and key.isalnum():
        return key
    if key.startswith("NUMPAD") and key[6:].isdigit() and len(key[6:]) == 1:
        return key
    if key in _NAMED_KEYS:
        return key
    if key.startswith("F") and key[1:].isdigit() and 1 <= int(key[1:]) <= 24:
        return key
    return None


def normalize_shortcut(shortcut: str) -> str:
    """Validate and normalize one modifier+key chord to its canonical form."""
    builtin = shortcut.strip().lower()
    if builtin in _SHORTCUT_KEYS:
        return builtin

    parts = [part.strip().upper() for part in shortcut.split("+")]
    if (
        len(parts) < 2
        or len(parts) > len(_MODIFIER_ORDER) + 1
        or any(not part for part in parts)
    ):
        raise ValueError("Use one supported key and at least one modifier.")
    modifier_parts, raw_key = parts[:-1], parts[-1]
    modifiers = [_MODIFIER_ALIASES.get(part) for part in modifier_parts]
    if any(modifier is None for modifier in modifiers) or len(set(modifiers)) != len(
        modifiers
    ):
        raise ValueError(
            "Use Ctrl, Alt, Shift, or Windows once each; duplicate modifiers are not supported."
        )
    key = _normalize_key(raw_key)
    if key is None:
        raise ValueError("The key is not supported.")

    normalized_modifiers = [
        modifier for modifier in _MODIFIER_ORDER if modifier in modifiers
    ]
    if "WIN" in normalized_modifiers and key in {"L", "R"}:
        reserved = "Windows+L" if key == "L" else "Windows+R"
        raise ValueError(f"{reserved} is reserved by Windows and cannot be saved.")
    return "+".join([*normalized_modifiers, key])


def _shortcut_key_events(shortcut: str) -> list[_KeyEvent]:
    normalized = normalize_shortcut(shortcut)
    builtin = normalized.lower()
    if builtin in _SHORTCUT_KEYS:
        return _shortcut_events(builtin)

    *modifier_names, key_name = normalized.split("+")
    modifiers = tuple(_MODIFIERS[name] for name in modifier_names)
    if key_name in _NAMED_KEYS:
        key = _NAMED_KEYS[key_name]
    elif key_name.startswith("F"):
        key = 0x70 + int(key_name[1:]) - 1
    elif key_name.startswith("NUMPAD") and key_name[6:].isdigit():
        key = 0x60 + int(key_name[6:])
    else:
        key = ord(key_name.upper())
    return [
        *(_KeyEvent(virtual_key) for virtual_key in modifiers),
        _KeyEvent(key),
        _KeyEvent(key, key_up=True),
        *(_KeyEvent(virtual_key, key_up=True) for virtual_key in reversed(modifiers)),
    ]


def is_windows_input_available() -> bool:
    return os.name == "nt"


def _shortcut_events(shortcut: str) -> list[_KeyEvent]:
    modifiers, key = _SHORTCUT_KEYS[shortcut]
    return [
        *(_KeyEvent(virtual_key) for virtual_key in modifiers),
        _KeyEvent(key),
        _KeyEvent(key, key_up=True),
        *(
            _KeyEvent(virtual_key, key_up=True)
            for virtual_key in reversed(modifiers)
        ),
    ]


def _as_input(event: _KeyEvent) -> _Input:
    flags = KEYEVENTF_KEYUP if event.key_up else 0
    value = _Input()
    value.input_type = INPUT_KEYBOARD
    value.value.keyboard = _KeyboardInput(event.virtual_key, 0, flags, 0, 0)
    return value


def _send_input_events(events: list[_KeyEvent]) -> int:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    inputs = (_Input * len(events))(*(_as_input(event) for event in events))
    user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(_Input), ctypes.c_int)
    user32.SendInput.restype = wintypes.UINT
    ctypes.set_last_error(0)
    return int(user32.SendInput(len(inputs), inputs, ctypes.sizeof(_Input)))


def send_keyboard_shortcut(shortcut: str) -> None:
    """Send one allowlisted shortcut to the active Windows foreground window."""
    if not is_windows_input_available():
        raise OSError("Keyboard shortcuts can only be sent on Windows.")
    events = _shortcut_key_events(shortcut)
    sent = _send_input_events(events)
    if sent == len(events):
        return

    error_code = ctypes.get_last_error()
    release_events = [
        _KeyEvent(event.virtual_key, key_up=True)
        for event in reversed(events)
        if not event.key_up
    ]
    released = _send_input_events(release_events)
    logger.warning(
        "Windows accepted %d of %d keyboard input events; released %d keys.",
        sent,
        len(events),
        released,
    )
    if error_code:
        raise ctypes.WinError(error_code)
    raise OSError(
        f"Windows accepted only {sent} of {len(events)} keyboard input events."
    )


def send_system_control_key(control: str) -> None:
    """Send one allowlisted Windows multimedia key to the system."""
    if not is_windows_input_available():
        raise OSError("System volume controls are only available on Windows.")
    virtual_key = _SYSTEM_CONTROL_KEYS.get(control)
    if virtual_key is None:
        raise ValueError(f"Unsupported Windows system control '{control}'.")

    events = [_KeyEvent(virtual_key), _KeyEvent(virtual_key, key_up=True)]
    sent = _send_input_events(events)
    if sent == len(events):
        return

    error_code = ctypes.get_last_error()
    if sent == 1:
        _send_input_events([events[1]])
    if error_code:
        raise ctypes.WinError(error_code)
    raise OSError(f"Windows accepted only {sent} of {len(events)} system key events.")
