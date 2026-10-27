import { describe, expect, it } from 'vitest';
import type { DamOutlineGeometry, Position } from './handover.js';
import { bboxOf, MATCH_WATERBODY_SHARE, matchDam, MIN_DAM_SHARE, planarArea } from './match.js';

/** A rectangle w × h degrees from (x, y), closed. */
const rect = (x: number, y: number, w: number, h = w): Position[] => [
	[x, y],
	[x + w, y],
	[x + w, y + h],
	[x, y + h],
	[x, y]
];
const poly = (...rings: Position[][]): DamOutlineGeometry => ({ type: 'Polygon', coordinates: rings });
const multi = (...polys: Position[][][]): DamOutlineGeometry => ({ type: 'MultiPolygon', coordinates: polys });
const dam = poly(rect(21.3, -33.7, 0.01));

describe('matchDam', () => {
	it('matches the waterbody that is essentially the dam', () => {
		// The historical extent a little smaller than the traced outline.
		const r = matchDam(dam, [{ uid: 'zzzzza0001', geometry: poly(rect(21.3005, -33.6995, 0.009)) }]);
		expect(r).toEqual({ status: 'matched', uid: 'zzzzza0001', damShare: 0.81, waterbodyShare: 1 });
	});

	it('still matches a waterbody that spills a little past the outline', () => {
		const r = matchDam(dam, [{ uid: 'zzzzza0001', geometry: poly(rect(21.3, -33.7, 0.0125, 0.01)) }]);
		expect(r.status).toBe('matched');
		expect(r.waterbodyShare).toBe(0.8);
	});

	it('calls it merged when the waterbody also holds other water', () => {
		// The dam is a third of a long waterbody (two dams whose water joins).
		const r = matchDam(dam, [{ uid: 'zzzzza0001', geometry: poly(rect(21.3, -33.7, 0.03, 0.01)) }]);
		expect(r).toMatchObject({ status: 'merged', uid: 'zzzzza0001', damShare: 1 });
		expect(r.waterbodyShare!).toBeLessThan(MATCH_WATERBODY_SHARE);
	});

	it('calls it merged when the dam is split over two waterbodies', () => {
		const r = matchDam(dam, [
			{ uid: 'zzzzza0001', geometry: poly(rect(21.3, -33.7, 0.006, 0.01)) },
			{ uid: 'zzzzza0002', geometry: poly(rect(21.306, -33.7, 0.004, 0.01)) }
		]);
		expect(r).toMatchObject({ status: 'merged', uid: 'zzzzza0001', damShare: 0.6, waterbodyShare: 1 });
	});

	it('ignores a tiny neighbour touching the edge', () => {
		const r = matchDam(dam, [
			{ uid: 'zzzzza0001', geometry: poly(rect(21.3, -33.7, 0.01)) },
			{ uid: 'zzzzza0002', geometry: poly(rect(21.3095, -33.7, 0.002, 0.002)) }
		]);
		expect(r.status).toBe('matched');
	});

	it('finds none with no candidate, or one covering too little of the dam (a dam under 0.45 ha is never in Waterbodies)', () => {
		expect(matchDam(dam, [])).toEqual({ status: 'none', uid: null, damShare: null, waterbodyShare: null });
		expect(matchDam(dam, [{ uid: 'zzzzza0001', geometry: poly(rect(21.4, -33.7, 0.01)) }]).status).toBe('none');
		const corner = matchDam(dam, [{ uid: 'zzzzza0001', geometry: poly(rect(21.305, -33.695, 0.01)) }]);
		expect(corner.status).toBe('none');
		expect(0.25).toBeLessThan(MIN_DAM_SHARE);
	});

	it('reads a MultiPolygon dam and a waterbody with a hole (an island)', () => {
		const two = multi([rect(21.3, -33.7, 0.004, 0.01)], [rect(21.306, -33.7, 0.004, 0.01)]);
		expect(planarArea(two)).toBeCloseTo(0.00008, 12);
		bboxOf(two).forEach((v, i) => expect(v).toBeCloseTo([21.3, -33.7, 21.31, -33.69][i]!, 9));
		const r = matchDam(two, [{ uid: 'zzzzza0001', geometry: poly(rect(21.3, -33.7, 0.01), rect(21.304, -33.698, 0.002, 0.006)) }]);
		// The island covers none of the dam; the waterbody (less its island) is 0.000088°², 0.00008 of it the dam.
		expect(r).toMatchObject({ status: 'matched', damShare: 1 });
		expect(r.waterbodyShare).toBeCloseTo(0.9091, 4);
	});
});
