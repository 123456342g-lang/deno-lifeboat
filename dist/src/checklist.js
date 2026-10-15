export const CHECKLIST_FILE = "lifeboat-checklist.md";
const CATEGORY_TITLES = {
    env: "Environment variables",
    process: "Process / CLI",
    fs: "File system",
    serve: "HTTP server",
    cron: "Cron",
    test: "Tests",
    kv: "Deno KV",
    net: "Networking",
    subprocess: "Subprocesses",
    permissions: "Permissions",
    errors: "Errors",
    runtime: "Runtime APIs",
    deploy: "Deno Deploy-only features",
    import: "Imports",
    syntax: "TypeScript / syntax",
    config: "deno.json",
};
const TARGET_NAMES = { node: "Node.js", bun: "Bun", workers: "Cloudflare Workers" };
function has(findings, category) {
    return findings.some((f) => f.category === category && f.status !== "info");
}
function hasApi(findings, pattern) {
    return findings.some((f) => pattern.test(f.api));
}
function workersSteps(input) {
    const { findings } = input;
    const serveRewritten = findings.some((f) => f.category === "serve" && f.status === "auto");
    const steps = [
        "`npm install`, then `npx wrangler dev` — lifeboat generated `wrangler.jsonc` (with the `nodejs_compat` flag) if you had no wrangler config.",
        serveRewritten
            ? `Entry point: \`Deno.serve\` in \`${input.entry ?? "your entry file"}\` was rewritten to \`export default { fetch }\`. Check that \`main\` in wrangler.jsonc points at it.`
            : "Entry point: export `{ fetch(request, env, ctx) }` as the default export of the file `main` in wrangler.jsonc points at.",
        "Environment & secrets: plain values go in `vars` in wrangler.jsonc, secrets via `npx wrangler secret put NAME`, local values in `.dev.vars`. With `nodejs_compat` and a compatibility date ≥ 2025-04-01 they are also readable as `process.env.NAME`.",
    ];
    if (has(findings, "kv")) {
        steps.push("Deno KV: choose a replacement per access pattern — Workers KV (eventually consistent, no transactions), D1 (SQLite), or Durable Objects (strongly consistent; closest to `kv.atomic()`). Copy your data out of Deno Deploy first (see the KV section below).");
    }
    if (hasApi(findings, /enqueue|listenQueue/))
        steps.push("KV queues (`enqueue`/`listenQueue`) → Cloudflare Queues (producer + consumer bindings in wrangler.jsonc).");
    if (has(findings, "cron")) {
        steps.push("Cron: schedules were copied into `triggers.crons` in wrangler.jsonc where they were string literals. Add `scheduled(controller, env, ctx)` to the default export and move each `Deno.cron` handler there (switch on `controller.cron`).");
    }
    if (has(findings, "fs"))
        steps.push("File system: there is no writable disk. Serve static files with Workers Static Assets (`assets` in wrangler.jsonc); store uploads/data in R2, KV or D1.");
    if (hasApi(findings, /upgradeWebSocket/))
        steps.push("WebSockets: use `WebSocketPair` in the fetch handler; use a Durable Object if clients must share state.");
    if (hasApi(findings, /BroadcastChannel/))
        steps.push("BroadcastChannel: Deploy delivered it across isolates; on Workers route those messages through a Durable Object.");
    if (has(findings, "subprocess") || has(findings, "net"))
        steps.push("Subprocesses and listening sockets are unavailable on Workers; outbound TCP is available via `connect()` from `cloudflare:sockets`.");
    if (has(findings, "test"))
        steps.push("Tests: `Deno.test` was mapped to vitest where possible; for tests that need the Workers runtime use `@cloudflare/vitest-pool-workers`.");
    steps.push("Limits: Workers enforce per-request CPU-time and memory limits that differ from Deno Deploy; check them for your plan and move long-running work to Queues or Workflows.", "Deploy: `npx wrangler deploy`, then attach your custom domain/routes in the Cloudflare dashboard or wrangler.jsonc.");
    return steps;
}
function runtimeSteps(input) {
    const entry = input.entry ?? "main.ts";
    const steps = input.target === "bun"
        ? ["`bun install`", `Run: \`bun ${entry}\` (Bun runs TypeScript directly).`]
        : [
            "`npm install`",
            `Run: \`node ${entry}\` on Node ≥ 22.18 or ≥ 23.6 (TypeScript type stripping is on by default); on Node 22.6–22.17 use \`node --experimental-strip-types ${entry}\`.`,
        ];
    if (has(input.findings, "kv")) {
        steps.push("Deno KV: replace `Deno.openKv()` with `openKv()` from the `@deno/kv` npm package (local SQLite file, or your Deploy database via its KV Connect URL). Copy data out of Deno Deploy before it shuts down (see the KV section below).");
    }
    if (has(input.findings, "cron"))
        steps.push("Cron: `Deno.cron` now runs in-process via croner (UTC). If you run several instances, run cron jobs in only one of them.");
    steps.push("Hosting: any host that runs a long-lived Node/Bun process (a container or VM). Set `PORT` if your host requires it; the serve shim reads it when no port is passed.");
    return steps;
}
function manualSection(findings) {
    const manual = findings.filter((f) => f.status === "manual");
    if (manual.length === 0)
        return ["Nothing — every Deno-specific item was migrated automatically.", ""];
    const byCategory = new Map();
    for (const f of manual)
        byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), f]);
    return [...byCategory.entries()].flatMap(([category, items]) => [
        `### ${CATEGORY_TITLES[category]}`,
        "",
        ...items.map((f) => `- [ ] \`${f.file}:${f.line}\` **${f.api}** — ${f.message}`),
        "",
    ]);
}
const KV_EXPORT = [
    "## Deno KV data",
    "",
    "Deno Deploy is expected to shut down in about six months. If your app stores data in Deploy KV, copy it out early:",
    "",
    "- `exportEntries` from [`jsr:@deno/kv-utils`](https://jsr.io/@deno/kv-utils) streams every entry as NDJSON (and `importEntries` loads it back).",
    "- From Node, `openKv(\"https://api.deno.com/databases/<database-id>/connect\")` from the `@deno/kv` npm package (token in `DENO_KV_ACCESS_TOKEN`) reads the remote database directly.",
    "",
];
export function buildChecklist(input) {
    const { summary } = input;
    const steps = input.target === "workers" ? workersSteps(input) : runtimeSteps(input);
    return [
        `# Migration checklist: Deno → ${TARGET_NAMES[input.target]}`,
        "",
        `Generated by [deno-lifeboat](https://github.com/123456342g-lang/deno-lifeboat). ${summary.overall.auto} of ${summary.overall.total} items were migrated automatically (${summary.overall.percent}%); ${summary.overall.manual} need you.`,
        "",
        "`deno.json` was left untouched so you can roll back (`git checkout .`) or keep running on Deno while you migrate.",
        "",
        "## Steps",
        "",
        ...steps.map((s) => `- [ ] ${s}`),
        "",
        "## Needs a human",
        "",
        ...manualSection(input.findings),
        ...(summary.features.kv ? KV_EXPORT : []),
        summary.typeOnly > 0 ? `_${summary.typeOnly} type-only references to the \`Deno\` namespace (e.g. \`Deno.Kv\` in annotations) have no runtime effect but will fail type-checking until replaced._\n` : "",
    ].join("\n");
}
