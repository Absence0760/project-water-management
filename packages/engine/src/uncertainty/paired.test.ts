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
