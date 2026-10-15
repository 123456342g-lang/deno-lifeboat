import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { taskCommand, type DenoConfig } from "./denoConfig.js";
import { mapDirectSpecifier } from "./imports.js";
import { convertTask } from "./tasks.js";
import type { Dependency, Finding, Target } from "./types.js";

export interface PlannedFile {
  /** POSIX path relative to the project root. */
  readonly path: string;
  readonly content: string;
  /** Content currently on disk, if the file exists. */
  readonly original?: string;
}

export interface ConfigInput {
  readonly root: string;
  readonly target: Target;
  readonly deno: DenoConfig;
  readonly dependencies: readonly Dependency[];
  readonly testPatterns: readonly string[];
  readonly entry?: string;
  readonly cronTriggers: readonly string[];
  readonly usesTypeScript: boolean;
  /** UTC date (YYYY-MM-DD) for the generated Workers compatibility_date. */
  readonly today: string;
}

export interface ConfigOutput {
  readonly files: readonly PlannedFile[];
  readonly findings: readonly Finding[];
}

type Json = Record<string, unknown>;

const NODE_ENGINE = ">=22.18";
const JSR_REGISTRY_LINE = "@jsr:registry=https://npm.jsr.io";
const DEV_DEPENDENCIES: Readonly<Record<Target, Readonly<Record<string, string>>>> = {
  node: { "@types/node": "^22.10.0" },
  bun: { "@types/bun": "^1.2.0" },
  workers: { wrangler: "^4.0.0" },
};

function readText(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

export function npmPackageName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9@/._-]+/g, "-")
    .replace(/^[._-]+/, "");
  return /^@[^/]+\/[^/]+$/.test(cleaned) ? cleaned : cleaned.replaceAll("/", "-").replaceAll("@", "") || "app";
}

/** Merges dependencies; an explicit version beats "latest", otherwise the first one wins. */
export function mergeDependencies(deps: readonly Dependency[]): { prod: Record<string, string>; dev: Record<string, string> } {
  const prod: Record<string, string> = {};
  const dev: Record<string, string> = {};
  for (const dep of deps) {
    const bucket = dep.dev ? dev : prod;
    const current = bucket[dep.name];
    if (current === undefined || (/latest$/.test(current) && !/latest$/.test(dep.spec))) bucket[dep.name] = dep.spec;
  }
  return { prod, dev };
}

export function importMapDependencies(deno: DenoConfig): Dependency[] {
  return Object.values(deno.importMap?.imports ?? {}).flatMap((value) => {
    const mapped = mapDirectSpecifier(value);
    return mapped.kind === "rewrite" ? [...mapped.deps] : [];
  });
}

function lineOf(text: string | undefined, needle: string): number {
  if (!text) return 1;
  const index = text.indexOf(needle);
  return index === -1 ? 1 : text.slice(0, index).split("\n").length;
}

function convertTasks(input: ConfigInput, configText: string | undefined): { scripts: Record<string, string>; findings: Finding[] } {
  const scripts: Record<string, string> = {};
  const findings: Finding[] = [];
  const file = input.deno.file ? path.basename(input.deno.file) : "deno.json";
  for (const [name, task] of Object.entries(input.deno.tasks)) {
    const command = taskCommand(task);
    if (command === undefined) continue;
    const result = convertTask(command, { target: input.target, testPatterns: input.testPatterns });
    scripts[name] = result.script;
    const message = `"${command}" → "${result.script}"${result.note ? ` (${result.note})` : ""}`;
    findings.push({ file, line: lineOf(configText, `"${name}"`), column: 1, api: `task:${name}`, category: "config", status: result.status, message });
    if (typeof task === "object" && task.dependencies && task.dependencies.length > 0) {
      const runner = input.target === "bun" ? "bun run" : "npm run";
      scripts[name] = [...task.dependencies.map((d) => `${runner} ${d}`), result.script].join(" && ");
    }
  }
  return { scripts, findings };
}

function packageJson(input: ConfigInput, scripts: Record<string, string>, existing: Json | undefined): Json {
  const { prod, dev } = mergeDependencies([...importMapDependencies(input.deno), ...input.dependencies]);
  const devDefaults = input.target === "workers" || input.usesTypeScript ? DEV_DEPENDENCIES[input.target] : {};
  const base: Json = existing ?? {
    name: npmPackageName(input.deno.name ?? path.basename(input.root)),
    version: input.deno.version ?? "0.0.0",
    private: true,
  };
  const existingRecord = (key: string): Record<string, string> => (base[key] as Record<string, string> | undefined) ?? {};
  const merged: Json = {
    ...base,
    type: "module",
    scripts: { ...scripts, ...existingRecord("scripts") },
    dependencies: { ...prod, ...existingRecord("dependencies") },
    devDependencies: { ...devDefaults, ...dev, ...existingRecord("devDependencies") },
  };
  if (input.target === "node" && base.engines === undefined) merged.engines = { node: NODE_ENGINE };
  for (const key of ["scripts", "dependencies", "devDependencies"]) {
    if (Object.keys(merged[key] as Json).length === 0) delete merged[key];
  }
  return merged;
}

