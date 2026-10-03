import { describe, expect, it } from 'vitest';
import { daysPerMonth, toEpochDay, type Monthly } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { runModel, runModelWith } from '../run';
import {
	lowFlowMonthsFrom,
	monthlyMeansMm3,
	overlapDays,
	wr2012FlagLevel,
	wr2012Penalty,
	wr2012Report
} from './wr2012';
import { defaultWr2012Settings, m3DayToMm3, rainVolumeMm3, WR2012_MONTHLY_SUM_TOLERANCE, wr2012FlagIssues, wr2012PenaltyIssues, wr2012ReferenceIssues, type Wr2012Reference, type Wr2012Settings } from './wr2012Settings';
import { resolveWr2012 } from './wr2012Resolve';

// Everything here is synthetic: invented quaternary codes and round numbers.

/** Monthly means that add up to `mar` exactly, shared by month length. */
const evenMonthly = (mar: number) => [...daysPerMonth(28.25)].map((d) => (mar * d) / 365.25);

const ref = (over: Partial<Wr2012Reference> = {}): Wr2012Reference => ({
	quaternary: 'Z99A',
	areaKm2: 100,
	marMm3: 10,
	monthlyMm3: evenMonthly(10),
	periodStart: 2000,
	periodEnd: 2009,
	mapMm: null,
	source: 'Synthetic test reference',
	...over
});

const settings = (over: Partial<Wr2012Settings> = {}, r: Partial<Wr2012Reference> = {}): Wr2012Settings => ({
	...defaultWr2012Settings(),
	reference: ref(r),
	...over
});

/** Days from `start` to `end` inclusive. */
const span = (start: string, end: string) => toEpochDay(end) - toEpochDay(start) + 1;

describe('units', () => {
	it('rain volume: mm over km² → Mm³ (1 mm on 1 km² = 1 000 m³)', () => {
		expect(rainVolumeMm3(800, 100)).toBeCloseTo(80, 12);
		expect(rainVolumeMm3(1, 1)).toBeCloseTo(0.001, 15);
	});

	it('m³/day → Mm³: 1 m³/s for a year of 365.25 days is 31.5576 Mm³', () => {
		expect(m3DayToMm3(86_400, 365.25)).toBeCloseTo(31.5576, 10);
	});

	it('monthly means: a steady 1 m³/s is 2.6784 Mm³ in October and 2.44080 Mm³ in February (28.25 days), summing to the annual volume', () => {
		const days = span('2001-10-01', '2003-09-30');
		const m = monthlyMeansMm3(new Array(days).fill(86_400), '2001-10-01');
		expect(m[0]).toBeCloseTo(2.6784, 10); // Oct, 31 days
		expect(m[4]).toBeCloseTo(2.4408, 10); // Feb, 28.25 days
		expect(m.reduce((s, v) => s + v, 0)).toBeCloseTo(31.5576, 10);
	});

	it('monthly means are water-year ordered (Oct first) and use the mean daily flow of each month', () => {
		const start = '2001-10-01';
		const days = span(start, '2002-09-30');
		const d0 = toEpochDay(start);
		// 1 000 m³/day in January, 0 otherwise.
		const q = Array.from({ length: days }, (_, t) => (new Date((d0 + t) * 86_400_000).getUTCMonth() === 0 ? 1000 : 0));
		const m = monthlyMeansMm3(q, start);
		expect(m[3]).toBeCloseTo(0.031, 12); // Jan = index 3
		expect(m.filter((v) => v !== 0)).toHaveLength(1);
	});
});

