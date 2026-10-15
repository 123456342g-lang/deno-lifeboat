import { Node } from "ts-morph";
export function manual(message) {
    return { manual: message };
}
export function isManual(outcome) {
    return "manual" in outcome;
}
export function nodeAndBun(handler, workers) {
    return { node: handler, bun: handler, workers };
}
export function allTargets(handler) {
    return { node: handler, bun: handler, workers: handler };
}
/** Wraps an assignment/delete expression in parens unless it is a statement on its own (avoids ASI hazards). */
export function asExpression(ctx, text) {
    return ctx.isStatement ? text : `(${text})`;
}
/** Wraps `text` in parens unless `node`'s position already delimits it (if/while condition, parens, argument, initializer). */
export function parenthesize(node, text) {
    const parent = node.getParent();
    const delimited = Node.isParenthesizedExpression(parent) ||
        Node.isIfStatement(parent) ||
        Node.isWhileStatement(parent) ||
        Node.isReturnStatement(parent) ||
        Node.isVariableDeclaration(parent) ||
        Node.isPropertyAssignment(parent) ||
        (Node.isCallExpression(parent) && parent.getArguments().includes(node));
    return delimited ? text : `(${text})`;
}
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** `process.env.NAME` for string-literal identifier keys, `process.env[expr]` otherwise. */
export function envAccess(argNode, argText) {
    if (argNode && Node.isStringLiteral(argNode) && IDENTIFIER_RE.test(argNode.getLiteralValue())) {
        return `process.env.${argNode.getLiteralValue()}`;
    }
    return `process.env[${argText}]`;
}
export function withArity(min, max, handler) {
    return (ctx) => ctx.args.length < min || ctx.args.length > max
        ? manual(`called with ${ctx.args.length} argument(s); lifeboat only rewrites ${min === max ? min : `${min}–${max}`}`)
        : handler(ctx);
}
