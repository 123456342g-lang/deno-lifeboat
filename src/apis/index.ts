import { cronAndTestRules } from "./cronAndTest.js";
import { flaggedRules } from "./flagged.js";
import { fsRules } from "./fs.js";
import { processRules } from "./process.js";
import { serveRules } from "./serve.js";
import type { ApiRule } from "./types.js";

export type { ApiRule, Handler, Outcome, RewriteContext, TargetAction } from "./types.js";
export { isManual } from "./types.js";
export { KV, NODE, WORKERS } from "./guidance.js";

/**
 * The API mapping table. One entry per `Deno.*` path; add a mapping by adding an entry
 * (and a test in test/apis.test.ts).
 */
export const API_RULES: readonly ApiRule[] = [...processRules, ...fsRules, ...serveRules, ...cronAndTestRules, ...flaggedRules];

const BY_PATH: ReadonlyMap<string, ApiRule> = new Map(API_RULES.map((rule) => [rule.path, rule]));

if (BY_PATH.size !== API_RULES.length) {
  throw new Error("deno-lifeboat: duplicate path in API_RULES");
}

export function findRule(path: string): ApiRule | undefined {
  return BY_PATH.get(path);
}
