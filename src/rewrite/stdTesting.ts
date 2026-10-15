import { Node, SyntaxKind, type ImportDeclaration } from "ts-morph";
import type { Target } from "../types.js";

/** Runner modules whose describe/it/hooks match @std/testing/bdd closely enough to swap imports. */
const BDD_MODULES: Readonly<Record<Target, string>> = { node: "node:test", bun: "bun:test", workers: "vitest" };

type BddExport = "describe" | "it" | "test" | "beforeAll" | "afterAll" | "beforeEach" | "afterEach" | "before" | "after";

const NODE_NAMES: Readonly<Record<BddExport, string>> = {
  describe: "describe",
  it: "it",
  test: "test",
  beforeAll: "before",
  afterAll: "after",
  beforeEach: "beforeEach",
  afterEach: "afterEach",
  before: "before",
  after: "after",
};

const JEST_STYLE_NAMES: Readonly<Record<BddExport, string>> = { ...NODE_NAMES, beforeAll: "beforeAll", afterAll: "afterAll", before: "beforeAll", after: "afterAll" };

const TARGET_NAMES: Readonly<Record<Target, Readonly<Record<BddExport, string>>>> = { node: NODE_NAMES, bun: JEST_STYLE_NAMES, workers: JEST_STYLE_NAMES };

const STD_BDD = /^(?:jsr:\/?@std\/testing(?:@[^/]+)?\/bdd|@std\/testing\/bdd|https:\/\/deno\.land\/std(?:@[^/]+)?\/testing\/bdd\.ts)$/;

/** `@std/testing/bdd` in any of its spellings (resolve import-map aliases before calling). */
export function isStdBdd(specifier: string): boolean {
  return STD_BDD.test(specifier);
}

function isBddExport(name: string): name is BddExport {
  return Object.hasOwn(NODE_NAMES, name);
}

export type BddRewrite = { readonly text: string; readonly module: string } | { readonly manual: string };

/**
 * @std/testing/bdd registers its suites through `Deno.test`, so it cannot run on Node/Bun.
 * Swap the import to the target's runner when every use has a direct equivalent.
 */
export function rewriteStdBddImport(decl: ImportDeclaration, target: Target): BddRewrite {
  const module = BDD_MODULES[target];
  if (decl.getDefaultImport() || decl.getNamespaceImport()) return { manual: `import the named describe/it/hooks; then point the import at "${module}"` };
  const named = decl.getNamedImports();
  const unsupported = named.map((spec) => spec.getName()).filter((name) => !isBddExport(name));
  if (unsupported.length > 0) return { manual: `${unsupported.join(", ")} has no "${module}" equivalent; port those suites by hand` };
  const blocker = named.map((spec) => usageBlocker(spec.getNameNode())).find((reason) => reason !== undefined);
  if (blocker) return { manual: blocker };
  const names = TARGET_NAMES[target];
  const parts = named.map((spec) => {
    const mapped = names[spec.getName() as BddExport];
    const local = spec.getAliasNode()?.getText() ?? spec.getName();
    return local === mapped ? mapped : `${mapped} as ${local}`;
  });
  const unique = [...new Set(parts)];
  return { text: `import { ${unique.join(", ")} } from "${module}";`, module };
}

/** `.ignore` and the `{ name, fn }` object form are std-only. */
function usageBlocker(nameNode: Node): string | undefined {
  if (!Node.isIdentifier(nameNode)) return undefined;
  for (const ref of nameNode.findReferencesAsNodes()) {
    const parent = ref.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref && parent.getName() === "ignore") {
      return `${ref.getText()}.ignore: rename to .skip after switching the import`;
    }
    const call = Node.isCallExpression(parent) && parent.getExpression() === ref ? parent : undefined;
    if (call?.getArguments()[0]?.getKind() === SyntaxKind.ObjectLiteralExpression) {
      return `${ref.getText()}({ name, fn, ... }) object form: rewrite as ${ref.getText()}(name, fn) before switching the import`;
    }
  }
  return undefined;
}
