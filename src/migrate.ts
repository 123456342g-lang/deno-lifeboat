import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PlannedFile } from "./config.js";
import { writeGuard } from "./git.js";
import type { Analysis } from "./project.js";

export class WriteRefusedError extends Error {}

/** Writes all planned changes. Refuses on a dirty/non-git tree unless `force`. Never deletes files. */
export function writeChanges(analysis: Analysis, force: boolean): readonly PlannedFile[] {
  const refusal = writeGuard(analysis.root, force);
  if (refusal) throw new WriteRefusedError(refusal);
  for (const change of analysis.changes) {
    const target = path.join(analysis.root, change.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, change.content);
  }
  return analysis.changes;
}
