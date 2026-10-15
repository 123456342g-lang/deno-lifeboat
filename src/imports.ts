import path from "node:path";
import type { Dependency } from "./types.js";
import { own } from "./own.js";

export interface ImportMap {
  readonly imports: Readonly<Record<string, string>>;
  /** Directory relative targets in the import map are resolved against. */
  readonly baseDir: string;
}

export type SpecifierMapping =
  /** Not a Deno-specific specifier (relative path, `node:`, plain bare package). */
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "rewrite";
      readonly specifier: string;
      readonly deps: readonly Dependency[];
      readonly note?: string;
    }
  | { readonly kind: "manual"; readonly reason: string };

export interface MapContext {
  readonly importMap?: ImportMap;
  /** Absolute path of the importing file; needed to rewrite import-map paths into relative paths. */
  readonly fromFile: string;
}

const UNCHANGED: SpecifierMapping = { kind: "unchanged" };
const PACKAGE_RE = /^\/?((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?(\/.*)?$/;

interface PackageRef {
  readonly name: string;
  readonly version?: string;
  readonly subpath: string;
}

export function parsePackageRef(ref: string): PackageRef | undefined {
  const match = PACKAGE_RE.exec(ref);
  if (!match) return undefined;
  const [, name, version, subpath] = match;
  if (!name) return undefined;
  return { name, version: version || undefined, subpath: subpath ?? "" };
}

/** `@std/assert` → `@jsr/std__assert`, the name JSR's npm compatibility registry uses. */
export function jsrNpmName(name: string): string {
  return `@jsr/${name.slice(1).replace("/", "__")}`;
}

export function npmDependency(name: string, version: string | undefined): Dependency {
  return { name, spec: version ?? "latest" };
}

export function jsrDependency(name: string, version: string | undefined): Dependency {
  return { name, spec: `npm:${jsrNpmName(name)}@${version ?? "latest"}`, registry: "jsr" };
}

function unpinnedNote(version: string | undefined): string | undefined {
  return version ? undefined : "unversioned import: dependency added as \"latest\"; pin a version";
}

function rewrite(specifier: string, deps: readonly Dependency[], note?: string): SpecifierMapping {
  return note === undefined ? { kind: "rewrite", specifier, deps } : { kind: "rewrite", specifier, deps, note };
}

function mapNpm(rest: string): SpecifierMapping {
  const ref = parsePackageRef(rest);
  if (!ref) return { kind: "manual", reason: `cannot parse npm specifier "npm:${rest}"` };
  return rewrite(ref.name + ref.subpath, [npmDependency(ref.name, ref.version)], unpinnedNote(ref.version));
}

function mapJsr(rest: string): SpecifierMapping {
  const ref = parsePackageRef(rest);
  if (!ref || !ref.name.startsWith("@")) {
    return { kind: "manual", reason: `cannot parse jsr specifier "jsr:${rest}"` };
  }
  return rewrite(ref.name + ref.subpath, [jsrDependency(ref.name, ref.version)], unpinnedNote(ref.version));
}

const STD_RENAMES: Readonly<Record<string, string>> = {
  "testing/asserts.ts": "@std/assert",
  "testing/asserts": "@std/assert",
};

const STD_MANUAL: Readonly<Record<string, string>> = {
  "http/server.ts":
    "std/http/server.ts was removed from std; lifeboat maps `import { serve }` (plus the Handler/ConnInfo types) to its serve shim, other exports (serveTls, Server) need porting to Deno.serve",
};

/** `https://deno.land/std@x/http/server.ts` (the pre-Deno.serve std HTTP server). */
export function isStdHttpServer(specifier: string): boolean {
  return /^https:\/\/deno\.land\/std(?:@[^/]+)?\/http\/server\.ts$/.test(specifier);
}

function mapDenoStd(rest: string): SpecifierMapping {
  const match = /^std(?:@[^/]+)?\/(.+)$/.exec(rest);
  if (!match?.[1]) return { kind: "manual", reason: `cannot parse deno.land/std URL "${rest}"` };
  const filePath = match[1];
  const manual = own(STD_MANUAL, filePath);
  if (manual) return { kind: "manual", reason: manual };
  const renamed = own(STD_RENAMES, filePath);
  const note = "approximate mapping from deno.land/std to JSR @std: verify the subpath and API, std 0.x APIs changed";
  if (renamed) return rewrite(renamed, [jsrDependency(renamed, undefined)], note);
  const [moduleName, ...fileParts] = filePath.split("/");
  if (!moduleName || fileParts.length === 0) return { kind: "manual", reason: `cannot map deno.land/std path "${filePath}"` };
  const pkg = `@std/${moduleName.replaceAll("_", "-")}`;
  const file = fileParts.join("/").replace(/\.(ts|js|mjs)$/, "");
  const sub = file === "mod" ? "" : `/${stripModulePrefix(moduleName, file).replaceAll("_", "-")}`;
  return rewrite(pkg + sub, [jsrDependency(pkg, undefined)], note);
}

function stripModulePrefix(moduleName: string, file: string): string {
  return file.startsWith(`${moduleName}_`) ? file.slice(moduleName.length + 1) : file;
}

interface ThirdPartyMapping {
  readonly registry: "npm" | "jsr";
  readonly name: string;
}

/** deno.land/x modules with a well-known npm/JSR home. Only the `mod.ts` entry point is mapped. */
const DENO_LAND_X: Readonly<Record<string, ThirdPartyMapping>> = {
  hono: { registry: "npm", name: "hono" },
  oak: { registry: "jsr", name: "@oak/oak" },
  zod: { registry: "npm", name: "zod" },
};

function mapDenoLandX(rest: string): SpecifierMapping {
  const match = /^x\/([^/@]+)(?:@v?([^/]+))?\/(.+)$/.exec(rest);
  const known = match?.[1] ? own(DENO_LAND_X, match[1]) : undefined;
  if (!match || !known || match[3] !== "mod.ts") {
    return {
      kind: "manual",
      reason: "deno.land/x module: find its npm or JSR equivalent (or vendor the code) and import it by package name",
    };
  }
  const version = match[2];
  const dep = known.registry === "npm" ? npmDependency(known.name, version) : jsrDependency(known.name, undefined);
  return rewrite(known.name, [dep], `deno.land/x/${match[1]} mapped to ${known.registry}:${known.name}; check the version`);
}

const ESM_SH_UNSAFE_QUERY = /(?:^|&)(?:deps|alias|external|bundle|exports)=/;

function mapCdnPackage(rest: string, host: string): SpecifierMapping {
  const [pathPart = "", query = ""] = rest.split("?");
  const cleaned = pathPart.replace(/^v\d+\//, "").replace(/^stable\//, "").replace(/^\*/, "");
  if (cleaned.startsWith("jsr/")) return mapJsr(cleaned.slice("jsr/".length));
  if (cleaned.startsWith("gh/") || /\/(?:es20\d\d|denonext|deno|esnext)\//.test(cleaned)) {
    return { kind: "manual", reason: `${host} build URL: import the npm package by name instead` };
  }
  const ref = parsePackageRef(cleaned);
  if (!ref) return { kind: "manual", reason: `cannot parse ${host} URL` };
  const notes = [unpinnedNote(ref.version), ESM_SH_UNSAFE_QUERY.test(query) ? `${host} query "?${query}" dropped; check dependency pinning` : undefined]
    .filter((n): n is string => n !== undefined);
  return rewrite(ref.name + ref.subpath, [npmDependency(ref.name, ref.version)], notes.length ? notes.join("; ") : undefined);
}

const CDN_HOSTS: ReadonlyArray<readonly [prefix: string, host: string]> = [
  ["https://esm.sh/", "esm.sh"],
  ["https://cdn.esm.sh/", "esm.sh"],
  ["https://cdn.skypack.dev/", "skypack"],
  ["https://unpkg.com/", "unpkg"],
  ["https://cdn.jsdelivr.net/npm/", "jsdelivr"],
  ["https://esm.run/", "esm.run"],
];

function mapUrl(specifier: string): SpecifierMapping {
  if (specifier.startsWith("https://deno.land/std")) return mapDenoStd(specifier.slice("https://deno.land/".length));
  if (specifier.startsWith("https://deno.land/x/")) return mapDenoLandX(specifier.slice("https://deno.land/".length));
  for (const [prefix, host] of CDN_HOSTS) {
    if (specifier.startsWith(prefix)) return mapCdnPackage(specifier.slice(prefix.length), host);
  }
  return {
    kind: "manual",
    reason: "remote URL import: Node/Bun cannot import over HTTP; vendor the file or use the npm/JSR package",
  };
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || specifier.startsWith("file:");
}

export function toRelativeImport(fromFile: string, targetPath: string): string {
  const relative = path.relative(path.dirname(fromFile), targetPath).split(path.sep).join("/");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

/** Resolves a specifier through the import map (exact keys first, then the longest matching `/` prefix key). */
export function resolveImportMap(specifier: string, importMap: ImportMap | undefined): string | undefined {
  if (!importMap) return undefined;
  const exact = own(importMap.imports, specifier);
  if (exact !== undefined) return exact;
  let best: string | undefined;
  for (const key of Object.keys(importMap.imports)) {
    if (key.endsWith("/") && specifier.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  return best === undefined ? undefined : importMap.imports[best] + specifier.slice(best.length);
}

/** Maps a direct (non-import-map) specifier. */
export function mapDirectSpecifier(specifier: string): SpecifierMapping {
  if (specifier.startsWith("npm:")) return mapNpm(specifier.slice(4));
  if (specifier.startsWith("jsr:")) return mapJsr(specifier.slice(4));
  if (specifier.startsWith("https://") || specifier.startsWith("http://")) return mapUrl(specifier);
  return UNCHANGED;
}

export function mapSpecifier(specifier: string, ctx: MapContext): SpecifierMapping {
  if (specifier.startsWith("node:") || isRelative(specifier)) return UNCHANGED;
  const direct = mapDirectSpecifier(specifier);
  if (direct.kind !== "unchanged") return direct;
  const target = resolveImportMap(specifier, ctx.importMap);
  if (target === undefined || !ctx.importMap) return UNCHANGED;
  if (target.startsWith("node:")) return rewrite(target, []);
  if (isRelative(target)) {
    const absolute = target.startsWith("file:") ? new URL(target).pathname : path.resolve(ctx.importMap.baseDir, target);
    return rewrite(toRelativeImport(ctx.fromFile, absolute), [], "import-map alias rewritten to a relative path");
  }
  const mapped = mapDirectSpecifier(target);
  if (mapped.kind === "manual") return { kind: "manual", reason: `import map entry "${specifier}" → "${target}": ${mapped.reason}` };
  if (mapped.kind === "unchanged") return target === specifier ? UNCHANGED : rewrite(target, []);
  return mapped;
}
