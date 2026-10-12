import { useCallback, useEffect, useState } from "react";
import {
  ConfigurationEventsClient,
  type RealtimeStatus,
} from "../api/realtime";
import type { BackendConnectionState } from "./useBackendHealth";

export function useRealtimeUpdates(
  onConfigurationUpdated: (revision: number) => void,
  getCurrentRevision: () => number,
  backendStatus: BackendConnectionState["status"],
  clientAuthorized = true,
) {
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const [restartKey, setRestartKey] = useState(0);

  useEffect(() => {
    if (backendStatus !== "connected" || !clientAuthorized) {
      return;
    }

    const client = new ConfigurationEventsClient(
      setStatus,
      onConfigurationUpdated,
      getCurrentRevision,
    );
    client.start();
    return () => client.dispose();
  }, [
    backendStatus,
    clientAuthorized,
    getCurrentRevision,
    onConfigurationUpdated,
    restartKey,
  ]);

  const retry = useCallback(() => {
    if (backendStatus === "connected") {
      setStatus("connecting");
    }
    setRestartKey((key) => key + 1);
  }, [backendStatus]);

  return {
    status:
      backendStatus === "checking"
        ? "connecting"
        : backendStatus === "disconnected" || !clientAuthorized
          ? "disconnected"
          : status,
    retry,
  };
}
