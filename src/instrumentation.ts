export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { log } = await import("@/lib/logger");
  try {
    const { bootstrapPlatform } = await import("@/lib/bootstrap");
    await bootstrapPlatform();
  } catch (error) {
    log.warn("Platform bootstrap skipped", { error: String(error) });
  }

  if (process.env.PLATFORM_DISABLE_WORKER === "1") {
    log.info("Worker loop disabled by configuration");
    return;
  }
  try {
    const { startWorkerLoop } = await import("@/lib/worker");
    startWorkerLoop();
  } catch (error) {
    log.error("Worker loop failed to start", { error: String(error) });
  }
}
