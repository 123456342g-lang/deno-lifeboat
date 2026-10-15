import path from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import { isManual, KV } from "../apis/index.js";
import { VITEST_VERSION } from "../apis/cronAndTest.js";
import { parenthesize } from "../apis/types.js";
import { isStdHttpServer, mapSpecifier, resolveImportMap, toRelativeImport } from "../imports.js";
import { EditSet } from "./editSet.js";
import { erasableSyntaxEdits } from "./erasable.js";
import { findDenoRefs, shadowsDeno } from "./denoRefs.js";
import { own } from "../own.js";
import { ImportManager } from "./importManager.js";
import { isStdBdd, rewriteStdBddImport } from "./stdTesting.js";
import { typeOnlyImportFixes } from "./typeImports.js";
export const SHIM_DIR = "lifeboat-shim";
export const TODO_MARK = "lifeboat: TODO";
const KV_METHODS = {
    atomic: { guidance: KV.atomic, nodeStatus: "info" },
    enqueue: { guidance: KV.enqueue, nodeStatus: "manual" },
    listenQueue: { guidance: KV.enqueue, nodeStatus: "manual" },
    watch: { guidance: KV.watch, nodeStatus: "info" },
};
const KV_MARKERS = /\bDeno\.(openKv|Kv|AtomicOperation|KvKey)\b|["']@deno\/kv["']/;
class FileRewrite {
    file;
    options;
    edits;
    imports;
    findings = [];
    dependencies = [];
    shims = new Set();
    cronTriggers = [];
    todoLines = new Set();
    servesHttp = false;
    relative;
    isTs;
    constructor(file, options) {
        this.file = file;
        this.options = options;
        this.edits = new EditSet(file.getFullText());
        this.imports = new ImportManager(file);
        this.relative = path.relative(options.root, file.getFilePath()).split(path.sep).join("/");
        this.isTs = /\.(ts|tsx|mts)$/.test(file.getFilePath());
    }
    get text() {
        return this.file.getFullText();
    }
    finding(node, api, category, status, message) {
        const { line, column } = this.file.getLineAndColumnAtPos(node.getStart());
        this.findings.push({ file: this.relative, line, column, api, category, status, message });
        if (status === "manual" && this.options.emitTodos)
            this.todo(node, api, message);
    }
    /** Inserts `// lifeboat: TODO(api) message` above the statement containing `node`. */
    todo(node, api, message) {
        const isClassMember = (a) => {
            const parent = a.getParent();
            return parent !== undefined && (Node.isClassDeclaration(parent) || Node.isClassExpression(parent));
        };
        const anchor = node.getFirstAncestor((a) => Node.isStatement(a) || isClassMember(a)) ?? node;
        const pos = anchor.getStart();
        const lineStart = this.text.lastIndexOf("\n", pos - 1) + 1;
        const indent = this.text.slice(lineStart, pos);
        const dedupe = `${lineStart}:${api}`;
        if (this.todoLines.has(dedupe))
            return;
        this.todoLines.add(dedupe);
        const previousLine = this.text.slice(this.text.lastIndexOf("\n", lineStart - 2) + 1, lineStart);
        if (previousLine.includes(`${TODO_MARK}(${api})`))
            return;
        const oneLine = message.replace(/\s+/g, " ").replaceAll("*/", "* /");
        if (/^\s*$/.test(indent)) {
            this.edits.add({ start: lineStart, end: lineStart, text: `${indent}// ${TODO_MARK}(${api}) ${oneLine}\n` });
        }
        else {
            this.edits.add({ start: pos, end: pos, text: `/* ${TODO_MARK}(${api}) ${oneLine} */ ` });
        }
    }
    shimSpecifier(shim) {
        return toRelativeImport(this.file.getFilePath(), path.join(this.options.root, SHIM_DIR, `${shim}.ts`));
    }
    context(node, args) {
        const text = (n, extra = []) => this.edits.textOf(n.getStart(), n.getEnd(), extra);
        return {
            target: this.options.target,
            node,
            args,
            isStatement: Node.isExpressionStatement(node.getParent()),
            isTs: this.isTs,
            arg: (index, extra) => {
                const arg = args[index];
                if (!arg)
                    throw new Error(`lifeboat: missing argument ${index}`);
                return text(arg, extra);
            },
            text,
            allArgs: () => args.map((a) => text(a)).join(", "),
            named: (module, name) => this.imports.named(module, name),
            shim: (shim, name) => {
                this.shims.add(shim);
                return this.imports.named(this.shimSpecifier(shim), name);
            },
            dependency: (dep) => void this.dependencies.push(dep),
            cronTrigger: (schedule) => void this.cronTriggers.push(schedule),
        };
    }
    applyApi(ref) {
        const action = ref.rule.targets[this.options.target];
        if (typeof action === "string") {
            this.finding(ref.node, ref.api, ref.rule.category, "manual", action);
            return;
        }
        const args = Node.isCallExpression(ref.node) ? ref.node.getArguments() : [];
        let outcome = { manual: "" };
        const rollbackImports = this.imports.checkpoint();
        const shimsBefore = new Set(this.shims);
        const depsBefore = this.dependencies.length;
        this.edits.transaction(() => {
            outcome = action(this.context(ref.node, args));
            return !isManual(outcome);
        });
        if (isManual(outcome)) {
            rollbackImports();
            for (const shim of [...this.shims])
                if (!shimsBefore.has(shim))
                    this.shims.delete(shim);
            this.dependencies.splice(depsBefore);
            this.finding(ref.node, ref.api, ref.rule.category, "manual", outcome.manual);
            return;
        }
        const replaced = outcome.replace ?? ref.node;
        this.edits.add({ start: replaced.getStart(), end: replaced.getEnd(), text: outcome.text });
        if (ref.rule.category === "serve")
            this.servesHttp = true;
        this.finding(ref.node, ref.api, ref.rule.category, "auto", outcome.note ? `→ ${outcome.text.split("\n")[0]} (${outcome.note})` : `→ ${firstLine(outcome.text)}`);
    }
}
function firstLine(text) {
    const line = text.split("\n")[0] ?? "";
    return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}
function rewriteDenoRefs(rw) {
    if (shadowsDeno(rw.file)) {
        rw.finding(rw.file, "Deno", "runtime", "info", "file declares its own `Deno` binding; Deno.* references left untouched");
        return;
    }
    const refs = findDenoRefs(rw.file).sort((a, b) => a.node.getWidth() - b.node.getWidth());
    for (const ref of refs) {
        switch (ref.kind) {
            case "api":
                rw.applyApi(ref);
                break;
            case "unmapped":
                rw.finding(ref.node, ref.api, "runtime", "manual", `${ref.api} has no mapping yet; port it by hand (PRs adding it to src/apis welcome)`);
                break;
            case "type":
                rw.finding(ref.node, ref.api, "runtime", "type", "type-only reference to the Deno namespace; replace with a Node/web type (no runtime effect)");
                break;
            case "detect":
                rw.finding(ref.node, "typeof Deno", "runtime", "info", "runtime detection; keeps working (Deno is undefined outside Deno)");
                break;
            case "bare":
                rw.finding(ref.node, "Deno", "runtime", "manual", "the Deno namespace is used as a value; rewrite this usage by hand");
                break;
            default: {
                const exhaustive = ref;
                throw new Error(`unhandled ref ${String(exhaustive)}`);
            }
        }
    }
}
function moduleSpecifierLiterals(file) {
    const literals = [];
    for (const decl of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
        const spec = decl.getModuleSpecifier();
        if (spec && Node.isStringLiteral(spec))
            literals.push(spec);
    }
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const arg = call.getArguments()[0];
        if (call.getExpression().getKind() === SyntaxKind.ImportKeyword && arg && Node.isStringLiteral(arg))
            literals.push(arg);
    }
    return literals;
}
const STD_SERVER_EXPORTS = {
    serve: { name: "serveStd", type: false },
    Handler: { name: "ServeHandler", type: true },
    ConnInfo: { name: "ServeHandlerInfo", type: true },
};
/** Rewrites `import { serve } from "https://deno.land/std@x/http/server.ts"` to the serve shim. Returns false if it can't. */
function rewriteStdHttpServer(rw, decl) {
    if (rw.options.target === "workers" || decl.getDefaultImport() || decl.getNamespaceImport())
        return false;
    const named = decl.getNamedImports();
    if (named.length === 0 || !named.every((spec) => own(STD_SERVER_EXPORTS, spec.getName())))
        return false;
    const parts = named.map((spec) => {
        const mapped = own(STD_SERVER_EXPORTS, spec.getName());
        const local = spec.getAliasNode()?.getText() ?? spec.getName();
        const typed = mapped.type || spec.isTypeOnly() || decl.isTypeOnly();
        return `${typed && !decl.isTypeOnly() ? "type " : ""}${mapped.name}${local === mapped.name ? "" : ` as ${local}`}`;
    });
    if (named.some((spec) => spec.getName() === "serve"))
        rw.shims.add("serve");
    const prefix = decl.isTypeOnly() ? "import type" : "import";
    rw.edits.add({ start: decl.getStart(), end: decl.getEnd(), text: `${prefix} { ${parts.join(", ")} } from "${rw.shimSpecifier("serve")}";` });
    rw.servesHttp ||= named.some((spec) => spec.getName() === "serve");
    rw.finding(decl, decl.getModuleSpecifierValue(), "import", "auto", "→ lifeboat-shim/serve.ts (std serve(handler, options) compatible)");
    return true;
}
function rewriteStdBdd(rw, decl) {
    const result = rewriteStdBddImport(decl, rw.options.target);
    if ("manual" in result) {
        rw.finding(decl, "@std/testing/bdd", "test", "manual", `@std/testing/bdd runs on Deno.test; ${result.manual}`);
        return false;
    }
    if (rw.options.target === "workers")
        rw.dependencies.push({ name: "vitest", spec: VITEST_VERSION, dev: true });
    rw.edits.add({ start: decl.getStart(), end: decl.getEnd(), text: result.text });
    rw.finding(decl, "@std/testing/bdd", "test", "auto", `→ "${result.module}" (@std/testing/bdd registers suites via Deno.test)`);
    return true;
}
function rewriteSpecifiers(rw) {
    const handled = new Set();
    for (const decl of rw.file.getImportDeclarations()) {
        const value = decl.getModuleSpecifierValue();
        if (isStdHttpServer(value) && rewriteStdHttpServer(rw, decl))
            handled.add(decl.getModuleSpecifier());
        if (isStdBdd(resolveImportMap(value, rw.options.importMap) ?? value) && rewriteStdBdd(rw, decl))
            handled.add(decl.getModuleSpecifier());
    }
    for (const literal of moduleSpecifierLiterals(rw.file)) {
        if (handled.has(literal))
            continue;
        const value = literal.getLiteralValue();
        const mapping = mapSpecifier(value, { importMap: rw.options.importMap, fromFile: rw.file.getFilePath() });
        if (mapping.kind === "unchanged")
            continue;
        if (mapping.kind === "manual") {
            rw.finding(literal, value, "import", "manual", mapping.reason);
            continue;
        }
        rw.dependencies.push(...mapping.deps);
        if (mapping.specifier !== value) {
            const quote = literal.getText()[0] ?? '"';
            rw.edits.add({ start: literal.getStart(), end: literal.getEnd(), text: `${quote}${mapping.specifier}${quote}` });
        }
        const message = mapping.specifier === value ? "resolved via import map; added to package.json" : `→ "${mapping.specifier}"`;
        rw.finding(literal, value, "import", "auto", mapping.note ? `${message} (${mapping.note})` : message);
    }
    for (const decl of rw.file.getImportDeclarations()) {
        for (const range of decl.getLeadingCommentRanges()) {
            if (!/^\/\/\s*@deno-types\s*=/.test(range.getText()))
                continue;
            const end = rw.text[range.getEnd()] === "\n" ? range.getEnd() + 1 : range.getEnd();
            rw.edits.add({ start: range.getPos(), end, text: "" });
            rw.finding(decl, "@deno-types", "import", "auto", "removed `// @deno-types` hint (install @types/* or rely on the package's own types)");
        }
    }
}
const SHEBANGS = {
    node: "#!/usr/bin/env node",
    bun: "#!/usr/bin/env bun",
    workers: undefined,
};
function rewriteHeader(rw) {
    const text = rw.text;
    const newline = text.indexOf("\n");
    const end = newline === -1 ? text.length : newline;
    if (text.startsWith("#!") && text.slice(0, end).includes("deno")) {
        const replacement = SHEBANGS[rw.options.target];
        if (replacement) {
            rw.edits.add({ start: 0, end, text: replacement });
            rw.findings.push({ file: rw.relative, line: 1, column: 1, api: "#!deno", category: "syntax", status: "auto", message: `→ ${replacement}` });
        }
        else {
            rw.findings.push({ file: rw.relative, line: 1, column: 1, api: "#!deno", category: "syntax", status: "info", message: "Workers modules have no shebang; remove it" });
        }
    }
    const firstStatement = rw.file.getStatements()[0];
    const headerEnd = firstStatement ? firstStatement.getStart(true) : text.length;
    const libRef = /^\/\/\/\s*<reference\s+lib\s*=\s*["']deno\.[^"']*["']\s*\/>[^\n]*\n?/gm;
    for (const match of text.slice(0, headerEnd).matchAll(libRef)) {
        const start = match.index;
        rw.edits.add({ start, end: start + match[0].length, text: "" });
        const line = text.slice(0, start).split("\n").length;
        rw.findings.push({ file: rw.relative, line, column: 1, api: "/// <reference lib=\"deno.*\">", category: "syntax", status: "auto", message: "removed Deno lib reference" });
    }
}
function rewriteImportMetaMain(rw) {
    for (const access of rw.file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
        if (access.getName() !== "main" || !Node.isMetaProperty(access.getExpression()))
            continue;
        if (access.getExpression().getText() !== "import.meta")
            continue;
        const target = rw.options.target;
        if (target === "bun")
            continue;
        if (target === "workers") {
            rw.finding(access, "import.meta.main", "runtime", "manual", "Workers have no entry-point script; remove the `import.meta.main` guard and export the handler");
            continue;
        }
        const pathToFileURL = rw.imports.named("node:url", "pathToFileURL");
        const replacement = parenthesize(access, `import.meta.url === ${pathToFileURL}(process.argv[1] ?? "").href`);
        rw.edits.add({ start: access.getStart(), end: access.getEnd(), text: replacement });
        rw.finding(access, "import.meta.main", "runtime", "auto", "→ import.meta.url === pathToFileURL(process.argv[1]).href (import.meta.main needs Node ≥ 24.2)");
    }
}
function flagKvCalls(rw) {
    if (!KV_MARKERS.test(rw.text))
        return;
    for (const call of rw.file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (!Node.isPropertyAccessExpression(callee))
            continue;
        const method = own(KV_METHODS, callee.getName());
        if (!method)
            continue;
        if (callee.getName() === "watch" && !/kv|db|store/i.test(callee.getExpression().getText()))
            continue;
        const status = rw.options.target === "workers" ? "manual" : method.nodeStatus;
        rw.finding(call, `kv.${callee.getName()}()`, "kv", status, method.guidance);
    }
}
const DEPLOY_ENV_VARS = new Set(["DENO_DEPLOYMENT_ID", "DENO_REGION"]);
function flagDeployFeatures(rw) {
    const broadcastGuidance = rw.options.target === "workers"
        ? "BroadcastChannel: Deno Deploy delivered messages across isolates and regions; on Workers coordinate through a Durable Object (or Queues)"
        : "BroadcastChannel: Deno Deploy delivered messages across isolates and regions; on Node/Bun it only reaches threads in the same process. Use Redis pub/sub, Postgres LISTEN/NOTIFY or similar for cross-instance messaging";
    for (const expr of rw.file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        if (expr.getExpression().getText() === "BroadcastChannel")
            rw.finding(expr, "BroadcastChannel", "deploy", "manual", broadcastGuidance);
    }
    for (const literal of rw.file.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
        if (DEPLOY_ENV_VARS.has(literal.getLiteralValue())) {
            rw.finding(literal, literal.getLiteralValue(), "deploy", "info", "Deno Deploy-only environment variable; it is undefined on other hosts");
        }
    }
}
function flagNodeTypeScriptSyntax(rw) {
    if (rw.options.target !== "node" || !rw.isTs)
        return;
    const transformHint = "Node's built-in type stripping cannot run this; rewrite it as plain functions/objects or run with --experimental-transform-types / tsx";
    if (rw.file.getFilePath().endsWith(".tsx")) {
        rw.finding(rw.file, ".tsx", "syntax", "manual", "Node cannot run JSX/TSX directly: add a build step (esbuild, tsx, Vite) or use Bun");
    }
    const erasable = erasableSyntaxEdits(rw.file);
    for (const edit of erasable.edits)
        rw.edits.add(edit);
    for (const report of erasable.reports)
        rw.finding(report.node, report.api, "syntax", report.status, report.message);
    for (const node of rw.file.getDescendantsOfKind(SyntaxKind.ModuleDeclaration)) {
        const ambient = node.hasDeclareKeyword() || node.getFirstAncestor((a) => Node.isModuleDeclaration(a) && a.hasDeclareKeyword()) !== undefined;
        const typesOnly = node.getStatements().every((s) => Node.isInterfaceDeclaration(s) || Node.isTypeAliasDeclaration(s));
        if (!ambient && !typesOnly && node.getDeclarationKind() !== "global") {
            rw.finding(node, "namespace", "syntax", "manual", `TypeScript namespace: ${transformHint}`);
        }
    }
    for (const decorator of rw.file.getDescendantsOfKind(SyntaxKind.Decorator)) {
        rw.finding(decorator, "decorator", "syntax", "manual", "decorators: Node cannot run them without a build step (tsx/esbuild/tsc)");
    }
}
function fixTypeOnlyImports(rw) {
    if (rw.options.target !== "node" || !rw.isTs)
        return;
    const fix = typeOnlyImportFixes(rw.file, (specifier) => isStdHttpServer(specifier) || isStdBdd(specifier));
    for (const edit of fix.edits)
        rw.edits.add(edit);
    for (const { name, line } of fix.names) {
        rw.findings.push({ file: rw.relative, line, column: 1, api: name, category: "syntax", status: "info", message: "marked as a type-only import (Node keeps non-`type` imports at runtime)" });
    }
}
export function rewriteFile(file, options) {
    const rw = new FileRewrite(file, options);
    const original = file.getFullText();
    rewriteHeader(rw);
    rewriteImportMetaMain(rw);
    rewriteDenoRefs(rw);
    rewriteSpecifiers(rw);
    flagKvCalls(rw);
    flagDeployFeatures(rw);
    flagNodeTypeScriptSyntax(rw);
    fixTypeOnlyImports(rw);
    const block = rw.imports.render();
    if (block)
        rw.edits.add({ start: block.position, end: block.position, text: block.text });
    const output = rw.edits.apply();
    for (const dropped of rw.edits.droppedEdits) {
        const { line, column } = file.getLineAndColumnAtPos(dropped.start);
        rw.findings.push({ file: rw.relative, line, column, api: "overlap", category: "syntax", status: "manual", message: `overlapping rewrites; skipped "${firstLine(dropped.text)}"` });
    }
    return {
        file: rw.relative,
        original,
        output,
        findings: rw.findings.sort((a, b) => a.line - b.line || a.column - b.column),
        dependencies: rw.dependencies,
        shims: rw.shims,
        cronTriggers: rw.cronTriggers,
        servesHttp: rw.servesHttp,
    };
}
