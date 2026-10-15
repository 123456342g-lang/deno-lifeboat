#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { CHECKLIST_FILE } from "./checklist.js";
import { ConfigError } from "./denoConfig.js";
import { writeChanges, WriteRefusedError } from "./migrate.js";
import { analyzeProject, ProjectError, type Analysis } from "./project.js";
import { analysisJson, envelope, errorEnvelope, formatDiff, formatNextStep, formatReport } from "./report.js";
import { SHIM_DIR } from "./rewrite/fileRewriter.js";
import { isTarget, TARGETS, type Target } from "./types.js";

const HELP = `deno-lifeboat — move a Deno project to Node.js, Bun or Cloudflare Workers

Usage:
  lifeboat scan [dir] [--to node|bun|workers] [--json]
      Read-only report: Deno APIs and imports, how much migrates automatically, and a file:line list of the rest.

  lifeboat migrate [dir] --to node|bun|workers [--write] [--force] [--json] [--no-todo]
      Dry run by default: prints the diff. --write applies it (refuses on a dirty git tree unless --force).
      deno.json is never modified or deleted.

Options:
  --to <target>   node (default for scan), bun, or workers
  --write         apply the changes
  --force         write even if the git tree is dirty or not a git repo
  --json          machine-readable output ({ ok, data, error })
  --no-todo       don't insert "// lifeboat: TODO" comments for manual items
  -h, --help      show this help
  -v, --version   show the version
`;

class UsageError extends Error {}

interface CliOptions {
  readonly command: "scan" | "migrate";
  readonly dir: string;
  readonly target: Target;
  readonly write: boolean;
  readonly force: boolean;
  readonly json: boolean;
  readonly todo: boolean;
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

function parseFlags(argv: readonly string[]) {
  try {
    return parseRawFlags(argv);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function parseRawFlags(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      to: { type: "string" },
      write: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "no-todo": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
}

function parseCli(argv: readonly string[]): CliOptions | "help" | "version" {
  const { values, positionals } = parseFlags(argv);
  if (values.version) return "version";
  const [command, dir = ".", ...extra] = positionals;
  if (values.help || command === undefined || command === "help") return "help";
  if (command !== "scan" && command !== "migrate") throw new UsageError(`unknown command "${command}" (expected scan or migrate)`);
  if (extra.length > 0) throw new UsageError(`unexpected arguments: ${extra.join(" ")}`);
  const to = values.to ?? (command === "scan" ? "node" : undefined);
  if (to === undefined) throw new UsageError(`migrate needs --to (${TARGETS.join(", ")})`);
  if (!isTarget(to)) throw new UsageError(`unknown target "${to}" (expected ${TARGETS.join(", ")})`);
  if (command === "scan" && (values.write || values.force)) throw new UsageError("scan is read-only; use migrate --write");
  return { command, dir, target: to, write: values.write, force: values.force, json: values.json, todo: !values["no-todo"] };
}

function isBulky(path: string): boolean {
  return path === CHECKLIST_FILE || path.startsWith(`${SHIM_DIR}/`);
}

function printDiff(analysis: Analysis): void {
  const shown = analysis.changes.filter((c) => !isBulky(c.path));
  const bulky = analysis.changes.filter((c) => isBulky(c.path));
  if (shown.length > 0) process.stdout.write(`\n${formatDiff(shown, pc.isColorSupported)}\n`);
  for (const file of bulky) {
    const lines = file.content.split("\n").length;
    process.stdout.write(pc.green(`+ ${file.original === undefined ? "create" : "update"} ${file.path} (${lines} lines)\n`));
  }
}

function printChecklist(analysis: Analysis): void {
  const checklist = analysis.changes.find((c) => c.path === CHECKLIST_FILE);
  if (checklist) process.stdout.write(`\n${checklist.content}\n`);
}

function run(options: CliOptions): number {
  const analysis = analyzeProject(options.dir, { target: options.target, emitTodos: options.command === "migrate" && options.todo });
  if (options.command === "scan") {
    if (options.json) {
      process.stdout.write(`${JSON.stringify(envelope(analysisJson(analysis)), null, 2)}\n`);
      return 0;
    }
    process.stdout.write(formatReport(analysis, "scan"));
    if (options.target === "workers") printChecklist(analysis);
    process.stdout.write(formatNextStep(analysis, "scan", false));
    return 0;
  }
  const written = options.write ? writeChanges(analysis, options.force) : [];
  if (options.json) {
    const diff = formatDiff(analysis.changes, false);
    process.stdout.write(`${JSON.stringify(envelope(analysisJson(analysis, { written: written.map((c) => c.path), diff })), null, 2)}\n`);
    return 0;
  }
  if (!options.write) printDiff(analysis);
  process.stdout.write(formatReport(analysis, "migrate"));
  if (options.target === "workers") printChecklist(analysis);
  if (options.write) process.stdout.write(pc.dim(`\nWrote ${written.length} file(s): ${written.map((c) => c.path).join(", ")}\n`));
  process.stdout.write(formatNextStep(analysis, "migrate", options.write));
  return 0;
}

function main(argv: readonly string[]): number {
  let json = argv.includes("--json");
  try {
    const parsed = parseCli(argv);
    if (parsed === "help") {
      process.stdout.write(HELP);
      return 0;
    }
    if (parsed === "version") {
      process.stdout.write(`${version()}\n`);
      return 0;
    }
    json = parsed.json;
    return run(parsed);
  } catch (error) {
    const known = error instanceof UsageError || error instanceof WriteRefusedError || error instanceof ProjectError || error instanceof ConfigError;
    const message = error instanceof Error ? error.message : String(error);
    if (json) process.stdout.write(`${JSON.stringify(errorEnvelope(message), null, 2)}\n`);
    else process.stderr.write(`${pc.red("error:")} ${message}\n${error instanceof UsageError ? `\n${HELP}` : ""}`);
    if (!known && !json && error instanceof Error && error.stack) process.stderr.write(pc.dim(`${error.stack}\n`));
    return error instanceof WriteRefusedError ? 3 : error instanceof UsageError ? 2 : 1;
  }
}

process.exitCode = main(process.argv.slice(2));