describe('wr2012ReferenceIssues (plausibility)', () => {
	it('accepts a consistent reference', () => {
		expect(wr2012ReferenceIssues(ref())).toEqual([]);
		expect(wr2012ReferenceIssues(ref({ mapMm: 600 }))).toEqual([]);
	});

	it('rejects a MAR larger than the rain on the quaternary, when the MAP is known', () => {
		// 100 mm × 100 km² = 10 Mm³ of rain; a MAR of 10.5 is impossible.
		const issues = wr2012ReferenceIssues(ref({ mapMm: 100, marMm3: 10.5, monthlyMm3: evenMonthly(10.5) }));
		expect(issues.map((i) => i.field)).toEqual(['marMm3']);
		expect(issues[0]!.message).toMatch(/more than the rain/);
		// Exactly the rain volume is allowed (a runoff coefficient of 1).
		expect(wr2012ReferenceIssues(ref({ mapMm: 100, marMm3: 10, monthlyMm3: evenMonthly(10) }))).toEqual([]);
		// Without a MAP there is nothing to check against.
		expect(wr2012ReferenceIssues(ref({ mapMm: null, marMm3: 10.5, monthlyMm3: evenMonthly(10.5) }))).toEqual([]);
	});

	it(`rejects monthly means that add up to more than ${WR2012_MONTHLY_SUM_TOLERANCE * 100} % away from the MAR`, () => {
		const scaled = (f: number) => evenMonthly(10).map((v) => v * f);
		expect(wr2012ReferenceIssues(ref({ monthlyMm3: scaled(1.049) }))).toEqual([]);
		expect(wr2012ReferenceIssues(ref({ monthlyMm3: scaled(0.951) }))).toEqual([]);
		expect(wr2012ReferenceIssues(ref({ monthlyMm3: scaled(1.06) })).map((i) => i.field)).toEqual(['monthlyMm3']);
		expect(wr2012ReferenceIssues(ref({ monthlyMm3: scaled(0.94) })).map((i) => i.field)).toEqual(['monthlyMm3']);
		// Monthly values in m³/s by mistake (~0.3 each) are caught by the sum.
		expect(wr2012ReferenceIssues(ref({ monthlyMm3: new Array(12).fill(0.317) })).map((i) => i.field)).toEqual(['monthlyMm3']);
	});

	it('rejects missing or impossible fields', () => {
		const fields = (r: Partial<Wr2012Reference>) => wr2012ReferenceIssues(ref(r)).map((i) => i.field);
		expect(fields({ quaternary: ' ' })).toEqual(['quaternary']);
		expect(fields({ source: '' })).toEqual(['source']);
		expect(fields({ areaKm2: 0 })).toEqual(['areaKm2']);
		expect(fields({ marMm3: -1 })).toEqual(['marMm3']);
		expect(fields({ monthlyMm3: [1, 2, 3] })).toEqual(['monthlyMm3']);
		expect(fields({ periodStart: 2010, periodEnd: 2009 })).toEqual(['periodEnd']);
		expect(fields({ mapMm: 0 })).toEqual(['mapMm']);
	});
});

describe('deviation flags', () => {
	const f = defaultWr2012Settings().flags;

	it('defaults: note at 10 %, query at 25 % (or wetter by more than 15 %), not usable at 50 %', () => {
		expect(f).toEqual({ notePct: 10, queryPct: 25, queryWetterPct: 15, unusablePct: 50 });
		const cases: [number, string][] = [
			[0, 'ok'],
			[9.9, 'ok'],
			[-9.9, 'ok'],
			[10, 'note'],
			[-10, 'note'],
			[15, 'note'],
			[15.1, 'query'], // wetter by more than 15 %
			[-15.1, 'note'], // drier by the same is only a note
			[-24.9, 'note'],
			[-25, 'query'],
			[25, 'query'],
			[49.9, 'query'],
			[50, 'unusable'],
			[-50, 'unusable'],
			[-100, 'unusable']
		];
		for (const [d, level] of cases) expect(wr2012FlagLevel(d, f), String(d)).toBe(level);
		expect(wr2012FlagLevel(null, f)).toBe('ok');
	});

	it('uses the stored thresholds', () => {
		expect(wr2012FlagLevel(12, { notePct: 5, queryPct: 12, queryWetterPct: 8, unusablePct: 20 })).toBe('query');
		expect(wr2012FlagLevel(12, { notePct: 15, queryPct: 30, queryWetterPct: 20, unusablePct: 60 })).toBe('ok');
	});

	it('threshold validation: positive and rising', () => {
		expect(wr2012FlagIssues(f)).toEqual([]);
		expect(wr2012FlagIssues({ ...f, notePct: 30 }).map((i) => i.field)).toEqual(['queryPct']);
		expect(wr2012FlagIssues({ ...f, queryWetterPct: 30 }).map((i) => i.field)).toEqual(['queryWetterPct']);
		expect(wr2012FlagIssues({ ...f, unusablePct: 0 }).map((i) => i.field)).toEqual(['unusablePct']);
	});
});

