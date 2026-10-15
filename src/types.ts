export const TARGETS = ["node", "bun", "workers"] as const;
export type Target = (typeof TARGETS)[number];

export function isTarget(value: string): value is Target {
  return (TARGETS as readonly string[]).includes(value);
}

/**
 * auto   – rewritten (or shimmed) without human input
 * manual – needs a human; flagged with `// lifeboat: TODO` and listed in the report
 * type   – type-only reference (e.g. `Deno.Kv` in a type annotation): no runtime effect
 * info   – noteworthy, but nothing to do (e.g. `typeof Deno` runtime detection)
 */
export type Status = "auto" | "manual" | "type" | "info";

export type Category =
  | "env"
  | "process"
  | "fs"
  | "serve"
  | "cron"
  | "test"
  | "kv"
  | "net"
  | "subprocess"
  | "permissions"
  | "errors"
  | "runtime"
  | "deploy"
  | "import"
  | "syntax"
  | "config";

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly api: string;
  readonly category: Category;
  readonly status: Status;
  readonly message: string;
}

export interface Dependency {
  readonly name: string;
  readonly spec: string;
  readonly dev?: boolean;
  readonly registry?: "jsr";
}

export type ShimName = "serve" | "cron" | "fs" | "build";

export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
