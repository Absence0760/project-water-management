import { describe, expect, it } from 'vitest';
import { runEvidence, type Nomination } from './evidence.js';

const n = (runId: string, day: number, reason = `r${day}`): Nomination => ({
	id: `n${day}`,
	withdrawn: false,
	runId,
	runLabel: `Run ${runId.toUpperCase()}`,
	runCreatedAt: '2026-09-01T00:00:00.000Z',
	runoffModel: 'gr4j',
	engineVersion: '0.19.2',
	reason,
	nominatedAt: `2026-09-${String(day).padStart(2, '0')}T08:00:00.000Z`,
	nominatedBy: 'Ann'
});

describe('runEvidence', () => {
	it('is null for a run the history never names, and for an empty history', () => {
		expect(runEvidence([], 'a')).toBeNull();
		expect(runEvidence([n('a', 1)], 'b')).toBeNull();
	});

	it('marks the newest nomination current, with no replacement', () => {
		expect(runEvidence([n('a', 1), n('b', 2)], 'b')).toEqual({
			status: 'current',
			nominatedAt: '2026-09-02T08:00:00.000Z',
			nominatedBy: 'Ann',
			reason: 'r2',
			replacedBy: null
		});
	});

	it('marks an earlier one past and names the nomination that replaced it', () => {
		expect(runEvidence([n('a', 1), n('b', 2)], 'a')).toMatchObject({
			status: 'past',
			reason: 'r1',
			replacedBy: { runId: 'b', runLabel: 'Run B', nominatedAt: '2026-09-02T08:00:00.000Z', reason: 'r2' }
		});
	});

	it('reads a run nominated twice by its latest nomination (A, B, A: A is current again)', () => {
		const h = [n('a', 1), n('b', 2), n('a', 3)];
		expect(runEvidence(h, 'a')).toMatchObject({ status: 'current', reason: 'r3', replacedBy: null });
		expect(runEvidence(h, 'b')).toMatchObject({ status: 'past', replacedBy: { runId: 'a', reason: 'r3' } });
	});

	it('a withdrawal (098) makes the nomination before it past, "withdrawn" rather than replaced, and names no run', () => {
		const w: Nomination = { ...n('x', 3, 'application lapsed'), withdrawn: true, runId: null, runLabel: null, runCreatedAt: null, runoffModel: null, engineVersion: null };
		expect(runEvidence([n('a', 1), w], 'a')).toMatchObject({
			status: 'past',
			replacedBy: { withdrawn: true, runId: null, runLabel: null, nominatedAt: '2026-09-03T08:00:00.000Z', reason: 'application lapsed' }
		});
		// Nominated again after the withdrawal: current again, and the control (a replacement) is not a withdrawal.
		expect(runEvidence([n('a', 1), w, n('a', 4)], 'a')).toMatchObject({ status: 'current', replacedBy: null });
		expect(runEvidence([n('a', 1), n('b', 2)], 'a')?.replacedBy?.withdrawn).toBe(false);
	});

	it('writes timestamps as ISO strings whether pg hands back a Date or a string', () => {
		const fromPg = { ...n('a', 1), nominatedAt: new Date('2026-09-01T08:00:00Z') as unknown as string };
		expect(runEvidence([fromPg], 'a')?.nominatedAt).toBe('2026-09-01T08:00:00.000Z');
	});
});
