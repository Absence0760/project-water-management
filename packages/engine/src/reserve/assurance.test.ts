// EWR compliance by the Reserve's assurance rules (docs/model.md §2.9c):
// worked examples, then the invariants on random series and random networks:
// natural flow meets any table whose EWR is at most its natural curve, the
// requirement depends only on natural flow, and less flow can only lose months.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModel, runModelWith } from '../run';
import { cloneInput, randomInput } from '../testing/fuzz';
import { assessSite, assuranceWarnings, completeMonths, durationQuantile, lookupRequirement, runningMin, type EwrAssuranceSite } from './assurance';
import { DEFAULT_ASSURANCE_POINTS, type EwrRuleTable } from './rules';

const rows = (row: number[]) => Array.from({ length: 12 }, () => [...row]);

function table(over: Partial<EwrRuleTable> = {}): EwrRuleTable {
	return {
		siteNodeId: null,
		source: 'Synthetic',
		component: 'total',
		unit: 'mcm',
		points: [10, 50, 90],
		ewr: rows([1.5, 1, 0.5]),
		naturalSource: 'table',
		natural: rows([3, 2, 1]),
		scale: 1,
		...over
	};
}

/** Daily m³ so that each calendar month's total is `monthM3(year, month)`. */
function daily(startDate: string, days: number, monthM3: (year: number, month: number) => number): Float64Array {
	const d0 = toEpochDay(startDate);
	const out = new Float64Array(days);
	for (let t = 0; t < days; t++) {
		const d = new Date((d0 + t) * 86_400_000);
		const y = d.getUTCFullYear();
		const m = d.getUTCMonth() + 1;
		const len = new Date(Date.UTC(y, m, 0)).getUTCDate();
		out[t] = monthM3(y, m) / len;
	}
	return out;
}

const daysBetween = (a: string, b: string) => toEpochDay(b) - toEpochDay(a) + 1;

describe('durationQuantile (Weibull plotting positions)', () => {
	it('plots the i-th largest of n at i / (n + 1), linear between, held at the ends', () => {
		const x = [1, 3, 2];
		expect(durationQuantile(x, 25)).toBe(3);
		expect(durationQuantile(x, 50)).toBe(2);
		expect(durationQuantile(x, 75)).toBe(1);
		expect(durationQuantile(x, 37.5)).toBeCloseTo(2.5, 12);
		expect(durationQuantile(x, 10)).toBe(3);
		expect(durationQuantile(x, 99)).toBe(1);
		expect(durationQuantile([7], 50)).toBe(7);
		expect(durationQuantile([], 50)).toBeNull();
	});
});

describe('lookupRequirement', () => {
	it('reads the same requirement for flows one ulp apart on a flat stretch of the natural curve (engine 0.24.1, seed 18472)', () => {
		const points = [10, 50, 70, 90];
		const natural = [5, 2, 2, 1];
		const ewr = [3, 1.5, 0.8, 0.4];
		const at = lookupRequirement(2, points, natural, ewr);
		const below = lookupRequirement(2 * (1 - Number.EPSILON), points, natural, ewr);
		expect(below.percentile).toBeCloseTo(at.percentile, 9);
		expect(below.required).toBeCloseTo(at.required, 9);
		expect(at).toEqual({ percentile: 50, required: 1.5, beyond: null });
	});

	const P = [10, 50, 90];
	const N = [3, 2, 1];
	const T = [1.5, 1, 0.5];
	it('interpolates the % and the EWR with the same weight', () => {
		expect(lookupRequirement(1.5, P, N, T)).toEqual({ percentile: 70, required: 0.75, beyond: null });
		expect(lookupRequirement(2, P, N, T)).toEqual({ percentile: 50, required: 1, beyond: null });
	});
	it('holds the first EWR above the wettest point and scales the last below the driest', () => {
		expect(lookupRequirement(9, P, N, T)).toEqual({ percentile: 10, required: 1.5, beyond: 'wetter' });
		expect(lookupRequirement(3, P, N, T)).toEqual({ percentile: 10, required: 1.5, beyond: null });
		expect(lookupRequirement(0.4, P, N, T)).toEqual({ percentile: 90, required: 0.2, beyond: 'drier' });
		expect(lookupRequirement(0, P, [3, 0, 0], [1, 0.2, 0])).toEqual({ percentile: 50, required: expect.closeTo(0.2, 15), beyond: null });
	});
	it('takes the wettest point of a flat stretch (the strictest requirement)', () => {
		expect(lookupRequirement(2, [10, 50, 90], [2, 2, 1], [1.4, 1, 0.5])).toEqual({ percentile: 10, required: 1.4, beyond: null });
	});
	it('runningMin keeps a curve from rising', () => {
		expect(runningMin([3, 4, 2, 2.5, 1])).toEqual([3, 3, 2, 2, 1]);
	});
});

