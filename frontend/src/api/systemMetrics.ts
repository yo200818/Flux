import { API_BASE_URL } from "./baseUrl";
import { addAuthorizationHeader } from "./authorization";
import type { SystemMetricName } from "./configuration";

export interface SystemMetricsSnapshot {
  cpu_status: "sampling" | "available" | "unavailable";
  cpu_usage_percent: number | null;
  memory_used_bytes: number | null;
  memory_total_bytes: number | null;
  unavailable_metrics: Partial<Record<SystemMetricName, string>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSystemMetricsSnapshot(value: unknown): value is SystemMetricsSnapshot {
  const unavailableMetrics = isRecord(value) ? value.unavailable_metrics : null;
  const cpuPercent = isRecord(value) ? value.cpu_usage_percent : undefined;
  const memoryUsed = isRecord(value) ? value.memory_used_bytes : undefined;
  const memoryTotal = isRecord(value) ? value.memory_total_bytes : undefined;
  const cpuStatus = isRecord(value) ? value.cpu_status : undefined;
  const validNumberOrNull = (candidate: unknown) =>
    candidate === null ||
    (typeof candidate === "number" && Number.isFinite(candidate));
  const knownMetrics: readonly string[] = [
    "cpu_utilization",
    "memory_usage",
    "gpu_utilization",
    "gpu_temperature",
    "cpu_temperature",
  ];
  return (
    isRecord(value) &&
    ["sampling", "available", "unavailable"].includes(String(cpuStatus)) &&
    validNumberOrNull(cpuPercent) &&
    validNumberOrNull(memoryUsed) &&
    validNumberOrNull(memoryTotal) &&
    isRecord(unavailableMetrics) &&
    Object.entries(unavailableMetrics).every(
      ([metric, message]) =>
        knownMetrics.includes(metric) &&
        typeof message === "string",
    ) &&
    (cpuStatus === "available"
      ? typeof cpuPercent === "number" && cpuPercent >= 0 && cpuPercent <= 100
      : cpuPercent === null) &&
    (memoryUsed === null
      ? memoryTotal === null
      : typeof memoryUsed === "number" &&
        Number.isInteger(memoryUsed) &&
        memoryUsed >= 0 &&
        typeof memoryTotal === "number" &&
        Number.isInteger(memoryTotal) &&
        memoryTotal > 0 &&
        memoryUsed <= memoryTotal
    )
  );
}

export async function getSystemMetrics(
  signal?: AbortSignal,
): Promise<SystemMetricsSnapshot> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/system/metrics`, {
      headers: addAuthorizationHeader({ Accept: "application/json" }),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw new Error("Could not reach the PocketDeck system monitoring service.", {
      cause: error,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Backend returned an invalid system metrics response.");
  }

  if (!response.ok) {
    const message =
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string"
        ? body.error.message
        : `System metrics request failed (${response.status}).`;
    throw new Error(message);
  }
  if (!isSystemMetricsSnapshot(body)) {
    throw new Error("Backend returned an unsupported system metrics response.");
  }
  return body;
}
