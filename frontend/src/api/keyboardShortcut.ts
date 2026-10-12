const MODIFIER_ORDER = ["CTRL", "ALT", "SHIFT", "WIN"] as const;
const MODIFIER_ALIASES: Record<string, (typeof MODIFIER_ORDER)[number]> = {
  CTRL: "CTRL",
  CONTROL: "CTRL",
  ALT: "ALT",
  SHIFT: "SHIFT",
  WIN: "WIN",
  WINDOWS: "WIN",
};

const KEY_ALIASES: Record<string, string> = {
  ESCAPE: "ESC",
  ARROWUP: "UP",
  ARROWDOWN: "DOWN",
  ARROWLEFT: "LEFT",
  ARROWRIGHT: "RIGHT",
  PAGE_UP: "PAGEUP",
  PAGE_DOWN: "PAGEDOWN",
  INSERT: "INSERT",
  BACKTICK: "BACKQUOTE",
  TILDE: "BACKQUOTE",
  MINUS: "MINUS",
  EQUAL: "EQUAL",
  EQUALS: "EQUAL",
  BRACKETLEFT: "BRACKETLEFT",
  BRACKETRIGHT: "BRACKETRIGHT",
  BACKSLASH: "BACKSLASH",
  SEMICOLON: "SEMICOLON",
  QUOTE: "QUOTE",
  COMMA: "COMMA",
  PERIOD: "PERIOD",
  SLASH: "SLASH",
  NUMPADADD: "NUMPADADD",
  NUMPADSUBTRACT: "NUMPADSUBTRACT",
  NUMPADMULTIPLY: "NUMPADMULTIPLY",
  NUMPADDIVIDE: "NUMPADDIVIDE",
  NUMPADDECIMAL: "NUMPADDECIMAL",
  NUMPADENTER: "NUMPADENTER",
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
};

const NAMED_KEYS = new Set([
  "ENTER",
  "TAB",
  "ESC",
  "SPACE",
  "BACKSPACE",
  "DELETE",
  "INSERT",
  "HOME",
  "END",
  "PAGEUP",
  "PAGEDOWN",
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "BACKQUOTE",
  "MINUS",
  "EQUAL",
  "BRACKETLEFT",
  "BRACKETRIGHT",
  "BACKSLASH",
  "SEMICOLON",
  "QUOTE",
  "COMMA",
  "PERIOD",
  "SLASH",
  "NUMPADADD",
  "NUMPADSUBTRACT",
  "NUMPADMULTIPLY",
  "NUMPADDIVIDE",
  "NUMPADDECIMAL",
  "NUMPADENTER",
]);

function normalizeKey(value: string): string | null {
  const key = KEY_ALIASES[value] ?? value;
  if (/^[A-Z0-9]$/.test(key) || /^NUMPAD[0-9]$/.test(key)) {
    return key;
  }
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(key) || NAMED_KEYS.has(key)) {
    return key;
  }
  return null;
}

export function normalizeShortcut(value: string): string {
  const input = value.trim();
  const builtin = input.toLowerCase();
  if (
    ["copy", "paste", "cut", "undo", "redo", "save", "select_all", "switch_app"].includes(
      builtin,
    )
  ) {
    return builtin;
  }

  const parts = input.split("+").map((part) => part.trim().toUpperCase());
  if (parts.length < 2 || parts.length > MODIFIER_ORDER.length + 1 || parts.some((part) => !part)) {
    throw new Error("Use one supported key with at least one modifier.");
  }

  const modifiers = parts.slice(0, -1).map((part) => MODIFIER_ALIASES[part]);
  if (
    modifiers.some((modifier) => !modifier) ||
    new Set(modifiers).size !== modifiers.length
  ) {
    throw new Error("Use Ctrl, Alt, Shift, or Windows once each.");
  }

  const key = normalizeKey(parts.at(-1) ?? "");
  if (!key) {
    throw new Error("That key is not supported.");
  }

  const normalizedModifiers = MODIFIER_ORDER.filter((modifier) =>
    modifiers.includes(modifier),
  );
  if (normalizedModifiers.includes("WIN") && ["L", "R"].includes(key)) {
    const reserved = key === "L" ? "Windows+L" : "Windows+R";
    throw new Error(`${reserved} is reserved by Windows and cannot be saved.`);
  }
  return [...normalizedModifiers, key].join("+");
}

