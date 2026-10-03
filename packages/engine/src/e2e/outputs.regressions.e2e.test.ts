// Regression tests for the derived-output bug the engine end-to-end tests found
// (fixed in engine 1.69.0; erratum ER-13), asserting the behaviour docs/model.md specifies.
// Synthetic catchment only.
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import type { DemandObject, ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { testCatchment } from '../outlook/testCatchment';
import { randomInput } from '../testing';

const series = (o: ModelOutput, id: string, key: string) => o.series.find((s) => s.nodeId === id && s.key === key)?.values ?? null;
/** Every river-side take of a unit, per day: the §2.7e river pump, river off-take water used (§2.6a) and its own river abstractions (§2.7j). */
function riverSide(o: ModelOutput, id: string): number[] {
	const parts = o.series.filter((s) => s.nodeId === id && (s.key === 'river_abstraction' || s.key === 'offtake_used' || s.key.startsWith('river_take@'))).map((s) => s.values);
	return Array.from({ length: o.days }, (_, t) => parts.reduce((a, v) => a + v[t]!, 0));
}

/**
 * §2.12 surface use per water year, by the doc's words: Σ (supplied − groundwater_used) − MIN(Σ groundwater_to_dam, Σ dam
 * draw), the dam draw being what the unit drew from its OWN DAM ("the dam draw Gs is supplied less groundwater to the crop
 * and the river pump"; "Never below the river pump … the river pump's take always stays surface use"). Water a unit takes
 * from the river by another route (an off-take, §2.6a; its own river abstraction, §2.7j) is not drawn from the dam either.
 */
function handSurface(o: ModelOutput, id: string): Map<number, { surface: number; river: number }> {
	const sup = series(o, id, 'supplied')!;
	const gw = series(o, id, 'groundwater_used');
	const toDam = series(o, id, 'groundwater_to_dam');
	const river = riverSide(o, id);
	const d0 = toEpochDay(o.startDate);
	const y = new Map<number, { gross: number; toDam: number; draw: number; river: number }>();
	for (let t = 0; t < o.days; t++) {
		const wy = waterYearOf(d0 + t);
		const r = y.get(wy) ?? { gross: 0, toDam: 0, draw: 0, river: 0 };
		const surface = sup[t]! - (gw?.[t] ?? 0);
		r.gross += surface;
		r.toDam += toDam?.[t] ?? 0;
		r.draw += Math.max(surface - river[t]!, 0);
		r.river += river[t]!;
		y.set(wy, r);
	}
	return new Map([...y].map(([wy, r]) => [wy, { surface: r.gross - Math.min(r.toDam, r.draw), river: r.river }]));
}

describe('fixed in 1.69.0: §2.12 surface use nets groundwater pumped into the dam against river water that never came from the dam', () => {
	// Farm A: no crops; a small livestock demand on its dam (so its primary dam-target borehole runs, §2.7d) and a town
	// that takes 300 m³/day straight from the river through its own abstraction (§2.7j, waterSource 'river').
	const BASE = testCatchment({ start: '2003-10-01', end: '2006-09-30', seed: 5 });
	const town: DemandObject = {
		id: 'town',
		nodeId: 'a',
		name: 'Town',
		category: 'municipal',
		sizing: 'monthly',
		monthlyM3Day: new Array(12).fill(300),
		count: null,
		litresPerUnitDay: null,
		lossPct: 0,
		monthlyFactor: null,
		returnPct: 0,
		priority: 'first',
		destination: 'external',
		enabled: true,
		waterSource: 'river',
		riverPumpM3Day: null,
		riverPoolM3: null
	} as DemandObject;
	const input: ModelInput = {
		...BASE,
		model: {
			...BASE.model,
			cropAreas: BASE.model.cropAreas.filter((c) => c.nodeId !== 'a'),
			demandObjects: [town, { ...town, id: 'stock', name: 'Stock', category: 'livestock', monthlyM3Day: new Array(12).fill(5), waterSource: null } as DemandObject],
			boreholes: [{ id: 'bh', nodeId: 'a', name: 'Bore', capacityM3Day: 5000, annualCapM3: null, mode: 'primary', emergencyBelowPct: 0, target: 'dam', depletionFactor: 0 }],
			allocations: [{ id: 'surface-a', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 99_000 }]
		}
	};
	const out = runModel(input);

	it('2003/04: the town took 109 800 m³ from the river, so surface use is at least that: over a 99 000 m³ registration in all three years', () => {
		const hand = handSurface(out, 'a');
		expect(hand.get(2003)!.river).toBeCloseTo(109_800, 3);
		for (const [, h] of hand) expect(h.surface).toBeGreaterThanOrEqual(h.river - 1e-6);
		// By hand every year is over (> 108 900 m³); the engine nets 13 170 m³ of pumped water against the town's river
		// water in 2003/04 and reads 96 630 m³ there, "within", so it reports 2 years over.
		expect([...hand.values()].filter((h) => h.surface > 99_000 * 1.1)).toHaveLength(3);
		const src = out.summary.allocations!.nodes[0]!.sources.find((x) => x.waterSource === 'surface')!;
		expect(src.yearsOver).toBe(3);
	});

	it('RunSummary.allocations reads the same: the mean surface use per whole year is the hand rule’s', () => {
		const hand = handSurface(out, 'a');
		const mean = [...hand.values()].reduce((s, y) => s + y.surface, 0) / hand.size;
		const src = out.summary.allocations!.nodes[0]!.sources.find((s) => s.waterSource === 'surface')!;
		expect(src.meanModelledM3PerYear!).toBeCloseTo(mean, 3);
		expect(src.yearsOver).toBe([...hand.values()].filter((y) => y.surface > 99_000 * 1.1).length);
	});

	it('random networks with off-takes and river abstractions: each unit’s mean surface use per whole year is the hand rule’s', () => {
		// Seeds found by search (randomInput, maxNodes 8, maxDays 600): 41 (off-take water used), 1708, 1930, 2614 (§2.7j river takes).
		const problems: string[] = [];
		for (const seed of [41, 1708, 1930, 2614]) {
			const x0 = randomInput(seed, { maxNodes: 8, maxDays: 600 });
			const farms = x0.model.nodes.filter((n) => n.kind === 'farm');
			// A surface allocation on every farm in mode none, so RunSummary.allocations reports each one (the run is unchanged).
			const x: ModelInput = { ...x0, settings: { ...x0.settings, allocationMode: 'none' }, model: { ...x0.model, allocations: farms.map((n) => ({ id: `al-${n.id}`, nodeId: n.id, waterSource: 'surface' as const, volumeM3PerYear: 1 })) } };
			const o = runModel(x);
			const d0 = toEpochDay(o.startDate);
			for (const n of farms) {
				if (!series(o, n.id, 'groundwater_to_dam')) continue;
				const whole = [...handSurface(o, n.id)].filter(([wy]) => {
					const len = toEpochDay(`${wy + 1}-10-01`) - toEpochDay(`${wy}-10-01`);
					return toEpochDay(`${wy}-10-01`) >= d0 && toEpochDay(`${wy + 1}-10-01`) - 1 <= d0 + o.days - 1 && len > 0;
				});
				if (!whole.length) continue;
				const mean = whole.reduce((s, [, h]) => s + h.surface, 0) / whole.length;
				const src = o.summary.allocations!.nodes.find((r) => r.nodeId === n.id)!.sources.find((r) => r.waterSource === 'surface')!;
				if (Math.abs(src.meanModelledM3PerYear! - mean) > 1e-6 * Math.max(1, mean)) problems.push(`seed ${seed} ${n.id}: engine ${src.meanModelledM3PerYear!.toFixed(1)}, hand ${mean.toFixed(1)}`);
			}
		}
		expect(problems).toEqual([]);
	});
});
