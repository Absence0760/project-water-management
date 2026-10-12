// A licence's terms and what followed its decision (227_licence_terms,
// 228_decision_events, issue #523 G3/G4; docs/scenarios.md § Applications):
// the shapes the API returns and which ops a scenario counts with among the
// other applications on its baseline. Whether a licence is in force is the
// database's rule (app_scenario_licence), read into ScenarioRow.licence;
// this only picks the terms that rule names.
import type { ScenarioOp } from '@water-management/engine';
import type { ScenarioRow } from './execute.js';
import type { OpName } from './names.js';

/** A licence's granted terms (227): the "as licensed" ops, their hash and names, and the conditions in words. */
export interface LicenceTerms {
	ops: ScenarioOp[];
	opsSha256: string;
	opNames: OpName[];
	conditions: string;
	/** The ops are the ones applied for (the same hash). */
	asApplied: boolean;
	/** How many ops a viewer kept from each farm's volume doesn't get (viewerScenario); absent otherwise. */
	withheldOps?: number;
}

export type DecisionEventKind = 'lodged' | 'upheld' | 'set_aside' | 'varied';
export type DecisionEventForum = 'water_tribunal' | 'court';

/** One event after a decision (228): an appeal lodged, or its outcome. `terms` only on `varied`. */
export interface DecisionEvent {
	id: string;
	position: number;
	kind: DecisionEventKind;
	forum: DecisionEventForum;
	eventDate: string;
	reference: string;
	note: string;
	terms: LicenceTerms | null;
	recordedBy: string | null;
	recordedAt: string;
}

/** app_scenario_licence without its terms (they are grantedTerms, or the event's). */
export interface LicenceStanding {
	inForce: boolean;
	from: 'decision' | 'event';
	eventId: string | null;
	appealPending: boolean;
}

/** The terms a licence in force counts on (its decision's, or the newest variation's); null when none is in force. */
export function licensedTerms(s: Pick<ScenarioRow, 'licence' | 'grantedTerms' | 'decisionEvents'>): LicenceTerms | null {
	if (!s.licence?.inForce) return null;
	if (s.licence.from === 'decision') return s.grantedTerms;
	return s.decisionEvents.find((e) => e.id === s.licence!.eventId)?.terms ?? null;
}

/** The ops a scenario counts with among other applications (cumulative impact): a licence in force's terms, else the ops themselves. */
export function countedOps(s: Pick<ScenarioRow, 'ops' | 'opsSha256' | 'licence' | 'grantedTerms' | 'decisionEvents'>): { ops: ScenarioOp[]; opsSha256: string } {
	const t = licensedTerms(s);
	return t ? { ops: t.ops, opsSha256: t.opsSha256 } : { ops: s.ops, opsSha256: s.opsSha256 };
}
