import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveConfigurationExport } from "../api/configurationExport";
import type { PocketDeckConfiguration } from "../api/configuration";
import type { ConfigurationState } from "../hooks/useConfiguration";
import { ConfigurationStudio } from "./ConfigurationStudio";

vi.mock("../api/configurationExport", () => ({
  saveConfigurationExport: vi.fn(),
}));

afterEach(cleanup);

function makeConfiguration(): PocketDeckConfiguration {
  return {
    schema_version: 1,
    profiles: [
      {
        id: "profile-main",
        name: "Main",
        pages: [
          {
            id: "page-main",
            name: "Page 1",
            grid: { columns: 2, rows: 1 },
            buttons: [],
          },
        ],
      },
    ],
    actions: [],
    commands: [],
    shortcuts: [],
    settings: { confirm_commands: false },
  };
}

function loadedState(configuration = makeConfiguration()): ConfigurationState {
  return {
    status: "loaded",
    revision: 1,
    configuration,
  };
}

describe("ConfigurationStudio commands", () => {
  it("creates a saved command definition and an executable action reference", async () => {
    const saveConfiguration = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfigurationStudio
        section="actions"
        state={loadedState()}
        saveConfiguration={saveConfiguration}
        onDirtyChange={vi.fn()}
        adminDeviceAccess={false}
        backendConnected={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New command" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Open notes" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Open the shared notes page." },
    });
    fireEvent.change(screen.getByLabelText("HTTP or HTTPS URL"), {
      target: { value: "https://example.com/notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.change(screen.getAllByLabelText("Action")[1], {
      target: { value: "wait" },
    });
    fireEvent.change(
      screen.getByLabelText("Wait (milliseconds, max 10,000)"),
      { target: { value: "250" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save command" }));

    await waitFor(() => expect(saveConfiguration).toHaveBeenCalledOnce());
    const saved = saveConfiguration.mock.calls[0][0];
    expect(saved.commands).toHaveLength(1);
    expect(saved.commands[0]).toMatchObject({
      name: "Open notes",
      description: "Open the shared notes page.",
      category: "General",
      enabled: true,
      steps: [
        {
          type: "open_url",
          parameters: { url: "https://example.com/notes" },
        },
        { type: "wait", parameters: { milliseconds: 250 } },
      ],
    });
    expect(saved.actions).toHaveLength(1);
    expect(saved.actions[0]).toMatchObject({
      type: "run_command",
      enabled_for_execution: true,
      parameters: { command_id: saved.commands[0].id },
    });
  });

  it("duplicates saved commands without reusing their stable IDs", async () => {
    const configuration = makeConfiguration();
    configuration.commands = [
      {
        id: "command-original",
        definition_version: 1,
        name: "Original",
        category: "Work",
        enabled: true,
        steps: [{ type: "wait", parameters: { milliseconds: 300 } }],
      },
    ];
    configuration.actions = [
      {
        id: "action-original",
        type: "run_command",
        enabled_for_execution: true,
        parameters: { command_id: "command-original" },
      },
    ];
    const saveConfiguration = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfigurationStudio
        section="actions"
        state={loadedState(configuration)}
        saveConfiguration={saveConfiguration}
        onDirtyChange={vi.fn()}
        adminDeviceAccess={false}
        backendConnected={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Save command" }));

    await waitFor(() => expect(saveConfiguration).toHaveBeenCalledOnce());
    const saved = saveConfiguration.mock.calls[0][0];
    expect(saved.commands).toHaveLength(2);
    expect(saved.commands[1].id).not.toBe("command-original");
    expect(saved.actions[1].parameters).toEqual({
      command_id: saved.commands[1].id,
    });
  });

    it("preserves a command ID when its name and description change", async () => {
      const configuration = makeConfiguration();
      configuration.commands = [
        {
          id: "command-stable",
          definition_version: 1,
          name: "Before",
          description: "Old description",
          category: "Work",
          enabled: true,
          steps: [{ type: "wait", parameters: { milliseconds: 300 } }],
        },
      ];
      configuration.actions = [
        {
          id: "action-stable",
          type: "run_command",
          enabled_for_execution: true,
          parameters: { command_id: "command-stable" },
        },
      ];
      const saveConfiguration = vi.fn().mockResolvedValue(undefined);
      render(
        <ConfigurationStudio
          section="actions"
          state={loadedState(configuration)}
          saveConfiguration={saveConfiguration}
          onDirtyChange={vi.fn()}
          adminDeviceAccess={false}
          backendConnected={false}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
      fireEvent.change(screen.getByLabelText("Name"), {
        target: { value: "After" },
      });
      fireEvent.change(screen.getByLabelText("Description"), {
        target: { value: "New description" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save command" }));

      await waitFor(() => expect(saveConfiguration).toHaveBeenCalledOnce());
      const saved = saveConfiguration.mock.calls[0][0];
      expect(saved.commands[0]).toMatchObject({
        id: "command-stable",
        name: "After",
        description: "New description",
      });
      expect(saved.actions[0].parameters).toEqual({
        command_id: "command-stable",
      });
    });

    it("refuses to delete a command while its action is assigned to a button", async () => {
      const configuration = makeConfiguration();
      configuration.commands = [
        {
          id: "command-assigned",
          definition_version: 1,
          name: "Assigned",
          category: "Work",
          enabled: true,
          steps: [{ type: "wait", parameters: { milliseconds: 300 } }],
        },
      ];
      configuration.actions = [
        {
          id: "action-assigned",
          type: "run_command",
          enabled_for_execution: true,
          parameters: { command_id: "command-assigned" },
        },
      ];
      configuration.profiles[0].pages[0].buttons = [
        {
          id: "button-assigned",
          label: "Assigned command",
          action_id: "action-assigned",
        },
      ];
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const saveConfiguration = vi.fn().mockResolvedValue(undefined);
      render(
        <ConfigurationStudio
          section="actions"
          state={loadedState(configuration)}
          saveConfiguration={saveConfiguration}
          onDirtyChange={vi.fn()}
          adminDeviceAccess={false}
          backendConnected={false}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Delete" }));

      expect(
        await screen.findByText(
          "Unassign this command from every button before deleting it.",
        ),
      ).toBeInTheDocument();
      expect(saveConfiguration).not.toHaveBeenCalled();
    });
});

describe("ConfigurationStudio shortcuts, profiles, and pages", () => {
  it("captures and saves a reusable supported key chord", async () => {
    const saveConfiguration = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfigurationStudio
        section="shortcuts"
        state={loadedState()}
        saveConfiguration={saveConfiguration}
        onDirtyChange={vi.fn()}
        adminDeviceAccess={false}
        backendConnected={false}
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Review" },
    });

    const capture = screen.getByRole("textbox", {
      name: "Keyboard shortcut capture",
    });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { key: "r", ctrlKey: true, shiftKey: true });
    expect(capture).toHaveTextContent("Ctrl + Shift + R");
    fireEvent.click(
      within(capture.parentElement!).getByRole("button", {
        name: "Save shortcut",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add shortcut" }));

    await waitFor(() => expect(saveConfiguration).toHaveBeenCalledOnce());
    const saved = saveConfiguration.mock.calls[0][0];
    expect(saved.shortcuts[0]).toMatchObject({
      name: "Review",
      shortcut: "CTRL+SHIFT+R",
    });
    expect(saved.actions[0]).toMatchObject({
      type: "keyboard_shortcut",
      enabled_for_execution: true,
      parameters: { shortcut_id: saved.shortcuts[0].id },
    });
  });

  it("edits a saved shortcut without changing its stable ID or references", async () => {
    const configuration = makeConfiguration();
    configuration.shortcuts = [
      {
        id: "shortcut-stable",
        name: "Review",
        shortcut: "CTRL+R",
      },
    ];
    configuration.commands = [
      {
        id: "command-shortcut-reference",
        definition_version: 1,
        name: "Review workflow",
        category: "Work",
        enabled: true,
        steps: [
          {
            type: "keyboard_shortcut",
            parameters: { shortcut_id: "shortcut-stable" },
          },
        ],
      },
    ];
    configuration.actions = [
      {
        id: "shortcut-action",
        type: "keyboard_shortcut",
        enabled_for_execution: true,
        parameters: { shortcut_id: "shortcut-stable" },
      },
      {
        id: "command-action",
        type: "run_command",
        enabled_for_execution: true,
        parameters: { command_id: "command-shortcut-reference" },
      },
    ];
    const saveConfiguration = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfigurationStudio
        section="shortcuts"
        state={loadedState(configuration)}
        saveConfiguration={saveConfiguration}
        onDirtyChange={vi.fn()}
        adminDeviceAccess={false}
        backendConnected={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Review selection" },
    });
    const capture = screen.getByRole("textbox", {
      name: "Keyboard shortcut capture",
    });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, { key: "F2", altKey: true });
    fireEvent.click(
      within(capture.parentElement!).getByRole("button", {
        name: "Save shortcut",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save shortcut" }));

    await waitFor(() => expect(saveConfiguration).toHaveBeenCalledOnce());
    const saved = saveConfiguration.mock.calls[0][0];
    expect(saved.shortcuts[0]).toEqual({
      id: "shortcut-stable",
      name: "Review selection",
      shortcut: "ALT+F2",
    });
    expect(saved.actions[0].parameters).toEqual({
      shortcut_id: "shortcut-stable",
    });
    expect(saved.commands[0].steps[0].parameters).toEqual({
      shortcut_id: "shortcut-stable",
    });
  });

  it("duplicates pages with fresh page and button IDs while preserving assignments", async () => {
    const configuration = makeConfiguration();
    configuration.actions = [
      {
        id: "open-action",
        type: "open_url",
        enabled_for_execution: true,
        parameters: { url: "https://example.com/" },
      },
    ];
    configuration.profiles[0].pages[0].buttons = [
      {
        id: "button-original",
        label: "Example",
        action_id: "open-action",
      },
    ];
    const saveConfiguration = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfigurationStudio
        section="profiles"
        state={loadedState(configuration)}
        saveConfiguration={saveConfiguration}
        onDirtyChange={vi.fn()}
        adminDeviceAccess={false}
        backendConnected={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Duplicate page" }));

    await waitFor(() => expect(saveConfiguration).toHaveBeenCalledOnce());
    const saved = saveConfiguration.mock.calls[0][0];
    const pages = saved.profiles[0].pages;
    expect(pages).toHaveLength(2);
    expect(pages[1].id).not.toBe("page-main");
    expect(pages[1].buttons[0]).toMatchObject({
      label: "Example",
      action_id: "open-action",
    });
    expect(pages[1].buttons[0].id).not.toBe("button-original");
  });

  it("preserves an unsaved profile name when persistence fails", async () => {
    const dirtyChange = vi.fn();
    const saveConfiguration = vi
      .fn()
      .mockRejectedValue(new Error("Configuration storage is unavailable."));
    render(
      <ConfigurationStudio
        section="profiles"
        state={loadedState()}
        saveConfiguration={saveConfiguration}
        onDirtyChange={dirtyChange}
        adminDeviceAccess={false}
        backendConnected={false}
      />,
    );

    const input = screen.getByPlaceholderText("Profile name");
    fireEvent.change(input, { target: { value: "Research" } });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));

    expect(
      await screen.findByText("Configuration storage is unavailable."),
    ).toBeInTheDocument();
    expect(input).toHaveValue("Research");
    await waitFor(() => expect(dirtyChange).toHaveBeenLastCalledWith(true));
  });

  it("keeps an unsaved command draft until the user cancels it", async () => {
    const dirtyChange = vi.fn();
    render(
      <ConfigurationStudio
        section="actions"
        state={loadedState()}
        saveConfiguration={vi.fn()}
        onDirtyChange={dirtyChange}
        adminDeviceAccess={false}
        backendConnected={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New command" }));
    await waitFor(() => expect(dirtyChange).toHaveBeenLastCalledWith(true));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dirtyChange).toHaveBeenLastCalledWith(false));
  });

  it("reports export success only after the native save completes", async () => {
    vi.mocked(saveConfigurationExport).mockResolvedValue(true);
    render(
      <ConfigurationStudio
        section="settings"
        state={loadedState()}
        saveConfiguration={vi.fn()}
        onDirtyChange={vi.fn()}
        adminDeviceAccess={false}
        backendConnected={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export configuration" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Configuration exported successfully.",
    );
    expect(saveConfigurationExport).toHaveBeenCalledWith(
      makeConfiguration(),
    );
  });

  it("reports a canceled export without claiming it was saved", async () => {
    vi.mocked(saveConfigurationExport).mockResolvedValue(false);
    render(
      <ConfigurationStudio
        section="settings"
        state={loadedState()}
        saveConfiguration={vi.fn()}
        onDirtyChange={vi.fn()}
        adminDeviceAccess={false}
        backendConnected={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export configuration" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Configuration export canceled.",
    );
    expect(screen.queryByText("Configuration exported successfully.")).toBeNull();
  });

  it("reports save failures without claiming the configuration was exported", async () => {
    vi.mocked(saveConfigurationExport).mockRejectedValue(
      new Error("Access is denied."),
    );
    render(
      <ConfigurationStudio
        section="settings"
        state={loadedState()}
        saveConfiguration={vi.fn()}
        onDirtyChange={vi.fn()}
        adminDeviceAccess={false}
        backendConnected={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Export configuration" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Access is denied.",
    );
    expect(screen.queryByText("Configuration exported successfully.")).toBeNull();
  });
});
