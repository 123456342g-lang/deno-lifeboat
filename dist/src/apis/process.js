import { WORKERS } from "./guidance.js";
import { allTargets, asExpression, envAccess, nodeAndBun, withArity } from "./types.js";
const workersEnv = (handler) => (ctx) => {
    const outcome = handler(ctx);
    return "text" in outcome ? { ...outcome, note: "Workers: needs the nodejs_compat flag (set in the generated wrangler.jsonc)" } : outcome;
};
const envGet = withArity(1, 1, (ctx) => ({ text: envAccess(ctx.args[0], ctx.arg(0)) }));
const envSet = withArity(2, 2, (ctx) => ({ text: asExpression(ctx, `${envAccess(ctx.args[0], ctx.arg(0))} = ${ctx.arg(1)}`) }));
const envDelete = withArity(1, 1, (ctx) => ({ text: asExpression(ctx, `delete ${envAccess(ctx.args[0], ctx.arg(0))}`) }));
const envHas = withArity(1, 1, (ctx) => ({ text: `Object.hasOwn(process.env, ${ctx.arg(0)})` }));
const envToObject = withArity(0, 0, () => ({ text: "Object.assign({}, process.env)" }));
const processCall = (name) => (ctx) => ({ text: `process.${name}(${ctx.allArgs()})` });
const processValue = (expr) => () => ({ text: expr });
const osCall = (name) => (ctx) => ({ text: `${ctx.named("node:os", name)}(${ctx.allArgs()})` });
export const processRules = [
    { path: "env.get", kind: "call", category: "env", targets: { node: envGet, bun: envGet, workers: workersEnv(envGet) } },
    { path: "env.has", kind: "call", category: "env", targets: { node: envHas, bun: envHas, workers: workersEnv(envHas) } },
    { path: "env.toObject", kind: "call", category: "env", targets: { node: envToObject, bun: envToObject, workers: workersEnv(envToObject) } },
    { path: "env.set", kind: "call", category: "env", targets: nodeAndBun(envSet, WORKERS.env) },
    { path: "env.delete", kind: "call", category: "env", targets: nodeAndBun(envDelete, WORKERS.env) },
    { path: "env", kind: "value", category: "env", targets: allTargets("Deno.env used as a value: replace with process.env (a plain object, not get/set methods)") },
    { path: "args", kind: "value", category: "process", targets: nodeAndBun(processValue("process.argv.slice(2)"), WORKERS.noProcess) },
    { path: "exit", kind: "call", category: "process", targets: nodeAndBun(processCall("exit"), WORKERS.noProcess) },
    { path: "exitCode", kind: "value", category: "process", targets: nodeAndBun(processValue("process.exitCode"), WORKERS.noProcess) },
    { path: "cwd", kind: "call", category: "process", targets: nodeAndBun(processCall("cwd"), WORKERS.noProcess) },
    { path: "chdir", kind: "call", category: "process", targets: nodeAndBun(processCall("chdir"), WORKERS.noProcess) },
    { path: "pid", kind: "value", category: "process", targets: nodeAndBun(processValue("process.pid"), WORKERS.noProcess) },
    { path: "ppid", kind: "value", category: "process", targets: nodeAndBun(processValue("process.ppid"), WORKERS.noProcess) },
    { path: "execPath", kind: "call", category: "process", targets: nodeAndBun(withArity(0, 0, processValue("process.execPath")), WORKERS.noProcess) },
    { path: "memoryUsage", kind: "call", category: "process", targets: nodeAndBun(processCall("memoryUsage"), WORKERS.noProcess) },
    { path: "kill", kind: "call", category: "process", targets: nodeAndBun(processCall("kill"), WORKERS.noProcess) },
    { path: "addSignalListener", kind: "call", category: "process", targets: nodeAndBun(withArity(2, 2, processCall("on")), WORKERS.noProcess) },
    { path: "removeSignalListener", kind: "call", category: "process", targets: nodeAndBun(withArity(2, 2, processCall("off")), WORKERS.noProcess) },
    { path: "uid", kind: "call", category: "process", targets: nodeAndBun(withArity(0, 0, processValue("(process.getuid?.() ?? null)")), WORKERS.noProcess) },
    { path: "gid", kind: "call", category: "process", targets: nodeAndBun(withArity(0, 0, processValue("(process.getgid?.() ?? null)")), WORKERS.noProcess) },
    {
        path: "noColor",
        kind: "value",
        category: "process",
        targets: nodeAndBun(processValue("(process.env.NO_COLOR !== undefined)"), WORKERS.noProcess),
    },
    {
        path: "mainModule",
        kind: "value",
        category: "process",
        targets: nodeAndBun((ctx) => ({ text: `${ctx.named("node:url", "pathToFileURL")}(process.argv[1] ?? "").href` }), WORKERS.noProcess),
    },
    {
        path: "consoleSize",
        kind: "call",
        category: "process",
        targets: nodeAndBun(withArity(0, 0, () => ({ text: "({ columns: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 })" })), WORKERS.noProcess),
    },
    { path: "isatty", kind: "call", category: "process", targets: nodeAndBun(withArity(1, 1, (ctx) => ({ text: `${ctx.named("node:tty", "isatty")}(${ctx.arg(0)})` })), WORKERS.noProcess) },
    { path: "hostname", kind: "call", category: "runtime", targets: nodeAndBun(withArity(0, 0, osCall("hostname")), WORKERS.noProcess) },
    { path: "osRelease", kind: "call", category: "runtime", targets: nodeAndBun(withArity(0, 0, osCall("release")), WORKERS.noProcess) },
    { path: "osUptime", kind: "call", category: "runtime", targets: nodeAndBun(withArity(0, 0, osCall("uptime")), WORKERS.noProcess) },
    { path: "loadavg", kind: "call", category: "runtime", targets: nodeAndBun(withArity(0, 0, osCall("loadavg")), WORKERS.noProcess) },
    {
        path: "inspect",
        kind: "call",
        category: "runtime",
        targets: allTargets(withArity(1, 2, (ctx) => ({ text: `${ctx.named("node:util", "inspect")}(${ctx.allArgs()})` }))),
    },
    {
        path: "build",
        kind: "value",
        category: "runtime",
        targets: nodeAndBun((ctx) => ({ text: ctx.shim("build", "build") }), "Deno.build on Workers: there is no OS/arch to detect; remove the branch"),
    },
];
