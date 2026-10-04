// Low flows and high-flow components of a Reserve rule table (engine ≥ 0.33.0,
// WP-3.7, docs/model.md §2.9d): worked examples, the event counter, and the
// invariants: natural flow meets its own low flows and its own high flows;
// a table without either reports exactly as before; less flow never meets
// more; a dam on one branch changes only the sites below it.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, NetworkNode } from '../project';
import { Rng } from '../random';
import { runModelWith } from '../run';
import { EWR_HIGH_FLOW_EVENT_LEVEL, EWR_HIGH_FLOW_NATURAL_MIN_SHARE, assessSite, assuranceWarnings, completeMonths, completeWaterYears, countHighFlowEvents, highFlowEventMinDays } from './assurance';
import { DEFAULT_ASSURANCE_POINTS, type EwrHighFlowEvent, type EwrRuleTable } from './rules';

const rows = (row: number[]) => Array.from({ length: 12 }, () => [...row]);
const daysBetween = (a: string, b: string) => toEpochDay(b) - toEpochDay(a) + 1;

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

const freshet = (over: Partial<EwrHighFlowEvent> = {}): EwrHighFlowEvent => ({ label: 'Freshet', months: [11, 12, 1], peakM3s: 10, durationDays: 3, perYear: 2, ...over });

/** Daily m³ so that each calendar month's total is `monthM3(year, month)`. */
function daily(startDate: string, days: number, monthM3: (year: number, month: number) => number): Float64Array {
	const d0 = toEpochDay(startDate);
	const out = new Float64Array(days);
	for (let t = 0; t < days; t++) {
		const d = new Date((d0 + t) * 86_400_000);
		const y = d.getUTCFullYear();
		const m = d.getUTCMonth() + 1;
		out[t] = monthM3(y, m) / new Date(Date.UTC(y, m, 0)).getUTCDate();
	}
	return out;
}

const site = (t: EwrRuleTable, start: string, natural: ArrayLike<number>, impacted: ArrayLike<number>) =>
	assessSite(start, natural.length, { table: t, nodeId: null, name: 'O', isOutlet: true, natural, impacted }).report;

