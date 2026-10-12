import { describe, expect, it } from "vitest";
import {
  captureShortcut,
  formatShortcut,
  normalizeShortcut,
} from "./keyboardShortcut";

describe("keyboard shortcut validation and capture", () => {
  it.each([
    ["SHIFT+CONTROL+WIN+F24", "CTRL+SHIFT+WIN+F24"],
    ["ALT+F13", "ALT+F13"],
    ["CTRL+ARROWLEFT", "CTRL+LEFT"],
    ["CTRL+INSERT", "CTRL+INSERT"],
    ["WIN+NUMPAD7", "WIN+NUMPAD7"],
    ["SHIFT+;", "SHIFT+SEMICOLON"],
    ["CTRL+PAGE_DOWN", "CTRL+PAGEDOWN"],
    ["ctrl+shift+r", "CTRL+SHIFT+R"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeShortcut(input)).toBe(expected);
  });

  it.each([
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
  ])("rejects malformed or unsupported shortcut %s", (shortcut) => {
    expect(() => normalizeShortcut(shortcut)).toThrow();
  });

  it("captures modifier combinations and canonicalizes their order", () => {
    expect(
      captureShortcut({
        key: "F1",
        code: "F1",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
        metaKey: true,
      }),
    ).toEqual({ kind: "shortcut", value: "CTRL+ALT+SHIFT+WIN+F1" });
  });

  it.each([
    ["F24", "F24"],
    ["ArrowLeft", "LEFT"],
    ["Insert", "INSERT"],
    ["Numpad7", "NUMPAD7"],
    ["NumpadAdd", "NUMPADADD"],
    ["Semicolon", "SEMICOLON"],
  ])("captures the %s key from its physical key code", (code, key) => {
    expect(
      captureShortcut({
        key: code,
        code,
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toEqual({ kind: "shortcut", value: `CTRL+${key}` });
  });

  it("keeps recording when a modifier is pressed alone and describes unsupported input", () => {
    expect(
      captureShortcut({
        key: "Meta",
        code: "MetaLeft",
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: true,
      }),
    ).toEqual({ kind: "modifier" });
    expect(
      captureShortcut({
        key: "Unidentified",
        code: "Unidentified",
        ctrlKey: true,
        altKey: false,
        shiftKey: false,
        metaKey: false,
      }),
    ).toMatchObject({ kind: "unsupported" });
  });

  it("renders a readable friendly chord", () => {
    expect(formatShortcut("CTRL+SHIFT+PAGEUP")).toBe("Ctrl + Shift + Page Up");
  });
});
