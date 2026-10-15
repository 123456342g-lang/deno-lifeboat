import { Node, SyntaxKind } from "ts-morph";
const TRANSFORM_HINT = "Node's built-in type stripping cannot run this; rewrite it by hand or run with --experimental-transform-types / tsx";
function indentOf(text, pos) {
    const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
    return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? "";
}
function propertyNames(ctor) {
    return ctor.getParameters().filter((p) => p.isParameterProperty()).map((p) => p.getName());
}
function initializersUse(ctor, names) {
    const cls = ctor.getParent();
    if (!Node.isClassDeclaration(cls) && !Node.isClassExpression(cls))
        return true;
    return cls.getProperties().some((prop) => {
        const init = prop.getInitializer();
        return init !== undefined && names.some((name) => new RegExp(`\\bthis\\.${name}\\b`).test(init.getText()));
    });
}
function rewriteParameterProperties(ctor, text) {
    const body = ctor.getBody();
    if (!body || !Node.isBlock(body))
        return "constructor without a body";
    const params = ctor.getParameters().filter((p) => p.isParameterProperty());
    if (params.some((p) => p.getDecorators().length > 0 || !Node.isIdentifier(p.getNameNode()))) {
        return "decorated or destructured parameter property";
    }
    if (initializersUse(ctor, propertyNames(ctor)))
        return "a field initializer reads a parameter property (initialization order would change)";
    const edits = [];
    const fields = [];
    for (const param of params) {
        const modifiers = param.getModifiers();
        const first = modifiers[0];
        if (!first)
            continue;
        edits.push({ start: first.getStart(), end: param.getNameNode().getStart(), text: "" });
        const type = param.getTypeNode()?.getText();
        const optional = param.hasQuestionToken() ? "?" : "";
        fields.push(`${modifiers.map((m) => m.getText()).join(" ")} ${param.getName()}${optional}${type ? `: ${type}` : ""};`);
    }
    const ctorStart = ctor.getStart(true);
    const memberIndent = indentOf(text, ctorStart);
    edits.push({ start: ctorStart, end: ctorStart, text: fields.map((f, i) => `${i === 0 ? "" : memberIndent}${f}\n`).join("") + memberIndent });
    const statements = body.getStatements();
    const superCall = statements.find((s) => Node.isExpressionStatement(s) && s.getExpression().getText().startsWith("super("));
    const bodyIndent = statements[0] ? indentOf(text, statements[0].getStart()) : `${memberIndent}  `;
    const assignments = params.map((p) => `this.${p.getName()} = ${p.getName()};`);
    if (superCall) {
        edits.push({ start: superCall.getEnd(), end: superCall.getEnd(), text: assignments.map((a) => `\n${bodyIndent}${a}`).join("") });
    }
    else {
        const open = body.getStart() + 1;
        edits.push({ start: open, end: open, text: assignments.map((a) => `\n${bodyIndent}${a}`).join("") + (statements.length === 0 ? `\n${memberIndent}` : "") });
    }
    return edits;
}
function literalValue(init) {
    if (!init)
        return undefined;
    if (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))
        return { kind: "string", value: init.getLiteralValue() };
    if (Node.isNumericLiteral(init))
        return { kind: "number", value: init.getLiteralValue() };
    if (Node.isPrefixUnaryExpression(init) && init.getOperatorToken() === SyntaxKind.MinusToken && Node.isNumericLiteral(init.getOperand())) {
        return { kind: "number", value: -Number(init.getOperand().getText()) };
    }
    return undefined;
}
function rewriteEnum(decl, file, text) {
    const name = decl.getName();
    const sameName = file.getDescendantsOfKind(SyntaxKind.EnumDeclaration).filter((e) => e.getName() === name);
    if (sameName.length > 1)
        throw new EnumError("merged enum declarations");
    const usedAsNamespaceType = file.getDescendantsOfKind(SyntaxKind.QualifiedName).some((q) => q.getLeft().getText() === name);
    if (usedAsNamespaceType)
        throw new EnumError(`\`${name}.Member\` is used as a type`);
    let next = 0;
    const entries = decl.getMembers().map((member) => {
        const init = member.getInitializer();
        const value = init ? literalValue(init) : { kind: "number", value: next };
        if (!value)
            throw new EnumError("computed enum member");
        if (value.kind === "number")
            next = value.value + 1;
        return `${member.getNameNode().getText()}: ${value.kind === "string" ? JSON.stringify(value.value) : value.value}`;
    });
    const exported = decl.hasExportKeyword() ? "export " : "";
    const indent = indentOf(text, decl.getStart());
    const body = entries.length === 0 ? "{}" : `{\n${entries.map((e) => `${indent}  ${e},`).join("\n")}\n${indent}}`;
    return `${exported}const ${name} = ${body} as const;\n${indent}${exported}type ${name} = (typeof ${name})[keyof typeof ${name}];`;
}
class EnumError extends Error {
}
export function erasableSyntaxEdits(file) {
    const text = file.getFullText();
    const edits = [];
    const reports = [];
    for (const ctor of file.getDescendantsOfKind(SyntaxKind.Constructor)) {
        if (!ctor.getParameters().some((p) => p.isParameterProperty()))
            continue;
        const result = rewriteParameterProperties(ctor, text);
        if (typeof result === "string") {
            reports.push({ node: ctor, api: "parameter property", status: "manual", message: `constructor parameter properties (${result}): ${TRANSFORM_HINT}` });
        }
        else {
            edits.push(...result);
            reports.push({ node: ctor, api: "parameter property", status: "auto", message: `→ class fields assigned in the constructor (${propertyNames(ctor).join(", ")})` });
        }
    }
    for (const decl of file.getDescendantsOfKind(SyntaxKind.EnumDeclaration)) {
        if (decl.hasDeclareKeyword())
            continue;
        try {
            edits.push({ start: decl.getStart(), end: decl.getEnd(), text: rewriteEnum(decl, file, text) });
            const reverse = decl.getMembers().some((m) => !m.getInitializer() || Node.isNumericLiteral(m.getInitializer()));
            reports.push({
                node: decl,
                api: "enum",
                status: "auto",
                message: `→ \`as const\` object + union type (other files using \`${decl.getName()}.Member\` as a type need \`typeof ${decl.getName()}.Member\`)${reverse ? "; numeric reverse lookups like E[0] no longer work" : ""}${decl.isConstEnum() ? "; const enum is now a runtime object" : ""}`,
            });
        }
        catch (error) {
            if (!(error instanceof EnumError))
                throw error;
            reports.push({ node: decl, api: "enum", status: "manual", message: `TypeScript enum (${error.message}): ${TRANSFORM_HINT}` });
        }
    }
    return { edits, reports };
}