const CODE_KEYS: Record<string, string> = {
  Space: "SPACE",
  Enter: "ENTER",
  NumpadEnter: "NUMPADENTER",
  Tab: "TAB",
  Escape: "ESC",
  Backspace: "BACKSPACE",
  Delete: "DELETE",
  Insert: "INSERT",
  Home: "HOME",
  End: "END",
  PageUp: "PAGEUP",
  PageDown: "PAGEDOWN",
  ArrowUp: "UP",
  ArrowDown: "DOWN",
  ArrowLeft: "LEFT",
  ArrowRight: "RIGHT",
  Backquote: "BACKQUOTE",
  Minus: "MINUS",
  Equal: "EQUAL",
  BracketLeft: "BRACKETLEFT",
  BracketRight: "BRACKETRIGHT",
  Backslash: "BACKSLASH",
  Semicolon: "SEMICOLON",
  Quote: "QUOTE",
  Comma: "COMMA",
  Period: "PERIOD",
  Slash: "SLASH",
  NumpadAdd: "NUMPADADD",
  NumpadSubtract: "NUMPADSUBTRACT",
  NumpadMultiply: "NUMPADMULTIPLY",
  NumpadDivide: "NUMPADDIVIDE",
  NumpadDecimal: "NUMPADDECIMAL",
};

export interface ShortcutKeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type ShortcutCaptureResult =
  | { kind: "modifier" }
  | { kind: "shortcut"; value: string }
  | { kind: "unsupported"; message: string };

export function captureShortcut(
  event: ShortcutKeyEvent,
): ShortcutCaptureResult {
  const modifiers = [
    event.ctrlKey ? "CTRL" : null,
    event.altKey ? "ALT" : null,
    event.shiftKey ? "SHIFT" : null,
    event.metaKey ? "WIN" : null,
  ].filter((modifier): modifier is string => modifier !== null);

  if (
    ["Control", "Alt", "Shift", "Meta", "OS"].includes(event.key) ||
    ["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"].includes(event.code)
  ) {
    return { kind: "modifier" };
  }
  if (modifiers.length === 0) {
    return {
      kind: "unsupported",
      message: "Hold Ctrl, Alt, Shift, or Windows, then press a supported key.",
    };
  }

  const codeKey =
    CODE_KEYS[event.code] ??
    (/^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : null) ??
    (/^Digit[0-9]$/.test(event.code) ? event.code.slice(5) : null) ??
    (/^Numpad[0-9]$/.test(event.code) ? event.code.toUpperCase() : null) ??
    (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.code) ? event.code : null);
  const key = codeKey ?? KEY_ALIASES[event.key.toUpperCase()] ?? event.key.toUpperCase();
  try {
    return {
      kind: "shortcut",
      value: normalizeShortcut([...modifiers, key].join("+")),
    };
  } catch (error) {
    return {
      kind: "unsupported",
      message:
        error instanceof Error ? error.message : "That key combination is not supported.",
    };
  }
}

export function formatShortcut(value: string): string {
  const builtinLabels: Record<string, string> = {
    copy: "Copy",
    paste: "Paste",
    cut: "Cut",
    undo: "Undo",
    redo: "Redo",
    save: "Save",
    select_all: "Select all",
    switch_app: "Switch app",
  };
  if (builtinLabels[value.toLowerCase()]) {
    return builtinLabels[value.toLowerCase()];
  }
  return value
    .replaceAll("CTRL", "Ctrl")
    .replaceAll("ALT", "Alt")
    .replaceAll("SHIFT", "Shift")
    .replaceAll("WIN", "Windows")
    .replaceAll("BACKQUOTE", "`")
    .replaceAll("BRACKETLEFT", "[")
    .replaceAll("BRACKETRIGHT", "]")
    .replaceAll("BACKSLASH", "\\")
    .replaceAll("SEMICOLON", ";")
    .replaceAll("QUOTE", "'")
    .replaceAll("COMMA", ",")
    .replaceAll("PERIOD", ".")
    .replaceAll("SLASH", "/")
    .replaceAll("NUMPADADD", "Num +")
    .replaceAll("NUMPADSUBTRACT", "Num −")
    .replaceAll("NUMPADMULTIPLY", "Num ×")
    .replaceAll("NUMPADDIVIDE", "Num ÷")
    .replaceAll("NUMPADDECIMAL", "Num .")
    .replaceAll("NUMPADENTER", "Num Enter")
    .replaceAll("MINUS", "-")
    .replaceAll("EQUAL", "=")
    .replaceAll("PAGEUP", "Page Up")
    .replaceAll("PAGEDOWN", "Page Down")
    .replaceAll("SPACE", "Space")
    .replaceAll("BACKSPACE", "Backspace")
    .replaceAll("DELETE", "Delete")
    .replaceAll("INSERT", "Insert")
    .replaceAll("ENTER", "Enter")
    .replaceAll("TAB", "Tab")
    .replaceAll("ESC", "Esc")
    .replaceAll("HOME", "Home")
    .replaceAll("END", "End")
    .replaceAll("UP", "Up")
    .replaceAll("DOWN", "Down")
    .replaceAll("LEFT", "Left")
    .replaceAll("RIGHT", "Right")
    .replaceAll("+", " + ");
}
