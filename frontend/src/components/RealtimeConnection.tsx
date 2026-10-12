import type { RealtimeStatus } from "../api/realtime";
import { StatusCard } from "./StatusCard";

interface RealtimeConnectionProps {
  status: RealtimeStatus;
  retry: () => void;
}

const statusDetails: Record<
  RealtimeStatus,
  { value: string; detail: string; tone: "ready" | "pending" | "error"; badge: string }
> = {
  connecting: {
    value: "Connecting",
    detail: "Opening the local configuration event stream.",
    tone: "pending",
    badge: "CONNECTING",
  },
  connected: {
    value: "Connected",
    detail: "Live configuration notifications are active.",
    tone: "ready",
    badge: "CONNECTED",
  },
  disconnected: {
    value: "Disconnected",
    detail: "Automatic reconnect attempts have stopped.",
    tone: "error",
    badge: "DISCONNECTED",
  },
  reconnecting: {
    value: "Reconnecting",
    detail: "Trying to restore the local event stream.",
    tone: "pending",
    badge: "RECONNECTING",
  },
};

export function RealtimeConnection({
  status,
  retry,
}: RealtimeConnectionProps) {
  const details = statusDetails[status];

  return (
    <StatusCard
      icon="server"
      label="Live updates"
      value={details.value}
      detail={details.detail}
      tone={details.tone}
      badge={details.badge}
      action={
        status === "disconnected" ? (
          <button className="retry-button" onClick={retry} type="button">
            Retry live updates
          </button>
        ) : undefined
      }
    />
  );
}
