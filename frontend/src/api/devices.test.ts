import { afterEach, describe, expect, it, vi } from "vitest";
import { setApiCredential } from "./authorization";
import {
  getAuthenticatedDevice,
  getWifiConnectionInfo,
  uploadConfigurationToDevice,
  windowsConnectionQrPayload,
} from "./devices";

const deviceResponse = {
  device_id: "web-device",
  name: "Browser",
  client_type: "web",
  created_at: "2026-01-01T00:00:00Z",
  is_authorized: true,
  is_revoked: false,
};

describe("getAuthenticatedDevice", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiCredential(null);
  });

  describe("uploadConfigurationToDevice", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      setApiCredential(null);
    });

    it("returns only a server-confirmed Android save", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({
            device_id: "android-1",
            config_epoch: "epoch",
            revision: 7,
            outcome: "succeeded",
            message: "Saved atomically.",
          }),
        ),
      );

      await expect(uploadConfigurationToDevice("android-1")).resolves.toEqual({
        revision: 7,
        message: "Saved atomically.",
      });
    });

    it("does not treat an unconfirmed upload as successful", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({
            device_id: "android-1",
            config_epoch: "epoch",
            revision: 7,
            outcome: "failed",
            message: "Disk full.",
          }),
        ),
      );

      await expect(uploadConfigurationToDevice("android-1")).rejects.toThrow(
        "Backend did not confirm saving the configuration on Android.",
      );
    });
  });

  describe("getWifiConnectionInfo", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      setApiCredential(null);
    });

    it("validates and returns authenticated TLS endpoint details", async () => {
      const response = {
        enabled: true,
        addresses: ["192.168.1.12"],
        port: 8443,
        server_id: "server-id",
        certificate_sha256: "AA:".repeat(31) + "AA",
        certificate_expires_at: 1_800_000_000,
        error: null,
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));

      await expect(getWifiConnectionInfo()).resolves.toEqual(response);
    });

    it("rejects incomplete or malformed endpoint details", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({
            enabled: true,
            addresses: ["192.168.1.12"],
            port: "8443",
            server_id: "server-id",
            certificate_sha256: null,
            certificate_expires_at: null,
            error: null,
          }),
        ),
      );

      await expect(getWifiConnectionInfo()).rejects.toThrow(
        "Backend returned invalid Wi-Fi connection information.",
      );
    });

    it("generates the versioned QR contract without replacing Wi-Fi addresses by loopback", () => {
      const payload = JSON.parse(
        windowsConnectionQrPayload({
          enabled: true,
          addresses: ["127.0.0.1", "192.168.1.12", "::1"],
          port: 8443,
          server_id: "6b7bb8da-a30a-45bd-9b89-4a42a191a7c4",
          certificate_sha256: "AA:".repeat(31) + "AA",
          certificate_expires_at: 1_800_000_000,
          error: null,
        }),
      );

      expect(payload).toEqual({
        type: "pocketdeck.connection",
        version: 2,
        server_id: "6b7bb8da-a30a-45bd-9b89-4a42a191a7c4",
        wifi_addresses: ["192.168.1.12"],
        port: 8443,
        certificate_sha256: "AA".repeat(32),
        certificate_expires_at: 1_800_000_000,
      });
    });

    it("emits an empty Wi-Fi endpoint list when only USB loopback is available", () => {
      const payload = JSON.parse(
        windowsConnectionQrPayload({
          enabled: false,
          addresses: [],
          port: 8443,
          server_id: "6b7bb8da-a30a-45bd-9b89-4a42a191a7c4",
          certificate_sha256: "AA:".repeat(31) + "AA",
          certificate_expires_at: 1_800_000_000,
          error: "Wi-Fi is unavailable.",
        }),
      );

      expect(payload.wifi_addresses).toEqual([]);
      expect(payload.wifi_addresses).not.toContain("127.0.0.1");
    });
  });

  it("authenticates and validates the registered device response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json(deviceResponse));
    vi.stubGlobal("fetch", fetchMock);
    setApiCredential("paired-web-token");

    await expect(getAuthenticatedDevice()).resolves.toEqual(deviceResponse);
    const options = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(options?.headers).get("Authorization")).toBe(
      "Bearer paired-web-token",
    );
  });

  it("rejects responses that lack authorization metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ ...deviceResponse, is_revoked: true }),
      ),
    );

    await expect(getAuthenticatedDevice()).rejects.toThrow(
      "Backend returned an unsupported device authorization response.",
    );
  });
});
