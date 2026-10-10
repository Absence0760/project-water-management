// A dam beside the river is compared at the river intake (engine ≥ 1.82.0,
// docs/model.md §2.12, issue #513): the farm's surface take is River to dam +
// top-up off-takes + river water used directly, less the same day's spill of
// diverted water (at most that day's diversion). Draws from the dam are
// reported, not counted. A dam on the river keeps the draws rule. The water
// balance doesn't move: the take is the comparison's input only. Synthetic
// catchment (outlook/testCatchment.ts): Farm A's dam is beside the river,
// Farm B's on it.
import { describe, expect, it } from 'vitest';
import { runModel } from '../run';
import type { ModelInput, ModelOutput, Transfer } from '../project';
import { testCatchment } from '../outlook/testCatchment';
import { compareAllocations, type AllocationUseNode } from './compare';
import { INTAKE_SERIES } from './intake';
import { toEpochDay, waterYearOf } from '../calendar';

const series = (o: ModelOutput, id: string, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)?.values ?? null;
const zeros = (o: ModelOutput) => new Array<number>(o.days).fill(0);
const TAKE = INTAKE_SERIES.take.key;
const RECEIVED = INTAKE_SERIES.received.key;

type Over = Partial<ModelInput['model']['nodes'][number]>;
/** Farm A beside the river: none of the upstream inflow reaches its dam, River to dam fills it; a small dam, so it spills. */
function beside(a: Over = {}, b: Over = {}): ModelInput {
	const input = testCatchment({ start: '2003-10-01', end: '2007-09-30', seed: 11 });
	input.model.nodes = input.model.nodes.map((n) =>
		n.id === 'a' ? { ...n, pctUpstreamToDam: 0, pctRunoffToDam: 0.3, divertCapacityM3Day: 6_000, damCapacityM3: 60_000, damAreaFullM2: 20_000, ...a } : n.id === 'b' ? { ...n, ...b } : n
	);
	return input;
}

const damRule = (over: Partial<Transfer>): Transfer => ({
	id: 'r1',
	fromNodeId: 'a',
	toNodeId: 'b',
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: 0.02,
	dailyCapM3: null,
	minStoragePct: 0.2,
	enabled: true,
	priority: 1,
	...over
});

/** The comparison's input, read from a run's series the way the backend reads a stored run. */
function useNode(o: ModelOutput, id: string): AllocationUseNode {
	return {
		nodeId: id,
		name: id,
		kind: 'farm',
		supplied: series(o, id, 'supplied')!,
		groundwater: series(o, id, 'groundwater_used'),
		groundwaterToDam: series(o, id, 'groundwater_to_dam'),
		riverAbstraction: series(o, id, 'river_abstraction'),
		riverTakes: o.series.filter((s) => s.nodeId === id && (s.key === 'offtake_used' || s.key.startsWith('river_take@'))).map((s) => s.values),
		intakeTake: series(o, id, TAKE),
		receivedAtIntake: series(o, id, RECEIVED)
	};
}

/** Σ per water year of a daily series. */
function byYear(o: ModelOutput, v: ArrayLike<number>): Map<number, number> {
	const d0 = toEpochDay(o.startDate);
	const m = new Map<number, number>();
	for (let t = 0; t < o.days; t++) m.set(waterYearOf(d0 + t), (m.get(waterYearOf(d0 + t)) ?? 0) + v[t]!);
	return m;
}

