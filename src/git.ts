import { execFileSync } from "node:child_process";

export type GitState =
  | { readonly kind: "clean" }
  | { readonly kind: "dirty"; readonly files: readonly string[] }
  | { readonly kind: "not-a-repo" };

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** Working-tree state for `dir` (only paths under `dir` count). */
export function gitState(dir: string): GitState {
  try {
    if (git(dir, ["rev-parse", "--is-inside-work-tree"]).trim() !== "true") return { kind: "not-a-repo" };
  } catch {
    return { kind: "not-a-repo" };
  }
  const files = git(dir, ["status", "--porcelain", "--", "."])
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return files.length === 0 ? { kind: "clean" } : { kind: "dirty", files };
}

/** Returns an error message if writing is unsafe, or undefined when it may proceed. */
export function writeGuard(dir: string, force: boolean): string | undefined {
  if (force) return undefined;
  const state = gitState(dir);
  switch (state.kind) {
    case "clean":
      return undefined;
    case "dirty":
      return `refusing to write: the git working tree has uncommitted changes (${state.files.length} path(s), e.g. "${state.files[0]?.trim()}").\nCommit or stash them first so you can review and roll back the migration, or pass --force.`;
    case "not-a-repo":
      return "refusing to write: not inside a git repository, so the migration could not be rolled back.\nRun `git init && git add -A && git commit -m \"before lifeboat\"` first, or pass --force.";
    default: {
      const exhaustive: never = state;
      throw new Error(`unknown git state ${String(exhaustive)}`);
    }
  }
}
