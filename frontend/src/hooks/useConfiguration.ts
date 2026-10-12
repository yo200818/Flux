import { useCallback, useEffect, useRef, useState } from "react";
import {
  getConfiguration,
  ConfigurationRevisionConflictError,
  updateConfiguration,
  type ConfigurationSnapshot,
  type PocketDeckConfiguration,
} from "../api/configuration";
import type { BackendConnectionState } from "./useBackendHealth";

export type ConfigurationState =
  | { status: "loading" }
  | ({ status: "loaded" } & ConfigurationSnapshot)
  | { status: "error"; message: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Could not load the PocketDeck configuration.";
}

export function useConfiguration(backend: BackendConnectionState) {
  const [state, setState] = useState<ConfigurationState>({
    status: "loading",
  });
  const stateRef = useRef<ConfigurationState>(state);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const updateState = useCallback((next: ConfigurationState) => {
    const current = stateRef.current;
    if (
      next.status === "loaded" &&
      current.status === "loaded" &&
      next.revision < current.revision
    ) {
      return;
    }
    stateRef.current = next;
    setState(next);
  }, []);

  const fetchConfiguration = useCallback(
    (signal?: AbortSignal): Promise<ConfigurationState> =>
      getConfiguration(signal)
        .then((snapshot) => ({ status: "loaded" as const, ...snapshot }))
        .catch((error: unknown) => ({
          status: "error" as const,
          message: getErrorMessage(error),
        })),
    [],
  );

  useEffect(() => {
    if (backend.status === "checking") {
      updateState({ status: "loading" });
      return;
    }
    if (backend.status === "disconnected") {
      updateState({ status: "error", message: backend.message });
      return;
    }

    const controller = new AbortController();
    let isActive = true;
    void fetchConfiguration(controller.signal).then((result) => {
      if (isActive && !controller.signal.aborted) {
        updateState(result);
      }
    });
    return () => {
      isActive = false;
      controller.abort();
    };
  }, [backend, fetchConfiguration, updateState]);

  const retry = useCallback(() => {
    if (backend.status !== "connected") {
      return;
    }
    updateState({ status: "loading" });
    void fetchConfiguration().then(updateState);
  }, [backend.status, fetchConfiguration, updateState]);

  const refreshForRevision = useCallback(
    async (revision: number) => {
      const current = stateRef.current;
      if (current.status === "loaded" && revision <= current.revision) {
        return;
      }
      try {
        const snapshot = await getConfiguration();
        if (snapshot.revision >= revision) {
          updateState({ status: "loaded", ...snapshot });
          setRefreshError(null);
        }
      } catch (error) {
        setRefreshError(getErrorMessage(error));
      }
    },
    [updateState],
  );

  const getCurrentRevision = useCallback(() => {
    const current = stateRef.current;
    return current.status === "loaded" ? current.revision : -1;
  }, []);

  const saveConfiguration = useCallback(
    async (configuration: PocketDeckConfiguration): Promise<void> => {
      const current = stateRef.current;
      if (current.status !== "loaded") {
        throw new Error("Wait for the configuration to load before saving.");
      }

      try {
        const snapshot = await updateConfiguration(
          configuration,
          current.revision,
        );
        updateState({ status: "loaded", ...snapshot });
      } catch (error) {
        if (
          error instanceof ConfigurationRevisionConflictError &&
          error.latestSnapshot
        ) {
          updateState({ status: "loaded", ...error.latestSnapshot });
        }
        throw error;
      }
    },
    [updateState],
  );

  return {
    state,
    retry,
    saveConfiguration,
    refreshForRevision,
    getCurrentRevision,
    refreshError,
  };
}
