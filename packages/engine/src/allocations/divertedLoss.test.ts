// Diverted river water lost from a dam counts as surface use (engine ≥ 1.79.0,
// docs/model.md §2.12, §2.12a, issue #507). Farm A's dam sits beside the river
// (none of the upstream inflow or its own runoff reaches it) and fills only
// through River to dam, so all its water is diverted water; Farm B's dam is on
// the river and diverts nothing. Synthetic catchment (outlook/testCatchment.ts).
import { describe, expect, it } from 'vitest';
import { runModel } from '../run';
import type { ModelInput, ModelOutput } from '../project';
import { testCatchment } from '../outlook/testCatchment';
import { compareAllocations } from './compare';
import { toEpochDay, waterYearOf } from '../calendar';

const series = (o: ModelOutput, id: string, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)?.values ?? null;

function offChannel(over: Partial<ModelInput['model']['nodes'][number]> = {}): ModelInput {
	const input = testCatchment({ start: '2003-10-01', end: '2007-09-30', seed: 11 });
	input.model.nodes = input.model.nodes.map((n) =>
		n.id === 'a' ? { ...n, pctUpstreamToDam: 0, pctRunoffToDam: 0, divertCapacityM3Day: 4_000, damSeepagePerDay: 0.002, damSeepageReturnPct: 0.25, ...over } : n
	);
	return input;
}

