// Boreholes and stream depletion (WP-1.34, docs/model.md §2.7d): hand-worked
// cases on a fixed natural flow.
import { describe, expect, it } from 'vitest';
import { GA538_ALLUVIAL_DEPLETION_FRAC, GA538_GROUNDWATER_LIMIT_M3_YEAR, GA538_GROUNDWATER_RATES, ga538VolumeM3, type Borehole, type ModelInput, type NetworkNode } from '../project';
import { fromEpochDay, toEpochDay } from '../calendar';
import { damDrawnFor, ga538Warnings, groundwaterAnnualUse, groundwaterDay, twelveMonthsStart, type PlanBorehole } from './boreholes';
import { runModelWith, withVerification } from '../run';
import { checkGroundwater, checkInvariants } from '../verify/checks';
import { randomInput, withoutCropSupply, withoutRiverSources } from '../testing/fuzz';
import { checkDoubledCropAreas, droughtBoreholesAsSupplemental } from '../testing/invariants';

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 1,
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

const flat = (v: number) => new Array(12).fill(v) as number[];

/**
 * A January run of `natural.length` dry days. Farm A needs `need` m³/day
 * (31 000 m² of a crop with factor 1, the January A-pan set to the need,
 * efficiency 1, no effective rain) and drains into the outlet gauge G.
 */
function input(a: Partial<NetworkNode>, need: number, days: number): ModelInput {
	const apanMm = new Array(12).fill(0);
	apanMm[3] = need;
	return {
		settings: { apanMm: apanMm as never, effectiveRainFraction: 0, ewrPragmaticM3PerDay: flat(0) as never },
		model: {
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', a)],
			crops: [{ id: 'c', name: 'Crop', cropFactor: flat(1) }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 31_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: new Array(days).fill(0) } }
	};
}

const run = (i: ModelInput, natural: number[]) => withVerification(i, runModelWith(i, () => ({ naturalFlowM3Day: natural })));
const col = (o: ReturnType<typeof run>, id: string | null, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)!.values;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

