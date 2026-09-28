// The double-mass proposal for the CHIRPS fit period (issue #40). Synthetic records only.
import { describe, expect, it } from 'vitest';
import { resolveChirpsFitPeriod, type DailySeries } from '@water-management/engine';
import { proposalFrom } from './fitRangeProposal';

/** `ratios[k]` × CHIRPS for water year 1990 + k; CHIRPS on every third day, wetter in winter. */
function records(ratios: number[]): { c: DailySeries; h: DailySeries } {
	const base = [0, 2, 2, 4, 6, 10, 12, 12, 10, 6, 4, 3, 2];
	const c: number[] = [];
	const h: number[] = [];
	const t0 = Date.UTC(1990, 9, 1);
	const end = Date.UTC(1990 + ratios.length, 9, 1);
	for (let t = t0, i = 0; t < end; t += 86_400_000, i++) {
		const d = new Date(t);
		const month = d.getUTCMonth() + 1;
		const k = d.getUTCFullYear() - 1990 - (month >= 10 ? 0 : 1);
		const v = i % 3 === 0 ? base[month]! * (0.8 + 0.4 * ((k * 7) % 5) / 4) : 0;
		h.push(v);
		c.push(v * ratios[k]!);
	}
	return { c: { startDate: '1990-10-01', values: c }, h: { startDate: '1990-10-01', values: h } };
}

describe('proposalFrom', () => {
	it('proposes one range per double-mass segment, valid as a setting, for the hydrologist to check', () => {
		const { c, h } = records([...new Array(10).fill(2), ...new Array(10).fill(1.2)]);
		const r = proposalFrom(c, h, null);
		expect('ranges' in r).toBe(true);
		if (!('ranges' in r)) return;
		expect(r.ranges.map((x) => [x.fromWaterYear, x.toWaterYear])).toEqual([
			[1990, 1999],
			[2000, 2009]
		]);
		expect(r.ranges.every((x) => /^proposed from the double-mass check/.test(x.reason))).toBe(true);
		const w: string[] = [];
		expect(resolveChirpsFitPeriod(r.ranges, w)).toEqual(r.ranges);
		expect(w).toEqual([]);
	});

	it('says why there is nothing to propose', () => {
		const steady = records(new Array(20).fill(2));
		expect(proposalFrom(steady.c, steady.h, null)).toEqual({ reason: expect.stringMatching(/finds no break/) });
		const short = records(new Array(5).fill(2));
		expect(proposalFrom(short.c, short.h, null)).toEqual({ reason: expect.stringMatching(/too short/) });
		expect(proposalFrom(steady.c, null, null)).toEqual({ reason: expect.stringMatching(/needs a catchment rain series and a CHIRPS series/) });
	});
});
