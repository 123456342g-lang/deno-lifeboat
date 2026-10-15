import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget, ts } from "ts-morph";
import { buildChecklist, CHECKLIST_FILE } from "./checklist.js";
import { planConfig } from "./config.js";
import { loadDenoConfig, taskCommand } from "./denoConfig.js";
import { listSourceFiles } from "./files.js";
import { rewriteFile, SHIM_DIR } from "./rewrite/fileRewriter.js";
import { summarize } from "./summary.js";
const TEMPLATE_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));
const PROTECTED_FILES = new Set(["deno.json", "deno.jsonc", "deno.lock"]);
const ENTRY_CANDIDATES = ["main.ts", "server.ts", "mod.ts", "index.ts", "main.js", "server.js", "src/main.ts", "src/index.ts"];
export class ProjectError extends Error {
}
function createProject() {
    return new Project({
        compilerOptions: {
            allowJs: true,
            jsx: ts.JsxEmit.Preserve,
            allowImportingTsExtensions: true,
            noEmit: true,
            module: ModuleKind.ESNext,
            moduleResolution: ModuleResolutionKind.Bundler,
            target: ScriptTarget.ESNext,
        },
        skipAddingFilesFromTsConfig: true,
        skipFileDependencyResolution: true,
    });
}
function testPatterns(files) {
    const testFiles = files.filter((f) => f.findings.some((x) => x.category === "test")).map((f) => f.file);
    const patterns = testFiles.map((file) => {
        const ext = path.extname(file);
        if (file.endsWith(`_test${ext}`))
            return `**/*_test${ext}`;
        if (file.endsWith(`.test${ext}`))
            return `**/*.test${ext}`;
        return file;
    });
    return [...new Set(patterns)];
}
function detectEntry(root, deno, files) {
    const serving = files.find((f) => f.servesHttp);
    if (serving)
        return serving.file;
    for (const name of ["start", "dev", "serve"]) {
        const task = deno.tasks[name];
        const command = task === undefined ? undefined : taskCommand(task);
        const match = command?.match(/(\S+\.(?:ts|tsx|js|mjs))\b/);
        if (match?.[1])
            return match[1].replace(/^\.\//, "");
    }
    return ENTRY_CANDIDATES.find((candidate) => existsSync(path.join(root, candidate)));
}
function shimFiles(root, shims) {
    return [...shims].sort().flatMap((shim) => {
        const relative = `${SHIM_DIR}/${shim}.ts`;
        if (existsSync(path.join(root, relative)))
            return [];
        return [{ path: relative, content: readFileSync(path.join(TEMPLATE_DIR, `${shim}.ts`), "utf8") }];
    });
}
export function todayUtc() {
    return new Date().toISOString().slice(0, 10);
}
export function analyzeProject(dir, options) {
    const root = path.resolve(dir);
    if (!existsSync(root) || !statSync(root).isDirectory())
        throw new ProjectError(`not a directory: ${dir}`);
    const deno = loadDenoConfig(root);
    const sources = listSourceFiles(root, deno.exclude);
    const project = createProject();
    const sourceFiles = sources.map((file) => project.addSourceFileAtPath(path.join(root, file)));
    const files = sourceFiles.map((file) => rewriteFile(file, { target: options.target, root, importMap: deno.importMap, emitTodos: options.emitTodos }));
    const shims = new Set(files.flatMap((f) => [...f.shims]));
    const entry = detectEntry(root, deno, files);
    const config = planConfig({
        root,
        target: options.target,
        deno,
        dependencies: files.flatMap((f) => f.dependencies),
        testPatterns: testPatterns(files),
        entry,
        cronTriggers: files.flatMap((f) => f.cronTriggers),
        usesTypeScript: sources.some((f) => /\.(ts|tsx|mts)$/.test(f)),
        today: options.today ?? todayUtc(),
    });
    const findings = [...files.flatMap((f) => f.findings), ...config.findings];
    const summary = summarize(findings);
    const sourceChanges = files
        .filter((f) => f.output !== f.original)
        .map((f) => ({ path: f.file, content: f.output, original: f.original }));
    const checklistPath = path.join(root, CHECKLIST_FILE);
    const checklist = {
        path: CHECKLIST_FILE,
        content: buildChecklist({ target: options.target, findings, summary, entry }),
        original: existsSync(checklistPath) ? readFileSync(checklistPath, "utf8") : undefined,
    };
    const changes = [...sourceChanges, ...config.files, ...shimFiles(root, shims), checklist];
    const forbidden = changes.find((c) => PROTECTED_FILES.has(c.path));
    if (forbidden)
        throw new ProjectError(`internal error: refusing to modify ${forbidden.path}`);
    return { root, target: options.target, deno, files, findings, summary, entry, shims, changes };
}