describe('diverted_loss (§2.12)', () => {
	const input = offChannel();
	const out = runModel(input);
	const loss = series(out, 'a', 'diverted_loss')!;
	const evap = series(out, 'a', 'dam_evaporation')!;
	const lost = series(out, 'a', 'dam_seepage_lost')!;

	it('only a unit that can divert into a dam carries the series', () => {
		expect(loss).not.toBeNull();
		expect(series(out, 'b', 'diverted_loss')).toBeNull();
		// River to dam 0 and no top-up off-take: no series, even on an off-river dam.
		expect(series(runModel(offChannel({ divertCapacityM3Day: 0 })), 'a', 'diverted_loss')).toBeNull();
	});

	it('a dam that only diverted water fills starts all diverted; rain on it is not diverted water and dilutes it', () => {
		// Day 0: f = 1 on the starting storage, so the loss is that storage's share of what is there × (E + lost seepage).
		const q0 = 0.6 * 300_000;
		const pd = series(out, 'a', 'rain_on_dam')!;
		expect(loss[0]!).toBeCloseTo((q0 / (q0 + pd[0]!)) * (evap[0]! + lost[0]!), 6);
		let total = 0;
		let all = 0;
		for (let t = 0; t < out.days; t++) {
			expect(loss[t]!).toBeGreaterThanOrEqual(0);
			expect(loss[t]!).toBeLessThanOrEqual(evap[t]! + lost[t]! + 1e-9);
			total += loss[t]!;
			all += evap[t]! + lost[t]!;
		}
		// Diverted water is nearly all the dam holds (rain on its surface is the rest), and something is lost at all.
		expect(total).toBeGreaterThan(1_000);
		expect(total / all).toBeGreaterThan(0.8);
		expect(total / all).toBeLessThan(1);
	});

	it('a dam its own runoff also fills starts with no diverted water, and never loses more than evaporation and lost seepage', () => {
		const mixed = runModel(offChannel({ pctRunoffToDam: 0.8 }));
		const l = series(mixed, 'a', 'diverted_loss')!;
		const e = series(mixed, 'a', 'dam_evaporation')!;
		const s = series(mixed, 'a', 'dam_seepage_lost')!;
		expect(l[0]).toBe(0);
		let some = 0;
		let below = 0;
		for (let t = 0; t < mixed.days; t++) {
			expect(l[t]!).toBeGreaterThanOrEqual(0);
			expect(l[t]!).toBeLessThanOrEqual(e[t]! + s[t]! + 1e-9);
			if (l[t]! > 0) some++;
			if (l[t]! < (e[t]! + s[t]!) * 0.99) below++;
		}
		// Diverted water arrives and is lost, but only as its share of a dam the runoff fills too.
		expect(some).toBeGreaterThan(100);
		expect(below).toBeGreaterThan(100);
	});

	it('the comparison adds the loss to the surface side, beside the draws', () => {
		const at = { startDate: out.startDate, allocations: [{ id: 'al', nodeId: 'a', waterSource: 'surface' as const, volumeM3PerYear: 50_000 }], tolerance: 0.1 };
		const supplied = series(out, 'a', 'supplied')!;
		const without = compareAllocations({ ...at, nodes: [{ nodeId: 'a', name: 'Farm A', kind: 'farm', supplied }] });
		const withLoss = compareAllocations({ ...at, nodes: [{ nodeId: 'a', name: 'Farm A', kind: 'farm', supplied, divertedLoss: loss }] });
		const ys = withLoss.nodes[0]!.surface.years;
		expect(ys.length).toBe(4);
		const d0 = toEpochDay(out.startDate);
		for (const [k, y] of ys.entries()) {
			let l = 0;
			for (let t = 0; t < out.days; t++) if (waterYearOf(d0 + t) === y.waterYear) l += loss[t]!;
			expect(y.modelledM3 - without.nodes[0]!.surface.years[k]!.modelledM3).toBeCloseTo(l, 3);
		}
		// The run's own summary is the comparison with the loss in it.
		const run = runModel({ ...input, model: { ...input.model, allocations: at.allocations } });
		const src = run.summary.allocations!.nodes.find((n) => n.nodeId === 'a')!.sources[0]!;
		expect(src.meanModelledM3PerYear!).toBeCloseTo(withLoss.nodes[0]!.surface.meanModelledM3PerYear!, 3);
	});

	it('under a cap of 0 nothing is drawn, yet the losses count: the cap holds draws, not evaporation (§2.12a)', () => {
		const capped = runModel({
			...input,
			settings: { ...input.settings, allocationMode: 'cap' },
			model: { ...input.model, allocations: [{ id: 'al', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 0 }] }
		});
		const sup = series(capped, 'a', 'supplied')!;
		const l = series(capped, 'a', 'diverted_loss')!;
		const room = series(capped, 'a', 'allocation_room_surface')!;
		let total = 0;
		for (let t = 0; t < capped.days; t++) {
			expect(sup[t]).toBe(0);
			expect(room[t]).toBe(0);
			total += l[t]!;
		}
		expect(total).toBeGreaterThan(1_000);
		const src = capped.summary.allocations!.nodes.find((n) => n.nodeId === 'a')!.sources[0]!;
		expect(src.capReached!.map((r) => r.waterYear)).toEqual([2003, 2004, 2005, 2006]);
	});

	it('the loss takes from the year’s volume, never from the daily rate', () => {
		// A volume large enough never to bind, and a licence rate below a day’s loss on most days: the loss is the
		// same as uncapped, and the room the next day is the volume less everything counted so far.
		const vol = 10_000_000;
		const capped = runModel({
			...input,
			settings: { ...input.settings, allocationMode: 'cap' },
			model: { ...input.model, allocations: [{ id: 'al', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: vol, maxRateM3s: 1e-6 }] }
		});
		const l = series(capped, 'a', 'diverted_loss')!;
		const left = series(capped, 'a', 'allocation_left_surface')!;
		const sup = series(capped, 'a', 'supplied')!;
		// Day 0: nothing counted before it, so what is left is the volume less the day's loss.
		expect(left[0]!).toBeCloseTo(vol - l[0]!, 6);
		let used = l[0]! + sup[0]!;
		for (let t = 1; t < 365; t++) {
			used += l[t]!;
			expect(left[t]!).toBeCloseTo(vol - used, 3);
			used += sup[t]!;
		}
	});
});
