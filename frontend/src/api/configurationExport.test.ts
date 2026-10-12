import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  saveConfigurationExport,
  serializeConfigurationForExport,
} from "./configurationExport";
import type { PocketDeckConfiguration } from "./configuration";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const fullConfiguration: PocketDeckConfiguration = {
  schema_version: 1,
  profiles: [
    {
      id: "profile-main",
      name: "Main",
      pages: [
        {
          id: "page-main",
          name: "Main page",
          grid: { columns: 2, rows: 1 },
          buttons: [
            {
              id: "button-command",
              label: "Run command",
              action_id: "action-command",
            },
            {
              id: "button-unassigned",
              label: "Empty",
              action_id: null,
            },
          ],
        },
      ],
    },
  ],
  actions: [
    {
      id: "action-command",
      type: "run_command",
      enabled_for_execution: true,
      parameters: { command_id: "command-build" },
    },
  ],
  commands: [
    {
      id: "command-build",
      definition_version: 1,
      name: "Build",
      description: "Build the project.",
      category: "Development",
      enabled: true,
      steps: [{ type: "wait", parameters: { milliseconds: 250 } }],
    },
  ],
  shortcuts: [{ id: "shortcut-save", name: "Save", shortcut: "CTRL+S" }],
  settings: { confirm_commands: true },
};

afterEach(() => {
  vi.mocked(invoke).mockReset();
  vi.restoreAllMocks();
});

describe("configuration export", () => {
  it("serializes the complete v1 configuration without dropping supported fields", () => {
    const serialized = serializeConfigurationForExport(fullConfiguration);

    expect(JSON.parse(serialized)).toEqual(fullConfiguration);
    expect(serialized).toContain('"schema_version": 1');
  });

  it("rejects unsupported fields instead of silently omitting them", () => {
    expect(() =>
      serializeConfigurationForExport({
        ...fullConfiguration,
        credentials: { admin_token: "must-not-be-exported" },
      }),
    ).toThrow(/unsupported or invalid fields/);
  });

  it("reports serialization errors", () => {
    const stringify = vi
      .spyOn(JSON, "stringify")
      .mockImplementation(() => {
        throw new Error("serialization failed");
      });

    expect(() => serializeConfigurationForExport(fullConfiguration)).toThrow(
      "Could not serialize the PocketDeck configuration: serialization failed",
    );
    stringify.mockRestore();
  });

  it("passes the serialized validated configuration to the native save dialog", async () => {
    vi.mocked(invoke).mockResolvedValue(true);

    await expect(saveConfigurationExport(fullConfiguration)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith("save_configuration_export", {
      contents: JSON.stringify(fullConfiguration, null, 2),
    });
  });

  it("preserves save-dialog cancellation without reporting a save", async () => {
    vi.mocked(invoke).mockResolvedValue(false);

    await expect(saveConfigurationExport(fullConfiguration)).resolves.toBe(false);
  });

  it("surfaces native dialog and filesystem errors", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("Access is denied."));

    await expect(saveConfigurationExport(fullConfiguration)).rejects.toThrow(
      "Could not save the PocketDeck configuration: Access is denied.",
    );
  });
});
