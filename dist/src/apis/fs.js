import { Node, SyntaxKind } from "ts-morph";
import { NODE, WORKERS } from "./guidance.js";
import { manual, nodeAndBun, withArity } from "./types.js";
const ASYNC = "node:fs/promises";
const SYNC = "node:fs";
function moduleFor(sync) {
    return sync ? SYNC : ASYNC;
}
/** `{ append: true }` (and nothing else) → true; no options → false; anything else → undefined (can't map). */
function appendOnly(ctx, index) {
    const node = ctx.args[index];
    if (node === undefined)
        return false;
    if (!Node.isObjectLiteralExpression(node))
        return undefined;
    const props = node.getProperties();
    if (props.length === 0)
        return false;
    if (props.length !== 1)
        return undefined;
    const [prop] = props;
    if (!Node.isPropertyAssignment(prop) || prop.getName() !== "append")
        return undefined;
    return prop.getInitializerIfKind(SyntaxKind.TrueKeyword) ? true : undefined;
}
function readText(sync) {
    return withArity(1, 1, (ctx) => {
        const fn = ctx.named(moduleFor(sync), sync ? "readFileSync" : "readFile");
        return { text: `${fn}(${ctx.arg(0)}, "utf8")` };
    });
}
function passthrough(sync, nodeName, minArgs, maxArgs, note) {
    return withArity(minArgs, maxArgs, (ctx) => {
        const fn = ctx.named(moduleFor(sync), sync ? `${nodeName}Sync` : nodeName);
        return note === undefined ? { text: `${fn}(${ctx.allArgs()})` } : { text: `${fn}(${ctx.allArgs()})`, note };
    });
}
function write(sync) {
    return withArity(2, 3, (ctx) => {
        const append = appendOnly(ctx, 2);
        if (append === undefined) {
            return manual("write options other than { append: true } (create, mode, signal) are not mapped; use writeFile/appendFile from node:fs with the equivalent flags");
        }
        const name = append ? "appendFile" : "writeFile";
        const fn = ctx.named(moduleFor(sync), sync ? `${name}Sync` : name);
        return { text: `${fn}(${ctx.arg(0)}, ${ctx.arg(1)})` };
    });
}
const REMOVE_NOTE = "Deno.remove also deletes empty directories without { recursive: true }; Node's rm does not";
function remove(sync) {
    return withArity(1, 2, (ctx) => {
        const fn = ctx.named(moduleFor(sync), sync ? "rmSync" : "rm");
        return { text: `${fn}(${ctx.allArgs()})`, ...(ctx.args.length === 1 ? { note: REMOVE_NOTE } : {}) };
    });
}
function makeTempDir(sync) {
    return withArity(0, 0, (ctx) => {
        const fn = ctx.named(moduleFor(sync), sync ? "mkdtempSync" : "mkdtemp");
        const join = ctx.named("node:path", "join");
        const tmpdir = ctx.named("node:os", "tmpdir");
        return { text: `${fn}(${join}(${tmpdir}(), "tmp-"))` };
    });
}
function shimFs(name) {
    return (ctx) => ({ text: `${ctx.shim("fs", name)}(${ctx.allArgs()})` });
}
function fsRule(path, handler) {
    return { path, kind: "call", category: "fs", targets: nodeAndBun(handler, WORKERS.noFs) };
}
function pair(name, nodeName, min, max, note) {
    return [fsRule(name, passthrough(false, nodeName, min, max, note)), fsRule(`${name}Sync`, passthrough(true, nodeName, min, max, note))];
}
export const fsRules = [
    fsRule("readTextFile", readText(false)),
    fsRule("readTextFileSync", readText(true)),
    ...pair("readFile", "readFile", 1, 1),
    fsRule("writeTextFile", write(false)),
    fsRule("writeTextFileSync", write(true)),
    fsRule("writeFile", write(false)),
    fsRule("writeFileSync", write(true)),
    fsRule("remove", remove(false)),
    fsRule("removeSync", remove(true)),
    ...pair("mkdir", "mkdir", 1, 2),
    ...pair("rename", "rename", 2, 2),
    ...pair("copyFile", "copyFile", 2, 2),
    ...pair("chmod", "chmod", 2, 2),
    ...pair("chown", "chown", 3, 3),
    ...pair("truncate", "truncate", 1, 2),
    ...pair("realPath", "realpath", 1, 1),
    ...pair("readLink", "readlink", 1, 1),
    ...pair("link", "link", 2, 2),
    ...pair("symlink", "symlink", 2, 2, "on Windows pass the link type as the third argument of symlink()"),
    ...pair("utime", "utimes", 3, 3),
    fsRule("makeTempDir", makeTempDir(false)),
    fsRule("makeTempDirSync", makeTempDir(true)),
    fsRule("readDir", shimFs("readDir")),
    fsRule("readDirSync", shimFs("readDirSync")),
    fsRule("stat", shimFs("stat")),
    fsRule("statSync", shimFs("statSync")),
    fsRule("lstat", shimFs("lstat")),
    fsRule("lstatSync", shimFs("lstatSync")),
    ...["open", "openSync", "create", "createSync"].map((path) => fsRule(path, () => manual(NODE.fileHandle))),
    fsRule("watchFs", () => manual(NODE.watchFs)),
];
