import { invoke } from "@tauri-apps/api/core";
import {
  isPocketDeckConfiguration,
  type PocketDeckConfiguration,
} from "./configuration";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

export function serializeConfigurationForExport(
  configuration: unknown,
): string {
  if (!isPocketDeckConfiguration(configuration)) {
    throw new Error(
      "The current configuration contains unsupported or invalid fields and cannot be exported.",
    );
  }

  try {
    const serialized = JSON.stringify(configuration, null, 2);
    if (serialized === undefined) {
      throw new Error("Serialization produced no JSON data.");
    }
    return serialized;
  } catch (error) {
    throw new Error(
      `Could not serialize the PocketDeck configuration: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export async function saveConfigurationExport(
  configuration: PocketDeckConfiguration,
): Promise<boolean> {
  const contents = serializeConfigurationForExport(configuration);
  try {
    return await invoke<boolean>("save_configuration_export", { contents });
  } catch (error) {
    throw new Error(
      `Could not save the PocketDeck configuration: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