describe('low flows of a total table', () => {
	it('reads the low flow at the same percentile, and splits out the high-flow part', () => {
		// One October of 2 Mm³ natural: 50 % on the curve, 1 Mm³ total and 0.6 Mm³ low flow required; 0.8 flowed.
		const start = '2000-10-01';
		const natural = daily(start, 31, () => 2e6);
		const impacted = daily(start, 31, () => 0.8e6);
		const r = site(table({ lowFlow: rows([1, 0.6, 0.2]) }), start, natural, impacted);
		const [m] = r.months;
		expect(m!.percentile).toBeCloseTo(50, 9);
		expect(m!.required).toBeCloseTo(1, 12);
		expect(m!.requiredLowFlow).toBeCloseTo(0.6, 12);
		expect(m!.requiredHighFlow).toBeCloseTo(0.4, 12);
		expect(m).toMatchObject({ met: false, lowFlowMet: true });
		expect(r.lowFlow).toEqual({ months: 1, met: 1, rate: 1, deficitM3: 0, longestNotMetRun: 0 });
		expect(r.byMonth[0]!.lowFlowRate).toBe(1);
		expect(r.byMonth[1]!.lowFlowRate).toBeNull();
	});

	it('charges the low-flow deficit in m³ and scales the low flow below the driest point', () => {
		// 0.5 Mm³ natural is drier than the 90 % point (1): low flow = 0.2 × 0.5 / 1 = 0.1 Mm³; 0.04 flowed.
		const start = '2001-01-01';
		const natural = daily(start, 31, () => 0.5e6);
		const impacted = daily(start, 31, () => 0.04e6);
		const r = site(table({ lowFlow: rows([1, 0.6, 0.2]) }), start, natural, impacted);
		expect(r.months[0]!.requiredLowFlow).toBeCloseTo(0.1, 12);
		expect(r.months[0]!.lowFlowMet).toBe(false);
		expect(r.lowFlow!.deficitM3).toBeCloseTo(60_000, 3);
		expect(r.lowFlow!.longestNotMetRun).toBe(1);
	});

	it('a table without low flows or high flows reports exactly as before (no new keys)', () => {
		const rng = new Rng(7);
		const start = '1999-10-01';
		const days = daysBetween(start, '2004-09-30');
		const natural = Float64Array.from({ length: days }, () => rng.logFloat(1e3, 1e6));
		const impacted = natural.map((v) => v * rng.float(0, 1));
		const plain = site(table({ naturalSource: 'run', natural: null }), start, natural, impacted);
		const withEmpty = site(table({ naturalSource: 'run', natural: null, lowFlow: null, highFlows: [] }), start, natural, impacted);
		expect(withEmpty).toEqual(plain);
		expect('lowFlow' in plain).toBe(false);
		expect('highFlows' in plain).toBe(false);
		expect(plain.months.some((m) => 'requiredLowFlow' in m || 'lowFlowMet' in m)).toBe(false);
		expect(plain.byMonth.some((m) => 'lowFlowRate' in m)).toBe(false);
	});

	it('on random series: natural flow meets low flows at most its curve, low ≤ total means met total ⇒ met low, and less flow never meets more', () => {
		const rng = new Rng(20260926);
		let months = 0;
		for (let k = 0; k < 150; k++) {
			const start = fromEpochDay(toEpochDay('1980-01-01') + rng.int(0, 30 * 365));
			const days = rng.int(400, 8 * 366);
			const wet = rng.logFloat(10, 1e6);
			const natural = Float64Array.from({ length: days }, () => (rng.bool(0.05) ? 0 : rng.logFloat(1e-3, 1) * wet));
			const points = [...DEFAULT_ASSURANCE_POINTS];
			const unit = rng.pick(['mcm', 'm3s'] as const);
			// The run's own curve, then a total table at most the curve and a low-flow table at most the total.
			const curves = site(table({ points, unit, naturalSource: 'run', natural: null, ewr: rows(points.map(() => 0)) }), start, natural, natural).byMonth.map((m) => m.naturalCurve);
			const ewr = curves.map((c) => points.map((_, i) => (c ? c[i]! * rng.float(0, 1) : 0)));
			const lowFlow = ewr.map((row) => row.map((v) => v * rng.float(0, 1)));
			const t = table({ points, unit, naturalSource: 'run', natural: null, ewr, lowFlow });
			const own = site(t, start, natural, natural);
			for (const m of own.months) expect(m.lowFlowMet, `case ${k} ${m.year}-${m.month}`).toBe(true);
			const impacted = natural.map((v) => v * rng.float(0, 1.2));
			const less = impacted.map((v) => v * rng.float(0, 1));
			const a = site(t, start, natural, impacted);
			const b = site(t, start, natural, less);
			a.months.forEach((m, i) => {
				expect(m.requiredLowFlow!).toBeLessThanOrEqual(m.required * (1 + 1e-12) + 1e-15);
				expect(m.requiredHighFlow).toBeCloseTo(m.required - m.requiredLowFlow!, 9);
				if (m.met) expect(m.lowFlowMet).toBe(true);
				const n = b.months[i]!;
				expect(n.requiredLowFlow).toBe(m.requiredLowFlow);
				if (n.lowFlowMet) expect(m.lowFlowMet, `case ${k} ${m.year}-${m.month}`).toBe(true);
				months++;
			});
			expect(b.lowFlow!.met).toBeLessThanOrEqual(a.lowFlow!.met);
			expect(a.byMonth.reduce((s, m) => s + (m.lowFlowRate ?? 0) * m.years, 0)).toBeCloseTo(a.lowFlow!.met, 9);
		}
		expect(months).toBeGreaterThan(2000);
	});
});

