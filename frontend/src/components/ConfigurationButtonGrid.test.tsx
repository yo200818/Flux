import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "../api/actions";
import { getSystemMetrics } from "../api/systemMetrics";
import {
  ConfigurationRevisionConflictError,
  type ConfigurationSnapshot,
  type PocketDeckConfiguration,
} from "../api/configuration";
import type { ConfigurationState } from "../hooks/useConfiguration";
import { ConfigurationButtonGrid } from "./ConfigurationButtonGrid";

vi.mock("../api/actions", () => ({
  executeAction: vi.fn(),
}));

vi.mock("../api/systemMetrics", () => ({
  getSystemMetrics: vi.fn(),
}));

const executeActionMock = vi.mocked(executeAction);
const getSystemMetricsMock = vi.mocked(getSystemMetrics);

function makeConfiguration(
  buttons: { id: string; label: string; action_id: string | null }[] = [],
): PocketDeckConfiguration {
  return {
    schema_version: 1 as const,
    commands: [],
    shortcuts: [],
    settings: { confirm_commands: false },
    profiles: [
      {
        id: "default",
        name: "Default",
        pages: [
          {
            id: "main",
            name: "Main",
            grid: { columns: 2, rows: 1 },
            buttons,
          },
        ],
      },
    ],
    actions: [
      {
        id: "open-site",
        type: "open_url" as const,
        enabled_for_execution: true,
        parameters: { url: "https://example.com/" },
      },
      {
        id: "copy",
        type: "keyboard_shortcut" as const,
        enabled_for_execution: false,
        parameters: { shortcut: "copy" },
      },
      {
        id: "open-docs",
        type: "open_url" as const,
        enabled_for_execution: true,
        parameters: { url: "https://docs.example.com/" },
      },
    ],
  };
}

function makeSnapshot(
  buttons: Parameters<typeof makeConfiguration>[0] = [],
): ConfigurationSnapshot {
  return { revision: 4, configuration: makeConfiguration(buttons) };
}

function makeNavigationSnapshot(): ConfigurationSnapshot {
  const configuration: PocketDeckConfiguration = makeConfiguration();
  configuration.profiles[0].pages[0].buttons = [
    { id: "main-button", label: "Main action", action_id: "open-site" },
  ];
  configuration.profiles[0].pages.push({
    id: "secondary",
    name: "Secondary",
    grid: { columns: 2, rows: 1 },
    buttons: [
      { id: "secondary-button", label: "Secondary action", action_id: "open-site" },
    ],
  });
  configuration.profiles.push({
    id: "work",
    name: "Work",
    pages: [
      {
        id: "overview",
        name: "Overview",
        grid: { columns: 2, rows: 1 },
        buttons: [
          { id: "overview-button", label: "Overview action", action_id: "open-docs" },
        ],
      },
      {
        id: "details",
        name: "Details",
        grid: { columns: 2, rows: 1 },
        buttons: [
          { id: "details-button", label: "Details action", action_id: "open-site" },
        ],
      },
    ],
  });
  return { revision: 4, configuration };
}

function renderGrid(
  state: ConfigurationState = { status: "loaded", ...makeSnapshot() },
  retry = vi.fn(),
  saveConfiguration = vi.fn().mockResolvedValue(undefined),
) {
  return render(
    <ConfigurationButtonGrid
      state={state}
      retry={retry}
      saveConfiguration={saveConfiguration}
    />,
  );
}

