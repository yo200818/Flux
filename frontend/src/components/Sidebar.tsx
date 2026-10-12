import { Icon, type IconName } from "./Icon";

export type SectionId =
  | "dashboard"
  | "profiles"
  | "actions"
  | "shortcuts"
  | "devices"
  | "settings";

const navigationItems: {
  id: SectionId;
  label: string;
  icon: IconName;
}[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "profiles", label: "Profiles", icon: "profiles" },
  { id: "actions", label: "Commands", icon: "actions" },
  { id: "shortcuts", label: "Shortcuts", icon: "actions" },
  { id: "devices", label: "Devices", icon: "devices" },
  { id: "settings", label: "Settings", icon: "settings" },
];

interface SidebarProps {
  activeSection: SectionId;
  onNavigate: (section: SectionId) => void;
}

export function Sidebar({ activeSection, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <a
        aria-label="PocketDeck home"
        className="brand"
        href="#dashboard"
        onClick={(event) => {
          event.preventDefault();
          onNavigate("dashboard");
        }}
      >
        <span className="brand-mark" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <span className="brand-copy">
          <strong>PocketDeck</strong>
          <span>DESKTOP</span>
        </span>
      </a>

      <div className="sidebar-label">WORKSPACE</div>
      <nav aria-label="Main navigation" className="primary-nav">
        {navigationItems.map((item) => (
          <button
            aria-current={activeSection === item.id ? "page" : undefined}
            className={`nav-item${activeSection === item.id ? " is-active" : ""}`}
            key={item.id}
            onClick={() => onNavigate(item.id)}
            type="button"
          >
            <Icon className="nav-icon" name={item.icon} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-bottom">
        <div className="sidebar-status">
          <span className="status-indicator is-idle" aria-hidden="true" />
          <div>
            <strong>Backend status</strong>
            <span>See dashboard</span>
          </div>
        </div>
        <p className="sidebar-caption">A local-first control center</p>
      </div>
    </aside>
  );
}
