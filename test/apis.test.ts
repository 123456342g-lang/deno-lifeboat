import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { API_RULES } from "../src/apis/index.js";
import type { Target } from "../src/types.js";
import { rewrite } from "./helpers.js";

interface Case {
  /** API rule path this case covers. */
  readonly path: string;
  readonly code: string;
  readonly target?: Target;
  readonly fileName?: string;
  /** Substrings the rewritten output must contain. */
  readonly contains?: readonly string[];
  /** If set, the API must be flagged manual with a message matching this. */
  readonly manual?: RegExp;
}

const CASES: readonly Case[] = [
  // env
  { path: "env.get", code: `const a = Deno.env.get("API_KEY");`, contains: ["const a = process.env.API_KEY;"] },
  { path: "env.get", code: `const k = "X"; const a = Deno.env.get(k);`, contains: ["process.env[k]"] },
  { path: "env.get", code: `const a = Deno.env.get("my-key");`, contains: [`process.env["my-key"]`] },
  { path: "env.get", code: `const a = Deno.env.get("A");`, target: "workers", contains: ["process.env.A"] },
  { path: "env.set", code: `Deno.env.set("A", "1");`, contains: [`process.env.A = "1";`] },
  { path: "env.set", code: `const r = Deno.env.set("A", "1");`, contains: [`(process.env.A = "1")`] },
  { path: "env.set", code: `Deno.env.set("A", "1");`, target: "workers", manual: /bindings/ },
  { path: "env.delete", code: `Deno.env.delete("A");`, contains: ["delete process.env.A;"] },
  { path: "env.has", code: `if (Deno.env.has("A")) {}`, contains: [`Object.hasOwn(process.env, "A")`] },
  { path: "env.toObject", code: `const all = Deno.env.toObject();`, contains: ["Object.assign({}, process.env)"] },
  { path: "env", code: `const e = Deno.env;`, manual: /process\.env/ },
  // process
  { path: "args", code: `const [first] = Deno.args;`, contains: ["process.argv.slice(2)"] },
  { path: "args", code: `const [first] = Deno.args;`, target: "workers", manual: /not meaningful on Workers/ },
  { path: "exit", code: `Deno.exit(1);`, contains: ["process.exit(1);"] },
  { path: "exitCode", code: `Deno.exitCode = 2;`, contains: ["process.exitCode = 2;"] },
  { path: "cwd", code: `const d = Deno.cwd();`, contains: ["process.cwd()"] },
  { path: "chdir", code: `Deno.chdir("/tmp");`, contains: [`process.chdir("/tmp")`] },
  { path: "pid", code: `console.log(Deno.pid);`, contains: ["process.pid"] },
  { path: "ppid", code: `console.log(Deno.ppid);`, contains: ["process.ppid"] },
  { path: "execPath", code: `const p = Deno.execPath();`, contains: ["const p = process.execPath;"] },
  { path: "memoryUsage", code: `const m = Deno.memoryUsage();`, contains: ["process.memoryUsage()"] },
  { path: "kill", code: `Deno.kill(123, "SIGTERM");`, contains: [`process.kill(123, "SIGTERM")`] },
  { path: "addSignalListener", code: `Deno.addSignalListener("SIGINT", onStop);`, contains: [`process.on("SIGINT", onStop)`] },
  { path: "removeSignalListener", code: `Deno.removeSignalListener("SIGINT", onStop);`, contains: [`process.off("SIGINT", onStop)`] },
  { path: "uid", code: `const u = Deno.uid();`, contains: ["process.getuid?.() ?? null"] },
  { path: "gid", code: `const g = Deno.gid();`, contains: ["process.getgid?.() ?? null"] },
  { path: "noColor", code: `const plain = Deno.noColor;`, contains: ["process.env.NO_COLOR !== undefined"] },
  { path: "mainModule", code: `const m = Deno.mainModule;`, contains: [`import { pathToFileURL } from "node:url";`, "pathToFileURL(process.argv[1]"] },
  { path: "consoleSize", code: `const { columns } = Deno.consoleSize();`, contains: ["process.stdout.columns"] },
  { path: "isatty", code: `const tty = Deno.isatty(1);`, contains: [`import { isatty } from "node:tty";`, "isatty(1)"] },
  { path: "hostname", code: `const h = Deno.hostname();`, contains: [`import { hostname } from "node:os";`, "const h = hostname();"] },
  { path: "osRelease", code: `const r = Deno.osRelease();`, contains: [`import { release } from "node:os";`] },
  { path: "osUptime", code: `const u = Deno.osUptime();`, contains: [`import { uptime } from "node:os";`] },
  { path: "loadavg", code: `const l = Deno.loadavg();`, contains: [`import { loadavg } from "node:os";`] },
  { path: "inspect", code: `console.log(Deno.inspect(obj, { depth: 4 }));`, contains: [`import { inspect } from "node:util";`, "inspect(obj, { depth: 4 })"] },
  { path: "build", code: `if (Deno.build.os === "windows") {}`, contains: [`import { build } from "./lifeboat-shim/build.ts";`, `build.os === "windows"`] },
  // fs
  { path: "readTextFile", code: `const t = await Deno.readTextFile("a.txt");`, contains: [`import { readFile } from "node:fs/promises";`, `await readFile("a.txt", "utf8")`] },
  { path: "readTextFileSync", code: `const t = Deno.readTextFileSync("a.txt");`, contains: [`import { readFileSync } from "node:fs";`, `readFileSync("a.txt", "utf8")`] },
  { path: "readFile", code: `const b = await Deno.readFile("a.bin");`, contains: [`readFile("a.bin")`] },
  { path: "readFileSync", code: `const b = Deno.readFileSync("a.bin");`, contains: [`readFileSync("a.bin")`] },
  { path: "writeTextFile", code: `await Deno.writeTextFile("a.txt", "hi");`, contains: [`import { writeFile } from "node:fs/promises";`, `await writeFile("a.txt", "hi");`] },
  { path: "writeTextFile", code: `await Deno.writeTextFile("a.txt", "hi", { append: true });`, contains: [`await appendFile("a.txt", "hi");`] },
  { path: "writeTextFile", code: `await Deno.writeTextFile("a.txt", "hi", { mode: 0o600 });`, manual: /write options/ },
  { path: "writeTextFileSync", code: `Deno.writeTextFileSync("a.txt", "hi");`, contains: [`writeFileSync("a.txt", "hi")`] },
  { path: "writeFile", code: `await Deno.writeFile("a.bin", bytes);`, contains: [`writeFile("a.bin", bytes)`] },
  { path: "writeFileSync", code: `Deno.writeFileSync("a.bin", bytes);`, contains: [`writeFileSync("a.bin", bytes)`] },
  { path: "remove", code: `await Deno.remove("dir", { recursive: true });`, contains: [`import { rm } from "node:fs/promises";`, `rm("dir", { recursive: true })`] },
  { path: "removeSync", code: `Deno.removeSync("a.txt");`, contains: [`rmSync("a.txt")`] },
  { path: "mkdir", code: `await Deno.mkdir("out", { recursive: true });`, contains: [`mkdir("out", { recursive: true })`] },
  { path: "mkdirSync", code: `Deno.mkdirSync("out");`, contains: [`mkdirSync("out")`] },
  { path: "rename", code: `await Deno.rename("a", "b");`, contains: [`rename("a", "b")`] },
  { path: "renameSync", code: `Deno.renameSync("a", "b");`, contains: [`renameSync("a", "b")`] },
  { path: "copyFile", code: `await Deno.copyFile("a", "b");`, contains: [`copyFile("a", "b")`] },
  { path: "copyFileSync", code: `Deno.copyFileSync("a", "b");`, contains: [`copyFileSync("a", "b")`] },
  { path: "chmod", code: `await Deno.chmod("a", 0o755);`, contains: [`chmod("a", 0o755)`] },
  { path: "chmodSync", code: `Deno.chmodSync("a", 0o755);`, contains: [`chmodSync("a", 0o755)`] },
  { path: "chown", code: `await Deno.chown("a", 1, 1);`, contains: [`chown("a", 1, 1)`] },
  { path: "chownSync", code: `Deno.chownSync("a", 1, 1);`, contains: [`chownSync("a", 1, 1)`] },
  { path: "truncate", code: `await Deno.truncate("a", 0);`, contains: [`truncate("a", 0)`] },
  { path: "truncateSync", code: `Deno.truncateSync("a");`, contains: [`truncateSync("a")`] },
  { path: "realPath", code: `const p = await Deno.realPath(".");`, contains: [`import { realpath } from "node:fs/promises";`] },
  { path: "realPathSync", code: `const p = Deno.realPathSync(".");`, contains: [`realpathSync(".")`] },
  { path: "readLink", code: `const p = await Deno.readLink("l");`, contains: [`readlink("l")`] },
  { path: "readLinkSync", code: `const p = Deno.readLinkSync("l");`, contains: [`readlinkSync("l")`] },
  { path: "link", code: `await Deno.link("a", "b");`, contains: [`link("a", "b")`] },
  { path: "linkSync", code: `Deno.linkSync("a", "b");`, contains: [`linkSync("a", "b")`] },
  { path: "symlink", code: `await Deno.symlink("a", "b");`, contains: [`symlink("a", "b")`] },
  { path: "symlinkSync", code: `Deno.symlinkSync("a", "b");`, contains: [`symlinkSync("a", "b")`] },
  { path: "utime", code: `await Deno.utime("a", 1, 2);`, contains: [`utimes("a", 1, 2)`] },
  { path: "utimeSync", code: `Deno.utimeSync("a", 1, 2);`, contains: [`utimesSync("a", 1, 2)`] },
  { path: "makeTempDir", code: `const d = await Deno.makeTempDir();`, contains: [`mkdtemp(join(tmpdir(), "tmp-"))`] },
  { path: "makeTempDirSync", code: `const d = Deno.makeTempDirSync();`, contains: [`mkdtempSync(join(tmpdir(), "tmp-"))`] },
  { path: "readDir", code: `for await (const e of Deno.readDir(".")) console.log(e.name);`, contains: [`import { readDir } from "./lifeboat-shim/fs.ts";`, `readDir(".")`] },
  { path: "readDirSync", code: `for (const e of Deno.readDirSync(".")) {}`, contains: [`readDirSync(".")`] },
  { path: "stat", code: `const s = await Deno.stat("a");`, contains: [`import { stat } from "./lifeboat-shim/fs.ts";`] },
  { path: "statSync", code: `const s = Deno.statSync("a");`, contains: [`statSync("a")`] },
  { path: "lstat", code: `const s = await Deno.lstat("a");`, contains: [`lstat("a")`] },
  { path: "lstatSync", code: `const s = Deno.lstatSync("a");`, contains: [`lstatSync("a")`] },
  { path: "readTextFile", code: `const t = await Deno.readTextFile("a.txt");`, target: "workers", manual: /no persistent file system/ },
  { path: "open", code: `const f = await Deno.open("a");`, manual: /FileHandle/ },
  { path: "openSync", code: `const f = Deno.openSync("a");`, manual: /FileHandle/ },
  { path: "create", code: `const f = await Deno.create("a");`, manual: /FileHandle/ },
  { path: "createSync", code: `const f = Deno.createSync("a");`, manual: /FileHandle/ },
  { path: "watchFs", code: `const w = Deno.watchFs(".");`, manual: /watch\(\)/ },
  // serve
  { path: "serve", code: `Deno.serve((req) => new Response("hi"));`, contains: [`import { serve } from "./lifeboat-shim/serve.ts";`, `serve((req) => new Response("hi"));`] },
  { path: "serve", code: `Deno.serve((req) => new Response("hi"));`, target: "bun", contains: [`serve((req) => new Response("hi"))`] },
  { path: "serve", code: `Deno.serve({ port: 3000 }, app.fetch);`, target: "workers", contains: ["export default { fetch: app.fetch };"] },
  { path: "serve", code: `Deno.serve({ handler: (req) => new Response("x") });`, target: "workers", contains: [`export default { fetch: (req) => new Response("x") };`] },
  { path: "serve", code: `const server = Deno.serve(handler);`, target: "workers", manual: /top-level/ },
  // cron & test
  { path: "cron", code: `Deno.cron("tick", "*/5 * * * *", () => {});`, contains: [`import { cron } from "./lifeboat-shim/cron.ts";`, `cron("tick", "*/5 * * * *", () => {})`] },
  { path: "cron", code: `Deno.cron("tick", "*/5 * * * *", () => {});`, target: "workers", manual: /Cron Triggers/ },
  { path: "test", code: `Deno.test("adds", () => {});`, contains: [`import { test } from "node:test";`, `test("adds", () => {});`] },
  { path: "test", code: `Deno.test("adds", () => {});`, target: "bun", contains: [`import { test } from "bun:test";`] },
  { path: "test", code: `Deno.test("adds", () => {});`, target: "workers", contains: [`import { test } from "vitest";`] },
  { path: "test", code: `Deno.test("s", async (t) => { await t.step("a", () => {}); });`, contains: [`await t.test("a", () => {})`] },
  {
    path: "test",
    code: `Deno.test("s", async (t) => { await t.step("a", () => {}); });`,
    target: "bun",
    contains: [`import { testContext } from "./lifeboat-shim/test.ts";`, `test("s", () => (async (t) => { await t.step("a", () => {}); })(testContext("s")));`],
  },
  { path: "test", code: `Deno.test({ name: "obj", only: true, fn: () => {} });`, target: "bun", manual: /test\.only/ },
  { path: "test", code: `Deno.test({ name: "obj", ignore: true, fn() {} });`, manual: /method/ },
  { path: "test", code: `Deno.test({ name: "obj", ignore: isCI, fn: () => {} });`, contains: [`test("obj", { skip: isCI }, () => {})`] },
  { path: "test", code: `Deno.test("x", { sanitizeOps: false }, () => {});`, contains: [`test("x", () => {})`] },
  { path: "test", code: `Deno.test(function namedTest() {});`, contains: [`test("namedTest", function namedTest() {})`] },
  { path: "test.ignore", code: `Deno.test.ignore("later", () => {});`, contains: [`test.skip("later", () => {})`] },
  { path: "test.only", code: `Deno.test.only("focus", () => {});`, contains: [`test.only("focus", () => {})`] },
  { path: "bench", code: `Deno.bench("fast", () => {});`, manual: /mitata|tinybench/ },
  // flagged
  { path: "openKv", code: `const kv = await Deno.openKv();`, manual: /@deno\/kv/ },
  { path: "openKv", code: `const kv = await Deno.openKv();`, target: "workers", manual: /Durable Object/ },
  { path: "Command", code: `const out = await new Deno.Command("ls").output();`, manual: /child_process/ },
  { path: "run", code: `const p = Deno.run({ cmd: ["ls"] });`, manual: /child_process/ },
  { path: "connect", code: `const c = await Deno.connect({ port: 80 });`, manual: /node:net/ },
  { path: "connectTls", code: `const c = await Deno.connectTls({ port: 443 });`, manual: /node:net/ },
  { path: "listen", code: `const l = Deno.listen({ port: 80 });`, manual: /node:net/ },
  { path: "listenTls", code: `const l = Deno.listenTls({ port: 443 });`, manual: /node:net/ },
  { path: "listenDatagram", code: `const l = Deno.listenDatagram({ port: 53, transport: "udp" });`, manual: /node:net/ },
  { path: "startTls", code: `const c = await Deno.startTls(conn);`, manual: /node:net/ },
  { path: "resolveDns", code: `const r = await Deno.resolveDns("x.com", "A");`, manual: /node:dns/ },
  { path: "upgradeWebSocket", code: `const { socket, response } = Deno.upgradeWebSocket(req);`, manual: /`ws` package/ },
  { path: "upgradeWebSocket", code: `const { socket, response } = Deno.upgradeWebSocket(req);`, target: "workers", manual: /WebSocketPair/ },
  { path: "serveHttp", code: `const h = Deno.serveHttp(conn);`, manual: /deprecated/ },
  { path: "permissions", code: `await Deno.permissions.request({ name: "net" });`, manual: /--permission/ },
  { path: "stdin", code: `const r = Deno.stdin.readable;`, manual: /process\.stdin/ },
  { path: "stdout", code: `await Deno.stdout.write(bytes);`, manual: /process\.stdin\/stdout/ },
  { path: "stderr", code: `Deno.stderr.writeSync(bytes);`, manual: /process\.stdin\/stdout/ },
  { path: "version", code: `console.log(Deno.version.deno);`, manual: /process\.versions/ },
  { path: "errors", code: `try {} catch (e) { if (e instanceof Deno.errors.NotFound) {} }`, contains: [`if ((e as { code?: unknown } | null | undefined)?.code === "ENOENT")`] },
  { path: "errors", code: `try {} catch (e) { if (!(e instanceof Deno.errors.AlreadyExists)) throw e; }`, fileName: "a.js", contains: [`if (!(e?.code === "EEXIST")) throw e;`] },
  { path: "errors", code: `throw new Deno.errors.NotFound("x");`, manual: /err\.code/ },
];

