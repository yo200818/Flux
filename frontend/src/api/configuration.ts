import { API_BASE_URL } from "./baseUrl";
import { addAuthorizationHeader } from "./authorization";
import { normalizeShortcut } from "./keyboardShortcut";

export interface GridConfiguration {
  columns: number;
  rows: number;
}

export interface ApplicationAction {
  id: string;
  type: "application";
  enabled_for_execution: boolean;
  parameters: { name: string; path: string };
  logo_asset_id?: string | null;
}

export type SystemControlName =
  | "volume_up"
  | "volume_down"
  | "mute_toggle"
  | "brightness_up"
  | "brightness_down";

export interface SystemControlAction {
  id: string;
  type: "system_control";
  enabled_for_execution: boolean;
  parameters: { control: SystemControlName };
  logo_asset_id?: string | null;
}

export type SystemMetricName =
  | "cpu_utilization"
  | "memory_usage"
  | "gpu_utilization"
  | "gpu_temperature"
  | "cpu_temperature";

export interface SystemMonitorAction {
  id: string;
  type: "system_monitor";
  enabled_for_execution: false;
  parameters: { metric: SystemMetricName };
  logo_asset_id?: string | null;
}

export interface ButtonConfiguration {
  id: string;
  label: string;
  icon?: string | null;
  color?: string | null;
  logo_asset_id?: string | null;
  action_id: string | null;
}
export interface PageConfiguration {
  id: string;
  name: string;
  grid: GridConfiguration;
  buttons: ButtonConfiguration[];
}
export interface ProfileConfiguration {
  id: string;
  name: string;
  logo_asset_id?: string | null;
  pages: PageConfiguration[];
}

export interface OpenUrlAction {
  id: string;
  type: "open_url";
  enabled_for_execution: boolean;
  parameters: { url: string; name?: string };
  logo_asset_id?: string | null;
}

export interface KeyboardShortcutAction {
  id: string;
  type: "keyboard_shortcut";
  enabled_for_execution: boolean;
  parameters: { shortcut: string } | { shortcut_id: string };
  logo_asset_id?: string | null;
}

export interface RunCommandAction {
  id: string;
  type: "run_command";
  enabled_for_execution: boolean;
  parameters: { command_id: string };
  logo_asset_id?: string | null;
}

export type ActionConfiguration =
  | OpenUrlAction
  | ApplicationAction
  | SystemControlAction
  | SystemMonitorAction
  | KeyboardShortcutAction
  | RunCommandAction;

export interface SavedShortcutConfiguration {
  id: string;
  name: string;
  shortcut: string;
}

export type CommandStepConfiguration =
  | { type: "open_url"; parameters: { url: string } }
  | {
      type: "keyboard_shortcut";
      parameters: { shortcut: string } | { shortcut_id: string };
    }
  | { type: "wait"; parameters: { milliseconds: number } };

export interface CustomCommandConfiguration {
  id: string;
  definition_version: 1;
  name: string;
  description?: string;
  category: string;
  enabled: boolean;
  steps: CommandStepConfiguration[];
}

export interface PocketDeckConfiguration {
  schema_version: 1;
  profiles: ProfileConfiguration[];
  actions: ActionConfiguration[];
  commands: CustomCommandConfiguration[];
  shortcuts: SavedShortcutConfiguration[];
  settings: { confirm_commands: boolean };
}

export interface ConfigurationSnapshot {
  revision: number;
  configuration: PocketDeckConfiguration;
}