describe('overlapDays', () => {
	it('keeps only complete water years inside the reference period', () => {
		// Run: 15 Nov 2000 – 30 Sep 2004. 2000/01 is incomplete; 2001/02–2003/04 are complete.
		const start = '2000-11-15';
		const days = span(start, '2004-09-30');
		expect(overlapDays(start, days, 1990, 2009)!.years).toEqual([2001, 2002, 2003]);
		expect(overlapDays(start, days, 2002, 2002)!.years).toEqual([2002]);
		expect(overlapDays(start, days, 2002, 2002)!.idx.length).toBe(365);
		expect(overlapDays(start, days, 1950, 1990)).toBeNull();
	});
});

describe('lowFlowMonthsFrom', () => {
	it("finds the project's own dry season: months below half the average month", () => {
		// Water-year order Oct … Sep; a winter-rainfall shape, dry Dec–Mar.
		const m = [2, 1, 0.2, 0.1, 0.1, 0.2, 1.5, 3, 4, 4, 3, 2.5];
		expect(lowFlowMonthsFrom(m)).toEqual([1, 2, 3, 12]);
		// A summer-rainfall shape: dry May–Sep instead. Nothing is hard-coded.
		const s = [1, 3, 4, 4, 4, 3, 1.5, 0.8, 0.2, 0.1, 0.1, 0.2];
		expect(lowFlowMonthsFrom(s)).toEqual([5, 6, 7, 8, 9]);
		// Flat flow: the lowest month alone.
		expect(lowFlowMonthsFrom(new Array(12).fill(1))).toEqual([10]);
	});
});

