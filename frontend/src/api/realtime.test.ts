import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiCredential } from "./authorization";
import {
  ConfigurationEventsClient,
  INITIAL_RECONNECT_DELAY_MS,
  MAX_RECONNECT_ATTEMPTS,
  MAX_RECONNECT_DELAY_MS,
  type RealtimeStatus,
} from "./realtime";

class MockWebSocket {
  static readonly CLOSED = 3;
  static readonly CLOSING = 2;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  });

  message(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function makeEvent(
  type: "connection.ready" | "config.updated",
  revision: number,
) {
  return JSON.stringify({
    protocol_version: 1,
    event_id: `00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`,
    type,
    revision,
    payload: {},
  });
}

describe("ConfigurationEventsClient", () => {
  beforeEach(() => {
    setApiCredential("test-token");
  });

  afterEach(() => {
    vi.useRealTimers();
    setApiCredential(null);
  });

  it("ignores duplicate and stale revisions and refreshes only for newer events", () => {
    const socket = new MockWebSocket();
    const status = vi.fn<(value: RealtimeStatus) => void>();
    const updated = vi.fn<(revision: number) => void>();
    const client = new ConfigurationEventsClient(
      status,
      updated,
      () => 5,
      () => socket as unknown as WebSocket,
    );

    client.start();
    expect(status).toHaveBeenCalledWith("connecting");
    socket.onopen?.();
    expect(status).toHaveBeenCalledWith("connected");

    socket.message(makeEvent("config.updated", 4));
    socket.message(makeEvent("config.updated", 6));
    socket.message(makeEvent("config.updated", 6));
    socket.message(makeEvent("connection.ready", 5));

    expect(updated).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledWith(6);
    client.dispose();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("ignores malformed, unsupported, and action execution messages", () => {
    const socket = new MockWebSocket();
    const updated = vi.fn();
    const client = new ConfigurationEventsClient(
      vi.fn(),
      updated,
      () => 0,
      () => socket as unknown as WebSocket,
    );
    client.start();

    socket.message("not-json");
    socket.message(
      JSON.stringify({
        protocol_version: 9,
        event_id: "event-1",
        type: "config.updated",
        revision: 10,
        payload: {},
      }),
    );
    socket.message(
      JSON.stringify({
        protocol_version: 1,
        event_id: "event-2",
        type: "action.execute",
        revision: 10,
        payload: {},
      }),
    );

    expect(updated).not.toHaveBeenCalled();
    client.dispose();
  });

  it("reconnects with capped exponential delay and stops after bounded attempts", () => {
    vi.useFakeTimers();
    const sockets: MockWebSocket[] = [];
    const statuses: RealtimeStatus[] = [];
    const client = new ConfigurationEventsClient(
      (status) => statuses.push(status),
      vi.fn(),
      () => 0,
      () => {
        const socket = new MockWebSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    );

    client.start();
    for (let retry = 0; retry < MAX_RECONNECT_ATTEMPTS; retry += 1) {
      sockets.at(-1)?.close();
      expect(statuses.at(-1)).toBe("reconnecting");
      const expectedDelay = Math.min(
        INITIAL_RECONNECT_DELAY_MS * 2 ** retry,
        MAX_RECONNECT_DELAY_MS,
      );
      vi.advanceTimersByTime(expectedDelay);
    }
    sockets.at(-1)?.close();

    expect(statuses.at(-1)).toBe("disconnected");
    expect(sockets).toHaveLength(MAX_RECONNECT_ATTEMPTS + 1);
    client.dispose();
  });

  it("clears a pending reconnect timer and closes its socket on dispose", () => {
    vi.useFakeTimers();
    const socket = new MockWebSocket();
    const factory = vi.fn(() => socket as unknown as WebSocket);
    const client = new ConfigurationEventsClient(
      vi.fn(),
      vi.fn(),
      () => 0,
      factory,
    );
    client.start();
    socket.close();

    client.dispose();
    vi.advanceTimersByTime(MAX_RECONNECT_DELAY_MS * 2);

    expect(factory).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
  });
});
