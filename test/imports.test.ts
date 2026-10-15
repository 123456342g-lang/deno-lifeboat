import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { jsrNpmName, mapSpecifier, parsePackageRef, resolveImportMap, type SpecifierMapping } from "../src/imports.js";
import { rewrite } from "./helpers.js";

const ctx = { fromFile: "/proj/src/main.ts" };

function expectRewrite(mapping: SpecifierMapping, specifier: string, deps?: Record<string, string>): void {
  assert.equal(mapping.kind, "rewrite", JSON.stringify(mapping));
  if (mapping.kind !== "rewrite") return;
  assert.equal(mapping.specifier, specifier);
  if (deps) assert.deepEqual(Object.fromEntries(mapping.deps.map((d) => [d.name, d.spec])), deps);
}

describe("specifier mapping", () => {
  test("parsePackageRef", () => {
    assert.deepEqual(parsePackageRef("@std/path@^1.0.0/join"), { name: "@std/path", version: "^1.0.0", subpath: "/join" });
    assert.deepEqual(parsePackageRef("express@4"), { name: "express", version: "4", subpath: "" });
    assert.deepEqual(parsePackageRef("/preact"), { name: "preact", version: undefined, subpath: "" });
  });

  test("jsrNpmName", () => assert.equal(jsrNpmName("@std/assert"), "@jsr/std__assert"));

  test("npm: with version and subpath", () => expectRewrite(mapSpecifier("npm:preact@10.19.2/hooks", ctx), "preact/hooks", { preact: "10.19.2" }));
  test("npm: scoped", () => expectRewrite(mapSpecifier("npm:@hono/node-server@^1.13", ctx), "@hono/node-server", { "@hono/node-server": "^1.13" }));
  test("npm: unversioned → latest with note", () => {
    const m = mapSpecifier("npm:chalk", ctx);
    expectRewrite(m, "chalk", { chalk: "latest" });
    assert.match(m.kind === "rewrite" ? (m.note ?? "") : "", /pin a version/);
  });
  test("jsr: → npm alias on the JSR registry", () => {
    const m = mapSpecifier("jsr:@std/path@^1.0.8/join", ctx);
    expectRewrite(m, "@std/path/join", { "@std/path": "npm:@jsr/std__path@^1.0.8" });
    assert.equal(m.kind === "rewrite" ? m.deps[0]?.registry : undefined, "jsr");
  });
  test("jsr: leading-slash form", () => expectRewrite(mapSpecifier("jsr:/@oak/oak@17", ctx), "@oak/oak", { "@oak/oak": "npm:@jsr/oak__oak@17" }));
  test("jsr: unscoped is manual", () => assert.equal(mapSpecifier("jsr:nope", ctx).kind, "manual"));

  test("deno.land/std mod.ts → @std/<module>", () => expectRewrite(mapSpecifier("https://deno.land/std@0.224.0/path/mod.ts", ctx), "@std/path", { "@std/path": "npm:@jsr/std__path@latest" }));
  test("deno.land/std file → subpath (underscores → hyphens)", () => expectRewrite(mapSpecifier("https://deno.land/std@0.200.0/path/to_file_url.ts", ctx), "@std/path/to-file-url"));
  test("deno.land/std assert_ prefix is stripped", () => expectRewrite(mapSpecifier("https://deno.land/std@0.200.0/assert/assert_equals.ts", ctx), "@std/assert/equals"));
  test("deno.land/std testing/asserts.ts → @std/assert", () => expectRewrite(mapSpecifier("https://deno.land/std@0.170.0/testing/asserts.ts", ctx), "@std/assert"));
  test("deno.land/std http/server.ts is manual", () => assert.equal(mapSpecifier("https://deno.land/std@0.170.0/http/server.ts", ctx).kind, "manual"));
  test("deno.land/x known module", () => expectRewrite(mapSpecifier("https://deno.land/x/hono@v4.3.11/mod.ts", ctx), "hono", { hono: "4.3.11" }));
  test("deno.land/x unknown module is manual", () => assert.equal(mapSpecifier("https://deno.land/x/somelib@1.0.0/mod.ts", ctx).kind, "manual"));

  test("esm.sh package", () => expectRewrite(mapSpecifier("https://esm.sh/preact@10.19.2", ctx), "preact", { preact: "10.19.2" }));
  test("esm.sh versioned build prefix and query", () => {
    const m = mapSpecifier("https://esm.sh/v135/react-dom@18.2.0/client?deps=react@18.2.0", ctx);
    expectRewrite(m, "react-dom/client", { "react-dom": "18.2.0" });
    assert.match(m.kind === "rewrite" ? (m.note ?? "") : "", /query/);
  });
  test("esm.sh jsr/", () => expectRewrite(mapSpecifier("https://esm.sh/jsr/@std/encoding@1/base64", ctx), "@std/encoding/base64"));
  test("unpkg / jsdelivr", () => {
    expectRewrite(mapSpecifier("https://unpkg.com/lodash-es@4.17.21/lodash.js", ctx), "lodash-es/lodash.js");
    expectRewrite(mapSpecifier("https://cdn.jsdelivr.net/npm/zod@3.23.8/+esm", ctx), "zod/+esm");
  });
  test("other URLs are manual", () => assert.equal(mapSpecifier("https://example.com/lib.ts", ctx).kind, "manual"));

  test("relative and node: are unchanged", () => {
    assert.equal(mapSpecifier("./x.ts", ctx).kind, "unchanged");
    assert.equal(mapSpecifier("node:fs", ctx).kind, "unchanged");
    assert.equal(mapSpecifier("hono", ctx).kind, "unchanged");
  });
});

