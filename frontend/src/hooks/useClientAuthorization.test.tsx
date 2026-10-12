import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getApiCredential, setApiCredential } from "../api/authorization";
import { getAuthenticatedDevice } from "../api/devices";
import { useClientAuthorization } from "./useClientAuthorization";

vi.mock("../api/devices", () => ({
  getAuthenticatedDevice: vi.fn(),
}));

const getAuthenticatedDeviceMock = vi.mocked(getAuthenticatedDevice);

describe("useClientAuthorization", () => {
  afterEach(() => {
    setApiCredential(null);
    getAuthenticatedDeviceMock.mockReset();
  });

  it("accepts and keeps a verified paired web credential in memory", async () => {
    getAuthenticatedDeviceMock.mockResolvedValue({
      device_id: "web-device",
      name: "Browser",
      client_type: "web",
      created_at: "2026-01-01T00:00:00Z",
      is_authorized: true,
      is_revoked: false,
    });
    const { result } = renderHook(() => useClientAuthorization());

    await act(async () => {
      await result.current.authorizeWebClient("  device-secret  ");
    });

    expect(getApiCredential()).toBe("device-secret");
    expect(result.current.state).toEqual({
      status: "authorized",
      clientType: "web",
    });
  });

  it("rejects non-web devices and clears the attempted credential", async () => {
    getAuthenticatedDeviceMock.mockResolvedValue({
      device_id: "android-device",
      name: "Phone",
      client_type: "android",
      created_at: "2026-01-01T00:00:00Z",
      is_authorized: true,
      is_revoked: false,
    });
    const { result } = renderHook(() => useClientAuthorization());

    let failure: unknown;
    await act(async () => {
      try {
        await result.current.authorizeWebClient("device-secret");
      } catch (error) {
        failure = error;
      }
    });

    expect(failure).toEqual(
      expect.objectContaining({
        message: "Browser access requires a paired web-device credential.",
      }),
    );
    expect(getApiCredential()).toBeNull();
    expect(result.current.state).toEqual({
      status: "unauthorized",
      message: "Browser access requires a paired web-device credential.",
    });
  });
});
