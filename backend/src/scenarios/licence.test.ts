// Which ops a scenario counts with among the other applications on its
// baseline (licence.ts; 227_licence_terms, 228_decision_events): the database
// says whether its licence is in force and from what; this picks those terms.
import type { ScenarioOp } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { countedOps, licensedTerms, type DecisionEvent, type LicenceTerms } from './licence.js';

const node = crypto.randomUUID();
const dam = (value: number): ScenarioOp[] => [{ op: 'node.set', nodeId: node, field: 'damCapacityM3', value }];
const terms = (value: number, sha: string): LicenceTerms => ({ ops: dam(value), opsSha256: sha, opNames: [], conditions: '', asApplied: false });
const event = (id: string, kind: DecisionEvent['kind'], t: LicenceTerms | null = null): DecisionEvent => ({
	id,
	position: 1,
	kind,
	forum: 'water_tribunal',
	eventDate: '2026-10-01',
	reference: '',
	note: '',
	terms: t,
	recordedBy: null,
	recordedAt: '2026-10-01T00:00:00Z'
});
const applied = { ops: dam(200_000), opsSha256: 'a'.repeat(64) };

describe('countedOps', () => {
	it('is the scenario’s own ops while nothing is decided, or no licence is in force (refused, set aside)', () => {
		expect(countedOps({ ...applied, licence: null, grantedTerms: null, decisionEvents: [] })).toEqual(applied);
		expect(countedOps({ ...applied, licence: { inForce: false, from: 'decision', eventId: null, appealPending: false }, grantedTerms: null, decisionEvents: [] })).toEqual(applied);
		const granted = terms(150_000, 'b'.repeat(64));
		const setAside = { inForce: false, from: 'event' as const, eventId: 'e2', appealPending: false };
		expect(countedOps({ ...applied, licence: setAside, grantedTerms: granted, decisionEvents: [event('e1', 'lodged'), event('e2', 'set_aside')] })).toEqual(applied);
	});

	it('is the granted terms of a licence in force from its decision, not the ops applied for', () => {
		const granted = terms(150_000, 'b'.repeat(64));
		const s = { ...applied, licence: { inForce: true, from: 'decision' as const, eventId: null, appealPending: true }, grantedTerms: granted, decisionEvents: [event('e1', 'lodged')] };
		expect(countedOps(s)).toEqual({ ops: dam(150_000), opsSha256: 'b'.repeat(64) });
		expect(licensedTerms(s)).toBe(granted);
	});

	it('is the newest variation’s terms when the licence stands from an event', () => {
		const granted = terms(150_000, 'b'.repeat(64));
		const varied = terms(170_000, 'c'.repeat(64));
		const s = {
			...applied,
			licence: { inForce: true, from: 'event' as const, eventId: 'e2', appealPending: false },
			grantedTerms: granted,
			decisionEvents: [event('e1', 'lodged'), event('e2', 'varied', varied)]
		};
		expect(countedOps(s)).toEqual({ ops: dam(170_000), opsSha256: 'c'.repeat(64) });
	});
});