export class ConfigurationRevisionConflictError extends Error {
  constructor(
    public readonly expectedRevision: number,
    public readonly currentRevision: number | null,
    public readonly latestSnapshot: ConfigurationSnapshot | null,
  ) {
    super(
      currentRevision === null
        ? "Configuration changed on the backend. The latest version could not be loaded."
        : `Configuration changed on the backend (revision ${currentRevision}; this edit used revision ${expectedRevision}).`,
    );
    this.name = "ConfigurationRevisionConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
): boolean {
  const keySet = new Set(allowedKeys);
  return Object.keys(value).every((key) => keySet.has(key));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isHttpOrHttpsUrl(value: unknown): value is string {
  if (!isString(value) || value.length > 2048) {
    return false;
  }
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

function isId(value: unknown): value is string {
  return (
    isString(value) &&
    value.length <= 64 &&
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
  );
}

function isLogoAssetId(value: unknown): value is string {
  return isString(value) && /^logo_[a-f0-9]{32}$/.test(value);
}

function isOptionalLogoAssetId(value: unknown): boolean {
  return value === undefined || value === null || isLogoAssetId(value);
}

function isName(value: unknown): value is string {
  return isString(value) && value.length > 0 && value.length <= 64;
}

function isWindowsExecutablePath(value: unknown): value is string {
  return (
    isString(value) &&
    value.length <= 32768 &&
    /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/])/.test(value) &&
    /\.exe$/i.test(value) &&
    !/[<>:"|?*\0]/.test(value.replace(/^[A-Za-z]:/, ""))
  );
}

function isSupportedShortcut(value: unknown): value is string {
  if (!isString(value) || value.length > 64) {
    return false;
  }
  try {
    normalizeShortcut(value);
    return true;
  } catch {
    return false;
  }
}

function isActionConfiguration(value: unknown): value is ActionConfiguration {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "type", "enabled_for_execution", "parameters", "logo_asset_id"]) ||
    !isId(value.id) ||
    typeof value.enabled_for_execution !== "boolean" ||
    !isOptionalLogoAssetId(value.logo_asset_id) ||
    !isRecord(value.parameters)
  ) {
    return false;
  }

  if (value.type === "open_url") {
    return (
      hasOnlyKeys(value.parameters, ["url", "name"]) &&
      isHttpOrHttpsUrl(value.parameters.url) &&
      (value.parameters.name === undefined || isName(value.parameters.name))
    );
  }
  if (value.type === "application") {
    return (
      hasOnlyKeys(value.parameters, ["name", "path"]) &&
      isName(value.parameters.name) &&
      isWindowsExecutablePath(value.parameters.path)
    );
  }
  if (value.type === "system_control") {
    return (
      hasOnlyKeys(value.parameters, ["control"]) &&
      typeof value.parameters.control === "string" &&
      [
        "volume_up",
        "volume_down",
        "mute_toggle",
        "brightness_up",
        "brightness_down",
      ].includes(value.parameters.control)
    );
  }
  if (value.type === "system_monitor") {
    return (
      value.enabled_for_execution === false &&
      hasOnlyKeys(value.parameters, ["metric"]) &&
      [
        "cpu_utilization",
        "memory_usage",
        "gpu_utilization",
        "gpu_temperature",
        "cpu_temperature",
      ].includes(String(value.parameters.metric))
    );
  }
  if (value.type === "keyboard_shortcut") {
    return (
      (hasOnlyKeys(value.parameters, ["shortcut"]) &&
        "shortcut" in value.parameters &&
        isSupportedShortcut(value.parameters.shortcut) &&
        !("shortcut_id" in value.parameters)) ||
      (hasOnlyKeys(value.parameters, ["shortcut_id"]) &&
        "shortcut_id" in value.parameters &&
        isId(value.parameters.shortcut_id) &&
        !("shortcut" in value.parameters))
    );
  }
  if (value.type === "run_command") {
    return (
      hasOnlyKeys(value.parameters, ["command_id"]) &&
      isId(value.parameters.command_id)
    );
  }
  return false;
}

function isButtonConfiguration(value: unknown): value is ButtonConfiguration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "label", "icon", "color", "logo_asset_id", "action_id"]) &&
    isId(value.id) &&
    isName(value.label) &&
    (value.icon === undefined ||
      value.icon === null ||
      (isString(value.icon) && value.icon.length > 0 && value.icon.length <= 128)) &&
    (value.color === undefined ||
      value.color === null ||
      (isString(value.color) && /^#[0-9A-Fa-f]{6}$/.test(value.color))) &&
    isOptionalLogoAssetId(value.logo_asset_id) &&
    (value.action_id === null || isId(value.action_id))
  );
}

