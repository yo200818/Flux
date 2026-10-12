import { describe, expect, it } from "vitest";
import type { PocketDeckConfiguration } from "./configuration";
import {
  commandActionId,
  shortcutActionId,
  withSavedCommand,
  withSavedShortcut,
} from "./configurationEdits";

function makeConfiguration(): PocketDeckConfiguration {
  return {
    schema_version: 1,
    profiles: [
      {
        id: "profile",
        name: "Profile",
        pages: [
          {
            id: "page",
            name: "Page",
            grid: { columns: 1, rows: 1 },
            buttons: [{ id: "button", label: "Button", action_id: "run-stable" }],
          },
        ],
      },
    ],
    actions: [
      {
        id: "run-stable",
        type: "run_command",
        enabled_for_execution: true,
        parameters: { command_id: "command-stable" },
      },
      {
        id: "shortcut-action-stable",
        type: "keyboard_shortcut",
        enabled_for_execution: true,
        parameters: { shortcut_id: "shortcut-stable" },
      },
    ],
    commands: [
      {
        id: "command-stable",
        definition_version: 1,
        name: "First",
        category: "Tests",
        enabled: true,
        steps: [{ type: "wait", parameters: { milliseconds: 10 } }],
      },
    ],
    shortcuts: [
      { id: "shortcut-stable", name: "First", shortcut: "CTRL+A" },
    ],
    settings: { confirm_commands: false },
  };
}

describe("configuration definition edits", () => {
  it("updates command definitions without changing their assigned action IDs", () => {
    const configuration = makeConfiguration();
    const updated = withSavedCommand(configuration, {
      ...configuration.commands[0],
      name: "Updated",
      enabled: false,
    });

    expect(commandActionId("command-stable", updated)).toBe("run-stable");
    expect(updated.profiles[0].pages[0].buttons[0].action_id).toBe("run-stable");
    expect(updated.actions[0].enabled_for_execution).toBe(false);
  });

  it("updates a saved shortcut without changing button or command references", () => {
    const configuration = makeConfiguration();
    configuration.actions.push({
      id: "command-action",
      type: "run_command",
      enabled_for_execution: true,
      parameters: { command_id: "uses-shortcut" },
    });
    configuration.commands.push({
      id: "uses-shortcut",
      definition_version: 1,
      name: "Uses shortcut",
      category: "Tests",
      enabled: true,
      steps: [
        { type: "keyboard_shortcut", parameters: { shortcut_id: "shortcut-stable" } },
      ],
    });
    const updated = withSavedShortcut(configuration, {
      id: "shortcut-stable",
      name: "Updated",
      shortcut: "CTRL+SHIFT+A",
    });

    expect(shortcutActionId("shortcut-stable", updated)).toBe(
      "shortcut-action-stable",
    );
    expect(updated.actions[1].parameters).toEqual({
      shortcut_id: "shortcut-stable",
    });
    expect(updated.commands[1].steps[0].parameters).toEqual({
      shortcut_id: "shortcut-stable",
    });
    expect(updated.shortcuts[0].shortcut).toBe("CTRL+SHIFT+A");
  });
});
