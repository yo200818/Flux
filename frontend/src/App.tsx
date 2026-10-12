import { useCallback, useMemo, useState, type FormEvent } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { BackendConnection } from "./components/BackendConnection";
import { ConfigurationButtonGrid } from "./components/ConfigurationButtonGrid";
import { ConfigurationStudio } from "./components/ConfigurationStudio";
import { RealtimeConnection } from "./components/RealtimeConnection";
import { Sidebar, type SectionId } from "./components/Sidebar";
import { StatusCard } from "./components/StatusCard";
import { useBackendHealth } from "./hooks/useBackendHealth";
import { useClientAuthorization } from "./hooks/useClientAuthorization";
import { useConfiguration } from "./hooks/useConfiguration";
import { useRealtimeUpdates } from "./hooks/useRealtimeUpdates";
import "./App.css";

const sectionTitles: Record<SectionId, string> = {
  dashboard: "Dashboard",
  profiles: "Profiles",
  actions: "Commands",
  shortcuts: "Shortcuts",
  devices: "Devices",
  settings: "Settings",
};

function App() {
  const desktopClient = isTauri();
  const [activeSection, setActiveSection] = useState<SectionId>("dashboard");
  const [webCredential, setWebCredential] = useState("");
  const [authorizationError, setAuthorizationError] = useState<string | null>(
    null,
  );
  const [studioDirty, setStudioDirty] = useState(false);
  const backend = useBackendHealth();
  const authorization = useClientAuthorization();
  const configurationBackend = useMemo(
    () =>
      authorization.state.status === "authorized"
        ? backend.connection
        : { status: "checking" as const },
    [authorization.state.status, backend.connection],
  );
  const configuration = useConfiguration(configurationBackend);
  const realtime = useRealtimeUpdates(
    configuration.refreshForRevision,
    configuration.getCurrentRevision,
    backend.connection.status,
    authorization.state.status === "authorized",
  );
  const isDashboard = activeSection === "dashboard";
  const navigate = (section: SectionId) => {
    if (
      studioDirty &&
      !window.confirm("Discard the unsaved editor draft and leave this section?")
    ) {
      return;
    }
    setStudioDirty(false);
    setActiveSection(section);
  };
  const handleStudioDirtyChange = useCallback((dirty: boolean) => {
    setStudioDirty(dirty);
  }, []);

  const submitWebCredential = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthorizationError(null);
    try {
      await authorization.authorizeWebClient(webCredential);
      setWebCredential("");
    } catch (error) {
      setAuthorizationError(
        error instanceof Error
          ? error.message
          : "The web-device credential could not be verified.",
      );
    }
  };

  return (
    <div className="app-shell">
      <Sidebar
        activeSection={activeSection}
        onNavigate={navigate}
      />

      <main className="main-content">
        <header className="page-header">
          <div>
            <p className="eyebrow">
              POCKETDECK {desktopClient ? "DESKTOP" : "WEB CLIENT"}
            </p>
            <h1>{isDashboard ? "PocketDeck" : sectionTitles[activeSection]}</h1>
            <p className="page-subtitle">
              {isDashboard
                ? desktopClient
                  ? "Your Windows desktop control center."
                  : "Your paired browser control center."
                : activeSection === "actions"
                  ? "Create reusable, validated multi-step Windows commands."
                  : activeSection === "shortcuts"
                    ? "Record and manage reusable supported keyboard combinations."
                    : activeSection === "profiles"
                      ? "Organize your deck into profiles and pages."
                      : activeSection === "devices"
                        ? "Review the available pairing and authorization capabilities."
                        : "Manage persisted preferences and configuration files."}
            </p>
          </div>
          <div className="host-chip">
            <span className="host-indicator" aria-hidden="true" />
            <span>{desktopClient ? "This PC" : "Browser"}</span>
          </div>
        </header>

        {isDashboard ? (
          <div className="dashboard-content">
            {!isTauri() && (
              <section
                aria-labelledby="web-authorization-title"
                className="web-authorization"
              >
                <div>
                  <p className="eyebrow">PAIRED WEB CLIENT</p>
                  <h2 id="web-authorization-title">
                    {authorization.state.status === "authorized"
                      ? "Connected as an authorized web device"
                      : "Connect this browser"}
                  </h2>
                </div>
                {authorization.state.status === "authorized" ? (
                  <button
                    className="editor-button is-quiet"
                    onClick={authorization.disconnect}
                    type="button"
                  >
                    Disconnect
                  </button>
                ) : (
                  <form onSubmit={(event) => void submitWebCredential(event)}>
                    <label>
                      <span>Paired web-device credential</span>
                      <input
                        autoComplete="off"
                        onChange={(event) => setWebCredential(event.target.value)}
                        type="password"
                        value={webCredential}
                      />
                    </label>
                    <button
                      className="editor-button"
                      disabled={
                        authorization.state.status === "checking" ||
                        !webCredential.trim()
                      }
                      type="submit"
                    >
                      Connect
                    </button>
                  </form>
                )}
                {authorizationError && (
                  <p className="web-authorization-error" role="alert">
                    {authorizationError}
                  </p>
                )}
              </section>
            )}
            <section className="status-grid" aria-label="Connection status">
              <StatusCard
                icon={desktopClient ? "monitor" : "globe"}
                label={desktopClient ? "Desktop" : "Browser"}
                value={desktopClient ? "Local desktop" : "Web client"}
                detail={
                  desktopClient
                    ? "PocketDeck interface on this PC"
                    : "Paired browser client"
                }
                tone="ready"
                badge={desktopClient ? "THIS PC" : "WEB"}
              />
              <BackendConnection
                connection={backend.connection}
                retry={backend.retry}
              />
              <RealtimeConnection
                status={realtime.status}
                retry={
                  backend.connection.status === "connected"
                    ? realtime.retry
                    : backend.retry
                }
              />
            </section>

            <ConfigurationButtonGrid
              state={configuration.state}
              retry={
                backend.connection.status === "connected"
                  ? configuration.retry
                  : backend.retry
              }
              saveConfiguration={configuration.saveConfiguration}
              refreshError={configuration.refreshError}
              authorized={authorization.state.status === "authorized"}
              onDirtyChange={handleStudioDirtyChange}
            />
          </div>
        ) : (
          <ConfigurationStudio
            section={activeSection}
            state={configuration.state}
            saveConfiguration={configuration.saveConfiguration}
            onDirtyChange={handleStudioDirtyChange}
            adminDeviceAccess={
              authorization.state.status === "authorized" &&
              authorization.state.clientType === "desktop"
            }
            backendConnected={backend.connection.status === "connected"}
          />
        )}

        <footer className="app-footer">
          <span className="footer-dot" aria-hidden="true" />
          <span>Backend API is loopback-only</span>
          <span className="footer-divider" aria-hidden="true">
            /
          </span>
          <span>
            {authorization.state.status === "authorized"
              ? `Authorized ${authorization.state.clientType} client`
              : "Client authorization required"}
          </span>
        </footer>
      </main>
    </div>
  );
}

export default App;
