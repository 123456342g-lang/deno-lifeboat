# deno-lifeboat

**Move a Deno app to Node.js, Bun, or Cloudflare Workers: one scan to see what's involved, one AST-based codemod to do the mechanical part. No lock-in to any of the three.**

```text
$ npx github:123456342g-lang/deno-lifeboat scan

deno-lifeboat scan . → Node.js

  Deno APIs        5   3 auto  2 manual
  Imports          6   5 auto  1 manual
  deno.json        1   1 auto
  Features      Deno.serve, Deno KV, Deno.cron

  Auto-migratable: ███████████████░░░░░ 75% (9/12)

Needs a human (3):
  main.ts:5   https://deno.land/x/somelib@1.0.0/mod.ts  deno.land/x module: find its npm or JSR equivalent (or vendor the code) ...
  main.ts:7   Deno.openKv  Deno.openKv on Node: `import { openKv } from "@deno/kv"` (npm, Deno's official client) ...
  main.ts:16  kv.enqueue()  kv.enqueue()/listenQueue(): works with @deno/kv on a local SQLite store only ...

Next: npx github:123456342g-lang/deno-lifeboat migrate --to node   (dry run: shows the diff, changes nothing)
```

(That is the real output for [`test/fixtures/deploy-app`](test/fixtures/deploy-app), with the long lines shortened.)

## Install / run

Requires Node.js ≥ 20. Not published to npm yet, so run it straight from GitHub:

```bash
npx github:123456342g-lang/deno-lifeboat scan                        # read-only report (target: node)
npx github:123456342g-lang/deno-lifeboat scan --to workers           # what a move to Workers involves
npx github:123456342g-lang/deno-lifeboat migrate --to node           # dry run: prints the diff
npx github:123456342g-lang/deno-lifeboat migrate --to node --write   # apply (needs a clean git tree)
```

Or clone it and use it locally:

```bash
git clone https://github.com/123456342g-lang/deno-lifeboat && cd deno-lifeboat
npm install            # also compiles to dist/
node dist/src/cli.js scan /path/to/your/deno/app
```

Note that `npx deno-lifeboat` (without `github:`) will **not** run this tool, because nothing is published under that name.

---

## Why

Cloudflare took in the Deno team on 2026-10-09. Deno Deploy is expected to keep running for about six more months and then shut down, and the Deno runtime is to be maintained for roughly another year. The official migration help covers paid customers moving to Workers. Everyone else has to do the move themselves, and Workers is not the only reasonable destination.

lifeboat does the mechanical part of that move for whichever target you pick, and gives you a precise, `file:line` list of everything it could not do.

## What it does