describe('boreholes (WP-1.34)', () => {
	it('supplemental boreholes cover only what the river cannot; primary ones pump first', () => {
		// A dam-less farm needing 2000 m³/day, a borehole of 800 m³/day, no depletion.
		const natural = [1000, 10_000, 1500];
		const supp = run(input({ boreholeCapacityM3Day: 800, boreholeRule: 'supplemental' }, 2000, 3), natural);
		const prim = run(input({ boreholeCapacityM3Day: 800, boreholeRule: 'primary' }, 2000, 3), natural);
		for (const o of [supp, prim]) expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		// Supplemental: river 1000 + 800 pumped (200 short); wet day none pumped; 1500 + 500.
		expect(col(supp, 'A', 'groundwater_used')).toEqual([800, 0, 500]);
		expect(col(supp, 'A', 'supplied')).toEqual([1800, 2000, 2000]);
		expect(col(supp, 'A', 'deficit')).toEqual([200, 0, 0]);
		// Primary: 800 pumped every day, the river covers the rest.
		expect(col(prim, 'A', 'groundwater_used')).toEqual([800, 800, 800]);
		expect(col(prim, 'A', 'supplied')).toEqual([1800, 2000, 2000]);
		// So the river keeps more on a wet day: 10 000 − 1200 instead of − 2000.
		expect(col(prim, null, 'simulated_outflow')[1]).toBe(8800);
		expect(col(supp, null, 'simulated_outflow')[1]).toBe(8000);
		expect(supp.summary.farms[0]).toMatchObject({ avgGroundwaterM3Day: 1300 / 3, avgBaseflowDepletionM3Day: 0 });
	});

	it('drought boreholes run only while the dam is below its trigger', () => {
		// A dam of 10 000 m³ starting full, no inflow, 3000 m³/day demand, trigger 50 %:
		// day 0 (10 000 at the start) the dam gives 3000; day 1 (7000) 3000; day 2 (4000 < 5000) the dam gives 3000 and nothing is pumped
		// because it covers the demand; day 3 (1000) the dam gives 1000 and the borehole 2000 (capacity 2500).
		const a = { damCapacityM3: 10_000, damInitialPct: 1, pctRunoffToDam: 1, boreholeCapacityM3Day: 2500, boreholeRule: 'drought' as const, boreholeTriggerPct: 0.5 };
		const o = run(input(a, 3000, 5), [0, 0, 0, 0, 0]);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(col(o, 'A', 'groundwater_used')).toEqual([0, 0, 0, 2000, 2500]);
		expect(col(o, 'A', 'supplied')).toEqual([3000, 3000, 3000, 3000, 2500]);
		// Supplemental pumps as soon as the dam falls short, whatever its level.
		const s = run(input({ ...a, boreholeRule: 'supplemental' }, 3000, 5), [0, 0, 0, 0, 0]);
		expect(col(s, 'A', 'groundwater_used')).toEqual([0, 0, 0, 2000, 2500]);
		// With the trigger at 0 the drought rule never pumps.
		const never = run(input({ ...a, boreholeTriggerPct: 0 }, 3000, 5), [0, 0, 0, 0, 0]);
		expect(col(never, 'A', 'groundwater_used')).toEqual([0, 0, 0, 0, 0]);
	});

	it('stream depletion d × pumping is taken from the river, the same day without a lag', () => {
		// Primary 1000 m³/day, d = 0.4, no lag: 400 leaves the river below the farm each day.
		const o = run(input({ boreholeCapacityM3Day: 1000, boreholeRule: 'primary', streamDepletionFrac: 0.4 }, 1000, 3), [5000, 5000, 5000]);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(col(o, 'A', 'baseflow_depletion')).toEqual([400, 400, 400]);
		// The river keeps all 5000 of its runoff (the borehole covers the farm) less the depletion.
		expect(col(o, null, 'simulated_outflow')).toEqual([4600, 4600, 4600]);
		const wb = o.summary.waterBalance!.total;
		expect(wb.groundwaterM3).toBe(3000);
		expect(wb.streamDepletionM3).toBe(1200);
		expect(Math.abs(wb.residualM3)).toBeLessThan(1e-9);
	});

	it('the lag spreads the depletion out and conserves its volume: over a long run Σ depletion → d × Σ pumping', () => {
		// Pump 1000 m³/day for 10 days, then stop; d = 0.5, k = 20 days; the river always has water.
		const days = 2000;
		const i = input({ boreholeCapacityM3Day: 1000, boreholeRule: 'primary', streamDepletionFrac: 0.5, streamDepletionLagDays: 20 }, 1000, days);
		// Demand only in January of the first year: 31 days of pumping.
		const o = run(i, new Array(days).fill(1e6));
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		const pumped = sum(col(o, 'A', 'groundwater_used'));
		const dep = col(o, 'A', 'baseflow_depletion');
		const store = col(o, 'A', 'depletion_store');
		// Day 0: 500 into the store, α = 1 − e^(−1/20) of it out.
		const alpha = 1 - Math.exp(-1 / 20);
		expect(dep[0]).toBeCloseTo(500 * alpha, 9);
		// Depletion keeps going after the pumping stops (January is 31 days; it runs every January).
		const firstFeb = 31;
		expect(col(o, 'A', 'groundwater_used')[firstFeb]).toBe(0);
		expect(dep[firstFeb]).toBeGreaterThan(0);
		// Volume: d × Σ pumped = Σ depletion + what is still in the store.
		expect(sum(dep) + store.at(-1)!).toBeCloseTo(0.5 * pumped, 6);
	});

	it('depletion never takes the river below 0: what it cannot give is owed, reported and warned about at the end', () => {
		// The farm takes the whole river, and pumps the rest; d = 1: nothing is left to deplete.
		const o = run(input({ boreholeCapacityM3Day: 5000, boreholeRule: 'supplemental', streamDepletionFrac: 1 }, 3000, 2), [1000, 1000]);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(col(o, 'A', 'baseflow_depletion')).toEqual([0, 0]);
		expect(col(o, 'A', 'depletion_deficit')).toEqual([2000, 4000]);
		expect(o.series.some((s) => s.key === 'depletion_unmet')).toBe(false);
		expect(col(o, null, 'simulated_outflow')).toEqual([0, 0]);
		expect(o.summary.warnings.some((w) => w.startsWith('stream depletion of 4000 m³ is still owed to the river at the end of the run') && w.includes('A 4000 m³'))).toBe(true);
	});

	it('the deficit carries over and comes off the first flow that returns (engine 1.10.0, hydrologist review item 15)', () => {
		// Dry days 0–2: the farm takes all 1000 and pumps 2000 (d = 0.5, no lag): 1000 owed a day.
		// Day 3: 10 000 in the river, the farm takes 3000 of it and pumps nothing: the 3000 owed comes off the 7000 left.
		// Day 4: 5000 − 3000 = 2000 left, owed 0: nothing taken.
		const o = run(input({ boreholeCapacityM3Day: 5000, boreholeRule: 'supplemental', streamDepletionFrac: 0.5 }, 3000, 5), [1000, 1000, 1000, 10_000, 5000]);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(col(o, 'A', 'depletion_deficit')).toEqual([1000, 2000, 3000, 0, 0]);
		expect(col(o, 'A', 'baseflow_depletion')).toEqual([0, 0, 0, 3000, 0]);
		expect(col(o, null, 'simulated_outflow')).toEqual([0, 0, 0, 4000, 2000]);
		// Repaid in full: no end-of-run warning.
		expect(o.summary.warnings.some((w) => w.includes('still owed to the river'))).toBe(false);
		// Partly repaid: 2500 left on day 3 covers 2500 of the 3000 owed.
		const part = run(input({ boreholeCapacityM3Day: 5000, boreholeRule: 'supplemental', streamDepletionFrac: 0.5 }, 3000, 4), [1000, 1000, 1000, 5500]);
		expect(part.summary.verification!.passed, JSON.stringify(part.summary.verification)).toBe(true);
		expect(col(part, 'A', 'baseflow_depletion')).toEqual([0, 0, 0, 2500]);
		expect(col(part, 'A', 'depletion_deficit')).toEqual([1000, 2000, 3000, 500]);
		expect(part.summary.warnings.some((w) => w.startsWith('stream depletion of 500 m³ is still owed'))).toBe(true);
	});

	it('mass balance: depletion taken from the river + the deficit owed at the end = depletion generated, and + the lag store = d × pumped', () => {
		// A year of flow switching between dry spells and wet days, with a lag, so the deficit builds and is repaid several times.
		const days = 365;
		const natural = Array.from({ length: days }, (_, t) => (t % 60 < 40 ? 500 : 20_000 * ((t % 7) + 1) / 7));
		const d = 0.7;
		const o = run(input({ boreholeCapacityM3Day: 4000, boreholeRule: 'supplemental', streamDepletionFrac: d, streamDepletionLagDays: 15 }, 3000, days), natural);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		const pumped = sum(col(o, 'A', 'groundwater_used'));
		const taken = sum(col(o, 'A', 'baseflow_depletion'));
		const owed = col(o, 'A', 'depletion_deficit');
		const store = col(o, 'A', 'depletion_store');
		expect(Math.max(...owed)).toBeGreaterThan(0);
		// Generated (fallen due) = d × pumped − what is still in the lag store.
		const generated = d * pumped - store.at(-1)!;
		expect(taken + owed.at(-1)!).toBeCloseTo(generated, 6);
		// The deficit is never more than the depletion generated so far: it can't grow without limit.
		let gen = 0;
		const gw = col(o, 'A', 'groundwater_used');
		for (let t = 0; t < days; t++) {
			gen += d * gw[t]!;
			expect(owed[t]!).toBeLessThanOrEqual(gen - store[t]! + 1e-6);
		}
		// A deficit only on a day the river had nothing left below the farm.
		const out = col(o, null, 'simulated_outflow');
		for (let t = 0; t < days; t++) if (owed[t]! > 1e-9) expect(out[t]!).toBeLessThan(1e-9);
	});

	it('a farm with boreholes shows less deficit, and the outlet shows the depletion', () => {
		const natural = [800, 800, 800];
		const without = run(input({}, 2000, 3), natural);
		const withB = run(input({ boreholeCapacityM3Day: 1000, streamDepletionFrac: 0.3 }, 2000, 3), [5000, 5000, 5000]);
		const withSame = run(input({ boreholeCapacityM3Day: 1000, streamDepletionFrac: 0.3 }, 2000, 3), natural);
		expect(withSame.summary.farms[0]!.avgDeficitM3Day).toBeLessThan(without.summary.farms[0]!.avgDeficitM3Day);
		// Wet enough that the farm is served from the river: no pumping, no depletion.
		expect(col(withB, 'A', 'groundwater_used')).toEqual([0, 0, 0]);
		// Dry: pumped 1000 a day, 300 of which the river can't give (it's all taken): owed, and it adds up.
		expect(col(withSame, 'A', 'groundwater_used')).toEqual([1000, 1000, 1000]);
		expect(col(withSame, 'A', 'depletion_deficit')).toEqual([300, 600, 900]);
	});

	it('an other water user can have boreholes too', () => {
		const i = input({}, 0, 2);
		i.model.nodes.push(node('U', 'user', 'G', { userDemandM3Day: flat(1500), boreholeCapacityM3Day: 1000, streamDepletionFrac: 0.5 }));
		i.model.nodes.find((n) => n.id === 'A')!.downstreamNodeId = 'U';
		const o = run(i, [1000, 3000]);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		// Day 0: 1000 from the river, 500 pumped, 250 depletion — but the river below has 0 left: owed.
		// Day 1: 3000 − 1500 = 1500 left, so the 250 owed comes off it.
		expect(col(o, 'U', 'groundwater_used')).toEqual([500, 0]);
		expect(col(o, 'U', 'supplied')).toEqual([1500, 1500]);
		expect(col(o, 'U', 'depletion_deficit')).toEqual([250, 0]);
		expect(col(o, 'U', 'baseflow_depletion')).toEqual([0, 250]);
		expect(o.summary.users![0]!.avgGroundwaterM3Day).toBe(250);
	});

	it('no boreholes: no groundwater series or summary fields, and the self-checks catch a broken lag', () => {
		const plain = run(input({}, 1000, 2), [5000, 5000]);
		expect(plain.series.some((s) => s.key === 'groundwater_used')).toBe(false);
		expect(plain.summary.farms[0]!.avgGroundwaterM3Day).toBeUndefined();
		expect(plain.summary.waterBalance!.total.groundwaterM3).toBeUndefined();
		const i = input({ boreholeCapacityM3Day: 1000, boreholeRule: 'primary', streamDepletionFrac: 0.4, streamDepletionLagDays: 3 }, 1000, 3);
		const o = run(i, [5000, 5000, 5000]);
		expect(checkInvariants(i, o)).toBeNull();
		const broken = structuredClone(o);
		col(broken, 'A', 'depletion_store')[1]! -= 10;
		expect(checkGroundwater(i, broken)).toMatch(/A day 1: depletion store|A day 2/);
		const greedy = structuredClone(o);
		col(greedy, 'A', 'groundwater_used')[0] = 2000;
		expect(checkGroundwater(i, greedy)).toMatch(/groundwater 2000 outside/);
	});

	it('a drought rule can legitimately raise the supply fraction when demand grows (seed 4536; was 4623 before a dam on the river lost River to dam, engine 1.68.0, and 1450 before the fuzz generator drew rule tables), so the doubled-crop-area law is checked without it', () => {
		// Engine 1.73.0's crop supply tables are taken off, so the case is the one found.
		const input = withoutCropSupply(randomInput(4536));
		expect(checkDoubledCropAreas(input)).toMatch(/doubling crop areas raised n8's supply fraction/);
		expect(checkDoubledCropAreas(droughtBoreholesAsSupplemental(input))).toBeNull();
	});

	it('an annual borehole cap can legitimately raise a downstream farm’s time reliability when demand grows (seed 2909), so the law is checked without caps', () => {
		// More demand uses n2's capped borehole up earlier, so its lagged stream depletion falls earlier and misses the
		// days n1's dam (minimum level 100 %) needs the river to refill.
		// Engine 1.65.0's river abstractions are taken off, so the case is the one found.
		const input = withoutRiverSources(randomInput(2909));
		expect(input.model.boreholes!.some((b) => b.nodeId === 'n2' && b.annualCapM3 !== null && b.depletionFactor > 0)).toBe(true);
		const rules = droughtBoreholesAsSupplemental(input);
		for (const b of rules.model.boreholes ?? []) b.annualCapM3 = input.model.boreholes!.find((x) => x.id === b.id)!.annualCapM3;
		expect(checkDoubledCropAreas(rules)).toMatch(/doubling crop areas raised n1's timeReliability/);
		expect(checkDoubledCropAreas(droughtBoreholesAsSupplemental(input))).toBeNull();
	});

	it('a primary dam-target borehole can legitimately raise a downstream farm’s supply fraction when demand grows (seeds 4536, 10028), so the law is checked with it supplemental', () => {
		// It tops the dam up to capacity only on a day the dam is drawn for demand (engine ≥ 1.8.0), so more
		// demand switches it on, like a drought trigger. 4536: n12's direct borehole covered the base demand
		// on day 23, so the dam wasn't drawn; doubled, it was, the 1e9 m³/day unit refilled the dam that day
		// and a flood took the stream depletion at once, while the base run refilled it on the dry day 24 and
		// owed 40 000 m³ of depletion for days (n8 0.288 → 0.492). 10028: n16's dam seeps all it holds, and
		// doubled demand kept it filled from groundwater every day, all it holds seeping on down to n13
		// (0.781 → 0.852). 20 000-case soak on engine 1.20.0, #164.
		for (const [seed, id] of [[4536, 'n12'], [10028, 'n16']] as const) {
			// Engine 1.73.0's crop supply tables are taken off, so each case is the one found.
			const input = withoutCropSupply(randomInput(seed));
			expect(input.model.boreholes!.some((b) => b.nodeId === id && b.mode === 'primary' && b.target === 'dam'), `seed ${seed}`).toBe(true);
			// The rest of the helper, with the primary dam-target units left as they are.
			const rules = droughtBoreholesAsSupplemental(input);
			for (const b of rules.model.boreholes ?? []) if (input.model.boreholes!.find((x) => x.id === b.id)!.mode === 'primary') b.mode = 'primary';
			expect(checkDoubledCropAreas(rules), `seed ${seed}`).toMatch(/doubling crop areas raised n(8|13)'s supply fraction/);
			expect(checkDoubledCropAreas(droughtBoreholesAsSupplemental(input)), `seed ${seed}`).toBeNull();
		}
	});
});

describe('individual boreholes (WP-3.9)', () => {
	const bh = (over: Partial<Borehole> = {}): Borehole => ({
		id: 'b1',
		nodeId: 'A',
		name: 'BH1',
		capacityM3Day: 800,
		annualCapM3: null,
		mode: 'supplemental',
		emergencyBelowPct: 0.3,
		target: 'direct',
		depletionFactor: 0,
		...over
	});
	const withBores = (i: ModelInput, b: Borehole[]): ModelInput => ({ ...i, model: { ...i.model, boreholes: b } });
	const ok = (o: ReturnType<typeof run>) => expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);

	it('no boreholes, or only ones switched off, give the same output to the bit', () => {
		const plain = run(input({}, 2000, 3), [1000, 3000, 500]);
		const off = run(withBores(input({}, 2000, 3), [bh({ mode: 'none' }), bh({ id: 'b2', capacityM3Day: 0 })]), [1000, 3000, 500]);
		expect(JSON.stringify(off.series)).toBe(JSON.stringify(plain.series));
		expect(off.summary.groundwaterAnnualUse).toBeUndefined();
		expect(off.summary.farms).toEqual(plain.summary.farms);
	});

	it("a node's combined borehole capacity (WP-1.34) and one uncapped direct borehole with the same values run identically", () => {
		const natural = [1000, 10_000, 1500, 200];
		const combined = run(input({ boreholeCapacityM3Day: 800, boreholeRule: 'supplemental', streamDepletionFrac: 0.4, streamDepletionLagDays: 3 }, 2000, 4), natural);
		const single = run(withBores(input({ streamDepletionLagDays: 3 }, 2000, 4), [bh({ depletionFactor: 0.4 })]), natural);
		ok(single);
		for (const k of ['groundwater_used', 'baseflow_depletion', 'depletion_store', 'supplied', 'outflow']) expect(col(single, 'A', k)).toEqual(col(combined, 'A', k));
	});

	it('each borehole has its own mode: primary pumps before the river, supplemental after it', () => {
		// A dam-less farm needing 2000 m³/day: a primary borehole of 500 and a supplemental one of 800.
		const o = run(withBores(input({}, 2000, 3), [bh({ id: 'p', name: 'P', mode: 'primary', capacityM3Day: 500 }), bh({ id: 's', name: 'S' })]), [1000, 10_000, 1500]);
		ok(o);
		// Day 0: 500 primary, the river's 1000, 500 supplemental. Days 1–2: 500 primary, the river covers the rest.
		expect(col(o, 'A', 'groundwater_used')).toEqual([1000, 500, 500]);
		expect(col(o, 'A', 'supplied')).toEqual([2000, 2000, 2000]);
		const year = o.summary.groundwaterAnnualUse!;
		expect(year).toHaveLength(1);
		expect(year[0]!.boreholes.map((b) => [b.id, b.abstractionM3])).toEqual([
			['p', 1500],
			['s', 500]
		]);
	});

	it('an annual cap stops a borehole for the rest of the water year; it pumps again from 1 October', () => {
		// Sep 28 – Oct 3, 2021, dry, a dam-less farm needing ~3000 m³/day; 1000 m³/day capacity, 2500 m³ a year.
		const i = withBores(input({}, 3000, 6), [bh({ capacityM3Day: 1000, annualCapM3: 2500, depletionFactor: 0.2 })]);
		i.settings.apanMm = flat(3000) as never;
		i.series.rain_catchment_mm = { startDate: '2021-09-28', values: new Array(6).fill(0) };
		const o = run(i, new Array(6).fill(0));
		ok(o);
		expect(col(o, 'A', 'groundwater_used')).toEqual([1000, 1000, 500, 1000, 1000, 500]);
		const rows = o.summary.groundwaterAnnualUse!;
		expect(rows.map((r) => [r.label, r.days, r.abstractionM3, r.annualCapM3, r.gaLimitM3])).toEqual([
			['2020/21', 3, 2500, 2500, 40_000],
			['2021/22', 3, 2500, 2500, 40_000]
		]);
		expect(rows[0]!.boreholes[0]!.capReached).toBe(true);
		expect(o.summary.warnings.some((w) => w.startsWith('borehole annual cap reached') && w.includes('A: BH1'))).toBe(true);
		// The self-check reads the caps from the summary: a year over its cap is caught.
		const bad = structuredClone(o);
		bad.summary.groundwaterAnnualUse![0]!.boreholes[0]!.annualCapM3 = 2000;
		expect(checkGroundwater(i, bad)).toMatch(/over its annual cap 2000/);
		const lost = structuredClone(o);
		lost.summary.groundwaterAnnualUse!.pop();
		expect(checkGroundwater(i, lost)).toMatch(/no row for water year 2021/);
	});

	it('a dam-target borehole pumps into the dam: supplemental covers the day, primary fills it, and neither makes it spill', () => {
		// A 10 000 m³ dam, empty, no inflow, a farm needing 500 m³/day; a borehole of 2000 m³/day into the dam.
		const dam = { damCapacityM3: 10_000, damInitialPct: 0 };
		const supp = run(withBores(input(dam, 500, 8), [bh({ capacityM3Day: 2000, target: 'dam' })]), new Array(8).fill(0));
		const prim = run(withBores(input(dam, 500, 8), [bh({ capacityM3Day: 2000, target: 'dam', mode: 'primary' })]), new Array(8).fill(0));
		ok(supp);
		ok(prim);
		expect(col(supp, 'A', 'groundwater_to_dam')).toEqual(new Array(8).fill(500));
		expect(col(supp, 'A', 'groundwater_used')).toEqual(new Array(8).fill(0));
		expect(col(supp, 'A', 'supplied')).toEqual(new Array(8).fill(500));
		expect(col(prim, 'A', 'groundwater_to_dam')).toEqual([2000, 2000, 2000, 2000, 2000, 2000, 1000, 500]);
		expect(col(prim, 'A', 'dam_storage')).toEqual([1500, 3000, 4500, 6000, 7500, 9000, 9500, 9500]);
		expect(col(prim, 'A', 'spill')).toEqual(new Array(8).fill(0));
		expect(prim.summary.farms[0]!.avgGroundwaterToDamM3Day).toBe(13_500 / 8);
		expect(prim.summary.groundwaterAnnualUse![0]).toMatchObject({ abstractionM3: 13_500, toDamM3: 13_500 });
		// The water balance counts water pumped into the dam as groundwater in.
		expect(prim.summary.waterBalance!.total.groundwaterM3).toBe(13_500);
		expect(Math.abs(prim.summary.waterBalance!.total.residualM3)).toBeLessThan(1e-6);
	});

	it('a dam-target borehole pumps nothing on a day with no demand, so it never fills the dam ahead of rain that then spills', () => {
		// A winter-rainfall case: a 30 000 m³ dam, empty, no demand at all; 92 dry
		// days, then 10 days of 5000 m³/day inflow. A 200 m³/day borehole into the dam.
		const days = 102;
		const natural = [...new Array(92).fill(0), ...new Array(10).fill(5000)];
		const dam = { damCapacityM3: 30_000, damInitialPct: 0 };
		const none = run(input(dam, 0, days), natural);
		const spilled = sum(col(none, 'A', 'spill'));
		expect(spilled).toBe(20_000);
		for (const mode of ['primary', 'emergency', 'supplemental'] as const) {
			const o = run(withBores(input(dam, 0, days), [bh({ capacityM3Day: 200, target: 'dam', mode })]), natural);
			ok(o);
			expect(sum(col(o, 'A', 'demand')), mode).toBe(0);
			// Until engine 1.8.0 a primary one pumped 94 × 200 = 18 800 m³ into the dam
			// (the dry spell and the first wet days) and an emergency one 9000 m³ (up
			// to its 30 % level), and all of it spilled again once the rain came:
			// 38 800 and 29 000 m³ of spill instead of 20 000.
			expect(sum(col(o, 'A', 'groundwater_to_dam')), mode).toBe(0);
			expect(sum(col(o, 'A', 'spill')), mode).toBe(spilled);
			expect(o.summary.groundwaterAnnualUse![0]!.abstractionM3, mode).toBe(0);
		}
		// Positive control: with demand drawn from the dam, primary and emergency still top it up at full capacity.
		for (const mode of ['primary', 'emergency'] as const) {
			const o = run(withBores(input(dam, 50, 3), [bh({ capacityM3Day: 200, target: 'dam', mode })]), [0, 0, 0]);
			ok(o);
			expect(col(o, 'A', 'groundwater_to_dam'), mode).toEqual([200, 200, 200]);
			expect(col(o, 'A', 'dam_storage'), mode).toEqual([150, 300, 450]);
		}
	});

	it('an ulp of demand left after off-take water does not switch on a primary or emergency dam-target borehole (engine 1.57.0)', () => {
		// Verify dense seed 86: off-take water arrived at 980.5862268744551 m³ against a demand of
		// 980.5862268744552 m³. The rest, 1.1e-13 m³, was judged against itself, so an emergency unit
		// filled its dam (1 590 m³). It is judged against the day's full demand now, as §2.7d says.
		const D = 980.5862268744552;
		const rest = D - 980.5862268744551;
		expect(rest).toBeGreaterThan(0);
		expect(damDrawnFor(rest, D)).toBe(false);
		expect(damDrawnFor(rest, rest)).toBe(true);
		for (const mode of [1, 2] as const) {
			const b: PlanBorehole = { units: [{ id: 'b', name: 'BH', capacityM3Day: 2000, annualCapM3: Infinity, mode, triggerM3: 1000, toDam: true, depletionFrac: 0 }], depletionAlpha: 1 };
			const pumped = [new Float64Array(1)];
			// A 3189 m³ dam holding 1599 m³ (below the emergency trigger), dead storage 0.
			const [Gs, gw, gd] = groundwaterDay(b, new Float64Array(1), pumped, 0, rest, 500, 1599, 0, 3189, 0, 1, Infinity, Infinity, D);
			expect(gd, `mode ${mode}`).toBe(0);
			expect(gw).toBe(0);
			expect(Gs).toBe(rest);
			// Positive control: a real rest (1 m³ of the 980) still tops the dam up.
			const real = groundwaterDay(b, new Float64Array(1), [new Float64Array(1)], 0, 1, 500, 1599, 0, 3189, 0, 1, Infinity, Infinity, D);
			expect(real[2], `mode ${mode}`).toBe(1590);
		}
	});

	it('a supplemental dam-target borehole first lifts a dam below its dead storage to it', () => {
		// Dead storage 20 % of 10 000; the dam starts at 10 %: 1000 below it. Demand 500.
		const o = run(withBores(input({ damCapacityM3: 10_000, damInitialPct: 0.1, damMinPct: 0.2 }, 500, 2), [bh({ capacityM3Day: 5000, target: 'dam' })]), [0, 0]);
		ok(o);
		expect(col(o, 'A', 'groundwater_to_dam')).toEqual([1500, 500]);
		expect(col(o, 'A', 'supplied')).toEqual([500, 500]);
	});

	it('an emergency borehole runs only while the dam is below its level', () => {
		const a = { damCapacityM3: 10_000, damInitialPct: 1 };
		const o = run(withBores(input(a, 3000, 5), [bh({ capacityM3Day: 2500, mode: 'emergency', emergencyBelowPct: 0.5 })]), [0, 0, 0, 0, 0]);
		ok(o);
		expect(col(o, 'A', 'groundwater_used')).toEqual([0, 0, 0, 2000, 2500]);
	});

	it('acceptance: a supplemental borehole raises reliability on a deficit farm and lowers the downstream flow by its depletion', () => {
		// The farm's runoff all passes below it (nothing into a dam, no diversion): it has only its boreholes.
		const farm = { pctRunoffToDam: 0 };
		const natural = [5000, 5000, 5000];
		const without = run(input(farm, 2000, 3), natural);
		const withB = run(withBores(input(farm, 2000, 3), [bh({ capacityM3Day: 1000, depletionFactor: 0.5 })]), natural);
		ok(withB);
		expect(without.summary.farms[0]!.fractionSupplied).toBe(0);
		expect(withB.summary.farms[0]!.fractionSupplied).toBe(0.5);
		expect(col(withB, null, 'simulated_outflow')).toEqual(col(without, null, 'simulated_outflow').map((v) => v - 500));
		expect(withB.summary.groundwaterAnnualUse![0]).toMatchObject({ abstractionM3: 3000, streamDepletionM3: 1500, annualCapM3: null });
	});

	it('warns about boreholes that cannot run as entered', () => {
		const i = withBores(input({}, 1000, 2), [
			bh({ id: 'a', name: 'ToDam', target: 'dam' }),
			bh({ id: 'b', name: 'Emerg', mode: 'emergency' }),
			bh({ id: 'c', name: 'OnGauge', nodeId: 'G' }),
			bh({ id: 'd', name: 'Nowhere', nodeId: 'X' })
		]);
		const o = run(i, [0, 0]);
		ok(o);
		const w = o.summary.warnings.join('\n');
		expect(w).toMatch(/borehole "ToDam" pumps into a dam but there is none/);
		expect(w).toMatch(/borehole "Emerg" runs in emergency mode but there is no dam/);
		expect(w).toMatch(/gauge "G": a gauge only measures; its 1 borehole is skipped/);
		expect(w).toMatch(/borehole "Nowhere" refers to a hydrological unit that does not exist/);
		// Both remaining boreholes pump straight to the crop.
		expect(col(o, 'A', 'groundwater_used')).toEqual([1000, 1000]);
	});
});

describe('GN 538 context (engine 1.12.0, issue #46 item 7)', () => {
	it('the property volume is area × Table 2 rate, capped at 40 000 m³/a; without both, the ceiling', () => {
		expect(GA538_GROUNDWATER_RATES).toEqual([0, 45, 75, 150, 275, 400]);
		expect(GA538_GROUNDWATER_LIMIT_M3_YEAR).toBe(40_000);
		expect(ga538VolumeM3({ gaPropertyAreaHa: 60, gaRateM3HaYear: 45 })).toEqual({ limitM3: 2700, basis: 'property' });
		// A zero-rate quaternary: no groundwater under the GA at all.
		expect(ga538VolumeM3({ gaPropertyAreaHa: 500, gaRateM3HaYear: 0 })).toEqual({ limitM3: 0, basis: 'property' });
		// A large property meets the 40 000 m³/a cap.
		expect(ga538VolumeM3({ gaPropertyAreaHa: 250, gaRateM3HaYear: 400 })).toEqual({ limitM3: 40_000, basis: 'property' });
		// Unknown or invalid: the ceiling only.
		for (const n of [{}, { gaPropertyAreaHa: 60 }, { gaRateM3HaYear: 75 }, { gaPropertyAreaHa: 60, gaRateM3HaYear: 100 }, { gaPropertyAreaHa: -1, gaRateM3HaYear: 75 }, { gaPropertyAreaHa: Number.NaN, gaRateM3HaYear: 75 }, { gaPropertyAreaHa: null, gaRateM3HaYear: null }])
			expect(ga538VolumeM3(n)).toEqual({ limitM3: 40_000, basis: 'ceiling' });
	});

	it('twelve consecutive months end on the day before the same date next year, 29 February included', () => {
		const start = (iso: string) => fromEpochDay(twelveMonthsStart(toEpochDay(iso)));
		expect(start('2022-03-31')).toBe('2021-04-01');
		expect(start('2021-09-30')).toBe('2020-10-01');
		expect(start('2024-02-29')).toBe('2023-03-01');
		expect(start('2024-03-01')).toBe('2023-03-02');
		expect(start('2025-02-28')).toBe('2024-02-29');
		expect(start('2021-01-01')).toBe('2020-01-02');
	});

	it('reports the most pumped in any 12 months ending in each water year, which a water-year total can hide', () => {
		// Two water years from 1 Oct 2020; 100 m³/day pumped from 1 Apr 2021 to 31 Mar 2022, straddling 1 October.
		const t0 = toEpochDay('2020-10-01');
		const days = 730;
		const pumped = Float64Array.from({ length: days }, (_, t) => (t0 + t >= toEpochDay('2021-04-01') && t0 + t <= toEpochDay('2022-03-31') ? 100 : 0));
		const zero = new Float64Array(days);
		const unit = { id: 'b', name: 'BH', capacityM3Day: 100, annualCapM3: Infinity, mode: 1 as const, triggerM3: 0, toDam: false, depletionFrac: 0 };
		const plan = { days, nodes: [{ borehole: { units: [unit], depletionAlpha: 1 } satisfies PlanBorehole }] };
		const sim = { nodes: [{ groundwater: pumped, groundwaterToDam: zero, depletion: zero, boreholePumped: [pumped] }] };
		const a = node('A', 'farm', null, { gaPropertyAreaHa: 50, gaRateM3HaYear: 400 });
		const rows = groundwaterAnnualUse([a], plan, sim, t0);
		expect(rows.map((r) => [r.label, r.abstractionM3, r.rolling12MaxM3, r.gaLimitM3, r.gaBasis])).toEqual([
			['2020/21', 18_300, 18_300, 20_000, 'property'],
			['2021/22', 18_200, 36_500, 20_000, 'property']
		]);
		// Neither water year passes the property's 20 000 m³/a; the 12 months to 31 March 2022 do.
		// A run that starts mid-year has no full 12 months in its first year.
		const late = groundwaterAnnualUse([node('A', 'farm', null)], { ...plan, days: 400 }, { nodes: [{ ...sim.nodes[0]!, groundwater: pumped.slice(1), groundwaterToDam: zero.slice(1) }] }, t0 + 1);
		expect(late[0]).toMatchObject({ rolling12MaxM3: null, gaLimitM3: 40_000, gaBasis: 'ceiling' });
	});

	it('warns when the property volume is unknown, and on a depletion share that suggests an alluvial aquifer', () => {
		const unit = (name: string, depletionFrac: number) => ({ id: name, name, capacityM3Day: 1, annualCapM3: Infinity, mode: 0 as const, triggerM3: 0, toDam: false, depletionFrac });
		const nodes = [node('A', 'farm', null), node('B', 'farm', null, { gaPropertyAreaHa: 10, gaRateM3HaYear: 75 }), node('C', 'farm', null)];
		const plan = { nodes: [{ borehole: { units: [unit('BH-A', 0.2)], depletionAlpha: 1 } }, { borehole: { units: [unit('BH-B', GA538_ALLUVIAL_DEPLETION_FRAC)], depletionAlpha: 1 } }, {}] };
		const [unknown, alluvial, ...rest] = ga538Warnings(nodes, plan);
		expect(rest).toEqual([]);
		// C pumps nothing, so it isn't named.
		expect(unknown).toBe("GN 538 volume unknown for A: no property area or Table 2 rate (or one not in the table), so the groundwater tables show the 40\u202f000 m³/a ceiling only, not the property's own volume (area × rate)");
		expect(alluvial).toMatch(/^boreholes with a stream depletion share of 80 % or more \(B: BH-B\): if they draw on an alluvial aquifer connected to the stream, GN 538 counts that as surface water/);
		expect(ga538Warnings([nodes[1]!], { nodes: [{ borehole: { units: [unit('BH-B', 0.5)], depletionAlpha: 1 } }] })).toEqual([]);
	});

	it('a run carries the property volume and warns through runModel', () => {
		const i = input({ boreholeCapacityM3Day: 800, boreholeRule: 'primary', gaPropertyAreaHa: 60, gaRateM3HaYear: 45 }, 2000, 3);
		const o = run(i, [0, 0, 0]);
		expect(o.summary.verification!.passed, JSON.stringify(o.summary.verification)).toBe(true);
		expect(o.summary.groundwaterAnnualUse![0]).toMatchObject({ gaLimitM3: 2700, gaBasis: 'property' });
		expect(o.summary.warnings.some((w) => w.startsWith('GN 538 volume unknown'))).toBe(false);
		const bare = run(input({ boreholeCapacityM3Day: 800, boreholeRule: 'primary' }, 2000, 3), [0, 0, 0]);
		expect(bare.summary.groundwaterAnnualUse![0]).toMatchObject({ gaLimitM3: 40_000, gaBasis: 'ceiling' });
		expect(bare.summary.warnings).toContain(
			"GN 538 volume unknown for A: no property area or Table 2 rate (or one not in the table), so the groundwater tables show the 40\u202f000 m³/a ceiling only, not the property's own volume (area × rate)"
		);
	});
});
