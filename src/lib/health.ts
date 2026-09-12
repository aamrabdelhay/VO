import { db } from "@/db";
import { healthCheckResults } from "@/db/schema";
import { assertSafeUrl } from "@/lib/net-guard";

export type HealthPolicy = {
  path: string;
  expectedStatus: number;
  timeoutMs: number;
  initialDelayMs: number;
  intervalMs: number;
  retries: number;
};

export type HealthProbe = { ok: boolean; statusCode?: number; latencyMs: number; error?: string };

export async function probe(
  port: number,
  policy: Pick<HealthPolicy, "path" | "expectedStatus" | "timeoutMs">,
  host = "127.0.0.1",
): Promise<HealthProbe> {
  const url = `http://${host}:${port}${policy.path.startsWith("/") ? policy.path : `/${policy.path}`}`;
  // Loopback is allowed here (and only here): the target is a platform-managed runtime.
  await assertSafeUrl(url, { allowLoopback: true });
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    const latencyMs = Date.now() - started;
    const ok =
      res.status === policy.expectedStatus || (policy.expectedStatus === 200 && res.status < 400);
    return { ok, statusCode: res.status, latencyMs };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Readiness gate: repeatedly probes the *running* deployment until healthy. */
export async function waitForHealthy(
  input: { projectId: string; deploymentId: string; port: number },
  policy: HealthPolicy,
  onAttempt?: (attempt: number, result: HealthProbe) => Promise<void> | void,
): Promise<HealthProbe> {
  await sleep(policy.initialDelayMs);
  let last: HealthProbe = { ok: false, latencyMs: 0, error: "not attempted" };
  for (let attempt = 1; attempt <= policy.retries; attempt++) {
    last = await probe(input.port, policy);
    await db.insert(healthCheckResults).values({
      projectId: input.projectId,
      deploymentId: input.deploymentId,
      kind: "readiness",
      ok: last.ok,
      statusCode: last.statusCode ?? null,
      latencyMs: last.latencyMs,
      error: last.error ?? null,
    });
    await onAttempt?.(attempt, last);
    if (last.ok) return last;
    await sleep(policy.intervalMs);
  }
  return last;
}

export async function recordLiveness(
  projectId: string,
  deploymentId: string,
  result: HealthProbe,
) {
  await db.insert(healthCheckResults).values({
    projectId,
    deploymentId,
    kind: "liveness",
    ok: result.ok,
    statusCode: result.statusCode ?? null,
    latencyMs: result.latencyMs,
    error: result.error ?? null,
  });
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
