type Level = "debug" | "info" | "warn" | "error";

export type LogContext = {
  service?: string;
  projectId?: string;
  deploymentId?: string;
  jobId?: string;
  correlationId?: string;
  [k: string]: unknown;
};

function emit(level: Level, message: string, ctx: LogContext = {}) {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: ctx.service ?? "control-plane",
    message,
    ...ctx,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (m: string, c?: LogContext) => emit("debug", m, c),
  info: (m: string, c?: LogContext) => emit("info", m, c),
  warn: (m: string, c?: LogContext) => emit("warn", m, c),
  error: (m: string, c?: LogContext) => emit("error", m, c),
  child: (base: LogContext) => ({
    debug: (m: string, c?: LogContext) => emit("debug", m, { ...base, ...c }),
    info: (m: string, c?: LogContext) => emit("info", m, { ...base, ...c }),
    warn: (m: string, c?: LogContext) => emit("warn", m, { ...base, ...c }),
    error: (m: string, c?: LogContext) => emit("error", m, { ...base, ...c }),
  }),
};
