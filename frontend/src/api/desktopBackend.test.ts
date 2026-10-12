import { afterEach, describe, expect, it, vi } from "vitest";
import { getDesktopBackendStartupError } from "./desktopBackend";

const { invokeMock, isTauriMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  isTauriMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
  isTauri: isTauriMock,
}));

describe("getDesktopBackendStartupError", () => {
  afterEach(() => {
    invokeMock.mockReset();
    isTauriMock.mockReset();
  });

  it("does not invoke desktop commands in the browser", async () => {
    isTauriMock.mockReturnValue(false);

    await expect(getDesktopBackendStartupError()).resolves.toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reads the packaged backend startup error from Tauri", async () => {
    isTauriMock.mockReturnValue(true);
    invokeMock.mockResolvedValue("Backend failed to start.");

    await expect(getDesktopBackendStartupError()).resolves.toBe(
      "Backend failed to start.",
    );
    expect(invokeMock).toHaveBeenCalledWith("backend_startup_error");
  });
});
