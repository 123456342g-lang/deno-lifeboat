import { Node } from "ts-morph";
import { KV, NODE, WORKERS } from "./guidance.js";
import { own } from "../own.js";
import { manual, parenthesize } from "./types.js";
const ERROR_CODES = {
    NotFound: "ENOENT",
    AlreadyExists: "EEXIST",
    PermissionDenied: "EACCES",
    IsADirectory: "EISDIR",
    NotADirectory: "ENOTDIR",
    ConnectionRefused: "ECONNREFUSED",
    ConnectionReset: "ECONNRESET",
    AddrInUse: "EADDRINUSE",
    TimedOut: "ETIMEDOUT",
    BrokenPipe: "EPIPE",
};
/** `err instanceof Deno.errors.NotFound` → `err?.code === "ENOENT"`; other uses of Deno.errors are flagged. */
const errorsHandler = (ctx) => {
    const access = ctx.node.getParent();
    if (!Node.isPropertyAccessExpression(access) || access.getExpression() !== ctx.node)
        return manual(NODE.errors);
    const code = own(ERROR_CODES, access.getName());
    const binary = access.getParent();
    if (!code || !Node.isBinaryExpression(binary) || binary.getRight() !== access || binary.getOperatorToken().getText() !== "instanceof") {
        return manual(NODE.errors);
    }
    const subject = ctx.text(binary.getLeft());
    const typed = ctx.isTs ? `(${subject} as { code?: unknown } | null | undefined)` : subject;
    return { text: parenthesize(binary, `${typed}?.code === "${code}"`), replace: binary };
};
function flag(path, category, node, workers, bun = node) {
    return { path, kind: "value", category, targets: { node, bun, workers } };
}
export const flaggedRules = [
    flag("openKv", "kv", KV.openKvNode, KV.openKvWorkers, KV.openKvBun),
    flag("Command", "subprocess", NODE.subprocess, WORKERS.subprocess),
    flag("run", "subprocess", NODE.subprocess, WORKERS.subprocess),
    flag("connect", "net", NODE.net, WORKERS.net),
    flag("connectTls", "net", NODE.net, WORKERS.net),
    flag("listen", "net", NODE.net, WORKERS.net),
    flag("listenTls", "net", NODE.net, WORKERS.net),
    flag("listenDatagram", "net", NODE.net, WORKERS.net),
    flag("startTls", "net", NODE.net, WORKERS.net),
    flag("resolveDns", "net", "Deno.resolveDns → resolve()/resolve4()/resolveTxt() from node:dns/promises", "use DNS over HTTPS (fetch https://cloudflare-dns.com/dns-query)"),
    flag("upgradeWebSocket", "deploy", NODE.websocket, WORKERS.websocket),
    flag("serveHttp", "serve", NODE.serveHttp, NODE.serveHttp),
    flag("permissions", "permissions", NODE.permissions, NODE.permissions),
    flag("stdin", "process", NODE.stdio, WORKERS.noProcess),
    flag("stdout", "process", NODE.stdio, WORKERS.noProcess),
    flag("stderr", "process", NODE.stdio, WORKERS.noProcess),
    flag("version", "runtime", NODE.version, NODE.version),
    flag("errors", "errors", errorsHandler, NODE.errors, errorsHandler),
];
