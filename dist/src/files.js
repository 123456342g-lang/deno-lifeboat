import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "vendor", ".deno", "lifeboat-shim", "_fresh"]);
export function isSourceFile(file) {
    return SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext)) && !file.endsWith(".d.ts");
}
function isExcluded(relative, exclude) {
    const parts = relative.split("/");
    if (parts.some((part) => SKIP_DIRS.has(part)))
        return true;
    return exclude.some((pattern) => {
        const clean = pattern.replace(/^\.\//, "").replace(/\/\*\*$/, "").replace(/\/$/, "");
        return relative === clean || relative.startsWith(`${clean}/`);
    });
}
function gitListFiles(root) {
    try {
        const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], {
            cwd: root,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            maxBuffer: 64 * 1024 * 1024,
        });
        return out.split("\0").filter(Boolean);
    }
    catch {
        return undefined;
    }
}
function walk(root, dir = "") {
    const entries = readdirSync(path.join(root, dir), { withFileTypes: true });
    return entries.flatMap((entry) => {
        const relative = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory())
            return SKIP_DIRS.has(entry.name) ? [] : walk(root, relative);
        return entry.isFile() ? [relative] : [];
    });
}
/** Source files under `root` as sorted POSIX-style relative paths. Uses `git ls-files` when available so .gitignore is honoured. */
export function listSourceFiles(root, exclude = []) {
    const all = gitListFiles(root) ?? walk(root);
    return all
        .filter((file) => isSourceFile(file) && !isExcluded(file, exclude))
        .filter((file) => {
        try {
            return statSync(path.join(root, file)).isFile();
        }
        catch {
            return false;
        }
    })
        .sort();
}