describe('countHighFlowEvents', () => {
	const start = '2000-11-01';
	const peak = 10;
	const at = (m3s: number) => m3s * 86_400;

	it('needs ⌈duration × (1 − level)⌉ days at or above the level', () => {
		expect(EWR_HIGH_FLOW_EVENT_LEVEL).toBe(0.5);
		expect([1, 2, 3, 4, 5, 6, 7, 90].map(highFlowEventMinDays)).toEqual([1, 1, 2, 2, 3, 3, 4, 45]);
	});

	it('counts a natural storm hydrograph that reaches the peak and lasts the duration', () => {
		// The reproduction (engine < 1.9.0 counted none of the 3-day or longer
		// freshets here): a storm on a 1 m³/s base flow rising to 20 m³/s and
		// receding with a 2-day time constant. Its daily flows are 1, 6, 20,
		// 12.5, 8.0, 5.2, 3.6, 2.6 … m³/s: a flood that plainly carries a
		// 10 m³/s, 3-day freshet, with only two consecutive days at or above 10.
		const f = new Float64Array(30).fill(at(1));
		f[9] = at(6);
		for (let t = 0; t < 20; t++) f[10 + t] = at(1 + 19 * Math.exp(-t / 2));
		// Days at or above 5 m³/s (half of 10): 10 … 14 Nov, five days.
		for (const d of [1, 2, 3, 5, 7, 9, 10]) expect(countHighFlowEvents(f, 0, 30, start, peak, d, [11])).toBe(1);
		// A longer event than the storm was: none.
		expect(countHighFlowEvents(f, 0, 30, start, peak, 11, [11])).toBe(0);
		expect(countHighFlowEvents(f, 0, 30, start, peak, 30, [11])).toBe(0);
		// A bigger freshet than the storm: none, however short.
		expect(countHighFlowEvents(f, 0, 30, start, 21, 1, [11])).toBe(0);
		// The storm with its rise above the base flow cut to 40 % by a dam
		// (peak 8.6 m³/s) no longer carries the 10 m³/s freshet, but does a 5 m³/s one.
		const dammed = f.map((v) => at(1) + (v - at(1)) * 0.4);
		expect(countHighFlowEvents(dammed, 0, 30, start, peak, 3, [11])).toBe(0);
		expect(countHighFlowEvents(dammed, 0, 30, start, 5, 3, [11])).toBe(1);
		// Not a listed month: none count.
		expect(countHighFlowEvents(f, 0, 30, start, peak, 3, [12])).toBe(0);
	});

	it('counts a triangular event hydrograph of the stated peak and duration, and not one half as long', () => {
		// A triangle of peak 10 m³/s and base 2h days on a 1 m³/s base flow.
		const tri = (h: number) => {
			const f = new Float64Array(60).fill(at(1));
			for (let i = -h; i <= h; i++) f[20 + i] = at(1 + 9 * (1 - Math.abs(i) / h));
			return f;
		};
		for (const d of [4, 8, 12, 16]) {
			expect(countHighFlowEvents(tri(d / 2), 0, 60, start, peak, d, [11])).toBe(1);
			expect(countHighFlowEvents(tri(d / 4), 0, 60, start, peak, d, [11])).toBe(0);
		}
	});

	it('counts a run above the level once, and two peaks with a fall below it between them twice', () => {
		const f = new Float64Array(40).fill(at(1));
		f.fill(at(6), 2, 12);
		f[4] = at(10);
		f[9] = at(11); // two peaks inside one run above 5: one event
		expect(countHighFlowEvents(f, 0, 40, start, peak, 3, [11])).toBe(1);
		f[7] = at(4); // the flow falls below 5 between them: two events
		expect(countHighFlowEvents(f, 0, 40, start, peak, 3, [11])).toBe(2);
		// The parts are 5 and 4 days long; a 9-day event asks for 5.
		expect(countHighFlowEvents(f, 0, 40, start, peak, 9, [11])).toBe(1);
		expect(countHighFlowEvents(f, 0, 40, start, peak, 11, [11])).toBe(0);
		// A run above the level that never reaches the peak is no event.
		expect(countHighFlowEvents(new Float64Array(10).fill(at(9)), 0, 10, start, peak, 1, [11])).toBe(0);
		// A flow a hair below the peak (float noise) still reaches it.
		expect(countHighFlowEvents(new Float64Array(5).fill(at(peak) * (1 - 1e-12)), 0, 5, start, peak, 5, [11])).toBe(1);
	});

	it('goes by the month of the first day at the peak, and cuts a run at the window’s ends', () => {
		const f = new Float64Array(40).fill(at(1));
		f.fill(at(6), 26, 36); // 27 Nov … 6 Dec above the level
		f.fill(at(20), 30, 32); // 1 … 2 Dec at the peak
		expect(countHighFlowEvents(f, 0, 40, start, peak, 3, [11])).toBe(0);
		expect(countHighFlowEvents(f, 0, 40, start, peak, 3, [12])).toBe(1);
		// Inside a window from 1 Dec, the run starts on 1 Dec and has 6 days.
		expect(countHighFlowEvents(f, 30, 10, start, peak, 12, [12])).toBe(1);
		expect(countHighFlowEvents(f, 30, 10, start, peak, 13, [12])).toBe(0);
		// A window ending on 30 Nov sees the rise but not the peak.
		expect(countHighFlowEvents(f, 0, 30, start, peak, 1, [11, 12])).toBe(0);
		// A missing day breaks a run: 1 … 3 Dec is left.
		f[33] = NaN;
		expect(countHighFlowEvents(f, 30, 10, start, peak, 6, [12])).toBe(1);
		expect(countHighFlowEvents(f, 30, 10, start, peak, 7, [12])).toBe(0);
	});
});

