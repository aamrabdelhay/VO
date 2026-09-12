import dns from "node:dns/promises";
import net from "node:net";

const BLOCKED_HOSTNAMES = new Set(["metadata.google.internal", "metadata", "instance-data"]);

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  const lower = ip.toLowerCase();
  return (
    lower === "::1" ||
    lower === "::" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe80") ||
    lower.startsWith("::ffff:")
  );
}

export type GuardOptions = {
  /** Allow loopback: required for health checking runtimes on the local host. */
  allowLoopback?: boolean;
};

/**
 * SSRF guard for every user-influenced URL (health checks, integrations, AI tools).
 */
export async function assertSafeUrl(rawUrl: string, opts: GuardOptions = {}) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed");
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) throw new Error("Blocked host");

  const loopbackNames = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (opts.allowLoopback && loopbackNames.has(host)) return url;

  let addresses: string[] = [];
  if (net.isIP(host)) addresses = [host];
  else {
    const resolved = await dns.lookup(host, { all: true }).catch(() => []);
    addresses = resolved.map((r) => r.address);
  }
  if (addresses.length === 0) throw new Error("Host could not be resolved");
  for (const address of addresses) {
    if (isPrivateIp(address) && !(opts.allowLoopback && address.startsWith("127."))) {
      throw new Error("Requests to private network ranges are blocked");
    }
  }
  return url;
}

export async function safeFetch(rawUrl: string, init: RequestInit & { timeoutMs?: number } = {}) {
  await assertSafeUrl(rawUrl, { allowLoopback: false });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8000);
  try {
    return await fetch(rawUrl, { ...init, signal: controller.signal, redirect: "error" });
  } finally {
    clearTimeout(timer);
  }
}
