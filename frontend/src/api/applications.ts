import { invoke, isTauri } from "@tauri-apps/api/core";

export function isApplicationPickerAvailable(): boolean {
  return isTauri();
}

export async function selectApplicationExecutable(): Promise<string | null> {
  if (!isTauri()) {
    throw new Error(
      "The native application picker is only available in the Windows desktop app.",
    );
  }
  return invoke<string | null>("select_application_executable");
}