describe('completeMonths', () => {
	it('leaves out a part month at either end and counts a leap February as 29 days', () => {
		const m = completeMonths('2004-01-15', daysBetween('2004-01-15', '2004-04-10'));
		expect(m.map((b) => [b.year, b.month, b.days])).toEqual([
			[2004, 2, 29],
			[2004, 3, 31]
		]);
		expect(m[0]!.from).toBe(17);
		expect(completeMonths('2001-02-01', 28).map((b) => b.days)).toEqual([28]);
		expect(completeMonths('2001-02-01', 27)).toEqual([]);
	});
});

describe('assessSite across a forecast tail (engine 1.27.0, engine-audit.md K1)', () => {
	// Oct 2000 … Jan 2001, 'run' curves; the history ends on 15 December.
	const start = '2000-10-01';
	const days = daysBetween(start, '2001-01-31');
	const historyDays = daysBetween(start, '2000-12-15');
	const natural = daily(start, days, (y, m) => (m === 1 ? 4e6 : m * 1e5));
	const site = { table: table({ naturalSource: 'run', natural: null }), nodeId: null, name: 'Outlet', isOutlet: true, natural, impacted: natural };

	it('leaves out the month the history ends inside, and assesses one wholly in the tail', () => {
		const { report, requiredM3Day } = assessSite(start, days, site, undefined, null, 'total', [], historyDays);
		expect(report.months.map((m) => m.month)).toEqual([10, 11, 1]);
		expect(requiredM3Day.slice(historyDays - 15, historyDays).every(Number.isNaN)).toBe(true);
		// Positive control: without a tail December is assessed.
		expect(assessSite(start, days, site).report.months.map((m) => m.month)).toEqual([10, 11, 12, 1]);
	});

	it('gives the historical months the requirement of the run without the tail, to the bit', () => {
		const withTail = assessSite(start, days, site, undefined, null, 'total', [], historyDays);
		const without = assessSite(start, historyDays, { ...site, natural: natural.subarray(0, historyDays), impacted: natural.subarray(0, historyDays) });
		expect(withTail.report.months.slice(0, 2)).toEqual(without.report.months);
		expect(Array.from(withTail.requiredM3Day.subarray(0, historyDays))).toEqual(Array.from(without.requiredM3Day));
	});
});

