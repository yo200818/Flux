import { useCallback, useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getAuthenticatedDevice } from "../api/devices";
import { setApiCredential } from "../api/authorization";

export type ClientAuthorizationState =
  | { status: "checking" }
  | { status: "unauthorized"; message?: string }
  | { status: "authorized"; clientType: "desktop" | "web" };

export function useClientAuthorization() {
  const [state, setState] = useState<ClientAuthorizationState>(() =>
    isTauri() ? { status: "checking" } : { status: "unauthorized" },
  );

  useEffect(() => {
    if (!isTauri()) {
      return;
    }
    let active = true;
    void invoke<string>("backend_admin_token")
      .then((credential) => {
        if (active) {
          setApiCredential(credential);
          setState({ status: "authorized", clientType: "desktop" });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({
            status: "unauthorized",
            message:
              error instanceof Error
                ? error.message
                : "The desktop authentication credential is unavailable.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const authorizeWebClient = useCallback(async (credential: string) => {
    const normalized = credential.trim();
    if (!normalized) {
      throw new Error("Enter a paired web-device credential.");
    }
    setApiCredential(normalized);
    try {
      const device = await getAuthenticatedDevice();
      if (device.client_type !== "web") {
        throw new Error("Browser access requires a paired web-device credential.");
      }
      setState({ status: "authorized", clientType: "web" });
    } catch (error) {
      setApiCredential(null);
      setState({
        status: "unauthorized",
        message:
          error instanceof Error
            ? error.message
            : "The device credential could not be verified.",
      });
      throw error;
    }
  }, []);

  const disconnect = useCallback(() => {
    setApiCredential(null);
    setState({ status: "unauthorized" });
  }, []);

  return { state, authorizeWebClient, disconnect };
}