`scan` is read-only. It parses every source file with the TypeScript compiler (via [ts-morph](https://ts-morph.com)) and classifies every `Deno.*` use, every import specifier, every `deno.json` task, and any TypeScript syntax Node can't strip. You get the share that migrates automatically and a `file:line` list of the rest. `--json` returns `{ ok, data, error }`.

`migrate --to node|bun|workers` applies the same analysis as edits:

- **Dry run by default.** It prints a unified diff and writes nothing. `--write` applies the changes.
- **It refuses to write on a dirty git tree** (or outside a git repo) unless you pass `--force`, so `git diff` and `git checkout .` are always your review and rollback.
- **`deno.json`, `deno.jsonc` and `deno.lock` are never modified or deleted.** You can keep running on Deno while you migrate.
- Anything it can't rewrite is left in place with a `// lifeboat: TODO(api) …` comment explaining what to do (`--no-todo` turns these off), and is listed in a generated `lifeboat-checklist.md`.
- Rewrites are AST-based, so strings, comments, shadowed `Deno` bindings and property names like `obj.Deno` are left alone. If a rule can't be applied it rolls back cleanly, including any imports it would have added.

### Generated files

| File | When |
| --- | --- |
| `package.json` | Always. It is merged into an existing one (your keys win) and contains dependencies from imports and the import map, scripts converted from `deno.json` tasks, `"type": "module"`, and `engines`. |
| `tsconfig.json` | When missing. It is set up for type stripping on Node/Bun, or for Workers. |
| `.npmrc` | When JSR packages are used: `@jsr:registry=https://npm.jsr.io`. |
| `wrangler.jsonc` | `--to workers`. It includes `main`, `compatibility_date`, the `nodejs_compat` flag, and `triggers.crons` taken from `Deno.cron` schedules. |
| `lifeboat-shim/*.ts` | Small, readable files you own (`serve`, `cron`, `fs`, `build`, `test`), added only when they're needed and never overwritten. |
| `lifeboat-checklist.md` | Always. It lists target-specific steps, every manual item, and how to get KV data out. |

## Mappings

| Deno | Node / Bun | Workers |
| --- | --- | --- |
| `Deno.serve(handler)` / `Deno.serve(opts, handler)` | `serve` from `lifeboat-shim/serve.ts`, which uses `node:http` with streaming, backpressure, abort signals and `onListen`, and `Bun.serve` on Bun. `PORT` is honoured. | A top-level call becomes `export default { fetch: handler }`. |
| `serve` from `deno.land/std/http/server.ts` | the same shim (std signature) | manual |
| `Deno.cron(name, schedule, fn)` | `cron` shim on [croner](https://github.com/hexagon/croner) (UTC, no overlapping runs) | The schedule goes into `triggers.crons` in wrangler.jsonc; you move the handler body into `scheduled()` by hand. |
| `Deno.env.get/has/set/delete/toObject` | `process.env` | `process.env` via `nodejs_compat` (get/has/toObject); set/delete are manual |
| `Deno.args`, `exit`, `exitCode`, `cwd`, `chdir`, `pid`, `memoryUsage`, `kill`, signal listeners, `hostname`, `loadavg`, `inspect`, `build`, … | `process.*`, `node:os`, `node:util` | mostly manual |
| `Deno.readTextFile`, `writeTextFile` (incl. `{ append }`), `readFile`, `writeFile`, `mkdir`, `remove`, `rename`, `copyFile`, `stat`, `lstat`, `readDir`, `realPath`, `makeTempDir`, …, and their `Sync` forms | `node:fs` / `node:fs/promises`; `stat`/`readDir` go through the `fs` shim so the result shape matches | manual (no file system) |
| `Deno.test` (name/fn, options object, `.ignore`, `.only`, `t.step`) | `node:test` (`t.step` → `t.test`), `bun:test` | `vitest` |
| `@std/testing/bdd` (`describe`, `it`, hooks) | `node:test` (`beforeAll` → `before`), `bun:test` | `vitest` |
| `x instanceof Deno.errors.NotFound` (and the other error classes) | `x?.code === "ENOENT"` etc. | same |
| `import.meta.main` | `import.meta.url === pathToFileURL(process.argv[1]).href` (Bun: unchanged) | manual |
| `npm:pkg@1` | `pkg`, with the dependency added | same |
| `jsr:@scope/pkg@1` | `@scope/pkg`, installed from npm.jsr.io as `npm:@jsr/scope__pkg` | same |
| import maps (`deno.json` `imports`, external `importMap`, prefix entries like `"@/": "./src/"`) | rewritten to package names or relative paths | same |
| `deno.land/std@x/...` | `@std/*` on JSR (approximate for very old std paths) | same |
| `deno.land/x/hono`, `oak`, `zod` / `esm.sh`, `unpkg`, `jsdelivr`, `skypack` | npm packages | same |
| `deno.json` tasks | `package.json` scripts: `deno run` → `node`/`bun` (Deno flags dropped; `--watch`, `--env-file`, `--inspect` kept), `deno test` → `node --test <globs>` / `bun test` / `vitest run`, `deno task x` → `npm run x` | `wrangler dev`, `wrangler deploy` |
| enums, constructor parameter properties | rewritten into erasable syntax for Node's type stripping (Node only; Bun runs them as-is) | n/a |

**Flagged with precise guidance (not rewritten):** `Deno.openKv`, `kv.atomic`, `kv.enqueue`/`listenQueue`, `kv.watch`; `Deno.Command`/`run`, `connect*`/`listen*`, `upgradeWebSocket`, `resolveDns`, `permissions`, `stdin`/`stdout`; `BroadcastChannel` and `DENO_DEPLOYMENT_ID`/`DENO_REGION`; TypeScript namespaces with values, decorators, and `.tsx` on Node. Type-only references such as `Deno.Kv` in annotations are counted separately, because they have no runtime effect.

### Deno KV

There is no automatic KV migration in v0.1. lifeboat flags every `Deno.openKv`, `atomic`, `enqueue`, `listenQueue` and `watch` call with what to do on your target:

- **Node:** the official [`@deno/kv`](https://www.npmjs.com/package/@deno/kv) package gives you the same API on a local SQLite file, including atomic, watch and queues. It can also open your Deploy database over KV Connect, but queues are not available over that remote protocol.
- **Bun:** `@deno/kv` works but needs explicit `encodeV8`/`decodeV8` serializers. The resulting store uses JavaScriptCore serialization, so it must not be pointed at your Deploy database.
- **Workers:** pick Workers KV, D1 or a Durable Object per access pattern. Queues go to Cloudflare Queues.

**Exporting your data** is already solved by Deno's own [`@deno/kv-utils`](https://jsr.io/@deno/kv-utils) (`exportEntries` / `importEntries`), and the checklist points you there. lifeboat doesn't reimplement it.

## Results on real projects

All trials were run on 2026-10-15 against unmodified upstream commits, with Node 22.14 and Bun 1.4.3. These are measured results, not estimates.

| Project | What it is | `scan` (Node) | Result |
| --- | --- | --- | --- |
| [pwh-pwh/douyinVd](https://github.com/pwh-pwh/douyinVd) @ `6b85308` | `Deno.serve` app plus tests | 100% (16/16) | **Node:** `migrate --write`, `npm install`, `GET /` returns 200, and **12/12 tests pass** under `node --test`. **Bun:** `--to bun`, `bun install`, `GET /` returns 200, and **12/12 tests pass** under `bun test`. No hand edits. |
| [hbsgithub/deno-azure-openai-proxy](https://github.com/hbsgithub/deno-azure-openai-proxy) @ `4832d84` | std `serve()` proxy | 100% (16/16) | **Node:** boots with no hand edits; CORS `OPTIONS` returns 200 and `/v1/models` returns 200 JSON. Forwarding to Azure was **not** tested (no credentials). The first trial scored 94%, because std `http/server.ts` `serve` was manual; that mapping was added as a result. |
| [dnl-fm/done](https://github.com/dnl-fm/done) @ `4c786c3` | Hono + Deno KV + KV queues + `Deno.cron` + Turso, 68 tests | 87% (112/129); Bun 85%; Workers 67% | `migrate --write` changed 45 files. The 17 manual items are 7× `Deno.openKv`, 8× `enqueue`/`listenQueue`, 1× `Deno.resolveDns`, and the `deno fmt && deno lint` task. After the one-line `@deno/kv` swap that the TODOs describe, done to all 7 `openKv` call sites: **Node: 68/68 tests pass**, the server boots, and a posted message goes through the full KV-queue lifecycle (queued, delayed delivery, retry on a failed callback). **Bun: 68/68 tests pass** and the server boots, after also passing `encodeV8`/`decodeV8`. `Deno.resolveDns` in `src/utils/http.ts` was left unported. |

Bugs these trials found in lifeboat itself, all fixed before this release:

- `deno test tests/` became `node --test tests/`, which Node doesn't expand.
- `@std/testing/bdd` calls `Deno.test` internally and wasn't handled.
- `kv.toString()` crashed the Workers report.
- The Bun KV guidance was incomplete.
- Parameter properties and enums blocked Node's type stripping, which took `done` from 67% to 87%.

## Known gaps (v0.1)

- **Workers auto-rewrite is partial.** Only a top-level `Deno.serve(handler)` becomes `export default { fetch }`. `Deno.cron` handlers, KV, queues, file-system access and anything reading `env` bindings are checklist items, not rewrites. You get a complete checklist and a `wrangler.jsonc`, not a finished Worker.
- **No KV semantic migration.** KV calls are flagged, not translated to Workers KV, D1 or Durable Objects. That is planned for v0.2.
- **Type-only `Deno.*` references** (`Deno.Kv`, `Deno.KvListOptions`, …) are reported but left in place. They are erased at runtime, but `tsc` will complain until you replace them.
- **Node versions:** migrated TypeScript runs directly on Node ≥ 22.18 or 23.6. Node 22.6–22.17 needs `--experimental-strip-types`, and Node 20 needs a build step (`tsx`, `tsc`), because type stripping doesn't exist there. lifeboat itself runs on Node 20. Namespaces with values, decorators and `.tsx` need a build step on any Node version.
- **Import mapping is heuristic for old `deno.land/std` paths and `deno.land/x`.** Only a few well-known `x` modules are mapped. Unversioned imports become `latest` (with a note), so pin them.
- **Not handled:** `deno.json` `workspace` members (reported only), `deno compile`/`fmt`/`lint`/`bench` tasks (kept and flagged), Fresh projects (`_fresh`/islands need a framework port), and `Deno.Command`, sockets, `upgradeWebSocket` and `permissions` (flagged with pointers).
- The `serve` shim targets typical HTTP apps. It doesn't implement `Deno.serve`'s TLS options, Unix sockets or `reusePort`.

## Development

```bash
npm install
npm test          # build + 238 tests (unit tests per mapping, shim HTTP tests, end-to-end)
npm run typecheck
```

The end-to-end tests migrate [`test/fixtures/serve-app`](test/fixtures/serve-app) in a temporary git repo, start the migrated server, make a real HTTP request to it, and run its migrated tests. This happens under Node (≥ 22.6) and, if `bun` is on `PATH`, under Bun. No network access or package install is needed. CI runs Node 20, 22 and 24 plus a Bun job.

Mappings live in [`src/apis/`](src/apis) as a table: one entry per Deno API with a handler or guidance string for each target. The type system forces every target to be covered, and a test checks that every entry has a case. Adding an API means adding a row and a test case.

## License

[MIT](LICENSE)
