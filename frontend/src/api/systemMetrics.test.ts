import { afterEach, describe, expect, it, vi } from "vitest";
import { setApiCredential } from "./authorization";
import { getSystemMetrics } from "./systemMetrics";

describe("getSystemMetrics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setApiCredential(null);
  });

  it("requests authenticated read-only metrics and accepts unavailable sensors", async () => {
    const snapshot = {
      cpu_status: "available",
      cpu_usage_percent: 27.4,
      memory_used_bytes: 1024,
      memory_total_bytes: 4096,
      unavailable_metrics: {
        gpu_utilization: "No supported provider.",
        gpu_temperature: "No supported provider.",
        cpu_temperature: "No supported provider.",
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(snapshot));
    vi.stubGlobal("fetch", fetchMock);
    setApiCredential("metrics-test-token");

    await expect(getSystemMetrics()).resolves.toEqual(snapshot);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/system/metrics",
      expect.objectContaining({ signal: undefined }),
    );
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("Authorization")).toBe(
      "Bearer metrics-test-token",
    );
  });

  it("rejects malformed metrics responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ cpu: 10 })));

    await expect(getSystemMetrics()).rejects.toThrow(
      "Backend returned an unsupported system metrics response.",
    );
  });

  it("rejects impossible utilization percentages instead of displaying them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          cpu_status: "available",
          cpu_usage_percent: 140,
          memory_used_bytes: null,
          memory_total_bytes: null,
          unavailable_metrics: {},
        }),
      ),
    );

    await expect(getSystemMetrics()).rejects.toThrow(
      "Backend returned an unsupported system metrics response.",
    );
  });
});