describe('completeWaterYears', () => {
	it('takes only water years whose twelve months are all in the run', () => {
		const s = '2000-10-01';
		const d = daysBetween(s, '2002-09-30');
		expect(completeWaterYears(s, completeMonths(s, d))).toEqual([
			{ from: 0, days: 365, waterYear: 2000 },
			{ from: 365, days: 365, waterYear: 2001 }
		]);
		expect(completeWaterYears('2000-10-02', completeMonths('2000-10-02', d - 1)).map((y) => y.waterYear)).toEqual([2001]);
		expect(completeWaterYears(s, completeMonths(s, d - 1)).map((y) => y.waterYear)).toEqual([2000]);
		// A leap year: water year 2003 holds 29 Feb 2004.
		const l = '2003-10-01';
		expect(completeWaterYears(l, completeMonths(l, 366))).toEqual([{ from: 0, days: 366, waterYear: 2003 }]);
	});
});

describe('high-flow components at a site', () => {
	const start = '2000-10-01';
	const days = daysBetween(start, '2003-09-30');
	/** 1 m³/s, with 4-day floods of 15 m³/s starting on the given dates. */
	function floods(dates: string[]): Float64Array {
		const f = new Float64Array(days).fill(86_400);
		for (const d of dates) f.fill(15 * 86_400, toEpochDay(d) - toEpochDay(start), toEpochDay(d) - toEpochDay(start) + 4);
		return f;
	}

	it('asks each year for no more events than natural flow had, and meets it when the simulated flow has them', () => {
		// Natural: two in water year 2000, one in 2001, none in 2002.
		const natural = floods(['2000-11-05', '2000-12-10', '2001-11-20']);
		// Simulated: the December 2000 flood was held back by a dam.
		const impacted = floods(['2000-11-05', '2001-11-20']);
		const r = site(table({ highFlows: [freshet()] }), start, natural, impacted);
		const [h] = r.highFlows!;
		expect(h!.peakAppliedM3s).toBe(10);
		expect(h!.years).toEqual([
			{ waterYear: 2000, natural: 2, actual: 1, required: 2, met: false },
			{ waterYear: 2001, natural: 1, actual: 1, required: 1, met: true },
			{ waterYear: 2002, natural: 0, actual: 0, required: 0, met: true }
		]);
		expect(h!.overall).toEqual({ years: 3, required: 2, met: 1, rate: 0.5 });
	});

	it('applies the table’s scale to the peak, and caps the requirement at perYear', () => {
		const natural = floods(['2000-11-05', '2000-12-10', '2001-01-02']);
		const r = site(table({ scale: 2, highFlows: [freshet({ peakM3s: 7, perYear: 1 })] }), start, natural, natural);
		// Peak 7 × 2 = 14 m³/s: the 15 m³/s floods reach it.
		expect(r.highFlows![0]!.peakAppliedM3s).toBe(14);
		expect(r.highFlows![0]!.years[0]).toEqual({ waterYear: 2000, natural: 3, actual: 3, required: 1, met: true });
		const higher = site(table({ scale: 2, highFlows: [freshet({ peakM3s: 8 })] }), start, natural, natural);
		expect(higher.highFlows![0]!.overall).toEqual({ years: 3, required: 0, met: 0, rate: null });
	});

	it('warns when natural flow reaches the peak in no more than half the water years (engine ≥ 1.11.0), and not otherwise', () => {
		const blind = (r: ReturnType<typeof site>) => assuranceWarnings(r).filter((w) => w.includes('high flow "'));
		// Positive control: natural floods in 2 of the 3 water years; one year without is not more than half.
		const two = floods(['2000-11-05', '2001-11-20']);
		expect(blind(site(table({ highFlows: [freshet()] }), start, two, two))).toEqual([]);
		// One year with a flood, two without: more than half, so the requirement is waived in most years.
		const one = floods(['2000-11-05']);
		expect(blind(site(table({ highFlows: [freshet()] }), start, one, one))).toEqual([
			'EWR rule table at the outlet (O): high flow "Freshet": the site\'s natural flow reached its 10 m³/s daily-mean peak for the duration in only 1 of 3 water years, so the requirement is waived in the rest and the check can hardly fail; a gazette\'s flood peak is instantaneous, so enter the daily-mean peak it corresponds to (BBM manual, WRC TT 354/08, §21.3)'
		]);
		// An instantaneous peak entered as it is (20 m³/s above the 15 m³/s daily floods): natural flow never reaches it.
		const all = floods(['2000-11-05', '2001-11-20', '2002-12-01']);
		expect(blind(site(table({ highFlows: [freshet({ peakM3s: 20 })] }), start, all, all))[0]).toMatch(/reached its 20 m³\/s daily-mean peak for the duration in only 0 of 3 water years/);
		expect(blind(site(table({ highFlows: [freshet({ peakM3s: 10 })] }), start, all, all))).toEqual([]);
		// The share is the named constant.
		expect(EWR_HIGH_FLOW_NATURAL_MIN_SHARE).toBe(0.5);
	});

	it('on random series: natural flow meets its own high flows, and a flow with no event fails every year that required one', () => {
		const rng = new Rng(4242);
		let required = 0;
		for (let k = 0; k < 60; k++) {
			const s = fromEpochDay(toEpochDay('1990-01-01') + rng.int(0, 3000));
			const d = rng.int(365, 6 * 366);
			const natural = Float64Array.from({ length: d }, () => rng.logFloat(0.01, 100) * 86_400);
			const events = Array.from({ length: rng.int(1, 3) }, (_, i) =>
				freshet({ label: `e${i}`, months: [...new Set([rng.int(1, 12), rng.int(1, 12)])], peakM3s: rng.logFloat(0.5, 50), durationDays: rng.int(1, 3), perYear: rng.int(1, 4) })
			);
			const t = table({ highFlows: events });
			for (const h of site(t, s, natural, natural).highFlows ?? []) {
				expect(h.years.every((y) => y.met && y.actual === y.natural)).toBe(true);
				required += h.overall.required;
			}
			const none = site(t, s, natural, new Float64Array(d));
			for (const h of none.highFlows ?? []) expect(h.overall.met).toBe(0);
		}
		expect(required).toBeGreaterThan(20);
	});
});

