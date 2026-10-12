import { API_BASE_URL } from "./baseUrl";
import { addAuthorizationHeader } from "./authorization";

export interface AuthenticatedDevice {
  device_id: string;
  name: string;
  client_type: "desktop" | "android" | "ios" | "web" | "pocketdeck_os";
  created_at: string;
  is_authorized: boolean;
  is_revoked: boolean;
}

function isClientType(
  value: unknown,
): value is AuthenticatedDevice["client_type"] {
  return (
    value === "desktop" ||
    value === "android" ||
    value === "ios" ||
    value === "web" ||
    value === "pocketdeck_os"
  );
}

export type ManagedDevice = AuthenticatedDevice;

export interface PairingRequest {
  request_id: string;
  device_id: string;
  name: string;
  client_type: AuthenticatedDevice["client_type"];
  transport: "wifi" | "usb";
  expires_at: string;
}

export interface PairingSession {
  session_id: string;
  pairing_code: string;
  expires_at: string;
}

export interface WifiConnectionInfo {
  enabled: boolean;
  addresses: string[];
  port: number;
  server_id: string;
  certificate_sha256: string | null;
  certificate_expires_at: number | null;
  error: string | null;
}

export function windowsConnectionQrPayload(info: WifiConnectionInfo): string {
  const fingerprint = info.certificate_sha256?.replaceAll(":", "");
  if (
    !fingerprint ||
    !/^[0-9a-f]{64}$/i.test(fingerprint) ||
    info.certificate_expires_at === null ||
    info.certificate_expires_at <= 0
  ) {
    throw new Error("The Windows TLS certificate is not available for QR provisioning.");
  }
  return JSON.stringify({
    type: "pocketdeck.connection",
    version: 2,
    server_id: info.server_id,
    wifi_addresses: info.enabled
      ? info.addresses.filter((address) => !isLoopbackAddress(address))
      : [],
    port: info.port,
    certificate_sha256: fingerprint,
    certificate_expires_at: info.certificate_expires_at,
  });
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized.startsWith("127.")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function requestJson(
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: addAuthorizationHeader({
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      }),
    });
  } catch (error) {
    throw new Error("Could not reach the PocketDeck device API.", {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Device management requires an authorized desktop administrator."
        : `Device request failed (${response.status}).`,
    );
  }
  if (response.status === 204) {
    return null;
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error("Backend returned invalid device-management data.", {
      cause: error,
    });
  }
}

function isManagedDevice(value: unknown): value is ManagedDevice {
  return (
    typeof value === "object" &&
    value !== null &&
    "device_id" in value &&
    typeof value.device_id === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "client_type" in value &&
    isClientType(value.client_type) &&
    "created_at" in value &&
    typeof value.created_at === "string" &&
    "is_authorized" in value &&
    typeof value.is_authorized === "boolean" &&
    "is_revoked" in value &&
    typeof value.is_revoked === "boolean"
  );
}

export async function listManagedDevices(): Promise<ManagedDevice[]> {
  const body = await requestJson("/api/devices");
  if (
    !isRecord(body) ||
    !("devices" in body) ||
    !Array.isArray(body.devices) ||
    !body.devices.every(isManagedDevice)
  ) {
    throw new Error("Backend returned an unsupported device list.");
  }
  return body.devices;
}

export async function listPairingRequests(): Promise<PairingRequest[]> {
  const body = await requestJson("/api/pairing/requests");
  if (
    typeof body !== "object" ||
    body === null ||
    !("requests" in body) ||
    !Array.isArray(body.requests) ||
    !body.requests.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "request_id" in item &&
        typeof item.request_id === "string" &&
        "device_id" in item &&
        typeof item.device_id === "string" &&
        "name" in item &&
        typeof item.name === "string" &&
        "client_type" in item &&
        isClientType(item.client_type) &&
        "transport" in item &&
        (item.transport === "wifi" || item.transport === "usb") &&
        "expires_at" in item &&
        typeof item.expires_at === "string",
    )
  ) {
    throw new Error("Backend returned an unsupported pairing request list.");
  }
  return body.requests;
}

