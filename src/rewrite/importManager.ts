import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import { isPropertyName } from "./typeImports.js";

interface PendingImport {
  readonly module: string;
  readonly name: string;
  readonly local: string;
}

/** Adds named imports to a file, reusing existing ones and aliasing on identifier conflicts. */
export class ImportManager {
  private readonly taken: Set<string>;
  private readonly existing = new Map<string, string>();
  private readonly pending: PendingImport[] = [];

  constructor(private readonly file: SourceFile) {
    this.taken = new Set(
      file
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .filter((id) => !isPropertyName(id))
        .map((id) => id.getText()),
    );
    for (const decl of file.getImportDeclarations()) {
      if (decl.isTypeOnly()) continue;
      const module = decl.getModuleSpecifierValue();
      for (const spec of decl.getNamedImports()) {
        if (spec.isTypeOnly()) continue;
        const local = spec.getAliasNode()?.getText() ?? spec.getName();
        this.existing.set(key(module, spec.getName()), local);
      }
    }
  }

  named(module: string, name: string): string {
    const k = key(module, name);
    const found = this.existing.get(k);
    if (found) return found;
    let local = name;
    for (let i = 2; this.taken.has(local); i++) local = `${name}${i}`;
    this.taken.add(local);
    this.existing.set(k, local);
    this.pending.push({ module, name, local });
    return local;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** The import block to insert and where to insert it. */
  render(): { position: number; text: string } | undefined {
    if (this.pending.length === 0) return undefined;
    const byModule = new Map<string, PendingImport[]>();
    for (const imp of this.pending) byModule.set(imp.module, [...(byModule.get(imp.module) ?? []), imp]);
    const lines = [...byModule.entries()]
      .sort(([a], [b]) => sortKey(a).localeCompare(sortKey(b)))
      .map(([module, imports]) => {
        const names = imports.map((i) => (i.local === i.name ? i.name : `${i.name} as ${i.local}`)).join(", ");
        return `import { ${names} } from ${JSON.stringify(module)};`;
      });
    const imports = this.file.getStatements().filter((s) => Node.isImportDeclaration(s));
    const last = imports.at(-1);
    if (last) return { position: last.getEnd(), text: `\n${lines.join("\n")}` };
    const first = this.file.getStatements()[0];
    if (!first) return { position: this.file.getEnd(), text: `${lines.join("\n")}\n` };
    return { position: first.getStart(true), text: `${lines.join("\n")}\n\n` };
  }
}

function key(module: string, name: string): string {
  return `${module}\0${name}`;
}

/** node: builtins first, then packages, then relative paths. */
function sortKey(module: string): string {
  if (module.startsWith("node:") || module.startsWith("bun:")) return `0${module}`;
  if (module.startsWith(".")) return `2${module}`;
  return `1${module}`;
}
