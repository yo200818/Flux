import { afterEach, describe, expect, it, vi } from "vitest";
import { getHealth, HEALTH_CHECK_TIMEOUT_MS } from "./health";

describe("getHealth", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("requests the backend health endpoint and validates its response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          service: "PocketDeck Backend",
          status: "healthy",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getHealth()).resolves.toEqual({
      service: "PocketDeck Backend",
      status: "healthy",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/health",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("reports network errors clearly", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(getHealth()).rejects.toThrow(
      "Could not reach the PocketDeck backend.",
    );
  });

  it("rejects non-success HTTP responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    await expect(getHealth()).rejects.toThrow(
      "Backend health check failed (503).",
    );
  });

  it("rejects malformed and unexpected response bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(getHealth()).rejects.toThrow(
      "Backend returned an invalid health response.",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ service: "Other Service", status: "healthy" }),
      ),
    );
    await expect(getHealth()).rejects.toThrow(
      "Backend returned an unexpected health response.",
    );
  });

  it("aborts a stalled health request and reports a timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    );

    const request = getHealth();
    const rejection = expect(request).rejects.toThrow(
      `Backend health check timed out after ${HEALTH_CHECK_TIMEOUT_MS} ms.`,
    );
    await vi.advanceTimersByTimeAsync(HEALTH_CHECK_TIMEOUT_MS);

    await rejection;
  });
});
