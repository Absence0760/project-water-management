// End-to-end: the EWR compliance grid (docs/model.md §2.9), the agreement with
// the observed record (§2.9b) and the river measures (§2.9e), on invented
// catchments run through the whole model with natural flow fed directly.
//
//   A (farm, share 1) → U (junior user) → O (outlet gauge)
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearIndex, waterYearOf } from '../calendar';
import type { ModelInput, ModelOutput, NetworkNode } from '../project';
import type { EwrRuleTable } from '../reserve/rules';
import { runModelWith } from '../run';

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
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}
const farm = (id: string, down: string | null, over: Partial<NetworkNode> = {}) => node(id, { downstreamNodeId: down, areaKm2: 1, ...over });
const gauge = (id: string, down: string | null, over: Partial<NetworkNode> = {}) => node(id, { kind: 'gauge', downstreamNodeId: down, ...over });
const user = (id: string, down: string, demand: number | number[]) =>
	node(id, { kind: 'user', downstreamNodeId: down, userDemandM3Day: Array.isArray(demand) ? demand : new Array(12).fill(demand), userPriority: 'junior', userReturnPct: 0 });

const SEC = 86_400;
interface Opts {
	start: string;
	end: string;
	nodes: NetworkNode[];
	natural: (t: number) => number;
	ewr: number | number[];
	settings?: Record<string, unknown>;
	series?: Record<string, unknown>;
}
function go(o: Opts): { out: ModelOutput; input: ModelInput; days: number } {
	const days = toEpochDay(o.end) - toEpochDay(o.start) + 1;
	const input: ModelInput = {
		settings: { ewrPragmaticM3PerDay: (Array.isArray(o.ewr) ? o.ewr : new Array(12).fill(o.ewr)) as never, apanMm: new Array(12).fill(0) as never, ...o.settings },
		model: { nodes: o.nodes, crops: [], cropAreas: [], transfers: [] },
		series: { rain_catchment_mm: { startDate: o.start, values: new Array(days).fill(0) }, ...(o.series as object) } as never
	};
	const out = runModelWith(input, () => ({ naturalFlowM3Day: Array.from({ length: days }, (_, t) => o.natural(t)) }));
	return { out, input, days };
}
const ser = (out: ModelOutput, nodeId: string | null, key: string) => {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}/${key}`);
	return s.values;
};
const sum = (g: number[][]) => g.flat().reduce((a, b) => a + b, 0);

describe('the EWR compliance grid (§2.9)', () => {
	// A run from 15 Dec 2003 to 10 Feb 2006: part months at both ends, three water-year rows, a leap February.
	const start = '2003-12-15';
	const end = '2006-02-10';
	const d0 = toEpochDay(start);

	it('days per cell are the days simulated (a part month at either end, 29 in the leap February), and the cells add up to the run', () => {
		const { out, days } = go({ start, end, nodes: [farm('A', 'U'), user('U', 'O', 0), gauge('O', null)], natural: () => 1000, ewr: 0 });
		const g = out.summary.ewrCompliance!;
		expect(g.waterYears).toEqual([2003, 2004, 2005]);
		expect(g.days[0]![2]).toBe(17); // 15–31 Dec 2003
		expect(g.days[0]![0]).toBe(0); // Oct 2003: before the run
		expect(g.days[0]![4]).toBe(29); // Feb 2004
		expect(g.days[1]![4]).toBe(28); // Feb 2005
		expect(g.days[2]![4]).toBe(10); // 1–10 Feb 2006
		expect(g.days[2]![5]).toBe(0); // Mar 2006: after the run
		expect(sum(g.days)).toBe(days);
	});

	it('the outlet row counts each short day once (daily method) and sums the shortfall volume; equals the daily series', () => {
		// The flow alternates around the EWR: 600 and 400 on odd and even days against an EWR of 500;
		// every 7th day exactly 500 (met: ≥).
		const natural = (t: number) => (t % 7 === 0 ? 500 : t % 2 ? 600 : 400);
		const { out, days } = go({ start, end, nodes: [farm('A', 'U'), user('U', 'O', 0), gauge('O', null)], natural, ewr: 500 });
		const g = out.summary.ewrCompliance!;
		const notMet = g.days.map((r) => r.map(() => 0));
		const vol = g.days.map((r) => r.map(() => 0));
		let total = 0;
		for (let t = 0; t < days; t++) {
			const q = natural(t);
			if (q < 500) {
				const r = waterYearOf(d0 + t) - 2003;
				const c = waterYearIndex(new Date((d0 + t) * SEC * 1000).getUTCMonth() + 1);
				notMet[r]![c]!++;
				vol[r]![c]! += 500 - q;
				total++;
			}
		}
		expect(g.outlet.daysNotMet).toEqual(notMet);
		g.outlet.shortfallM3.forEach((row, r) => row.forEach((v, c) => expect(v).toBeCloseTo(vol[r]![c]!, 6)));
		expect(out.summary.catchment.ewrDaysNotMet).toBe(total);
		expect(out.summary.catchment.ewrFractionDaysNotMet).toBeCloseTo(total / days, 12);
		// The grid's volume equals −Σ of the ewr_shortfall series.
		expect(sum(g.outlet.shortfallM3)).toBeCloseTo(-ser(out, null, 'ewr_shortfall').reduce((a, b) => a + b, 0), 4);
		// A farm with no impact has an empty row.
		expect(sum(g.farms.find((f) => f.nodeId === 'A')!.daysNotMet)).toBe(0);
	});

	it('a monthly pragmatic EWR is read per water-year month (Oct first)', () => {
		// EWR 0 every month but January (index 3), when it is 2000 against a flow of 1000: only January days fail.
		const ewr = [0, 0, 0, 2000, 0, 0, 0, 0, 0, 0, 0, 0];
		const { out } = go({ start, end, nodes: [farm('A', 'U'), user('U', 'O', 0), gauge('O', null)], natural: () => 1000, ewr });
		const g = out.summary.ewrCompliance!;
		expect(g.outlet.daysNotMet.map((r) => r[3])).toEqual([31, 31, 31]);
		expect(sum(g.outlet.daysNotMet)).toBe(93);
		expect(g.outlet.shortfallM3[0]![3]).toBeCloseTo(31_000, 6);
	});
});

describe('EWR agreement with the observed record (§2.9b)', () => {
	const start = '2004-01-01';
	const end = '2004-12-31';
	// Simulated outflow 1000 m³/day; the EWR 900 → the model is never below. Observed alternates.
	it('cross-tabulates model and observed against the same EWR; at the EWR exactly is not below; missing and excluded days skipped', () => {
		const days = toEpochDay(end) - toEpochDay(start) + 1;
		// Observed (m³/s): day t: 0 → missing, 1 → 800 m³/day (below), 2 → exactly 900 m³/day (not below), 3 → 1200.
		const obs = Array.from({ length: days }, (_, t) => [null, 800 / SEC, 900 / SEC, 1200 / SEC][t % 4]);
		// The model: below on days whose index is a multiple of 3 (natural 850 then), else 1000.
		const natural = (t: number) => (t % 3 === 0 ? 850 : 1000);
		const exclusions = [{ start: '2004-12-01', end: '2004-12-31', reason: 'invented gauge outage' }];
		const { out } = go({ start, end, nodes: [farm('A', 'U'), user('U', 'O', 0), gauge('O', null)], natural, ewr: 900, series: { flow_observed_m3s: { startDate: start, values: obs } }, settings: { calibrationFlowKind: 'flow_observed_m3s', calibrationExclusions: exclusions } });
		const a = out.summary.catchment.ewrAgreement!;
		const dec1 = toEpochDay('2004-12-01') - toEpochDay(start);
		const c = { bothBelow: 0, falseAlarm: 0, miss: 0, bothAbove: 0, excl: 0 };
		for (let t = 0; t < days; t++) {
			const o = obs[t];
			if (o === null) continue;
			if (t >= dec1) {
				c.excl++;
				continue;
			}
			const m = natural(t) < 900;
			const ob = o! * SEC < 900 * (1 - 1e-12);
			if (m && ob) c.bothBelow++;
			else if (m) c.falseAlarm++;
			else if (ob) c.miss++;
			else c.bothAbove++;
		}
		expect(a.excludedDays).toBe(c.excl);
		expect(a.overall).toMatchObject({ bothBelow: c.bothBelow, falseAlarm: c.falseAlarm, miss: c.miss, bothAbove: c.bothAbove });
		expect(a.overall.days).toBe(c.bothBelow + c.falseAlarm + c.miss + c.bothAbove);
		expect(a.overall.hitRate).toBeCloseTo(c.bothBelow / (c.bothBelow + c.miss), 12);
		expect(a.overall.falseAlarmRatio).toBeCloseTo(c.falseAlarm / (c.bothBelow + c.falseAlarm), 12);
		expect(a.overall.frequencyBias).toBeCloseTo((c.bothBelow + c.falseAlarm) / (c.bothBelow + c.miss), 12);
		// By month (water-year order) and water year add up to the whole.
		expect(a.byMonth.reduce((s, m) => s + m.days, 0)).toBe(a.overall.days);
		expect(a.byWaterYear.map((y) => y.waterYear)).toEqual([2003, 2004]);
		expect(a.byWaterYear.reduce((s, y) => s + y.bothBelow, 0)).toBe(c.bothBelow);
		// December is all excluded: its month row has no days, so its ratios are null.
		expect(a.byMonth[2]!.days).toBe(0);
		expect(a.byMonth[2]!.hitRate).toBeNull();
		expect(a.firstObservedDate).toBe('2004-01-02');
	});
	it('a gauge EWR site with its own record gets the same test against its own cumulative EWR', () => {
		// A → U → G → B → O. G's flow 1000 − 300 = 700 vs Z_G = ½ × 1600 = 800: the model is below every day.
		// G's record: 900 m³/day (above) on even days, 700 (below) on odd days.
		const days = toEpochDay(end) - toEpochDay(start) + 1;
		const obs = Array.from({ length: days }, (_, t) => (t % 2 ? 700 : 900) / SEC);
		const nodes = [farm('A', 'U'), user('U', 'G', 300), gauge('G', 'B'), farm('B', 'O'), gauge('O', null)];
		const { out } = go({ start, end, nodes, natural: () => 2000, ewr: 1600, series: { 'flow_observed_m3s@G': { startDate: start, values: obs } } });
		const sites = out.summary.catchment.ewrAgreementSites!;
		expect(sites.map((s) => s.nodeId)).toEqual(['G']);
		const a = sites[0]!.agreement;
		expect(a.overall).toMatchObject({ days, bothBelow: Math.floor(days / 2), falseAlarm: Math.ceil(days / 2), miss: 0, bothAbove: 0 });
		expect(a.overall.hitRate).toBe(1);
		// The outlet has no record: no outlet agreement.
		expect(out.summary.catchment.ewrAgreement).toBeNull();
	});

	it('a whole water year excluded by the calibration exclusions is left out of the agreement', () => {
		const days = toEpochDay(end) - toEpochDay(start) + 1;
		const obs = new Array(days).fill(800 / SEC);
		const { out } = go({ start, end, nodes: [farm('A', 'O'), gauge('O', null)], natural: () => 1000, ewr: 900, series: { flow_observed_m3s: { startDate: start, values: obs } }, settings: { calibrationExclusions: [{ waterYear: 2003, reason: 'invented' }] } });
		const a = out.summary.catchment.ewrAgreement!;
		// 2004-01-01 … 2004-09-30 is water year 2003: excluded; Oct–Dec 2004 scored (92 days, all misses).
		const wy2003 = toEpochDay('2004-09-30') - toEpochDay(start) + 1;
		expect(a.excludedDays).toBe(wy2003);
		expect(a.overall).toMatchObject({ days: days - wy2003, miss: days - wy2003, bothBelow: 0 });
		expect(a.overall.hitRate).toBe(0);
		expect(a.overall.falseAlarmRatio).toBeNull();
	});
});

describe('no-flow days and users served in full while a site fails (§2.9e)', () => {
	const start = '2004-01-01';
	const end = '2004-03-31';

	it('no-flow: below 86.4 m³/day; exactly 86.4 flows; the longest spell', () => {
		// Natural: 10 days at 86.4, 5 days at 86.3, 1 day at 100, 7 days at 0, then 1000.
		const pattern = (t: number) => (t < 10 ? 86.4 : t < 15 ? 86.3 : t < 16 ? 100 : t < 23 ? 0 : 1000);
		const { out } = go({ start, end, nodes: [farm('A', 'O'), gauge('O', null)], natural: pattern, ewr: 0 });
		expect(out.summary.catchment.noFlow).toEqual({ thresholdM3Day: 86.4, days: 12, longestRun: 7 });
	});

	it('a failing site and the users above it: served in full on failing days counts only days with demand fully met', () => {
		// U1 wants 300 every day except February (0). EWR 800 at the outlet; natural 1000; U2 below wants 100 in March only.
		// Jan: flow 700 (short), U1 served. Feb: flow 1000 (met). Mar: 1000 − 300 − 100 = 600 (short), U1 and U2 served.
		const d1 = new Array(12).fill(300);
		d1[4] = 0; // Feb
		const d2 = new Array(12).fill(0);
		d2[5] = 100; // Mar
		const nodes = [farm('A', 'U1'), user('U1', 'B', d1), farm('B', 'U2', { areaKm2: 0 }), user('U2', 'O', d2), gauge('O', null)];
		const { out } = go({ start, end, nodes, natural: () => 1000, ewr: 800 });
		const s = out.summary.servedWhileEwrFails!;
		expect(s).toHaveLength(1);
		expect(s[0]).toMatchObject({ nodeId: null, basis: 'pragmatic', daysNotMet: 31 + 31 });
		expect(s[0]!.units).toEqual([
			{ nodeId: 'U1', name: 'U1', kind: 'user', days: 62 },
			{ nodeId: 'U2', name: 'U2', kind: 'user', days: 31 }
		]);
		expect(out.summary.catchment.ewrDaysNotMet).toBe(62);
	});

	it('with the charge on the rule table, the site is judged on the table’s day (basis ruleTable)', () => {
		// A table asking for 0.7 Mm³ a month (constant): flow 1000 m³/day ≈ 0.03 Mm³ fails every complete month.
		const rule: EwrRuleTable = {
			siteNodeId: null,
			source: 'Invented',
			component: 'total',
			unit: 'mcm',
			points: [10, 90],
			ewr: Array.from({ length: 12 }, () => [0.7, 0.7]),
			naturalSource: 'table',
			natural: Array.from({ length: 12 }, () => [0.01, 0.005]),
			scale: 1
		};
		const { out, days } = go({ start: '2004-01-10', end, nodes: [farm('A', 'U1'), user('U1', 'O', 10), gauge('O', null)], natural: () => 1000, ewr: 0, settings: { ewrRules: [rule], ewrChargeSource: 'ruleTable' } });
		const s = out.summary.servedWhileEwrFails![0]!;
		expect(s.basis).toBe('ruleTable');
		// Feb + Mar are complete months (29 + 31); 10–31 January follows the pragmatic EWR (0: met).
		expect(s.daysNotMet).toBe(60);
		expect(s.units).toEqual([{ nodeId: 'U1', name: 'U1', kind: 'user', days: 60 }]);
		expect(out.summary.warnings.some((w) => /22 days outside a complete calendar month follow the pragmatic EWR/.test(w))).toBe(true);
		// The charge: U1's whole take on each failing day (its impact is far below the shortfall).
		const c = ser(out, 'U1', 'ewr_charge');
		expect(c.slice(0, 22).every((v) => v === 0)).toBe(true);
		expect(c.slice(22).every((v) => Math.abs(v + 10) < 1e-9)).toBe(true);
		expect(c.length).toBe(days);
	});
});
