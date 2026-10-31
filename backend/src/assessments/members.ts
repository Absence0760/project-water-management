// An assessment's members as its jobs take them (145_assessment.sql): the
// copied ops, and how each enters combineScenarios. Shared by the assessment
// job (store.ts computeAssessment) and its firm-yield jobs (yields.ts).
import type { CombineScenario, ModelInput } from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { applicationMask } from '../scenarios/applicant.js';
import type { ScenarioRow } from '../scenarios/execute.js';

export interface MemberRow {
	id: string;
	position: number;
	scenarioId: string | null;
	name: string;
	origin: ScenarioRow['origin'];
	ops: ScenarioRow['ops'];
	ownedNodeIds: string[];
}

/** An assessment's members, in order (RLS: editor). */
export async function loadMembers(db: Db, assessmentId: string): Promise<MemberRow[]> {
	const { rows } = await db.query<MemberRow>(
		`SELECT id, position, scenario_id AS "scenarioId", name, origin, ops, owned_node_ids::text[] AS "ownedNodeIds"
		 FROM assessment_member WHERE assessment_id = $1 ORDER BY position`,
		[assessmentId]
	);
	return rows;
}

/** What combineScenarios takes for one scenario: an application's ops judged under its applicant's mask, as its own runs are (checkScenario). */
export function combineEntry(base: ModelInput, s: Pick<ScenarioRow, 'id' | 'name' | 'ops' | 'origin' | 'ownedNodeIds'>): CombineScenario {
	return { id: s.id, name: s.name, ops: s.ops, ...(s.origin === 'applicant' ? { mask: applicationMask(base, s.ownedNodeIds) } : {}) };
}

/** A member as a scenario: its scenario's id while it has one (else its own), name, copied ops, origin and own nodes. */
export const memberEntry = (m: MemberRow) => ({ id: m.scenarioId ?? m.id, name: m.name, ops: m.ops, origin: m.origin, ownedNodeIds: m.ownedNodeIds });
