import { Node } from "ts-morph";
import { WORKERS } from "./guidance.js";
import { manual, type ApiRule, type Handler, type RewriteContext } from "./types.js";

const nodeServe: Handler = (ctx) => {
  if (ctx.args.length < 1 || ctx.args.length > 2) return manual("Deno.serve called with an unexpected number of arguments");
  return { text: `${ctx.shim("serve", "serve")}(${ctx.allArgs()})` };
};

/** Finds the handler expression in `Deno.serve(handler)`, `Deno.serve(opts, handler)` or `Deno.serve({ handler })`. */
function handlerText(ctx: RewriteContext): string | undefined {
  const [first, second] = ctx.args;
  if (second !== undefined) return ctx.arg(1);
  if (first === undefined) return undefined;
  if (!Node.isObjectLiteralExpression(first)) return ctx.arg(0);
  const prop = first.getProperty("handler");
  if (Node.isShorthandPropertyAssignment(prop)) return "handler";
  const init = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
  return init ? ctx.text(init) : undefined;
}

const workersServe: Handler = (ctx) => {
  const statement = ctx.node.getParent();
  const atTopLevel = ctx.isStatement && statement !== undefined && Node.isSourceFile(statement.getParent());
  if (!atTopLevel) {
    return manual(`${WORKERS.serve}. lifeboat only rewrites a top-level \`Deno.serve(...)\` statement`);
  }
  const handler = handlerText(ctx);
  if (handler === undefined) return manual(WORKERS.serve);
  const usesOptions = ctx.args.length === 2 || (ctx.args.length === 1 && Node.isObjectLiteralExpression(ctx.args[0]));
  return {
    text: `export default { fetch: ${handler} };`,
    replace: statement,
    note: usesOptions
      ? "Deno.serve options (port, hostname, onListen, onError) were dropped; Workers ignore them"
      : "Workers call fetch(request, env, ctx): if the handler reads its second `info` argument (remoteAddr), use request.headers.get(\"cf-connecting-ip\")",
  };
};

export const serveRules: readonly ApiRule[] = [
  { path: "serve", kind: "call", category: "serve", targets: { node: nodeServe, bun: nodeServe, workers: workersServe } },
];