function isPageConfiguration(value: unknown): value is PageConfiguration {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "name", "grid", "buttons"]) ||
    !isId(value.id) ||
    !isName(value.name) ||
    !isRecord(value.grid) ||
    typeof value.grid.columns !== "number" ||
    !Number.isInteger(value.grid.columns) ||
    value.grid.columns < 1 ||
    value.grid.columns > 8 ||
    typeof value.grid.rows !== "number" ||
    !Number.isInteger(value.grid.rows) ||
    value.grid.rows < 1 ||
    value.grid.rows > 8 ||
    !Array.isArray(value.buttons) ||
    value.buttons.length > 64 ||
    !value.buttons.every(isButtonConfiguration)
  ) {
    return false;
  }
  return value.buttons.length <= value.grid.columns * value.grid.rows;
}

function isProfileConfiguration(
  value: unknown,
): value is ProfileConfiguration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "name", "logo_asset_id", "pages"]) &&
    isId(value.id) &&
    isName(value.name) &&
    isOptionalLogoAssetId(value.logo_asset_id) &&
    Array.isArray(value.pages) &&
    value.pages.length > 0 &&
    value.pages.length <= 32 &&
    value.pages.every(isPageConfiguration)
  );
}

export function isPocketDeckConfiguration(
  value: unknown,
): value is PocketDeckConfiguration {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schema_version", "profiles", "actions", "commands", "shortcuts", "settings"])) {
    return false;
  }
  const commands = value.commands === undefined ? [] : value.commands;
  const shortcuts = value.shortcuts === undefined ? [] : value.shortcuts;
  const profiles = value.profiles;
  const actions = value.actions;
  return (
    value.schema_version === 1 &&
    Array.isArray(profiles) &&
    profiles.length > 0 &&
    profiles.length <= 32 &&
    profiles.every(isProfileConfiguration) &&
    Array.isArray(actions) &&
    actions.length > 0 &&
    actions.length <= 128 &&
    actions.every(isActionConfiguration) &&
    Array.isArray(commands) &&
    commands.length <= 64 &&
    commands.every(isCustomCommandConfiguration) &&
    Array.isArray(shortcuts) &&
    shortcuts.length <= 64 &&
    shortcuts.every(isSavedShortcutConfiguration) &&
    (value.settings === undefined ||
      (isRecord(value.settings) &&
        hasOnlyKeys(value.settings, ["confirm_commands"]) &&
        typeof value.settings.confirm_commands === "boolean")) &&
    hasUniqueIdsAndActionReferences(
      profiles,
      actions,
      commands,
      shortcuts,
    )
  );
}

function normalizeConfiguration(value: unknown): PocketDeckConfiguration | null {
  if (!isRecord(value)) {
    return null;
  }
  const normalized = {
    ...value,
    commands: value.commands === undefined ? [] : value.commands,
    shortcuts: value.shortcuts === undefined ? [] : value.shortcuts,
    settings:
      value.settings === undefined
        ? { confirm_commands: false }
        : value.settings,
  };
  return isPocketDeckConfiguration(normalized) ? normalized : null;
}

function isSavedShortcutConfiguration(
  value: unknown,
): value is SavedShortcutConfiguration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "name", "shortcut"]) &&
    isId(value.id) &&
    isName(value.name) &&
    isString(value.shortcut) &&
    isSupportedShortcut(value.shortcut)
  );
}

function isCommandStepConfiguration(
  value: unknown,
): value is CommandStepConfiguration {
  if (!isRecord(value) || !hasOnlyKeys(value, ["type", "parameters"]) || !isRecord(value.parameters)) {
    return false;
  }
  if (value.type === "open_url") {
    return (
      hasOnlyKeys(value.parameters, ["url", "name"]) &&
      isHttpOrHttpsUrl(value.parameters.url) &&
      (value.parameters.name === undefined || isName(value.parameters.name))
    );
  }
  if (value.type === "keyboard_shortcut") {
    return (
      (hasOnlyKeys(value.parameters, ["shortcut"]) &&
        "shortcut" in value.parameters &&
        isSupportedShortcut(value.parameters.shortcut) &&
        !("shortcut_id" in value.parameters)) ||
      (hasOnlyKeys(value.parameters, ["shortcut_id"]) &&
        "shortcut_id" in value.parameters &&
        isId(value.parameters.shortcut_id) &&
        !("shortcut" in value.parameters))
    );
  }
  return (
    value.type === "wait" &&
    hasOnlyKeys(value.parameters, ["milliseconds"]) &&
    typeof value.parameters.milliseconds === "number" &&
    Number.isInteger(value.parameters.milliseconds) &&
    value.parameters.milliseconds >= 0 &&
    value.parameters.milliseconds <= 10000
  );
}

