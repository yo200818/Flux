import { invoke, isTauri } from "@tauri-apps/api/core";

export async function getLaunchAtLogin(): Promise<boolean> {
  if (!isTauri()) {
    return false;
  }
  return invoke<boolean>("get_launch_at_login");
}

export async function setLaunchAtLogin(enabled: boolean): Promise<boolean> {
  if (!isTauri()) {
    throw new Error("Windows startup settings are available in the Windows app.");
  }
  return invoke<boolean>("set_launch_at_login", { enabled });
}
