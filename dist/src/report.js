import path from "node:path";
import { createTwoFilesPatch } from "diff";
import pc from "picocolors";
const TARGET_NAMES = { node: "Node.js", bun: "Bun", workers: "Cloudflare Workers" };
const MAX_MANUAL_LINES = 60;
/** Not on npm yet: `npx deno-lifeboat` would resolve to whatever package claims that name. */
const INVOKE = "npx github:123456342g-lang/deno-lifeboat";
export function envelope(data) {
    return { ok: true, data, error: null };
}
export function errorEnvelope(error) {
    return { ok: false, data: null, error };
}
function bar(pct, width = 20) {
    const filled = Math.round((pct / 100) * width);
    return pc.green("█".repeat(filled)) + pc.dim("░".repeat(width - filled));
}
function tallyLine(label, t) {
    if (t.total === 0)
        return undefined;
    const auto = t.auto === t.total ? pc.green(`${t.auto} auto`) : `${pc.green(`${t.auto} auto`)}  ${pc.yellow(`${t.manual} manual`)}`;
    return `  ${label.padEnd(14)}${String(t.total).padStart(4)}   ${auto}`;
}
function location(f) {
    return `${f.file}:${f.line}`;
}
function manualLines(findings) {
    const manual = findings.filter((f) => f.status === "manual");
    if (manual.length === 0)
        return [];
    const width = Math.min(40, Math.max(...manual.map((f) => location(f).length)));
    const shown = manual.slice(0, MAX_MANUAL_LINES).map((f) => {
        const msg = f.message.length > 140 ? `${f.message.slice(0, 137)}...` : f.message;
        return `  ${pc.cyan(location(f).padEnd(width))}  ${pc.bold(f.api)}  ${pc.dim(msg)}`;
    });
    const more = manual.length > MAX_MANUAL_LINES ? [pc.dim(`  ... and ${manual.length - MAX_MANUAL_LINES} more (see lifeboat-checklist.md or --json)`)] : [];
    return ["", pc.bold(pc.yellow(`Needs a human (${manual.length}):`)), ...shown, ...more];
}
export function formatReport(analysis, command) {
    const { summary } = analysis;
    const rel = path.relative(process.cwd(), analysis.root) || ".";
    const features = [
        summary.features.serve && "Deno.serve",
        summary.features.kv && pc.yellow("Deno KV"),
        summary.features.cron && "Deno.cron",
        ...summary.features.deploy.map((d) => pc.yellow(d)),
    ].filter(Boolean);
    const lines = [
        "",
        `${pc.bold("deno-lifeboat")} ${command} ${pc.dim(rel)} ${pc.dim(`→ ${TARGET_NAMES[analysis.target]}`)}`,
        "",
        ...[
            tallyLine("Deno APIs", summary.apis),
            tallyLine("Imports", summary.imports),
            tallyLine("deno.json", summary.config),
            tallyLine("TS syntax", summary.syntax),
        ].filter((l) => l !== undefined),
        features.length > 0 ? `  ${"Features".padEnd(14)}${features.join(", ")}` : undefined,
        summary.typeOnly > 0 ? pc.dim(`  ${"Type-only".padEnd(14)}${summary.typeOnly} Deno.* type references (no runtime effect)`) : undefined,
        "",
        `  ${pc.bold("Auto-migratable:")} ${bar(summary.overall.percent)} ${pc.bold(`${summary.overall.percent}%`)} ${pc.dim(`(${summary.overall.auto}/${summary.overall.total})`)}`,
        ...manualLines(analysis.findings),
    ].filter((l) => l !== undefined);
    return `${lines.join("\n")}\n`;
}
export function formatNextStep(analysis, command, wrote) {
    const dir = path.relative(process.cwd(), analysis.root) || ".";
    const dirArg = dir === "." ? "" : ` ${dir}`;
    if (command === "scan") {
        return `\n${pc.dim("Next:")} ${INVOKE} migrate${dirArg} --to ${analysis.target}   ${pc.dim("(dry run: shows the diff, changes nothing)")}\n`;
    }
    if (!wrote) {
        return `\n${pc.dim("Dry run — nothing was written.")} Apply with: ${INVOKE} migrate${dirArg} --to ${analysis.target} --write\n`;
    }
    return `\n${pc.green("Done.")} Review with ${pc.bold("git diff")}, then follow ${pc.bold("lifeboat-checklist.md")}. deno.json was left untouched.\n`;
}
function colorPatch(patch) {
    return patch
        .split("\n")
        .map((line) => {
        if (line.startsWith("+++") || line.startsWith("---"))
            return pc.bold(line);
        if (line.startsWith("+"))
            return pc.green(line);
        if (line.startsWith("-"))
            return pc.red(line);
        if (line.startsWith("@@"))
            return pc.cyan(line);
        return line;
    })
        .join("\n");
}
export function formatDiff(changes, color) {
    return changes
        .map((change) => {
        const patch = createTwoFilesPatch(change.original === undefined ? "/dev/null" : `a/${change.path}`, `b/${change.path}`, change.original ?? "", change.content, undefined, undefined, { context: 3 }).replace(/^=+\n/, "");
        return color ? colorPatch(patch) : patch;
    })
        .join("\n");
}
export function analysisJson(analysis, extra = {}) {
    return {
        root: analysis.root,
        target: analysis.target,
        summary: analysis.summary,
        entry: analysis.entry ?? null,
        findings: analysis.findings,
        changes: analysis.changes.map((c) => ({ path: c.path, created: c.original === undefined })),
        ...extra,
    };
}
