import { Node, SyntaxKind, type Identifier, type SourceFile } from "ts-morph";
import type { Edit } from "../types.js";

export interface TypeImportFix {
  readonly edits: readonly Edit[];
  /** Names that were marked type-only, with their line numbers. */
  readonly names: ReadonlyArray<{ readonly name: string; readonly line: number }>;
}

/** True when the identifier sits in a type position (annotations, `implements`, interface heritage, `typeof` queries in types). */
export function isTypePosition(id: Node): boolean {
  for (let parent = id.getParent(); parent; parent = parent.getParent()) {
    if (Node.isExpressionWithTypeArguments(parent)) {
      const clause = parent.getParent();
      const isClassExtends =
        Node.isHeritageClause(clause) &&
        clause.getToken() === SyntaxKind.ExtendsKeyword &&
        (Node.isClassDeclaration(clause.getParent()) || Node.isClassExpression(clause.getParent()));
      return !isClassExtends;
    }
    if (Node.isTypeNode(parent) || Node.isInterfaceDeclaration(parent) || Node.isTypeAliasDeclaration(parent)) return true;
    const isValueExpression = Node.isExpression(parent) && !Node.isPropertyAccessExpression(parent);
    if (Node.isStatement(parent) || Node.isSourceFile(parent) || isValueExpression) return false;
  }
  return false;
}

function isTypeDeclaration(node: Node): boolean {
  return Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node);
}

/** Whether `name` is exported from `file` only as types (interfaces / type aliases). */
function exportedOnlyAsType(file: SourceFile | undefined, name: string): boolean {
  if (!file) return false;
  const decls = file.getExportedDeclarations().get(name);
  return decls !== undefined && decls.length > 0 && decls.every(isTypeDeclaration);
}

function usedOnlyAsType(file: SourceFile, nameNode: Identifier, identifiers: readonly Identifier[]): boolean {
  const name = nameNode.getText();
  const references = identifiers.filter((id) => id !== nameNode && id.getText() === name && !isPropertyName(id));
  return references.length > 0 && references.every(isTypePosition);
}

/** True for identifiers that name a property/member rather than reference a binding (`x.name`, `{ name: 1 }`). */
export function isPropertyName(id: Identifier): boolean {
  const parent = id.getParent();
  return (
    (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) ||
    (Node.isPropertyAssignment(parent) && parent.getNameNode() === id) ||
    (Node.isPropertySignature(parent) && parent.getNameNode() === id) ||
    (Node.isMethodDeclaration(parent) && parent.getNameNode() === id) ||
    (Node.isPropertyDeclaration(parent) && parent.getNameNode() === id) ||
    (Node.isQualifiedName(parent) && parent.getRight() === id)
  );
}

function safeModuleFile(decl: { getModuleSpecifierSourceFile(): SourceFile | undefined }): SourceFile | undefined {
  try {
    return decl.getModuleSpecifierSourceFile();
  } catch {
    return undefined;
  }
}

/**
 * Node's type stripping keeps every import that is not marked `type`, so importing an interface
 * from another module fails at runtime ("does not provide an export named"). Deno/tsc elide them.
 * This marks imports (and re-exports) that are only used as types with `type`.
 */
export function typeOnlyImportFixes(file: SourceFile, skip: (specifier: string) => boolean = () => false): TypeImportFix {
  const identifiers = file.getDescendantsOfKind(SyntaxKind.Identifier);
  const edits: Edit[] = [];
  const names: Array<{ name: string; line: number }> = [];
  const mark = (node: Node, name: string): void => {
    edits.push({ start: node.getStart(), end: node.getStart(), text: "type " });
    names.push({ name, line: node.getStartLineNumber() });
  };

  for (const decl of file.getImportDeclarations()) {
    if (decl.isTypeOnly() || !decl.getImportClause() || skip(decl.getModuleSpecifierValue())) continue;
    const target = safeModuleFile(decl);
    const isType = (nameNode: Identifier, importedName: string): boolean =>
      exportedOnlyAsType(target, importedName) || usedOnlyAsType(file, nameNode, identifiers);
    const named = decl.getNamedImports();
    const defaultImport = decl.getDefaultImport();
    const namespaceImport = decl.getNamespaceImport();
    const pending = named.filter((spec) => !spec.isTypeOnly() && isType(spec.getAliasNode() ?? spec.getNameNode() as Identifier, spec.getName()));
    const defaultIsType = defaultImport ? usedOnlyAsType(file, defaultImport, identifiers) : true;
    const namespaceIsType = namespaceImport ? usedOnlyAsType(file, namespaceImport, identifiers) : true;
    const allNamedType = named.every((spec) => spec.isTypeOnly() || pending.includes(spec));
    const hasBindings = named.length > 0 || defaultImport !== undefined || namespaceImport !== undefined;

    if (hasBindings && allNamedType && namespaceIsType && defaultIsType && !(defaultImport && named.length > 0)) {
      const importKeyword = decl.getFirstChildByKind(SyntaxKind.ImportKeyword);
      if (!importKeyword) continue;
      edits.push({ start: importKeyword.getEnd(), end: importKeyword.getEnd(), text: " type" });
      for (const spec of named) {
        if (spec.isTypeOnly()) edits.push({ start: spec.getStart(), end: spec.getNameNode().getStart(), text: "" });
      }
      names.push({ name: decl.getModuleSpecifierValue(), line: decl.getStartLineNumber() });
      continue;
    }
    for (const spec of pending) mark(spec, spec.getName());
  }

  for (const decl of file.getExportDeclarations()) {
    if (decl.isTypeOnly() || !decl.hasModuleSpecifier()) continue;
    const target = safeModuleFile(decl);
    for (const spec of decl.getNamedExports()) {
      if (!spec.isTypeOnly() && exportedOnlyAsType(target, spec.getName())) mark(spec, spec.getName());
    }
  }
  return { edits, names };
}
