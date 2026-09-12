import fs from "node:fs/promises";
import path from "node:path";

export type BuildConfig = {
  framework: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  installCommand: string;
  buildCommand: string | null;
  startCommand: string;
  testCommand: string | null;
  outputDirectory: string | null;
  runtime: "node" | "static";
  port: number;
};

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
};

export async function detectFramework(root: string): Promise<BuildConfig> {
  const pkg = await readJson<PackageJson>(path.join(root, "package.json"));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const scripts = pkg?.scripts ?? {};

  let packageManager: BuildConfig["packageManager"] = "npm";
  if (await exists(path.join(root, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (await exists(path.join(root, "yarn.lock"))) packageManager = "yarn";
  else if (await exists(path.join(root, "bun.lockb"))) packageManager = "bun";
  else if (pkg?.packageManager?.startsWith("pnpm")) packageManager = "pnpm";

  const hasLock =
    (await exists(path.join(root, "package-lock.json"))) ||
    (await exists(path.join(root, "npm-shrinkwrap.json")));

  const install =
    packageManager === "npm"
      ? hasLock
        ? "npm ci"
        : "npm install"
      : packageManager === "pnpm"
        ? "pnpm install --frozen-lockfile"
        : packageManager === "yarn"
          ? "yarn install --frozen-lockfile"
          : "bun install";

  const run = (script: string) =>
    packageManager === "npm"
      ? `npm run ${script}`
      : packageManager === "bun"
        ? `bun run ${script}`
        : `${packageManager} run ${script}`;

  if (!pkg) {
    const staticRoot = (await exists(path.join(root, "index.html"))) ? "." : "public";
    return {
      framework: "static",
      packageManager,
      installCommand: "",
      buildCommand: null,
      startCommand: "",
      testCommand: null,
      outputDirectory: staticRoot,
      runtime: "static",
      port: 0,
    };
  }

  const has = (name: string) => Boolean(deps[name]);
  let framework = "node";
  let outputDirectory: string | null = null;
  let runtime: BuildConfig["runtime"] = "node";
  let startCommand = scripts.start ? run("start") : "node index.js";

  if (has("next")) {
    framework = "nextjs";
    outputDirectory = ".next";
    startCommand = scripts.start ? run("start") : "npx next start";
  } else if (has("nuxt") || has("nuxt3")) {
    framework = "nuxt";
    outputDirectory = ".output";
  } else if (has("@remix-run/dev")) {
    framework = "remix";
    outputDirectory = "build";
  } else if (has("astro")) {
    framework = "astro";
    outputDirectory = "dist";
  } else if (has("vite")) {
    framework = has("react") ? "vite-react" : "vite";
    outputDirectory = "dist";
    runtime = scripts.start ? "node" : "static";
  } else if (has("@nestjs/core")) {
    framework = "nestjs";
    outputDirectory = "dist";
    startCommand = scripts["start:prod"] ? run("start:prod") : startCommand;
  } else if (has("express") || has("fastify") || has("koa")) {
    framework = has("express") ? "express" : has("fastify") ? "fastify" : "koa";
  } else if (has("react-scripts")) {
    framework = "create-react-app";
    outputDirectory = "build";
    runtime = "static";
  }

  return {
    framework,
    packageManager,
    installCommand: install,
    buildCommand: scripts.build ? run("build") : null,
    startCommand,
    testCommand: scripts.test ? run("test") : null,
    outputDirectory,
    runtime,
    port: 3000,
  };
}

/** Detector output never overwrites explicit user configuration. */
export function mergeConfig(
  detected: BuildConfig,
  overrides: Partial<Record<keyof BuildConfig, string | null>>,
): BuildConfig {
  const pick = <K extends keyof BuildConfig>(key: K): BuildConfig[K] => {
    const value = overrides[key];
    if (value === undefined || value === null || value === "") return detected[key];
    return value as BuildConfig[K];
  };
  return {
    framework: pick("framework"),
    packageManager: pick("packageManager"),
    installCommand: pick("installCommand"),
    buildCommand: pick("buildCommand"),
    startCommand: pick("startCommand"),
    testCommand: pick("testCommand"),
    outputDirectory: pick("outputDirectory"),
    runtime: detected.runtime,
    port: detected.port,
  };
}
