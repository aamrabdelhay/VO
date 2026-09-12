import { NextResponse } from "next/server";
import { HttpError } from "@/lib/auth";
import { log } from "@/lib/logger";

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ data }, init);
}

export function fail(status: number, message: string, details?: unknown) {
  return NextResponse.json({ error: { message, details } }, { status });
}

export async function handle<T>(fn: () => Promise<T>) {
  try {
    const result = await fn();
    if (result instanceof NextResponse) return result;
    return ok(result);
  } catch (error) {
    if (error instanceof HttpError) return fail(error.status, error.message);
    const message = error instanceof Error ? error.message : String(error);
    log.error("API request failed", { error: message });
    return fail(400, message);
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function requireFields<T extends object>(body: T, fields: (keyof T)[]) {
  for (const field of fields) {
    const value = body[field];
    if (value === undefined || value === null || value === "") {
      throw new HttpError(400, `Missing required field: ${String(field)}`);
    }
  }
}

const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) throw new HttpError(429, "Too many requests");
}
