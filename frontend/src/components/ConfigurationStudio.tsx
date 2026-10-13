import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  approvePairingRequest,
  createPairingSession,
  getWifiConnectionInfo,
  listManagedDevices,
  listPairingRequests,
  rejectPairingRequest,
  revokeDevice,
  uploadConfigurationToDevice,
  windowsConnectionQrPayload,
  type ManagedDevice,
  type PairingRequest,
  type PairingSession,
  type WifiConnectionInfo,
} from "../api/devices";
import {
  isPocketDeckConfiguration,
  type CommandStepConfiguration,
  type CustomCommandConfiguration,
  type PocketDeckConfiguration,
  type SavedShortcutConfiguration,
} from "../api/configuration";
import {
  commandActionId,
  createConfigurationId as newId,
  withSavedCommand,
  withSavedShortcut,
} from "../api/configurationEdits";
import { saveConfigurationExport } from "../api/configurationExport";
import {
  getLaunchAtLogin,
  setLaunchAtLogin,
} from "../api/companionLifecycle";
import {
  disableUsbReverse,
  enableUsbReverse,
  listUsbAndroidDevices,
  type UsbAndroidDevice,
} from "../api/usbTransport";
import { normalizeShortcut } from "../api/keyboardShortcut";
import type { ConfigurationState } from "../hooks/useConfiguration";
import type { SectionId } from "./Sidebar";
import { ShortcutRecorder } from "./ShortcutRecorder";
import { LogoAssetPicker } from "./LogoAssetPicker";

interface ConfigurationStudioProps {
  section: Exclude<SectionId, "dashboard">;
  state: ConfigurationState;
  saveConfiguration: (configuration: PocketDeckConfiguration) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  adminDeviceAccess: boolean;
  backendConnected: boolean;
}

interface StepDraft {
  type: CommandStepConfiguration["type"];
  value: string;
  milliseconds: number;
}

interface CommandDraft {
  id: string | null;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  steps: StepDraft[];
}

const NEW_STEP: StepDraft = { type: "open_url", value: "", milliseconds: 500 };

function newCommandDraft(): CommandDraft {
  return {
    id: null,
    name: "",
    description: "",
    category: "General",
    enabled: true,
    steps: [{ ...NEW_STEP }],
  };
}

function toStepDraft(step: CommandStepConfiguration): StepDraft {
  if (step.type === "open_url") {
    return { type: step.type, value: step.parameters.url, milliseconds: 0 };
  }
  if (step.type === "wait") {
    return {
      type: step.type,
      value: "",
      milliseconds: step.parameters.milliseconds,
    };
  }
  return {
    type: step.type,
    value:
      "shortcut_id" in step.parameters
        ? `shortcut:${step.parameters.shortcut_id}`
        : step.parameters.shortcut,
    milliseconds: 0,
  };
}