export async function createPairingSession(): Promise<PairingSession> {
  const body = await requestJson("/api/pairing/sessions", { method: "POST" });
  if (
    typeof body !== "object" ||
    body === null ||
    !("session_id" in body) ||
    typeof body.session_id !== "string" ||
    !("pairing_code" in body) ||
    typeof body.pairing_code !== "string" ||
    !("expires_at" in body) ||
    typeof body.expires_at !== "string"
  ) {
    throw new Error("Backend returned an unsupported pairing session.");
  }
  return {
    session_id: body.session_id,
    pairing_code: body.pairing_code,
    expires_at: body.expires_at,
  };
}

export async function approvePairingRequest(
  requestId: string,
): Promise<{ device: ManagedDevice; credential: string | null }> {
  const body = await requestJson(
    `/api/pairing/requests/${encodeURIComponent(requestId)}/approve`,
    { method: "POST" },
  );
  if (
    typeof body !== "object" ||
    body === null ||
    !("device" in body) ||
    !isManagedDevice(body.device) ||
    !("credential" in body) ||
    !(body.credential === null || typeof body.credential === "string")
  ) {
    throw new Error("Backend returned an unsupported approved device.");
  }
  return { device: body.device, credential: body.credential };
}

export async function getWifiConnectionInfo(): Promise<WifiConnectionInfo> {
  const body = await requestJson("/api/wifi/status");
  if (
    !isRecord(body) ||
    typeof body.enabled !== "boolean" ||
    !Array.isArray(body.addresses) ||
    !body.addresses.every(
      (address: unknown): address is string => typeof address === "string",
    ) ||
    typeof body.port !== "number" ||
    !Number.isInteger(body.port) ||
    typeof body.server_id !== "string" ||
    !(body.certificate_sha256 === null ||
      typeof body.certificate_sha256 === "string") ||
    !(body.certificate_expires_at === null ||
      (typeof body.certificate_expires_at === "number" &&
        Number.isSafeInteger(body.certificate_expires_at))) ||
    !(body.error === null || typeof body.error === "string")
  ) {
    throw new Error("Backend returned invalid Wi-Fi connection information.");
  }
  return {
    enabled: body.enabled,
    addresses: body.addresses,
    port: body.port,
    server_id: body.server_id,
    certificate_sha256: body.certificate_sha256,
    certificate_expires_at: body.certificate_expires_at,
    error: body.error,
  };
}

export async function rejectPairingRequest(requestId: string): Promise<void> {
  await requestJson(
    `/api/pairing/requests/${encodeURIComponent(requestId)}/reject`,
    { method: "POST" },
  );
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await requestJson(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
}

export async function uploadConfigurationToDevice(
  deviceId: string,
): Promise<{ revision: number; message: string }> {
  const body = await requestJson(
    `/api/devices/${encodeURIComponent(deviceId)}/configuration/upload`,
    { method: "POST" },
  );
  if (
    !isRecord(body) ||
    body.device_id !== deviceId ||
    typeof body.revision !== "number" ||
    !Number.isInteger(body.revision) ||
    body.outcome !== "succeeded" ||
    typeof body.message !== "string"
  ) {
    throw new Error("Backend did not confirm saving the configuration on Android.");
  }
  return { revision: body.revision, message: body.message };
}

export async function getAuthenticatedDevice(): Promise<AuthenticatedDevice> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/devices/me`, {
      headers: addAuthorizationHeader({ Accept: "application/json" }),
    });
  } catch (error) {
    throw new Error("Could not verify the PocketDeck device credential.", {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "This device credential is invalid or has been revoked."
        : `Device authorization failed (${response.status}).`,
    );
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("device_id" in body) ||
    typeof body.device_id !== "string" ||
    !("name" in body) ||
    typeof body.name !== "string" ||
    !("client_type" in body) ||
    !isClientType(body.client_type) ||
    !("created_at" in body) ||
    typeof body.created_at !== "string" ||
    !("is_authorized" in body) ||
    body.is_authorized !== true ||
    !("is_revoked" in body) ||
    body.is_revoked !== false
  ) {
    throw new Error("Backend returned an unsupported device authorization response.");
  }
  return {
    device_id: body.device_id,
    name: body.name,
    client_type: body.client_type,
    created_at: body.created_at,
    is_authorized: true,
    is_revoked: false,
  };
}
