import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { FIXTURES, fixtureRepo, runCli } from "./helpers.js";

interface Envelope {
  ok: boolean;
  error: string | null;
  data: {
    summary: { overall: { total: number; auto: number; manual: number; percent: number }; features: { kv: boolean; cron: boolean } };
    findings: Array<{ file: string; line: number; api: string; status: string; category: string; message: string }>;
    changes: Array<{ path: string; created: boolean }>;
  };
}

function json(args: string[]): Envelope {
  const result = runCli([...args, "--json"]);
  return JSON.parse(result.stdout) as Envelope;
}

describe("scan / migrate on the deploy-app fixture", () => {
  test("scan --json reports APIs, imports, KV and cron with file:line", () => {
    const report = json(["scan", path.join(FIXTURES, "deploy-app")]);
    assert.equal(report.ok, true);
    const { summary, findings } = report.data;
    assert.equal(summary.features.kv, true);
    assert.equal(summary.features.cron, true);
    const manual = findings.filter((f) => f.status === "manual").map((f) => `${f.file}:${f.line} ${f.api}`);
    assert.deepEqual(manual, [
      "main.ts:5 https://deno.land/x/somelib@1.0.0/mod.ts",
      "main.ts:7 Deno.openKv",
      "main.ts:16 kv.enqueue()",
    ]);
    assert.ok(summary.overall.percent > 50 && summary.overall.percent < 100);
  });

  test("scan is read-only", () => {
    const dir = fixtureRepo("deploy-app");
    runCli(["scan", dir]);
    assert.ok(!existsSync(path.join(dir, "package.json")));
    assert.ok(!existsSync(path.join(dir, "lifeboat-checklist.md")));
  });

  test("migrate --to node writes dependencies, .npmrc for JSR, and keeps deno.json", () => {
    const dir = fixtureRepo("deploy-app");
    const denoJson = readFileSync(path.join(dir, "deno.json"), "utf8");
    const result = runCli(["migrate", dir, "--to", "node", "--write"]);
    assert.equal(result.status, 0, result.stderr);
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.deepEqual(pkg.dependencies, {
      "@std/assert": "npm:@jsr/std__assert@^1.0.0",
      hono: "^4.6.0",
      "@std/path": "npm:@jsr/std__path@^1.0.8",
      chalk: "5.3.0",
      preact: "10.19.2",
      croner: "^10.0.1",
    });
    assert.equal(pkg.scripts.dev, "node --watch main.ts");
    assert.equal(readFileSync(path.join(dir, ".npmrc"), "utf8"), "@jsr:registry=https://npm.jsr.io\n");
    assert.equal(readFileSync(path.join(dir, "deno.json"), "utf8"), denoJson);
    const main = readFileSync(path.join(dir, "main.ts"), "utf8");
    assert.match(main, /import \{ join \} from "@std\/path";/);
    assert.match(main, /import chalk from "chalk";/);
    assert.match(main, /import \{ useState \} from "preact\/hooks";/);
    assert.match(main, /\/\/ lifeboat: TODO\(Deno\.openKv\) .*@deno\/kv/);
    assert.match(main, /cron\("cleanup", "0 3 \* \* \*"/);
    assert.ok(existsSync(path.join(dir, "lifeboat-shim", "cron.ts")));
    assert.ok(existsSync(path.join(dir, "lifeboat-shim", "serve.ts")));
    const test = readFileSync(path.join(dir, "main_test.ts"), "utf8");
    assert.match(test, /import \{ test \} from "node:test";/);
  });

  test("migrate --to workers: export default, cron trigger, KV guidance", () => {
    const dir = fixtureRepo("deploy-app");
    const result = runCli(["migrate", dir, "--to", "workers", "--write"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Migration checklist: Deno → Cloudflare Workers/);
    const main = readFileSync(path.join(dir, "main.ts"), "utf8");
    assert.match(main, /^export default \{ fetch: app\.fetch \};$/m);
    assert.match(main, /lifeboat: TODO\(Deno\.openKv\) .*Durable Object/);
    assert.match(main, /lifeboat: TODO\(kv\.atomic\(\)\)/);
    const wrangler = readFileSync(path.join(dir, "wrangler.jsonc"), "utf8");
    assert.match(wrangler, /"crons": \[\s*"0 3 \* \* \*"\s*\]/);
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.equal(pkg.scripts.dev, "wrangler dev");
    assert.ok(pkg.devDependencies.wrangler);
    assert.ok(pkg.devDependencies.vitest);
    const checklist = readFileSync(path.join(dir, "lifeboat-checklist.md"), "utf8");
    for (const expected of [/Cloudflare Queues/, /Cron Triggers|triggers\.crons/, /exportEntries/, /about six months/]) {
      assert.match(checklist, expected);
    }
  });

  test("CLI errors use the JSON envelope", () => {
    const report = json(["migrate", path.join(FIXTURES, "deploy-app"), "--to", "deno"]);
    assert.equal(report.ok, false);
    assert.match(report.error ?? "", /unknown target/);
  });

  test("migrate requires --to", () => {
    const result = runCli(["migrate", "."]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /needs --to/);
  });
});
