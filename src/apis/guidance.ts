/** Shared manual-migration guidance. Kept in one place so wording stays precise and consistent. */

export const WORKERS = {
  noFs:
    "Workers have no persistent file system: read bundled files via Workers Static Assets or an `import` with a wrangler `rules` entry, and store data in R2, KV or D1",
  noProcess: "not meaningful on Workers (no process, CLI arguments or working directory); remove or move to a build script",
  env: "Deno.env on Workers: read bindings from the `env` argument of your fetch handler, or `process.env` with the `nodejs_compat` flag (populated from vars/secrets for compatibility dates ≥ 2025-04-01); set secrets with `wrangler secret put`",
  cron:
    "Deno.cron → Cron Triggers: the schedule was added to wrangler.jsonc `triggers.crons`; move the handler body into `scheduled(controller, env, ctx)` on your default export and switch on `controller.cron` if you have several",
  serve:
    "Deno.serve on Workers: export `{ fetch(request, env, ctx) }` as the module default export; options (port, hostname, onListen) do not apply",
  net: "raw TCP/UDP: outbound TCP is available via `connect()` from `cloudflare:sockets`; listening sockets are not available on Workers",
  subprocess: "subprocesses are not available on Workers; move this to a separate service or a build step",
  websocket:
    "Deno.upgradeWebSocket → `const [client, server] = Object.values(new WebSocketPair()); server.accept(); return new Response(null, { status: 101, webSocket: client })`; use Durable Objects for shared state",
} as const;

export const KV = {
  openKvNode:
    "Deno.openKv on Node: `import { openKv } from \"@deno/kv\"` (npm, Deno's official client). `await openKv(\"kv.sqlite3\")` gives a local SQLite store with the same API (get/set/list/atomic/watch/enqueue); `await openKv(\"https://api.deno.com/databases/<id>/connect\")` (token in DENO_KV_ACCESS_TOKEN) reads your existing Deploy KV, but queues (enqueue/listenQueue) are not available over that remote protocol. Copy data out before Deno Deploy shuts down, e.g. with `exportEntries` from jsr:@deno/kv-utils",
  openKvBun:
    "Deno.openKv on Bun: try `import { openKv } from \"@deno/kv\"` (Node-API SQLite build; verify on your Bun version), or move to `bun:sqlite`. Export existing Deploy data with `exportEntries` from jsr:@deno/kv-utils before Deno Deploy shuts down",
  openKvWorkers:
    "Deno.openKv on Workers: pick a store per access pattern — Workers KV (eventually consistent, no transactions), D1 (SQLite, transactions via batch), or a Durable Object (strongly consistent storage, the closest match to kv.atomic()). Export existing data with `exportEntries` from jsr:@deno/kv-utils and import it before Deno Deploy shuts down",
  atomic:
    "kv.atomic(): keeps working with @deno/kv (Node). On Workers KV there are no atomic check-and-set transactions; use a Durable Object or D1 for this logic",
  enqueue:
    "kv.enqueue()/listenQueue(): works with @deno/kv on a local SQLite store only (not over the remote KV Connect URL). Elsewhere use a real queue: Cloudflare Queues on Workers; BullMQ/pg-boss or similar on Node/Bun",
  watch: "kv.watch(): supported by @deno/kv; no equivalent in Workers KV (use Durable Objects + WebSockets)",
} as const;

export const NODE = {
  subprocess:
    "Deno.Command → `spawn`/`execFile` from node:child_process (`const { stdout } = await promisify(execFile)(cmd, args)`); on Bun you can also use `Bun.spawn`",
  net: "Deno.connect/listen → node:net (`net.connect`, `net.createServer`) or node:tls; the stream APIs differ (Node streams vs Deno.Conn)",
  websocket:
    "Deno.upgradeWebSocket → on Node use the `ws` package (WebSocketServer with `noServer` + the http `upgrade` event); on Bun use `server.upgrade(req)` in Bun.serve",
  permissions: "Deno.permissions has no equivalent; delete the check (Node has a process-wide `--permission` flag instead)",
  fileHandle: "Deno.open/create file handles → `open()` from node:fs/promises (FileHandle: read/write/close); method names differ",
  watchFs: "Deno.watchFs → `watch()` from node:fs/promises (async iterator of { eventType, filename }) or chokidar",
  bench: "Deno.bench → a benchmark library (mitata or tinybench) on Node/Bun",
  stdio: "Deno.stdin/stdout/stderr → process.stdin/stdout/stderr (Node streams; use `Readable.toWeb(process.stdin)` / `Writable.toWeb(process.stdout)` for web streams)",
  version: "Deno.version → process.versions (e.g. process.versions.node / process.versions.bun)",
  errors:
    "Deno.errors.* → check `err.code` instead (NotFound → \"ENOENT\", AlreadyExists → \"EEXIST\", PermissionDenied → \"EACCES\"/\"EPERM\", IsADirectory → \"EISDIR\", NotADirectory → \"ENOTDIR\")",
  serveHttp: "Deno.serveHttp is deprecated; port the code to Deno.serve first (lifeboat can then rewrite it)",
} as const;
