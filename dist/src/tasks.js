/** Splits a shell command on &&, ||, ;, | while respecting quotes. Returns parts and the separators between them. */
export function splitCommand(command) {
    const parts = [];
    const separators = [];
    let current = "";
    let quote;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote) {
            current += ch;
            if (ch === quote)
                quote = undefined;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        const two = command.slice(i, i + 2);
        const sep = two === "&&" || two === "||" ? two : ch === ";" || ch === "|" ? ch : undefined;
        if (sep) {
            parts.push(current);
            separators.push(sep);
            current = "";
            i += sep.length - 1;
            continue;
        }
        current += ch;
    }
    parts.push(current);
    return { parts, separators };
}
export function tokenize(segment) {
    const tokens = [];
    const re = /"[^"]*"|'[^']*'|\S+/g;
    for (const match of segment.matchAll(re))
        tokens.push(match[0]);
    return tokens;
}
/** Deno flags that take a separate value argument (`--config deno.json`). */
const FLAGS_WITH_VALUE = new Set(["-c", "--config", "--import-map", "--lock", "--cert", "--location", "--seed", "--v8-flags", "-L", "--log-level", "--env"]);
/** Separates `deno run` flags into ones Node/Bun understand and Deno-only ones (permissions, --unstable-*, ...). */
function parseRunFlags(args, target) {
    const kept = [];
    const dropped = [];
    let i = 0;
    for (; i < args.length; i++) {
        const arg = args[i];
        if (!arg.startsWith("-"))
            break;
        if (arg === "--watch" || arg.startsWith("--watch="))
            kept.push("--watch");
        else if (arg === "--env-file" || arg === "--env")
            kept.push("--env-file=.env");
        else if (arg.startsWith("--env-file=") || arg.startsWith("--env="))
            kept.push(`--env-file=${arg.split("=").slice(1).join("=")}`);
        else if (arg === "--inspect" || arg.startsWith("--inspect=") || arg.startsWith("--inspect-brk"))
            kept.push(arg);
        else {
            dropped.push(arg);
            if (FLAGS_WITH_VALUE.has(arg) && args[i + 1] !== undefined)
                dropped.push(args[++i]);
        }
    }
    return { kept, dropped, rest: args.slice(i) };
}
const DEFAULT_TEST_GLOBS = ["**/*_test.ts", "**/*.test.ts"];
/** `node --test` does not expand directories (Deno does), so `tests/` becomes `"tests/**\/*_test.ts"`. */
function nodeTestArg(arg, testPatterns) {
    const looksLikeDirectory = !arg.startsWith("-") && !/[*?{]/.test(arg) && (arg.endsWith("/") || !/\.[A-Za-z0-9]+$/.test(arg));
    if (!looksLikeDirectory)
        return [arg];
    const dir = arg.replace(/^\.\//, "").replace(/\/+$/, "");
    const globs = testPatterns.length > 0 ? testPatterns : DEFAULT_TEST_GLOBS;
    return globs.map((glob) => `"${dir === "." || dir === "" ? glob : `${dir}/${glob}`}"`);
}
function runtimeCommand(target) {
    return target === "bun" ? "bun" : "node";
}
function convertDenoInvocation(subcommand, args, ctx) {
    const { target } = ctx;
    switch (subcommand) {
        case "run": {
            const { kept, dropped, rest } = parseRunFlags(args, target);
            const [entry, ...entryArgs] = rest;
            if (entry === undefined)
                return undefined;
            const notes = dropped.length > 0 ? [`dropped Deno-only flags: ${dropped.join(" ")}`] : [];
            if (entry.startsWith("npm:")) {
                const pkg = entry.slice(4).replace(/^\//, "");
                return { text: [target === "bun" ? "bunx" : "npx", pkg, ...entryArgs].join(" "), converted: true, notes };
            }
            if (/^(jsr:|https?:)/.test(entry)) {
                return { text: "", converted: false, manual: `runs a remote module (${entry}); install the equivalent package and call its binary`, notes };
            }
            if (target === "workers")
                return { text: "wrangler dev", converted: true, notes };
            return { text: [runtimeCommand(target), ...kept, ...rest].join(" "), converted: true, notes };
        }
        case "serve": {
            if (target === "workers")
                return { text: "wrangler dev", converted: true, notes: [] };
            return { text: "", converted: false, manual: "`deno serve` runs the module's default export { fetch }; on Node/Bun call serve(handler) from lifeboat-shim/serve.ts in an entry file", notes: [] };
        }
        case "test": {
            const { dropped, rest } = parseRunFlags(args, target);
            const notes = dropped.length > 0 ? [`dropped Deno-only flags: ${dropped.join(" ")}`] : [];
            if (target === "bun")
                return { text: ["bun test", ...rest].join(" "), converted: true, notes };
            if (target === "workers")
                return { text: ["vitest run", ...rest].join(" "), converted: true, notes };
            const patterns = rest.length > 0 ? rest.flatMap((arg) => nodeTestArg(arg, ctx.testPatterns)) : ctx.testPatterns.map((p) => `"${p}"`);
            return { text: ["node --test", ...patterns].join(" "), converted: true, notes };
        }
        case "task": {
            const [name, ...more] = args;
            if (!name)
                return undefined;
            const runner = target === "bun" ? "bun run" : "npm run";
            return { text: [runner, name, ...(more.length > 0 ? (target === "bun" ? more : ["--", ...more]) : [])].join(" "), converted: true, notes: [] };
        }
        case "deploy":
            return target === "workers"
                ? { text: "wrangler deploy", converted: true, notes: [] }
                : { text: "", converted: false, manual: "`deno deploy` targets Deno Deploy, which is shutting down; replace with your new host's deploy command", notes: [] };
        default:
            return undefined;
    }
}
function convertSegment(segment, ctx) {
    const tokens = tokenize(segment);
    const envPrefix = [];
    while (tokens[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]))
        envPrefix.push(tokens.shift());
    if (tokens[0] !== "deno")
        return { text: segment.trim(), converted: false, notes: [] };
    const [, subcommand = "", ...args] = tokens;
    const result = convertDenoInvocation(subcommand, args, ctx);
    if (!result) {
        return { text: segment.trim(), converted: false, manual: `\`deno ${subcommand}\` has no direct equivalent; kept as-is (works while Deno is installed)`, notes: [] };
    }
    if (!result.converted)
        return { ...result, text: segment.trim() };
    return { ...result, text: [...envPrefix, result.text].join(" ") };
}
export function convertTask(command, ctx) {
    const { parts, separators } = splitCommand(command);
    const results = parts.map((part) => convertSegment(part, ctx));
    const script = results.reduce((acc, r, i) => (i === 0 ? r.text : `${acc} ${separators[i - 1]} ${r.text}`), "");
    const manual = results.flatMap((r) => (r.manual ? [r.manual] : []));
    const notes = results.flatMap((r) => r.notes);
    const all = [...manual, ...notes];
    return {
        script,
        status: manual.length > 0 ? "manual" : "auto",
        ...(all.length > 0 ? { note: all.join("; ") } : {}),
    };
}