describe('wr2012Report', () => {
	const start = '2001-10-01';
	const days = span(start, '2005-09-30'); // four water years
	const steady = (m3Day: number) => new Array(days).fill(m3Day);
	// 10 Mm³/a over the whole of a 100 km² quaternary = 27 379.9 m³/day.
	const mar10 = (10e6 / 365.25) * 1;

	it('scales by area: a 50 km² catchment on a 100 km² quaternary halves the reference', () => {
		const w: string[] = [];
		const r = wr2012Report({ settings: settings(), startDate: start, natural: steady(mar10 / 2), areaKm2: 50, rainMm: null }, w)!;
		expect(r.scaling).toMatchObject({ rule: 'area', requested: 'area', factor: 0.5, areaFactor: 0.5, rainFactor: null });
		expect(r.scaledMarMm3).toBeCloseTo(5, 12);
		expect(r.whole.simulatedMarMm3).toBeCloseTo(5, 10);
		expect(r.whole.ratio).toBeCloseTo(1, 10);
		expect(r.overlap!.years).toEqual([2001, 2002, 2003, 2004]);
		expect(r.overlap!.ratio).toBeCloseTo(1, 10);
		expect(r.compared).toBe('natural_flow');
		expect(r.flag.level).toBe('ok');
		expect(r.flag.text).toBeNull();
		for (const m of r.months) expect(m.ratio).toBeCloseTo(1, 10);
		expect(w).toEqual([]);
	});

	it('scales by area × rainfall when asked and the data exists, and says when it had to fall back to area', () => {
		const rain = new Array(days).fill(900 / 365.25); // MAP 900 mm
		const w: string[] = [];
		const r = wr2012Report(
			{ settings: settings({ scaling: 'areaRain' }, { mapMm: 600 }), startDate: start, natural: steady(mar10), areaKm2: 100, rainMm: rain },
			w
		)!;
		expect(r.scaling.rule).toBe('areaRain');
		expect(r.scaling.modelMapMm).toBeCloseTo(900, 8);
		expect(r.scaling.rainFactor).toBeCloseTo(1.5, 10);
		expect(r.scaling.factor).toBeCloseTo(1.5, 10);
		expect(r.scaledMarMm3).toBeCloseTo(15, 8);

		const w2: string[] = [];
		const r2 = wr2012Report({ settings: settings({ scaling: 'areaRain' }), startDate: start, natural: steady(mar10), areaKm2: 100, rainMm: rain }, w2)!;
		expect(r2.scaling).toMatchObject({ rule: 'area', requested: 'areaRain', factor: 1, rainFactor: null });
		expect(w2).toContain('WR2012 check: scaled by area only, because the quaternary MAP is not entered');
	});

	it('flags the deviation in plain language, and 12 monthly ratios with the dry season marked', () => {
		const w: string[] = [];
		const r = wr2012Report({ settings: settings(), startDate: start, natural: steady(mar10 * 1.3), areaKm2: 100, rainMm: null }, w)!;
		expect(r.overlap!.ratio).toBeCloseTo(1.3, 10);
		expect(r.flag).toMatchObject({ level: 'query', basis: 'overlap' });
		expect(r.flag.deviationPct).toBeCloseTo(30, 8);
		expect(r.flag.text).toBe(
			'Simulated natural flow is 30 % above the WR2012 naturalised MAR for Z99A (scaled to the modelled catchment) over the 4 water years both cover. ' +
				'Query it: check the rainfall, the catchment area and the calibration before relying on the results.'
		);
		expect(w).toContain(r.flag.text);
		expect(r.months).toHaveLength(12);
		expect(r.months.map((m) => m.month)).toEqual([10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

		const low = wr2012Report({ settings: settings(), startDate: start, natural: steady(mar10 * 0.4), areaKm2: 100, rainMm: null }, [])!;
		expect(low.flag.level).toBe('unusable');
		expect(low.flag.text).toMatch(/60 % below .* Don't use this run for EWR findings until the difference is explained\.$/);
	});

	it('reports the dry-season ratio over the configured months, and the correlation of the monthly pattern', () => {
		const d0 = toEpochDay(start);
		// Winter (May–Sep) flow 3× the rest; the dry months match the reference.
		const q = Array.from({ length: days }, (_, t) => {
			const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
			return [5, 6, 7, 8, 9].includes(m) ? 3 * mar10 : mar10;
		});
		const r = wr2012Report({ settings: settings({ lowFlowMonths: [1, 2] }), startDate: start, natural: q, areaKm2: 100, rainMm: null }, [])!;
		expect(r.lowFlowSource).toBe('setting');
		expect(r.lowFlowMonths).toEqual([1, 2]);
		expect(r.months.filter((m) => m.lowFlow).map((m) => m.month)).toEqual([1, 2]);
		expect(r.lowFlowRatio).toBeCloseTo(1, 10);
	});

	it('correlation is 1 when the simulated pattern is the reference pattern, whatever the volume', () => {
		const shape = [1, 2, 4, 6, 5, 3, 2, 1, 0.5, 0.3, 0.3, 0.5];
		const total = shape.reduce((s, v) => s + v, 0);
		const monthly = shape.map((v) => (v * 10) / total);
		const d0 = toEpochDay(start);
		const len = daysPerMonth(28.25);
		const q = Array.from({ length: days }, (_, t) => {
			const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
			const i = (m + 2) % 12;
			return ((monthly[i]! * 2) / len[i]!) * 1e6; // twice the reference volume
		});
		const r = wr2012Report({ settings: settings({}, { monthlyMm3: monthly }), startDate: start, natural: q, areaKm2: 100, rainMm: null }, [])!;
		expect(r.patternCorrelation).toBeCloseTo(1, 10);
		expect(r.lowFlowSource).toBe('simulated');
		expect(r.lowFlowMonths).toEqual([5, 6, 7, 8, 9, 10]);
	});

	it('falls back to the whole run, with a warning, when no complete year is inside the reference period', () => {
		const w: string[] = [];
		const r = wr2012Report(
			{ settings: settings({}, { periodStart: 1950, periodEnd: 1990 }), startDate: start, natural: steady(mar10), areaKm2: 100, rainMm: null },
			w
		)!;
		expect(r.overlap).toBeNull();
		expect(r.monthlyBasis).toBe('whole');
		expect(r.flag.basis).toBe('whole');
		expect(w).toContain(
			'WR2012 check: the run has no complete water year inside the reference period (1950/51 – 1990/91), so the MAR is compared over the whole run'
		);
	});

	it('warns when the scaled reference MAR exceeds the rain on the modelled catchment', () => {
		const w: string[] = [];
		// 50 mm a year over 100 km² = 5 Mm³, less than the 10 Mm³ reference.
		wr2012Report({ settings: settings(), startDate: start, natural: steady(mar10), areaKm2: 100, rainMm: new Array(days).fill(50 / 365.25) }, w);
		expect(w.some((x) => /more than the rain that falls on the modelled catchment/.test(x))).toBe(true);
	});

	it('returns null without a reference', () => {
		expect(wr2012Report({ settings: defaultWr2012Settings(), startDate: start, natural: steady(1), areaKm2: 1, rainMm: null }, [])).toBeNull();
	});
});

describe('resolveWr2012', () => {
	it('fills defaults and drops an implausible reference with a warning', () => {
		expect(resolveWr2012(undefined, [])).toEqual(defaultWr2012Settings());
		const w: string[] = [];
		const s = resolveWr2012({ reference: { ...ref(), marMm3: 99 } }, w);
		expect(s.reference).toBeNull();
		expect(w[0]).toMatch(/^WR2012 check skipped/);
		const ok = resolveWr2012({ reference: ref(), lowFlowMonths: [3, 1, 1, 13], flags: { notePct: 5 } }, []);
		expect(ok.reference).toEqual(ref());
		expect(ok.lowFlowMonths).toEqual([1, 3]);
		expect(ok.flags).toEqual({ notePct: 5, queryPct: 25, queryWetterPct: 15, unusablePct: 50 });
	});

	it('accepts a valid MAR band, and drops a one-sided or inverted band (keeping a valid weight) with a warning', () => {
		const ok = resolveWr2012({ calibrationPenalty: { enabled: true, weight: 2, marLowMm3: 5, marHighMm3: 10 } }, []);
		expect(ok.calibrationPenalty).toEqual({ enabled: true, weight: 2, marLowMm3: 5, marHighMm3: 10 });

		const w1: string[] = [];
		const oneSided = resolveWr2012({ calibrationPenalty: { enabled: true, weight: 2, marLowMm3: 5, marHighMm3: null } }, w1);
		expect(oneSided.calibrationPenalty).toEqual({ enabled: true, weight: 2, marLowMm3: null, marHighMm3: null });
		expect(w1[0]).toMatch(/^WR2012 calibration penalty settings aren't usable/);

		const w2: string[] = [];
		const inverted = resolveWr2012({ calibrationPenalty: { enabled: false, weight: 0.5, marLowMm3: 10, marHighMm3: 5 } }, w2);
		expect(inverted.calibrationPenalty).toEqual({ enabled: false, weight: 0.5, marLowMm3: null, marHighMm3: null });
		expect(w2[0]).toMatch(/low bound can.t be above its high bound/);

		// A bad weight and a bad band are corrected independently.
		const w3: string[] = [];
		const both = resolveWr2012({ calibrationPenalty: { enabled: true, weight: 99, marLowMm3: 10, marHighMm3: 5 } }, w3);
		expect(both.calibrationPenalty).toEqual({ enabled: true, weight: 0.5, marLowMm3: null, marHighMm3: null });
	});
});

describe('wr2012PenaltyIssues', () => {
	it('requires both bounds or neither, low ≤ high, and a weight in range', () => {
		expect(wr2012PenaltyIssues({ weight: 1, marLowMm3: null, marHighMm3: null })).toEqual([]);
		expect(wr2012PenaltyIssues({ weight: 1, marLowMm3: 5, marHighMm3: 10 })).toEqual([]);
		expect(wr2012PenaltyIssues({ weight: 1, marLowMm3: 5, marHighMm3: 5 })).toEqual([]); // equal bounds: a zero-width band
		expect(wr2012PenaltyIssues({ weight: 1, marLowMm3: 5, marHighMm3: null }).map((i) => i.field)).toEqual(['marLowMm3']);
		expect(wr2012PenaltyIssues({ weight: 1, marLowMm3: null, marHighMm3: 10 }).map((i) => i.field)).toEqual(['marLowMm3']);
		expect(wr2012PenaltyIssues({ weight: 1, marLowMm3: 10, marHighMm3: 5 }).map((i) => i.field)).toEqual(['marHighMm3']);
		expect(wr2012PenaltyIssues({ weight: 1, marLowMm3: -1, marHighMm3: 10 }).map((i) => i.field)).toEqual(['marLowMm3']);
		expect(wr2012PenaltyIssues({ weight: 11, marLowMm3: null, marHighMm3: null }).map((i) => i.field)).toEqual(['weight']);
	});
});

// ---------------------------------------------------------------------------
// In a run
// ---------------------------------------------------------------------------

const node = (id: string, over: Partial<NetworkNode> = {}): NetworkNode => ({
	id,
	name: id,
	kind: 'farm',
	downstreamNodeId: null,
	sortOrder: 0,
	areaKm2: 0,
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
	returnFlowFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0,
	...over
});

describe('in a run', () => {
	const start = '2001-10-01';
	const days = span(start, '2005-09-30');
	const natural = 10_000; // m³/day
	const mar = m3DayToMm3(natural, 365.25); // 3.6525 Mm³/a

	/** A heavily irrigating farm on a 10 km² catchment: outflow is well below natural flow. */
	function input(): ModelInput {
		return {
			settings: {
				apanMm: new Array(12).fill(3100) as unknown as Monthly,
				wr2012: settings({}, { areaKm2: 10, marMm3: mar, monthlyMm3: evenMonthly(mar) })
			} as ModelInput['settings'],
			model: {
				nodes: [
					node('F', { name: 'Farm', downstreamNodeId: 'G', areaKm2: 10, divertCapacityM3Day: 1e9 }),
					node('G', { name: 'Gauge', kind: 'gauge', sortOrder: 1 })
				],
				crops: [{ id: 'c', name: 'Crop', cropFactor: new Array(12).fill(1) }],
				cropAreas: [{ nodeId: 'F', cropId: 'c', areaM2: 60_000 }],
				transfers: []
			},
			series: { rain_catchment_mm: { startDate: start, values: new Array(days).fill(null) } }
		};
	}

	it('compares natural flow, not outflow: a ratio of 1 against natural flow even though the farm takes most of the river', () => {
		const out = runModelWith(input(), () => ({ naturalFlowM3Day: new Array(days).fill(natural) }));
		const r = out.summary.wr2012!;
		// The outflow is well below natural flow, so an outflow comparison would be ~0.4 and "not usable".
		expect(out.summary.catchment.meanSimulatedOutflowM3Day).toBeLessThan(0.5 * natural);
		expect(r.compared).toBe('natural_flow');
		expect(r.whole.simulatedMarMm3).toBeCloseTo(mar, 10);
		expect(r.overlap!.ratio).toBeCloseTo(1, 10);
		expect(r.whole.ratio).toBeCloseTo(1, 10);
		expect(r.flag.level).toBe('ok');
		expect(out.summary.warnings.some((w) => w.includes('WR2012 naturalised MAR'))).toBe(false);
	});

	it('is deterministic: the same inputs and engine version give an identical report', () => {
		const a = runModel(input());
		const b = runModel(input());
		expect(a.summary.wr2012).toBeDefined();
		expect(JSON.stringify(b.summary.wr2012)).toBe(JSON.stringify(a.summary.wr2012));
		expect(b.engineVersion).toBe(a.engineVersion);
	});

	it('is absent when the project has no reference', () => {
		const i = input();
		(i.settings as Record<string, unknown>).wr2012 = defaultWr2012Settings();
		expect(runModel(i).summary.wr2012).toBeUndefined();
	});
});

describe('wr2012Penalty', () => {
	const start = '2001-10-01';
	const days = span(start, '2005-09-30');

	it('is off by default, and weight × |ln(simulated ÷ target)| when on', () => {
		expect(wr2012Penalty(settings(), start, days, 100, null)).toBeNull();
		const p = wr2012Penalty(settings({ calibrationPenalty: { enabled: true, weight: 2, marLowMm3: null, marHighMm3: null } }), start, days, 50, null)!;
		expect(p.targetMarMm3).toBeCloseTo(5, 12);
		expect(p.basis).toBe('overlap');
		const q = (mar: number) => new Array(days).fill((mar * 1e6) / 365.25);
		expect(p.penalty(q(5))).toBeCloseTo(0, 8);
		expect(p.penalty(q(10))).toBeCloseTo(2 * Math.log(2), 8);
		expect(p.penalty(q(2.5))).toBeCloseTo(2 * Math.log(2), 8); // symmetric: half is as bad as double
		expect(p.marLowMm3).toBeNull();
		expect(p.marHighMm3).toBeNull();
	});

	it('band: zero inside [low, high], weight × |ln(sim ÷ nearest bound)| outside it', () => {
		const p = wr2012Penalty(settings({ calibrationPenalty: { enabled: true, weight: 2, marLowMm3: 4, marHighMm3: 8 } }), start, days, 50, null)!;
		expect(p.marLowMm3).toBe(4);
		expect(p.marHighMm3).toBe(8);
		expect(p.targetMarMm3).toBeCloseTo(Math.sqrt(4 * 8), 10); // the band's geometric mean: equally far (in log space) from both bounds
		const q = (mar: number) => new Array(days).fill((mar * 1e6) / 365.25);
		expect(p.penalty(q(4))).toBeCloseTo(0, 8); // on the low bound
		expect(p.penalty(q(6))).toBeCloseTo(0, 8); // inside
		expect(p.penalty(q(8))).toBeCloseTo(0, 8); // on the high bound
		expect(p.penalty(q(16))).toBeCloseTo(2 * Math.log(2), 8); // double the high bound
		expect(p.penalty(q(2))).toBeCloseTo(2 * Math.log(2), 8); // half the low bound: the same penalty (symmetric per bound)
	});

	it('band: a one-sided or inverted band is ignored here too, falling back to the single scaled target', () => {
		const oneSided = wr2012Penalty(settings({ calibrationPenalty: { enabled: true, weight: 1, marLowMm3: 4, marHighMm3: null } }), start, days, 50, null)!;
		expect(oneSided.marLowMm3).toBeNull();
		expect(oneSided.marHighMm3).toBeNull();
		expect(oneSided.targetMarMm3).toBeCloseTo(5, 12); // ref.marMm3 (10) × area factor (0.5)

		const inverted = wr2012Penalty(settings({ calibrationPenalty: { enabled: true, weight: 1, marLowMm3: 8, marHighMm3: 4 } }), start, days, 50, null)!;
		expect(inverted.marLowMm3).toBeNull();
		expect(inverted.marHighMm3).toBeNull();
		expect(inverted.targetMarMm3).toBeCloseTo(5, 12);
	});
});
