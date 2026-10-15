import { Node } from "ts-morph";
import type { Category, Dependency, Edit, ShimName, Target } from "../types.js";

export interface RewriteContext {
  readonly target: Target;
  /** Matched node: the CallExpression for call rules, the PropertyAccessExpression for value rules. */
  readonly node: Node;
  /** Call arguments (empty for value rules). */
  readonly args: readonly Node[];
  /** True when `node` is the whole expression of an ExpressionStatement. */
  readonly isStatement: boolean;
  /** True for .ts/.tsx/.mts files (type annotations are allowed in emitted code). */
  readonly isTs: boolean;
  /** Rewritten text of argument `index` (nested Deno APIs already migrated). */
  arg(index: number, extraEdits?: readonly Edit[]): string;
  /** Rewritten text of any node inside the matched expression. */
  text(node: Node, extraEdits?: readonly Edit[]): string;
  /** Rewritten text of all arguments, comma separated. */
  allArgs(): string;
  /** Imports `name` from `module` and returns the local identifier (aliased on conflict). */
  named(module: string, name: string): string;
  /** Imports `name` from a generated lifeboat shim and returns the local identifier. */
  shim(shim: ShimName, name: string): string;
  dependency(dep: Dependency): void;
  /** Records a cron schedule for the generated Workers config. */
  cronTrigger(schedule: string): void;
}

export type Outcome =
  | {
      readonly text: string;
      /** Replace this node instead of `ctx.node`. */
      readonly replace?: Node;
      readonly note?: string;
    }
  | { readonly manual: string };

export type Handler = (ctx: RewriteContext) => Outcome;

/** A handler, or a string meaning "flag as manual with this guidance". */
export type TargetAction = Handler | string;

export interface ApiRule {
  /** Path below `Deno`, e.g. "env.get". */
  readonly path: string;
  /** "call" rules match `Deno.x(...)`; "value" rules match any use of `Deno.x`. */
  readonly kind: "call" | "value";
  readonly category: Category;
  readonly targets: Readonly<Record<Target, TargetAction>>;
}

export function manual(message: string): Outcome {
  return { manual: message };
}

export function isManual(outcome: Outcome): outcome is { readonly manual: string } {
  return "manual" in outcome;
}

export function nodeAndBun(handler: TargetAction, workers: TargetAction): Readonly<Record<Target, TargetAction>> {
  return { node: handler, bun: handler, workers };
}

export function allTargets(handler: TargetAction): Readonly<Record<Target, TargetAction>> {
  return { node: handler, bun: handler, workers: handler };
}

/** Wraps an assignment/delete expression in parens unless it is a statement on its own (avoids ASI hazards). */
export function asExpression(ctx: RewriteContext, text: string): string {
  return ctx.isStatement ? text : `(${text})`;
}

/** Wraps `text` in parens unless `node`'s position already delimits it (if/while condition, parens, argument, initializer). */
export function parenthesize(node: Node, text: string): string {
  const parent = node.getParent();
  const delimited =
    Node.isParenthesizedExpression(parent) ||
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
export function envAccess(argNode: Node | undefined, argText: string): string {
  if (argNode && Node.isStringLiteral(argNode) && IDENTIFIER_RE.test(argNode.getLiteralValue())) {
    return `process.env.${argNode.getLiteralValue()}`;
  }
  return `process.env[${argText}]`;
}

export function withArity(min: number, max: number, handler: Handler): Handler {
  return (ctx) =>
    ctx.args.length < min || ctx.args.length > max
      ? manual(`called with ${ctx.args.length} argument(s); lifeboat only rewrites ${min === max ? min : `${min}–${max}`}`)
      : handler(ctx);
}