describe('assessSite: worked examples', () => {
	it('reads the requirement off the entered natural curve and charges the deficit in m³', () => {
		// One October of 1.5 Mm³ natural flow: 70 % on the natural curve, so 0.75 Mm³ is required; 0.7 Mm³ flowed.
		const start = '2000-10-01';
		const days = 31;
		const natural = daily(start, days, () => 1.5e6);
		const impacted = daily(start, days, () => 0.7e6);
		const { report, requiredM3Day } = assessSite(start, days, { table: table(), nodeId: null, name: 'Outlet', isOutlet: true, natural, impacted });
		const [m] = report.months;
		expect(m).toMatchObject({ year: 2000, month: 10, waterYear: 2000, days: 31, beyond: null, met: false });
		expect(m!.percentile).toBeCloseTo(70, 9);
		expect(m!.natural).toBeCloseTo(1.5, 12);
		expect(m!.required).toBeCloseTo(0.75, 12);
		expect(m!.actual).toBeCloseTo(0.7, 12);
		expect(m!.deficitM3).toBeCloseTo(50_000, 6);
		expect(requiredM3Day[0]).toBeCloseTo(750_000 / 31, 6);
		expect(report.overall).toMatchObject({ months: 1, met: 0, rate: 0, longestNotMetRun: 1 });
		expect(report.overall.meanShortfallPct).toBeCloseTo((100 * 0.05) / 0.75, 9);
		// No source kind on the table: none on the report, as before engine 1.5.0.
		expect(report).not.toHaveProperty('sourceKind');
		expect(assessSite(start, days, { table: table({ sourceKind: 'gazetted' }), nodeId: null, name: 'Outlet', isOutlet: true, natural, impacted }).report.sourceKind).toBe('gazetted');
		const oct = report.byMonth[0]!;
		expect(oct).toMatchObject({ month: 10, years: 1, met: 0, rate: 0 });
		expect(report.byMonth[1]).toMatchObject({ month: 11, years: 0, rate: null, meanRequired: null });
		expect(report.minYears).toBe(0);
	});

	it('reports % of time and volume not met from daily data beside the monthly verdict (CR-29)', () => {
		// October 2000: 1.5 Mm³ natural, so R = 0.75 Mm³, 750 000 / 31 m³ a day. No flow for 10 days, then twice the day's R:
		// the month is met on volume (42/31 × R), but 10 of 31 days, and 10/31 of the volume, were not.
		const start = '2000-10-01';
		const days = 31;
		const rDay = 750_000 / 31;
		const natural = daily(start, days, () => 1.5e6);
		const impacted = Float64Array.from({ length: days }, (_, t) => (t < 10 ? 0 : 2 * rDay));
		const { report } = assessSite(start, days, { table: table(), nodeId: null, name: 'Outlet', isOutlet: true, natural, impacted });
		expect(report.months[0]!.met).toBe(true);
		expect(report.daily).toMatchObject({ days: 31, daysNotMet: 10 });
		expect(report.daily!.timeNotMet).toBeCloseTo(10 / 31, 12);
		expect(report.daily!.requiredM3).toBeCloseTo(750_000, 6);
		expect(report.daily!.shortfallM3).toBeCloseTo(10 * rDay, 6);
		expect(report.daily!.volumeNotMet).toBeCloseTo(10 / 31, 12);
		expect(report.byMonth[0]!.daily).toEqual(report.daily);
		// A month of the year with no complete month: nothing assessed.
		expect(report.byMonth[1]!.daily).toEqual({ days: 0, daysNotMet: 0, timeNotMet: null, requiredM3: 0, shortfallM3: 0, volumeNotMet: null });
		// The FDC overlay: the run's natural curve beside the impacted one, in the table's unit.
		for (const f of report.byMonth[0]!.fdc) expect(f.natural).toBeCloseTo(1.5, 12);
		expect(report.byMonth[1]!.fdc.map((f) => f.natural)).toEqual([null, null, null]);
		// One month isn't every calendar month: no %nMAR.
		expect(report.ewrPctNmar).toBeUndefined();
	});

	it('gives the EWR as %nMAR over a whole year, and the low flows alone with a low-flow grid (CR-29)', () => {
		// Every month 1.5 Mm³ natural: R = 0.75 (70 % on the curve), so 9 of 18 Mm³ a year, 50 %.
		// Low flows 0.9 / 0.6 / 0.3 read at 70 %: 0.45 a month, 5.4 Mm³, 30 %.
		const start = '2000-10-01';
		const days = daysBetween(start, '2001-09-30');
		const natural = daily(start, days, () => 1.5e6);
		const site = { nodeId: null, name: 'Outlet', isOutlet: true, natural, impacted: natural };
		const r = assessSite(start, days, { ...site, table: table() }).report;
		expect(r.ewrPctNmar!.ewrMcm).toBeCloseTo(9, 9);
		expect(r.ewrPctNmar!.naturalMarMcm).toBeCloseTo(18, 9);
		expect(r.ewrPctNmar!.pct).toBeCloseTo(50, 9);
		expect(r.ewrPctNmar).not.toHaveProperty('lowFlowPct');
		const low = assessSite(start, days, { ...site, table: table({ lowFlow: rows([0.9, 0.6, 0.3]) }) }).report;
		expect(low.ewrPctNmar!.lowFlowMcm).toBeCloseTo(5.4, 9);
		expect(low.ewrPctNmar!.lowFlowPct).toBeCloseTo(30, 9);
		// No natural flow: no share.
		const dry = assessSite(start, days, { ...site, natural: new Float64Array(days), impacted: new Float64Array(days), table: table() }).report;
		expect(dry.ewrPctNmar!.pct).toBeNull();
	});

	it('ranks natural flow among the run’s own years, and a flow at exactly the requirement meets it', () => {
		// Three Octobers of 3, 2 and 1 Mm³: the run's own curve at 10/50/90 % is 3, 2, 1; the EWR is half of it.
		const start = '2000-10-01';
		const days = daysBetween(start, '2003-09-30');
		const oct = (y: number) => [3, 2, 1][y - 2000]! * 1e6;
		const natural = daily(start, days, (y, m) => (m === 10 ? oct(y) : 1e5));
		const impacted = natural.map((v) => v / 2);
		const t = table({ naturalSource: 'run', natural: null, ewr: rows([1.5, 1, 0.5]) });
		const { report } = assessSite(start, days, { table: t, nodeId: 'g', name: 'Gauge', isOutlet: false, natural, impacted });
		const octs = report.months.filter((m) => m.month === 10);
		const close = (xs: number[]) => xs.map((x) => expect.closeTo(x, 9));
		expect(octs.map((m) => m.percentile)).toEqual(close([10, 50, 90]));
		expect(octs.map((m) => m.required)).toEqual(close([1.5, 1, 0.5]));
		expect(octs.every((m) => m.met)).toBe(true);
		expect(report.byMonth[0]!.naturalCurve).toEqual(close([3, 2, 1]));
		// The FDC check: the impacted curve (1.5, 1, 0.5) is on the EWR curve.
		expect(report.byMonth[0]!.fdc.map((f) => [f.point, f.impacted, f.met])).toEqual([
			[10, expect.closeTo(1.5, 9), true],
			[50, expect.closeTo(1, 9), true],
			[90, expect.closeTo(0.5, 9), true]
		]);
		expect(report.minYears).toBe(3);
		expect(assuranceWarnings(report)).toEqual([expect.stringMatching(/^EWR rule table at Gauge: some calendar months have only 3 complete years in the run \(fewer than 10\), so the natural-flow percentiles/)]);
	});

	it('works in mean m³/s over the month when the table is in m³/s, and applies the scale', () => {
		const start = '2001-02-01';
		const days = 28;
		// 1 m³/s natural, 0.3 m³/s flowing; table natural 2/1/0.5 m³/s × 0.5 = 1/0.5/0.25: 1 m³/s sits at 10 %.
		const natural = new Float64Array(days).fill(86_400);
		const impacted = new Float64Array(days).fill(0.3 * 86_400);
		const t = table({ unit: 'm3s', scale: 0.5, natural: rows([2, 1, 0.5]), ewr: rows([0.8, 0.4, 0.2]) });
		const { report, requiredM3Day } = assessSite(start, days, { table: t, nodeId: null, name: 'Outlet', isOutlet: true, natural, impacted });
		const [m] = report.months;
		expect(m).toMatchObject({ month: 2, percentile: 10, required: 0.4, met: false });
		expect(m!.actual).toBeCloseTo(0.3, 12);
		expect(m!.deficitM3).toBeCloseTo(0.1 * 28 * 86_400, 6);
		expect(requiredM3Day[0]).toBeCloseTo(0.4 * 86_400, 6);
		expect(report.byMonth[4]!.fdc[0]).toEqual({ point: 10, required: 0.4, impacted: expect.closeTo(0.3, 12), met: false, natural: expect.closeTo(1, 12) });
	});

	it('counts the longest run of consecutive months not met and leaves part months as NaN', () => {
		const start = '2000-09-15';
		const days = daysBetween(start, '2001-06-10');
		const natural = daily(start, days, () => 2e6);
		// 2 Mm³ natural sits at 50 %: 1 Mm³ required. Short in Nov, Dec, Jan and Mar.
		const short = new Set([11, 12, 1, 3]);
		const impacted = daily(start, days, (_y, m) => (short.has(m) ? 0.5e6 : 1.2e6));
		const { report, requiredM3Day } = assessSite(start, days, { table: table(), nodeId: null, name: 'O', isOutlet: true, natural, impacted });
		expect(report.months.map((m) => m.month)).toEqual([10, 11, 12, 1, 2, 3, 4, 5]);
		expect(report.overall).toMatchObject({ months: 8, met: 4, rate: 0.5, longestNotMetRun: 3 });
		expect(report.overall.deficitM3).toBeCloseTo(4 * 0.5e6, 3);
		expect(Number.isNaN(requiredM3Day[0]!)).toBe(true);
		expect(Number.isNaN(requiredM3Day[days - 1]!)).toBe(true);
		expect(assuranceWarnings(report)[0]).toBe('EWR rule table at the outlet (O): the run has no complete Jun, Jul, Aug, Sep, so those months are not assessed');
	});

	it('says when the run has no complete month', () => {
		const n = new Float64Array(10).fill(1);
		const { report } = assessSite('2001-01-05', 10, { table: table(), nodeId: null, name: 'O', isOutlet: true, natural: n, impacted: n });
		expect(report.overall).toMatchObject({ months: 0, rate: null });
		expect(report.fdc).toEqual({ cells: 0, met: 0, rate: null });
		expect(assuranceWarnings(report)).toEqual(['EWR rule table at the outlet (O): the run has no complete calendar month, so Reserve compliance is not assessed']);
	});
});

