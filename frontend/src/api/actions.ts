import { API_BASE_URL } from "./baseUrl";
import { addAuthorizationHeader } from "./authorization";

export interface ActionExecutionResult {
  action_id: string;
  success: boolean;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function executeAction(
  actionId: string,
): Promise<ActionExecutionResult> {
  let response: Response;
  try {
    response = await fetch(
      `${API_BASE_URL}/api/actions/${encodeURIComponent(actionId)}/execute`,
      {
        method: "POST",
        headers: addAuthorizationHeader({ Accept: "application/json" }),
      },
    );
  } catch (error) {
    throw new Error("Could not reach the PocketDeck action service.", {
      cause: error,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Backend returned an invalid action response.");
  }

  if (!response.ok) {
    const errorMessage =
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string"
        ? body.error.message
        : `Action request failed (${response.status}).`;
    throw new Error(errorMessage);
  }

  if (
    !isRecord(body) ||
    body.action_id !== actionId ||
    typeof body.success !== "boolean" ||
    typeof body.message !== "string"
  ) {
    throw new Error("Backend returned an unsupported action response.");
  }
  return {
    action_id: body.action_id,
    success: body.success,
    message: body.message,
  };
}
