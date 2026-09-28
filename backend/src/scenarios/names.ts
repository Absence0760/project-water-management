// The display names a scenario's ops need (047_scenario_op_names,
// docs/scenarios.md § Backend). An op targets a node or crop by id; the editor
// names it from the base run's snapshot, which after a rebase may no longer
// have it. So the API keeps `{ id, name }` for every node and crop the ops
// name, captured from the base run's snapshot whenever the ops or the base
// are written.
//
// Applicants (WP-3.3): the names are captured from the full base, server-side
// (an applicant can't read the base run's row), and an applicant is only ever
// shown the names of the scenario's own nodes (applicantOpNames): every other
// node is anonymised in what they see of the base, so its real name must not
// reach them through op_names either.
import type { ProjectModel, ScenarioOp } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import type { Role } from '../projects/access.js';
import { loadBaseInput } from './execute.js';
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

/**
 * The nodes and crops of the base run the names come from. An editor's is the
 * run's snapshot under RLS; a contributor can't read that row, so theirs is
 * the full published base (loadBaseInput), kept server-side: only the names
 * go into op_names, and applicantOpNames filters them on the way out. Null
 * when the base can't be rebuilt (the earlier names are kept).
 */
export async function baseNames(db: Db, projectId: string, runId: string, role: Role): Promise<Names | null> {
	if (role !== 'contributor') return snapshotNames(db, runId);
	try {
		return (await loadBaseInput(db, projectId, runId, role)).model;
	} catch (err) {
		if (err instanceof ApiError && err.status === 409) return null;
		throw err;
	}
}

/**
 * op_names as a caller in `role` may see them: in full for the team; for a
 * contributor (an applicant, or someone they shared the application with)
 * only the scenario's own nodes (its owner's farm links, which the applicant
 * projection shows in full). Every other name, a neighbour's farm or a crop
 * on it, is dropped: the projection anonymises those nodes. Fails closed: a
 * gauge a rebase dropped then reads as unknown to an applicant.
 */
export function applicantOpNames<T extends { opNames: OpName[]; ownedNodeIds: string[] }>(s: T, role: Role): T {
	if (role !== 'contributor') return s;
	return ownNames(s);
}

/**
 * Only the names of `s`'s own nodes: what an application stores (047), since
 * its applicant sees every other node under an anonymous name.
 */
export function ownNames<T extends { opNames: OpName[]; ownedNodeIds: string[] }>(s: T): T {
	const own = new Set(s.ownedNodeIds);
	return { ...s, opNames: s.opNames.filter((x) => own.has(x.id)) };
}
