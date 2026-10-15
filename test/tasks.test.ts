import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { convertTask, splitCommand } from "../src/tasks.js";
import type { Target } from "../src/types.js";

const convert = (cmd: string, target: Target = "node", testPatterns: string[] = ["**/*_test.ts"]) => convertTask(cmd, { target, testPatterns });

describe("deno.json tasks → package.json scripts", () => {
  test("splitCommand respects quotes", () => {
    assert.deepEqual(splitCommand(`echo "a && b" && deno run x.ts`), { parts: [`echo "a && b" `, " deno run x.ts"], separators: ["&&"] });
  });

  test("deno run drops permission flags", () => {
    const r = convert("deno run --allow-net --allow-env=FOO -A main.ts");
    assert.equal(r.script, "node main.ts");
    assert.equal(r.status, "auto");
    assert.match(r.note ?? "", /--allow-net/);
  });
  test("deno run keeps --watch and --env-file, passes script args", () => {
    assert.equal(convert("deno run --watch --env-file=.env.local -A main.ts --port 3000").script, "node --watch --env-file=.env.local main.ts --port 3000");
  });
  test("deno run drops flags with separate values", () => assert.equal(convert("deno run --config deno.json -A main.ts").script, "node main.ts"));
  test("deno run on Bun", () => assert.equal(convert("deno run -A main.ts", "bun").script, "bun main.ts"));
  test("deno run on Workers → wrangler dev", () => assert.equal(convert("deno run -A main.ts", "workers").script, "wrangler dev"));
  test("deno run npm: package → npx/bunx", () => {
    assert.equal(convert("deno run -A npm:prisma@5 generate").script, "npx prisma@5 generate");
    assert.equal(convert("deno run -A npm:prisma generate", "bun").script, "bunx prisma generate");
  });
  test("deno run of a remote module is manual", () => assert.equal(convert("deno run -A https://deno.land/x/tool/cli.ts").status, "manual"));
  test("deno test → node --test with discovered patterns", () => assert.equal(convert("deno test -A").script, `node --test "**/*_test.ts"`));
  test("deno test with explicit files", () => assert.equal(convert("deno test -A tests/").script, "node --test tests/"));
  test("deno test on Bun / Workers", () => {
    assert.equal(convert("deno test -A", "bun").script, "bun test");
    assert.equal(convert("deno test -A", "workers").script, "vitest run");
  });
  test("deno task → npm run / bun run", () => {
    assert.equal(convert("deno task build").script, "npm run build");
    assert.equal(convert("deno task build", "bun").script, "bun run build");
  });
  test("env var prefixes and chains are preserved", () => {
    assert.equal(convert("deno task build && PORT=3000 deno run -A main.ts").script, "npm run build && PORT=3000 node main.ts");
  });
  test("non-deno commands pass through", () => {
    const r = convert("tailwindcss -i in.css -o out.css");
    assert.equal(r.script, "tailwindcss -i in.css -o out.css");
    assert.equal(r.status, "auto");
  });
  test("unmapped deno subcommands are kept and flagged", () => {
    const r = convert("deno fmt --check");
    assert.equal(r.script, "deno fmt --check");
    assert.equal(r.status, "manual");
  });
  test("deno serve is manual on Node, wrangler dev on Workers", () => {
    assert.equal(convert("deno serve main.ts").status, "manual");
    assert.equal(convert("deno serve main.ts", "workers").script, "wrangler dev");
  });
  test("deno deploy", () => {
    assert.equal(convert("deno deploy --prod", "workers").script, "wrangler deploy");
    assert.equal(convert("deno deploy --prod").status, "manual");
  });
});
