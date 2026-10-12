import { API_BASE_URL } from "./baseUrl";
import { getApiCredential } from "./authorization";

export type RealtimeStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting";

export interface ServerEvent {
  protocol_version: 1;
  event_id: string;
  type: "connection.ready" | "config.updated" | "server.pong" | "protocol.error";
  revision?: number;
  payload: Record<string, unknown>;
}

export const MAX_RECONNECT_ATTEMPTS = 8;
export const INITIAL_RECONNECT_DELAY_MS = 500;
export const MAX_RECONNECT_DELAY_MS = 10_000;

type SocketFactory = (url: string, protocols?: string[]) => WebSocket;

function websocketUrl(): string {
  const url = new URL(API_BASE_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`;
  return url.toString();
}

export function websocketProtocols(): string[] | null {
  const credential = getApiCredential();
  return credential ? ["pocketdeck.v1", `bearer.${credential}`] : null;
}

function parseServerEvent(value: unknown): ServerEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const event = value;
  if (
    event.protocol_version !== 1 ||
    typeof event.event_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      event.event_id,
    ) ||
    !isRecord(event.payload) ||
    !isServerEventType(event.type) ||
    (event.type !== "protocol.error" &&
      (typeof event.revision !== "number" ||
        !Number.isSafeInteger(event.revision) ||
        event.revision < 0)) ||
    (event.revision !== undefined &&
      (typeof event.revision !== "number" ||
        !Number.isSafeInteger(event.revision) ||
        event.revision < 0))
  ) {
    return null;
  }
  const baseEvent: Omit<ServerEvent, "revision"> = {
    protocol_version: 1,
    event_id: event.event_id,
    type: event.type,
    payload: event.payload,
  };
  if (typeof event.revision === "number") {
    return { ...baseEvent, revision: event.revision };
  }
  return baseEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isServerEventType(value: unknown): value is ServerEvent["type"] {
  return (
    value === "connection.ready" ||
    value === "config.updated" ||
    value === "server.pong" ||
    value === "protocol.error"
  );
}

export class ConfigurationEventsClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private retryCount = 0;
  private highestRevisionSeen: number;

  constructor(
    private readonly onStatus: (status: RealtimeStatus) => void,
    private readonly onConfigurationUpdated: (revision: number) => void,
    private readonly getCurrentRevision: () => number,
    private readonly createSocket: SocketFactory = (url, protocols) =>
      new WebSocket(url, protocols),
  ) {
    this.highestRevisionSeen = getCurrentRevision();
  }

  start(): void {
    if (!this.disposed) {
      this.openSocket();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (
      socket &&
      socket.readyState !== WebSocket.CLOSED &&
      socket.readyState !== WebSocket.CLOSING
    ) {
      socket.close(1000, "Client disposed");
    }
  }

  private openSocket(): void {
    if (this.disposed) {
      return;
    }
    this.onStatus(this.retryCount === 0 ? "connecting" : "reconnecting");
    let socket: WebSocket;
    try {
      const protocols = websocketProtocols();
      if (!protocols) {
        this.onStatus("disconnected");
        return;
      }
      socket = this.createSocket(websocketUrl(), protocols);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.retryCount = 0;
      this.onStatus("connected");
    };
    socket.onmessage = (message) => this.handleMessage(message.data);
    socket.onerror = () => {
      socket.close();
    };
    socket.onclose = () => {
      if (this.socket === socket) {
        this.socket = null;
      }
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    };
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const event = parseServerEvent(parsed);
    if (
      !event ||
      (event.type !== "connection.ready" && event.type !== "config.updated") ||
      event.revision === undefined ||
      event.revision <= this.highestRevisionSeen ||
      event.revision <= this.getCurrentRevision()
    ) {
      return;
    }
    this.highestRevisionSeen = event.revision;
    this.onConfigurationUpdated(event.revision);
  }

  private scheduleReconnect(): void {
    if (this.disposed) {
      return;
    }
    if (this.retryCount >= MAX_RECONNECT_ATTEMPTS) {
      this.onStatus("disconnected");
      return;
    }

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** this.retryCount,
      MAX_RECONNECT_DELAY_MS,
    );
    this.retryCount += 1;
    this.onStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }
}
