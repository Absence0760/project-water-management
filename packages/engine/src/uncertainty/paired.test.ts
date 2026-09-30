// The paired summary's Reserve share (issue #71, docs/design/evidence-report.md
// ER4, D-U3): beside each site's band on the change in months met, the share
// of the pairs in which the other run meets fewer months.
import { describe, expect, it } from 'vitest';
import type { EnsembleHeader, MemberMetrics, MemberResult } from './ensemble';
import type { ResolvedEnsembleOptions } from './options';
import { summarisePaired } from './paired';

const metrics = (reserve: Record<string, number | null>): MemberMetrics => ({
	ewrDaysNotMet: 0,
	ewrDaysNotMetByMonth: new Array(12).fill(0),
	shortfallMm3: 0,
	marNaturalMm3: 1,
	marOutflowMm3: 1,
	annualNaturalMm3: [],
	annualOutflowMm3: [],
	curtailmentM3Day: {},
	reserveRate: reserve,
	fdcM3Day: []
});

const header = (sites: string[]): EnsembleHeader => ({
	startDate: '2000-10-01',
	days: 365,
	splitDate: '2001-04-01',
	waterYears: [],
	farms: [],
	reserveSites: sites.map((key) => ({ key, name: key })),
	fdcPoints: [],
	monthDays: [],
	ewrByMonthM3Day: [],
	records: [],
	wr2012Band: null,
	hasWr2012: false
});

function pair(n: number, base: (i: number) => Record<string, number | null>, other: (i: number) => Record<string, number | null>, minMembers = 30) {
	const members = Array.from({ length: n }, (_, i) => ({ index: i + 1, accepted: true, metrics: metrics(base(i)) }) as unknown as MemberResult);
	const options = { minMembers, seed: 7, members: n, percentiles: [5, 50, 95] } as unknown as ResolvedEnsembleOptions;
	const sites = Object.keys(base(0));
	return summarisePaired(
		{ options, header: header(sites), members },
		{ header: header(sites), members: members.map((m, i) => ({ index: m.index, metrics: metrics(other(i)) })) }
	);
}

describe('summarisePaired: the Reserve share worse (ER4)', () => {
	it('counts the pairs in which the other run meets fewer months', () => {
		// 40 pairs: 30 lower, 6 equal, 4 higher.
		const s = pair(40, () => ({ outlet: 0.6 }), (i) => ({ outlet: i < 30 ? 0.55 : i < 36 ? 0.6 : 0.65 }));
		expect(s.reserve).toHaveLength(1);
		expect(s.reserve[0]!.worse).toBeCloseTo(30 / 40, 12);
		expect(s.reserve[0]!.band.p50).toBeCloseTo(-0.05, 12);
	});

	it('is 0 for identical runs (positive control above), and null below the gate or without rates', () => {
		expect(pair(40, () => ({ outlet: 0.6 }), () => ({ outlet: 0.6 })).reserve[0]!.worse).toBe(0);
		expect(pair(20, () => ({ outlet: 0.6 }), () => ({ outlet: 0.5 })).reserve[0]!.worse).toBeNull();
		expect(pair(40, () => ({ outlet: null }), () => ({ outlet: null })).reserve[0]!.worse).toBeNull();
	});
});

/** A pair set whose members carry only an outlet Reserve FDC curve: `curve(i)` is member i's impacted flow at each table point in October (water-year month 0); other months empty. */
function fdcPair(n: number, base: (i: number) => (number | null)[], other: (i: number) => (number | null)[], minMembers = 30) {
	const withFdc = (points: (number | null)[]): MemberMetrics => ({ ...metrics({ outlet: 0.5 }), reserveFdc: { outlet: [points, ...Array.from({ length: 11 }, () => [])] } });
	const members = Array.from({ length: n }, (_, i) => ({ index: i + 1, accepted: true, metrics: withFdc(base(i)) }) as unknown as MemberResult);
	const options = { minMembers, seed: 7, members: n, percentiles: [5, 50, 95] } as unknown as ResolvedEnsembleOptions;
	return summarisePaired(
		{ options, header: header(['outlet']), members },
		{ header: header(['outlet']), members: members.map((m, i) => ({ index: m.index, metrics: withFdc(other(i)) })) }
	).reserveFdcChange!;
}

describe('summarisePaired: the paired change in the Reserve FDC check curve (evidence-7)', () => {
	// Each set's own curve spreads widely (0.1 × i), so two bands on the runs' own curves would overlap however the curve moves.
	const spread = (i: number) => [1 + 0.1 * i, 0.5 + 0.05 * i, 0.2 + 0.01 * i];

	it('identical runs give a zero band and no set worse', () => {
		const [site] = fdcPair(40, spread, spread);
		expect(site!.key).toBe('outlet');
		expect(site!.months).toHaveLength(12);
		expect(site!.months[0]).toHaveLength(3);
		for (const p of site!.months[0]!) {
			expect(p.band).toMatchObject({ n: 40, p5: 0, p50: 0, p95: 0 });
			expect(p.worse).toBe(0);
		}
		// Months without a curve carry no points.
		expect(site!.months[1]).toEqual([]);
	});

	it('a uniform shift gives a tight band at the shift, whatever each set’s own curve, and every set worse (or none)', () => {
		const down = fdcPair(40, spread, (i) => spread(i).map((v) => v - 0.05));
		for (const p of down[0]!.months[0]!) {
			expect(p.band.p5).toBeCloseTo(-0.05, 12);
			expect(p.band.p50).toBeCloseTo(-0.05, 12);
			expect(p.band.p95).toBeCloseTo(-0.05, 12);
			expect(p.worse).toBe(1);
		}
		const up = fdcPair(40, spread, (i) => spread(i).map((v) => v + 0.02));
		for (const p of up[0]!.months[0]!) {
			expect(p.band.p50).toBeCloseTo(0.02, 12);
			expect(p.worse).toBe(0);
		}
	});

	it('counts worse per point over the pairs with a flow on both sides, and gates below the minimum', () => {
		// Point 0: 10 of 40 lower. Point 1: 30 pairs with a flow on both sides, all lower. Point 2: 20 pairs only (gated).
		const [site] = fdcPair(
			40,
			(i) => [1, 0.5, i < 20 ? 0.2 : null],
			(i) => [i < 10 ? 0.9 : 1, i < 30 ? 0.4 : null, 0.1]
		);
		const [p0, p1, p2] = site!.months[0]!;
		expect(p0!.worse).toBeCloseTo(10 / 40, 12);
		expect(p1!.band.n).toBe(30);
		expect(p1!.worse).toBe(1);
		expect(p2!.band).toMatchObject({ n: 20, p50: null });
		expect(p2!.worse).toBeNull();
	});
});