// ---------------------------------------------------------------------------
// In a run: two branches, a site on each, the outlet below both
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
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** out ← g1 ← farm a; out ← g2 ← farm b. Farm a may have a dam catching all its runoff. */
function twoBranches(damM3: number, ewrRules: EwrRuleTable[]): ModelInput {
	const days = daysBetween('2000-10-01', '2003-09-30');
	return {
		settings: { ewrPragmaticM3PerDay: new Array(12).fill(0) as never, apanMm: new Array(12).fill(0) as never, ewrRules },
		model: {
			nodes: [
				node('out', { kind: 'gauge' }),
				node('g1', { kind: 'gauge', downstreamNodeId: 'out' }),
				node('g2', { kind: 'gauge', downstreamNodeId: 'out' }),
				node('a', { downstreamNodeId: 'g1', areaKm2: 2, damCapacityM3: damM3, pctRunoffToDam: damM3 > 0 ? 1 : 0 }),
				node('b', { downstreamNodeId: 'g2', areaKm2: 2 })
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2000-10-01', values: new Array(days).fill(0) } }
	};
}

describe('several EWR sites in a run (WP-3.7 acceptance)', () => {
	// Natural flow with a flood of 20 m³/s for 5 days every November.
	const naturalOf = (days: number) =>
		Array.from({ length: days }, (_, t) => {
			const d = new Date((toEpochDay('2000-10-01') + t) * 86_400_000);
			return (d.getUTCMonth() === 10 && d.getUTCDate() <= 5 ? 20 : 2 + Math.sin(t / 29)) * 86_400;
		});
	const run = (input: ModelInput) => runModelWith(input, () => ({ naturalFlowM3Day: naturalOf((input.series.rain_catchment_mm!.values as unknown[]).length) }));
	const rules = ['out', 'g1', 'g2'].map((id) =>
		table({
			siteNodeId: id === 'out' ? null : id,
			// Mean m³/s: the sites carry 0.5–1.5 m³/s of natural base flow, the outlet twice that.
			unit: 'm3s',
			naturalSource: 'run',
			natural: null,
			points: [...DEFAULT_ASSURANCE_POINTS],
			ewr: rows(DEFAULT_ASSURANCE_POINTS.map((p) => (id === 'out' ? 0.8 : 0.4) * (1 - p / 200))),
			lowFlow: rows(DEFAULT_ASSURANCE_POINTS.map((p) => (id === 'out' ? 0.6 : 0.3) * (1 - p / 200))),
			highFlows: [freshet({ months: [11], peakM3s: id === 'out' ? 8 : 4, durationDays: 3, perYear: 1 })]
		})
	);

	it('gives each site its own compliance, and a dam on one branch changes that site and the outlet but not the other branch', () => {
		const before = run(twoBranches(0, rules)).summary.ewrAssurance!;
		const after = run(twoBranches(2e7, rules)).summary.ewrAssurance!;
		expect(before.map((s) => s.nodeId)).toEqual([null, 'g1', 'g2']);
		const by = (list: typeof before, id: string | null) => list.find((s) => s.nodeId === id)!;
		// Undeveloped: every site meets its tables, low flows and floods.
		for (const s of before) {
			expect(s.overall.rate).toBe(1);
			expect(s.lowFlow!.rate).toBe(1);
			expect(s.highFlows![0]!.overall).toEqual({ years: 3, required: 3, met: 3, rate: 1 });
		}
		// The dam on branch 1 catches the November floods: g1 and the outlet lose them, g2 keeps everything.
		expect(by(after, 'g1').highFlows![0]!.overall.met).toBeLessThan(3);
		expect(by(after, 'g1').overall.met).toBeLessThan(by(before, 'g1').overall.met);
		expect(by(after, null).overall.met).toBeLessThan(by(before, null).overall.met);
		expect(by(after, 'g2')).toEqual(by(before, 'g2'));
	});

	it('the run warns about a low-flow grid above the total', () => {
		const bad = { ...rules[0]!, lowFlow: rows(DEFAULT_ASSURANCE_POINTS.map(() => 99)) };
		const out = run(twoBranches(0, [bad]));
		expect(out.summary.warnings.some((w) => /^EWR rule table at the outlet \(out\): the low flows are above the total flow at 120 points/.test(w))).toBe(true);
	});
});
