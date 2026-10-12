import { StatusCard } from "./StatusCard";
import type { BackendConnectionState } from "../hooks/useBackendHealth";

interface BackendConnectionProps {
  connection: BackendConnectionState;
  retry: () => void;
}

export function BackendConnection({
  connection,
  retry,
}: BackendConnectionProps) {

  if (connection.status === "checking") {
    return (
      <StatusCard
        icon="server"
        label="Backend connection"
        value="Checking connection"
        detail="Checking the local PocketDeck backend."
        tone="pending"
        badge="CHECKING"
      />
    );
  }

  if (connection.status === "connected") {
    return (
      <StatusCard
        icon="server"
        label="Backend connection"
        value="Backend connected"
        detail="The local PocketDeck backend is healthy."
        tone="ready"
        badge="CONNECTED"
      />
    );
  }

  return (
    <StatusCard
      icon="server"
      label="Backend connection"
      value="Backend disconnected"
      detail={connection.message}
      tone="error"
      badge="DISCONNECTED"
      action={
        connection.retryable === false ? undefined : (
          <button className="retry-button" onClick={retry} type="button">
            Retry connection
          </button>
        )
      }
    />
  );
}