// ---------------------------------------------------------------------------
// Properties on random series
// ---------------------------------------------------------------------------

interface Case {
	start: string;
	days: number;
	natural: Float64Array;
	points: number[];
	unit: 'mcm' | 'm3s';
}

function randomCase(rng: Rng): Case {
	const start = fromEpochDay(toEpochDay('1980-01-01') + rng.int(0, 40 * 365));
	const days = rng.int(60, 12 * 366);
	const wet = rng.logFloat(1, 1e6);
	const natural = Float64Array.from({ length: days }, () => (rng.bool(0.05) ? 0 : rng.logFloat(1e-3, 1) * wet));
	const points = rng.bool(0.5) ? [...DEFAULT_ASSURANCE_POINTS] : [...new Set(Array.from({ length: rng.int(2, 12) }, () => rng.int(1, 100)))].sort((a, b) => a - b);
	if (points.length < 2) points.push(100);
	return { start, days, natural, points, unit: rng.pick(['mcm', 'm3s'] as const) };
}

/** The run's own natural curve per calendar month, from an assessment with any table. */
function runCurves(c: Case): (number[] | null)[] {
	const t = table({ points: c.points, unit: c.unit, naturalSource: 'run', natural: null, ewr: rows(c.points.map(() => 0)) });
	return assessSite(c.start, c.days, { table: t, nodeId: null, name: 'O', isOutlet: true, natural: c.natural, impacted: c.natural }).report.byMonth.map((m) => m.naturalCurve);
}