describe('the intake take (§2.12)', () => {
	const out = runModel(beside());
	const take = series(out, 'a', TAKE)!;

	it('only a dam beside the river that diverts into it carries the series', () => {
		expect(take).not.toBeNull();
		// Farm B's dam is on the river (all the upstream inflow goes into it).
		expect(series(out, 'b', TAKE)).toBeNull();
		// Nothing diverted into it: no River to dam, no top-up off-take.
		expect(series(runModel(beside({ divertCapacityM3Day: 0 })), 'a', TAKE)).toBeNull();
		// Any of the upstream inflow into the dam puts it on the river, River to dam or not: the draws rule.
		expect(series(runModel(beside({ pctUpstreamToDam: 0.5 })), 'a', TAKE)).toBeNull();
		// River to dam by month counts as diverting.
		const monthly = runModel(beside({ divertCapacityM3Day: 0, divertMonthlyM3Day: [0, 0, 0, 0, 3_000, 3_000, 3_000, 3_000, 0, 0, 0, 0] }));
		expect(series(monthly, 'a', TAKE)).not.toBeNull();
	});

	it('is River to dam + river water used directly − the same day’s spill, the spill netted at most the day’s diversion', () => {
		const O = series(out, 'a', 'diverted_to_dam')!;
		const R = series(out, 'a', 'spill')!;
		const ra = series(out, 'a', 'river_abstraction') ?? zeros(out);
		let spillDays = 0;
		let spillPastDiversion = 0;
		for (let t = 0; t < out.days; t++) {
			const want = O[t]! - Math.min(R[t]!, O[t]!) + ra[t]!;
			expect(take[t]!, `day ${t}`).toBeCloseTo(want, 9);
			// Never below the river water that met the demand directly, never above everything taken from the river.
			expect(take[t]!).toBeGreaterThanOrEqual(ra[t]! - 1e-9);
			expect(take[t]!).toBeLessThanOrEqual(O[t]! + ra[t]! + 1e-9);
			if (R[t]! > 0 && O[t]! > 0) spillDays++;
			if (R[t]! > O[t]! && O[t]! > 0) spillPastDiversion++;
		}
		// The small dam spills while it diverts, and some days spill more than was diverted (its own runoff too).
		expect(spillDays).toBeGreaterThan(5);
		expect(spillPastDiversion).toBeGreaterThan(0);
	});

	it('adds a top-up off-take’s water into the dam and the off-take water used directly', () => {
		const input = beside({ divertCapacityM3Day: 0 }, { pctUpstreamToDam: 0, pctRunoffToDam: 0.2 });
		input.model.transfers = [damRule({ id: 'x1', fromNodeId: 'a', toNodeId: 'b', source: 'river', sizing: 'capacity', topUpDam: true, maxRateM3s: 0.03 })];
		const o = runModel(input);
		const t2 = series(o, 'b', TAKE)!;
		expect(t2).not.toBeNull();
		const used = series(o, 'b', 'offtake_used')!;
		const toDam = series(o, 'b', 'offtake_to_dam')!;
		const R = series(o, 'b', 'spill')!;
		let topped = 0;
		for (let t = 0; t < o.days; t++) {
			const d = toDam[t]!;
			expect(t2[t]!, `day ${t}`).toBeCloseTo(d - Math.min(R[t]!, d) + used[t]!, 9);
			topped += d;
		}
		expect(topped).toBeGreaterThan(0);
	});

	it('the comparison counts the take as the surface use and reports the draws beside it, not added', () => {
		const at = { startDate: out.startDate, allocations: [{ id: 'l', nodeId: 'a', waterSource: 'surface' as const, volumeM3PerYear: 200_000 }] };
		const cmp = compareAllocations({ ...at, nodes: [useNode(out, 'a')] }).nodes[0]!.surface;
		expect(cmp.measuredAt).toBe('intake');
		const want = byYear(out, take);
		const sup = series(out, 'a', 'supplied')!;
		const ra = series(out, 'a', 'river_abstraction') ?? zeros(out);
		const draws = byYear(out, Array.from(sup, (v, t) => Math.max(v - ra[t]!, 0)));
		for (const y of cmp.years) {
			expect(y.modelledM3).toBeCloseTo(want.get(y.waterYear)!, 6);
			expect(y.damDrawM3).toBeCloseTo(draws.get(y.waterYear)!, 6);
		}
		// The farm drew on the dam, and the take isn't the draws.
		expect(cmp.years.some((y) => y.damDrawM3! > 0 && Math.abs(y.damDrawM3! - y.modelledM3) > 1)).toBe(true);
		// The groundwater side and a dam on the river are as before: no `measuredAt`, no draws reported.
		const b = compareAllocations({ ...at, nodes: [useNode(out, 'b')] }).nodes[0]!.surface;
		expect(b.measuredAt).toBeUndefined();
		expect(b.years.every((y) => y.damDrawM3 === undefined)).toBe(true);
		// The run's own summary says so too (the map's labels read it).
		const withVolumes = beside();
		withVolumes.model.allocations = [at.allocations[0]!, { id: 'lb', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: 200_000 }];
		const sum = runModel(withVolumes).summary.allocations!;
		expect(sum.nodes.find((n) => n.nodeId === 'a')!.sources[0]).toMatchObject({ waterSource: 'surface', measuredAt: 'intake' });
		expect(sum.nodes.find((n) => n.nodeId === 'b')!.sources[0]!.measuredAt).toBeUndefined();
	});

	it('an older run (no intake series; 1.79.0–1.81.0 stored diverted_loss) reads by the draws rule', () => {
		const node = useNode(out, 'a');
		const old = compareAllocations({ startDate: out.startDate, allocations: [], nodes: [{ ...node, intakeTake: null }] }).nodes[0]!.surface;
		expect(old.measuredAt).toBeUndefined();
		const sup = byYear(out, series(out, 'a', 'supplied')!);
		for (const y of old.years) expect(y.modelledM3).toBeCloseTo(sup.get(y.waterYear)!, 6);
	});

	it('water a dam beside the river gives another unit is counted at its intake, not again where it is drawn', () => {
		const input = beside();
		input.model.transfers = [damRule({})];
		const o = runModel(input);
		const moved = series(o, 'a', 'transfer_rule@r1')!;
		const got = series(o, 'b', RECEIVED)!;
		expect(got).not.toBeNull();
		for (let t = 0; t < o.days; t++) expect(got[t]).toBe(moved[t]);
		expect(moved.reduce((s, v) => s + v, 0)).toBeGreaterThan(0);
		// B (on the river) nets it against its dam draw, as groundwater pumped into the dam: at most the year's draws.
		const at = { startDate: o.startDate, allocations: [] };
		const withIt = compareAllocations({ ...at, nodes: [useNode(o, 'b')] }).nodes[0]!.surface;
		const without = compareAllocations({ ...at, nodes: [{ ...useNode(o, 'b'), receivedAtIntake: null }] }).nodes[0]!.surface;
		const gotY = byYear(o, got);
		for (const [k, y] of withIt.years.entries()) {
			const less = without.years[k]!.modelledM3 - y.modelledM3;
			expect(less).toBeGreaterThanOrEqual(-1e-9);
			expect(less).toBeLessThanOrEqual(gotY.get(y.waterYear)! + 1e-6);
		}
		expect(withIt.years.some((y, k) => without.years[k]!.modelledM3 - y.modelledM3 > 1)).toBe(true);
		// The other way, a dam on the river giving to one beside it: the receiver's take counts it (no one else does).
		const back = beside();
		back.model.transfers = [damRule({ fromNodeId: 'b', toNodeId: 'a' })];
		const ob = runModel(back);
		const movedBack = series(ob, 'b', 'transfer_rule@r1')!;
		const O = series(ob, 'a', 'diverted_to_dam')!;
		const R = series(ob, 'a', 'spill')!;
		const ra = series(ob, 'a', 'river_abstraction') ?? zeros(ob);
		const tb = series(ob, 'a', TAKE)!;
		for (let t = 0; t < ob.days; t++) expect(tb[t]!, `day ${t}`).toBeCloseTo(O[t]! - Math.min(R[t]!, O[t]!) + ra[t]! + movedBack[t]!, 9);
		expect(series(ob, 'b', RECEIVED)).toBeNull();
	});

	it('is the comparison’s input only: a cap scenario still limits the draws, never the intake take (§2.12a)', () => {
		const capped = beside();
		capped.settings.allocationMode = 'cap';
		capped.model.allocations = [{ id: 'l', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 5_000 }];
		const c = runModel(capped);
		const room = series(c, 'a', 'allocation_room_surface')!;
		const sup = series(c, 'a', 'supplied')!;
		const take = series(c, 'a', TAKE)!;
		const d0 = toEpochDay(c.startDate);
		let differs = 0;
		for (let t = 1; t < c.days; t++) {
			if (waterYearOf(d0 + t) !== waterYearOf(d0 + t - 1)) continue;
			// The room falls by the day before's surface supply (G − GW; no boreholes here), not by its intake take.
			expect(room[t - 1]! - room[t]!, `day ${t}`).toBeCloseTo(sup[t - 1]!, 6);
			if (Math.abs(take[t - 1]! - sup[t - 1]!) > 1) differs++;
		}
		expect(differs).toBeGreaterThan(0);
	});
});
