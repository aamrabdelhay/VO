"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

async function api(path: string, init: RequestInit & { csrf?: string } = {}) {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.csrf ? { "x-csrf-token": init.csrf } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
  return json.data;
}

export function ActionButton({
  path,
  body,
  method = "POST",
  csrf,
  children,
  variant = "",
  confirm,
  onDone,
}: {
  path: string;
  body?: unknown;
  method?: string;
  csrf: string;
  children: ReactNode;
  variant?: "" | "btn-primary" | "btn-danger";
  confirm?: string;
  onDone?: (data: unknown) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <button
        className={`btn ${variant}`}
        disabled={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setError(null);
          try {
            const data = await api(path, {
              method,
              csrf,
              body: body ? JSON.stringify(body) : undefined,
            });
            onDone?.(data);
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Working…" : children}
      </button>
      {error ? (
        <span style={{ color: "var(--color-danger)", fontSize: 11, maxWidth: 320 }}>{error}</span>
      ) : null}
    </span>
  );
}

export function LoginForm({ allowRegister }: { allowRegister: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("admin@platform.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api("/api/v1/auth", {
            method: "POST",
            body: JSON.stringify({ action: mode, email, password }),
          });
          router.push("/dashboard");
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="input"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      {error ? (
        <p role="alert" style={{ color: "var(--color-danger)", fontSize: 12 }}>
          {error}
        </p>
      ) : null}
      <button className="btn btn-primary justify-center" type="submit" disabled={busy}>
        {busy ? "Signing in…" : mode === "login" ? "Sign in" : "Create account"}
      </button>
      {allowRegister ? (
        <button
          type="button"
          className="text-left"
          style={{ color: "var(--color-fg-muted)", fontSize: 11.5 }}
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "Create the first account" : "Back to sign in"}
        </button>
      ) : null}
    </form>
  );
}

export function NewProjectForm({ csrf }: { csrf: string }) {
  const router = useRouter();
  const [form, setForm] = useState({
    name: "",
    repoFullName: "",
    freeDomain: "",
    productionBranch: "main",
    rootDirectory: ".",
    installCommand: "",
    buildCommand: "",
    startCommand: "",
    healthPath: "/",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const field = (key: keyof typeof form, label: string, placeholder = "", hint?: string) => (
    <div>
      <label className="label" htmlFor={key}>
        {label}
      </label>
      <input
        id={key}
        className="input"
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );

  return (
    <form
      className="grid gap-4 md:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const data = (await api("/api/v1/projects", {
            method: "POST",
            csrf,
            body: JSON.stringify(form),
          })) as { project: { id: string } };
          router.push(`/projects/${data.project.id}`);
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {field("name", "Project name", "storefront")}
      {field(
        "freeDomain",
        "Free domain",
        "storefront",
        "Creates a free stable URL like storefront.vercel.app. Must be unique on the platform.",
      )}
      {field("repoFullName", "GitHub repository", "owner/repo", "Source of truth for every deployment")}
      {field("productionBranch", "Production branch", "main")}
      {field("rootDirectory", "Root directory", ".")}
      {field("installCommand", "Install command", "auto-detected")}
      {field("buildCommand", "Build command", "auto-detected")}
      {field("startCommand", "Start command", "auto-detected")}
      {field("healthPath", "Health check path", "/")}
      <div className="md:col-span-2 flex items-center gap-3">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create project"}
        </button>
        {error ? <span style={{ color: "var(--color-danger)", fontSize: 12 }}>{error}</span> : null}
      </div>
    </form>
  );
}

export function SettingsForm({
  csrf,
  projectId,
  fields,
  values,
}: {
  csrf: string;
  projectId: string;
  fields: { key: string; label: string; type?: "text" | "number" | "boolean" | "select"; options?: string[]; hint?: string }[];
  values: Record<string, unknown>;
}) {
  const router = useRouter();
  const [form, setForm] = useState<Record<string, unknown>>(values);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="grid gap-4 p-3.5 md:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setStatus(null);
        try {
          await api(`/api/v1/projects/${projectId}`, {
            method: "PATCH",
            csrf,
            body: JSON.stringify(form),
          });
          setStatus("Saved");
          router.refresh();
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {fields.map((f) => (
        <div key={f.key}>
          <label className="label" htmlFor={f.key}>
            {f.label}
          </label>
          {f.type === "boolean" ? (
            <select
              id={f.key}
              className="select"
              value={String(form[f.key] ?? false)}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value === "true" })}
            >
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
          ) : f.type === "select" ? (
            <select
              id={f.key}
              className="select"
              value={String(form[f.key] ?? "")}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            >
              {(f.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={f.key}
              className="input"
              type={f.type === "number" ? "number" : "text"}
              value={String(form[f.key] ?? "")}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          )}
          {f.hint ? <p className="hint">{f.hint}</p> : null}
        </div>
      ))}
      <div className="md:col-span-2 flex items-center gap-3">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {status ? <span className="hint">{status}</span> : null}
      </div>
    </form>
  );
}

export function LogStream({ deploymentId, live }: { deploymentId: string; live: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const load = async () => {
      try {
        const data = await api(`/api/v1/deployments/${deploymentId}/logs`);
        setLines(data?.lines ?? []);
      } catch {
        // The page still provides the durable event stream if log polling is unavailable.
      }
    };
    void load();
    if (live) timer.current = setInterval(load, 2000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [deploymentId, live]);

  return (
    <pre className="mono overflow-auto p-3" style={{ maxHeight: 420, fontSize: 11, lineHeight: 1.6 }}>
      {lines.join("\n") || "Waiting for deployment output…"}
    </pre>
  );
}