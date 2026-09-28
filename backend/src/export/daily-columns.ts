// One scope's daily run series (a node's, or the catchment's when nodeId is
// null) in the daily CSV's column order and with its headers. Shared by
// `…/export/daily.csv` and `…/runs/:runId/series/bulk` (the browser-built
// .xlsx workbook), so the workbook's columns can't drift from the CSV's.
import type { RunSummary } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { seriesHeader } from './csv.js';
import { nodeColumnHeader, seriesKeyOrder } from './run-tables.js';

export interface DailySeries {
	key: string;
	label: string;
	unit: string | null;
	/** The daily CSV's column header: `label (unit)`, a node's `label [letter] (unit)`. */
	header: string;
	values: (number | null)[];
}

export interface DailyScope {
	/** The node's current name (the run's name for a deleted node), or 'catchment'. */
	name: string;
	kind: 'catchment' | 'farm' | 'gauge' | 'user';
	series: DailySeries[];
}

/** Null when the run has no series for that scope (unknown node, or not this run's). */
export async function loadDailyScope(db: Db, runId: string, nodeId: string | null, summary: RunSummary): Promise<DailyScope | null> {
	const { rows } = await db.query<{ key: string; label: string | null; unit: string | null; values: (number | null)[] }>(
		`SELECT key, meta->>'label' AS label, meta->>'unit' AS unit, "values"
		 FROM run_series WHERE run_id = $1 AND node_id IS NOT DISTINCT FROM $2::uuid`,
		[runId, nodeId]
	);
	if (!rows.length) return null;
	const order = seriesKeyOrder(nodeId ? 'node' : 'catchment');
	rows.sort((a, b) => order(a.key, b.key));

	let name = 'catchment';
	let kind: DailyScope['kind'] = 'catchment';
	if (nodeId) {
		const { rows: n } = await db.query<{ name: string; kind: 'farm' | 'gauge' | 'user' }>('SELECT name, kind FROM node WHERE id = $1', [nodeId]);
		const fromSummary = summary.farms.find((f) => f.nodeId === nodeId)?.name;
		name = n[0]?.name ?? fromSummary ?? 'node';
		// A deleted node: a farm has a demand series, a gauge doesn't.
		kind = n[0]?.kind ?? (rows.some((r) => r.key === 'demand') ? 'farm' : 'gauge');
	}
	const nodeKind = kind === 'catchment' ? null : kind;
	return {
		name,
		kind,
		series: rows.map((r) => ({
			key: r.key,
			label: r.label ?? r.key,
			unit: r.unit,
			header: nodeKind ? nodeColumnHeader(r.key, r.label ?? r.key, r.unit, nodeKind) : seriesHeader(r.label ?? r.key, r.unit),
			values: r.values
		}))
	};
}
