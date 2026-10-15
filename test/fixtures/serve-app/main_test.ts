import assert from "node:assert/strict";
import { handler } from "./main.ts";

Deno.test("GET / greets", async () => {
  const res = await handler(new Request("http://localhost/"));
  assert.equal(await res.text(), "Hello, lifeboat!");
});

Deno.test("routes", async (t) => {
  await t.step("echo", async () => {
    const res = await handler(new Request("http://localhost/echo", { method: "POST", body: "ping" }));
    assert.equal(await res.text(), "ping");
  });
  await t.step("404", async () => {
    const res = await handler(new Request("http://localhost/nope"));
    assert.equal(res.status, 404);
  });
});
