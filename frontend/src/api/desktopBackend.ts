import { invoke, isTauri } from "@tauri-apps/api/core";

export async function getDesktopBackendStartupError(): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }
  return invoke<string | null>("backend_startup_error");
}
