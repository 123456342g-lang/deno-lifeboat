import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ModuleKind, ModuleResolutionKind, Project } from "ts-morph";
import { mergeDependencies, npmPackageName } from "../src/config.js";
import { applyEdits, EditSet } from "../src/rewrite/editSet.js";
import { typeOnlyImportFixes } from "../src/rewrite/typeImports.js";
import { summarize } from "../src/summary.js";

describe("EditSet", () => {
  test("applies edits back to front", () => {
    assert.equal(applyEdits("abcdef", [{ start: 0, end: 1, text: "X" }, { start: 4, end: 6, text: "YZ!" }]), "XbcdYZ!");
  });
  test("insertions at the same position keep their order", () => {
    assert.equal(applyEdits("ab", [{ start: 1, end: 1, text: "1" }, { start: 1, end: 1, text: "2" }]), "a12b");
  });
  test("overlapping edits are skipped and reported", () => {
    const conflicts: { start: number; end: number; text: string }[] = [];
    assert.equal(applyEdits("abcdef", [{ start: 0, end: 4, text: "X" }, { start: 2, end: 5, text: "Y" }], conflicts), "abYf");
    assert.equal(conflicts.length, 1);
  });
  test("textOf consumes contained edits; transaction rollback releases them", () => {
    const set = new EditSet("f(g(x))");
    set.add({ start: 2, end: 6, text: "h(x)" });
    set.transaction(() => {
      set.textOf(2, 6);
      return false;
    });
    assert.equal(set.apply(), "f(h(x))");
    const inner = set.textOf(2, 6);
    set.add({ start: 0, end: 7, text: `k(${inner})` });
    assert.equal(set.apply(), "k(h(x))");
  });
});

function fix(files: Record<string, string>, main = "/p/main.ts"): string {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowImportingTsExtensions: true, noEmit: true, module: ModuleKind.ESNext, moduleResolution: ModuleResolutionKind.Bundler },
  });
  for (const [name, code] of Object.entries(files)) project.createSourceFile(name, code);
  const file = project.getSourceFileOrThrow(main);
  return applyEdits(file.getFullText(), typeOnlyImportFixes(file).edits);
}

describe("type-only imports (Node type stripping)", () => {
  test("interfaces used only in annotations become `type`", () => {
    const out = fix({
      "/p/types.ts": "export interface User { id: string }\nexport const VERSION = 1;",
      "/p/main.ts": `import { User, VERSION } from "./types.ts";\nconst u: User = { id: "1" };\nconsole.log(VERSION);`,
    });
    assert.ok(out.startsWith(`import { type User, VERSION } from "./types.ts";`), out);
  });
  test("whole declaration becomes `import type` when everything is a type", () => {
    const out = fix({
      "/p/types.ts": "export type A = string;\nexport interface B {}",
      "/p/main.ts": `import { A, type B } from "./types.ts";\nlet a: A; let b: B;`,
    });
    assert.ok(out.startsWith(`import type { A, B } from "./types.ts";`), out);
  });
  test("usage-based detection works for packages we can't resolve", () => {
    const out = fix({ "/p/main.ts": `import { Hono, type Context, MiddlewareHandler } from "hono";\nconst app = new Hono();\nconst mw: MiddlewareHandler = async (c: Context, next) => next();` });
    assert.ok(out.startsWith(`import { Hono, type Context, type MiddlewareHandler } from "hono";`), out);
  });
  test("class used in `extends` stays a value; in `implements` it is a type", () => {
    const out = fix({ "/p/main.ts": `import { Base, Shape } from "lib";\nclass A extends Base implements Shape {}` });
    assert.ok(out.startsWith(`import { Base, type Shape } from "lib";`), out);
  });
  test("re-exported types become `export { type X }`", () => {
    const out = fix({
      "/p/types.ts": "export interface Options {}\nexport function make() {}",
      "/p/main.ts": `export { make, Options } from "./types.ts";`,
    });
    assert.equal(out, `export { make, type Options } from "./types.ts";`);
  });
  test("unused imports are left alone", () => {
    const code = `import { something } from "./side-effects.ts";`;
    assert.equal(fix({ "/p/main.ts": code }), code);
  });
});

describe("config helpers", () => {
  test("npmPackageName", () => {
    assert.equal(npmPackageName("@scope/My App"), "@scope/my-app");
    assert.equal(npmPackageName("My_App"), "my_app");
  });
  test("mergeDependencies prefers explicit versions", () => {
    const merged = mergeDependencies([
      { name: "@std/path", spec: "npm:@jsr/std__path@latest" },
      { name: "@std/path", spec: "npm:@jsr/std__path@^1.0.8" },
      { name: "hono", spec: "^4" },
      { name: "hono", spec: "^3" },
      { name: "vitest", spec: "^3", dev: true },
    ]);
    assert.deepEqual(merged, { prod: { "@std/path": "npm:@jsr/std__path@^1.0.8", hono: "^4" }, dev: { vitest: "^3" } });
  });
  test("summary percent counts only auto/manual items", () => {
    const base = { file: "a.ts", line: 1, column: 1, api: "x", message: "" };
    const s = summarize([
      { ...base, category: "env", status: "auto" },
      { ...base, category: "env", status: "auto" },
      { ...base, category: "kv", status: "manual" },
      { ...base, category: "import", status: "auto" },
      { ...base, category: "runtime", status: "type" },
      { ...base, category: "runtime", status: "info" },
    ]);
    assert.deepEqual(s.overall, { total: 4, auto: 3, manual: 1, percent: 75 });
    assert.equal(s.typeOnly, 1);
    assert.equal(s.features.kv, true);
  });
});
