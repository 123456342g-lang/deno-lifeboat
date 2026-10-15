import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { build } from "../templates/build.js";
import { scheduleToCron } from "../templates/cron.js";
import { lstat, readDir, readDirSync, stat } from "../templates/fs.js";
import { serve, type NetAddr, type ServeHandler } from "../templates/serve.js";

async function withServer(
  handler: ServeHandler,
  run: (base: string) => Promise<void>,
  extra: { onError?: (e: unknown) => Response } = {},
): Promise<void> {
  let ready!: (addr: NetAddr) => void;
  const listening = new Promise<NetAddr>((resolve) => (ready = resolve));
  const server = serve({ port: 0, hostname: "127.0.0.1", onListen: ready, ...extra }, handler);
  const addr = await listening;
  try {
    await run(`http://127.0.0.1:${addr.port}`);
  } finally {
    await server.shutdown();
  }
  await server.finished;
}

describe("serve shim (Deno.serve on node:http)", () => {
  test("GET with query, headers and remoteAddr", async () => {
    await withServer(
      (req, info) => Response.json({ url: new URL(req.url).search, ua: req.headers.get("x-test"), ip: info.remoteAddr.hostname }),
      async (base) => {
        const res = await fetch(`${base}/path?q=1`, { headers: { "x-test": "yes" } });
        assert.deepEqual(await res.json(), { url: "?q=1", ua: "yes", ip: "127.0.0.1" });
      },
    );
  });

  test("POST body streams through", async () => {
    await withServer(
      async (req) => new Response(`${req.method}:${await req.text()}`),
      async (base) => {
        const res = await fetch(base, { method: "POST", body: "hello" });
        assert.equal(await res.text(), "POST:hello");
      },
    );
  });

  test("multiple Set-Cookie headers are preserved", async () => {
    await withServer(
      () => {
        const headers = new Headers();
        headers.append("set-cookie", "a=1");
        headers.append("set-cookie", "b=2");
        return new Response("ok", { status: 201, headers });
      },
      async (base) => {
        const res = await fetch(base);
        assert.equal(res.status, 201);
        assert.deepEqual(res.headers.getSetCookie(), ["a=1", "b=2"]);
      },
    );
  });

  test("streaming response bodies", async () => {
    await withServer(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("chunk1,"));
              controller.enqueue(new TextEncoder().encode("chunk2"));
              controller.close();
            },
          }),
        ),
      async (base) => assert.equal(await (await fetch(base)).text(), "chunk1,chunk2"),
    );
  });

  test("handler errors go through onError", async () => {
    await withServer(
      () => {
        throw new Error("boom");
      },
      async (base) => {
        const res = await fetch(base);
        assert.equal(res.status, 418);
        assert.equal(await res.text(), "handled: boom");
      },
      { onError: (e) => new Response(`handled: ${(e as Error).message}`, { status: 418 }) },
    );
  });

  test("handler-only form, PORT env and AbortSignal shutdown", async () => {
    const previous = process.env.PORT;
    process.env.PORT = "0";
    const controller = new AbortController();
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (msg: string) => void logs.push(msg);
    try {
      const server = serve({ signal: controller.signal, hostname: "127.0.0.1" }, () => new Response("x"));
      await new Promise((r) => setTimeout(r, 50));
      assert.match(logs[0] ?? "", /^Listening on http:\/\/127\.0\.0\.1:\d+\/$/);
      assert.equal(await (await fetch(`http://127.0.0.1:${server.addr.port}`)).text(), "x");
      controller.abort();
      await server.finished;
    } finally {
      console.log = originalLog;
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });
});

describe("cron shim", () => {
  test("object schedules convert like Deno's", () => {
    assert.equal(scheduleToCron({ minute: { every: 15 } }), "*/15 * * * *");
    assert.equal(scheduleToCron({ hour: { exact: [1, 13] }, minute: 0 }), "0 1,13 * * *");
    assert.equal(scheduleToCron({ dayOfWeek: { start: 1, end: 5 }, hour: 9, minute: 30 }), "30 9 * * 1-5");
  });
});

describe("fs shim", () => {
  test("readDir / readDirSync / stat / lstat return Deno-shaped values", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lifeboat-fs-"));
    writeFileSync(path.join(dir, "a.txt"), "hello");
    mkdirSync(path.join(dir, "sub"));
    const entries = [];
    for await (const entry of readDir(dir)) entries.push(entry);
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(sorted, [
      { name: "a.txt", isFile: true, isDirectory: false, isSymlink: false },
      { name: "sub", isFile: false, isDirectory: true, isSymlink: false },
    ]);
    assert.equal(readDirSync(dir).length, 2);
    const info = await stat(path.join(dir, "a.txt"));
    assert.equal(info.isFile, true);
    assert.equal(info.size, 5);
    assert.ok(info.mtime instanceof Date);
    assert.equal((await lstat(path.join(dir, "sub"))).isDirectory, true);
  });
});

describe("build shim", () => {
  test("uses Deno's os/arch names", () => {
    assert.notEqual(build.os, "win32");
    assert.ok(!["x64", "arm64"].includes(build.arch));
    assert.equal(build.target, `${build.arch}-${build.os}`);
  });
});