const allMet = (r: EwrAssuranceSite) => r.months.filter((m) => !m.met).map((m) => `${m.year}-${m.month}: ${m.actual} < ${m.required}`);

describe('assessSite invariants on random series', () => {
	it('natural flow meets every table whose EWR is at most the natural curve it is read against (run and table curves)', () => {
		const rng = new Rng(20260925);
		for (let k = 0; k < 300; k++) {
			const c = randomCase(rng);
			const curves = runCurves(c);
			// From the run: EWR = u × the run's own curve, u ∈ [0, 1] per cell (the row need not fall).
			const ewrRun = curves.map((curve) => c.points.map((_, i) => (curve ? curve[i]! * rng.float(0, 1) : rng.float(0, 1))));
			const run = assessSite(c.start, c.days, {
				table: table({ points: c.points, unit: c.unit, naturalSource: 'run', natural: null, ewr: ewrRun }),
				nodeId: null,
				name: 'O',
				isOutlet: true,
				natural: c.natural,
				impacted: c.natural
			}).report;
			expect(allMet(run), `case ${k} (run curve)`).toEqual([]);
			// Its FDC check passes too: the impacted curve is the natural curve.
			expect(run.fdc.met, `case ${k} (run curve FDC)`).toBe(run.fdc.cells);

			// From an entered natural curve (any row, the run takes its running minimum), EWR below that minimum.
			const scale = rng.pick([1, rng.logFloat(0.01, 100)]);
			const natural = Array.from({ length: 12 }, () => c.points.map(() => rng.logFloat(1e-4, 10) * (c.unit === 'mcm' ? 1 : 10)));
			const ewrTable = natural.map((row) => runningMin(row).map((v) => v * rng.float(0, 1)));
			const tab = assessSite(c.start, c.days, {
				table: table({ points: c.points, unit: c.unit, naturalSource: 'table', natural, ewr: ewrTable, scale }),
				nodeId: null,
				name: 'O',
				isOutlet: true,
				natural: c.natural,
				impacted: c.natural
			}).report;
			expect(allMet(tab), `case ${k} (table curve)`).toEqual([]);
		}
	});

	it('less flow never meets more months: the requirement is unchanged, deficits only grow, FDC cells only fail', () => {
		const rng = new Rng(7);
		for (let k = 0; k < 300; k++) {
			const c = randomCase(rng);
			const curves = runCurves(c);
			const ewr = curves.map((curve) => c.points.map((_, i) => (curve ? curve[i]! * rng.float(0, 1.5) : 0)));
			const t = table({ points: c.points, unit: c.unit, naturalSource: 'run', natural: null, ewr });
			const impacted = c.natural.map((v) => v * rng.float(0.2, 1));
			const less = impacted.map((v) => v * rng.pick([1, 1, rng.float(0, 1)]));
			const a = assessSite(c.start, c.days, { table: t, nodeId: null, name: 'O', isOutlet: true, natural: c.natural, impacted }).report;
			const b = assessSite(c.start, c.days, { table: t, nodeId: null, name: 'O', isOutlet: true, natural: c.natural, impacted: less }).report;
			a.months.forEach((m, i) => {
				const n = b.months[i]!;
				expect(n.required).toBe(m.required);
				expect(n.percentile).toBe(m.percentile);
				if (n.met) expect(m.met, `case ${k} month ${i}`).toBe(true);
				expect(n.deficitM3).toBeGreaterThanOrEqual(m.deficitM3 - 1e-9 * Math.max(1, m.deficitM3));
			});
			expect(b.overall.met).toBeLessThanOrEqual(a.overall.met);
			expect(b.fdc.met).toBeLessThanOrEqual(a.fdc.met);
			expect(b.overall.longestNotMetRun).toBeGreaterThanOrEqual(a.overall.longestNotMetRun);
			// Daily (CR-29): the same days, never fewer short, never less shortfall; %nMAR depends only on natural flow.
			expect(b.daily!.days).toBe(a.daily!.days);
			expect(b.daily!.requiredM3).toBe(a.daily!.requiredM3);
			expect(b.daily!.daysNotMet).toBeGreaterThanOrEqual(a.daily!.daysNotMet);
			expect(b.daily!.shortfallM3).toBeGreaterThanOrEqual(a.daily!.shortfallM3 - 1e-9 * Math.max(1, a.daily!.shortfallM3));
			expect(b.ewrPctNmar).toEqual(a.ewrPctNmar);
			a.byMonth.forEach((m, i) => {
				expect(b.byMonth[i]!.daily!.daysNotMet).toBeGreaterThanOrEqual(m.daily!.daysNotMet);
				// The FDC overlay's natural curve is the natural flow's, whatever the impacted flow.
				expect(b.byMonth[i]!.fdc.map((f) => f.natural)).toEqual(m.fdc.map((f) => f.natural));
			});
		}
	});

	it('the summaries add up: byMonth sums to overall, rates are met ÷ months', () => {
		const rng = new Rng(99);
		for (let k = 0; k < 100; k++) {
			const c = randomCase(rng);
			const impacted = c.natural.map((v) => v * rng.float(0, 1));
			const ewr = rows(c.points.map(() => 0)).map((row) => row.map(() => rng.logFloat(1e-4, 10)));
			const r = assessSite(c.start, c.days, { table: table({ points: c.points, unit: c.unit, naturalSource: 'run', natural: null, ewr }), nodeId: null, name: 'O', isOutlet: true, natural: c.natural, impacted }).report;
			expect(r.byMonth.reduce((s, m) => s + m.years, 0)).toBe(r.overall.months);
			expect(r.byMonth.reduce((s, m) => s + m.met, 0)).toBe(r.overall.met);
			expect(r.byMonth.reduce((s, m) => s + m.deficitM3, 0)).toBeCloseTo(r.overall.deficitM3, 3);
			for (const m of r.byMonth) expect(m.rate).toBe(m.years ? m.met / m.years : null);
			// Daily (CR-29): the months of the year add up to the whole, which covers every day of a complete month.
			expect(r.byMonth.reduce((s, m) => s + m.daily!.days, 0)).toBe(r.daily!.days);
			expect(r.daily!.days).toBe(r.months.reduce((s, m) => s + m.days, 0));
			expect(r.byMonth.reduce((s, m) => s + m.daily!.daysNotMet, 0)).toBe(r.daily!.daysNotMet);
			expect(r.byMonth.reduce((s, m) => s + m.daily!.shortfallM3, 0)).toBeCloseTo(r.daily!.shortfallM3, 3);
			expect(r.daily!.timeNotMet).toBe(r.daily!.days ? r.daily!.daysNotMet / r.daily!.days : null);
			expect(r.months.every((m) => m.percentile >= c.points[0]! && m.percentile <= c.points[c.points.length - 1]!)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// In a run
// ---------------------------------------------------------------------------

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** Outlet ← gauge g ← farm a (3 km²); outlet ← farm b (1 km²). A third node, farm c, drains into g too. */
function network(ewrRules: EwrRuleTable[]): ModelInput {
	const days = daysBetween('2000-10-01', '2002-09-30');
	const nodes = [
		node('out', { kind: 'gauge' }),
		node('g', { kind: 'gauge', downstreamNodeId: 'out' }),
		node('a', { downstreamNodeId: 'g', areaKm2: 3, damCapacityM3: 50_000, pctRunoffToDam: 1 }),
		node('b', { downstreamNodeId: 'out' })
	];
	return {
		settings: { ewrPragmaticM3PerDay: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], apanMm: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200], ewrRules },
		model: {
			nodes,
			crops: [{ id: 'c', name: 'crop', cropFactor: new Array(12).fill(1) }],
			cropAreas: [{ nodeId: 'a', cropId: 'c', areaM2: 50_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2000-10-01', values: new Array(days).fill(0) } }
	};
}
const naturalOf = (days: number) => Array.from({ length: days }, (_, t) => 20_000 + 15_000 * Math.sin(t / 29));
const runNet = (input: ModelInput) => {
	const days = (input.series.rain_catchment_mm!.values as unknown[]).length;
	return runModelWith(input, () => ({ naturalFlowM3Day: naturalOf(days) }));
};

describe('Reserve compliance in a run', () => {
	it('is absent without a rule table: the summary, series and warnings are as before', () => {
		const out = runNet(network([]));
		expect(out.summary.ewrAssurance).toBeUndefined();
		expect(out.series.some((s) => s.key === 'ewr_rule')).toBe(false);
		expect(out.summary.warnings.some((w) => w.includes('rule table'))).toBe(false);
	});

	it('assesses the outlet first, then gauges; a gauge’s natural flow is its upstream farms’ runoff', () => {
		const t = { ...table({ naturalSource: 'run', natural: null, points: [...DEFAULT_ASSURANCE_POINTS], ewr: rows(DEFAULT_ASSURANCE_POINTS.map(() => 0.1)) }) };
		const out = runNet(network([{ ...t, siteNodeId: 'g' }, t]));
		const sites = out.summary.ewrAssurance!;
		expect(sites.map((s) => [s.nodeId, s.name, s.isOutlet])).toEqual([
			[null, 'out', true],
			['g', 'g', false]
		]);
		// Farm a has 3 of the 4 km²: g's natural flow is ¾ of the catchment's.
		const oct = (s: EwrAssuranceSite) => s.months.find((m) => m.year === 2000 && m.month === 10)!;
		expect(oct(sites[1]!).natural / oct(sites[0]!).natural).toBeCloseTo(0.75, 12);
		// The requirement is a daily series for each site (m³/day), the month's volume ÷ its days.
		const req = out.series.find((s) => s.nodeId === 'g' && s.key === 'ewr_rule')!;
		expect(req.values[0]).toBeCloseTo((oct(sites[1]!).required * 1e6) / 31, 6);
		expect(out.series.find((s) => s.nodeId === null && s.key === 'ewr_rule')).toBeDefined();
		expect(out.summary.warnings.filter((w) => w.startsWith('EWR rule table'))).toEqual([
			expect.stringMatching(/^EWR rule table at the outlet \(out\): some calendar months have only 2 complete years/),
			expect.stringMatching(/^EWR rule table at g: some calendar months have only 2 complete years/)
		]);
	});

	it('skips a table at a farm, a missing node or a second table for the outlet, with warnings', () => {
		const t = table();
		const out = runNet(network([{ ...t, siteNodeId: 'a' }, { ...t, siteNodeId: 'nope' }, { ...t, siteNodeId: 'out' }, t]));
		expect(out.summary.ewrAssurance!.map((s) => s.nodeId)).toEqual([null]);
		expect(out.summary.warnings).toEqual(
			expect.arrayContaining([
				'EWR rule table for "a" skipped: an EWR site is the outlet or a gauge',
				'EWR rule table skipped: its site (nope) is not in the network',
				'a second EWR rule table for "out" is ignored: each site has one'
			])
		);
	});

	it('natural flow meets its own table on an undeveloped random network, at every site', () => {
		let assessed = 0;
		for (let seed = 1; seed <= 60; seed++) {
			const base = randomInput(seed, { maxDays: 900 });
			const x = cloneInput(base);
			// No development: no crops, demand objects, dams, diversions or transfers, so every site carries its natural flow.
			x.model.cropAreas = [];
			x.model.demandObjects = [];
			x.model.transfers = [];
			for (const n of x.model.nodes) Object.assign(n, { damCapacityM3: 0, divertCapacityM3Day: 0 });
			const gauges = x.model.nodes.filter((n) => n.kind === 'gauge').map((n) => n.id);
			const rng = new Rng(seed);
			x.settings.ewrRules = [null, ...gauges].map((siteNodeId) => ({
				...table({ points: [...DEFAULT_ASSURANCE_POINTS], naturalSource: 'run', natural: null }),
				siteNodeId,
				ewr: rows(DEFAULT_ASSURANCE_POINTS.map(() => 0))
			}));
			let out;
			try {
				out = runModel(x);
			} catch {
				continue; // a network with nothing runnable (the fuzz generator's edge cases)
			}
			// Read each site's own curve, then ask for up to all of it.
			x.settings.ewrRules = (out.summary.ewrAssurance ?? []).map((s) => ({
				...table({ points: s.points, naturalSource: 'run', natural: null }),
				siteNodeId: s.nodeId,
				ewr: s.byMonth.map((m) => s.points.map((_, i) => (m.naturalCurve ? m.naturalCurve[i]! * rng.float(0, 1) : 0)))
			}));
			const again = runModel(x);
			for (const s of again.summary.ewrAssurance ?? []) {
				expect(allMet(s), `seed ${seed} site ${s.name}`).toEqual([]);
				assessed += s.overall.months;
			}
		}
		// Not vacuous: the seeds cover hundreds of site-months.
		expect(assessed).toBeGreaterThan(300);
	});

	it('more irrigation leaves the requirement as it was and never meets more months', () => {
		let compared = 0;
		for (let seed = 1; seed <= 80 && compared < 25; seed++) {
			const x = randomInput(seed, { maxDays: 900 });
			if (!x.model.cropAreas.length) continue;
			// Without return flow, extra use upstream only lowers the flow downstream (as checkDoubledCropAreas).
			for (const n of x.model.nodes) n.lossReturnFraction = 0;
			x.settings.ewrRules = [{ ...table({ points: [...DEFAULT_ASSURANCE_POINTS], naturalSource: 'run', natural: null, ewr: rows([9, 8, 7, 6, 5, 4, 3, 2, 1, 0.5].map((v) => v * 1e-3)) }) }];
			const more = cloneInput(x);
			for (const a of more.model.cropAreas) a.areaM2 *= 3;
			let a;
			let b;
			try {
				a = runModel(x).summary.ewrAssurance?.[0];
				b = runModel(more).summary.ewrAssurance?.[0];
			} catch {
				continue;
			}
			if (!a || !b) continue;
			compared++;
			a.months.forEach((m, i) => {
				const n = b.months[i]!;
				expect(n.required).toBe(m.required);
				expect(n.percentile).toBe(m.percentile);
				expect(n.actual).toBeLessThanOrEqual(m.actual * (1 + 1e-9) + 1e-12);
				if (n.met) expect(m.met, `seed ${seed} ${m.year}-${m.month}`).toBe(true);
			});
		}
		expect(compared).toBeGreaterThan(10);
	});
});

describe("the run's natural MAR against the determination's (engine ≥ 1.11.0, issue #46)", () => {
	// One water year, every month the same natural volume, so the run's natural MAR is 12 × that.
	const start = '2000-10-01';
	const days = daysBetween(start, '2001-09-30');
	const site = (monthMcm: number, over: Partial<EwrRuleTable>) => {
		const natural = daily(start, days, () => monthMcm * 1e6);
		return assessSite(start, days, { table: table(over), nodeId: null, name: 'O', isOutlet: true, natural, impacted: natural }).report;
	};
	const marWarning = (r: EwrAssuranceSite) => assuranceWarnings(r).filter((w) => w.includes('natural MAR'));

	it('reports the comparison only when the table records a natural MAR, scaled like the table', () => {
		expect(site(1, {})).not.toHaveProperty('naturalMar');
		expect(site(1, { naturalMarMcm: null })).not.toHaveProperty('naturalMar');
		const r = site(1, { naturalMarMcm: 5, scale: 2 });
		expect(r.naturalMar!.runMcm).toBeCloseTo(12, 9);
		expect(r.naturalMar!.tableMcm).toBe(10);
		expect(r.naturalMar!.differencePct).toBeCloseTo(20, 9);
	});

	it('warns beyond ±15 % only when the percentile comes from the run', () => {
		const wet = site(1, { naturalSource: 'run', natural: null, naturalMarMcm: 10 });
		expect(marWarning(wet)).toEqual([
			"EWR rule table at the outlet (O): the run's natural MAR at the site (12 Mm³/a) is 20 % above the determination's (10 Mm³/a), beyond ±15 %; with the percentile from the run, the table's flows are judged against a natural flow wetter than the one they were set for, so months pass or fail that the determination's own curve would not: check the calibration, or enter the table's natural flows"
		]);
		const dry = site(0.5, { naturalSource: 'run', natural: null, naturalMarMcm: 10 });
		expect(marWarning(dry)[0]).toMatch(/\(6 Mm³\/a\) is 40 % below the determination's \(10 Mm³\/a\).*a natural flow drier than/);
		// The gazette's own curve places each month: the gap is reported, not warned about.
		const onTable = site(1, { naturalMarMcm: 10 });
		expect(onTable.naturalMar!.differencePct).toBeCloseTo(20, 9);
		expect(marWarning(onTable)).toEqual([]);
	});

	it('within ±15 % (15 % itself included) there is no warning', () => {
		for (const m of [11.5 / 12, 8.5 / 12, 1 / 1.2]) {
			const r = site(m, { naturalSource: 'run', natural: null, naturalMarMcm: 10 });
			expect(Math.abs(r.naturalMar!.differencePct)).toBeLessThanOrEqual(15 + 1e-9);
			expect(marWarning(r)).toEqual([]);
		}
	});

	it('without every calendar month in the run there is no comparison (the missing months are warned about already)', () => {
		const short = daysBetween(start, '2001-05-31');
		const natural = daily(start, short, () => 1e6);
		const r = assessSite(start, short, { table: table({ naturalSource: 'run', natural: null, naturalMarMcm: 10 }), nodeId: null, name: 'O', isOutlet: true, natural, impacted: natural }).report;
		expect(r).not.toHaveProperty('naturalMar');
		expect(marWarning(r)).toEqual([]);
	});
});
