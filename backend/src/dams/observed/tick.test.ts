// The dams tick's pure parts (issue #604 R5): which stale dams it matches
// first, and the digest a Waterbodies file's load mark keeps of the dams it
// reached. The tick itself is in tick.db.test.ts.
import { describe, expect, it } from 'vitest';
import { matchQueue, targetsDigest } from './tick.js';

const dam = (id: string, stale = true) => ({ feature_id: id, match_stale: stale });

describe('matchQueue', () => {
	it('takes the stale dams in the order listed (oldest traced first), up to the cap', () => {
		const q = matchQueue([dam('a'), dam('b', false), dam('c'), dam('d')], new Map(), 2);
		expect(q.map((d) => d.feature_id)).toEqual(['a', 'c']);
	});

	it('puts the dams whose match failed after the rest, oldest failure first, so they can’t hold every slot', () => {
		// a and b failed (b first); c and d never did: c and d go first even though a and b were traced earlier.
		const failed = new Map([
			['a', 2_000],
			['b', 1_000]
		]);
		expect(matchQueue([dam('a'), dam('b'), dam('c'), dam('d')], failed, 2).map((d) => d.feature_id)).toEqual(['c', 'd']);
		expect(matchQueue([dam('a'), dam('b'), dam('c'), dam('d')], failed, 4).map((d) => d.feature_id)).toEqual(['c', 'd', 'b', 'a']);
	});
});

describe('targetsDigest', () => {
	const at = new Date('2026-10-01T08:00:00.123Z');
	it('is the same for the same dams in any order', () => {
		const a = { feature_id: '00000000-0000-4000-8000-000000000001', matched_at: at };
		const b = { feature_id: '00000000-0000-4000-8000-000000000002', matched_at: at };
		expect(targetsDigest([a, b])).toBe(targetsDigest([b, a]));
		expect(targetsDigest([a, b])).toMatch(/^[0-9a-f]{64}$/);
	});

	it('changes when a dam joins or is matched again (a redraw, a reload of the reference set)', () => {
		const a = { feature_id: '00000000-0000-4000-8000-000000000001', matched_at: at };
		const b = { feature_id: '00000000-0000-4000-8000-000000000002', matched_at: at };
		expect(targetsDigest([a])).not.toBe(targetsDigest([a, b]));
		expect(targetsDigest([a])).not.toBe(targetsDigest([{ ...a, matched_at: new Date(at.getTime() + 1) }]));
	});
});
