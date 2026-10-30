// Ids named in the assistant's tool output (issue #610, the 2026-10-30
// production test): settings, warnings and network rows refer to nodes,
// transfers and series by id ("calibrationSiteNodeId": "<uuid>", "gauge node
// <uuid>", rainStations.units keyed by node id). The model then quoted them.
// Every tool's result goes through nameIds before the model reads it: a known
// id becomes what it is in the app's words ("the gauge 'Outlet weir'", "the
// transfer 'Upper → Lower'", "the series 'Weir record'"), as a value, an object
// key or inside a sentence; an id in a node field that matches no node says so
// ("a node that no longer exists"). The one exception is a field named `id`,
// which sits beside its own name and is what a tool takes as an argument (the
// tools take names too, and the prompt says never to quote ids).
//
// The names come from what the tool's transaction can already read as the
// caller, under RLS: the project's nodes, transfers and series, and the nodes
// of the run the conversation is about (a node since deleted keeps its name
// there). Names only, never values.
import type { Db } from '../../db/tx.js';
import { latestRunId } from '../../runs/read.js';
import type { AssistantTool, ToolContext } from '../types.js';

/** What the app calls a node kind. */
const KIND_WORDS: Record<string, string> = { farm: 'hydrological unit', gauge: 'gauge', user: 'other water user' };

export const GONE_NODE = 'a node that no longer exists';

/** The shape of every id the database gives a node. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fields whose value is a node's id (or a list of them). */
const NODE_FIELD = /(?:^|[a-z])(?:N|n)odeIds?$|^(?:unitId|unitIds|site|node|drainsInto)$/;

export interface IdNames {
	/** id → what it is ("the gauge 'Weir'"). */
	names: Map<string, string>;
	/** The ids that are nodes, for the node fields. */
	nodes: Set<string>;
}

export function nodeWords(n: { name?: unknown; kind?: unknown }): string {
	const kind = KIND_WORDS[String(n.kind)] ?? 'node';
	const name = typeof n.name === 'string' && n.name.trim() ? n.name.trim() : 'unnamed';
	return `the ${kind} '${name}'`;
}

/** The project's (and the run's) nodes, transfers and series by id, read as the caller. */
export async function loadIdNames(db: Db, projectId: string, runId: string | null): Promise<IdNames> {
	const names = new Map<string, string>();
	const nodes = new Set<string>();
	const runNodes = runId
		? (
				await db.query<{ id: string; name: string | null; kind: string | null }>(
					`SELECT n->>'id' AS id, n->>'name' AS name, n->>'kind' AS kind
					 FROM model_run r, jsonb_array_elements(COALESCE(r.inputs->'model'->'nodes', '[]'::jsonb)) n
					 WHERE r.id = $1 AND r.project_id = $2`,
					[runId, projectId]
				)
			).rows
		: [];
	const { rows: projectNodes } = await db.query<{ id: string; name: string; kind: string }>('SELECT id::text AS id, name, kind FROM node WHERE project_id = $1', [projectId]);
	// The project's own names win: a node renamed since the run is called what it is called now.
	for (const n of [...runNodes, ...projectNodes]) {
		if (!n.id) continue;
		names.set(n.id, nodeWords(n));
		nodes.add(n.id);
	}
	const { rows: transfers } = await db.query<{ id: string; from_name: string | null; to_name: string | null }>(
		`SELECT t.id::text AS id, f.name AS from_name, d.name AS to_name
		 FROM transfer t LEFT JOIN node f ON f.id = t.from_node_id LEFT JOIN node d ON d.id = t.to_node_id
		 WHERE t.project_id = $1`,
		[projectId]
	);
	for (const t of transfers) names.set(t.id, `the transfer '${t.from_name ?? 'a node that no longer exists'} → ${t.to_name ?? 'outside the catchment'}'`);
	const { rows: series } = await db.query<{ id: string; name: string; kind: string }>('SELECT id::text AS id, name, kind FROM time_series WHERE project_id = $1', [projectId]);
	for (const s of series) names.set(s.id, `the series '${s.name || s.kind.replace(/_/g, ' ')}'`);
	return { names, nodes };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `value` with every id named (see the header). Pure, for the unit tests. */
export function nameIds(value: unknown, ids: IdNames): unknown {
	// Ids inside sentences: long enough not to match ordinary words; "gauge node <id>" and "node <id>" read as one name.
	const long = [...ids.names.keys()].filter((k) => k.length >= 8).sort((a, b) => b.length - a.length);
	const inText = long.length ? new RegExp(`(?:(?:the )?(?:gauge |unit )?node )?(${long.map(escapeRe).join('|')})`, 'g') : null;
	const text = (s: string): string => {
		const whole = ids.names.get(s);
		if (whole) return whole;
		return inText ? s.replace(inText, (_m, id: string) => ids.names.get(id) ?? id) : s;
	};
	// A node field holding a name (a tool's own echo) stays as it is; one holding an id that is no node now says so.
	const nodeRef = (v: unknown): unknown =>
		typeof v === 'string' ? (ids.nodes.has(v) ? ids.names.get(v)! : UUID.test(v) ? GONE_NODE : text(v)) : walk(v, '');
	const walk = (v: unknown, key: string): unknown => {
		if (typeof v === 'string') return key === 'id' ? v : NODE_FIELD.test(key) ? nodeRef(v) : text(v);
		if (Array.isArray(v)) return v.map((x) => (NODE_FIELD.test(key) ? nodeRef(x) : walk(x, key)));
		if (v === null || typeof v !== 'object') return v;
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) out[ids.names.get(k) ?? text(k)] = walk(x, k);
		return out;
	};
	return walk(value, '');
}

/** `tool` with its result's ids named before the model reads it. A tool that failed answers in words already. */
export function withIdNames(tool: AssistantTool): AssistantTool {
	return {
		...tool,
		async run(ctx: ToolContext, args: unknown) {
			const result = await tool.run(ctx, args);
			if (!result.ok) return result;
			const ids = await loadIdNames(ctx.db, ctx.projectId, ctx.runId ?? (await latestRunId(ctx.db, ctx.projectId)));
			return { ...result, data: nameIds(result.data, ids) };
		}
	};
}
