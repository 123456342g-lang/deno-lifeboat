import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { rewrite, stripTypesFlags } from "./helpers.js";

const flags = stripTypesFlags();

/** Runs TypeScript with Node's type stripping and returns stdout. */
function runStripped(code: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lifeboat-erasable-"));
  const file = path.join(dir, "main.ts");
  writeFileSync(file, code);
  const result = spawnSync(process.execPath, [...(flags ?? []), file], { encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stderr}\n--- code:\n${code}`);
  return result.stdout.trim();
}

const skip = flags === undefined && "this Node cannot run TypeScript";

describe("erasable syntax rewrites for Node type stripping", () => {
  test("parameter properties become fields assigned in the constructor", () => {
    const { output } = rewrite(
      [
        "class Base { constructor(public id: string) {} }",
        "class Store extends Base {",
        "  /** docs */",
        "  constructor(private readonly kv: Map<string, number>, public name?: string, plain = 1) {",
        "    super(\"s\");",
        "    console.log(plain);",
        "  }",
        "  size() { return this.kv.size; }",
        "}",
      ].join("\n"),
    );
    assert.ok(output.includes("  private readonly kv: Map<string, number>;\n  public name?: string;\n  /** docs */\n  constructor(kv: Map<string, number>, name?: string, plain = 1) {"), output);
    assert.ok(output.includes(`    super("s");\n    this.kv = kv;\n    this.name = name;\n    console.log(plain);`), output);
    assert.ok(output.includes("class Base { public id: string;\nconstructor(id: string) {\n  this.id = id;\n} }"), output);
  });

  test("parameter properties read by field initializers stay manual", () => {
    const { findings } = rewrite("class A {\n  doubled = this.x * 2;\n  constructor(private x: number) {}\n}");
    assert.equal(findings[0]?.status, "manual");
  });

  test("string and numeric enums become `as const` objects", () => {
    const { output } = rewrite("export enum Status { Pending = \"pending\", Done = \"done\" }\nenum Level { Low, Mid = 5, High }");
    assert.ok(output.includes(`export const Status = {\n  Pending: "pending",\n  Done: "done",\n} as const;\nexport type Status = (typeof Status)[keyof typeof Status];`), output);
    assert.ok(output.includes("Low: 0,\n  Mid: 5,\n  High: 6,"), output);
  });

  test("computed enums and enums used as namespaces stay manual", () => {
    assert.equal(rewrite("enum Flags { A = 1 << 0 }").findings[0]?.status, "manual");
    assert.equal(rewrite("enum E { A }\nlet x: E.A;").findings[0]?.status, "manual");
  });

  test("rewritten code actually runs under Node type stripping", { skip }, () => {
    const { output } = rewrite(
      [
        "enum Status { Pending = \"pending\", Done = \"done\" }",
        "class Base { constructor(protected tag: string) {} }",
        "class Job extends Base {",
        "  constructor(public readonly id: number, private status: Status = Status.Pending) { super(\"job\"); }",
        "  finish(): string { this.status = Status.Done; return `${this.tag}:${this.id}:${this.status}`; }",
        "}",
        "const s: Status = Status.Pending;",
        "console.log(new Job(7).finish(), s);",
      ].join("\n"),
    );
    assert.equal(runStripped(output), "job:7:done pending");
  });
});
