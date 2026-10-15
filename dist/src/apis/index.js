import { cronAndTestRules } from "./cronAndTest.js";
import { flaggedRules } from "./flagged.js";
import { fsRules } from "./fs.js";
import { processRules } from "./process.js";
import { serveRules } from "./serve.js";
export { isManual } from "./types.js";
export { KV, NODE, WORKERS } from "./guidance.js";
/**
 * The API mapping table. One entry per `Deno.*` path; add a mapping by adding an entry
 * (and a test in test/apis.test.ts).
 */
export const API_RULES = [...processRules, ...fsRules, ...serveRules, ...cronAndTestRules, ...flaggedRules];
const BY_PATH = new Map(API_RULES.map((rule) => [rule.path, rule]));
if (BY_PATH.size !== API_RULES.length) {
    throw new Error("deno-lifeboat: duplicate path in API_RULES");
}
export function findRule(path) {
    return BY_PATH.get(path);
}