describe("API mapping table", () => {
  for (const c of CASES) {
    const target = c.target ?? "node";
    test(`${c.path} [${target}]: ${c.code}`, () => {
      const result = rewrite(c.code, { target, fileName: c.fileName });
      const finding = result.findings.find((f) => f.api.startsWith(`Deno.${c.path.split(".")[0]}`));
      if (c.manual) {
        assert.ok(finding, `expected a finding for Deno.${c.path}`);
        assert.equal(finding.status, "manual", `expected manual, got ${finding.status}: ${finding.message}`);
        assert.match(finding.message, c.manual);
        return;
      }
      assert.equal(result.findings.filter((f) => f.status === "manual").length, 0, JSON.stringify(result.findings, null, 2));
      for (const expected of c.contains ?? []) assert.ok(result.output.includes(expected), `missing:\n${expected}\n--- in output:\n${result.output}`);
      assert.ok(!/\bDeno\./.test(result.output), `Deno.* left in output:\n${result.output}`);
    });
  }

  test("every rule in API_RULES has at least one test case", () => {
    const covered = new Set(CASES.map((c) => c.path));
    const missing = API_RULES.map((r) => r.path).filter((p) => !covered.has(p));
    assert.deepEqual(missing, []);
  });
});

describe("rewriter behaviour", () => {
  test("nested Deno calls are composed", () => {
    const { output } = rewrite(`await Deno.writeTextFile(Deno.env.get("OUT") ?? "o.txt", Deno.cwd());`);
    assert.ok(output.includes(`await writeFile(process.env.OUT ?? "o.txt", process.cwd());`), output);
  });

  test("manual fallbacks keep inner rewrites", () => {
    const { output } = rewrite(`await Deno.writeTextFile(Deno.env.get("OUT")!, "x", { create: false });`);
    assert.ok(output.includes(`Deno.writeTextFile(process.env.OUT!, "x", { create: false })`), output);
  });

  test("a rule that falls back to manual leaves no stray imports or shims", () => {
    const result = rewrite(`Deno.test({ name: "x", ignore: true, fn: () => {} });`, { target: "bun" });
    assert.ok(!result.output.includes("import"), result.output);
    assert.equal(result.shims.size, 0);
  });

  test("imported names are aliased on conflict", () => {
    const { output } = rewrite(`const readFile = 1;\nconst t = await Deno.readTextFile("a");`);
    assert.ok(output.includes(`import { readFile as readFile2 } from "node:fs/promises";`), output);
    assert.ok(output.includes(`readFile2("a", "utf8")`), output);
  });

  test("existing imports are reused", () => {
    const { output } = rewrite(`import { readFile } from "node:fs/promises";\nconst t = await Deno.readTextFile("a");`);
    assert.equal(output.match(/from "node:fs\/promises"/g)?.length, 1, output);
  });

  test("shim paths are relative to the file", () => {
    const { output } = rewrite(`Deno.serve(() => new Response());`, { fileName: "src/server/main.ts" });
    assert.ok(output.includes(`from "../../lifeboat-shim/serve.ts"`), output);
  });

  test("manual items get a TODO comment when requested", () => {
    const { output } = rewrite(`function f() {\n  const kv = await Deno.openKv();\n}`, { emitTodos: true });
    assert.match(output, /\n {2}\/\/ lifeboat: TODO\(Deno\.openKv\) .*\n {2}const kv = await Deno\.openKv\(\);/);
  });

  test("TODO comments are not duplicated on re-run", () => {
    const once = rewrite(`const kv = await Deno.openKv();`, { emitTodos: true }).output;
    const twice = rewrite(once, { emitTodos: true }).output;
    assert.equal(twice, once);
  });

  test("files that declare their own Deno binding are left alone", () => {
    const { output, findings } = rewrite(`const Deno = { env: { get: () => "x" } };\nDeno.env.get("A");`);
    assert.ok(output.includes(`Deno.env.get("A")`));
    assert.equal(findings[0]?.status, "info");
  });

  test("type-only Deno references are reported, not counted", () => {
    const { findings } = rewrite(`let kv: Deno.Kv;`);
    assert.equal(findings[0]?.status, "type");
    assert.equal(findings[0]?.api, "Deno.Kv");
  });

  test("typeof Deno runtime detection is informational", () => {
    const { findings, output } = rewrite(`const isDeno = typeof Deno !== "undefined";`);
    assert.equal(findings[0]?.status, "info");
    assert.ok(output.includes("typeof Deno"));
  });

  test("unknown Deno APIs are flagged", () => {
    const { findings } = rewrite(`Deno.someFutureApi();`);
    assert.equal(findings[0]?.status, "manual");
    assert.equal(findings[0]?.api, "Deno.someFutureApi");
  });

  test("import.meta.main → argv check on Node, untouched on Bun", () => {
    const node = rewrite(`if (import.meta.main) main();`).output;
    assert.ok(node.includes(`if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();`), node);
    assert.ok(rewrite(`if (import.meta.main) main();`, { target: "bun" }).output.includes("import.meta.main"));
  });

  test("deno shebangs are rewritten", () => {
    assert.ok(rewrite(`#!/usr/bin/env -S deno run -A\nconsole.log(1);`).output.startsWith("#!/usr/bin/env node\n"));
    assert.ok(rewrite(`#!/usr/bin/env -S deno run -A\nconsole.log(1);`, { target: "bun" }).output.startsWith("#!/usr/bin/env bun\n"));
  });

  test("deno lib references and @deno-types hints are removed", () => {
    const { output } = rewrite(`/// <reference lib="deno.ns" />\n// @deno-types="npm:@types/express@4"\nimport express from "npm:express@4";\n`);
    assert.equal(output, `import express from "express";\n`);
  });

  test("KV atomic/enqueue calls are flagged with guidance", () => {
    const code = `const kv = await Deno.openKv();\nawait kv.atomic().set(["a"], 1).commit();\nawait kv.enqueue({ id: 1 });`;
    const node = rewrite(code).findings;
    assert.equal(node.find((f) => f.api === "kv.atomic()")?.status, "info");
    assert.equal(node.find((f) => f.api === "kv.enqueue()")?.status, "manual");
    const workers = rewrite(code, { target: "workers" }).findings;
    assert.equal(workers.find((f) => f.api === "kv.atomic()")?.status, "manual");
    assert.match(workers.find((f) => f.api === "kv.atomic()")?.message ?? "", /Durable Object/);
  });

  test("BroadcastChannel is flagged as Deploy-specific", () => {
    const { findings } = rewrite(`const ch = new BroadcastChannel("updates");`);
    assert.equal(findings[0]?.category, "deploy");
    assert.equal(findings[0]?.status, "manual");
  });

  test("Node-only: enums and parameter properties are flagged for type stripping", () => {
    const code = `enum Color { Red }\nclass A { constructor(private x: number) {} }`;
    assert.deepEqual(rewrite(code).findings.map((f) => f.api), ["enum", "parameter property"]);
    assert.equal(rewrite(code, { target: "bun" }).findings.length, 0);
  });
});
