import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  isApplicationPickerAvailable,
  selectApplicationExecutable,
} from "../api/applications";
import { executeAction } from "../api/actions";
import {
  getSystemMetrics,
  type SystemMetricsSnapshot,
} from "../api/systemMetrics";
import {
  ConfigurationRevisionConflictError,
  type ActionConfiguration,
  type ButtonConfiguration,
  type PocketDeckConfiguration,
  type SystemMetricName,
  type SystemControlName,
} from "../api/configuration";
import { createConfigurationId } from "../api/configurationEdits";
import { formatShortcut } from "../api/keyboardShortcut";
import type { ConfigurationState } from "../hooks/useConfiguration";
import { Icon } from "./Icon";
import {
  InlineActionEditor,
  type InlineActionEditorRequest,
} from "./InlineActionEditor";

interface ConfigurationButtonGridProps {
  state: ConfigurationState;
  retry: () => void;
  saveConfiguration: (configuration: PocketDeckConfiguration) => Promise<void>;
  refreshError?: string | null;
  authorized?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}

interface ButtonEditorDraft {
  mode: "create" | "edit";
  buttonId?: string;
  profileId: string;
  pageId: string;
  label: string;
  actionId: string | null;
  actionType:
    | "none"
    | "open_url"
    | "application"
    | "system_control"
    | "system_monitor"
    | "run_command"
    | "keyboard_shortcut"
    | "missing";
  websiteName: string;
  websiteUrl: string;
  applicationName: string;
  applicationPath: string;
  systemControl: SystemControlName | "";
  systemMetric: SystemMetricName | "";
  icon: string;
  color: string;
}

interface ViewSelection {
  profileId: string;
  pageId: string | null;
}

interface GridEditorDraft {
  profileId: string;
  pageId: string;
  columns: number;
  rows: number;
}

interface StoredViewSelection {
  version: 1;
  profileId: string;
  pageIds: Record<string, string>;
}

const VIEW_SELECTION_KEY = "pocketdeck.view-selection.v1";
const BUTTON_ICONS = [
  "globe",
  "application",
  "volume",
  "brightness",
  "folder",
  "star",
  "document",
  "mail",
] as const;
const EMPTY_PROFILES: PocketDeckConfiguration["profiles"] = [];
const SYSTEM_CONTROL_LABELS: Record<SystemControlName, string> = {
  volume_up: "Volume up",
  volume_down: "Volume down",
  mute_toggle: "Mute / unmute",
  brightness_up: "Brightness up",
  brightness_down: "Brightness down",
};
const SYSTEM_CONTROL_ICONS: Record<SystemControlName, "volume" | "brightness"> = {
  volume_up: "volume",
  volume_down: "volume",
  mute_toggle: "volume",
  brightness_up: "brightness",
  brightness_down: "brightness",
};
const SYSTEM_METRIC_LABELS: Record<SystemMetricName, string> = {
  cpu_utilization: "CPU utilization",
  memory_usage: "Memory usage",
  gpu_utilization: "GPU utilization",
  gpu_temperature: "GPU temperature",
  cpu_temperature: "CPU temperature",
};

function formatMetricBytes(value: number): string {
  const gibibytes = value / 1024 ** 3;
  return `${gibibytes.toFixed(1)} GiB`;
}

function describeMetricValue(
  metric: SystemMetricName,
  snapshot: SystemMetricsSnapshot | null,
  refreshError: string | null,
): { value: string; detail: string } {
  if (metric === "cpu_utilization") {
    if (snapshot?.cpu_status === "sampling") {
      return {
        value: "Sampling…",
        detail:
          refreshError ??
          "Waiting for the next CPU sample.",
      };
    }
    if (
      snapshot?.cpu_status === "available" &&
      snapshot.cpu_usage_percent !== null
    ) {
      return {
        value: `${snapshot.cpu_usage_percent.toFixed(1)}%`,
        detail: refreshError
          ? `Last reading. Refresh failed: ${refreshError}`
          : "Current CPU utilization.",
      };
    }
    return {
      value: "Unavailable",
      detail:
        snapshot?.unavailable_metrics.cpu_utilization ??
        refreshError ??
        "CPU utilization is unavailable.",
    };
  }
  if (metric === "memory_usage") {
    if (
      snapshot?.memory_used_bytes !== null &&
      snapshot?.memory_total_bytes !== null &&
      snapshot &&
      snapshot.memory_total_bytes > 0
    ) {
      const used = snapshot.memory_used_bytes;
      const total = snapshot.memory_total_bytes;
      const percent = ((used / total) * 100).toFixed(1);
      return {
        value: `${percent}%`,
        detail: refreshError
          ? `${formatMetricBytes(used)} used of ${formatMetricBytes(total)}. Refresh failed: ${refreshError}`
          : `${formatMetricBytes(used)} used of ${formatMetricBytes(total)}.`,
      };
    }
    return {
      value: "Unavailable",
      detail:
        snapshot?.unavailable_metrics.memory_usage ??
        refreshError ??
        "Physical memory usage is unavailable.",
    };
  }
  return {
    value: "Unavailable",
    detail:
      snapshot?.unavailable_metrics[metric] ??
      refreshError ??
      `${SYSTEM_METRIC_LABELS[metric]} is not supported on this system.`,
  };
}

function isHttpOrHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function isWindowsExecutablePath(value: string): boolean {
  return (
    /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(value) &&
    /\.exe$/i.test(value) &&
    !/[<>:"|?*\0]/.test(value.replace(/^[A-Za-z]:/, "")) &&
    value.length <= 32768
  );
}

function applicationNameFromPath(path: string): string {
  return (path.split(/[\\/]/).pop() ?? "")
    .replace(/\.exe$/i, "")
    .slice(0, 64);
}

function isButtonIcon(value: string): value is (typeof BUTTON_ICONS)[number] {
  return BUTTON_ICONS.some((icon) => icon === value);
}

function readStoredViewSelection(): StoredViewSelection | null {
  try {
    const serialized = localStorage.getItem(VIEW_SELECTION_KEY);
    if (!serialized) {
      return null;
    }
    const value: unknown = JSON.parse(serialized);
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("profileId" in value) ||
      typeof value.profileId !== "string" ||
      !("pageIds" in value) ||
      typeof value.pageIds !== "object" ||
      value.pageIds === null ||
      Array.isArray(value.pageIds) ||
      !Object.values(value.pageIds).every(
        (pageId) => typeof pageId === "string",
      )
    ) {
      return null;
    }
    return value as StoredViewSelection;
  } catch {
    return null;
  }
}