function compilerOptions(input: ConfigInput): Json {
  const fromDeno: Json = {};
  for (const key of ["jsx", "jsxImportSource", "jsxFactory", "jsxFragmentFactory", "strict", "noImplicitAny", "noUnusedLocals"]) {
    if (input.deno.compilerOptions[key] !== undefined) fromDeno[key] = input.deno.compilerOptions[key];
  }
  if (fromDeno.jsx === "precompile") fromDeno.jsx = "react-jsx";
  const common = { target: "ES2022", strict: true, skipLibCheck: true, allowImportingTsExtensions: true, noEmit: true };
  switch (input.target) {
    case "node":
      return { ...common, module: "NodeNext", moduleResolution: "NodeNext", types: ["node"], ...fromDeno };
    case "bun":
      return { ...common, module: "Preserve", moduleResolution: "bundler", types: ["bun"], ...fromDeno };
    case "workers":
      return { ...common, module: "ES2022", moduleResolution: "bundler", types: ["./worker-configuration.d.ts"], ...fromDeno };
    default: {
      const exhaustive: never = input.target;
      throw new Error(`unknown target ${String(exhaustive)}`);
    }
  }
}

function wranglerConfig(input: ConfigInput): string {
  const config: Json = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: npmPackageName(input.deno.name ?? path.basename(input.root)).replace(/^@[^/]+\//, ""),
    main: input.entry ?? "main.ts",
    compatibility_date: input.today,
    compatibility_flags: ["nodejs_compat"],
    ...(input.cronTriggers.length > 0 ? { triggers: { crons: [...new Set(input.cronTriggers)] } } : {}),
  };
  return `// Generated by deno-lifeboat. See https://developers.cloudflare.com/workers/wrangler/configuration/\n${JSON.stringify(config, null, 2)}\n`;
}

function npmrc(original: string | undefined): string | undefined {
  if (original?.split("\n").some((line) => line.trim() === JSR_REGISTRY_LINE)) return undefined;
  const prefix = original && !original.endsWith("\n") ? `${original}\n` : (original ?? "");
  return `${prefix}${JSR_REGISTRY_LINE}\n`;
}

function parseExistingPackageJson(text: string | undefined, file: string): Json | undefined {
  if (text === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Json;
  } catch {
    // fall through
  }
  throw new Error(`${file}: existing package.json is not valid JSON; fix it before migrating`);
}

function configFindings(input: ConfigInput, configText: string | undefined): Finding[] {
  const file = input.deno.file ? path.basename(input.deno.file) : "deno.json";
  const at = (needle: string): number => lineOf(configText, needle);
  const findings: Finding[] = [];
  if (input.deno.hasScopes) {
    findings.push({ file, line: at('"scopes"'), column: 1, api: "scopes", category: "config", status: "manual", message: "import map scopes are not migrated; resolve them into plain dependencies" });
  }
  if (input.deno.workspace.length > 0) {
    findings.push({ file, line: at('"workspace"'), column: 1, api: "workspace", category: "config", status: "manual", message: "Deno workspace: run lifeboat inside each member and add an npm/bun `workspaces` field" });
  }
  if (input.deno.exports !== undefined) {
    findings.push({ file, line: at('"exports"'), column: 1, api: "exports", category: "config", status: "info", message: "library exports: publishing to npm needs a build step (tsc/tsup) and an `exports` map in package.json" });
  }
  if (input.deno.unstable.length > 0) {
    findings.push({ file, line: at('"unstable"'), column: 1, api: "unstable", category: "config", status: "info", message: `Deno unstable features enabled: ${input.deno.unstable.join(", ")}` });
  }
  return findings;
}

export function planConfig(input: ConfigInput): ConfigOutput {
  const configText = input.deno.file ? readText(input.deno.file) : undefined;
  const { scripts, findings: taskFindings } = convertTasks(input, configText);
  const files: PlannedFile[] = [];
  const pkgPath = path.join(input.root, "package.json");
  const pkgOriginal = readText(pkgPath);
  const pkg = packageJson(input, scripts, parseExistingPackageJson(pkgOriginal, pkgPath));
  files.push({ path: "package.json", content: `${JSON.stringify(pkg, null, 2)}\n`, original: pkgOriginal });

  if (input.usesTypeScript && !existsSync(path.join(input.root, "tsconfig.json"))) {
    const tsconfig = { compilerOptions: compilerOptions(input), exclude: ["node_modules"] };
    files.push({ path: "tsconfig.json", content: `${JSON.stringify(tsconfig, null, 2)}\n` });
  }
  const allDeps = [...importMapDependencies(input.deno), ...input.dependencies];
  if (allDeps.some((d) => d.registry === "jsr")) {
    const original = readText(path.join(input.root, ".npmrc"));
    const content = npmrc(original);
    if (content !== undefined) files.push({ path: ".npmrc", content, original });
  }
  const hasWrangler = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"].some((f) => existsSync(path.join(input.root, f)));
  if (input.target === "workers" && !hasWrangler) files.push({ path: "wrangler.jsonc", content: wranglerConfig(input) });
  return { files, findings: [...taskFindings, ...configFindings(input, configText)] };
}