export function ConfigurationStudio({
  section,
  state,
  saveConfiguration,
  onDirtyChange,
  adminDeviceAccess,
  backendConnected,
}: ConfigurationStudioProps) {
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  const [shortcutName, setShortcutName] = useState("");
  const [shortcutValue, setShortcutValue] = useState("");
  const [shortcutId, setShortcutId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [pageName, setPageName] = useState("");
  const [targetProfileId, setTargetProfileId] = useState("");
  const [renameProfile, setRenameProfile] = useState("");
  const [renamePage, setRenamePage] = useState("");
  const [renameProfileId, setRenameProfileId] = useState("");
  const [renamePageId, setRenamePageId] = useState("");
  const [managedDevices, setManagedDevices] = useState<ManagedDevice[]>([]);
  const [pairingRequests, setPairingRequests] = useState<PairingRequest[]>([]);
  const [pairingSession, setPairingSession] = useState<PairingSession | null>(null);
  const [approvedCredential, setApprovedCredential] = useState<string | null>(null);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [deviceNotice, setDeviceNotice] = useState<string | null>(null);
  const [wifiInfo, setWifiInfo] = useState<WifiConnectionInfo | null>(null);
  const [usbDevices, setUsbDevices] = useState<UsbAndroidDevice[]>([]);
  const [usbError, setUsbError] = useState<string | null>(null);
  const [launchAtLogin, setLaunchAtLoginState] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  useEffect(() => {
    if (!wifiInfo) {
      return;
    }
    console.info("[PocketDeck] Windows QR provisioning summary", {
      version: 2,
      port: wifiInfo.port,
      wifiAddressCount: wifiInfo.enabled ? wifiInfo.addresses.length : 0,
      wifiEndpoint: wifiInfo.enabled ? "redacted LAN address(es)" : "unavailable",
      usbEndpoint: `127.0.0.1:${wifiInfo.port}`,
      certificateFingerprint: wifiInfo.certificate_sha256 ? "redacted" : "unavailable",
      certificateExpiresAt: wifiInfo.certificate_expires_at,
    });
  }, [wifiInfo]);

  const refreshUsbDevices = useCallback(async () => {
    setUsbError(null);
    try {
      setUsbDevices(await listUsbAndroidDevices());
    } catch (error) {
      setUsbError(
        error instanceof Error
          ? error.message
          : "Android USB devices could not be listed.",
      );
    }
  }, []);

  const refreshDevices = useCallback(async () => {
    setDeviceBusy(true);
    setDeviceError(null);
    try {
      const [devices, requests, connectionInfo] = await Promise.all([
        listManagedDevices(),
        listPairingRequests(),
        getWifiConnectionInfo(),
      ]);
      setManagedDevices(devices);
      setPairingRequests(requests);
      setWifiInfo(connectionInfo);
      void refreshUsbDevices();
    } catch (error) {
      setDeviceError(
        error instanceof Error
          ? error.message
          : "Device information could not be loaded.",
      );
      throw error;
    } finally {
      setDeviceBusy(false);
    }
  }, [refreshUsbDevices]);

  useEffect(() => {
    if (section !== "devices") {
      return;
    }
    let active = true;
    void getLaunchAtLogin()
      .then((enabled) => {
        if (active) setLaunchAtLoginState(enabled);
      })
      .catch((error: unknown) => {
        if (active) {
          setLifecycleError(
            error instanceof Error
              ? error.message
              : "Companion startup status could not be loaded.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [section]);

  useEffect(() => {
    if (section !== "devices" || !adminDeviceAccess || !backendConnected) {
      return;
    }
    let active = true;
    void (async () => {
      setDeviceBusy(true);
      setDeviceError(null);
      try {
        const [devices, requests] = await Promise.all([
          listManagedDevices(),
          listPairingRequests(),
        ]);
        if (!active) {
          return;
        }
        setManagedDevices(devices);
        setPairingRequests(requests);
        void refreshUsbDevices();
      } catch (error) {
        if (!active) {
          return;
        }
        setDeviceError(
          error instanceof Error
            ? error.message
            : "Device information could not be loaded.",
        );
      } finally {
        if (active) {
          setDeviceBusy(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [adminDeviceAccess, backendConnected, refreshUsbDevices, section]);

  const configuration =
    state.status === "loaded" ? state.configuration : null;
  const commandDraftDirty = draft !== null;
  const shortcutDraftDirty = shortcutName.length > 0 || shortcutValue.length > 0;
  const profileDraftDirty =
    profileName.length > 0 ||
    pageName.length > 0 ||
    renameProfile.length > 0 ||
    renamePage.length > 0;
  useEffect(() => {
    onDirtyChange(commandDraftDirty || shortcutDraftDirty || profileDraftDirty);
  }, [
    commandDraftDirty,
    onDirtyChange,
    profileDraftDirty,
    shortcutDraftDirty,
  ]);

  const categories = useMemo(
    () =>
      configuration
        ? ["All", ...new Set(configuration.commands.map((command) => command.category))]
        : ["All"],
    [configuration],
  );
  const visibleCommands =
    configuration?.commands.filter((command) => {
      const matchesQuery = `${command.name} ${command.category}`
        .toLowerCase()
        .includes(query.toLowerCase());
      return matchesQuery && (category === "All" || command.category === category);
    }) ?? [];

  const persist = async (
    next: PocketDeckConfiguration,
    successMessage: string,
  ) => {
    setBusy(true);
    setMessage(null);
    try {
      await saveConfiguration(next);
      setMessage({ error: false, text: successMessage });
      return true;
    } catch (error) {
      setMessage({
        error: true,
        text: error instanceof Error ? error.message : "Configuration could not be saved.",
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const createPairingCode = async () => {
    setDeviceBusy(true);
    setDeviceError(null);
    setApprovedCredential(null);
    try {
      setPairingSession(await createPairingSession());
    } catch (error) {
      setDeviceError(
        error instanceof Error ? error.message : "Pairing session could not be created.",
      );
    } finally {
      setDeviceBusy(false);
    }
  };

  const approveRequest = async (request: PairingRequest) => {
    setDeviceBusy(true);
    setDeviceError(null);
    try {
      const approved = await approvePairingRequest(request.request_id);
      setApprovedCredential(approved.credential);
      setDeviceNotice(
        approved.credential === null
          ? "Approved. The Android device received its credential over the pinned Wi-Fi connection."
          : "Approved. Copy the credential now and share it only with the paired device.",
      );
      await refreshDevices();
    } catch (error) {
      setDeviceError(
        error instanceof Error ? error.message : "Pairing request could not be approved.",
      );
    } finally {
      setDeviceBusy(false);
    }
  };

  const rejectRequest = async (request: PairingRequest) => {
    setDeviceBusy(true);
    setDeviceError(null);
    try {
      await rejectPairingRequest(request.request_id);
      await refreshDevices();
    } catch (error) {
      setDeviceError(
        error instanceof Error ? error.message : "Pairing request could not be rejected.",
      );
    } finally {
      setDeviceBusy(false);
    }
  };

  const revokeManagedDevice = async (device: ManagedDevice) => {
    if (!window.confirm(`Revoke access for ${device.name}?`)) {
      return;
    }
    setDeviceBusy(true);
    setDeviceError(null);
    try {
      await revokeDevice(device.device_id);
      await refreshDevices();
    } catch (error) {
      setDeviceError(
        error instanceof Error ? error.message : "Device access could not be revoked.",
      );
    } finally {
      setDeviceBusy(false);
    }
  };

  const uploadConfiguration = async (device: ManagedDevice) => {
    setDeviceBusy(true);
    setDeviceError(null);
    setDeviceNotice(`Uploading configuration to ${device.name}…`);
    try {
      const result = await uploadConfigurationToDevice(device.device_id);
      setDeviceNotice(
        `${result.message} Windows configuration revision ${result.revision} was confirmed.`,
      );
    } catch (error) {
      setDeviceNotice(null);
      setDeviceError(
        error instanceof Error
          ? error.message
          : "Configuration upload failed; the Android deck was not confirmed.",
      );
    } finally {
      setDeviceBusy(false);
    }
  };

  const configureUsbReverse = async (
    device: UsbAndroidDevice,
    enable: boolean,
  ) => {
    if (!device.is_usb || device.state !== "device") {
      setUsbError("Authorize this Android phone over USB before configuring transport.");
      return;
    }
    setDeviceBusy(true);
    setUsbError(null);
    try {
      const port = wifiInfo?.port ?? 8443;
      const notice = enable
        ? await enableUsbReverse(device.serial, port)
        : await disableUsbReverse(device.serial, port);
      setDeviceNotice(notice);
    } catch (error) {
      setUsbError(
        error instanceof Error
          ? error.message
          : "The USB reverse connection could not be configured.",
      );
    } finally {
      setDeviceBusy(false);
    }
  };

  const toggleLaunchAtLogin = async () => {
    setLifecycleError(null);
    try {
      setLaunchAtLoginState(await setLaunchAtLogin(!launchAtLogin));
    } catch (error) {
      setLifecycleError(
        error instanceof Error
          ? error.message
          : "PocketDeck startup preference could not be saved.",
      );
    }
  };

  const saveCommand = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!configuration || !draft || busy) {
      return;
    }
    const name = draft.name.trim();
    const commandCategory = draft.category.trim();
    if (!name || !commandCategory || draft.steps.length < 1 || draft.steps.length > 20) {
      setMessage({ error: true, text: "Commands need a name, category, and 1–20 steps." });
      return;
    }
    const steps: CommandStepConfiguration[] = draft.steps.map((step) => {
      if (step.type === "open_url") {
        return { type: step.type, parameters: { url: step.value.trim() } };
      }
      if (step.type === "wait") {
        return { type: step.type, parameters: { milliseconds: step.milliseconds } };
      }
      if (step.value.startsWith("shortcut:")) {
        return {
          type: step.type,
          parameters: { shortcut_id: step.value.slice("shortcut:".length) },
        };
      }
      return { type: step.type, parameters: { shortcut: step.value.trim() } };
    });

    const command: CustomCommandConfiguration = {
      id: draft.id ?? newId("command", configuration),
      definition_version: 1,
      name,
      description: draft.description.trim(),
      category: commandCategory,
      enabled: draft.enabled,
      steps,
    };
    const saved = await persist(
      withSavedCommand(configuration, command),
      "Command saved.",
    );
    if (saved) {
      setDraft(null);
    }
  };

  const deleteCommand = async (command: CustomCommandConfiguration) => {
    if (!configuration || busy) {
      return;
    }
    if (!window.confirm(`Delete command "${command.name}"?`)) {
      return;
    }
    const actionId = commandActionId(command.id, configuration);
    const assigned = actionId && configuration.profiles.some((profile) =>
      profile.pages.some((page) =>
        page.buttons.some((button) => button.action_id === actionId),
      ),
    );
    if (assigned) {
      setMessage({
        error: true,
        text: "Unassign this command from every button before deleting it.",
      });
      return;
    }
    const actions = configuration.actions.filter((action) => action.id !== actionId);
    const saved = await persist(
      {
        ...configuration,
        actions,
        commands: configuration.commands.filter((item) => item.id !== command.id),
      },
      "Command deleted.",
    );
    if (saved && draft?.id === command.id) {
      setDraft(null);
    }
  };

  const toggleCommand = async (command: CustomCommandConfiguration) => {
    if (!configuration) {
      return;
    }
    const enabled = !command.enabled;
    const actionId = commandActionId(command.id, configuration);
    await persist(
      {
        ...configuration,
        commands: configuration.commands.map((item) =>
          item.id === command.id ? { ...item, enabled } : item,
        ),
        actions: configuration.actions.map((action) =>
          action.id === actionId && action.type === "run_command"
            ? { ...action, enabled_for_execution: enabled }
            : action,
        ),
      },
      enabled ? "Command enabled." : "Command disabled.",
    );
  };

  const duplicateCommand = (command: CustomCommandConfiguration) => {
    setDraft({
      id: null,
      name: `${command.name} copy`,
      description: command.description ?? "",
      category: command.category,
      enabled: command.enabled,
      steps: command.steps.map(toStepDraft),
    });
    setMessage(null);
  };

  const saveShortcut = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!configuration || busy) {
      return;
    }
    const name = shortcutName.trim();
    if (!name || !shortcutValue) {
      setMessage({ error: true, text: "Enter a name and record a supported shortcut." });
      return;
    }
    let shortcut: string;
    try {
      shortcut = normalizeShortcut(shortcutValue);
    } catch (error) {
      setMessage({
        error: true,
        text: error instanceof Error ? error.message : "That shortcut is not supported.",
      });
      return;
    }
    const value: SavedShortcutConfiguration = {
      id: shortcutId ?? newId("shortcut", configuration),
      name,
      shortcut,
    };
    const saved = await persist(
      withSavedShortcut(configuration, value),
      "Shortcut saved.",
    );
    if (saved) {
      setShortcutName("");
      setShortcutValue("");
      setShortcutId(null);
    }
  };

  const deleteShortcut = async (shortcut: SavedShortcutConfiguration) => {
    if (!configuration) {
      return;
    }
    const referenced =
      configuration.actions.some(
        (action) =>
          action.type === "keyboard_shortcut" &&
          "shortcut_id" in action.parameters &&
          action.parameters.shortcut_id === shortcut.id &&
          configuration.profiles.some((profile) =>
            profile.pages.some((page) =>
              page.buttons.some((button) => button.action_id === action.id),
            ),
          ),
      ) ||
      configuration.commands.some((command) =>
        command.steps.some(
          (step) =>
            step.type === "keyboard_shortcut" &&
            "shortcut_id" in step.parameters &&
            step.parameters.shortcut_id === shortcut.id,
        ),
      );
    if (referenced) {
      setMessage({
        error: true,
        text: "This shortcut is in use. Edit its references before deleting it.",
      });
      return;
    }
    if (!window.confirm(`Delete shortcut "${shortcut.name}"?`)) {
      return;
    }
    const actionIds = configuration.actions
      .filter(
        (action) =>
          action.type === "keyboard_shortcut" &&
          "shortcut_id" in action.parameters &&
          action.parameters.shortcut_id === shortcut.id,
      )
      .map((action) => action.id);
    await persist(
      {
        ...configuration,
        actions: configuration.actions.filter((action) => !actionIds.includes(action.id)),
        shortcuts: configuration.shortcuts.filter((item) => item.id !== shortcut.id),
      },
      "Shortcut deleted.",
    );
  };

  const createProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !configuration ||
      !profileName.trim() ||
      configuration.profiles.length >= 32 ||
      busy
    ) {
      return;
    }
    const id = newId("profile", configuration);
    const saved = await persist(
      {
        ...configuration,
        profiles: [
          ...configuration.profiles,
          {
            id,
            name: profileName.trim(),
            pages: [
              {
                id: newId("page", configuration),
                name: "Page 1",
                grid: { columns: 3, rows: 2 },
                buttons: [],
              },
            ],
          },
        ],
      },
      "Profile created.",
    );
    if (saved) {
      setProfileName("");
    }
  };

  const createPage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const profile = configuration?.profiles.find((item) => item.id === targetProfileId);
    if (
      !configuration ||
      !profile ||
      !pageName.trim() ||
      profile.pages.length >= 32 ||
      busy
    ) {
      return;
    }
    const nextPage = {
      id: newId("page", configuration),
      name: pageName.trim(),
      grid: { columns: 3, rows: 2 },
      buttons: [],
    };
    const saved = await persist(
      {
        ...configuration,
        profiles: configuration.profiles.map((item) =>
          item.id === profile.id ? { ...item, pages: [...item.pages, nextPage] } : item,
        ),
      },
      "Page created.",
    );
    if (saved) {
      setPageName("");
    }
  };

  const mutateProfile = async (
    profileId: string,
    mutation: (profile: PocketDeckConfiguration["profiles"][number]) => PocketDeckConfiguration["profiles"][number] | null,
    success: string,
  ) => {
    if (!configuration) {
      return false;
    }
    const profile = configuration.profiles.find((item) => item.id === profileId);
    if (!profile) {
      return false;
    }
    const updated = mutation(profile);
    if (
      !updated &&
      !window.confirm(`Delete profile "${profile.name}" and its pages?`)
    ) {
      return false;
    }
    if (!updated && configuration.profiles.length === 1) {
      setMessage({ error: true, text: "At least one profile must remain." });
      return false;
    }
    const profiles = updated
      ? configuration.profiles.map((item) => (item.id === profileId ? updated : item))
      : configuration.profiles.filter((item) => item.id !== profileId);
    return persist({ ...configuration, profiles }, success);
  };

  const mutatePage = async (
    profileId: string,
    pageId: string,
    mutation: (page: PocketDeckConfiguration["profiles"][number]["pages"][number]) => PocketDeckConfiguration["profiles"][number]["pages"][number] | null,
    success: string,
  ) => {
    if (!configuration) {
      return false;
    }
    const profile = configuration.profiles.find((item) => item.id === profileId);
    const page = profile?.pages.find((item) => item.id === pageId);
    if (!profile || !page) {
      return false;
    }
    const updated = mutation(page);
    if (!updated && !window.confirm(`Delete page "${page.name}"?`)) {
      return false;
    }
    if (!updated && profile.pages.length === 1) {
      setMessage({ error: true, text: "A profile must retain at least one page." });
      return false;
    }
    const pages = updated
      ? profile.pages.map((item) => (item.id === pageId ? updated : item))
      : profile.pages.filter((item) => item.id !== pageId);
    return persist(
      {
        ...configuration,
        profiles: configuration.profiles.map((item) =>
          item.id === profileId ? { ...item, pages } : item,
        ),
      },
      success,
    );
  };

  const moveProfile = (index: number, direction: -1 | 1) => {
    if (!configuration) {
      return;
    }
    const to = index + direction;
    if (to < 0 || to >= configuration.profiles.length) {
      return;
    }
    const profiles = [...configuration.profiles];
    [profiles[index], profiles[to]] = [profiles[to], profiles[index]];
    void persist({ ...configuration, profiles }, "Profile order saved.");
  };

  const movePage = (profileId: string, index: number, direction: -1 | 1) => {
    if (!configuration) {
      return;
    }
    const profile = configuration.profiles.find((item) => item.id === profileId);
    const to = index + direction;
    if (!profile || to < 0 || to >= profile.pages.length) {
      return;
    }
    const pages = [...profile.pages];
    [pages[index], pages[to]] = [pages[to], pages[index]];
    void persist(
      {
        ...configuration,
        profiles: configuration.profiles.map((item) =>
          item.id === profileId ? { ...item, pages } : item,
        ),
      },
      "Page order saved.",
    );
  };

  const duplicatePage = (profileId: string, pageId: string) => {
    if (!configuration) {
      return;
    }
    const profile = configuration.profiles.find((item) => item.id === profileId);
    const page = profile?.pages.find((item) => item.id === pageId);
    if (!profile || !page || profile.pages.length >= 32) {
      return;
    }
    const duplicate = {
      ...page,
      id: newId("page", configuration),
      name: `${page.name} copy`,
      buttons: page.buttons.map((button) => ({
        ...button,
        id: newId("button", configuration),
      })),
    };
    void persist(
      {
        ...configuration,
        profiles: configuration.profiles.map((item) =>
          item.id === profileId
            ? { ...item, pages: [...item.pages, duplicate] }
            : item,
        ),
      },
      "Page duplicated.",
    );
  };

  const exportConfiguration = async () => {
    if (!configuration) {
      return;
    }
    try {
      const saved = await saveConfigurationExport(configuration);
      setMessage({
        error: false,
        text: saved
          ? "Configuration exported successfully."
          : "Configuration export canceled.",
      });
    } catch (error) {
      setMessage({
        error: true,
        text:
          error instanceof Error
            ? error.message
            : "Could not export the PocketDeck configuration.",
      });
    }
  };

  const importConfiguration = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    try {
      const imported: unknown = JSON.parse(await file.text());
      if (!isPocketDeckConfiguration(imported)) {
        throw new Error("The file is not a valid PocketDeck v1 configuration.");
      }
      await persist(imported, "Configuration imported and saved.");
    } catch (error) {
      setMessage({
        error: true,
        text: error instanceof Error ? error.message : "Configuration import failed.",
      });
    }
  };

  if (!configuration) {
    return (
      <section className="layout-panel configuration-studio" aria-live="polite">
        <p>
          {state.status === "error" ? state.message : "Loading configuration…"}
        </p>
      </section>
    );
  }

  const title =
    section === "actions"
      ? "Commands"
      : section === "shortcuts"
        ? "Keyboard shortcuts"
        : section === "profiles"
          ? "Profiles and pages"
          : section === "devices"
            ? "Devices"
            : "Settings and configuration";

  return (
    <section className="layout-panel configuration-studio" aria-labelledby="studio-title">
      <div className="layout-heading">
        <div>
          <p className="eyebrow">CONFIGURATION STUDIO</p>
          <h2 id="studio-title">{title}</h2>
        </div>
        <span className="count-badge">Saved configuration v1</span>
      </div>
      {message && (
        <p className={`studio-message${message.error ? " is-error" : ""}`} role={message.error ? "alert" : "status"}>
          {message.text}
        </p>
      )}

      {section === "actions" && (
        <div className="studio-body">
          <div className="studio-toolbar">
            <label>
              <span>Search commands</span>
              <input
                aria-label="Search commands"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Name or category"
                value={query}
              />
            </label>
            <label>
              <span>Category</span>
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                {categories.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
            <button
              className="editor-button"
              disabled={busy || draft !== null}
              onClick={() => {
                setDraft(newCommandDraft());
                setMessage(null);
              }}
              type="button"
            >
              New command
            </button>
          </div>
          <p className="studio-hint">
            Commands are saved definitions. Buttons execute the saved command ID; editing a definition updates every assigned button. Drag an enabled command onto a deck button to assign it.
          </p>
          <div className="studio-list">
            {visibleCommands.length === 0 ? (
              <p className="studio-empty">No commands match your search.</p>
            ) : visibleCommands.map((command) => (
              <article
                className="studio-list-item"
                draggable={command.enabled}
                key={command.id}
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    "application/x-pocketdeck-command",
                    command.id,
                  );
                  event.dataTransfer.effectAllowed = "copy";
                }}
              >
                <div className="studio-list-copy">
                  <strong>{command.name}</strong>
                  <span>{command.category} · {command.steps.length} step{command.steps.length === 1 ? "" : "s"} · {command.enabled ? "Enabled" : "Disabled"}</span>
                  {command.description && <span>{command.description}</span>}
                </div>
                <div className="studio-list-actions">
                  <button className="editor-button is-quiet" disabled={busy} onClick={() => void toggleCommand(command)} type="button">
                    {command.enabled ? "Disable" : "Enable"}
                  </button>
                  <button className="editor-button is-quiet" disabled={busy || draft !== null} onClick={() => duplicateCommand(command)} type="button">Duplicate</button>
                  <button className="editor-button is-quiet" disabled={busy || draft !== null} onClick={() => setDraft({ ...command, description: command.description ?? "", steps: command.steps.map(toStepDraft) })} type="button">Edit</button>
                  <button className="editor-button is-quiet is-danger" disabled={busy} onClick={() => void deleteCommand(command)} type="button">Delete</button>
                </div>
              </article>
            ))}
          </div>
          {draft && (
            <form aria-label={draft.id ? "Edit command" : "Create command"} className="studio-editor" onSubmit={(event) => void saveCommand(event)}>
              <div className="studio-editor-heading">
                <h3>{draft.id ? "Edit command" : "Create command"}</h3>
                <button className="editor-button is-quiet" disabled={busy} onClick={() => setDraft(null)} type="button">Cancel</button>
              </div>
              <div className="studio-form-grid">
                <label><span>Name</span><input autoFocus maxLength={64} required value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
                <label><span>Category</span><input maxLength={32} required value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} /></label>
              </div>
              <label><span>Description</span><textarea maxLength={256} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
              <label className="studio-check"><input checked={draft.enabled} type="checkbox" onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> Enabled for execution</label>
              <ol className="command-step-list">
                {draft.steps.map((step, index) => (
                  <li className="command-step" key={`${index}-${step.type}`}>
                    <div className="command-step-heading">
                      <strong>Step {index + 1}</strong>
                      <div>
                        <button aria-label={`Move step ${index + 1} up`} className="editor-button is-quiet" disabled={index === 0} onClick={() => {
                          const steps = [...draft.steps];
                          [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
                          setDraft({ ...draft, steps });
                        }} type="button">Up</button>
                        <button aria-label={`Move step ${index + 1} down`} className="editor-button is-quiet" disabled={index === draft.steps.length - 1} onClick={() => {
                          const steps = [...draft.steps];
                          [steps[index + 1], steps[index]] = [steps[index], steps[index + 1]];
                          setDraft({ ...draft, steps });
                        }} type="button">Down</button>
                        <button aria-label={`Remove step ${index + 1}`} className="editor-button is-quiet is-danger" disabled={draft.steps.length === 1} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, stepIndex) => stepIndex !== index) })} type="button">Remove</button>
                      </div>
                    </div>
                    <label><span>Action</span><select value={step.type} onChange={(event) => {
                      const steps = [...draft.steps];
                      steps[index] = { ...NEW_STEP, type: event.target.value as StepDraft["type"] };
                      setDraft({ ...draft, steps });
                    }}>
                      <option value="open_url">Open a URL</option>
                      <option value="keyboard_shortcut">Keyboard shortcut</option>
                      <option value="wait">Wait</option>
                    </select></label>
                    {step.type === "open_url" && <label><span>HTTP or HTTPS URL</span><input type="url" required value={step.value} onChange={(event) => {
                      const steps = [...draft.steps]; steps[index] = { ...step, value: event.target.value }; setDraft({ ...draft, steps });
                    }} placeholder="https://example.com" /></label>}
                    {step.type === "keyboard_shortcut" && (
                      <label>
                        <span>Shortcut</span>
                        <select
                          value={
                            step.value.startsWith("shortcut:")
                              ? step.value
                              : step.value
                                ? "custom"
                                : ""
                          }
                          onChange={(event) => {
                            const steps = [...draft.steps];
                            steps[index] = {
                              ...step,
                              value:
                                event.target.value === "custom"
                                  ? ""
                                  : event.target.value,
                            };
                            setDraft({ ...draft, steps });
                          }}
                        >
                          <option value="">Choose a saved shortcut</option>
                          {configuration.shortcuts.map((shortcut) => (
                            <option
                              key={shortcut.id}
                              value={`shortcut:${shortcut.id}`}
                            >
                              {shortcut.name} ({shortcut.shortcut})
                            </option>
                          ))}
                          <option value="custom">Enter a key combination</option>
                        </select>
                      </label>
                    )}
                    {step.type === "keyboard_shortcut" && !step.value.startsWith("shortcut:") && <label><span>Combination (for example Ctrl+Shift+S)</span><input required value={step.value} onChange={(event) => {
                      const steps = [...draft.steps]; steps[index] = { ...step, value: event.target.value }; setDraft({ ...draft, steps });
                    }} /></label>}
                    {step.type === "wait" && <label><span>Wait (milliseconds, max 10,000)</span><input max={10000} min={0} required type="number" value={step.milliseconds} onChange={(event) => {
                      const steps = [...draft.steps]; steps[index] = { ...step, milliseconds: Number(event.target.value) }; setDraft({ ...draft, steps });
                    }} /></label>}
                  </li>
                ))}
              </ol>
              <button className="editor-button is-quiet" disabled={draft.steps.length >= 20} onClick={() => setDraft({ ...draft, steps: [...draft.steps, { ...NEW_STEP }] })} type="button">Add step</button>
              <button className="editor-button" disabled={busy} type="submit">{busy ? "Saving…" : "Save command"}</button>
            </form>
          )}
        </div>
      )}

      {section === "shortcuts" && (
        <div className="studio-body">
          <p className="studio-hint">
            Record Ctrl, Alt, Shift, or Windows with a supported key. Windows may intercept reserved combinations or reject input across privilege levels or if the intended app loses focus. Fn is not recordable unless your keyboard exposes it as a Windows key event.
          </p>
          <form aria-label={shortcutId ? "Edit shortcut" : "Save shortcut"} className="studio-editor" onSubmit={(event) => void saveShortcut(event)}>
            <div className="studio-form-grid">
              <label><span>Name</span><input autoComplete="off" maxLength={64} required value={shortcutName} onChange={(event) => setShortcutName(event.target.value)} /></label>
              <ShortcutRecorder
                value={shortcutValue}
                onChange={setShortcutValue}
              />
            </div>
            <div className="studio-list-actions">
              <button className="editor-button" disabled={busy || !shortcutValue || !shortcutName.trim()} type="submit">{shortcutId ? "Save shortcut" : "Add shortcut"}</button>
              {(shortcutId || shortcutName || shortcutValue) && <button className="editor-button is-quiet" type="button" onClick={() => {
                setShortcutId(null); setShortcutName(""); setShortcutValue("");
              }}>Cancel</button>}
            </div>
          </form>
          <div className="studio-list">
            {configuration.shortcuts.map((shortcut) => (
              <article className="studio-list-item" key={shortcut.id}>
                <div className="studio-list-copy"><strong>{shortcut.name}</strong><span>{shortcut.shortcut}</span></div>
                <div className="studio-list-actions">
                  <button className="editor-button is-quiet" onClick={() => {
                    setShortcutId(shortcut.id); setShortcutName(shortcut.name); setShortcutValue(shortcut.shortcut);
                  }} type="button">Edit</button>
                  <button className="editor-button is-quiet is-danger" disabled={busy} onClick={() => void deleteShortcut(shortcut)} type="button">Delete</button>
                </div>
              </article>
            ))}
            {configuration.shortcuts.length === 0 && <p className="studio-empty">No saved shortcuts yet.</p>}
          </div>
        </div>
      )}

      {section === "profiles" && (
        <div className="studio-body">
          <form className="studio-inline-form" onSubmit={(event) => void createProfile(event)}>
            <label><span>New profile</span><input maxLength={64} required value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Profile name" /></label>
            <button className="editor-button" disabled={busy || configuration.profiles.length >= 32} type="submit">Create profile</button>
          </form>
          <form className="studio-inline-form" onSubmit={(event) => void createPage(event)}>
            <label><span>Profile</span><select required value={targetProfileId} onChange={(event) => setTargetProfileId(event.target.value)}><option value="">Select a profile</option>{configuration.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
            <label><span>New page</span><input maxLength={64} required value={pageName} onChange={(event) => setPageName(event.target.value)} placeholder="Page name" /></label>
            <button className="editor-button" disabled={busy} type="submit">Add page</button>
          </form>
          <form className="studio-inline-form" onSubmit={(event) => {
            event.preventDefault();
            if (renameProfile.trim() && renameProfileId) {
              void mutateProfile(
                renameProfileId,
                (item) => ({ ...item, name: renameProfile.trim() }),
                "Profile renamed.",
              ).then((saved) => {
                if (saved) {
                  setRenameProfile("");
                }
              });
            }
          }}>
            <label><span>Profile to rename</span><select value={renameProfileId} onChange={(event) => setRenameProfileId(event.target.value)}><option value="">Select a profile</option>{configuration.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
            <label><span>New profile name</span><input maxLength={64} required value={renameProfile} onChange={(event) => setRenameProfile(event.target.value)} /></label>
            <button className="editor-button is-quiet" disabled={busy || !renameProfile.trim() || !renameProfileId} type="submit">Rename profile</button>
          </form>
          <form className="studio-inline-form" onSubmit={(event) => {
            event.preventDefault();
            if (renamePage.trim() && renamePageId && targetProfileId) {
              void mutatePage(
                targetProfileId,
                renamePageId,
                (item) => ({ ...item, name: renamePage.trim() }),
                "Page renamed.",
              ).then((saved) => {
                if (saved) {
                  setRenamePage("");
                }
              });
            }
          }}>
            <label><span>Page profile</span><select value={targetProfileId} onChange={(event) => {
              setTargetProfileId(event.target.value);
              setRenamePageId("");
            }}><option value="">Select a profile</option>{configuration.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
            <label><span>Page to rename</span><select value={renamePageId} onChange={(event) => setRenamePageId(event.target.value)}><option value="">Select a page</option>{configuration.profiles.find((profile) => profile.id === targetProfileId)?.pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>
            <label><span>New page name</span><input maxLength={64} required value={renamePage} onChange={(event) => setRenamePage(event.target.value)} /></label>
            <button className="editor-button is-quiet" disabled={busy || !renamePage.trim() || !renamePageId} type="submit">Rename page</button>
          </form>
          {configuration.profiles.map((profile, index) => (
            <article className="profile-studio-item" key={profile.id}>
              <LogoAssetPicker
                label={`${profile.name} profile logo`}
                value={profile.logo_asset_id}
                onChange={async (logoAssetId) => {
                  await mutateProfile(
                    profile.id,
                    (item) => ({ ...item, logo_asset_id: logoAssetId }),
                    "Profile logo saved.",
                  );
                }}
              />
              <div className="profile-studio-heading">
                <strong>{profile.name}</strong>
                <div className="studio-list-actions">
                  <button className="editor-button is-quiet" aria-label={`Move profile ${profile.name} up`} disabled={index === 0 || busy} onClick={() => moveProfile(index, -1)} type="button">Up</button>
                  <button className="editor-button is-quiet" aria-label={`Move profile ${profile.name} down`} disabled={index === configuration.profiles.length - 1 || busy} onClick={() => moveProfile(index, 1)} type="button">Down</button>
                  <button className="editor-button is-quiet" disabled={busy || configuration.profiles.length >= 32} onClick={() => {
                    const id = newId("profile", configuration);
                    const duplicate = { ...profile, id, name: `${profile.name} copy`, pages: profile.pages.map((page) => ({
                      ...page, id: newId("page", configuration), buttons: page.buttons.map((button) => ({ ...button, id: newId("button", configuration) })),
                    })) };
                    void persist({ ...configuration, profiles: [...configuration.profiles, duplicate] }, "Profile duplicated.");
                  }} type="button">Duplicate</button>
                  <button className="editor-button is-quiet is-danger" disabled={busy} onClick={() => void mutateProfile(profile.id, () => null, "Profile deleted.")} type="button">Delete</button>
                </div>
              </div>
              {profile.pages.map((page, pageIndex) => (
                <div className="page-studio-item" key={page.id}>
                  <div className="profile-studio-heading">
                    <span>{page.name} · {page.buttons.length} buttons</span>
                    <div className="studio-list-actions">
                      <button aria-label={`Move page ${page.name} up`} className="editor-button is-quiet" disabled={pageIndex === 0 || busy} onClick={() => movePage(profile.id, pageIndex, -1)} type="button">Up</button>
                      <button aria-label={`Move page ${page.name} down`} className="editor-button is-quiet" disabled={pageIndex === profile.pages.length - 1 || busy} onClick={() => movePage(profile.id, pageIndex, 1)} type="button">Down</button>
                      <button className="editor-button is-quiet" disabled={busy || profile.pages.length >= 32} onClick={() => duplicatePage(profile.id, page.id)} type="button">Duplicate page</button>
                      <button className="editor-button is-quiet is-danger" disabled={busy} onClick={() => void mutatePage(profile.id, page.id, () => null, "Page deleted.")} type="button">Delete page</button>
                    </div>
                  </div>
                </div>
              ))}
            </article>
          ))}
        </div>
      )}

      {section === "devices" && (
        <div className="studio-body">
          <article className="studio-info-card">
            <strong>Backend connection: {backendConnected ? "Connected" : "Offline"}</strong>
            <p>
              {adminDeviceAccess
                ? "Desktop administrator access is available. Pairing codes expire after three minutes; approved credentials are shown once."
                : "Device administration requires the desktop administrator credential. Paired web clients cannot manage devices."}
            </p>
            <p>Closing the studio window hides it to the system tray; the Windows companion remains available until you choose Quit PocketDeck from the tray menu.</p>
            {lifecycleError && <p className="studio-message is-error" role="alert">{lifecycleError}</p>}
            <label className="studio-check">
              <input
                checked={launchAtLogin}
                onChange={() => void toggleLaunchAtLogin()}
                type="checkbox"
              />
              Start PocketDeck companion with Windows
            </label>
          </article>
          {adminDeviceAccess && (
            <>
              {deviceError && <p className="studio-message is-error" role="alert">{deviceError}</p>}
              {deviceNotice && <p className="studio-message" role="status">{deviceNotice}</p>}
              {wifiInfo && (
                <article className="studio-info-card">
                  <strong>Authenticated Wi-Fi: {wifiInfo.enabled ? "Available" : "Unavailable"}</strong>
                  {wifiInfo.enabled ? (
                    <>
                      <p>Connect Android to one of these Windows host addresses on port {wifiInfo.port}.</p>
                      <ul>
                        {wifiInfo.addresses.map((address) => (
                          <li key={address}><code>wss://{address}:{wifiInfo.port}/ws/v2</code></li>
                        ))}
                      </ul>
                      <p>Wi-Fi listens only on private IPv4 addresses and loopback. If Android cannot connect, allow pocketdeck-backend.exe through Windows Defender Firewall on Private networks only; leave Public networks unchecked. Restart PocketDeck after changing networks.</p>
                    </>
                  ) : (
                    <p>{wifiInfo.error ?? "Wi-Fi is disabled. The authenticated TLS listener remains available on loopback for ADB reverse USB connections."}</p>
                  )}
                  {wifiInfo.certificate_sha256 &&
                    wifiInfo.certificate_expires_at !== null &&
                    wifiInfo.certificate_expires_at > 0 && (
                    <>
                      <p>Scan this QR code in Android to pin this Windows companion&apos;s TLS certificate. Wi-Fi addresses are kept separate from the USB loopback endpoint. For USB, the trusted certificate is reused after Windows establishes ADB reverse.</p>
                      <QRCodeSVG
                        aria-label="PocketDeck Windows connection QR code"
                        value={windowsConnectionQrPayload(wifiInfo)}
                        size={320}
                        level="M"
                      />
                    </>
                  )}
                </article>
              )}
              <div className="studio-list-actions">
                <button className="editor-button" disabled={deviceBusy || !backendConnected} onClick={() => void createPairingCode()} type="button">Create pairing code</button>
                <button className="editor-button is-quiet" disabled={deviceBusy || !backendConnected} onClick={() => void refreshDevices().catch((error: unknown) => setDeviceError(error instanceof Error ? error.message : "Refresh failed."))} type="button">Refresh devices</button>
                <button className="editor-button is-quiet" disabled={deviceBusy} onClick={() => void refreshUsbDevices()} type="button">Refresh USB devices</button>
              </div>
              {pairingSession && (
                <article className="studio-info-card">
                  <strong>Six-digit pairing PIN: <code>{pairingSession.pairing_code}</code></strong>
                  <p>Expires {new Date(pairingSession.expires_at).toLocaleTimeString()}.</p>
                </article>
              )}
              {approvedCredential && (
                <article className="studio-info-card" role="status">
                  <strong>New device credential — copy it now</strong>
                  <p>The token will not be shown again. Store it securely and share it only with the paired device.</p>
                  <output className="device-credential">{approvedCredential}</output>
                  <button className="editor-button is-quiet" onClick={() => setApprovedCredential(null)} type="button">Hide credential</button>
                </article>
              )}
              <section aria-label="Pending pairing requests" className="studio-list">
                <h3>Pending pairing requests</h3>
                {pairingRequests.map((request) => (
                  <article className="studio-list-item" key={request.request_id}>
                    <div className="studio-list-copy"><strong>{request.name}</strong><span>{request.client_type} · {request.transport.toUpperCase()} · expires {new Date(request.expires_at).toLocaleTimeString()}</span></div>
                    <div className="studio-list-actions">
                      <button className="editor-button" disabled={deviceBusy} onClick={() => void approveRequest(request)} type="button">Approve</button>
                      <button className="editor-button is-quiet is-danger" disabled={deviceBusy} onClick={() => void rejectRequest(request)} type="button">Reject</button>
                    </div>
                  </article>
                ))}
                {pairingRequests.length === 0 && <p className="studio-empty">No pending requests.</p>}
              </section>
                <section aria-label="USB Android devices" className="studio-list">
                  <h3>USB connection (ADB reverse)</h3>
                  <p className="studio-muted">
                    Use a data-capable cable, enable USB debugging, install Android Platform Tools on Windows, and accept the phone&apos;s RSA authorization prompt. USB debugging authorization is separate from PocketDeck&apos;s approval.
                  </p>
                  {usbError && <p className="studio-message is-error" role="alert">{usbError}</p>}
                  {usbDevices.filter((device) => device.is_usb).map((device) => (
                    <article className="studio-list-item" key={device.serial}>
                      <div className="studio-list-copy">
                        <strong>{device.model ?? "Android phone"}</strong>
                        <span>{device.state === "device" ? "USB debugging authorized" : `USB debugging ${device.state}`}</span>
                      </div>
                      <div className="studio-list-actions">
                        <button
                          className="editor-button"
                          disabled={deviceBusy || device.state !== "device"}
                          onClick={() => void configureUsbReverse(device, true)}
                          type="button"
                        >
                          Enable USB
                        </button>
                        <button
                          className="editor-button is-quiet"
                          disabled={deviceBusy || device.state !== "device"}
                          onClick={() => void configureUsbReverse(device, false)}
                          type="button"
                        >
                          Disconnect USB
                        </button>
                      </div>
                    </article>
                  ))}
                  {!usbError && usbDevices.every((device) => !device.is_usb) && (
                    <p className="studio-empty">No authorized Android USB device detected. Connect a data cable, enable USB debugging, and refresh.</p>
                  )}
                </section>
                <section aria-label="Paired devices" className="studio-list">
                <h3>Paired devices</h3>
                {managedDevices.map((device) => (
                  <article className="studio-list-item" key={device.device_id}>
                    <div className="studio-list-copy">
                      <strong>{device.name}</strong>
                      <span>{device.client_type} · {device.is_revoked ? "Revoked" : device.is_authorized ? "Authorized" : "Not authorized"}</span>
                    </div>
                    <div className="studio-list-actions">
                      {device.client_type === "android" && device.is_authorized && !device.is_revoked && (
                        <button
                          className="editor-button"
                          disabled={deviceBusy}
                          onClick={() => void uploadConfiguration(device)}
                          type="button"
                        >
                          {deviceBusy ? "Uploading…" : "Upload configuration"}
                        </button>
                      )}
                      {!device.is_revoked && <button className="editor-button is-quiet is-danger" disabled={deviceBusy} onClick={() => void revokeManagedDevice(device)} type="button">Revoke</button>}
                    </div>
                  </article>
                ))}
                {managedDevices.length === 0 && <p className="studio-empty">No paired devices.</p>}
              </section>
            </>
          )}
        </div>
      )}

      {section === "settings" && (
        <div className="studio-body">
          <label className="studio-check">
            <input
              checked={configuration.settings.confirm_commands}
              onChange={(event) => void persist({
                ...configuration,
                settings: { ...configuration.settings, confirm_commands: event.target.checked },
              }, "Preference saved.")}
              type="checkbox"
            />
            Ask before running a command from a deck button
          </label>
          <p className="studio-hint">Backend connection and revision state are shown on the Dashboard. These settings are saved in the same atomic v1 configuration file.</p>
          <div className="studio-list-actions">
            <button className="editor-button" onClick={exportConfiguration} type="button">Export configuration</button>
            <label className="editor-button is-quiet studio-import">
              Import v1 configuration
              <input accept="application/json,.json" onChange={(event) => {
                void importConfiguration(event.target.files?.[0]);
                event.currentTarget.value = "";
              }} type="file" />
            </label>
          </div>
          <p className="studio-hint">Imported files are schema-validated and saved through the backend’s revision-checked, atomic configuration writer. Invalid files do not replace the current configuration.</p>
        </div>
      )}
    </section>
  );
}
