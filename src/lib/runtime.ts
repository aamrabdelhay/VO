import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";

export type CommandResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

export type RunOptions = {
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void | Promise<void>;
  maxOutputBytes?: number;
};

/**
 * Executes a command inside a build/runtime sandbox.
 * - no shell metacharacter injection from callers: argv form
 * - hard wall-clock timeout
 * - bounded captured output
 * - a scrubbed environment (never inherits platform secrets)
 */
export function runCommand(
  file: string,
  args: string[],
  opts: RunOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const maxBytes = opts.maxOutputBytes ?? 2 * 1024 * 1024;
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: sandboxEnv(opts.env) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"] as const,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 10 * 60 * 1000);

    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      if (stdout.length < maxBytes) stdout += text;
      void opts.onOutput?.(text, "stdout");
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      if (stderr.length < maxBytes) stderr += text;
      void opts.onOutput?.(text, "stderr");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

/** Shell-free command string parser used for user-configured build commands. */
export function parseCommand(command: string): { file: string; args: string[] } {
  const tokens = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const cleaned = tokens.map((t) => t.replace(/^["']|["']$/g, ""));
  const [file, ...args] = cleaned;
  if (!file) throw new Error("Empty command");
  if (/[;&|><`$]/.test(command)) throw new Error("Command contains disallowed shell metacharacters");
  return { file, args };
}

function sandboxEnv(extra: Record<string, string> = {}) {
  // Explicit allowlist: platform secrets (DATABASE_URL, encryption keys, provider
  // keys, registry credentials) are never inherited by user workloads.
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    LANG: "C.UTF-8",
    CI: "1",
    NODE_ENV: "production",
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  return { ...base, ...extra };
}

export async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        const port = address.port;
        server.close(() => resolve(port));
      } else reject(new Error("Could not allocate port"));
    });
  });
}

/* ------------------------------------------------------------- drivers */

export type RuntimeSpec = {
  projectId: string;
  deploymentId: string;
  workspace: string;
  command: string;
  port: number;
  env: Record<string, string>;
  memoryLimitMb: number;
  cpuLimit: number;
  pidsLimit: number;
  imageRef?: string | null;
};

export type RuntimeHandle = { externalId: string; pid?: number; driver: string };

export interface RuntimeDriver {
  readonly name: string;
  available(): Promise<boolean>;
  start(spec: RuntimeSpec): Promise<RuntimeHandle>;
  stop(externalId: string, graceMs?: number): Promise<void>;
  running(externalId: string): Promise<boolean>;
  stats(externalId: string): Promise<{ cpuPercent?: number; memoryMb?: number } | null>;
}

/** Data-plane driver: OCI containers with hardened defaults. */
export class DockerRuntimeDriver implements RuntimeDriver {
  readonly name = "docker";

  async available() {
    const res = await runCommand("docker", ["version", "--format", "{{.Server.Version}}"], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    return res.code === 0;
  }

  async start(spec: RuntimeSpec): Promise<RuntimeHandle> {
    const name = `app-${spec.deploymentId.slice(0, 12)}`;
    const envArgs = Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--restart",
      "no",
      // hardening: unprivileged, capability-dropped, non-writable rootfs
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=128m",
      "--pids-limit",
      String(spec.pidsLimit),
      "--memory",
      `${spec.memoryLimitMb}m`,
      "--cpus",
      String(spec.cpuLimit),
      "--network",
      process.env.PLATFORM_RUNTIME_NETWORK ?? "bridge",
      "-p",
      `127.0.0.1:${spec.port}:${spec.port}`,
      ...envArgs,
      "-e",
      `PORT=${spec.port}`,
      spec.imageRef ?? "",
    ].filter(Boolean);
    const res = await runCommand("docker", args, { cwd: process.cwd(), timeoutMs: 120000 });
    if (res.code !== 0) throw new Error(`docker run failed: ${res.stderr.slice(0, 500)}`);
    return { externalId: name, driver: this.name };
  }

  async stop(externalId: string, graceMs = 10000) {
    await runCommand("docker", ["stop", "-t", String(Math.ceil(graceMs / 1000)), externalId], {
      cwd: process.cwd(),
      timeoutMs: graceMs + 15000,
    });
    await runCommand("docker", ["rm", "-f", externalId], { cwd: process.cwd(), timeoutMs: 30000 });
  }

  async running(externalId: string) {
    const res = await runCommand("docker", ["inspect", "-f", "{{.State.Running}}", externalId], {
      cwd: process.cwd(),
      timeoutMs: 10000,
    });
    return res.code === 0 && res.stdout.trim() === "true";
  }

  async stats(externalId: string) {
    const res = await runCommand(
      "docker",
      ["stats", "--no-stream", "--format", "{{.CPUPerc}}|{{.MemUsage}}", externalId],
      { cwd: process.cwd(), timeoutMs: 15000 },
    );
    if (res.code !== 0) return null;
    const [cpu, mem] = res.stdout.trim().split("|");
    return {
      cpuPercent: Number.parseFloat(cpu?.replace("%", "") ?? "0") || 0,
      memoryMb: Number.parseFloat(mem?.split("/")[0] ?? "0") || 0,
    };
  }
}

/**
 * Single-host process driver used when Docker is not present on the host.
 * Processes are started detached in their own process group, with an isolated
 * environment and their own workspace, and are tracked in container_instances.
 */
export class ProcessRuntimeDriver implements RuntimeDriver {
  readonly name = "process";

  async available() {
    return true;
  }

  async start(spec: RuntimeSpec): Promise<RuntimeHandle> {
    const { file, args } = parseCommand(spec.command);
    const logFile = path.join(spec.workspace, ".runtime.log");
    await fs.writeFile(logFile, "", "utf8").catch(() => undefined);
    const out = await fs.open(logFile, "a");
    const child = spawn(file, args, {
      cwd: spec.workspace,
      detached: true,
      env: sandboxEnv({ ...spec.env, PORT: String(spec.port) }) as NodeJS.ProcessEnv,
      stdio: ["ignore", out.fd, out.fd] as const,
    });
    child.unref();
    if (!child.pid) throw new Error("Runtime process failed to start");
    return { externalId: String(child.pid), pid: child.pid, driver: this.name };
  }

  async stop(externalId: string, graceMs = 8000) {
    const pid = Number(externalId);
    if (!Number.isFinite(pid)) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return;
      }
    }
    await new Promise((r) => setTimeout(r, Math.min(graceMs, 8000)));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }

  async running(externalId: string) {
    const pid = Number(externalId);
    if (!Number.isFinite(pid)) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async stats(externalId: string) {
    const pid = Number(externalId);
    if (!Number.isFinite(pid)) return null;
    const res = await runCommand("ps", ["-p", String(pid), "-o", "%cpu=,rss="], {
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    if (res.code !== 0) return null;
    const [cpu, rss] = res.stdout.trim().split(/\s+/);
    return {
      cpuPercent: Number.parseFloat(cpu ?? "0") || 0,
      memoryMb: (Number.parseFloat(rss ?? "0") || 0) / 1024,
    };
  }
}

let cached: RuntimeDriver | null = null;

export async function getRuntimeDriver(): Promise<RuntimeDriver> {
  if (cached) return cached;
  const preferred = process.env.PLATFORM_RUNTIME_DRIVER;
  const docker = new DockerRuntimeDriver();
  if (preferred === "process") cached = new ProcessRuntimeDriver();
  else if (preferred === "docker" || (await docker.available())) cached = docker;
  else cached = new ProcessRuntimeDriver();
  return cached;
}
