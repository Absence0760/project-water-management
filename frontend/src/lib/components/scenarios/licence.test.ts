import { describe, expect, it } from 'vitest';
import type { DecisionEvent, LicenceTerms } from '#lib/api/types.js';
import { earliestEventDate, eventHeading, licensedTerms, licenceLine, nextEvents } from './licence';

const terms = (v: number): LicenceTerms => ({
	ops: [{ op: 'node.set', nodeId: 'n', field: 'damCapacityM3', value: v }],
	opsSha256: String(v).padStart(64, '0'),
	opNames: [],
	conditions: '',
	asApplied: false
});
const ev = (id: string, kind: DecisionEvent['kind'], over: Partial<DecisionEvent> = {}): DecisionEvent => ({
	id,
	position: 1,
	kind,
	forum: 'water_tribunal',
	eventDate: '2026-10-02',
	reference: '',
	note: '',
	terms: null,
	recordedBy: 'Assessor',
	recordedAt: '2026-10-02T08:00:00Z',
	...over
});

describe('licenceLine', () => {
	it('says an issued licence counts on its granted terms, and nothing changes while an appeal is open', () => {
		expect(licenceLine({ outcome: 'licence_issued', licence: { inForce: true, from: 'decision', eventId: null, appealPending: false }, decisionEvents: [] })).toBe(
			'The licence counts in cumulative assessments on its granted terms, not the changes applied for.'
		);
		expect(licenceLine({ outcome: 'licence_issued', licence: { inForce: true, from: 'decision', eventId: null, appealPending: true }, decisionEvents: [ev('e1', 'lodged')] })).toBe(
			'The licence counts in cumulative assessments on its granted terms, not the changes applied for. An appeal is lodged with the Water Tribunal: nothing changes until it is decided.'
		);
	});

	it('names the event a licence stands or falls on', () => {
		const events = [ev('e1', 'lodged'), ev('e2', 'set_aside', { eventDate: '2026-10-05' })];
		expect(licenceLine({ outcome: 'licence_issued', licence: { inForce: false, from: 'event', eventId: 'e2', appealPending: false }, decisionEvents: events })).toBe(
			'Set aside (Water Tribunal, 5 Oct 2026): it no longer counts in cumulative assessments.'
		);
		const varied = [...events, ev('e3', 'lodged', { forum: 'court' }), ev('e4', 'varied', { forum: 'court', eventDate: '2026-10-08', terms: terms(140) })];
		expect(licenceLine({ outcome: 'licence_issued', licence: { inForce: true, from: 'event', eventId: 'e4', appealPending: false }, decisionEvents: varied })).toBe(
			'The licence counts in cumulative assessments on the terms it was varied to (Court, 8 Oct 2026).'
		);
	});

	it('says a refusal counts for nothing, and has no line before a decision', () => {
		expect(licenceLine({ outcome: 'licence_refused', licence: { inForce: false, from: 'decision', eventId: null, appealPending: false }, decisionEvents: [] })).toBe(
			'No licence was issued, so it doesn’t count in cumulative assessments.'
		);
		expect(licenceLine({ outcome: null, licence: null, decisionEvents: [] })).toBeNull();
	});
});

describe('licensedTerms', () => {
	it('is the granted terms, the variation’s, or none', () => {
		const granted = terms(150);
		expect(licensedTerms({ licence: { inForce: true, from: 'decision', eventId: null, appealPending: false }, grantedTerms: granted, decisionEvents: [] })).toBe(granted);
		const varied = terms(140);
		expect(
			licensedTerms({ licence: { inForce: true, from: 'event', eventId: 'e2', appealPending: false }, grantedTerms: granted, decisionEvents: [ev('e1', 'lodged'), ev('e2', 'varied', { terms: varied })] })
		).toBe(varied);
		expect(licensedTerms({ licence: { inForce: false, from: 'event', eventId: 'e2', appealPending: false }, grantedTerms: granted, decisionEvents: [] })).toBeNull();
	});
});

describe('nextEvents and earliestEventDate', () => {
	it('offers an appeal after the decision or an outcome, and only its outcome, in its forum, while one is open', () => {
		expect(nextEvents([])).toEqual({ kinds: ['lodged'], forum: null });
		expect(nextEvents([ev('e1', 'lodged', { forum: 'court' })])).toEqual({ kinds: ['upheld', 'set_aside', 'varied'], forum: 'court' });
		expect(nextEvents([ev('e1', 'lodged'), ev('e2', 'upheld')])).toEqual({ kinds: ['lodged'], forum: null });
	});

	it('dates the next event no earlier than the last one, else the decision letter', () => {
		expect(earliestEventDate({ decisionDate: '2026-09-30', decisionEvents: [] })).toBe('2026-09-30');
		expect(earliestEventDate({ decisionDate: '2026-09-30', decisionEvents: [ev('e1', 'lodged', { eventDate: '2026-10-02' })] })).toBe('2026-10-02');
		expect(earliestEventDate({ decisionDate: null, decisionEvents: [] })).toBeNull();
		expect(eventHeading(ev('e1', 'set_aside'))).toBe('Decision set aside: Water Tribunal, 2 Oct 2026');
	});
});
