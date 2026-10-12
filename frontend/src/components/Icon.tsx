import type { ReactNode } from "react";

export type IconName =
  | "dashboard"
  | "profiles"
  | "actions"
  | "devices"
  | "settings"
  | "monitor"
  | "server"
  | "application"
  | "volume"
  | "brightness"
  | "globe"
  | "folder"
  | "star"
  | "document"
  | "mail";

const iconPaths: Record<IconName, ReactNode> = {
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="4" rx="1.5" />
      <rect x="13.5" y="10.5" width="7" height="10" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  profiles: (
    <>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M3.5 19.5v-1.25a5.5 5.5 0 0 1 11 0v1.25z" />
      <path d="M16 5.25a3.25 3.25 0 0 1 0 6.5M17 14.5a4.25 4.25 0 0 1 3.5 4.2v.8" />
    </>
  ),
  actions: (
    <>
      <path d="M13 2.75 5.5 13h5l-.5 8.25L18.5 11h-5z" />
    </>
  ),
  devices: (
    <>
      <rect x="3" y="4" width="13" height="11" rx="2" />
      <path d="M7 20h5M9.5 15v5" />
      <rect x="17.5" y="8" width="4" height="11" rx="1.25" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="m19.4 15 .1.1 1.3 1-1.4 2.4-1.6-.6a8 8 0 0 1-1.6.9l-.3 1.7h-2.8l-.3-1.7a8 8 0 0 1-1.6-.9l-1.6.6-1.4-2.4 1.3-1a7 7 0 0 1 0-1.9l-1.3-1 1.4-2.4 1.6.6a8 8 0 0 1 1.6-.9l.3-1.7h2.8l.3 1.7a8 8 0 0 1 1.6.9l1.6-.6 1.4 2.4-1.3 1a7 7 0 0 1-.1 1.9Z" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </>
  ),
  server: (
    <>
      <rect x="4" y="3.5" width="16" height="7" rx="2" />
      <rect x="4" y="13.5" width="16" height="7" rx="2" />
      <path d="M8 7h.01M8 17h.01M12 7h4M12 17h4" />
    </>
  ),
  application: (
    <>
      <rect x="3" y="4" width="18" height="15" rx="2" />
      <path d="M3 8h18M7 6h.01M10 6h.01M8 22h8M12 19v3" />
    </>
  ),
  volume: (
    <>
      <path d="M4 9v6h4l5 4V5L8 9z" />
      <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />
    </>
  ),
  brightness: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2M12 19.5v2M4.4 4.4l1.4 1.4m12.4 12.4 1.4 1.4M2.5 12h2m15 0h2M4.4 19.6l1.4-1.4M18.2 5.8l1.4-1.4" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 12h17M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  folder: (
    <path d="M3 7.5a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  ),
  star: (
    <path d="m12 3 2.75 5.57 6.15.9-4.45 4.34 1.05 6.13L12 17.05l-5.5 2.89 1.05-6.13L3.1 9.47l6.15-.9z" />
  ),
  document: (
    <>
      <path d="M6 3.5h8l4 4v13H6z" />
      <path d="M14 3.5v4h4M9 12h6M9 16h6" />
    </>
  ),
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
};

interface IconProps {
  name: IconName;
  className?: string;
}

export function Icon({ name, className }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      viewBox="0 0 24 24"
    >
      {iconPaths[name]}
    </svg>
  );
}
