import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { describe, test } from "node:test";
import { bunPath, fixtureRepo, runCli, stripTypesFlags } from "./helpers.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

/** Starts the app, waits for its "ready on <port>" log line, and returns the child process. */
async function startApp(command: string, args: string[], cwd: string, port: number): Promise<ChildProcess> {
  const child = spawn(command, args, { cwd, env: { ...process.env, PORT: String(port), GREETING: "ahoy" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`app did not start in time:\n${output}`)), 15_000);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.includes(`ready on ${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`app exited with ${code}:\n${output}`));
    });
  });
  return child;
}

async function assertServes(base: string): Promise<void> {
  assert.equal(await (await fetch(`${base}/`)).text(), "Hello, lifeboat!");
  assert.deepEqual(await (await fetch(`${base}/env`)).json(), { greeting: "ahoy", hasHome: true });
  const echo = await fetch(`${base}/echo`, { method: "POST", body: "ping", headers: { "content-type": "text/x-test" } });
  assert.equal(await echo.text(), "ping");
  assert.equal(echo.headers.get("content-type"), "text/x-test");
  assert.deepEqual((await fetch(`${base}/cookies`)).headers.getSetCookie(), ["a=1; Path=/", "b=2; Path=/"]);
  assert.equal((await fetch(`${base}/missing`)).status, 404);
}

function migrate(dir: string, target: string): void {
  const result = runCli(["migrate", dir, "--to", target, "--write"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
}

const nodeFlags = stripTypesFlags();
const bun = bunPath();

describe("end-to-end: migrate the serve-app fixture", () => {
  test("dry run changes nothing and prints a diff", () => {
    const dir = fixtureRepo("serve-app");
    const before = readFileSync(path.join(dir, "main.ts"), "utf8");
    const result = runCli(["migrate", dir, "--to", "node"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\+\+\+ b\/main\.ts/);
    assert.match(result.stdout, /Dry run/);
    assert.equal(readFileSync(path.join(dir, "main.ts"), "utf8"), before);
    assert.ok(!existsSync(path.join(dir, "package.json")));
  });

  test("--write refuses on a dirty git tree, --force overrides", () => {
    const dir = fixtureRepo("serve-app");
    writeFileSync(path.join(dir, "scratch.txt"), "uncommitted");
    const refused = runCli(["migrate", dir, "--to", "node", "--write"]);
    assert.equal(refused.status, 3);
    assert.match(refused.stderr, /uncommitted changes/);
    assert.ok(!existsSync(path.join(dir, "package.json")));
    assert.equal(runCli(["migrate", dir, "--to", "node", "--write", "--force"]).status, 0);
    assert.ok(existsSync(path.join(dir, "package.json")));
  });

  test("Node: migrated app serves HTTP and its tests pass", { skip: nodeFlags === undefined && "this Node cannot run TypeScript" }, async () => {
    const dir = fixtureRepo("serve-app");
    migrate(dir, "node");
    assert.ok(existsSync(path.join(dir, "deno.json")), "deno.json must be kept");
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.type, "module");
    assert.equal(pkg.scripts.start, "node main.ts");

    const port = await freePort();
    const app = await startApp(process.execPath, [...(nodeFlags ?? []), "main.ts"], dir, port);
    try {
      await assertServes(`http://127.0.0.1:${port}`);
    } finally {
      app.kill();
    }

    const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
    const tests = spawnSync(process.execPath, [...(nodeFlags ?? []), "--test", "main_test.ts"], { cwd: dir, encoding: "utf8", env });
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.match(tests.stdout, /pass 4/);
    assert.match(tests.stdout, /fail 0/);
  });

  test("Bun: migrated app serves HTTP and its tests pass", { skip: bun === undefined && !process.env.LIFEBOAT_REQUIRE_BUN && "bun not installed" }, async () => {
    const dir = fixtureRepo("serve-app");
    migrate(dir, "bun");
    const port = await freePort();
    const app = await startApp(bun!, ["main.ts"], dir, port);
    try {
      await assertServes(`http://127.0.0.1:${port}`);
    } finally {
      app.kill();
    }
    const tests = spawnSync(bun!, ["test"], { cwd: dir, encoding: "utf8" });
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.match(tests.stderr, /2 pass/);
  });

  test("Workers: entry becomes export default { fetch } and a checklist is written", () => {
    const dir = fixtureRepo("serve-app");
    const scan = runCli(["scan", dir, "--to", "workers"]);
    assert.equal(scan.status, 0, scan.stderr);
    assert.match(scan.stdout, /Migration checklist: Deno → Cloudflare Workers/);
    migrate(dir, "workers");
    const main = readFileSync(path.join(dir, "main.ts"), "utf8");
    assert.match(main, /lifeboat: TODO\(import\.meta\.main\)/);
    const wrangler = readFileSync(path.join(dir, "wrangler.jsonc"), "utf8");
    assert.match(wrangler, /"main": "main.ts"/);
    assert.match(wrangler, /"nodejs_compat"/);
    const checklist = readFileSync(path.join(dir, "lifeboat-checklist.md"), "utf8");
    assert.match(checklist, /wrangler dev/);
    assert.match(checklist, /no writable disk/);
  });
});
