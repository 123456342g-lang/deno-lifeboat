import { Hono } from "hono";
import { join } from "jsr:@std/path@^1.0.8";
import chalk from "npm:chalk@5.3.0";
import { useState } from "https://esm.sh/preact@10.19.2/hooks";
import * as legacy from "https://deno.land/x/somelib@1.0.0/mod.ts";

const kv = await Deno.openKv();
const app = new Hono();

app.get("/", async (c) => {
  await kv.atomic().set(["visits"], 1).commit();
  return c.text(chalk.green(join("a", "b")) + String(useState) + String(legacy));
});

Deno.cron("cleanup", "0 3 * * *", async () => {
  await kv.enqueue({ type: "cleanup" });
});

Deno.serve(app.fetch);
