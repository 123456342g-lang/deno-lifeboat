import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
const CONFIG_NAMES = ["deno.json", "deno.jsonc"];
export class ConfigError extends Error {
}
export function readJsonc(file) {
    const errors = [];
    const value = parseJsonc(readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
    if (errors.length > 0) {
        const first = errors[0];
        throw new ConfigError(`${file}: invalid JSON (${printParseErrorCode(first.error)} at offset ${first.offset})`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ConfigError(`${file}: expected a JSON object`);
    }
    return value;
}
function stringRecord(value) {
    if (typeof value !== "object" || value === null)
        return {};
    return Object.fromEntries(Object.entries(value).filter((e) => typeof e[1] === "string"));
}
function stringArray(value) {
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}
function optionalString(value) {
    return typeof value === "string" ? value : undefined;
}
function taskRecord(value) {
    if (typeof value !== "object" || value === null)
        return {};
    return Object.fromEntries(Object.entries(value).filter((e) => typeof e[1] === "string" || (typeof e[1] === "object" && e[1] !== null)));
}
export function findDenoConfigFile(root) {
    return CONFIG_NAMES.map((name) => path.join(root, name)).find((file) => existsSync(file));
}
export function loadDenoConfig(root) {
    const file = findDenoConfigFile(root);
    const raw = file ? readJsonc(file) : {};
    const inline = stringRecord(raw.imports);
    const importMapPath = optionalString(raw.importMap);
    const importMapFile = importMapPath ? path.resolve(root, importMapPath) : undefined;
    const external = importMapFile && existsSync(importMapFile) ? readJsonc(importMapFile) : undefined;
    const imports = { ...stringRecord(external?.imports), ...inline };
    const hasScopes = raw.scopes !== undefined || external?.scopes !== undefined;
    const baseDir = importMapFile && Object.keys(inline).length === 0 ? path.dirname(importMapFile) : root;
    const compilerOptions = typeof raw.compilerOptions === "object" && raw.compilerOptions !== null
        ? raw.compilerOptions
        : {};
    return {
        file,
        name: optionalString(raw.name),
        version: optionalString(raw.version),
        tasks: taskRecord(raw.tasks),
        importMap: Object.keys(imports).length > 0 ? { imports, baseDir } : undefined,
        importMapFile,
        hasScopes,
        compilerOptions,
        exclude: stringArray(raw.exclude),
        workspace: stringArray(raw.workspace),
        exports: raw.exports,
        unstable: stringArray(raw.unstable),
    };
}
export function taskCommand(task) {
    return typeof task === "string" ? task : task.command;
}
