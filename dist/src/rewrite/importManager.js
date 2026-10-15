import { Node, SyntaxKind } from "ts-morph";
import { isPropertyName } from "./typeImports.js";
/** Adds named imports to a file, reusing existing ones and aliasing on identifier conflicts. */
export class ImportManager {
    file;
    taken;
    existing = new Map();
    pending = [];
    constructor(file) {
        this.file = file;
        this.taken = new Set(file
            .getDescendantsOfKind(SyntaxKind.Identifier)
            .filter((id) => !isPropertyName(id))
            .map((id) => id.getText()));
        for (const decl of file.getImportDeclarations()) {
            if (decl.isTypeOnly())
                continue;
            const module = decl.getModuleSpecifierValue();
            for (const spec of decl.getNamedImports()) {
                if (spec.isTypeOnly())
                    continue;
                const local = spec.getAliasNode()?.getText() ?? spec.getName();
                this.existing.set(key(module, spec.getName()), local);
            }
        }
    }
    named(module, name) {
        const k = key(module, name);
        const found = this.existing.get(k);
        if (found)
            return found;
        let local = name;
        for (let i = 2; this.taken.has(local); i++)
            local = `${name}${i}`;
        this.taken.add(local);
        this.existing.set(k, local);
        this.pending.push({ module, name, local });
        return local;
    }
    /** Returns a function that undoes every `named()` call made after this point. */
    checkpoint() {
        const pendingLength = this.pending.length;
        return () => {
            for (const imp of this.pending.splice(pendingLength)) {
                this.taken.delete(imp.local);
                this.existing.delete(key(imp.module, imp.name));
            }
        };
    }
    get hasPending() {
        return this.pending.length > 0;
    }
    /** The import block to insert and where to insert it. */
    render() {
        if (this.pending.length === 0)
            return undefined;
        const byModule = new Map();
        for (const imp of this.pending)
            byModule.set(imp.module, [...(byModule.get(imp.module) ?? []), imp]);
        const lines = [...byModule.entries()]
            .sort(([a], [b]) => sortKey(a).localeCompare(sortKey(b)))
            .map(([module, imports]) => {
            const names = imports.map((i) => (i.local === i.name ? i.name : `${i.name} as ${i.local}`)).join(", ");
            return `import { ${names} } from ${JSON.stringify(module)};`;
        });
        const imports = this.file.getStatements().filter((s) => Node.isImportDeclaration(s));
        const last = imports.at(-1);
        if (last)
            return { position: last.getEnd(), text: `\n${lines.join("\n")}` };
        const first = this.file.getStatements()[0];
        if (!first)
            return { position: this.file.getEnd(), text: `${lines.join("\n")}\n` };
        return { position: first.getStart(true), text: `${lines.join("\n")}\n\n` };
    }
}
function key(module, name) {
    return `${module}\0${name}`;
}
/** node: builtins first, then packages, then relative paths. */
function sortKey(module) {
    if (module.startsWith("node:") || module.startsWith("bun:"))
        return `0${module}`;
    if (module.startsWith("."))
        return `2${module}`;
    return `1${module}`;
}
