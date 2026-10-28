// What the read-only tools share (issue #610): argument parsing, the run a
// tool reads, a node looked up by id or name, and `compact`, which keeps a
// result small before the orchestrator's own size cap
// (ASSISTANT_MAX_TOOL_RESULT_CHARS) has to cut it.
//
// Every tool reads through runs/read.ts, never run_series itself, so the
// routes' withholding applies (#523 I, D3), and answers a bad argument, a
// missing run or a withheld series with { ok: false, error } in words the
// API would use (ApiError messages, never database text). Anything else is
// thrown for the orchestrator: a database error has already aborted the
// transaction, so no later tool could read anyway.
import { z } from 'zod';
import { ApiError } from '../../http/errors.js';
import { requireRole, type Role } from '../../projects/access.js';
import { latestRunId } from '../../runs/read.js';
import type { ToolContext, ToolResult, ToolSpec } from '../types.js';

/** A tool's JSON Schema from its zod arguments, so what the model is told and what is checked can't drift apart. */
export function specOf(name: string, description: string, schema: z.ZodType): ToolSpec {
	const { $schema: _drop, ...parameters } = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
	return { name, description, parameters };
}

/** The model's arguments: an object, or JSON text of one (a provider that passed them through unparsed). */
export function parseArgs<T extends z.ZodType>(schema: T, args: unknown): { ok: true; value: z.output<T> } | { ok: false; error: string } {
	let raw = args ?? {};
	if (typeof raw === 'string') {
		try {
			raw = raw.trim() ? JSON.parse(raw) : {};
		} catch {
			return { ok: false, error: 'the arguments are not valid JSON' };
		}
	}
	const parsed = schema.safeParse(raw);
	if (parsed.success) return { ok: true, value: parsed.data };
	const issue = parsed.error.issues[0]!;
	return { ok: false, error: `invalid arguments: ${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}` };
}

export const fail = (error: string): ToolResult => ({ ok: false, error });

/** An ApiError (not found, withheld, a bad date) as the tool's refusal; anything else is rethrown. */
export function refusal(e: unknown): ToolResult {
	if (e instanceof ApiError) return fail(e.message);
	throw e;
}

/** The caller's role (viewer or above, as the chat needs) and the run the tool reads: the conversation's, else the latest. */
export async function runFor(ctx: ToolContext): Promise<{ role: Role; runId: string | null }> {
	const role = await requireRole(ctx.db, ctx.projectId, 'viewer');
	return { role, runId: ctx.runId ?? (await latestRunId(ctx.db, ctx.projectId)) };
}

export const NO_RUN = 'this project has no run yet: run the model first (the Runs tab)';

/** A node named by its id, or by its name (any case). */
export function findNode<N extends { id: string; name: string }>(nodes: readonly N[], ref: string): N | undefined {
	const want = ref.trim();
	return nodes.find((n) => n.id === want) ?? nodes.find((n) => n.name.trim().toLowerCase() === want.toLowerCase());
}

/** A node argument: its id or its name. */
export const NodeRef = z.string().trim().min(1).max(200).describe('The node: its id, or its name as the network lists it');

/** A number to `digits` significant digits (non-finite → null). */
export function round(x: number, digits = 4): number | null {
	if (!Number.isFinite(x)) return null;
	if (x === 0) return 0;
	return Number(x.toPrecision(digits));
}

export interface CompactOptions {
	/** Items kept of an array; the rest are counted in a last "… N more" string. */
	maxItems?: number;
	/** Nesting below which objects and arrays become "…". */
	maxDepth?: number;
	/** Characters kept of a string. */
	maxString?: number;
	/** Significant digits of a number; 0 keeps them all. */
	digits?: number;
}

/** `value` with long arrays cut, deep nesting folded, long strings trimmed and numbers rounded. */
export function compact(value: unknown, opts: CompactOptions = {}, depth = 0): unknown {
	const { maxItems = 20, maxDepth = 5, maxString = 400, digits = 4 } = opts;
	if (typeof value === 'number') return digits ? round(value, digits) : Number.isFinite(value) ? value : null;
	if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}…` : value;
	if (value === null || typeof value !== 'object') return value;
	if (depth >= maxDepth) return '…';
	if (Array.isArray(value)) {
		const kept = value.slice(0, maxItems).map((v) => compact(v, opts, depth + 1));
		return value.length > maxItems ? [...kept, `… ${value.length - maxItems} more`] : kept;
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = compact(v, opts, depth + 1);
	return out;
}
