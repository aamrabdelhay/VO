import type { ReactNode } from "react";

const STATUS_TONE: Record<string, string> = {
  PROMOTED: "var(--color-success)",
  HEALTHY: "var(--color-success)",
  ACTIVE: "var(--color-success)",
  QUEUED: "var(--color-fg-muted)",
  CLONING: "var(--color-info)",
  BUILDING: "var(--color-info)",
  TESTING: "var(--color-info)",
  BUILT: "var(--color-info)",
  STARTING: "var(--color-info)",
  HEALTH_CHECKING: "var(--color-info)",
  PROMOTING: "var(--color-info)",
  DRAINING: "var(--color-warning)",
  ROLLED_BACK: "var(--color-warning)",
  PENDING: "var(--color-warning)",
  DNS_VERIFICATION: "var(--color-warning)",
  CERTIFICATE_REQUESTED: "var(--color-warning)",
  FAILED: "var(--color-danger)",
  STOPPED: "var(--color-fg-muted)",
  CANCELED: "var(--color-fg-muted)",
  OBSOLETE: "var(--color-fg-muted)",
  REMOVED: "var(--color-fg-muted)",
};

export function StatusDot({ status }: { status: string }) {
  const color = STATUS_TONE[status] ?? "var(--color-fg-muted)";
  return (
    <span
      aria-hidden
      style={{
        width: 6,
        height: 6,
        borderRadius: 9999,
        background: color,
        display: "inline-block",
        flex: "none",
      }}
    />
  );
}

export function Status({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <StatusDot status={status} />
      <span style={{ color: "var(--color-fg-secondary)" }}>{status.replace(/_/g, " ").toLowerCase()}</span>
    </span>
  );
}

export function Panel({
  title,
  actions,
  children,
  bodyClass = "",
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
  bodyClass?: string;
}) {
  return (
    <section className="panel">
      {title ? (
        <header className="panel-header">
          <h2 className="panel-title">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="panel px-3.5 py-3">
      <div style={{ color: "var(--color-fg-muted)", fontSize: 11, letterSpacing: "0.04em" }}>
        {label.toUpperCase()}
      </div>
      <div className="mt-1.5 text-[19px] font-medium leading-none">{value}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <p style={{ color: "var(--color-fg-secondary)" }}>{title}</p>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function KeyValue({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="divide-y" style={{ borderColor: "var(--color-border)" }}>
      {items.map(([k, v]) => (
        <div key={k} className="flex items-start justify-between gap-6 px-3.5 py-2.5">
          <dt style={{ color: "var(--color-fg-muted)" }}>{k}</dt>
          <dd className="text-right">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function timeAgo(value: Date | string | null | undefined) {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  const diff = Date.now() - date.getTime();
  const units: [number, string][] = [
    [1000, "s"],
    [60_000, "m"],
    [3_600_000, "h"],
    [86_400_000, "d"],
  ];
  if (diff < 60_000) return `${Math.max(1, Math.round(diff / units[0][0]))}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / units[1][0])}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / units[2][0])}h ago`;
  return `${Math.round(diff / units[3][0])}d ago`;
}

export function duration(from: Date | string | null, to: Date | string | null) {
  if (!from || !to) return "—";
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function bytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
