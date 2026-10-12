import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

interface StatusCardProps {
  icon: IconName;
  label: string;
  value: string;
  detail: string;
  tone: "ready" | "pending" | "error";
  badge: string;
  action?: ReactNode;
}

export function StatusCard({
  icon,
  label,
  value,
  detail,
  tone,
  badge,
  action,
}: StatusCardProps) {
  return (
    <section className="status-card" aria-label={label}>
      <div className="status-card-top">
        <span className={`status-card-icon is-${tone}`}>
          <Icon name={icon} />
        </span>
        <span className={`status-badge is-${tone}`}>
          <span className="status-indicator" aria-hidden="true" />
          {badge}
        </span>
      </div>
      <p className="status-label">{label}</p>
      <p className="status-value" role="status" aria-live="polite">
        {value}
      </p>
      <p className="status-detail">{detail}</p>
      {action}
    </section>
  );
}
