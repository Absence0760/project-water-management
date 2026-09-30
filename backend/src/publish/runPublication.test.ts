// The pure choice behind GET …/runs/:runId/publication (issue #70): a run's
// own publication and the one to compare it with.
import { describe, expect, it } from 'vitest';
import { placeInPublications } from './runPublication.js';

const at = (id: string, run_id: string, superseded: boolean) => ({ id, run_id, superseded_at: superseded ? new Date('2026-09-01T00:00:00Z') : null });

describe('placeInPublications', () => {
	// Newest first, as the query orders them.
	const rows = [at('p4', 'r3', false), at('p3', 'r2', true), at('p2', 'r2', true), at('p1', 'r1', true)];

	it('gives a published run its newest publication and the newest earlier one of another run', () => {
		expect(placeInPublications(rows, 'r3')).toEqual({ own: rows[0], previous: rows[1] });
		// Published twice: the newest is its own, and its own earlier one is skipped.
		expect(placeInPublications(rows, 'r2')).toEqual({ own: rows[1], previous: rows[3] });
		expect(placeInPublications(rows, 'r1')).toEqual({ own: rows[3], previous: null });
	});

	it('has nothing before a run whose earlier publications are all its own', () => {
		const again = [at('b', 'r1', false), at('a', 'r1', true)];
		expect(placeInPublications(again, 'r1')).toEqual({ own: again[0], previous: null });
	});

	it('compares a run never published with the current publication', () => {
		expect(placeInPublications(rows, 'r9')).toEqual({ own: null, previous: rows[0] });
		// None current (every one superseded): nothing to compare with.
		expect(placeInPublications(rows.slice(1), 'r9')).toEqual({ own: null, previous: null });
		expect(placeInPublications([], 'r9')).toEqual({ own: null, previous: null });
	});
});
