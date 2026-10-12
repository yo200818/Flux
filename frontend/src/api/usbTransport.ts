import { invoke, isTauri } from "@tauri-apps/api/core";

export interface UsbAndroidDevice {
  serial: string;
  model: string | null;
  state: string;
  is_usb: boolean;
}

export async function listUsbAndroidDevices(): Promise<UsbAndroidDevice[]> {
  if (!isTauri()) {
    return [];
  }
  return invoke<UsbAndroidDevice[]>("list_usb_devices");
}

export async function enableUsbReverse(
  serial: string,
  port: number,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("USB reverse connections are available in the Windows app.");
  }
  return invoke<string>("enable_usb_reverse", { serial, port });
}

export async function disableUsbReverse(
  serial: string,
  port: number,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("USB reverse connections are available in the Windows app.");
  }
  return invoke<string>("disable_usb_reverse", { serial, port });
}
