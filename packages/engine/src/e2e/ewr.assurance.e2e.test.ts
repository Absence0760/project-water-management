// End-to-end: Reserve compliance by the assurance rules (docs/model.md §2.9c,
// §2.9d), through the whole model on invented catchments. Natural flow is fed
// directly (runModelWith) with a constant daily flow in each calendar month,
// so every month's natural volume V and simulated volume A is known exactly,
// and each month's requirement R is worked out here from the doc's formulas.
//
//   A (farm, the only one: share 1) → U (junior user, takes MIN(demand, flow)) → O (outlet gauge)
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import type { EwrRuleTable } from '../reserve/rules';
import { runModelWith, withVerification } from '../run';

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
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
		lossReturnFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}
const farm = (id: string, down: string | null, over: Partial<NetworkNode> = {}) => node(id, { downstreamNodeId: down, areaKm2: 1, ...over });
const gauge = (id: string, down: string | null, over: Partial<NetworkNode> = {}) => node(id, { kind: 'gauge', downstreamNodeId: down, ...over });
const user = (id: string, down: string, demand: number[]) => node(id, { kind: 'user', downstreamNodeId: down, userDemandM3Day: demand, userPriority: 'junior', userReturnPct: 0 });

const rows = (row: number[]) => Array.from({ length: 12 }, () => [...row]);
const table = (over: Partial<EwrRuleTable> = {}): EwrRuleTable => ({
	siteNodeId: null,
	source: 'Invented test table',
	component: 'total',
	unit: 'mcm',
	points: [10, 50, 90],
	ewr: rows([1.5, 1, 0.5]),
	naturalSource: 'table',
	natural: rows([3, 2, 1]),
	scale: 1,
	...over
});