describe("import maps", () => {
  const importMap = {
    baseDir: "/proj",
    imports: {
      "@std/assert": "jsr:@std/assert@^1.0.0",
      oak: "jsr:@oak/oak@^17",
      "hono/": "npm:/hono@^4.6.0/",
      "@/": "./src/",
      config: "./config/index.ts",
      chalk: "npm:chalk@5",
      fs: "node:fs",
      legacy: "https://deno.land/x/legacy@1.0.0/mod.ts",
    },
  };
  const c = { importMap, fromFile: "/proj/src/routes/api.ts" };

  test("resolveImportMap: exact beats prefix, longest prefix wins", () => {
    assert.equal(resolveImportMap("oak", importMap), "jsr:@oak/oak@^17");
    assert.equal(resolveImportMap("hono/jsx", importMap), "npm:/hono@^4.6.0/jsx");
    assert.equal(resolveImportMap("nothing", importMap), undefined);
  });
  test("bare key that equals the package name keeps the specifier", () => expectRewrite(mapSpecifier("@std/assert", c), "@std/assert", { "@std/assert": "npm:@jsr/std__assert@^1.0.0" }));
  test("alias key is rewritten to the package name", () => expectRewrite(mapSpecifier("oak", c), "@oak/oak"));
  test("prefix mapping to npm", () => expectRewrite(mapSpecifier("hono/jsx", c), "hono/jsx", { hono: "^4.6.0" }));
  test("prefix mapping to a local directory → relative path", () => expectRewrite(mapSpecifier("@/lib/db.ts", c), "../lib/db.ts"));
  test("exact mapping to a local file → relative path", () => expectRewrite(mapSpecifier("config", c), "../../config/index.ts"));
  test("mapping to node:", () => expectRewrite(mapSpecifier("fs", c), "node:fs"));
  test("mapping to an unmappable URL is manual and names the entry", () => {
    const m = mapSpecifier("legacy", c);
    assert.equal(m.kind, "manual");
    assert.match(m.kind === "manual" ? m.reason : "", /import map entry "legacy"/);
  });
});

describe("specifier rewriting in files", () => {
  test("static, re-export and dynamic imports keep their quote style", () => {
    const { output, dependencies } = rewrite(
      `import { Hono } from 'npm:hono@4';\nexport { join } from "jsr:@std/path@1";\nconst m = await import("npm:zod@3");\n`,
    );
    assert.equal(output, `import { Hono } from 'hono';\nexport { join } from "@std/path";\nconst m = await import("zod");\n`);
    assert.deepEqual(dependencies.map((d) => d.name).sort(), ["@std/path", "hono", "zod"]);
  });
});
