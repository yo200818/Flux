import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDesktopBackendStartupError } from "../api/desktopBackend";
import { getHealth } from "../api/health";
import { useBackendHealth } from "./useBackendHealth";

vi.mock("../api/desktopBackend", () => ({
  getDesktopBackendStartupError: vi.fn(),
}));
vi.mock("../api/health", () => ({
  getHealth: vi.fn(),
}));

const getDesktopBackendStartupErrorMock = vi.mocked(
  getDesktopBackendStartupError,
);
const getHealthMock = vi.mocked(getHealth);

describe("useBackendHealth", () => {
  afterEach(() => {
    getDesktopBackendStartupErrorMock.mockReset();
    getHealthMock.mockReset();
  });

  it("surfaces a packaged startup failure without querying the backend", async () => {
    getDesktopBackendStartupErrorMock.mockResolvedValue(
      "Packaged backend startup failed.",
    );
    const { result } = renderHook(() => useBackendHealth());

    await waitFor(() => {
      expect(result.current.connection).toEqual({
        status: "disconnected",
        message: "Packaged backend startup failed.",
        retryable: false,
      });
    });
    expect(getHealthMock).not.toHaveBeenCalled();
  });

  it("checks backend health when desktop startup succeeded", async () => {
    getDesktopBackendStartupErrorMock.mockResolvedValue(null);
    getHealthMock.mockResolvedValue({
      service: "PocketDeck Backend",
      status: "healthy",
    });
    const { result } = renderHook(() => useBackendHealth());

    await waitFor(() => {
      expect(result.current.connection).toEqual({ status: "connected" });
    });
    expect(getHealthMock).toHaveBeenCalledOnce();
  });
});
