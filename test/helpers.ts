import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleKind, ModuleResolutionKind, Project } from "ts-morph";
import type { ImportMap } from "../src/imports.js";
import { rewriteFile, type FileResult } from "../src/rewrite/fileRewriter.js";
import type { Target } from "../src/types.js";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const FIXTURES = path.join(REPO_ROOT, "test", "fixtures");
export const CLI = path.join(REPO_ROOT, "dist", "src", "cli.js");

export interface SnippetOptions {
  readonly target?: Target;
  readonly fileName?: string;
  readonly importMap?: Readonly<Record<string, string>>;
  readonly emitTodos?: boolean;
}

/** Rewrites a code snippet as if it were `/proj/<fileName>` in a project rooted at /proj. */
export function rewrite(code: string, options: SnippetOptions = {}): FileResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, allowImportingTsExtensions: true, noEmit: true, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler },
  });
  const file = project.createSourceFile(`/proj/${options.fileName ?? "main.ts"}`, code);
  const importMap: ImportMap | undefined = options.importMap ? { imports: options.importMap, baseDir: "/proj" } : undefined;
  return rewriteFile(file, {
    target: options.target ?? "node",
    root: "/proj",
    importMap,
    emitTodos: options.emitTodos ?? false,
  });
}

/** Copies a fixture into a fresh temp dir and commits it to a new git repo. */
export function fixtureRepo(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `lifeboat-${name}-`));
  cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  const git = (...args: string[]): void => void execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "fixture");
  return dir;
}

export function runCli(args: readonly string[], cwd = REPO_ROOT): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** `--experimental-strip-types` when this Node needs it, `undefined` when it can't run TypeScript at all. */
export function stripTypesFlags(): string[] | undefined {
  const features = process.features as { typescript?: string | false };
  if (features.typescript) return [];
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 6)) return ["--experimental-strip-types", "--no-warnings"];
  return undefined;
}

export function bunPath(): string | undefined {
  for (const candidate of ["bun", path.join(process.env.HOME ?? "", ".bun", "bin", "bun")]) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}
