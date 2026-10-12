import { afterEach, describe, expect, it, vi } from "vitest";
import { isApplicationPickerAvailable, selectApplicationExecutable } from "./applications";

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}));

describe("application executable picker", () => {
  afterEach(() => {
    invokeMock.mockReset();
    isTauriMock.mockReset();
  });

  it("reports picker availability only inside Tauri", () => {
    isTauriMock.mockReturnValue(true);
    expect(isApplicationPickerAvailable()).toBe(true);

    isTauriMock.mockReturnValue(false);
    expect(isApplicationPickerAvailable()).toBe(false);
  });

  it("returns the path selected through the native Tauri command", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue("C:\\Program Files\\Vendor\\App.exe");

    await expect(selectApplicationExecutable()).resolves.toBe(
      "C:\\Program Files\\Vendor\\App.exe",
    );
    expect(invokeMock).toHaveBeenCalledWith("select_application_executable");
  });

  it("does not invoke native commands from the browser", async () => {
    isTauriMock.mockReturnValue(false);

    await expect(selectApplicationExecutable()).rejects.toThrow(
      "only available in the Windows desktop app",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