const SEC = 86_400;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ymd = (start: string, t: number) => {
	const d = new Date((toEpochDay(start) + t) * SEC * 1000);
	return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

interface Case {
	start: string;
	end: string;
	nodes: NetworkNode[];
	/** Natural volume of each calendar month (m³), by year and month (1–12). */
	monthM3: (y: number, m: number) => number;
	rules: EwrRuleTable[];
	settings?: Record<string, unknown>;
	ewr?: number;
}

function build(c: Case): { input: ModelInput; natural: number[]; days: number } {
	const days = toEpochDay(c.end) - toEpochDay(c.start) + 1;
	const natural = Array.from({ length: days }, (_, t) => {
		const { y, m } = ymd(c.start, t);
		return c.monthM3(y, m) / daysIn(y, m);
	});
	return {
		days,
		natural,
		input: {
			settings: { ewrPragmaticM3PerDay: new Array(12).fill(c.ewr ?? 0) as never, apanMm: new Array(12).fill(0) as never, ewrRules: c.rules, ...c.settings },
			model: { nodes: c.nodes, crops: [], cropAreas: [], transfers: [] },
			series: { rain_catchment_mm: { startDate: c.start, values: new Array(days).fill(0) } }
		}
	};
}
const go = (c: Case): ModelOutput => {
	const b = build(c);
	return runModelWith(b.input, () => ({ naturalFlowM3Day: b.natural }));
};
const ser = (out: ModelOutput, nodeId: string | null, key: string) => {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
};

// --- the doc's formulas, independently --------------------------------------------------------
/** Weibull i/(n+1), linear between, held at the ends (§2.9c). */
function weibull(values: number[], p: number): number {
	const x = [...values].sort((a, b) => b - a);
	const n = x.length;
	const h = (p / 100) * (n + 1);
	if (h <= 1) return x[0]!;
	if (h >= n) return x[n - 1]!;
	const i = Math.floor(h);
	return x[i - 1]! + (h - i) * (x[i]! - x[i - 1]!);
}
function lookup(V: number, P: number[], N: number[], T: number[]): { p: number; R: number; beyond: 'wetter' | 'drier' | null } {
	const k = N.findIndex((n) => n <= V);
	if (k === 0) return { p: P[0]!, R: T[0]!, beyond: V > N[0]! ? 'wetter' : null };
	if (k < 0) return { p: P[P.length - 1]!, R: (T[T.length - 1]! * V) / N[N.length - 1]!, beyond: 'drier' };
	const w = (N[k - 1]! - V) / (N[k - 1]! - N[k]!);
	return { p: P[k - 1]! + w * (P[k]! - P[k - 1]!), R: T[k - 1]! + w * (T[k]! - T[k - 1]!), beyond: null };
}

describe('Reserve compliance at the outlet, one water year with a leap February (table natural curve)', () => {
	const start = '2003-10-01';
	const end = '2004-09-30';
	// Natural volumes per calendar month (Mm³), Oct … Sep: wetter than the table, on points, between, and drier.
	const natMcm: Record<number, number> = { 10: 3.5, 11: 3, 12: 2.5, 1: 2, 2: 1.5, 3: 1, 4: 0.8, 5: 0.4, 6: 2.2, 7: 1.2, 8: 2.75, 9: 0.6 };
	// The user's take (m³/day, Oct … Sep): 0 in Oct, so A = V there.
	const take = [0, 20_000, 30_000, 10_000, 10_000, 15_000, 10_000, 0, 50_000, 5_000, 40_000, 1_000];
	const c: Case = { start, end, nodes: [farm('A', 'U'), user('U', 'O', take), gauge('O', null)], monthM3: (_, m) => natMcm[m]! * 1e6, rules: [table()] };

	it('reads each month’s requirement off the table and judges A ≥ R, month by month', () => {
		const out = go(c);
		const site = out.summary.ewrAssurance![0]!;
		expect(site.nodeId).toBeNull();
		expect(site.months.map((m) => `${m.year}-${m.month}`)).toEqual(['2003-10', '2003-11', '2003-12', '2004-1', '2004-2', '2004-3', '2004-4', '2004-5', '2004-6', '2004-7', '2004-8', '2004-9']);
		let met = 0;
		let deficit = 0;
		site.months.forEach((m, i) => {
			const days = daysIn(m.year, m.month);
			expect(m.days).toBe(days);
			const V = natMcm[m.month]!;
			const A = (V * 1e6 - take[i]! * days) / 1e6;
			const look = lookup(V, [10, 50, 90], [3, 2, 1], [1.5, 1, 0.5]);
			expect(m.natural).toBeCloseTo(V, 9);
			expect(m.actual).toBeCloseTo(A, 9);
			expect(m.percentile).toBeCloseTo(look.p, 9);
			expect(m.required).toBeCloseTo(look.R, 9);
			expect(m.beyond).toBe(look.beyond);
			const ok = A >= look.R * (1 - 1e-9);
			expect(m.met, `${m.year}-${m.month}`).toBe(ok);
			expect(m.deficitM3).toBeCloseTo(ok ? 0 : (look.R - A) * 1e6, 3);
			if (ok) met++;
			deficit += ok ? 0 : (look.R - A) * 1e6;
		});
		// Hand checks of a few months.
		const by = (mo: number) => site.months.find((m) => m.month === mo)!;
		expect(by(10)).toMatchObject({ percentile: 10, beyond: 'wetter' }); // V 3.5 > N₁ 3 → T₁
		expect(by(10).required).toBeCloseTo(1.5, 12);
		expect(by(12).percentile).toBeCloseTo(30, 9); // 2.5 halfway between 3 and 2
		expect(by(12).required).toBeCloseTo(1.25, 12);
		expect(by(5).beyond).toBe('drier'); // 0.4 < 1 → 0.5 × 0.4 / 1 = 0.2
		expect(by(5).required).toBeCloseTo(0.2, 12);
		expect(by(5).met).toBe(true); // nothing taken in May
		expect(by(3).required).toBeCloseTo(0.5, 12); // exactly the driest point: T_last, not scaled
		expect(by(3).beyond).toBeNull();
		expect(site.overall.months).toBe(12);
		expect(site.overall.met).toBe(met);
		expect(site.overall.rate).toBeCloseTo(met / 12, 12);
		expect(site.overall.deficitM3).toBeCloseTo(deficit, 2);
		// Months of the year add up to the whole.
		expect(site.byMonth.map((m) => m.month)).toEqual([10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(site.byMonth.reduce((s, m) => s + m.met, 0)).toBe(site.overall.met);
		expect(site.byMonth.reduce((s, m) => s + m.deficitM3, 0)).toBeCloseTo(site.overall.deficitM3, 3);
	});

	it('the ewr_rule series is each month’s R as m³ ÷ its days (29 in the leap February)', () => {
		const out = go(c);
		const site = out.summary.ewrAssurance![0]!;
		const rule = ser(out, null, 'ewr_rule');
		let t = 0;
		for (const m of site.months) {
			for (let d = 0; d < m.days; d++, t++) expect(rule[t]).toBeCloseTo((m.required * 1e6) / m.days, 6);
		}
		expect(t).toBe(366);
		const feb = site.months.find((m) => m.month === 2)!;
		expect(feb.days).toBe(29);
	});

	it('daily compliance: with a constant daily flow, a failed month has every day short and a met month none', () => {
		const out = go(c);
		const site = out.summary.ewrAssurance![0]!;
		const failedDays = site.months.filter((m) => !m.met).reduce((s, m) => s + m.days, 0);
		expect(site.daily!.days).toBe(366);
		expect(site.daily!.daysNotMet).toBe(failedDays);
		expect(site.daily!.timeNotMet).toBeCloseTo(failedDays / 366, 12);
		expect(site.daily!.requiredM3).toBeCloseTo(site.months.reduce((s, m) => s + m.required * 1e6, 0), 2);
		expect(site.daily!.shortfallM3).toBeCloseTo(site.overall.deficitM3, 2);
		// Per month of the year the daily figures add up to the whole.
		expect(site.byMonth.reduce((s, m) => s + m.daily!.days, 0)).toBe(366);
		expect(site.byMonth.reduce((s, m) => s + m.daily!.daysNotMet, 0)).toBe(failedDays);
	});

	it('a month exactly at its requirement is met; one m³ a day less is not (A ≥ R)', () => {
		// December: V 2.5 → R 1.25 Mm³; take 1.25e6 / 31 a day leaves exactly R.
		const exact = [...take];
		exact[2] = 1.25e6 / 31;
		const out = go({ ...c, nodes: [farm('A', 'U'), user('U', 'O', exact), gauge('O', null)] });
		const dec = out.summary.ewrAssurance![0]!.months.find((m) => m.month === 12)!;
		expect(dec.actual).toBeCloseTo(1.25, 9);
		expect(dec.met).toBe(true);
		expect(dec.deficitM3).toBe(0);
		exact[2] = 1.25e6 / 31 + 1;
		const out2 = go({ ...c, nodes: [farm('A', 'U'), user('U', 'O', exact), gauge('O', null)] });
		const dec2 = out2.summary.ewrAssurance![0]!.months.find((m) => m.month === 12)!;
		expect(dec2.met).toBe(false);
		expect(dec2.deficitM3).toBeCloseTo(31, 3);
	});

	it('in m³/s, the month’s mean flow over its actual days (leap February out of 29)', () => {
		// The same table in m³/s: natural rows in m³/s, so V = volume ÷ (days × 86400).
		const t = table({ unit: 'm3s', natural: rows([3, 2, 1]), ewr: rows([1.5, 1, 0.5]) });
		// February 2004: natural 2 m³/s mean (2 × 29 × 86400 m³), user takes 0.6 m³/s → A 1.4 vs R 1 (V on the 50 % point).
		const febM3 = 2 * 29 * SEC;
		const takeFeb = [...take];
		takeFeb[4] = 0.6 * SEC;
		const out = go({ ...c, rules: [t], nodes: [farm('A', 'U'), user('U', 'O', takeFeb), gauge('O', null)], monthM3: (y, m) => (m === 2 ? febM3 : natMcm[m]! * 1e6) });
		const feb = out.summary.ewrAssurance![0]!.months.find((m) => m.month === 2)!;
		expect(feb.natural).toBeCloseTo(2, 9);
		expect(feb.actual).toBeCloseTo(1.4, 9);
		expect(feb.required).toBeCloseTo(1, 9);
		expect(feb.percentile).toBeCloseTo(50, 9);
		expect(feb.met).toBe(true);
		// The requirement per day is 1 m³/s.
		const rule = ser(out, null, 'ewr_rule');
		const febStart = toEpochDay('2004-02-01') - toEpochDay(start);
		expect(rule[febStart]).toBeCloseTo(SEC, 6);
	});

	it('a site that always fails, and one that never does', () => {
		// The user takes everything: A = 0 every month, so every month with R > 0 fails; deficit = Σ R.
		const all = go({ ...c, nodes: [farm('A', 'U'), user('U', 'O', new Array(12).fill(1e9)), gauge('O', null)] });
		const s = all.summary.ewrAssurance![0]!;
		expect(s.overall.met).toBe(0);
		expect(s.overall.longestNotMetRun).toBe(12);
		expect(s.overall.meanShortfallPct).toBeCloseTo(100, 9);
		expect(s.overall.deficitM3).toBeCloseTo(s.months.reduce((a, m) => a + m.required * 1e6, 0), 2);
		// Nothing taken: natural flow meets its own requirement (T ≤ N at every point).
		const none = go({ ...c, nodes: [farm('A', 'U'), user('U', 'O', new Array(12).fill(0)), gauge('O', null)] });
		const n = none.summary.ewrAssurance![0]!;
		expect(n.overall).toMatchObject({ months: 12, met: 12, rate: 1, deficitM3: 0, longestNotMetRun: 0, meanShortfallPct: null });
		expect(n.daily!.daysNotMet).toBe(0);
	});

	it('a site with a zero requirement never fails, even with no flow at all', () => {
		const out = go({ ...c, rules: [table({ ewr: rows([0, 0, 0]) })], nodes: [farm('A', 'U'), user('U', 'O', new Array(12).fill(1e9)), gauge('O', null)] });
		const s = out.summary.ewrAssurance![0]!;
		expect(s.overall).toMatchObject({ months: 12, met: 12, rate: 1, deficitM3: 0, longestNotMetRun: 0, meanShortfallPct: null });
		expect(s.daily).toMatchObject({ days: 366, daysNotMet: 0, requiredM3: 0, shortfallM3: 0, volumeNotMet: null });
		expect(s.fdc.met).toBe(s.fdc.cells);
	});

	it('the longest run not met counts consecutive months', () => {
		// Fail Nov, Dec, Jan (take everything), then Mar and Apr: longest 3.
		const t2 = [0, 1e9, 1e9, 1e9, 0, 1e9, 1e9, 0, 0, 0, 0, 0];
		const out = go({ ...c, nodes: [farm('A', 'U'), user('U', 'O', t2), gauge('O', null)] });
		const s = out.summary.ewrAssurance![0]!;
		expect(s.months.map((m) => m.met)).toEqual([true, false, false, false, true, false, false, true, true, true, true, true]);
		expect(s.overall.longestNotMetRun).toBe(3);
	});

	it('a part month at either end is not assessed and its days carry no ewr_rule', () => {
		const out = go({ ...c, start: '2003-10-15', end: '2004-09-20' });
		const s = out.summary.ewrAssurance![0]!;
		expect(s.months.map((m) => m.month)).toEqual([11, 12, 1, 2, 3, 4, 5, 6, 7, 8]);
		const rule = ser(out, null, 'ewr_rule');
		expect(Number.isNaN(rule[0]!)).toBe(true);
		expect(Number.isNaN(rule[rule.length - 1]!)).toBe(true);
		expect(s.byMonth.find((m) => m.month === 10)!.years).toBe(0);
		expect(s.byMonth.find((m) => m.month === 10)!.rate).toBeNull();
		expect(s.daily!.days).toBe(s.months.reduce((a, m) => a + m.days, 0));
		expect(out.summary.warnings).toContain('EWR rule table at the outlet (O): the run has no complete Oct, Sep, so those months are not assessed');
		// Not every month of the year: no %nMAR.
		expect(s.ewrPctNmar).toBeUndefined();
	});

	it('%nMAR: Σ of the 12 months’ R over Σ of their natural volumes', () => {
		const out = go(c);
		const s = out.summary.ewrAssurance![0]!;
		const ewrMcm = s.months.reduce((a, m) => a + m.required, 0);
		const marMcm = Object.values(natMcm).reduce((a, v) => a + v, 0);
		expect(s.ewrPctNmar!.ewrMcm).toBeCloseTo(ewrMcm, 9);
		expect(s.ewrPctNmar!.naturalMarMcm).toBeCloseTo(marMcm, 9);
		expect(s.ewrPctNmar!.pct).toBeCloseTo((100 * ewrMcm) / marMcm, 9);
	});

	it('scale multiplies every table value (EWR and natural curve)', () => {
		// Scale 2: N = [6, 4, 2], T = [3, 2, 1]; V for December 2.5 → drier... between 4 and 2: w = 0.75, p = 80, R = 2 − 0.75 = 1.25.
		const out = go({ ...c, rules: [table({ scale: 2 })] });
		const dec = out.summary.ewrAssurance![0]!.months.find((m) => m.month === 12)!;
		expect(dec.percentile).toBeCloseTo(80, 9);
		expect(dec.required).toBeCloseTo(1.25, 9);
	});
});

describe('the natural percentile from the run (Weibull over the run’s own years)', () => {
	// Four water years. October natural (Mm³): 4, 1, 3, 2; every other month 1 Mm³ every year.
	const start = '2000-10-01';
	const end = '2004-09-30';
	const oct: Record<number, number> = { 2000: 4, 2001: 1, 2002: 3, 2003: 2 };
	const c: Case = {
		start,
		end,
		nodes: [farm('A', 'U'), user('U', 'O', new Array(12).fill(0)), gauge('O', null)],
		monthM3: (y, m) => (m === 10 ? oct[y]! : 1) * 1e6,
		rules: [table({ naturalSource: 'run', natural: null, points: [10, 50, 90], ewr: rows([2, 1, 0.5]) })]
	};

	it('builds October’s curve from the four Octobers and reads each one on it', () => {
		const out = go(c);
		const s = out.summary.ewrAssurance![0]!;
		const N = [10, 50, 90].map((p) => weibull([4, 1, 3, 2], p));
		expect(N).toEqual([4, 2.5, 1]);
		const octRow = s.byMonth.find((m) => m.month === 10)!;
		octRow.naturalCurve!.forEach((v, i) => expect(v).toBeCloseTo(N[i]!, 9));
		expect(octRow.years).toBe(4);
		const octs = s.months.filter((m) => m.month === 10);
		expect(octs.map((m) => m.year)).toEqual([2000, 2001, 2002, 2003]);
		for (const m of octs) {
			const look = lookup(oct[m.year]!, [10, 50, 90], N, [2, 1, 0.5]);
			expect(m.percentile).toBeCloseTo(look.p, 9);
			expect(m.required).toBeCloseTo(look.R, 9);
			expect(m.met).toBe(true); // nothing taken; T ≤ N at every point
		}
		// V = 3: between 4 and 2.5, w = 2/3 → p = 36.67, R = 2 − 2/3 = 1.333.
		expect(octs[2]!.percentile).toBeCloseTo(10 + (2 / 3) * 40, 9);
		expect(octs[2]!.required).toBeCloseTo(2 - 2 / 3, 9);
		// A flat curve (every November 1 Mm³): V = N at every point → the wettest point of the stretch.
		const nov = s.months.filter((m) => m.month === 11);
		for (const m of nov) {
			expect(m.percentile).toBe(10);
			expect(m.required).toBe(2);
		}
		// Fewer than 10 years: the run warns the percentiles are coarse.
		expect(out.summary.warnings.some((w) => /only 4 complete years/.test(w))).toBe(true);
	});

	it('the FDC check compares the impacted duration curve with T at each point', () => {
		// The user takes 0.5 Mm³ out of every October (≈ 16 129 m³/day): impacted Octobers 3.5, 0.5, 2.5, 1.5.
		const takeOct = [0.5e6 / 31, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		const out = go({ ...c, nodes: [farm('A', 'U'), user('U', 'O', takeOct), gauge('O', null)] });
		const s = out.summary.ewrAssurance![0]!;
		const row = s.byMonth.find((m) => m.month === 10)!;
		const imp = [3.5, 0.5, 2.5, 1.5];
		const expected = [10, 50, 90].map((p, i) => ({ point: p, required: [2, 1, 0.5][i]!, impacted: weibull(imp, p) }));
		row.fdc.forEach((f, i) => {
			expect(f.point).toBe(expected[i]!.point);
			expect(f.required).toBe(expected[i]!.required);
			expect(f.impacted).toBeCloseTo(expected[i]!.impacted, 9);
			expect(f.met).toBe(expected[i]!.impacted >= expected[i]!.required);
			expect(f.natural).toBeCloseTo(weibull([4, 1, 3, 2], f.point), 9);
		});
		// Impacted curve [3.5, 2, 0.5] vs T [2, 1, 0.5]: all met.
		expect(row.fdc.map((f) => f.met)).toEqual([true, true, true]);
		// Months: 2001 October (V 1 → p 90, R 0.5, A 0.5): met exactly.
		const o2001 = s.months.find((m) => m.month === 10 && m.year === 2001)!;
		expect(o2001.required).toBeCloseTo(0.5, 9);
		expect(o2001.actual).toBeCloseTo(0.5, 9);
		expect(o2001.met).toBe(true);
		// Total cells: 12 months × 3 points.
		expect(s.fdc.cells).toBe(36);
	});
});

describe('low flows and high flows at the outlet (§2.9d)', () => {
	const start = '2003-10-01';
	const end = '2004-09-30';
	it('a month that meets its low flows but not its total, and one that meets neither', () => {
		const natMcm: Record<number, number> = { 10: 2, 11: 2, 12: 2, 1: 2, 2: 2, 3: 2, 4: 2, 5: 2, 6: 2, 7: 2, 8: 2, 9: 2 };
		// R = 1 (50 % point), R_low = 0.6. Take so that A = 0.8 in Oct (low met, total not) and 0.4 in Nov (neither).
		const take = [1.2e6 / 31, 1.6e6 / 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		const out = go({ start, end, nodes: [farm('A', 'U'), user('U', 'O', take), gauge('O', null)], monthM3: (_, m) => natMcm[m]! * 1e6, rules: [table({ lowFlow: rows([1, 0.6, 0.2]) })] });
		const s = out.summary.ewrAssurance![0]!;
		const [o, n] = s.months;
		expect(o).toMatchObject({ met: false, lowFlowMet: true });
		expect(o!.requiredLowFlow).toBeCloseTo(0.6, 12);
		expect(o!.requiredHighFlow).toBeCloseTo(0.4, 12);
		expect(n).toMatchObject({ met: false, lowFlowMet: false });
		expect(s.lowFlow!.months).toBe(12);
		expect(s.lowFlow!.met).toBe(11);
		expect(s.lowFlow!.deficitM3).toBeCloseTo(0.2e6, 2);
		expect(s.lowFlow!.longestNotMetRun).toBe(1);
		expect(s.overall.met).toBe(10);
		// %nMAR of the low flows: 12 × 0.6 over 12 × 2.
		expect(s.ewrPctNmar!.lowFlowPct).toBeCloseTo(30, 9);
		expect(s.ewrPctNmar!.pct).toBeCloseTo(50, 9);
	});

	it('a freshet the natural flow has every water year, and a dam-less user that cuts it below half the peak', () => {
		// Two water years; base flow 1 m³/s; every 10–14 November a storm of 20, 12, 8, 5, 3 m³/s.
		const s0 = '2002-10-01';
		const e0 = '2004-09-30';
		const days = toEpochDay(e0) - toEpochDay(s0) + 1;
		const storm = [20, 12, 8, 5, 3];
		const flow = Array.from({ length: days }, (_, t) => {
			const { m, day } = ymd(s0, t);
			return (m === 11 && day >= 10 && day <= 14 ? storm[day - 10]! : 1) * SEC;
		});
		const rule = table({
			unit: 'm3s',
			naturalSource: 'run',
			natural: null,
			ewr: rows([0, 0, 0]),
			highFlows: [{ label: 'November freshet', months: [11], peakM3s: 10, durationDays: 4, perYear: 1 }]
		});
		const mk = (takeM3s: number) => {
			const take = new Array(12).fill(0);
			take[1] = takeM3s * SEC; // November
			const b = build({ start: s0, end: e0, nodes: [farm('A', 'U'), user('U', 'O', take), gauge('O', null)], monthM3: () => 0, rules: [rule] });
			return runModelWith(b.input, () => ({ naturalFlowM3Day: flow }));
		};
		// Natural: level 5 m³/s; days ≥ 5: 20, 12, 8, 5 → 4 days ≥ ⌈4/2⌉ = 2, peak 20 ≥ 10 on 10 Nov → one event a year.
		const hf = mk(0).summary.ewrAssurance![0]!.highFlows![0]!;
		expect(hf.years.map((y) => [y.waterYear, y.natural, y.actual, y.required, y.met])).toEqual([
			[2002, 1, 1, 1, true],
			[2003, 1, 1, 1, true]
		]);
		expect(hf.overall).toEqual({ years: 2, required: 2, met: 2, rate: 1 });
		// The user takes 10.5 m³/s through November: 9.5, 1.5, … — the peak (10) is never reached → no event.
		const cut = mk(10.5).summary.ewrAssurance![0]!.highFlows![0]!;
		expect(cut.years.map((y) => [y.natural, y.actual, y.required, y.met])).toEqual([
			[1, 0, 1, false],
			[1, 0, 1, false]
		]);
		expect(cut.overall).toEqual({ years: 2, required: 2, met: 0, rate: 0 });
		// Takes 2 m³/s: 18, 10, 6, 3 → days ≥ 5: 3 (≥ 2), peak 18 → still an event.
		const some = mk(2).summary.ewrAssurance![0]!.highFlows![0]!;
		expect(some.overall.met).toBe(2);
	});
});

describe('two sites, one upstream of the other: each judged on its own natural and simulated flow', () => {
	//   A → U1 → G → B → U2 → O ; tables at G and at O (table curves, mcm).
	const start = '2003-10-01';
	const end = '2004-09-30';
	const nodes = (d1: number, d2: number) => [farm('A', 'U1'), user('U1', 'G', new Array(12).fill(d1)), gauge('G', 'B'), farm('B', 'U2'), user('U2', 'O', new Array(12).fill(d2)), gauge('O', null)];
	// Each farm gets half of a natural flow of 4 Mm³ a month: V_G = 2, V_O = 4.
	const rules = [table({ siteNodeId: 'G', natural: rows([3, 2, 1]), ewr: rows([1.5, 1, 0.5]) }), table({ siteNodeId: null, natural: rows([6, 4, 2]), ewr: rows([3, 2, 1]) })];

	it('V at G is A’s runoff only; at O both farms’; upstream use fails both, downstream use only O', () => {
		// U1 takes 1.2 Mm³ a month-ish (40 000 m³/day): at G, A = 2 − 40 000 × days / 1e6.
		const out = go({ start, end, nodes: nodes(40_000, 0), monthM3: () => 4e6, rules });
		const [o, g] = out.summary.ewrAssurance!;
		expect(o!.nodeId).toBeNull();
		expect(g!.nodeId).toBe('G');
		for (const m of g!.months) {
			expect(m.natural).toBeCloseTo(2, 9);
			expect(m.required).toBeCloseTo(1, 9);
			expect(m.actual).toBeCloseTo(2 - (40_000 * m.days) / 1e6, 9);
			expect(m.met).toBe(false);
		}
		for (const m of o!.months) {
			expect(m.natural).toBeCloseTo(4, 9);
			expect(m.required).toBeCloseTo(2, 9);
			expect(m.actual).toBeCloseTo(4 - (40_000 * m.days) / 1e6, 9);
			expect(m.met).toBe(true);
		}
		// Downstream use only: G untouched, O loses.
		const down = go({ start, end, nodes: nodes(0, 80_000), monthM3: () => 4e6, rules });
		expect(down.summary.ewrAssurance![1]!.overall.met).toBe(12);
		expect(down.summary.ewrAssurance![0]!.overall.met).toBe(0);
	});

	it('the charge from the rule table: D = MIN(A_t − R_day, 0) per day, charged to the users upstream of each site', () => {
		const out = go({ start, end, nodes: nodes(40_000, 0), monthM3: () => 4e6, rules, settings: { ewrChargeSource: 'ruleTable' } });
		const ruleG = ser(out, 'G', 'ewr_rule');
		const flowG = ser(out, 'G', 'outflow');
		const shG = ser(out, 'G', 'ewr_charge_shortfall');
		const c1 = ser(out, 'U1', 'ewr_charge');
		for (let t = 0; t < flowG.length; t++) {
			const D = Math.max(ruleG[t]! - flowG[t]!, 0);
			expect(-shG[t]!).toBeCloseTo(D, 6);
			// U1 is the only unit with an impact above G: charged MIN(D, its take).
			expect(-c1[t]!).toBeCloseTo(Math.min(D, 40_000), 6);
		}
		expect(out.summary.curtailment!.ewrSites!.find((s) => s.nodeId === 'G')!.ewrSource).toBe('ruleTable');
		// The pragmatic series are left alone (EWR 0 here: never short).
		expect(out.summary.catchment.ewrDaysNotMet).toBe(0);
		const b = build({ start, end, nodes: nodes(40_000, 0), monthM3: () => 4e6, rules, settings: { ewrChargeSource: 'ruleTable' } });
		const v = withVerification(b.input, out).summary.verification!;
		expect(v.checks.filter((x) => !x.passed).map((x) => `${x.label}: ${x.detail}`)).toEqual([]);
	});
});

describe('low flows on base flow, and the natural MAR check (§2.9c, §2.9d)', () => {
	const start = '2003-10-01';
	const end = '2004-09-30';
	const days = toEpochDay(end) - toEpochDay(start) + 1;
	// A low-flow table: R_low at V = 2.55 (December, a flood month) = 1 + 0.45 × (0.6 − 1) = 0.82 Mm³.
	const low = table({ component: 'lowFlow', ewr: rows([1, 0.6, 0.2]) });
	// Natural: 2 Mm³ a month spread evenly, except December: 50 000 m³/day and a 1e6 m³ flood on the 10th.
	const decFlood = toEpochDay('2003-12-10') - toEpochDay(start);
	const natural = Array.from({ length: days }, (_, t) => {
		const { y, m } = ymd(start, t);
		if (m === 12) return 50_000 + (t === decFlood ? 1e6 : 0);
		return 2e6 / daysIn(y, m);
	});
	const take = new Array(12).fill(0);
	take[2] = 40_000; // December: leaves 10 000 m³/day of base flow and the flood
	const mk = (measure: 'total' | 'baseflow') => {
		const b = build({ start, end, nodes: [farm('A', 'U'), user('U', 'O', take), gauge('O', null)], monthM3: () => 0, rules: [low], settings: { lowFlowMeasure: measure } });
		return runModelWith(b.input, () => ({ naturalFlowM3Day: natural })).summary.ewrAssurance![0]!;
	};

	it('a flood month passes its low flows on volume and fails them on base flow', () => {
		const tot = mk('total');
		const dec = tot.months.find((m) => m.month === 12)!;
		expect(dec.natural).toBeCloseTo(2.55, 9);
		expect(dec.required).toBeCloseTo(0.82, 9);
		expect(dec.actual).toBeCloseTo(2.55 - 1.24, 9);
		expect(dec.met).toBe(true);
		expect(dec.baseflow).toBeUndefined();
		const base = mk('baseflow');
		const decB = base.months.find((m) => m.month === 12)!;
		expect(base.lowFlowMeasure).toBe('baseflow');
		expect(decB.required).toBeCloseTo(0.82, 9); // the requirement doesn't depend on the measure
		expect(decB.baseflow!).toBeLessThanOrEqual(decB.actual * (1 + 1e-12));
		expect(decB.baseflow!).toBeLessThan(0.4);
		expect(decB.met).toBe(false);
		expect(decB.deficitM3).toBeCloseTo((0.82 - decB.baseflow!) * 1e6, 2);
		// Base flow never exceeds the volume; the first month, constant with nothing before it, is all base flow.
		for (const m of base.months) expect(m.baseflow!).toBeLessThanOrEqual(m.actual * (1 + 1e-12));
		expect(base.months[0]!.baseflow!).toBeCloseTo(base.months[0]!.actual, 9);
		// Daily compliance is still on total flow (§2.9c): a base-flow filter has no daily reading.
		expect(base.daily).toEqual(tot.daily);
	});

	it('the run’s natural MAR against the determination’s: exactly 15 % off is within, beyond it warns (percentile from the run)', () => {
		const natMcm = 24; // 2 Mm³ in each of 12 months
		const t = (mar: number) => table({ naturalSource: 'run', natural: null, naturalMarMcm: mar });
		const run = (mar: number) => go({ start, end, nodes: [farm('A', 'U'), user('U', 'O', new Array(12).fill(0)), gauge('O', null)], monthM3: () => 2e6, rules: [t(mar)] });
		const at15 = run(natMcm / 1.15);
		const s = at15.summary.ewrAssurance![0]!;
		expect(s.naturalMar!.runMcm).toBeCloseTo(natMcm, 9);
		expect(s.naturalMar!.differencePct).toBeCloseTo(15, 9);
		expect(at15.summary.warnings.some((w) => /natural MAR/.test(w))).toBe(false);
		const beyond = run(natMcm / 1.16);
		expect(beyond.summary.warnings.some((w) => /natural MAR at the site \(24 Mm³\/a\) is 16 % above/.test(w))).toBe(true);
		// In table mode the gap is reported but never warned about.
		const tbl = go({ start, end, nodes: [farm('A', 'U'), user('U', 'O', new Array(12).fill(0)), gauge('O', null)], monthM3: () => 2e6, rules: [table({ naturalMarMcm: 10 })] });
		expect(tbl.summary.ewrAssurance![0]!.naturalMar!.differencePct).toBeCloseTo(140, 9);
		expect(tbl.summary.warnings.some((w) => /natural MAR/.test(w))).toBe(false);
	});
});

// Silence an unused import if a refactor drops it.
void fromEpochDay;
