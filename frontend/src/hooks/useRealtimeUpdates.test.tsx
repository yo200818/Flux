import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendConnectionState } from "./useBackendHealth";
import { useRealtimeUpdates } from "./useRealtimeUpdates";

const clientMocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  start: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../api/realtime", () => ({
  ConfigurationEventsClient: class {
    constructor() {
      clientMocks.constructor();
    }

    start() {
      clientMocks.start();
    }

    dispose() {
      clientMocks.dispose();
    }
  },
}));

describe("useRealtimeUpdates", () => {
  afterEach(() => {
    clientMocks.constructor.mockClear();
    clientMocks.start.mockClear();
    clientMocks.dispose.mockClear();
  });

  it("waits for backend health before connecting and disposes on disconnect", () => {
    const backendState: { status: BackendConnectionState["status"] } = {
      status: "checking",
    };
    const { result, rerender } = renderHook(
      ({ status }: { status: BackendConnectionState["status"] }) =>
        useRealtimeUpdates(vi.fn(), () => -1, status),
      { initialProps: backendState },
    );

    expect(result.current.status).toBe("connecting");
    expect(clientMocks.constructor).not.toHaveBeenCalled();

    rerender({ status: "connected" });
    expect(clientMocks.constructor).toHaveBeenCalledOnce();
    expect(clientMocks.start).toHaveBeenCalledOnce();

    rerender({ status: "disconnected" });
    expect(clientMocks.dispose).toHaveBeenCalledOnce();
    expect(result.current.status).toBe("disconnected");
  });
});