function isSelectableAction(
  action: ActionConfiguration,
  configuration: PocketDeckConfiguration,
): boolean {
  if (action.type === "system_monitor") {
    return Object.hasOwn(SYSTEM_METRIC_LABELS, action.parameters.metric);
  }
  if (!action.enabled_for_execution) {
    return false;
  }
  if (action.type === "run_command") {
    return configuration.commands.some(
      (command) =>
        command.id === action.parameters.command_id && command.enabled,
    );
  }
  if (action.type === "keyboard_shortcut") {
    return true;
  }
  if (action.type === "application") {
    return (
      action.parameters.name.length > 0 &&
      isWindowsExecutablePath(action.parameters.path)
    );
  }
  if (action.type === "system_control") {
    return Object.hasOwn(SYSTEM_CONTROL_LABELS, action.parameters.control);
  }
  try {
    const url = new URL(action.parameters.url);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function describeAction(
  action: ActionConfiguration,
  configuration: PocketDeckConfiguration,
): string {
  if (action.type === "open_url") {
    if (action.parameters.name) {
      return action.parameters.name;
    }
    try {
      const url = new URL(action.parameters.url);
      return `Website · ${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return "Unavailable website action";
    }
  }
  if (action.type === "run_command") {
    return (
      configuration.commands.find(
        (command) => command.id === action.parameters.command_id,
      )?.name ?? "Unavailable command"
    );
  }
  if (action.type === "application") {
    return action.parameters.name;
  }
  if (action.type === "system_control") {
    return SYSTEM_CONTROL_LABELS[action.parameters.control];
  }
  if (action.type === "system_monitor") {
    return SYSTEM_METRIC_LABELS[action.parameters.metric];
  }
  if ("shortcut" in action.parameters) {
    return formatShortcut(action.parameters.shortcut);
  }
  const shortcutId = action.parameters.shortcut_id;
  return (
    configuration.shortcuts.find(
      (shortcut) => shortcut.id === shortcutId,
    )?.name ?? "Unavailable shortcut"
  );
}

function describeActionType(action: ActionConfiguration): ButtonEditorDraft["actionType"] {
  return action.type;
}

function friendlyActionOptionLabels(
  actions: ActionConfiguration[],
  configuration: PocketDeckConfiguration,
): Map<string, string> {
  const descriptions = actions.map((action) => {
    const name = describeAction(action, configuration);
    if (action.type === "run_command") {
      const command = configuration.commands.find(
        (item) => item.id === action.parameters.command_id,
      );
      return {
        action,
        name,
        category: command?.category ?? "Command",
      };
    }
    if (action.type === "keyboard_shortcut") {
      return { action, name, category: "Shortcut" };
    }
    if (action.type === "application") {
      return { action, name, category: "Application" };
    }
    if (action.type === "system_control") {
      return { action, name, category: "System control" };
    }
    if (action.type === "system_monitor") {
      return { action, name, category: "System monitor" };
    }
    try {
      return {
        action,
        name,
        category: `Website · ${new URL(action.parameters.url).hostname}`,
      };
    } catch {
      return { action, name: "Unavailable website action", category: "Website" };
    }
  });
  const counts = new Map<string, number>();
  for (const { name } of descriptions) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const usedLabels = new Map<string, number>();
  return new Map(
    descriptions.map(({ action, name, category }) => {
      const base = (counts.get(name) ?? 0) > 1 ? `${name} · ${category}` : name;
      const occurrence = (usedLabels.get(base) ?? 0) + 1;
      usedLabels.set(base, occurrence);
      return [
        action.id,
        occurrence === 1 ? base : `${base} ${occurrence}`,
      ];
    }),
  );
}

function makeButtonId(configuration: PocketDeckConfiguration): string {
  let id: string;
  do {
    id = `button-${crypto.randomUUID()}`;
  } while (
    configuration.profiles.some(
      (profile) =>
        profile.id === id ||
        profile.pages.some(
          (page) =>
            page.id === id || page.buttons.some((button) => button.id === id),
        ),
    ) || configuration.actions.some((action) => action.id === id)
  );
  return id;
}

export function ConfigurationButtonGrid({
  state,
  retry,
  saveConfiguration,
  refreshError = null,
  authorized = true,
  onDirtyChange,
}: ConfigurationButtonGridProps) {
  const executingActionIds = useRef(new Set<string>());
  const draggedButtonId = useRef<string | null>(null);
  const [executingIds, setExecutingIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [executionMessage, setExecutionMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [editor, setEditor] = useState<ButtonEditorDraft | null>(null);
  const [inlineActionEditor, setInlineActionEditor] =
    useState<InlineActionEditorRequest | null>(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [applicationPickerBusy, setApplicationPickerBusy] = useState(false);
  const [systemMetricsState, setSystemMetricsState] = useState<{
    requestKey: string;
    snapshot: SystemMetricsSnapshot | null;
    error: string | null;
  } | null>(null);
  const [editorMessage, setEditorMessage] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [storedViewSelection, setStoredViewSelection] =
    useState<StoredViewSelection | null>(readStoredViewSelection);
  const [pendingViewSelection, setPendingViewSelection] =
    useState<ViewSelection | null>(null);
  const [gridEditor, setGridEditor] = useState<GridEditorDraft | null>(null);
  useEffect(() => {
    onDirtyChange?.(
      editor !== null || gridEditor !== null || pendingViewSelection !== null,
    );
  }, [editor, gridEditor, onDirtyChange, pendingViewSelection]);
  const profiles =
    state.status === "loaded" ? state.configuration.profiles : EMPTY_PROFILES;
  const profile =
    profiles.find(
      (candidate) => candidate.id === storedViewSelection?.profileId,
    ) ??
    profiles[0] ??
    null;
  const selectedPageId = profile
    ? storedViewSelection?.pageIds[profile.id]
    : undefined;
  const page =
    profile?.pages.find((candidate) => candidate.id === selectedPageId) ??
    profile?.pages[0] ??
    null;
  const visibleActionIds = new Set(
    page?.buttons.flatMap((button) =>
      button.action_id ? [button.action_id] : [],
    ) ?? [],
  );
  const monitorActionIds =
    state.status === "loaded"
      ? state.configuration.actions
          .filter(
            (action) =>
              action.type === "system_monitor" &&
              visibleActionIds.has(action.id),
          )
          .map((action) => action.id)
          .join("|")
      : "";
  const metricsRequestKey = `${authorized ? "authorized" : "unauthorized"}:${monitorActionIds}`;
  const visibleMetricsState =
    authorized &&
    monitorActionIds &&
    systemMetricsState?.requestKey === metricsRequestKey
      ? systemMetricsState
      : null;

  useEffect(() => {
    if (!authorized || !monitorActionIds) {
      return;
    }

    let active = true;
    let timeout: number | undefined;
    let controller: AbortController | null = null;
    const poll = async () => {
      controller = new AbortController();
      try {
        const snapshot = await getSystemMetrics(controller.signal);
        if (active) {
          setSystemMetricsState({
            requestKey: metricsRequestKey,
            snapshot,
            error: null,
          });
        }
      } catch (error) {
        if (active) {
          setSystemMetricsState((current) => ({
            requestKey: metricsRequestKey,
            snapshot:
              current?.requestKey === metricsRequestKey
                ? current.snapshot
                : null,
            error:
              error instanceof Error
              ? error.message
                : "System metrics could not be refreshed.",
          }));
        }
      } finally {
        if (active) {
          timeout = window.setTimeout(() => void poll(), 2500);
        }
      }
    };
    void poll();

    return () => {
      active = false;
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
      controller?.abort();
    };
  }, [authorized, metricsRequestKey, monitorActionIds]);

  useEffect(() => {
    if (!profile) {
      return;
    }
    const validPageIds = Object.fromEntries(
      profiles.flatMap((candidateProfile) => {
        const pageId = storedViewSelection?.pageIds[candidateProfile.id];
        return pageId && candidateProfile.pages.some((item) => item.id === pageId)
          ? [[candidateProfile.id, pageId]]
          : [];
      }),
    );
    const next: StoredViewSelection = {
      version: 1,
      profileId: profile.id,
      pageIds: {
        ...validPageIds,
        ...(page ? { [profile.id]: page.id } : {}),
      },
    };
    try {
      localStorage.setItem(VIEW_SELECTION_KEY, JSON.stringify(next));
    } catch {
      // Selection remains available for the current render when storage is unavailable.
    }
  }, [page, profile, profiles, storedViewSelection]);

  const runAction = async (actionId: string) => {
    if (executingActionIds.current.has(actionId)) {
      return;
    }
    if (state.status === "loaded" && state.configuration.settings.confirm_commands) {
      const action = state.configuration.actions.find(
        (item) => item.id === actionId,
      );
      if (
        action?.type === "run_command" &&
        !window.confirm("Run this saved command now?")
      ) {
        setExecutionMessage({
          kind: "success",
          text: "Command cancelled before execution.",
        });
        return;
      }
    }
    executingActionIds.current.add(actionId);
    setExecutingIds(new Set(executingActionIds.current));
    setExecutionMessage(null);

    try {
      const result = await executeAction(actionId);
      setExecutionMessage({
        kind: result.success ? "success" : "error",
        text: result.message,
      });
    } catch (error) {
      setExecutionMessage({
        kind: "error",
        text:
          error instanceof Error
            ? error.message
            : "The action could not be completed.",
      });
    } finally {
      executingActionIds.current.delete(actionId);
      setExecutingIds(new Set(executingActionIds.current));
    }
  };

  const beginCreate = (
    profile: PocketDeckConfiguration["profiles"][number],
    page: PocketDeckConfiguration["profiles"][number]["pages"][number],
  ) => {
    setEditorError(null);
    setEditorMessage(null);
    setEditor({
      mode: "create",
      profileId: profile.id,
      pageId: page.id,
      label: "",
      actionId: null,
      actionType: "none",
      websiteName: "",
      websiteUrl: "",
      applicationName: "",
      applicationPath: "",
      systemControl: "",
      systemMetric: "",
      icon: "",
      color: "",
    });
  };

  const beginEdit = (
    button: ButtonConfiguration,
    profile: PocketDeckConfiguration["profiles"][number],
    page: PocketDeckConfiguration["profiles"][number]["pages"][number],
  ) => {
    if (state.status !== "loaded") {
      return;
    }
    const action = button.action_id
      ? state.configuration.actions.find(
          (candidate) => candidate.id === button.action_id,
        )
      : undefined;
    setEditorError(null);
    setEditorMessage(null);
    setEditor({
      mode: "edit",
      buttonId: button.id,
      profileId: profile.id,
      pageId: page.id,
      label: button.label,
      actionId: button.action_id,
      actionType: button.action_id
        ? action
          ? describeActionType(action)
          : "missing"
        : "none",
      websiteName:
        action?.type === "open_url"
          ? action.parameters.name ?? new URL(action.parameters.url).hostname
          : "",
      websiteUrl: action?.type === "open_url" ? action.parameters.url : "",
      applicationName:
        action?.type === "application" ? action.parameters.name : "",
      applicationPath:
        action?.type === "application" ? action.parameters.path : "",
      systemControl:
        action?.type === "system_control" ? action.parameters.control : "",
      systemMetric:
        action?.type === "system_monitor" ? action.parameters.metric : "",
      icon: button.icon ?? "",
      color: button.color ?? "",
    });
  };

  const chooseApplication = async () => {
    if (!isApplicationPickerAvailable()) {
      setEditorError(
        "The native executable picker is only available in the Windows desktop app. You can enter an absolute .exe path manually.",
      );
      return;
    }
    setApplicationPickerBusy(true);
    setEditorError(null);
    try {
      const path = await selectApplicationExecutable();
      if (path) {
        setEditor((current) =>
          current
            ? {
                ...current,
                applicationPath: path,
                applicationName:
                  current.applicationName || applicationNameFromPath(path),
              }
            : current,
        );
      }
    } catch (error) {
      setEditorError(
        error instanceof Error
          ? error.message
          : "The executable picker could not be opened.",
      );
    } finally {
      setApplicationPickerBusy(false);
    }
  };

  const submitEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.status !== "loaded" || !editor || editorBusy) {
      return;
    }

    const label = editor.label.trim();
    if (!label || label.length > 64) {
      setEditorError("Enter a button label between 1 and 64 characters.");
      return;
    }
    const profile = state.configuration.profiles.find(
      (candidate) => candidate.id === editor.profileId,
    );
    const page = profile?.pages.find(
      (candidate) => candidate.id === editor.pageId,
    );
    if (!profile || !page) {
      setEditorError("The current page is unavailable.");
      return;
    }
    const duplicateLabel = page.buttons.some(
      (button) =>
        button.id !== editor.buttonId &&
        button.label.trim().toLowerCase() === label.toLowerCase(),
    );
    if (duplicateLabel) {
      setEditorError("Button labels must be unique on this page.");
      return;
    }

    let action =
      editor.actionId === null
        ? undefined
        : state.configuration.actions.find(
            (candidate) => candidate.id === editor.actionId,
          );
    if (editor.actionType === "open_url") {
      const websiteName = editor.websiteName.trim();
      const websiteUrl = editor.websiteUrl.trim();
      if (!websiteName || websiteName.length > 64) {
        setEditorError("Enter a website name between 1 and 64 characters.");
        return;
      }
      if (!isHttpOrHttpsUrl(websiteUrl)) {
        setEditorError("Enter a valid HTTP or HTTPS website URL.");
        return;
      }
      if (!action) {
        action = {
          id: createConfigurationId("website", state.configuration),
          type: "open_url",
          enabled_for_execution: true,
          parameters: { url: websiteUrl, name: websiteName },
        };
      } else if (action.type === "open_url") {
        action = {
          ...action,
          parameters: { url: websiteUrl, name: websiteName },
        };
      }
    }
    if (editor.actionType === "application") {
      const applicationName = editor.applicationName.trim();
      const applicationPath = editor.applicationPath.trim();
      if (!applicationName || applicationName.length > 64) {
        setEditorError("Enter an application name between 1 and 64 characters.");
        return;
      }
      if (!isWindowsExecutablePath(applicationPath)) {
        setEditorError("Choose an absolute Windows .exe path without arguments.");
        return;
      }
      if (!action) {
        action = {
          id: createConfigurationId("application", state.configuration),
          type: "application",
          enabled_for_execution: true,
          parameters: { name: applicationName, path: applicationPath },
        };
      } else if (action.type === "application") {
        action = {
          ...action,
          parameters: { name: applicationName, path: applicationPath },
        };
      }
    }
    if (editor.actionType === "system_control") {
      const control = editor.systemControl;
      if (!control || !Object.hasOwn(SYSTEM_CONTROL_LABELS, control)) {
        setEditorError("Choose one of the supported system controls.");
        return;
      }
      if (!action) {
        action = {
          id: createConfigurationId("control", state.configuration),
          type: "system_control",
          enabled_for_execution: true,
          parameters: { control },
        };
      } else if (action.type === "system_control") {
        action = {
          ...action,
          parameters: { control },
        };
      }
    }
    if (editor.actionType === "system_monitor") {
      const metric = editor.systemMetric;
      if (!metric || !Object.hasOwn(SYSTEM_METRIC_LABELS, metric)) {
        setEditorError("Choose a system metric to display.");
        return;
      }
      if (!action) {
        action = {
          id: createConfigurationId("monitor", state.configuration),
          type: "system_monitor",
          enabled_for_execution: false,
          parameters: { metric },
        };
      } else if (action.type === "system_monitor") {
        action = {
          ...action,
          enabled_for_execution: false,
          parameters: { metric },
        };
      }
    }
    if (
      editor.actionType !== "none" &&
      (!action ||
        !isSelectableAction(action, state.configuration) ||
        describeActionType(action) !== editor.actionType)
    ) {
      setEditorError(
        editor.actionType === "missing"
          ? "This saved action is unavailable. Choose a replacement or explicitly select None; the existing assignment has not been changed."
          : "Choose an enabled supported action or select None.",
      );
      return;
    }

    let buttons: ButtonConfiguration[];
    if (editor.mode === "create") {
      if (page.buttons.length >= page.grid.columns * page.grid.rows) {
        setEditorError("This page is full. Delete a button before adding another.");
        return;
      }
      buttons = [
        ...page.buttons,
        {
          id: makeButtonId(state.configuration),
          label,
          action_id: action?.id ?? null,
          ...(isButtonIcon(editor.icon) ? { icon: editor.icon } : {}),
          ...(editor.color ? { color: editor.color } : {}),
        },
      ];
    } else {
      const buttonExists = page.buttons.some(
        (button) => button.id === editor.buttonId,
      );
      if (!buttonExists) {
        setEditorError(
          "This button was removed by another update. Your edits are preserved; cancel and create a new button if needed.",
        );
        return;
      }
      buttons = page.buttons.map((button) => {
        if (button.id !== editor.buttonId) {
          return button;
        }
        const updated = { ...button, label, action_id: action?.id ?? null };
        if (isButtonIcon(editor.icon)) {
          updated.icon = editor.icon;
        } else if (editor.icon !== (button.icon ?? "")) {
          delete updated.icon;
        }
        if (/^#[0-9A-Fa-f]{6}$/.test(editor.color)) {
          updated.color = editor.color;
        } else {
          delete updated.color;
        }
        return updated;
      });
    }

    const actionToPersist =
      action &&
      (action.type === "open_url" ||
        action.type === "application" ||
        action.type === "system_control" ||
        action.type === "system_monitor")
        ? action
        : undefined;
    const actions = actionToPersist
      ? state.configuration.actions.some((item) => item.id === actionToPersist.id)
        ? state.configuration.actions.map((item) =>
            item.id === actionToPersist.id ? actionToPersist : item,
          )
        : [...state.configuration.actions, actionToPersist]
      : state.configuration.actions;
    const configuration: PocketDeckConfiguration = {
      ...state.configuration,
      actions,
      profiles: state.configuration.profiles.map((candidateProfile) =>
        candidateProfile.id === profile.id
          ? {
              ...candidateProfile,
              pages: candidateProfile.pages.map((candidatePage) =>
                candidatePage.id === page.id ? { ...candidatePage, buttons } : candidatePage,
              ),
            }
          : candidateProfile,
      ),
    };

    setEditorBusy(true);
    setEditorError(null);
    setEditorMessage(null);
    try {
      await saveConfiguration(configuration);
      setEditor(null);
      setInlineActionEditor(null);
      setEditorMessage({
        kind: "success",
        text: editor.mode === "create" ? "Button added." : "Button saved.",
      });
    } catch (error) {
      if (error instanceof ConfigurationRevisionConflictError) {
        setEditorMessage({
          kind: "error",
          text: error.latestSnapshot
            ? "Configuration changed elsewhere. The latest version is loaded; your edits are preserved. Review and save again."
            : "Configuration changed elsewhere and the latest version could not be loaded. Your edits are preserved; retry when connected.",
        });
      } else {
        setEditorMessage({
          kind: "error",
          text:
            error instanceof Error
              ? error.message
              : "The button could not be saved.",
        });
      }
    } finally {
      setEditorBusy(false);
    }
  };

  const deleteButton = async (button: ButtonConfiguration) => {
    if (state.status !== "loaded" || editorBusy) {
      return;
    }
    const targetProfile = state.configuration.profiles.find(
      (candidate) => candidate.id === profile?.id,
    );
    const targetPage = targetProfile?.pages.find(
      (candidate) => candidate.id === page?.id,
    );
    if (!targetProfile || !targetPage) {
      return;
    }
    const buttons = targetPage.buttons.filter(
      (candidate) => candidate.id !== button.id,
    );
    if (buttons.length === targetPage.buttons.length) {
      return;
    }
    const configuration: PocketDeckConfiguration = {
      ...state.configuration,
      profiles: state.configuration.profiles.map((candidateProfile) =>
        candidateProfile.id === targetProfile.id
          ? {
              ...candidateProfile,
              pages: candidateProfile.pages.map((candidatePage) =>
                candidatePage.id === targetPage.id
                  ? { ...candidatePage, buttons }
                  : candidatePage,
              ),
            }
          : candidateProfile,
      ),
    };

    setEditorBusy(true);
    setEditorError(null);
    setEditorMessage(null);
    try {
      await saveConfiguration(configuration);
      if (editor?.buttonId === button.id) {
        setEditor(null);
        setInlineActionEditor(null);
      }
      setEditorMessage({ kind: "success", text: "Button deleted." });
    } catch (error) {
      setEditorMessage({
        kind: "error",
        text:
          error instanceof ConfigurationRevisionConflictError
            ? "Configuration changed elsewhere. The latest version is loaded; the button was not deleted. Try again."
            : error instanceof Error
              ? error.message
              : "The button could not be deleted.",
      });
    } finally {
      setEditorBusy(false);
    }
  };

  const moveButton = async (fromId: string, toId: string) => {
    if (
      state.status !== "loaded" ||
      editorBusy ||
      !profile ||
      !page ||
      fromId === toId
    ) {
      return;
    }
    const fromIndex = page.buttons.findIndex((button) => button.id === fromId);
    const toIndex = page.buttons.findIndex((button) => button.id === toId);
    if (fromIndex < 0 || toIndex < 0) {
      return;
    }
    const buttons = [...page.buttons];
    const [moved] = buttons.splice(fromIndex, 1);
    buttons.splice(toIndex, 0, moved);
    const configuration: PocketDeckConfiguration = {
      ...state.configuration,
      profiles: state.configuration.profiles.map((candidateProfile) =>
        candidateProfile.id === profile.id
          ? {
              ...candidateProfile,
              pages: candidateProfile.pages.map((candidatePage) =>
                candidatePage.id === page.id
                  ? { ...candidatePage, buttons }
                  : candidatePage,
              ),
            }
          : candidateProfile,
      ),
    };
    setEditorBusy(true);
    setEditorMessage(null);
    try {
      await saveConfiguration(configuration);
      setEditorMessage({ kind: "success", text: "Button order saved." });
    } catch (error) {
      setEditorMessage({
        kind: "error",
        text:
          error instanceof Error ? error.message : "Button order could not be saved.",
      });
    } finally {
      setEditorBusy(false);
    }
  };

  const assignCommand = async (commandId: string, buttonId: string) => {
    if (state.status !== "loaded" || editorBusy || !page) {
      return;
    }
    const command = state.configuration.commands.find(
      (item) => item.id === commandId && item.enabled,
    );
    const action = state.configuration.actions.find(
      (item) =>
        item.type === "run_command" &&
        item.parameters.command_id === commandId &&
        item.enabled_for_execution,
    );
    if (!command || !action) {
      setEditorMessage({
        kind: "error",
        text: "Only saved, enabled commands can be assigned to a button.",
      });
      return;
    }
    const buttons = page.buttons.map((button) =>
      button.id === buttonId ? { ...button, action_id: action.id } : button,
    );
    const configuration: PocketDeckConfiguration = {
      ...state.configuration,
      profiles: state.configuration.profiles.map((candidateProfile) =>
        candidateProfile.id === profile?.id
          ? {
              ...candidateProfile,
              pages: candidateProfile.pages.map((candidatePage) =>
                candidatePage.id === page.id
                  ? { ...candidatePage, buttons }
                  : candidatePage,
              ),
            }
          : candidateProfile,
      ),
    };
    setEditorBusy(true);
    setEditorMessage(null);
    try {
      await saveConfiguration(configuration);
      setEditorMessage({
        kind: "success",
        text: `Assigned ${command.name} to the button.`,
      });
    } catch (error) {
      setEditorMessage({
        kind: "error",
        text:
          error instanceof Error ? error.message : "Command assignment could not be saved.",
      });
    } finally {
      setEditorBusy(false);
    }
  };

  const submitGridEditor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.status !== "loaded" || !gridEditor || editorBusy) {
      return;
    }
    const profile = state.configuration.profiles.find(
      (candidate) => candidate.id === gridEditor.profileId,
    );
    const page = profile?.pages.find(
      (candidate) => candidate.id === gridEditor.pageId,
    );
    if (!profile || !page) {
      setEditorMessage({
        kind: "error",
        text: "The selected page is no longer available. Your grid draft is preserved.",
      });
      return;
    }
    if (
      !Number.isInteger(gridEditor.columns) ||
      !Number.isInteger(gridEditor.rows) ||
      gridEditor.columns < 1 ||
      gridEditor.columns > 8 ||
      gridEditor.rows < 1 ||
      gridEditor.rows > 8
    ) {
      setEditorMessage({
        kind: "error",
        text: "Grid rows and columns must each be between 1 and 8.",
      });
      return;
    }
    const capacity = gridEditor.columns * gridEditor.rows;
    if (capacity < page.buttons.length) {
      setEditorMessage({
        kind: "error",
        text: `This layout holds ${capacity} buttons, but the page has ${page.buttons.length}. Increase its size; no buttons were removed.`,
      });
      return;
    }
    if (
      gridEditor.columns === page.grid.columns &&
      gridEditor.rows === page.grid.rows
    ) {
      setGridEditor(null);
      setEditorMessage({ kind: "success", text: "Grid is unchanged." });
      return;
    }
    const configuration: PocketDeckConfiguration = {
      ...state.configuration,
      profiles: state.configuration.profiles.map((candidateProfile) =>
        candidateProfile.id === profile.id
          ? {
              ...candidateProfile,
              pages: candidateProfile.pages.map((candidatePage) =>
                candidatePage.id === page.id
                  ? {
                      ...candidatePage,
                      grid: {
                        columns: gridEditor.columns,
                        rows: gridEditor.rows,
                      },
                    }
                  : candidatePage,
              ),
            }
          : candidateProfile,
      ),
    };
    setEditorBusy(true);
    setEditorMessage(null);
    try {
      await saveConfiguration(configuration);
      setGridEditor(null);
      setEditorMessage({ kind: "success", text: "Grid layout saved." });
    } catch (error) {
      setEditorMessage({
        kind: "error",
        text:
          error instanceof ConfigurationRevisionConflictError
            ? "Configuration changed elsewhere. The latest version is loaded; your grid draft is preserved. Review and retry."
            : error instanceof Error
              ? error.message
              : "The grid layout could not be saved.",
      });
    } finally {
      setEditorBusy(false);
    }
  };

  if (state.status === "loading") {
    return (
      <section
        aria-busy="true"
        aria-labelledby="layout-title"
        className="layout-panel"
      >
        <div className="layout-heading">
          <div>
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h2 id="layout-title">Button layout</h2>
          </div>
          <span className="count-badge">Loading</span>
        </div>
        <div className="configuration-message" role="status">
          Loading your configuration…
        </div>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section aria-labelledby="layout-title" className="layout-panel">
        <div className="layout-heading">
          <div>
            <p className="eyebrow">YOUR WORKSPACE</p>
            <h2 id="layout-title">Button layout</h2>
          </div>
          <span className="count-badge">Unavailable</span>
        </div>
        <div className="configuration-message is-error" role="alert">
          <h3>Could not load buttons</h3>
          <p>{state.message}</p>
          <button className="retry-button" onClick={retry} type="button">
            Retry configuration
          </button>
        </div>
      </section>
    );
  }

  const actionsById = new Map(
    state.configuration.actions.map((action) => [action.id, action]),
  );
  const buttons = page?.buttons ?? [];
  const grid = page?.grid ?? { columns: 3, rows: 2 };
  const emptySlots = Math.max(0, grid.columns * grid.rows - buttons.length);
  const editableActions = state.configuration.actions.filter((action) =>
    isSelectableAction(action, state.configuration),
  );
  const editorNotice = !profile || !page
    ? null
    : buttons.length >= grid.columns * grid.rows
      ? "This page is full. Delete a button before adding another."
      : null;
  const actionOptionLabels = friendlyActionOptionLabels(
    state.configuration.actions,
    state.configuration,
  );
  const gridCapacity = gridEditor
    ? gridEditor.columns * gridEditor.rows
    : 0;
  const gridFitsButtons =
    gridEditor !== null && gridCapacity >=
      (profile?.pages.find((item) => item.id === gridEditor.pageId)?.buttons
        .length ?? Number.POSITIVE_INFINITY);
  const selectedEditorAction = editor?.actionId
    ? actionsById.get(editor.actionId)
    : undefined;
  const editorActionOptions =
    editor && editor.actionType !== "none" && editor.actionType !== "missing"
      ? editableActions.filter(
          (action) => action.type === editor.actionType,
        )
      : [];
  const preservedEditorAction =
    selectedEditorAction &&
    editor &&
    editor.actionType !== "none" &&
    editor.actionType !== "missing" &&
    selectedEditorAction.type === editor.actionType &&
    !editorActionOptions.some((action) => action.id === selectedEditorAction.id)
      ? selectedEditorAction
      : undefined;
  const selectedCommand =
    selectedEditorAction?.type === "run_command"
      ? state.configuration.commands.find(
          (command) =>
            command.id === selectedEditorAction.parameters.command_id,
        )
      : undefined;
  const selectedShortcutId =
    selectedEditorAction?.type === "keyboard_shortcut" &&
    "shortcut_id" in selectedEditorAction.parameters
        ? selectedEditorAction.parameters.shortcut_id
        : null;
  const selectedShortcut =
    selectedShortcutId
        ? state.configuration.shortcuts.find(
            (shortcut) => shortcut.id === selectedShortcutId,
          )
        : undefined;

  const applyViewSelection = (selection: ViewSelection) => {
    const pageId = selection.pageId;
    setStoredViewSelection((current) => ({
      version: 1,
      profileId: selection.profileId,
      pageIds: pageId
        ? { ...(current?.pageIds ?? {}), [selection.profileId]: pageId }
        : (current?.pageIds ?? {}),
    }));
    setPendingViewSelection(null);
    setEditor(null);
    setInlineActionEditor(null);
    setGridEditor(null);
    setEditorError(null);
    setEditorMessage(null);
  };

  const requestViewSelection = (selection: ViewSelection) => {
    if (
      selection.profileId === profile?.id &&
      selection.pageId === page?.id
    ) {
      return;
    }
    if (editor || gridEditor) {
      setPendingViewSelection(selection);
      return;
    }
    applyViewSelection(selection);
  };

  return (
    <section aria-labelledby="layout-title" className="layout-panel">
      <div className="layout-heading">
        <div>
          <p className="eyebrow">
            {profile ? profile.name.toUpperCase() : "YOUR WORKSPACE"}
          </p>
          <h2 id="layout-title">{page?.name ?? "Button layout"}</h2>
        </div>
        <div className="layout-heading-actions">
          <span className="count-badge">
            {buttons.length} {buttons.length === 1 ? "button" : "buttons"}
          </span>
          <button
            className="editor-button"
            disabled={
              !profile ||
              !page ||
              editorBusy ||
              editorNotice !== null
            }
            title={editorNotice ?? undefined}
            onClick={() => {
              if (profile && page) {
                beginCreate(profile, page);
              }
            }}
            type="button"
          >
            Add button
          </button>
          <button
            className="editor-button is-quiet"
            disabled={!profile || !page || editorBusy || editor !== null}
            onClick={() => {
              if (profile && page) {
                setEditorMessage(null);
                setGridEditor({
                  profileId: profile.id,
                  pageId: page.id,
                  columns: page.grid.columns,
                  rows: page.grid.rows,
                });
              }
            }}
            type="button"
          >
            Grid settings
          </button>
        </div>
      </div>
      <div className="workspace-navigation" aria-label="Workspace navigation">
        <label className="workspace-profile-select">
          <span>Profile</span>
          <select
            aria-label="Profile"
            disabled={profiles.length === 0 || editorBusy}
            onChange={(event) => {
              const nextProfile = profiles.find(
                (candidate) => candidate.id === event.target.value,
              );
              if (nextProfile) {
                const rememberedPage = nextProfile.pages.find(
                  (candidate) =>
                    candidate.id ===
                    storedViewSelection?.pageIds[nextProfile.id],
                );
                requestViewSelection({
                  profileId: nextProfile.id,
                  pageId: (rememberedPage ?? nextProfile.pages[0])?.id ?? null,
                });
              }
            }}
            value={profile?.id ?? ""}
          >
            {profiles.length === 0 ? (
              <option value="">No profiles available</option>
            ) : (
              profiles.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))
            )}
          </select>
        </label>
        {profile && profile.pages.length > 0 ? (
          <div className="workspace-page-navigation" aria-label="Pages">
            {profile.pages.map((candidate) => (
              <button
                aria-current={candidate.id === page?.id ? "page" : undefined}
                aria-pressed={candidate.id === page?.id}
                className={`workspace-page-button${candidate.id === page?.id ? " is-active" : ""}`}
                disabled={editorBusy}
                key={candidate.id}
                onClick={() =>
                  requestViewSelection({
                    profileId: profile.id,
                    pageId: candidate.id,
                  })
                }
                type="button"
              >
                {candidate.name}
              </button>
            ))}
          </div>
        ) : (
          <p className="workspace-no-pages" role="status">
            {profile
              ? "This profile has no pages."
              : "No profiles are configured."}
          </p>
        )}
      </div>
      {pendingViewSelection && (
        <div className="navigation-draft-warning" role="alert">
          <p>You have an open button draft. Discard it and switch views?</p>
          <div>
            <button
              className="editor-button is-quiet"
              onClick={() => setPendingViewSelection(null)}
              type="button"
            >
              Keep editing
            </button>
            <button
              className="editor-button is-danger"
              onClick={() => applyViewSelection(pendingViewSelection)}
              type="button"
            >
              Discard draft and switch
            </button>
          </div>
        </div>
      )}
      {editorNotice && (
        <p className="button-editor-notice" role="status">
          {editorNotice}
        </p>
      )}
      {gridEditor && (
        <form
          aria-label="Grid settings"
          className="button-editor grid-editor"
          onSubmit={(event) => void submitGridEditor(event)}
        >
          <div className="button-editor-heading">
            <div>
              <p className="eyebrow">LAYOUT SETTINGS</p>
              <h3>Customize grid</h3>
            </div>
            <button
              className="editor-button is-quiet"
              disabled={editorBusy}
              onClick={() => setGridEditor(null)}
              type="button"
            >
              Cancel
            </button>
          </div>
          <div className="grid-editor-fields">
            <label className="button-editor-field">
              <span>Columns (1–8)</span>
              <input
                aria-label="Grid columns"
                type="number"
                min="1"
                max="8"
                step="1"
                value={gridEditor.columns}
                onChange={(event) =>
                  setGridEditor({
                    ...gridEditor,
                    columns: Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="button-editor-field">
              <span>Rows (1–8)</span>
              <input
                aria-label="Grid rows"
                type="number"
                min="1"
                max="8"
                step="1"
                value={gridEditor.rows}
                onChange={(event) =>
                  setGridEditor({
                    ...gridEditor,
                    rows: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
          <div
            aria-label={`${gridEditor.rows} rows by ${gridEditor.columns} columns preview`}
            className="grid-preview"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, Math.min(8, gridEditor.columns))}, minmax(0, 1fr))`,
            }}
          >
            {Array.from({ length: Math.min(64, Math.max(0, gridCapacity)) }, (_, index) => {
              const currentPage = state.configuration.profiles
                .find((item) => item.id === gridEditor.profileId)
                ?.pages.find((item) => item.id === gridEditor.pageId);
              const button = currentPage?.buttons[index];
              return (
                <div
                  className={`grid-preview-cell${button ? " has-button" : ""}`}
                  key={index}
                  title={button?.label ?? `Empty slot ${index + 1}`}
                >
                  {button ? `${index + 1}. ${button.label}` : ""}
                </div>
              );
            })}
          </div>
          {!gridFitsButtons && (
            <p className="button-editor-error" role="alert">
              This layout cannot fit all existing buttons. Increase the grid
              size; no buttons will be removed.
            </p>
          )}
          {(gridEditor.columns < 1 ||
            gridEditor.columns > 8 ||
            gridEditor.rows < 1 ||
            gridEditor.rows > 8 ||
            !Number.isInteger(gridEditor.columns) ||
            !Number.isInteger(gridEditor.rows)) && (
            <p className="button-editor-error" role="alert">
              Grid rows and columns must each be whole numbers between 1 and 8.
            </p>
          )}
          <button
            className="editor-button"
            disabled={
              editorBusy ||
              !gridFitsButtons ||
              gridEditor.columns < 1 ||
              gridEditor.columns > 8 ||
              gridEditor.rows < 1 ||
              gridEditor.rows > 8 ||
              !Number.isInteger(gridEditor.columns) ||
              !Number.isInteger(gridEditor.rows)
            }
            type="submit"
          >
            {editorBusy ? "Saving…" : "Save grid"}
          </button>
        </form>
      )}

      <div className="button-grid-surface">
        {buttons.length === 0 ? (
          <div className="grid-empty-state" role="status">
            <span className="empty-state-mark" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
            <h3>
              {profile && page ? "This page is empty" : "No pages configured"}
            </h3>
            <p>
              Buttons and actions will appear here when they are added to your
              configuration.
            </p>
          </div>
        ) : (
          <div
            className="button-grid"
            style={{
              gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${grid.rows}, minmax(112px, 1fr))`,
            }}
          >
            {buttons.map((button) => {
              const action = button.action_id
                ? actionsById.get(button.action_id)
                : undefined;
              const isMonitor = action?.type === "system_monitor";
              const canExecute =
                authorized &&
                !isMonitor &&
                button.action_id !== null &&
                action !== undefined &&
                isSelectableAction(action, state.configuration);
              const isExecuting =
                button.action_id !== null && executingIds.has(button.action_id);
              const monitorDisplay =
                action?.type === "system_monitor"
                  ? describeMetricValue(
                      action.parameters.metric,
                      visibleMetricsState?.snapshot ?? null,
                      authorized
                        ? visibleMetricsState?.error ?? null
                        : "Connect an authorized client to read local metrics.",
                    )
                  : null;
              const disabledReason =
                isMonitor
                  ? "Read-only live system monitoring."
                  : !authorized
                    ? "Connect an authorized client before running actions."
                  : button.action_id === null
                    ? "No action is assigned."
                  : action && !action.enabled_for_execution
                    ? "This action is not enabled for execution."
                    : action
                      ? null
                      : "The configured action is unavailable.";
              const buttonContents = (
                <>
                  {button.icon && isButtonIcon(button.icon) ? (
                    <span
                      className="configured-button-icon"
                      style={button.color ? { color: button.color } : undefined}
                    >
                      <Icon name={button.icon} />
                    </span>
                  ) : button.icon ? (
                    <span className="configured-button-icon" aria-hidden="true">
                      {button.icon.slice(0, 1).toUpperCase()}
                    </span>
                  ) : null}
                  <span className="configured-button-label">
                    {button.label}
                  </span>
                  <span
                    className="configured-button-action"
                    id={`action-${button.id}`}
                  >
                    {action
                      ? describeAction(action, state.configuration)
                      : button.action_id === null
                        ? "No action assigned"
                        : "Unavailable action"}
                  </span>
                  {isMonitor && monitorDisplay && (
                    <span
                      aria-live="polite"
                      className="system-monitor-value"
                    >
                      {monitorDisplay.value}
                    </span>
                  )}
                  <span
                    className="configured-button-help"
                    id={`action-help-${button.id}`}
                  >
                    {isExecuting
                      ? "Sending action…"
                      : monitorDisplay?.detail ??
                        disabledReason ??
                        "Click to run"}
                  </span>
                </>
              );

              return (
                <div
                  className="button-grid-item"
                  draggable={!editorBusy}
                  key={button.id}
                  onDragStart={(event) => {
                    draggedButtonId.current = button.id;
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    const commandId = event.dataTransfer.getData(
                      "application/x-pocketdeck-command",
                    );
                    if (commandId) {
                      void assignCommand(commandId, button.id);
                      return;
                    }
                    const fromId = draggedButtonId.current;
                    draggedButtonId.current = null;
                    if (fromId) {
                      void moveButton(fromId, button.id);
                    }
                  }}
                  onDragEnd={() => {
                    draggedButtonId.current = null;
                  }}
                >
                  {isMonitor ? (
                    <div
                      aria-describedby={`action-${button.id} action-help-${button.id}`}
                      aria-label={`${button.label} system monitor`}
                      className="configured-button is-monitor"
                      role="group"
                      style={{
                        ...(button.color
                          ? {
                              borderColor: button.color,
                              backgroundColor: `${button.color}24`,
                            }
                          : {}),
                      }}
                    >
                      {buttonContents}
                    </div>
                  ) : (
                    <button
                      aria-busy={isExecuting}
                      aria-describedby={`action-${button.id} action-help-${button.id}`}
                      className={`configured-button${canExecute ? " is-executable" : ""}`}
                      disabled={!canExecute || isExecuting}
                      style={{
                        ...(button.color
                          ? {
                              borderColor: button.color,
                              backgroundColor: `${button.color}24`,
                            }
                          : {}),
                      }}
                      onClick={() => {
                        if (button.action_id !== null) {
                          void runAction(button.action_id);
                        }
                      }}
                      type="button"
                    >
                      {buttonContents}
                    </button>
                  )}
                  <div className="button-editor-actions">
                    <button
                      className="editor-button is-quiet"
                      disabled={editorBusy || page?.buttons[0]?.id === button.id}
                      onClick={() => {
                        const index = page?.buttons.findIndex(
                          (candidate) => candidate.id === button.id,
                        ) ?? -1;
                        const previous = index > 0 ? page?.buttons[index - 1] : null;
                        if (previous) {
                          void moveButton(button.id, previous.id);
                        }
                      }}
                      type="button"
                      aria-label={`Move ${button.label} earlier`}
                    >
                      Up
                    </button>
                    <button
                      className="editor-button is-quiet"
                      disabled={
                        editorBusy ||
                        page?.buttons.at(-1)?.id === button.id
                      }
                      onClick={() => {
                        const index = page?.buttons.findIndex(
                          (candidate) => candidate.id === button.id,
                        ) ?? -1;
                        const next = page?.buttons[index + 1];
                        if (next) {
                          void moveButton(button.id, next.id);
                        }
                      }}
                      type="button"
                      aria-label={`Move ${button.label} later`}
                    >
                      Down
                    </button>
                    <button
                      className="editor-button is-quiet"
                      disabled={editorBusy}
                      onClick={() => {
                        if (profile && page) {
                          beginEdit(button, profile, page);
                        }
                      }}
                      type="button"
                      aria-label={`Edit ${button.label}`}
                    >
                      Edit
                    </button>
                    <button
                      className="editor-button is-quiet is-danger"
                      disabled={editorBusy}
                      onClick={() => void deleteButton(button)}
                      type="button"
                      aria-label={`Delete ${button.label}`}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
            {Array.from({ length: emptySlots }, (_, index) => (
              <div
                aria-hidden="true"
                className="button-slot"
                key={`empty-${index}`}
              />
            ))}
          </div>
        )}
      </div>
      {editor && (
        <form
          aria-label={editor.mode === "create" ? "Add button" : "Edit button"}
          className="button-editor"
          onSubmit={(event) => void submitEditor(event)}
        >
          <div className="button-editor-heading">
            <div>
              <p className="eyebrow">BUTTON SETTINGS</p>
              <h3>{editor.mode === "create" ? "Add a button" : "Edit button"}</h3>
            </div>
            <button
              className="editor-button is-quiet"
              disabled={editorBusy}
              onClick={() => {
                setEditor(null);
                setEditorError(null);
              }}
              type="button"
            >
              Cancel
            </button>
          </div>
          <label className="button-editor-field">
            <span>Button label</span>
            <input
              autoFocus
              maxLength={64}
              onChange={(event) => {
                setEditor({ ...editor, label: event.target.value });
                setEditorError(null);
              }}
              placeholder="e.g. Open Website"
              required
              value={editor.label}
            />
          </label>
          <label className="button-editor-field">
            <span>Icon</span>
            <select
              aria-label="Button icon"
              onChange={(event) =>
                setEditor({ ...editor, icon: event.target.value })
              }
              value={isButtonIcon(editor.icon) ? editor.icon : ""}
            >
              <option value="">Default</option>
              {BUTTON_ICONS.map((icon) => (
                <option key={icon} value={icon}>
                  {icon[0].toUpperCase() + icon.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="button-editor-field">
            <span>Accent color</span>
            <input
              aria-label="Button accent color"
              type="color"
              onChange={(event) =>
                setEditor({ ...editor, color: event.target.value })
              }
              value={/^#[0-9A-Fa-f]{6}$/.test(editor.color) ? editor.color : "#9584ff"}
            />
          </label>
          <div
            aria-label="Button appearance preview"
            className="button-appearance-preview"
            style={{
              borderColor: /^#[0-9A-Fa-f]{6}$/.test(editor.color)
                ? editor.color
                : undefined,
              backgroundColor: /^#[0-9A-Fa-f]{6}$/.test(editor.color)
                ? `${editor.color}24`
                : undefined,
            }}
          >
            {isButtonIcon(editor.icon) && (
              <Icon
                className="configured-button-icon"
                name={editor.icon}
              />
            )}
            <span>{editor.label || "Button preview"}</span>
          </div>
          <label className="button-editor-field">
            <span>Action type</span>
            <select
              aria-label="Action type"
              onChange={(event) => {
                const actionType = event.target.value as ButtonEditorDraft["actionType"];
                setEditor({
                  ...editor,
                  actionType,
                  actionId: null,
                  icon:
                    actionType === "application" && !editor.icon
                      ? "application"
                      : actionType === "system_monitor" && !editor.icon
                        ? "document"
                      : editor.icon,
                });
                setEditorError(null);
              }}
              value={editor.actionType}
            >
              <option value="none">None</option>
              <option value="open_url">Website</option>
              <option value="application">Application</option>
              <option value="system_control">System Control</option>
              <option value="system_monitor">System Monitor (read-only)</option>
              <option value="run_command">Command</option>
              <option value="keyboard_shortcut">Shortcut</option>
              {editor.actionType === "missing" && (
                <option value="missing">Unavailable saved action</option>
              )}
            </select>
          </label>
          {editor.actionType === "none" ? (
            <p className="button-editor-hint">
              No action will be assigned. This button will not run until an
              action is selected.
            </p>
          ) : editor.actionType === "open_url" ||
            editor.actionType === "application" ||
            editor.actionType === "system_control" ||
            editor.actionType === "system_monitor" ? null : (
            <label className="button-editor-field">
              <span>
                {editor.actionType === "run_command"
                  ? "Command"
                  : editor.actionType === "keyboard_shortcut"
                    ? "Shortcut"
                    : "Unavailable action"}
              </span>
              <select
                aria-label="Assigned action"
                disabled={editor.actionType === "missing"}
                onChange={(event) => {
                  setEditor({
                    ...editor,
                    actionId: event.target.value || null,
                  });
                  setEditorError(null);
                }}
                required
                value={editor.actionId ?? ""}
              >
                {editor.actionType === "missing" && editor.actionId && (
                  <option value={editor.actionId}>
                    Unavailable action (reference retained)
                  </option>
                )}
                <option value="">Choose an action</option>
                {[...editorActionOptions, ...(preservedEditorAction ? [preservedEditorAction] : [])].map(
                  (action) => (
                    <option
                      key={action.id}
                      value={action.id}
                      disabled={!isSelectableAction(action, state.configuration)}
                    >
                      {actionOptionLabels.get(action.id) ??
                        `Unavailable ${action.type} action`}
                      {!isSelectableAction(action, state.configuration)
                        ? " · Disabled"
                        : ""}
                    </option>
                  ),
                )}
              </select>
            </label>
          )}
          {editor.actionType !== "none" &&
            editor.actionType !== "missing" &&
          editor.actionType !== "open_url" &&
            editor.actionType !== "system_monitor" &&
            editorActionOptions.length === 0 && (
                <p className="button-editor-hint" role="status">
                  No enabled {editor.actionType === "run_command"
                    ? "commands"
                    : editor.actionType === "keyboard_shortcut"
                      ? "shortcuts"
                      : editor.actionType === "system_control"
                        ? "system controls"
                      : "website actions"} are available. Create one inline, choose
                  another action type, or select None.
              </p>
            )}
          {selectedEditorAction && (
            <p aria-live="polite" className="button-editor-hint">
              Selected: {describeAction(selectedEditorAction, state.configuration)}
              {!selectedEditorAction.enabled_for_execution &&
                selectedEditorAction.type !== "system_monitor" &&
                " (disabled)"}
            </p>
          )}
          {editor.actionType === "open_url" && (
            <>
              <label className="button-editor-field">
                <span>Saved website</span>
                <select
                  aria-label="Saved website"
                  onChange={(event) => {
                    const actionId = event.target.value || null;
                    const selected = actionId
                      ? state.configuration.actions.find(
                          (item) => item.id === actionId && item.type === "open_url",
                        )
                      : undefined;
                    setEditor({
                      ...editor,
                      actionId,
                      websiteName:
                        selected?.type === "open_url"
                          ? selected.parameters.name ??
                            new URL(selected.parameters.url).hostname
                          : "",
                      websiteUrl:
                        selected?.type === "open_url"
                          ? selected.parameters.url
                          : "",
                    });
                    setEditorError(null);
                  }}
                  value={editor.actionId ?? ""}
                >
                  <option value="">Create a new website</option>
                  {editorActionOptions.map((website) => (
                    <option key={website.id} value={website.id}>
                      {actionOptionLabels.get(website.id) ?? "Website"}
                    </option>
                  ))}
                  {preservedEditorAction?.type === "open_url" && (
                    <option value={preservedEditorAction.id}>
                      {actionOptionLabels.get(preservedEditorAction.id) ??
                        "Unavailable website"}
                    </option>
                  )}
                </select>
              </label>
              <label className="button-editor-field">
                <span>Website name</span>
                <input
                  aria-label="Website name"
                  maxLength={64}
                  onChange={(event) =>
                    setEditor({ ...editor, websiteName: event.target.value })
                  }
                  placeholder="e.g. PocketDeck"
                  value={editor.websiteName}
                />
              </label>
              <label className="button-editor-field">
                <span>HTTP or HTTPS URL</span>
                <input
                  aria-label="Website URL"
                  maxLength={2048}
                  onChange={(event) =>
                    setEditor({ ...editor, websiteUrl: event.target.value })
                  }
                  placeholder="https://example.com"
                  type="text"
                  value={editor.websiteUrl}
                />
              </label>
            </>
          )}
          {editor.actionType === "application" && (
            <>
              <label className="button-editor-field">
                <span>Saved application</span>
                <select
                  aria-label="Saved application"
                  onChange={(event) => {
                    const actionId = event.target.value || null;
                    const selected = actionId
                      ? state.configuration.actions.find(
                          (item) =>
                            item.id === actionId && item.type === "application",
                        )
                      : undefined;
                    setEditor({
                      ...editor,
                      actionId,
                      applicationName:
                        selected?.type === "application"
                          ? selected.parameters.name
                          : "",
                      applicationPath:
                        selected?.type === "application"
                          ? selected.parameters.path
                          : "",
                    });
                    setEditorError(null);
                  }}
                  value={editor.actionId ?? ""}
                >
                  <option value="">Select or add an application</option>
                  {editorActionOptions
                    .filter((action) => action.type === "application")
                    .map((application) => (
                      <option key={application.id} value={application.id}>
                        {actionOptionLabels.get(application.id) ?? "Application"}
                      </option>
                    ))}
                  {preservedEditorAction?.type === "application" && (
                    <option value={preservedEditorAction.id}>
                      {preservedEditorAction.parameters.name}
                    </option>
                  )}
                </select>
              </label>
              <label className="button-editor-field">
                <span>Application name</span>
                <input
                  aria-label="Application name"
                  maxLength={64}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      applicationName: event.target.value,
                    })
                  }
                  placeholder="e.g. Visual Studio Code"
                  value={editor.applicationName}
                />
              </label>
              <label className="button-editor-field">
                <span>Executable path</span>
                <input
                  aria-label="Application executable path"
                  maxLength={32768}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      applicationPath: event.target.value,
                      applicationName:
                        editor.applicationName ||
                        applicationNameFromPath(event.target.value),
                    })
                  }
                  placeholder="C:\\Program Files\\Example\\app.exe"
                  value={editor.applicationPath}
                />
              </label>
              <button
                className="editor-button is-quiet"
                disabled={!isApplicationPickerAvailable() || applicationPickerBusy}
                onClick={() => void chooseApplication()}
                type="button"
              >
                {applicationPickerBusy ? "Choosing…" : "Browse for executable"}
              </button>
              {!isApplicationPickerAvailable() && (
                <p className="button-editor-hint" role="status">
                  The native executable picker is available in the Windows
                  desktop app. An absolute .exe path can be entered manually.
                </p>
              )}
              <p className="button-editor-hint">
                The selected program runs with the current Windows user’s
                permissions. Only choose executables you trust.
              </p>
            </>
          )}
          {editor.actionType === "system_control" && (
            <>
              <label className="button-editor-field">
                <span>Saved system control</span>
                <select
                  aria-label="Saved system control"
                  onChange={(event) => {
                    const actionId = event.target.value || null;
                    const selected = actionId
                      ? state.configuration.actions.find(
                          (item) =>
                            item.id === actionId &&
                            item.type === "system_control",
                        )
                      : undefined;
                    const control =
                      selected?.type === "system_control"
                        ? selected.parameters.control
                        : "";
                    setEditor({
                      ...editor,
                      actionId,
                      systemControl: control,
                      icon:
                        control &&
                        (!editor.icon ||
                          ["application", "volume", "brightness"].includes(
                            editor.icon,
                          ))
                          ? SYSTEM_CONTROL_ICONS[control]
                          : editor.icon,
                    });
                    setEditorError(null);
                  }}
                  value={editor.actionId ?? ""}
                >
                  <option value="">Create a new system control</option>
                  {editorActionOptions
                    .filter((action) => action.type === "system_control")
                    .map((action) => (
                      <option key={action.id} value={action.id}>
                        {actionOptionLabels.get(action.id) ?? "System control"}
                      </option>
                    ))}
                  {preservedEditorAction?.type === "system_control" && (
                    <option value={preservedEditorAction.id}>
                      {SYSTEM_CONTROL_LABELS[
                        preservedEditorAction.parameters.control
                      ]}
                    </option>
                  )}
                </select>
              </label>
              <label className="button-editor-field">
                <span>System control</span>
                <select
                  aria-label="System control"
                  onChange={(event) => {
                    const control = event.target.value as SystemControlName | "";
                    setEditor({
                      ...editor,
                      systemControl: control,
                      icon:
                        control &&
                        (!editor.icon ||
                          ["application", "volume", "brightness"].includes(
                            editor.icon,
                          ))
                        ? SYSTEM_CONTROL_ICONS[control]
                        : editor.icon,
                    });
                    setEditorError(null);
                  }}
                  value={editor.systemControl}
                >
                  <option value="">Choose an operation</option>
                  {Object.entries(SYSTEM_CONTROL_LABELS).map(
                    ([control, label]) => (
                      <option key={control} value={control}>
                        {label}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <p className="button-editor-hint">
                Volume uses Windows multimedia keys. Brightness works only when
                the display driver exposes Windows monitor brightness controls.
              </p>
            </>
          )}
          {editor.actionType === "system_monitor" && (
            <>
              <label className="button-editor-field">
                <span>Saved system monitor</span>
                <select
                  aria-label="Saved system monitor"
                  onChange={(event) => {
                    const actionId = event.target.value || null;
                    const selected = actionId
                      ? state.configuration.actions.find(
                          (item) =>
                            item.id === actionId &&
                            item.type === "system_monitor",
                        )
                      : undefined;
                    setEditor({
                      ...editor,
                      actionId,
                      systemMetric:
                        selected?.type === "system_monitor"
                          ? selected.parameters.metric
                          : "",
                    });
                    setEditorError(null);
                  }}
                  value={editor.actionId ?? ""}
                >
                  <option value="">Create a new system monitor</option>
                  {editorActionOptions
                    .filter((action) => action.type === "system_monitor")
                    .map((action) => (
                      <option key={action.id} value={action.id}>
                        {actionOptionLabels.get(action.id) ?? "System monitor"}
                      </option>
                    ))}
                  {preservedEditorAction?.type === "system_monitor" && (
                    <option value={preservedEditorAction.id}>
                      {SYSTEM_METRIC_LABELS[
                        preservedEditorAction.parameters.metric
                      ]}
                    </option>
                  )}
                </select>
              </label>
              <label className="button-editor-field">
                <span>System metric</span>
                <select
                  aria-label="System metric"
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      systemMetric: event.target.value as
                        | SystemMetricName
                        | "",
                    })
                  }
                  value={editor.systemMetric}
                >
                  <option value="">Choose a metric</option>
                  {Object.entries(SYSTEM_METRIC_LABELS).map(
                    ([metric, label]) => (
                      <option key={metric} value={metric}>
                        {label}
                      </option>
                    ),
                  )}
                </select>
              </label>
              <p className="button-editor-hint">
                Monitoring is read-only. GPU and temperature readings require
                supported sensor hardware and may be unavailable.
              </p>
            </>
          )}
          {editor.actionType === "run_command" && (
            <div className="studio-list-actions">
              <button
                className="editor-button is-quiet"
                onClick={() =>
                  setInlineActionEditor({ type: "command", mode: "create" })
                }
                type="button"
              >
                Create command inline
              </button>
              {selectedCommand && (
                <>
                  <button
                    className="editor-button is-quiet"
                    onClick={() =>
                      setInlineActionEditor({
                        type: "command",
                        mode: "edit",
                        item: selectedCommand,
                      })
                    }
                    type="button"
                  >
                    Edit command inline
                  </button>
                  <button
                    className="editor-button is-quiet"
                    onClick={() =>
                      setInlineActionEditor({
                        type: "command",
                        mode: "duplicate",
                        item: selectedCommand,
                      })
                    }
                    type="button"
                  >
                    Duplicate command inline
                  </button>
                </>
              )}
            </div>
          )}
          {editor.actionType === "keyboard_shortcut" && (
            <div className="studio-list-actions">
              <button
                className="editor-button is-quiet"
                onClick={() =>
                  setInlineActionEditor({ type: "shortcut", mode: "create" })
                }
                type="button"
              >
                Record shortcut inline
              </button>
              {selectedShortcut && (
                <>
                  <button
                    className="editor-button is-quiet"
                    onClick={() =>
                      setInlineActionEditor({
                        type: "shortcut",
                        mode: "edit",
                        item: selectedShortcut,
                      })
                    }
                    type="button"
                  >
                    Edit shortcut inline
                  </button>
                  <button
                    className="editor-button is-quiet"
                    onClick={() =>
                      setInlineActionEditor({
                        type: "shortcut",
                        mode: "duplicate",
                        item: selectedShortcut,
                      })
                    }
                    type="button"
                  >
                    Duplicate shortcut inline
                  </button>
                </>
              )}
            </div>
          )}
          {inlineActionEditor && (
            <InlineActionEditor
              key={`${inlineActionEditor.type}:${inlineActionEditor.mode}:${inlineActionEditor.item?.id ?? "new"}`}
              configuration={state.configuration}
              onCancel={() => setInlineActionEditor(null)}
              onSaved={(actionId) => {
                const actionType = inlineActionEditor.type === "command"
                  ? "run_command"
                  : "keyboard_shortcut";
                setEditor((current) =>
                  current ? { ...current, actionId, actionType } : current,
                );
                setInlineActionEditor(null);
                setEditorError(null);
                setEditorMessage({
                  kind: "success",
                  text: "Saved. Your button draft is still open.",
                });
              }}
              request={inlineActionEditor}
              saveConfiguration={saveConfiguration}
            />
          )}
          <p className="button-editor-hint">
            Button labels are unique within this page and do not rename actions.
          </p>
          {editorError && (
            <p className="button-editor-error" role="alert">
              {editorError}
            </p>
          )}
          <button
            className="editor-button"
            disabled={editorBusy}
            type="submit"
          >
            {editorBusy
              ? "Saving…"
              : editor.mode === "create"
                ? "Add button"
                : "Save button"}
          </button>
        </form>
      )}
      <p className="configuration-revision">
        Configuration revision {state.revision}
      </p>
      {editorMessage && (
        <p
          className={`action-execution-message is-${editorMessage.kind}`}
          role={editorMessage.kind === "error" ? "alert" : "status"}
        >
          {editorMessage.text}
        </p>
      )}
      {refreshError && (
        <p className="action-execution-message is-error" role="alert">
          Could not refresh configuration: {refreshError}
        </p>
      )}
      {executionMessage && (
        <p
          className={`action-execution-message is-${executionMessage.kind}`}
          role={executionMessage.kind === "error" ? "alert" : "status"}
        >
          {executionMessage.text}
        </p>
      )}
      {buttons.length > 0 && (
        <p className="display-only-note">
          Enabled website and keyboard shortcut actions are available. Keyboard
          shortcuts are sent to the active Windows window.
        </p>
      )}
    </section>
  );
}
