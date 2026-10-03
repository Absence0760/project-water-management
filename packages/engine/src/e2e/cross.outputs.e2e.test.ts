// End-to-end, round 2: the run-level outputs where features meet.
//
//   - a full-allocation run (§2.12a) with a scenario applied (src/scenario)
//     and compared with its base (src/compare.ts): a registered volume
//     changed by allocation.set moves each year's demand to exactly the new
//     volume; a demand.scale on some months only reshapes the year but
//     can't change its volume; the comparison's deltas are B − A of the two
//     runs' summaries, worked by hand from the volumes;
//   - the seasonal outlook (§2.15) on a network with a river off-take to a
//     canal town (§2.6a) and an allocation cap (§2.12a): every member from
//     the snapshot is the plain run (history + the analogue's rain) on the
//     season's days, to the bit, and the snapshot path is the older
//     re-run-the-history path's outlook, figure by figure.
// Synthetic values only.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay, waterYearOf } from '../calendar';
import type { DemandObject, ModelInput, ModelOutput, NetworkNode, Transfer } from '../project';
import type { AllocationEntry } from '../allocations/compare';
import { captureModelState, runModel, runModelFrom, runModelWithoutChecks, withVerification } from '../run';
import { testCatchment } from '../outlook/testCatchment';
import { outlookAnalogues, outlookSeasonInput, runSeasonalOutlook } from '../outlook/outlook';
import { applyScenario, type ScenarioOp } from '../scenario';
import { compareRuns, diffInputs, type RunInputsSnapshot } from '../compare';

