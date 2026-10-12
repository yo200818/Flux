import { API_BASE_URL } from "./baseUrl";

export interface HealthResponse {
  service: "PocketDeck Backend";
  status: "healthy";
}

export const HEALTH_CHECK_TIMEOUT_MS = 5_000;

function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const response = value as Record<string, unknown>;
  return (
    response.service === "PocketDeck Backend" &&
    response.status === "healthy"
  );
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, HEALTH_CHECK_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}/api/health`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw error;
      }
      throw new Error("Could not reach the PocketDeck backend.", {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new Error(`Backend health check failed (${response.status}).`);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error("Backend returned an invalid health response.");
    }

    if (!isHealthResponse(body)) {
      throw new Error("Backend returned an unexpected health response.");
    }

    return body;
  } catch (error) {
    if (timedOut) {
      throw new Error(
        `Backend health check timed out after ${HEALTH_CHECK_TIMEOUT_MS} ms.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
