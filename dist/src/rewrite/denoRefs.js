import { Node, SyntaxKind } from "ts-morph";
import { findRule } from "../apis/index.js";
const DECLARATION_CHECKS = [
    (p, id) => Node.isVariableDeclaration(p) && p.getNameNode() === id,
    (p, id) => Node.isParameterDeclaration(p) && p.getNameNode() === id,
    (p, id) => Node.isFunctionDeclaration(p) && p.getNameNode() === id,
    (p, id) => Node.isClassDeclaration(p) && p.getNameNode() === id,
    (p) => Node.isImportSpecifier(p) || Node.isImportClause(p) || Node.isNamespaceImport(p),
    (p, id) => Node.isBindingElement(p) && p.getNameNode() === id,
];
/** True when the file declares its own `Deno` binding (then `Deno.*` is not the runtime global). */
export function shadowsDeno(file) {
    return file
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some((id) => id.getText() === "Deno" && DECLARATION_CHECKS.some((check) => { const p = id.getParent(); return p !== undefined && check(p, id); }));
}
function qualifiedText(node) {
    let top = node;
    while (Node.isQualifiedName(top.getParent()))
        top = top.getParentOrThrow();
    return top.getText();
}
function matchChain(first) {
    const nodes = [];
    const names = [];
    for (let cur = first; Node.isPropertyAccessExpression(cur);) {
        nodes.push(cur);
        names.push(cur.getName());
        const parent = cur.getParent();
        cur = Node.isPropertyAccessExpression(parent) && parent.getExpression() === cur ? parent : undefined;
    }
    for (let length = names.length; length > 0; length--) {
        const path = names.slice(0, length).join(".");
        const rule = findRule(path);
        const node = nodes[length - 1];
        if (!rule)
            continue;
        if (rule.kind === "value")
            return { kind: "api", rule, node, api: `Deno.${path}` };
        const call = node.getParent();
        if (Node.isCallExpression(call) && call.getExpression() === node)
            return { kind: "api", rule, node: call, api: `Deno.${path}` };
    }
    return { kind: "unmapped", node: nodes.at(-1) ?? first, api: `Deno.${names.join(".")}` };
}
const BARE_PARENTS = new Set([
    SyntaxKind.VariableDeclaration,
    SyntaxKind.CallExpression,
    SyntaxKind.ShorthandPropertyAssignment,
    SyntaxKind.SpreadElement,
    SyntaxKind.ArrayLiteralExpression,
    SyntaxKind.ReturnStatement,
    SyntaxKind.PropertyAssignment,
    SyntaxKind.BinaryExpression,
    SyntaxKind.ElementAccessExpression,
]);
/** Every reference to the `Deno` global in a file, classified. */
export function findDenoRefs(file) {
    const refs = [];
    for (const id of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
        if (id.getText() !== "Deno")
            continue;
        const parent = id.getParent();
        if (!parent)
            continue;
        if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === id)
            refs.push(matchChain(parent));
        else if (Node.isQualifiedName(parent) && parent.getLeft() === id)
            refs.push({ kind: "type", node: parent, api: qualifiedText(parent) });
        else if (Node.isTypeOfExpression(parent))
            refs.push({ kind: "detect", node: parent });
        else if (Node.isPropertyAssignment(parent) && parent.getNameNode() === id)
            continue;
        else if (BARE_PARENTS.has(parent.getKind()))
            refs.push({ kind: "bare", node: id });
    }
    return refs;
}