function series(out: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}:${key}`);
	return s.values;
}
const snapshot = (x: ModelInput): RunInputsSnapshot => ({ settings: x.settings, model: x.model, series: Object.fromEntries(Object.entries(x.series).map(([k, s]) => [k, { startDate: s!.startDate, length: s!.values.length, valuesSha256: JSON.stringify(s!.values) }])) });

/** The test catchment with a canal head `c` (a town of 150 m³/day) fed by a river off-take from Farm A. */
function withCanal(x: ModelInput, allocations: AllocationEntry[], mode: 'none' | 'cap' | 'fullAllocation'): ModelInput {
	const town: DemandObject = {
		id: 'ct',
		nodeId: 'c',
		name: 'Canal town',
		category: 'municipal',
		sizing: 'monthly',
		monthlyM3Day: new Array(12).fill(150),
		count: null,
		litresPerUnitDay: null,
		lossPct: 0,
		monthlyFactor: null,
		returnPct: 0.3,
		priority: 'first',
		destination: 'internal',
		enabled: true,
		note: ''
	};
	const canal: NetworkNode = { ...x.model.nodes[1]!, id: 'c', name: 'Canal head', areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, damCapacityM3: 0, damInitialPct: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0, damAreaFullM2: null, sortOrder: 3, downstreamNodeId: 'g' };
	const ot: Transfer = { id: 'ot', fromNodeId: 'a', toNodeId: 'c', months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 0.01, dailyCapM3: 400, minStoragePct: 0, enabled: true, priority: 0, source: 'river', sizing: 'demand', lossPct: 0.1, handsOffM3Day: 150, handsOffEwr: false, topUpDam: false };
	return {
		...x,
		settings: { ...x.settings, allocationMode: mode },
		model: { ...x.model, nodes: [...x.model.nodes, canal], transfers: [ot], demandObjects: [town], allocations }
	};
}

describe('a full-allocation run with a scenario, compared with its base (§2.12a, scenarios, compare.ts)', () => {
	// 1 Oct 2002 … 31 Mar 2006: three whole water years and 182 days of 2005/06 (a 365-day year).
	const ALLOCS: AllocationEntry[] = [
		{ id: 'a1', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 220_000 },
		{ id: 'b1', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: 90_000 },
		{ id: 'c1', nodeId: 'c', waterSource: 'surface', volumeM3PerYear: 60_000 }
	];
	const BASE = withCanal(testCatchment({ start: '2002-10-01', end: '2006-03-31', seed: 29, ewrM3Day: 700 }), ALLOCS, 'fullAllocation');
	const base = withVerification(BASE, runModel(BASE));
	const days = base.days;
	const yearsAsked = 3 + 182 / 365;

	/** Each water year's demand of a unit over the run's days. */
	function yearDemand(out: ModelOutput, id: string): Map<number, number> {
		const d0 = toEpochDay(out.startDate);
		const dem = series(out, id, 'demand');
		const m = new Map<number, number>();
		dem.forEach((v, t) => m.set(waterYearOf(d0 + t), (m.get(waterYearOf(d0 + t)) ?? 0) + v));
		return m;
	}

	it('the base: each unit asks for its volume over the run’s days, the canal town included; the self-checks pass', () => {
		expect(base.summary.verification!.passed, JSON.stringify(base.summary.verification!.checks.filter((c) => !c.passed))).toBe(true);
		for (const [id, v] of [['a', 220_000], ['b', 90_000], ['c', 60_000]] as const) {
			const y = yearDemand(base, id);
			expect([...y.keys()]).toEqual([2002, 2003, 2004, 2005]);
			expect(y.get(2002)!).toBeCloseTo(v, 4);
			expect(y.get(2003)!).toBeCloseTo(v, 4);
			expect(y.get(2005)!).toBeCloseTo((v * 182) / 365, 4);
		}
	});

	it('allocation.set raises Farm A’s volume: its demand follows to the new volume, and the comparison’s demand delta is the volume’s', () => {
		const ops: ScenarioOp[] = [{ op: 'allocation.set', allocation: { id: 'a1', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 300_000 } }];
		const r = applyScenario(BASE, ops);
		expect(r.problems).toEqual([]);
		const out = withVerification(r.input, runModel(r.input));
		expect(out.summary.verification!.passed).toBe(true);
		const y = yearDemand(out, 'a');
		expect(y.get(2003)!).toBeCloseTo(300_000, 4);
		expect(y.get(2005)!).toBeCloseTo((300_000 * 182) / 365, 4);
		// Farm B's and the canal's demand don't move (their volumes are unchanged).
		expect(series(out, 'b', 'demand')).toEqual(series(base, 'b', 'demand'));
		expect(series(out, 'c', 'demand')).toEqual(series(base, 'c', 'demand'));
		const c = compareRuns(base, out);
		expect(c.samePeriod).toBe(true);
		const fa = c.farms.find((f) => f.nodeIdA === 'a')!;
		expect(fa.demandM3Day.delta!).toBeCloseTo((80_000 * yearsAsked) / days, 6);
		expect(c.farms.find((f) => f.nodeIdA === 'b')!.demandM3Day.delta).toBe(0);
		expect(c.totals.demandM3Day.delta!).toBeCloseTo((80_000 * yearsAsked) / days, 6);
		// Supplied rises by no more than the demand did; the river below A can only lose.
		expect(fa.suppliedM3Day.delta!).toBeLessThanOrEqual(fa.demandM3Day.delta! + 1e-9);
		expect(c.catchment.meanNaturalFlowM3Day.delta).toBe(0);
		// The input diff names the changed volume.
		const changes = diffInputs(snapshot(BASE), snapshot(r.input));
		expect(changes.length).toBeGreaterThan(0);
		expect(JSON.stringify(changes)).toMatch(/220[\s,.]?000|220000/);
	});

	it('demand.scale on Nov–Jan only: the year still asks for its volume, moved out of those months in proportion', () => {
		const ops: ScenarioOp[] = [{ op: 'demand.scale', factor: 0.5, nodeIds: ['a'], months: [11, 12, 1] }];
		const r = applyScenario(BASE, ops);
		const out = withVerification(r.input, runModel(r.input));
		expect(out.summary.verification!.passed, JSON.stringify(out.summary.verification!.checks.filter((c) => !c.passed))).toBe(true);
		const y = yearDemand(out, 'a');
		expect(y.get(2003)!).toBeCloseTo(220_000, 4);
		// By hand: in a year, D′ = k′ × f × D₀ with f = 0.5 in Nov–Jan, else 1, and k′ = V ÷ Σ f × D₀;
		// the base has k = V ÷ Σ D₀. So D′ ÷ D = f × Σ D₀ ÷ Σ f D₀, the same every day of the year.
		const d0 = toEpochDay(out.startDate);
		const D = series(base, 'a', 'demand');
		const D1 = series(out, 'a', 'demand');
		const from = toEpochDay('2003-10-01') - d0;
		const to = toEpochDay('2004-09-30') - d0;
		let all = 0;
		let scaled = 0;
		for (let t = from; t <= to; t++) {
			const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
			all += D[t]!;
			scaled += ([11, 12, 1].includes(m) ? 0.5 : 1) * D[t]!;
		}
		for (let t = from; t <= to; t++) {
			const m = new Date((d0 + t) * 86_400_000).getUTCMonth() + 1;
			const want = (([11, 12, 1].includes(m) ? 0.5 : 1) * all * D[t]!) / scaled;
			expect(Math.abs(D1[t]! - want), fromEpochDay(d0 + t)).toBeLessThanOrEqual(1e-9 * Math.max(1, want));
		}
		const c = compareRuns(base, out);
		// Over the run the demand moves months but not volume: the delta is float noise.
		expect(Math.abs(c.farms.find((f) => f.nodeIdA === 'a')!.demandM3Day.delta!)).toBeLessThan(1e-6);
	});

	it('settings.set to a cap: no unit uses more than its volume in any water year, and the comparison sees less supply nowhere above the volume', () => {
		const r = applyScenario(BASE, [{ op: 'settings.set', path: 'allocationMode', value: 'cap' }]);
		expect(r.problems).toEqual([]);
		const out = withVerification(r.input, runModel(r.input));
		expect(out.summary.verification!.passed, JSON.stringify(out.summary.verification!.checks.filter((c) => !c.passed))).toBe(true);
		const d0 = toEpochDay(out.startDate);
		for (const [id, v] of [['a', 220_000], ['b', 90_000], ['c', 60_000]] as const) {
			const sup = series(out, id, 'supplied');
			const used = new Map<number, number>();
			sup.forEach((g, t) => used.set(waterYearOf(d0 + t), (used.get(waterYearOf(d0 + t)) ?? 0) + g));
			for (const [wy, u] of used) expect(u, `${id} ${wy}`).toBeLessThanOrEqual(v * (1 + 1e-9));
		}
		// The cap run asks for the modelled demand, not the volume: its demand is the plain run's.
		const plain = runModel({ ...BASE, settings: { ...BASE.settings, allocationMode: 'none' } });
		expect(series(out, 'a', 'demand')).toEqual(series(plain, 'a', 'demand'));
		const changes = diffInputs(snapshot(BASE), snapshot(r.input));
		expect(changes.some((ch) => ch.area === 'settings')).toBe(true);
	});
});

describe('the seasonal outlook on a network with a river off-take and an allocation cap (§2.15, §2.6a, §2.12a)', () => {
	const RAW = testCatchment({ start: '1996-10-01', end: '2009-09-30', seed: 7, ewrM3Day: 900 });
	const ALLOCS: AllocationEntry[] = [
		{ id: 'a1', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 200_000 },
		{ id: 'c1', nodeId: 'c', waterSource: 'surface', volumeM3PerYear: 40_000 }
	];
	const BASE = withCanal(RAW, ALLOCS, 'cap');
	const baseRun = runModelWithoutChecks(BASE);
	const season = { decisionDate: '2008-12-15', seasonEnd: '2009-04-30' };
	const KEYS: [string | null, string][] = [
		[null, 'simulated_outflow'],
		[null, 'ewr_shortfall'],
		['a', 'supplied'],
		['a', 'dam_storage'],
		['a', 'transfer_rule@ot'],
		['a', 'allocation_room_surface'],
		['c', 'offtake_in'],
		['c', 'supplied'],
		['c', 'allocation_room_surface'],
		['b', 'dam_storage']
	];

	it('every member from the snapshot is the plain run (history + the analogue’s rain) on the season’s days, to the bit', () => {
		const { analogues } = outlookAnalogues(baseRun, season);
		expect(analogues.length).toBeGreaterThanOrEqual(10);
		const snap = captureModelState(BASE, season.decisionDate);
		const k = toEpochDay(season.decisionDate) - toEpochDay(baseRun.startDate);
		const rain = BASE.series.rain_catchment_mm!;
		const rf = series(baseRun, null, 'rain_final');
		const days = toEpochDay(season.seasonEnd) - toEpochDay(season.decisionDate) + 1;
		const problems: string[] = [];
		for (const a of analogues) {
			for (const f of [1, 0.6]) {
				const ops: ScenarioOp[] = f === 1 ? [] : [{ op: 'demand.scale', factor: f }];
				const member = runModelFrom(snap, outlookSeasonInput(BASE, baseRun, season, a, ops).input);
				const ai = toEpochDay(a.from) - toEpochDay(baseRun.startDate);
				const plainInput: ModelInput = {
					...BASE,
					settings: { ...BASE.settings, simulationEnd: season.seasonEnd, ...(f !== 1 ? { demandFactorFrom: season.decisionDate } : {}) },
					model: f === 1 ? BASE.model : { ...BASE.model, nodes: BASE.model.nodes.map((n) => (n.kind === 'farm' ? { ...n, demandFactor: new Array(12).fill(f) } : n)) },
					series: { rain_catchment_mm: { startDate: rain.startDate, values: [...rain.values.slice(0, k), ...rf.slice(ai, ai + days)] } }
				};
				const plain = runModelWithoutChecks(plainInput);
				for (const [n, key] of KEYS) {
					const m = series(member, n, key);
					const p = series(plain, n, key).slice(k);
					const t = m.findIndex((v, i) => !Object.is(v, p[i]));
					if (t >= 0) problems.push(`${a.label} ×${f} ${n}:${key} day ${t}: member ${m[t]} vs plain ${p[t]}`);
				}
			}
		}
		expect(problems.slice(0, 10)).toEqual([]);
	});

	it('the snapshot path’s outlook is the older re-run path’s, figure by figure, the canal town in the demand', () => {
		const levels = [
			{ id: '100', label: '100 %', ops: [] },
			{ id: '70', label: '70 %', ops: [{ op: 'demand.scale' as const, factor: 0.7 }] }
		];
		const warm = runSeasonalOutlook(BASE, { ...season, levels, baseRun });
		const cold = runSeasonalOutlook(BASE, { ...season, levels, baseRun, warmStart: false });
		expect(warm.nYears).toBe(cold.nYears);
		for (const [li, l] of warm.levels.entries()) {
			const c = cold.levels[li]!;
			expect(l.problems ?? []).toEqual([]);
			for (const [yi, y] of l.years.entries()) {
				const z = c.years[yi]!;
				expect(y.seasonEndStorageM3, `${l.id} ${y.label}`).toBe(z.seasonEndStorageM3);
				expect(y.demandM3).toBe(z.demandM3);
				expect(y.suppliedM3).toBe(z.suppliedM3);
				expect(y.ewrDays).toEqual(z.ewrDays);
			}
			// The canal town is one of the farms the member measures.
			expect(Object.keys(l.years[0]!.farms)).toContain('c');
			expect(l.years.map((y) => y.farms)).toEqual(c.years.map((y) => y.farms));
		}
	});
});
