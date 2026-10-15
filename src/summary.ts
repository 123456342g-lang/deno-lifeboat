import type { Category, Finding } from "./types.js";

export interface Tally {
  readonly total: number;
  readonly auto: number;
  readonly manual: number;
}

export interface Summary {
  readonly apis: Tally;
  readonly imports: Tally;
  readonly config: Tally;
  readonly syntax: Tally;
  readonly overall: Tally & { readonly percent: number };
  readonly typeOnly: number;
  readonly features: {
    readonly kv: boolean;
    readonly cron: boolean;
    readonly serve: boolean;
    readonly deploy: readonly string[];
  };
}

function tally(findings: readonly Finding[], match: (c: Category) => boolean): Tally {
  const relevant = findings.filter((f) => match(f.category) && (f.status === "auto" || f.status === "manual"));
  const auto = relevant.filter((f) => f.status === "auto").length;
  return { total: relevant.length, auto, manual: relevant.length - auto };
}

export function percent(part: number, total: number): number {
  return total === 0 ? 100 : Math.round((part / total) * 100);
}

export function summarize(findings: readonly Finding[]): Summary {
  const imports = tally(findings, (c) => c === "import");
  const config = tally(findings, (c) => c === "config");
  const syntax = tally(findings, (c) => c === "syntax");
  const apis = tally(findings, (c) => c !== "import" && c !== "config" && c !== "syntax");
  const total = apis.total + imports.total + config.total + syntax.total;
  const auto = apis.auto + imports.auto + config.auto + syntax.auto;
  return {
    apis,
    imports,
    config,
    syntax,
    overall: { total, auto, manual: total - auto, percent: percent(auto, total) },
    typeOnly: findings.filter((f) => f.status === "type").length,
    features: {
      kv: findings.some((f) => f.category === "kv"),
      cron: findings.some((f) => f.category === "cron"),
      serve: findings.some((f) => f.category === "serve"),
      deploy: [...new Set(findings.filter((f) => f.category === "deploy").map((f) => f.api))],
    },
  };
}
