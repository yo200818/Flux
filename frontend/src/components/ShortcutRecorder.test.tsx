import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  isTauri: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => tauri);
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));

import { ShortcutRecorder } from "./ShortcutRecorder";

let nativeHandler:
  | ((event: {
      payload: {
        kind: "modifier" | "shortcut" | "unsupported";
        modifiers: string[];
        shortcut: string | null;
        key: string | null;
      };
    }) => void)
  | undefined;
const unlisten = vi.fn();

beforeEach(() => {
  tauri.isTauri.mockReturnValue(false);
  tauri.invoke.mockReset().mockResolvedValue(undefined);
  tauri.listen.mockReset().mockImplementation(
    async (
      _eventName: string,
      handler: typeof nativeHandler,
    ) => {
      nativeHandler = handler ?? undefined;
      return unlisten;
    },
  );
  nativeHandler = undefined;
  unlisten.mockReset();
});

afterEach(cleanup);

describe("ShortcutRecorder", () => {
  it("captures without saving or dispatching until Save is selected", () => {
    const onChange = vi.fn();
    render(<ShortcutRecorder value="" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    const capture = screen.getByRole("textbox", {
      name: "Keyboard shortcut capture",
    });
    expect(capture).toHaveTextContent("Recording shortcut");

    fireEvent.keyDown(capture, {
      key: "Control",
      code: "ControlLeft",
      ctrlKey: true,
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Modifier held. Press a supported key to complete the shortcut.",
    );
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(capture, {
      key: "F24",
      code: "F24",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Captured: Ctrl + Shift + F24",
    );
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save shortcut" }));
    expect(onChange).toHaveBeenCalledWith("CTRL+SHIFT+F24");
    expect(capture).not.toHaveClass("is-capturing");
  });

  it("cancels without changing a saved value and supports clearing it", () => {
    const onChange = vi.fn();
    render(<ShortcutRecorder value="CTRL+A" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Record again" }));
    const capture = screen.getByRole("textbox", {
      name: "Keyboard shortcut capture",
    });
    fireEvent.keyDown(capture, {
      key: "B",
      code: "KeyB",
      ctrlKey: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
    expect(capture).toHaveTextContent("Ctrl + A");
    expect(capture).not.toHaveClass("is-capturing");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("does not save a standalone Print Screen key", () => {
    const onChange = vi.fn();
    render(<ShortcutRecorder value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Keyboard shortcut capture" }),
      { key: "PrintScreen", code: "PrintScreen" },
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Hold Ctrl, Alt, Shift, or Windows",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("activates and releases native capture when saved or cancelled", async () => {
    tauri.isTauri.mockReturnValue(true);
    const onChange = vi.fn();
    render(<ShortcutRecorder value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("start_shortcut_capture"));
    expect(tauri.listen).toHaveBeenCalledWith(
      "shortcut-capture-event",
      expect.any(Function),
    );
    await screen.findByText("Recording shortcut…");
    expect(nativeHandler).toBeDefined();
    act(() => {
      nativeHandler?.({
        payload: {
          kind: "shortcut",
          modifiers: ["CTRL", "SHIFT"],
          shortcut: "CTRL+SHIFT+F12",
          key: "F12",
        },
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Captured: Ctrl + Shift + F12",
    );
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save shortcut" }));
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("stop_shortcut_capture"),
    );
    expect(onChange).toHaveBeenCalledWith("CTRL+SHIFT+F12");
    expect(unlisten).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    await screen.findByText("Recording shortcut…");
    fireEvent.click(screen.getByRole("button", { name: "Cancel recording" }));
    await waitFor(() =>
      expect(
        tauri.invoke.mock.calls.filter(
          ([command]) => command === "stop_shortcut_capture",
        ),
      ).toHaveLength(2),
    );
  });

  it("releases native capture on clear, unmount, and startup errors", async () => {
    tauri.isTauri.mockReturnValue(true);
    const onChange = vi.fn();
    const view = render(<ShortcutRecorder value="CTRL+A" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Record again" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("start_shortcut_capture"));
    fireEvent.click(screen.getByRole("button", { name: "Clear shortcut" }));
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("stop_shortcut_capture"),
    );
    expect(onChange).toHaveBeenCalledWith("");

    view.rerender(<ShortcutRecorder value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledTimes(3));
    view.unmount();
    await waitFor(() =>
      expect(tauri.invoke).toHaveBeenCalledWith("stop_shortcut_capture"),
    );

    tauri.invoke.mockReset().mockRejectedValue(new Error("hook unavailable"));
    const failed = render(<ShortcutRecorder value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Record shortcut" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Native shortcut capture could not start; no keys were suppressed.",
      ),
    );
    expect(screen.queryByRole("button", { name: "Save shortcut" })).not.toBeInTheDocument();
    failed.unmount();
  });

  it("warns that browser capture cannot suppress operating-system shortcuts", () => {
    render(<ShortcutRecorder value="" onChange={vi.fn()} />);
    expect(screen.getByText(/cannot suppress Windows shortcuts/)).toBeInTheDocument();
  });
});
