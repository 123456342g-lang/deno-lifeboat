// Runs the compiled tests. Lists files explicitly because `node --test <dir>` differs between Node 20 and 22+.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const dir = path.resolve("dist/test");
const files = readdirSync(dir, { recursive: true })
  .map(String)
  .filter((file) => file.endsWith(".test.js"))
  .map((file) => path.join(dir, file))
  .sort();

const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
