import { Node, SyntaxKind } from "ts-morph";
import { NODE, WORKERS } from "./guidance.js";
import { manual } from "./types.js";
const CRONER_VERSION = "^10.0.1";
export const VITEST_VERSION = "^3.2.0";
const nodeCron = (ctx) => {
    if (ctx.args.length < 3 || ctx.args.length > 4)
        return manual("Deno.cron called with an unexpected number of arguments");
    ctx.dependency({ name: "croner", spec: CRONER_VERSION });
    return {
        text: `${ctx.shim("cron", "cron")}(${ctx.allArgs()})`,
        note: "runs in-process (UTC, no overlapping runs); with several app instances every instance fires the job",
    };
};
const workersCron = (ctx) => {
    const schedule = ctx.args[1];
    if (schedule && Node.isStringLiteral(schedule))
        ctx.cronTrigger(schedule.getLiteralValue());
    return manual(WORKERS.cron);
};
const TEST_MODULES = { node: "node:test", bun: "bun:test", workers: "vitest" };
const IGNORED_OPTIONS = new Set(["sanitizeOps", "sanitizeResources", "sanitizeExit", "permissions"]);
function fromDefinition(ctx, def, name, fn) {
    if (!Node.isObjectLiteralExpression(def))
        return "Deno.test options must be an object literal to be rewritten";
    let parts = { name, fn };
    const dropped = [];
    for (const prop of def.getProperties()) {
        if (!Node.isPropertyAssignment(prop) && !Node.isMethodDeclaration(prop))
            return "Deno.test definition uses spread or shorthand properties";
        const key = prop.getName();
        const init = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
        if (key === "fn" && Node.isMethodDeclaration(prop))
            return "Deno.test `fn` written as a method; use `fn: async () => {}`";
        if (!init)
            return `Deno.test option "${key}" is not a simple value`;
        if (key === "name")
            parts = { ...parts, name: ctx.text(init) };
        else if (key === "fn")
            parts = { ...parts, fn: init };
        else if (key === "ignore")
            parts = { ...parts, skip: ctx.text(init) };
        else if (key === "only")
            parts = { ...parts, only: ctx.text(init) };
        else if (IGNORED_OPTIONS.has(key))
            dropped.push(key);
        else
            return `Deno.test option "${key}" has no equivalent`;
    }
    if (!parts.name || !parts.fn)
        return "Deno.test definition without a name and fn";
    return { name: parts.name, fn: parts.fn, skip: parts.skip, only: parts.only, dropped };
}
function testParts(ctx) {
    const [a, b, c] = ctx.args;
    if (ctx.args.length === 3 && a && b && c)
        return fromDefinition(ctx, b, ctx.text(a), c);
    if (ctx.args.length === 2 && a && b) {
        return Node.isObjectLiteralExpression(b) ? "Deno.test(fn, options) is not supported" : { name: ctx.text(a), fn: b, dropped: [] };
    }
    if (ctx.args.length === 1 && a) {
        if (Node.isObjectLiteralExpression(a))
            return fromDefinition(ctx, a);
        if (Node.isFunctionExpression(a) && a.getName())
            return { name: JSON.stringify(a.getName()), fn: a, dropped: [] };
        if (Node.isIdentifier(a))
            return { name: JSON.stringify(a.getText()), fn: a, dropped: [] };
    }
    return "unsupported Deno.test signature";
}
/** Returns the test-context parameter name and the `t.step` call sites inside the test function. */
function contextUsage(fn) {
    if (!Node.isArrowFunction(fn) && !Node.isFunctionExpression(fn))
        return { stepNames: [], otherUses: 0 };
    const param = fn.getParameters()[0];
    const nameNode = param?.getNameNode();
    if (!nameNode || !Node.isIdentifier(nameNode))
        return { stepNames: [], otherUses: param ? 1 : 0 };
    const name = nameNode.getText();
    const refs = fn.getDescendantsOfKind(SyntaxKind.Identifier).filter((id) => id !== nameNode && id.getText() === name);
    const stepNames = refs.flatMap((id) => {
        const parent = id.getParent();
        return Node.isPropertyAccessExpression(parent) && parent.getExpression() === id && parent.getName() === "step"
            ? [parent.getNameNode()]
            : [];
    });
    return { param: name, stepNames, otherUses: refs.length - stepNames.length };
}
function buildTest(ctx, variant) {
    const parts = testParts(ctx);
    if (typeof parts === "string")
        return manual(parts);
    const options = [parts.skip && `skip: ${parts.skip}`, parts.only && `only: ${parts.only}`].filter(Boolean);
    if (options.length > 0 && ctx.target !== "node") {
        return manual("Deno.test ignore/only options: use test.skipIf(condition)(name, fn) / test.only(name, fn) by hand");
    }
    const usage = contextUsage(parts.fn);
    const usesContext = usage.stepNames.length > 0 || usage.otherUses > 0;
    const nativeSubtests = usesContext && ctx.target === "node" && usage.otherUses === 0;
    const stepEdits = nativeSubtests ? usage.stepNames.map((n) => ({ start: n.getStart(), end: n.getEnd(), text: "test" })) : [];
    const rawFnText = ctx.text(parts.fn, stepEdits);
    const fnText = usesContext && !nativeSubtests
        ? `() => (${rawFnText})(${ctx.shim("test", "testContext")}(${parts.name}))`
        : rawFnText;
    const test = ctx.named(TEST_MODULES[ctx.target], "test");
    if (ctx.target === "workers")
        ctx.dependency({ name: "vitest", spec: VITEST_VERSION, dev: true });
    const optionsText = options.length > 0 ? `{ ${options.join(", ")} }, ` : "";
    const notes = [
        parts.dropped.length > 0 ? `dropped Deno-only options: ${parts.dropped.join(", ")}` : undefined,
        nativeSubtests ? "t.step → t.test (node:test subtests)" : undefined,
        usesContext && !nativeSubtests ? "test context provided by lifeboat-shim/test.ts (steps run inline)" : undefined,
        variant === ".only" && ctx.target === "node" ? "node:test needs `--test-only` for test.only" : undefined,
    ].filter((n) => n !== undefined);
    return {
        text: `${test}${variant}(${parts.name}, ${optionsText}${fnText})`,
        ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
    };
}
const testHandler = (variant) => (ctx) => buildTest(ctx, variant);
export const cronAndTestRules = [
    { path: "cron", kind: "call", category: "cron", targets: { node: nodeCron, bun: nodeCron, workers: workersCron } },
    { path: "test", kind: "call", category: "test", targets: { node: testHandler(""), bun: testHandler(""), workers: testHandler("") } },
    { path: "test.ignore", kind: "call", category: "test", targets: { node: testHandler(".skip"), bun: testHandler(".skip"), workers: testHandler(".skip") } },
    { path: "test.only", kind: "call", category: "test", targets: { node: testHandler(".only"), bun: testHandler(".only"), workers: testHandler(".only") } },
    { path: "bench", kind: "call", category: "test", targets: { node: NODE.bench, bun: NODE.bench, workers: NODE.bench } },
];
