import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeGuard } from "./git.js";
export class WriteRefusedError extends Error {
}
/** Writes all planned changes. Refuses on a dirty/non-git tree unless `force`. Never deletes files. */
export function writeChanges(analysis, force) {
    const refusal = writeGuard(analysis.root, force);
    if (refusal)
        throw new WriteRefusedError(refusal);
    for (const change of analysis.changes) {
        const target = path.join(analysis.root, change.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, change.content);
    }
    return analysis.changes;
}
