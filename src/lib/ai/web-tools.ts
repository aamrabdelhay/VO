import dns from "node:dns/promises";
import net from "node:net";
import { redact } from "@/lib/crypto";
import { getPlatformSecret } from "@/lib/platform-secrets";

export class WebToolDenied extends Error {}

function isPrivate(address: string) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a === 0;
  }
  const value = address.toLowerCase();
  return value === "::1" || value === "::" || value.startsWith("fe80:") || value.startsWith("fc") || value.startsWith("fd");
}

export async function assertPublicHttpUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new WebToolDenied("Invalid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebToolDenied("Only http(s) URLs are allowed");
  if (url.username || url.password) throw new WebToolDenied("Credentials in URLs are not allowed");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivate(entry.address))) throw new WebToolDenied("URL resolves to a private, loopback, link-local or reserved address");
  return url.toString();
}

export async function webSearch(query: string) {
  const key = (await getPlatformSecret("SEARCH_API_KEY")) ?? process.env.SEARCH_API_KEY ?? null;
  if (!key) throw new WebToolDenied("SEARCH_API_KEY is not configured");
  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
    headers: { accept: "application/json", "x-subscription-token": key, "user-agent": "VO-Garvex/1.0" },
    signal: AbortSignal.timeout(10000),
    cache: "no-store",
  });
  if (!response.ok) throw new WebToolDenied(`Search provider failed (${response.status})`);
  const data = (await response.json()) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
  return (data.web?.results ?? []).slice(0, 8).map((item) => ({ title: item.title ?? "", url: item.url ?? "", snippet: item.description ?? "" }));
}

function readable(body: string, contentType: string) {
  if (!contentType.includes("html") && !/<html[\s>]/i.test(body)) return body.replace(/\s+/g, " ").trim();
  return body.replace(/<!--[\s\S]*?-->/g, " ").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>(?=.)/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim();
}

export async function webFetch(input: string, secrets: string[] = []) {
  let current = await assertPublicHttpUrl(input);
  let response: Response | null = null;
  for (let redirects = 0; redirects < 4; redirects += 1) {
    response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(10000), headers: { accept: "text/html,text/plain,application/xhtml+xml", "user-agent": "VO-Garvex/1.0" }, cache: "no-store" });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) break;
    current = await assertPublicHttpUrl(new URL(location, current).toString());
  }
  if (!response || !response.ok) throw new WebToolDenied(`Web fetch failed (${response?.status ?? "unknown"})`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 2 * 1024 * 1024) throw new WebToolDenied("Fetched response exceeds the 2MB safety limit");
  return redact(readable(new TextDecoder().decode(bytes), response.headers.get("content-type") ?? "").slice(0, 30000), secrets);
}