function EditorHarness({
  initialButtons = [],
  initialSnapshot,
  onSave = vi.fn().mockResolvedValue(undefined),
}: {
  initialButtons?: Parameters<typeof makeConfiguration>[0];
  initialSnapshot?: ConfigurationSnapshot;
  onSave?: (configuration: PocketDeckConfiguration) => Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState(
    () => initialSnapshot ?? makeSnapshot(initialButtons),
  );
  const saveConfiguration = async (
    configuration: PocketDeckConfiguration,
  ) => {
    try {
      await onSave(configuration);
    } catch (error) {
      if (
        error instanceof ConfigurationRevisionConflictError &&
        error.latestSnapshot
      ) {
        setSnapshot(error.latestSnapshot);
      }
      throw error;
    }
    setSnapshot((current) => ({
      revision: current.revision + 1,
      configuration,
    }));
  };
  return (
    <ConfigurationButtonGrid
      state={{ status: "loaded", ...snapshot }}
      retry={vi.fn()}
      saveConfiguration={saveConfiguration}
    />
  );
}

describe("ConfigurationButtonGrid", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    });
    localStorage.clear();
    executeActionMock.mockReset();
    getSystemMetricsMock.mockReset();
  });

  it("renders configured buttons, action types, and revision", () => {
    renderGrid({
      status: "loaded",
      ...makeSnapshot([
        { id: "site-button", label: "Open Website", action_id: "open-site" },
        { id: "copy-button", label: "Keyboard Shortcut", action_id: "copy" },
      ]),
    });

    const websiteButton = screen.getByRole("button", { name: /^Open Website/i });
    expect(websiteButton).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /^Keyboard Shortcut/i }),
    ).toBeDisabled();
    expect(screen.getByText("This action is not enabled for execution.")).toBeInTheDocument();
    expect(screen.getByText("Website · example.com")).toBeInTheDocument();
    expect(screen.getByText("Copy")).toBeInTheDocument();
    expect(screen.getByText("Configuration revision 4")).toBeInTheDocument();
    expect(websiteButton.closest(".button-grid")).toHaveStyle(
      "grid-template-columns: repeat(2, minmax(0, 1fr))",
    );
  });

  it("renders live system monitors as read-only widgets and cleans up polling", async () => {
    const configuration = makeConfiguration([
      { id: "ram-widget", label: "RAM", action_id: "memory-monitor" },
    ]);
    configuration.actions.push({
      id: "memory-monitor",
      type: "system_monitor",
      enabled_for_execution: false,
      parameters: { metric: "memory_usage" },
    });
    getSystemMetricsMock.mockResolvedValue({
      cpu_status: "sampling",
      cpu_usage_percent: null,
      memory_used_bytes: 4 * 1024 ** 3,
      memory_total_bytes: 8 * 1024 ** 3,
      unavailable_metrics: {
        gpu_utilization: "No supported provider.",
        gpu_temperature: "No supported provider.",
        cpu_temperature: "No supported provider.",
      },
    });
    const { unmount } = renderGrid({
      status: "loaded",
      revision: 4,
      configuration,
    });

    const widget = await screen.findByRole("group", {
      name: "RAM system monitor",
    });
    expect(widget).toHaveTextContent("50.0%");
    expect(widget).toHaveTextContent("4.0 GiB used of 8.0 GiB.");
    expect(getSystemMetricsMock).toHaveBeenCalledTimes(1);
    expect(executeActionMock).not.toHaveBeenCalled();
    const signal = getSystemMetricsMock.mock.calls[0]?.[0];
    expect(signal).toBeInstanceOf(AbortSignal);

    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("refreshes a CPU monitor on the sequential polling interval", async () => {
    vi.useFakeTimers();
    const configuration = makeConfiguration([
      { id: "cpu-widget", label: "CPU", action_id: "cpu-monitor" },
    ]);
    configuration.actions.push({
      id: "cpu-monitor",
      type: "system_monitor",
      enabled_for_execution: false,
      parameters: { metric: "cpu_utilization" },
    });
    getSystemMetricsMock
      .mockResolvedValueOnce({
        cpu_status: "available",
        cpu_usage_percent: 12.3,
        memory_used_bytes: null,
        memory_total_bytes: null,
        unavailable_metrics: {},
      })
      .mockResolvedValueOnce({
        cpu_status: "available",
        cpu_usage_percent: 42,
        memory_used_bytes: null,
        memory_total_bytes: null,
        unavailable_metrics: {},
      });

    const { unmount } = renderGrid({
      status: "loaded",
      revision: 4,
      configuration,
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const widget = screen.getByRole("group", { name: "CPU system monitor" });
    expect(widget).toHaveTextContent("12.3%");

    await act(async () => {
      vi.advanceTimersByTime(2500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(widget).toHaveTextContent("42.0%");
    expect(getSystemMetricsMock).toHaveBeenCalledTimes(2);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows configuration loading state", () => {
    renderGrid({ status: "loading" });

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading your configuration",
    );
  });

  it("displays backend action success and failure results", async () => {
    renderGrid({
      status: "loaded",
      ...makeSnapshot([
        { id: "site-button", label: "Open Website", action_id: "open-site" },
      ]),
    });
    executeActionMock.mockResolvedValueOnce({
      action_id: "open-site",
      success: true,
      message: "Opened the URL in the default browser.",
    });

    fireEvent.click(screen.getByRole("button", { name: /^Open Website/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Opened the URL in the default browser.",
    );

    executeActionMock.mockResolvedValueOnce({
      action_id: "open-site",
      success: false,
      message: "The operating system could not open the URL in a browser.",
    });
    fireEvent.click(screen.getByRole("button", { name: /^Open Website/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The operating system could not open the URL in a browser.",
    );
  });

  it("displays network errors without crashing the grid", async () => {
    renderGrid({
      status: "loaded",
      ...makeSnapshot([
        { id: "site-button", label: "Open Website", action_id: "open-site" },
      ]),
    });
    executeActionMock.mockRejectedValue(
      new Error("The action service is unavailable."),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Open Website/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The action service is unavailable.",
    );
    expect(screen.getByText("Website · example.com")).toBeInTheDocument();
  });

  it("prevents repeated clicks while the same action is executing", async () => {
    renderGrid({
      status: "loaded",
      ...makeSnapshot([
        { id: "site-button", label: "Open Website", action_id: "open-site" },
      ]),
    });
    let resolveExecution!: (result: {
      action_id: string;
      success: boolean;
      message: string;
    }) => void;
    executeActionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveExecution = resolve;
        }),
    );

    const button = screen.getByRole("button", { name: /^Open Website/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();

    resolveExecution({
      action_id: "open-site",
      success: true,
      message: "Opened the URL in the default browser.",
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Opened the URL in the default browser.",
    );
  });

  it("shows empty and error states and retries configuration", () => {
    renderGrid({
      status: "loaded",
      ...makeSnapshot(),
    });
    expect(screen.getByText("This page is empty")).toBeInTheDocument();
    cleanup();

    const retry = vi.fn();
    renderGrid(
      { status: "error", message: "Configuration service unavailable." },
      retry,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Configuration service unavailable.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry configuration" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("shows a failed real-time refresh while preserving loaded content", () => {
    const { rerender } = renderGrid(
      { status: "loaded", ...makeSnapshot() },
      vi.fn(),
    );
    rerender(
      <ConfigurationButtonGrid
        state={{ status: "loaded", ...makeSnapshot() }}
        retry={vi.fn()}
        saveConfiguration={vi.fn().mockResolvedValue(undefined)}
        refreshError="Configuration request failed (503)."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Configuration request failed (503).",
    );
    expect(screen.getByText("This page is empty")).toBeInTheDocument();
  });

  it("switches profiles and pages without saving and remembers each profile page", () => {
    const saveConfiguration = vi.fn().mockResolvedValue(undefined);
    const snapshot = makeNavigationSnapshot();
    const originalConfiguration = structuredClone(snapshot.configuration);
    renderGrid(
      { status: "loaded", ...snapshot },
      vi.fn(),
      saveConfiguration,
    );

    expect(screen.getByRole("button", { name: /^Main action/i })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), {
      target: { value: "work" },
    });
    expect(screen.getByRole("button", { name: /^Overview action/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Main action/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByRole("button", { name: /^Details action/i })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), {
      target: { value: "default" },
    });
    expect(screen.getByRole("button", { name: /^Main action/i })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), {
      target: { value: "work" },
    });
    expect(screen.getByRole("button", { name: /^Details action/i })).toBeInTheDocument();
    expect(screen.getByText("Configuration revision 4")).toBeInTheDocument();
    expect(saveConfiguration).not.toHaveBeenCalled();
    expect(snapshot.configuration).toEqual(originalConfiguration);
  });

  it("creates and deletes buttons on the selected non-default page", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditorHarness
        initialSnapshot={makeNavigationSnapshot()}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Secondary" }));
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    fireEvent.change(screen.getByLabelText("Button label"), {
      target: { value: "Extra secondary" },
    });
    fireEvent.click(
      within(screen.getByRole("form", { name: "Add button" })).getByRole(
        "button",
        { name: "Add button" },
      ),
    );
    expect(await screen.findByText("Button added.", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Extra secondary/i })).toBeInTheDocument();
    expect(onSave.mock.calls[0][0].profiles[0].pages[1].buttons).toHaveLength(2);
    expect(onSave.mock.calls[0][0].profiles[0].pages[0].buttons).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Secondary action" }),
    );
    expect(await screen.findByText("Button deleted.", { exact: true })).toBeInTheDocument();
    expect(onSave.mock.calls[1][0].profiles[0].pages[1].buttons).toEqual([
      expect.objectContaining({ label: "Extra secondary" }),
    ]);
    expect(onSave.mock.calls[1][0].profiles[0].pages[0].buttons[0].label).toBe(
      "Main action",
    );
  });

  it("edits buttons on a non-default page without changing other pages", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditorHarness
        initialSnapshot={makeNavigationSnapshot()}
        onSave={onSave}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Secondary" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Edit Secondary action" }),
    );
    const form = screen.getByRole("form", { name: "Edit button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Updated secondary" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save button" }));

    expect(await screen.findByText("Button saved.", { exact: true })).toBeInTheDocument();
    const saved = onSave.mock.calls[0][0];
    expect(saved.profiles[0].pages[0].buttons[0].label).toBe("Main action");
    expect(saved.profiles[0].pages[1].buttons[0]).toEqual({
      id: "secondary-button",
      label: "Updated secondary",
      action_id: "open-site",
    });
  });

  it("protects an open draft when navigating pages or profiles", () => {
    render(
      <EditorHarness initialSnapshot={makeNavigationSnapshot()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    fireEvent.change(screen.getByLabelText("Button label"), {
      target: { value: "Uncommitted draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Secondary" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "You have an open button draft. Discard it and switch views?",
    );
    expect(screen.getByLabelText("Button label")).toHaveValue("Uncommitted draft");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Button label")).toHaveValue("Uncommitted draft");

    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), {
      target: { value: "work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and switch" }));
    expect(screen.getByRole("button", { name: /^Overview action/i })).toBeInTheDocument();
    expect(screen.queryByLabelText("Button label")).not.toBeInTheDocument();
  });

  it("handles configurations with no profiles or pages without crashing", () => {
    const emptyProfiles = makeNavigationSnapshot();
    emptyProfiles.configuration.profiles = [];
    const { rerender } = renderGrid({
      status: "loaded",
      ...emptyProfiles,
    });
    expect(screen.getByText("No profiles are configured.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add button" })).toBeDisabled();

    const emptyPages = makeNavigationSnapshot();
    emptyPages.configuration.profiles[0].pages = [];
    rerender(
      <ConfigurationButtonGrid
        state={{ status: "loaded", ...emptyPages }}
        retry={vi.fn()}
        saveConfiguration={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByText("This profile has no pages.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add button" })).toBeDisabled();
    expect(screen.getByText("No pages configured")).toBeInTheDocument();
  });

  it("creates a button, saves its registered action, and updates the grid", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditorHarness onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Open docs" },
    });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "open_url" },
    });
    fireEvent.change(within(form).getByLabelText("Saved website"), {
      target: { value: "open-docs" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));

    expect(await screen.findByText("Button added.", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Open docs/i })).toBeInTheDocument();
    expect(screen.getByText("Configuration revision 5")).toBeInTheDocument();
    const savedConfiguration = onSave.mock.calls[0][0];
    expect(savedConfiguration.profiles[0].pages[0].buttons).toContainEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^button-/),
        label: "Open docs",
        action_id: "open-docs",
      }),
    );
  });

  it("creates a website inline while keeping the independent button label", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditorHarness onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Team portal" },
    });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "open_url" },
    });
    fireEvent.change(within(form).getByLabelText("Website name"), {
      target: { value: "Internal knowledge base" },
    });
    fireEvent.change(within(form).getByLabelText("Website URL"), {
      target: { value: "https://kb.example.org/start" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));

    expect(await screen.findByText("Button added.", { exact: true })).toBeInTheDocument();
    const saved = onSave.mock.calls[0][0];
    const createdWebsite = saved.actions.find(
      (action: { type: string; parameters: { name?: string } }) =>
        action.type === "open_url" &&
        action.parameters.name === "Internal knowledge base",
    );
    expect(createdWebsite).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^website-/),
        type: "open_url",
        enabled_for_execution: true,
        parameters: {
          url: "https://kb.example.org/start",
          name: "Internal knowledge base",
        },
      }),
    );
    expect(saved.profiles[0].pages[0].buttons.at(-1)).toEqual(
      expect.objectContaining({
        label: "Team portal",
        action_id: createdWebsite.id,
      }),
    );
  });

  it("reports an invalid inline website URL without losing the button draft", async () => {
    render(<EditorHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Draft label" },
    });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "open_url" },
    });
    fireEvent.change(within(form).getByLabelText("Website name"), {
      target: { value: "Bad destination" },
    });
    fireEvent.change(within(form).getByLabelText("Website URL"), {
      target: { value: "javascript:alert(1)" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a valid HTTP or HTTPS website URL.",
    );
    expect(within(form).getByLabelText("Button label")).toHaveValue("Draft label");
    expect(within(form).getByLabelText("Website URL")).toHaveValue(
      "javascript:alert(1)",
    );
  });

  it("edits the selected website inline without changing its stable action ID", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditorHarness
        initialButtons={[
          { id: "site-button", label: "Original button", action_id: "open-site" },
        ]}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Original button" }));
    const form = screen.getByRole("form", { name: "Edit button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "My own label" },
    });
    fireEvent.change(within(form).getByLabelText("Website name"), {
      target: { value: "Product home" },
    });
    fireEvent.change(within(form).getByLabelText("Website URL"), {
      target: { value: "https://product.example.net/docs" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save button" }));

    expect(await screen.findByText("Button saved.", { exact: true })).toBeInTheDocument();
    const saved = onSave.mock.calls[0][0];
    expect(saved.actions.find((action: { id: string }) => action.id === "open-site")).toEqual(
      expect.objectContaining({
        id: "open-site",
        parameters: {
          url: "https://product.example.net/docs",
          name: "Product home",
        },
      }),
    );
    expect(saved.profiles[0].pages[0].buttons[0]).toEqual({
      id: "site-button",
      label: "My own label",
      action_id: "open-site",
    });
  });

  it("creates an application action with a path containing spaces", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditorHarness onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Code" },
    });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "application" },
    });
    fireEvent.change(within(form).getByLabelText("Application name"), {
      target: { value: "Visual Studio Code" },
    });
    fireEvent.change(
      within(form).getByLabelText("Application executable path"),
      {
        target: {
          value: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
        },
      },
    );
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));

    expect(await screen.findByText("Button added.", { exact: true })).toBeInTheDocument();
    const saved = onSave.mock.calls[0][0];
    const application = saved.actions.find(
      (action: { type: string }) => action.type === "application",
    );
    expect(application).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^application-/),
        parameters: {
          name: "Visual Studio Code",
          path: "C:\\Program Files\\Microsoft VS Code\\Code.exe",
        },
      }),
    );
    expect(saved.profiles[0].pages[0].buttons.at(-1)).toMatchObject({
      label: "Code",
      icon: "application",
      action_id: application.id,
    });
  });

  it("rejects relative application paths and keeps the editor draft", async () => {
    render(<EditorHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Relative app" },
    });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "application" },
    });
    fireEvent.change(within(form).getByLabelText("Application name"), {
      target: { value: "Unsafe executable" },
    });
    fireEvent.change(
      within(form).getByLabelText("Application executable path"),
      { target: { value: "app.exe" } },
    );
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose an absolute Windows .exe path without arguments.",
    );
    expect(within(form).getByLabelText("Button label")).toHaveValue("Relative app");
    expect(
      within(form).getByLabelText("Application executable path"),
    ).toHaveValue("app.exe");
  });

  it("assigns a saved application and edits its executable without changing its ID", async () => {
    const configuration = makeConfiguration([
      { id: "app-button", label: "Editor button", action_id: "saved-editor" },
    ]);
    configuration.actions = [
      {
        id: "saved-editor",
        type: "application",
        enabled_for_execution: true,
        parameters: {
          name: "Code Editor",
          path: "C:\\Program Files\\Editor\\Editor.exe",
        },
      },
      {
        id: "saved-terminal",
        type: "application",
        enabled_for_execution: true,
        parameters: {
          name: "Terminal",
          path: "C:\\Windows\\System32\\WindowsTerminal.exe",
        },
      },
    ];
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditorHarness
        initialSnapshot={{ revision: 2, configuration }}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Editor button" }));
    const form = screen.getByRole("form", { name: "Edit button" });
    fireEvent.change(within(form).getByLabelText("Saved application"), {
      target: { value: "saved-terminal" },
    });
    expect(within(form).getByLabelText("Application name")).toHaveValue(
      "Terminal",
    );
    fireEvent.change(within(form).getByLabelText("Application executable path"), {
      target: { value: "D:\\Tools\\Updated Terminal\\Terminal.exe" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save button" }));

    expect(await screen.findByText("Button saved.", { exact: true })).toBeInTheDocument();
    const saved = onSave.mock.calls[0][0];
    expect(saved.actions).toContainEqual(
      expect.objectContaining({
        id: "saved-terminal",
        parameters: {
          name: "Terminal",
          path: "D:\\Tools\\Updated Terminal\\Terminal.exe",
        },
      }),
    );
    expect(saved.profiles[0].pages[0].buttons[0].action_id).toBe(
      "saved-terminal",
    );
  });

  it("creates an explicit system control action and displays its friendly label", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditorHarness onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Quiet" },
    });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "system_control" },
    });
    fireEvent.change(within(form).getByLabelText("System control"), {
      target: { value: "mute_toggle" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));

    expect(await screen.findByText("Button added.", { exact: true })).toBeInTheDocument();
    const saved = onSave.mock.calls[0][0];
    const action = saved.actions.find(
      (candidate: { type: string }) => candidate.type === "system_control",
    );
    expect(action).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^control-/),
        parameters: { control: "mute_toggle" },
      }),
    );
    expect(saved.profiles[0].pages[0].buttons.at(-1)).toMatchObject({
      label: "Quiet",
      icon: "volume",
      action_id: action.id,
    });
    expect(screen.getByText("Mute / unmute")).toBeInTheDocument();
  });

  it("creates a read-only system monitor and displays unsupported sensors honestly", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    getSystemMetricsMock.mockResolvedValue({
      cpu_status: "sampling",
      cpu_usage_percent: null,
      memory_used_bytes: null,
      memory_total_bytes: null,
      unavailable_metrics: {
        gpu_utilization: "GPU telemetry is unsupported.",
        gpu_temperature: "GPU temperature is unsupported.",
        cpu_temperature: "CPU temperature is unsupported.",
        memory_usage: "Memory telemetry is unavailable.",
      },
    });
    render(<EditorHarness onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "GPU" },
    });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "system_monitor" },
    });
    fireEvent.change(within(form).getByLabelText("System metric"), {
      target: { value: "gpu_utilization" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));

    expect(await screen.findByText("Button added.", { exact: true })).toBeInTheDocument();
    const saved = onSave.mock.calls[0][0];
    const monitor = saved.actions.find(
      (action: { type: string }) => action.type === "system_monitor",
    );
    expect(monitor).toMatchObject({
      enabled_for_execution: false,
      parameters: { metric: "gpu_utilization" },
    });
    const widget = screen.getByRole("group", { name: "GPU system monitor" });
    expect(widget).toHaveTextContent("Unavailable");
    expect(await screen.findByText("GPU telemetry is unsupported.")).toBeInTheDocument();
    expect(executeActionMock).not.toHaveBeenCalled();
  });

  it("edits a button label and reassigns it to an enabled action", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditorHarness
        initialButtons={[
          { id: "site-button", label: "Open Website", action_id: "open-site" },
        ]}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Open Website" }));
    const form = screen.getByRole("form", { name: "Edit button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Documentation" },
    });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "open_url" },
    });
    fireEvent.change(within(form).getByLabelText("Saved website"), {
      target: { value: "open-docs" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save button" }));

    expect(await screen.findByText("Button saved.", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Documentation/i })).toBeInTheDocument();
    expect(onSave.mock.calls[0][0].profiles[0].pages[0].buttons).toEqual([
      { id: "site-button", label: "Documentation", action_id: "open-docs" },
    ]);
  });

  it("offers all enabled supported actions and can assign a keyboard shortcut", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const snapshot = makeSnapshot();
    snapshot.configuration.actions[1].enabled_for_execution = true;
    render(<EditorHarness initialSnapshot={snapshot} onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "keyboard_shortcut" },
    });
    const actionSelect = within(form).getByLabelText("Assigned action");
    expect(within(actionSelect).getAllByRole("option")).toHaveLength(2);
    expect(
      within(actionSelect).getByRole("option", { name: "Copy" }),
    ).toBeInTheDocument();

    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Copy" },
    });
    fireEvent.change(actionSelect, { target: { value: "copy" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));

    expect(await screen.findByText("Button added.", { exact: true })).toBeInTheDocument();
    expect(onSave.mock.calls[0][0].profiles[0].pages[0].buttons).toContainEqual(
      expect.objectContaining({ label: "Copy", action_id: "copy" }),
    );
  });

  it("shows friendly, distinguishable action names while retaining stable IDs", async () => {
    const configuration = makeConfiguration();
    configuration.commands = [
      {
        id: "command-youtube",
        definition_version: 1,
        name: "Copy",
        description: "",
        category: "Media",
        enabled: true,
        steps: [{ type: "wait", parameters: { milliseconds: 100 } }],
      },
    ];
    configuration.shortcuts = [
      { id: "shortcut-copy", name: "Copy", shortcut: "CTRL+C" },
    ];
    configuration.actions = [
      {
        id: "internal-run-command-id",
        type: "run_command",
        enabled_for_execution: true,
        parameters: { command_id: "command-youtube" },
      },
      {
        id: "internal-shortcut-action-id",
        type: "keyboard_shortcut",
        enabled_for_execution: true,
        parameters: { shortcut_id: "shortcut-copy" },
      },
    ];
    configuration.profiles[0].pages[0].buttons = [
      {
        id: "assigned-command-button",
        label: "Assigned command",
        action_id: "internal-run-command-id",
      },
    ];
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditorHarness initialSnapshot={{ revision: 1, configuration }} onSave={onSave} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Edit Assigned command" }),
    );
    const form = screen.getByRole("form", { name: "Edit button" });
    const typeSelect = within(form).getByLabelText("Action type");
    const assignedAction = within(form).getByLabelText("Assigned action");
    expect(typeSelect).toHaveValue("run_command");
    const commandOption = within(assignedAction).getByRole("option", {
      name: "Copy · Media",
    });
    expect(commandOption).toHaveValue("internal-run-command-id");
    expect(commandOption).not.toHaveTextContent("internal-run-command-id");
    fireEvent.click(within(form).getByRole("button", { name: "Save button" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave.mock.calls[0][0].profiles[0].pages[0].buttons[0].action_id).toBe(
      "internal-run-command-id",
    );
    expect(screen.getByText("Copy", { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit Assigned command" }));
    const shortcutForm = screen.getByRole("form", { name: "Edit button" });
    fireEvent.change(within(shortcutForm).getByLabelText("Action type"), {
      target: { value: "keyboard_shortcut" },
    });
    const shortcutAction = within(shortcutForm).getByLabelText("Assigned action");
    const shortcutOption = within(shortcutAction).getByRole("option", {
      name: "Copy · Shortcut",
    });
    expect(shortcutOption).toHaveValue("internal-shortcut-action-id");
    expect(shortcutOption).not.toHaveTextContent("internal-shortcut-action-id");
    fireEvent.change(shortcutAction, {
      target: { value: "internal-shortcut-action-id" },
    });
    fireEvent.click(within(shortcutForm).getByRole("button", { name: "Save button" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1][0].profiles[0].pages[0].buttons[0].action_id).toBe(
      "internal-shortcut-action-id",
    );
  });

  it("creates and assigns a command inline without losing the button draft", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditorHarness onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Prepared command" },
    });
    fireEvent.change(within(form).getByLabelText("Button icon"), {
      target: { value: "star" },
    });
    fireEvent.change(within(form).getByLabelText("Button accent color"), {
      target: { value: "#00aaff" },
    });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "run_command" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Create command inline" }));

    const inline = within(form).getByRole("group", {
      name: "Create command inline",
    });
    fireEvent.change(within(inline).getByLabelText("Name"), {
      target: { value: "Harmless wait" },
    });
    fireEvent.change(within(inline).getByLabelText("Category"), {
      target: { value: "Tests" },
    });
    fireEvent.click(within(inline).getByRole("button", { name: "Save and assign" }));
    await waitFor(() =>
      expect(screen.getByText("Saved. Your button draft is still open.")).toBeInTheDocument(),
    );

    expect(screen.getByLabelText("Button label")).toHaveValue("Prepared command");
    expect(screen.getByLabelText("Button icon")).toHaveValue("star");
    expect(screen.getByLabelText("Button accent color")).toHaveValue("#00aaff");
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    const saved = onSave.mock.calls[1][0];
    expect(saved.commands).toContainEqual(
      expect.objectContaining({ name: "Harmless wait", category: "Tests" }),
    );
    expect(saved.profiles[0].pages[0].buttons[0]).toMatchObject({
      label: "Prepared command",
      icon: "star",
      color: "#00aaff",
      action_id: expect.stringMatching(/^run-/),
    });
  });

  it("records and assigns a new shortcut inline while preserving the button label", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<EditorHarness onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Use selection" },
    });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "keyboard_shortcut" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Record shortcut inline" }));
    const inline = within(form).getByRole("group", {
      name: "Create shortcut inline",
    });
    fireEvent.change(within(inline).getByLabelText("Name"), {
      target: { value: "Review selection" },
    });
    const capture = within(inline).getByRole("textbox", {
      name: "Keyboard shortcut capture",
    });
    fireEvent.click(capture);
    fireEvent.keyDown(capture, {
      key: "F24",
      code: "F24",
      ctrlKey: true,
      altKey: true,
    });
    expect(capture).toHaveTextContent("Ctrl + Alt + F24");
    fireEvent.click(
      within(capture.parentElement!).getByRole("button", {
        name: "Save shortcut",
      }),
    );
    fireEvent.click(within(inline).getByRole("button", { name: "Save and assign" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));

    const saved = onSave.mock.calls[1][0];
    expect(saved.shortcuts[0]).toEqual({
      id: expect.stringMatching(/^shortcut-/),
      name: "Review selection",
      shortcut: "CTRL+ALT+F24",
    });
    expect(saved.profiles[0].pages[0].buttons[0]).toMatchObject({
      label: "Use selection",
      action_id: expect.stringMatching(/^shortcut-action-/),
    });
  });

  it("keeps both inline item and button drafts when item save fails", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Storage is unavailable."));
    render(<EditorHarness onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Still here" },
    });
    fireEvent.change(within(form).getByLabelText("Action type"), {
      target: { value: "run_command" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Create command inline" }));
    const inline = within(form).getByRole("group", {
      name: "Create command inline",
    });
    fireEvent.change(within(inline).getByLabelText("Name"), {
      target: { value: "Unsaved command" },
    });
    fireEvent.click(within(inline).getByRole("button", { name: "Save and assign" }));

    expect(await within(inline).findByRole("alert")).toHaveTextContent(
      "Storage is unavailable.",
    );
    expect(within(form).getByLabelText("Button label")).toHaveValue("Still here");
    expect(within(inline).getByLabelText("Name")).toHaveValue("Unsaved command");
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("rejects duplicate button labels within the selected page", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditorHarness
        initialButtons={[
          { id: "existing", label: "Launch", action_id: "open-site" },
        ]}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: " launch " },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));

    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "Button labels must be unique on this page.",
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("dispatches an enabled keyboard shortcut button through the action API", async () => {
    const snapshot = makeSnapshot([
      { id: "copy-button", label: "Copy", action_id: "copy" },
    ]);
    snapshot.configuration.actions[1].enabled_for_execution = true;
    renderGrid({ status: "loaded", ...snapshot });
    executeActionMock.mockResolvedValueOnce({
      action_id: "copy",
      success: true,
      message: "Sent the copy shortcut to the active window.",
    });

    const button = screen.getByRole("button", { name: /^Copy/i });
    expect(button).toBeEnabled();
    fireEvent.click(button);

    expect(executeActionMock).toHaveBeenCalledWith("copy");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Sent the copy shortcut to the active window.",
    );
  });

  it("deletes a button and updates the current page immediately", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditorHarness
        initialButtons={[
          { id: "site-button", label: "Open Website", action_id: "open-site" },
        ]}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete Open Website" }));

    expect(
      await screen.findByText("Button deleted.", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByText("This page is empty")).toBeInTheDocument();
    expect(onSave.mock.calls[0][0].profiles[0].pages[0].buttons).toEqual([]);
  });

  it("rejects blank labels and does not offer invalid or disabled actions", () => {
    const saveConfiguration = vi.fn().mockResolvedValue(undefined);
    renderGrid(
      { status: "loaded", ...makeSnapshot() },
      vi.fn(),
      saveConfiguration,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "   " },
    });
    fireEvent.submit(form);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a button label between 1 and 64 characters.",
    );
    expect(saveConfiguration).not.toHaveBeenCalled();

    cleanup();
    const configuration = makeConfiguration();
    configuration.actions = [
      {
        id: "unsafe",
        type: "open_url",
        enabled_for_execution: true,
        parameters: { url: "javascript:alert(1)" },
      },
      {
        id: "disabled",
        type: "open_url",
        enabled_for_execution: false,
        parameters: { url: "https://example.com/" },
      },
    ];
    renderGrid(
      { status: "loaded", revision: 4, configuration },
      vi.fn(),
      saveConfiguration,
    );
    expect(screen.getByRole("button", { name: "Add button" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const emptyActionForm = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(emptyActionForm).getByLabelText("Action type"), {
      target: { value: "open_url" },
    });
    const savedWebsites = within(emptyActionForm).getByLabelText("Saved website");
    expect(within(savedWebsites).getAllByRole("option")).toHaveLength(1);
    expect(within(emptyActionForm).getByLabelText("Website URL")).toBeVisible();
    fireEvent.change(within(emptyActionForm).getByLabelText("Button label"), {
      target: { value: "Needs an action" },
    });
    fireEvent.change(within(emptyActionForm).getByLabelText("Website name"), {
      target: { value: "Unsafe URL" },
    });
    fireEvent.change(within(emptyActionForm).getByLabelText("Website URL"), {
      target: { value: "javascript:alert(1)" },
    });
    fireEvent.submit(emptyActionForm);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a valid HTTP or HTTPS website URL.",
    );
    expect(saveConfiguration).not.toHaveBeenCalled();
  });

  it("keeps editor input open and reports save failures", async () => {
    const onSave = vi.fn().mockRejectedValue(new Error("Storage is unavailable."));
    render(<EditorHarness onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "Keep my draft" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Storage is unavailable.",
    );
    expect(screen.getByLabelText("Button label")).toHaveValue("Keep my draft");
    expect(screen.getByText("Configuration revision 4")).toBeInTheDocument();
  });

  it("preserves draft input and reports stale-revision conflicts", async () => {
    const latestSnapshot = {
      revision: 5,
      configuration: makeConfiguration([
        { id: "other-button", label: "Other client", action_id: "open-site" },
      ]),
    };
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(
        new ConfigurationRevisionConflictError(4, 5, latestSnapshot),
      )
      .mockResolvedValueOnce(undefined);
    render(<EditorHarness onSave={onSave} />);
    fireEvent.click(screen.getByRole("button", { name: "Add button" }));
    const form = screen.getByRole("form", { name: "Add button" });
    fireEvent.change(within(form).getByLabelText("Button label"), {
      target: { value: "My unsaved button" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /your edits are preserved\. Review and save again\./i,
    );
    expect(screen.getByLabelText("Button label")).toHaveValue(
      "My unsaved button",
    );
    expect(screen.getByText("Configuration revision 5")).toBeInTheDocument();
    fireEvent.click(within(form).getByRole("button", { name: "Add button" }));
    expect(await screen.findByText("Button added.", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^My unsaved button/i })).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[1][0].profiles[0].pages[0].buttons).toEqual(
      expect.arrayContaining([
        {
          id: "other-button",
          label: "Other client",
          action_id: "open-site",
        },
        expect.objectContaining({
          label: "My unsaved button",
          action_id: null,
        }),
      ]),
    );
  });

  it("previews and saves button appearance using the curated icon and color", async () => {
    const snapshot = makeSnapshot([
      { id: "site-button", label: "Website", action_id: "open-site" },
    ]);
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditorHarness initialSnapshot={snapshot} onSave={onSave} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Website" }));
    fireEvent.change(screen.getByLabelText("Button label"), {
      target: { value: "Docs" },
    });
    fireEvent.change(screen.getByLabelText("Button icon"), {
      target: { value: "document" },
    });
    fireEvent.change(screen.getByLabelText("Button accent color"), {
      target: { value: "#12abef" },
    });

    const preview = screen.getByLabelText("Button appearance preview");
    expect(preview).toHaveStyle({
      borderColor: "#12abef",
      backgroundColor: "#12abef24",
    });
    fireEvent.click(screen.getByRole("button", { name: "Save button" }));

    const savedButtonLabel = await screen.findByText("Docs", {
      selector: ".configured-button-label",
    });
    expect(savedButtonLabel.closest("button")).toHaveStyle({
      borderColor: "rgb(18, 171, 239)",
      backgroundColor: "rgba(18, 171, 239, 0.14)",
    });
    expect(onSave.mock.calls[0][0].profiles[0].pages[0].buttons[0]).toEqual({
      id: "site-button",
      label: "Docs",
      action_id: "open-site",
      icon: "document",
      color: "#12abef",
    });
  });

  it("saves grid dimensions on the selected page without truncating button order", async () => {
    const snapshot = makeNavigationSnapshot();
    snapshot.configuration.profiles[1].pages[1].buttons.push({
      id: "details-button-2",
      label: "Second details action",
      action_id: "open-site",
    });

    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EditorHarness initialSnapshot={snapshot} onSave={onSave} />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), {
      target: { value: "work" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Grid settings" }));
    fireEvent.change(screen.getByLabelText("Grid columns"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Grid rows"), {
      target: { value: "2" },
    });
    expect(
      screen.getByLabelText("2 rows by 1 columns preview"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save grid" }));

    expect(await screen.findByText("Grid layout saved.")).toBeInTheDocument();
    const saved = onSave.mock.calls[0][0];
    expect(saved.profiles[0].pages[0].grid).toEqual({ columns: 2, rows: 1 });
    expect(saved.profiles[1].pages[1].grid).toEqual({ columns: 1, rows: 2 });
    expect(saved.profiles[1].pages[1].buttons.map((button: { id: string }) => button.id)).toEqual([
      "details-button",
      "details-button-2",
    ]);
  });

  it("assigns a saved command when a command is dropped onto a deck button", async () => {
    const configuration = makeConfiguration([
      { id: "target-button", label: "Target", action_id: "open-site" },
    ]);
    configuration.commands = [
      {
        id: "command-note",
        definition_version: 1,
        name: "Open note",
        category: "Work",
        enabled: true,
        steps: [{ type: "wait", parameters: { milliseconds: 10 } }],
      },
    ];
    configuration.actions.push({
      id: "run-note",
      type: "run_command",
      enabled_for_execution: true,
      parameters: { command_id: "command-note" },
    });
    const saveConfiguration = vi.fn().mockResolvedValue(undefined);
    renderGrid(
      { status: "loaded", revision: 4, configuration },
      vi.fn(),
      saveConfiguration,
    );
    const deckButton = screen.getByRole("button", { name: /^Target/i });
    const buttonTile = deckButton.closest(".button-grid-item");
    if (!buttonTile) {
      throw new Error("Expected a button tile to drop the command onto.");
    }
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        getData: (format: string) =>
          format === "application/x-pocketdeck-command"
            ? "command-note"
            : "",
      },
    });
    buttonTile.dispatchEvent(drop);

    await waitFor(() => expect(saveConfiguration).toHaveBeenCalledOnce());
    expect(
      saveConfiguration.mock.calls[0][0].profiles[0].pages[0].buttons[0]
        .action_id,
    ).toBe("run-note");
  });

  it("restores a valid saved profile and page selection without saving", () => {
    const saveConfiguration = vi.fn().mockResolvedValue(undefined);
    localStorage.setItem(
      "pocketdeck.view-selection.v1",
      JSON.stringify({
        version: 1,
        profileId: "work",
        pageIds: { default: "main", work: "details" },
      }),
    );

    renderGrid(
      { status: "loaded", ...makeNavigationSnapshot() },
      vi.fn(),
      saveConfiguration,
    );

    expect(screen.getByRole("button", { name: /^Details action/i })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Details" }),
    ).toHaveAttribute("aria-current", "page");
    expect(saveConfiguration).not.toHaveBeenCalled();
  });

  it("blocks grid capacity loss and preserves the draft through save failure and conflict", async () => {
    const snapshot = makeNavigationSnapshot();
    const page = snapshot.configuration.profiles[1].pages[1];
    page.grid = { columns: 2, rows: 2 };
    page.buttons.push(
      {
        id: "details-button-2",
        label: "Second details action",
        action_id: "open-site",
      },
      {
        id: "details-button-3",
        label: "Third details action",
        action_id: "open-site",
      },
    );
    const latestSnapshot: ConfigurationSnapshot = {
      revision: 5,
      configuration: structuredClone(snapshot.configuration),
    };
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error("Storage is unavailable."))
      .mockRejectedValueOnce(
        new ConfigurationRevisionConflictError(4, 5, latestSnapshot),
      )
      .mockResolvedValueOnce(undefined);
    render(
      <EditorHarness initialSnapshot={snapshot} onSave={onSave} />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Profile" }), {
      target: { value: "work" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    fireEvent.click(screen.getByRole("button", { name: "Grid settings" }));
    fireEvent.change(screen.getByLabelText("Grid columns"), {
      target: { value: "1" },
    });
    fireEvent.change(screen.getByLabelText("Grid rows"), {
      target: { value: "2" },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This layout cannot fit all existing buttons.",
    );
    expect(screen.getByRole("button", { name: "Save grid" })).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Grid rows"), {
      target: { value: "4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save grid" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Storage is unavailable.",
    );
    expect(screen.getByLabelText("Grid rows")).toHaveValue(4);

    fireEvent.click(screen.getByRole("button", { name: "Save grid" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /your grid draft is preserved/i,
    );
    expect(screen.getByLabelText("Grid rows")).toHaveValue(4);
    expect(screen.getByText("Configuration revision 5")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save grid" }));
    expect(await screen.findByText("Grid layout saved.")).toBeInTheDocument();
    expect(onSave).toHaveBeenCalledTimes(3);
    expect(onSave.mock.calls[2][0].profiles[1].pages[1].grid).toEqual({
      columns: 1,
      rows: 4,
    });
    expect(
      onSave.mock.calls[2][0].profiles[1].pages[1].buttons.map(
        (button: { id: string }) => button.id,
      ),
    ).toEqual([
      "details-button",
      "details-button-2",
      "details-button-3",
    ]);
  });
});
