import { useCallback, useEffect, useState } from "react";
import { getDesktopBackendStartupError } from "../api/desktopBackend";
import { getHealth } from "../api/health";

export type BackendConnectionState =
  | { status: "checking" }
  | { status: "connected" }
  | { status: "disconnected"; message: string; retryable?: boolean };

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "Could not reach the PocketDeck backend.";
}

export function useBackendHealth() {
  const [connection, setConnection] = useState<BackendConnectionState>({
    status: "checking",
  });

  const fetchConnection = useCallback(
    async (signal?: AbortSignal): Promise<BackendConnectionState> => {
      try {
        const startupError = await getDesktopBackendStartupError();
        if (startupError) {
          return {
            status: "disconnected",
            message: startupError,
            retryable: false,
          };
        }
        await getHealth(signal);
        return { status: "connected" };
      } catch (error: unknown) {
        return {
          status: "disconnected" as const,
          message: getErrorMessage(error),
        };
      }
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;
    void fetchConnection(controller.signal).then((result) => {
      if (isActive && !controller.signal.aborted) {
        setConnection(result);
      }
    });
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [fetchConnection]);

  const retry = useCallback(() => {
    setConnection({ status: "checking" });
    void fetchConnection().then(setConnection);
  }, [fetchConnection]);

  return { connection, retry };
}
