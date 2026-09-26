// The display names a scenario's ops need (044_scenario_op_names,
// docs/scenarios.md § Backend). An op targets a node or crop by id; the editor
// names it from the base run's snapshot, which after a rebase may no longer
// have it. So the API keeps `{ id, name }` for every node and crop the ops
// name, captured from the base run's snapshot whenever the ops or the base
// are written.
import type { ProjectModel, ScenarioOp } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { opIds } from './schema.js';

export interface OpName {
	id: string;
	name: string;
}

type Names = Pick<ProjectModel, 'nodes' | 'crops'>;

/**
 * The names `ops` need: every id an op names that `model` (the base run's
 * snapshot) has a node or crop for, plus the `kept` names of ids the model
 * doesn't have (a node a rebase dropped). The model's name wins over a kept
 * one; ids no op names any more are dropped. Sorted by id.
 */
export function opNames(ops: readonly ScenarioOp[], model: Names | null, kept: readonly OpName[]): OpName[] {
	const ids = new Set<string>();
	for (const op of ops) for (const [, v] of opIds(op)) if (typeof v === 'string') ids.add(v);
	const names = new Map<string, string>();
	for (const k of kept) if (ids.has(k.id)) names.set(k.id, k.name);
	for (const x of [...(model?.nodes ?? []), ...(model?.crops ?? [])]) if (ids.has(x.id)) names.set(x.id, x.name);
	return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The nodes and crops of a run's model snapshot (`model_run.inputs.model`), under the caller's RLS; null when there's none. */
export async function snapshotNames(db: Db, runId: string): Promise<Names | null> {
	const { rows } = await db.query<{ model: Partial<ProjectModel> | null }>(`SELECT inputs->'model' AS model FROM model_run WHERE id = $1`, [runId]);
	const m = rows[0]?.model;
	return m ? { nodes: m.nodes ?? [], crops: m.crops ?? [] } : null;
}