function isCustomCommandConfiguration(
  value: unknown,
): value is CustomCommandConfiguration {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, [
      "id",
      "definition_version",
      "name",
      "description",
      "category",
      "enabled",
      "steps",
    ]) &&
    isId(value.id) &&
    (value.definition_version === undefined || value.definition_version === 1) &&
    isName(value.name) &&
    (value.description === undefined ||
      (isString(value.description) && value.description.length <= 256)) &&
    isName(value.category) &&
    value.category.length <= 32 &&
    typeof value.enabled === "boolean" &&
    Array.isArray(value.steps) &&
    value.steps.length >= 1 &&
    value.steps.length <= 20 &&
    value.steps.every(isCommandStepConfiguration)
  );
}

function hasUniqueIdsAndActionReferences(
  profiles: unknown[],
  actions: unknown[],
  commands: unknown[],
  shortcuts: unknown[],
): boolean {
  const ids = new Set<string>();
  const actionIds = new Set<string>();
  const addId = (id: string) => {
    if (ids.has(id)) {
      return false;
    }
    ids.add(id);
    return true;
  };

  for (const action of actions) {
    if (!isActionConfiguration(action) || !addId(action.id)) {
      return false;
    }
    actionIds.add(action.id);
  }

  const commandIds = new Set<string>();
  for (const command of commands) {
    if (!isCustomCommandConfiguration(command) || !addId(command.id)) {
      return false;
    }
    commandIds.add(command.id);
  }
  const shortcutIds = new Set<string>();
  for (const shortcut of shortcuts) {
    if (!isSavedShortcutConfiguration(shortcut) || !addId(shortcut.id)) {
      return false;
    }
    shortcutIds.add(shortcut.id);
  }

  for (const action of actions) {
    if (!isActionConfiguration(action)) {
      return false;
    }
    if (action.type === "run_command" && !commandIds.has(action.parameters.command_id)) {
      return false;
    }
    if (
      action.type === "keyboard_shortcut" &&
      "shortcut_id" in action.parameters &&
      !shortcutIds.has(action.parameters.shortcut_id)
    ) {
      return false;
    }
  }
  for (const command of commands) {
    if (!isCustomCommandConfiguration(command)) {
      return false;
    }
    for (const step of command.steps) {
      if (
        step.type === "keyboard_shortcut" &&
        "shortcut_id" in step.parameters &&
        !shortcutIds.has(step.parameters.shortcut_id)
      ) {
        return false;
      }
    }
  }

  for (const profile of profiles) {
    if (!isProfileConfiguration(profile) || !addId(profile.id)) {
      return false;
    }
    for (const page of profile.pages) {
      if (!addId(page.id)) {
        return false;
      }
      for (const button of page.buttons) {
        if (
          !addId(button.id) ||
          (button.action_id !== null && !actionIds.has(button.action_id))
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

export async function getConfiguration(
  signal?: AbortSignal,
): Promise<ConfigurationSnapshot> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/api/config`, {
      headers: addAuthorizationHeader({ Accept: "application/json" }),
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    throw new Error("Could not reach the PocketDeck configuration.", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error(`Configuration request failed (${response.status}).`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Backend returned an invalid configuration response.");
  }

  const savedConfiguration = isRecord(body)
    ? normalizeConfiguration(body.configuration)
    : null;
  if (
    !isRecord(body) ||
    typeof body.revision !== "number" ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0 ||
    !savedConfiguration
  ) {
    throw new Error("Backend returned an unsupported configuration response.");
  }
  return {
    revision: body.revision,
    configuration: savedConfiguration,
  };
}

export async function updateConfiguration(
  configuration: PocketDeckConfiguration,
  expectedRevision: number,
): Promise<ConfigurationSnapshot> {
  if (!isPocketDeckConfiguration(configuration)) {
    throw new Error("The configuration is invalid and cannot be saved.");
  }

  let response: Response;
  try {
    response = await fetch(
      `${API_BASE_URL}/api/config?expected_revision=${expectedRevision}`,
      {
        method: "PUT",
        headers: addAuthorizationHeader({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify(configuration),
      },
    );
  } catch (error) {
    throw new Error("Could not save the PocketDeck configuration.", {
      cause: error,
    });
  }

  if (response.status === 409) {
    let currentRevision: number | null = null;
    try {
      const body: unknown = await response.json();
      if (
        isRecord(body) &&
        isRecord(body.error) &&
        typeof body.error.current_revision === "number" &&
        Number.isSafeInteger(body.error.current_revision)
      ) {
        currentRevision = body.error.current_revision;
      }
    } catch {
      currentRevision = null;
    }

    let latestSnapshot: ConfigurationSnapshot | null = null;
    try {
      const snapshot = await getConfiguration();
      latestSnapshot = snapshot;
      currentRevision = snapshot.revision;
    } catch {
      // Keep the revision from the conflict response when refresh is unavailable.
    }
    throw new ConfigurationRevisionConflictError(
      expectedRevision,
      currentRevision,
      latestSnapshot,
    );
  }

  if (!response.ok) {
    let message = `Configuration save failed (${response.status}).`;
    try {
      const body: unknown = await response.json();
      if (
        isRecord(body) &&
        isRecord(body.error) &&
        typeof body.error.message === "string"
      ) {
        message = body.error.message;
      }
    } catch {
      // Keep the HTTP status message when the backend response has no JSON body.
    }
    throw new Error(message);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("Backend returned an invalid configuration save response.");
  }
  const savedConfiguration = isRecord(body)
    ? normalizeConfiguration(body.configuration)
    : null;
  if (
    !isRecord(body) ||
    typeof body.revision !== "number" ||
    !Number.isSafeInteger(body.revision) ||
    body.revision < 0 ||
    !savedConfiguration
  ) {
    throw new Error("Backend returned an unsupported configuration response.");
  }
  return {
    revision: body.revision,
    configuration: savedConfiguration,
  };
}

export interface UploadedLogoAsset {
  asset_id: string;
  content_type: "image/webp";
  width: number;
  height: number;
}

const SUPPORTED_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_LOGO_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function uploadLogoAsset(file: File): Promise<UploadedLogoAsset> {
  if (!SUPPORTED_LOGO_TYPES.has(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  if (file.size < 1 || file.size > MAX_LOGO_UPLOAD_BYTES) {
    throw new Error("Images must be between 1 byte and 5 MiB.");
  }
  const response = await fetch(`${API_BASE_URL}/api/logo-assets`, {
    method: "POST",
    headers: addAuthorizationHeader({ "Content-Type": file.type }),
    body: file,
  });
  if (!response.ok) {
    let message = `Logo upload failed (${response.status}).`;
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body.detail === "string") {
        message = body.detail;
      }
    } catch {
      // Keep the explicit HTTP status when the server did not return JSON.
    }
    throw new Error(message);
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error("The backend returned an invalid logo asset response.");
  }
  if (!isRecord(result)) {
    throw new Error("The backend returned an invalid logo asset response.");
  }
  const assetId = result.asset_id;
  const width = result.width;
  const height = result.height;
  if (
    !isLogoAssetId(assetId) ||
    result.content_type !== "image/webp" ||
    typeof width !== "number" ||
    !Number.isInteger(width) ||
    width < 1 ||
    typeof height !== "number" ||
    !Number.isInteger(height) ||
    height < 1
  ) {
    throw new Error("The backend returned an invalid logo asset response.");
  }
  return {
    asset_id: assetId,
    content_type: "image/webp",
    width,
    height,
  };
}

export async function getLogoAsset(
  assetId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!isLogoAssetId(assetId)) {
    throw new Error("The logo reference is invalid.");
  }
  const response = await fetch(
    `${API_BASE_URL}/api/logo-assets/${encodeURIComponent(assetId)}`,
    {
      headers: addAuthorizationHeader({ Accept: "image/webp" }),
      signal,
    },
  );
  if (!response.ok) {
    throw new Error(`Logo preview is unavailable (${response.status}).`);
  }
  if (response.headers.get("content-type")?.split(";")[0] !== "image/webp") {
    throw new Error("The backend returned an unsupported logo image.");
  }
  return response.blob();
}
