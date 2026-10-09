// The engine's physical invariants (packages/engine/src/testing/invariants.ts)
// on the three invented example catchments that `pnpm seed:examples` loads:
// branching networks, an intermediate gauge, dams that spill and run dry,
// transfers, 15 years of daily data. These are the models people demo with,
// so they must balance as exactly as the random fuzz networks do. Built
// without the stored fit (several seconds; it only changes GR4J's
// parameters): examples.test.ts covers the examples as seeded.
import { defaultProjectSettings, fromEpochDay, runModel, SUPPLY_DEFAULTS, toEpochDay, transferRatesM3s, withMonthlyRates, type DailySeries, type DemandObject, type ModelInput } from '@water-management/engine';
import { checkAll, sameOutput } from '@water-management/engine/testing';
import { describe, expect, it } from 'vitest';
import { buildExamples, inputOf } from '../../scripts/examples/catchments.js';

const examples = buildExamples({ fit: false });

/**
 * Synthetic unit rain records for an example: every third land unit its own gauge (the catchment rain × 1.2
 * with a gap), every third its own CHIRPS (the catchment rain × 0.7), the rest none.
 */
function unitRecords(input: ModelInput): Record<string, DailySeries> {
	const rain = input.series.rain_catchment_mm ?? input.series.rain_chirps_mm!;
	const out: Record<string, DailySeries> = {};
	input.model.nodes.forEach((n, i) => {
		if (n.kind !== 'farm' || !(n.areaKm2 > 0)) return;
		const scaled = (k: number) => rain.values.map((v, t) => (t === 30 ? null : typeof v === 'number' ? v * k : null));
		if (i % 3 === 0) out[`rain_catchment_mm@${n.id}`] = { startDate: rain.startDate, values: scaled(1.2) };
		else if (i % 3 === 1) out[`rain_chirps_mm@${n.id}`] = { startDate: rain.startDate, values: scaled(0.7) };
	});
	return out;
}

describe('engine invariants on the example catchments', () => {
	it('builds all three', () => {
		expect(examples.map((e) => e.name)).toHaveLength(3);
	});

	for (const ex of examples) {
		it(`${ex.name}: every invariant (balance, limits, report totals, order invariance, crop-area property, the runoff water balance)`, () => {
			const input = inputOf(ex);
			// Guard against a vacuous pass: the example must actually irrigate.
			expect(input.model.cropAreas.length).toBeGreaterThan(0);
			expect(runModel(input).summary.runoff?.model).toBe('gr4j');
			for (const seed of [1, 2]) expect(checkAll(input, seed)).toBeNull();
		}, 60_000);
	}
	// Supply rules (engine 0.42.0, WP-3.8) are off by default: an example with
	// no supply fields and one with the dam-only defaults written out (and an
	// inert pump capacity on every farm) give the same output to the bit.
	it('the supply fields at their defaults change nothing (WP-3.8)', () => {
		const ex = examples[1]!;
		const bare = inputOf(ex);
		for (const n of bare.model.nodes) {
			delete n.supplyRule;
			delete n.pumpCapacityM3Day;
			delete n.supplyTriggerPct;
			delete n.supplyStopPct;
		}
		const explicit = structuredClone(bare);
		for (const n of explicit.model.nodes) Object.assign(n, SUPPLY_DEFAULTS, n.kind === 'farm' ? { pumpCapacityM3Day: 500 } : {});
		const out = runModel(bare);
		expect(sameOutput(out, runModel(explicit))).toBe(true);
		expect(out.series.some((s) => s.key === 'river_abstraction')).toBe(false);
	}, 60_000);

	// Monthly transfer rates (engine 1.14.0): every example's rules rewritten as
	// their one rate in each of their months give the same output to the bit.
	it('transfer rules written as monthly rates change nothing (engine 1.14.0)', () => {
		for (const ex of examples) {
			const bare = inputOf(ex);
			if (!bare.model.transfers.length) continue;
			const monthly = structuredClone(bare);
			for (const t of monthly.model.transfers) Object.assign(t, withMonthlyRates(transferRatesM3s(t)));
			expect(monthly.model.transfers.every((t) => t.monthlyRateM3s?.length === 12)).toBe(true);
			expect(sameOutput(runModel(bare), runModel(monthly)), ex.name).toBe(true);
		}
	}, 60_000);

	// Demand objects (engine 1.7.0, issue #54 item 2b) are off unless added: an
	// empty list and only disabled objects give the examples' output to the bit,
	// and a town, a village and stock on their units keep every invariant.
	it('demand objects: none changes nothing, and some keep every invariant (engine 1.7.0)', () => {
		const ex = examples[0]!;
		const bare = inputOf(ex);
		const out = runModel(bare);
		const units = bare.model.nodes.filter((n) => n.kind === 'farm');
		const town = (nodeId: string, over: Partial<DemandObject> = {}): DemandObject => ({
			id: crypto.randomUUID(),
			nodeId,
			name: 'Town',
			category: 'municipal',
			sizing: 'monthly',
			monthlyM3Day: [300, 320, 400, 420, 400, 320, 300, 280, 260, 260, 270, 280],
			count: null,
			litresPerUnitDay: null,
			lossPct: 0,
			monthlyFactor: null,
			returnPct: 0.5,
			priority: 'first',
			destination: 'internal',
			enabled: true,
			note: '',
			...over
		});
		for (const demandObjects of [[], [town(units[0]!.id, { enabled: false })]]) expect(sameOutput(out, runModel({ ...bare, model: { ...bare.model, demandObjects } }))).toBe(true);
		const withObjects = structuredClone(bare);
		withObjects.model.demandObjects = [
			town(units[0]!.id),
			town(units[1]!.id, { name: 'Village', category: 'domestic', sizing: 'perUnit', monthlyM3Day: null, count: 800, litresPerUnitDay: 90, lossPct: 0.2, priority: 'shared', returnPct: 0.3 }),
			town(units.at(-1)!.id, { name: 'Stock', category: 'livestock', sizing: 'perUnit', monthlyM3Day: null, count: 400, litresPerUnitDay: 45, priority: 'last', returnPct: 0 })
		];
		const run = runModel(withObjects);
		expect(run.summary.farms.filter((f) => f.demandObjects?.length)).toHaveLength(3);
		for (const seed of [1, 2]) expect(checkAll(withObjects, seed)).toBeNull();
	}, 120_000);

	// The default run window follows the rain (engine 0.45.0, issue #54): the
	// examples' rain fills their record, so the default window is the one the
	// series span gives, and writing it out changes nothing, bit for bit.
	for (const ex of examples) {
		it(`${ex.name}: the default window is the whole record, the same run as that window written out`, () => {
			const base = inputOf(ex);
			base.settings = { ...base.settings, simulationStart: null, simulationEnd: null };
			const auto = runModel(base);
			// The rule before 0.45.0: the span of every rain series (Sandspruit's forecast runs past the record).
			const spans = (['rain_catchment_mm', 'rain_chirps_mm', 'rain_forecast_mm'] as const).flatMap((k) => {
				const s = base.series[k];
				return s ? [[toEpochDay(s.startDate), toEpochDay(s.startDate) + s.values.length - 1]] : [];
			});
			expect(auto.startDate).toBe(fromEpochDay(Math.min(...spans.map((s) => s[0]!))));
			expect(auto.endDate).toBe(fromEpochDay(Math.max(...spans.map((s) => s[1]!))));
			expect(auto.summary.warnings.filter((w) => w.startsWith('the run covers the rain record'))).toEqual([]);
			const pinned = structuredClone(base);
			pinned.settings = { ...pinned.settings, simulationStart: auto.startDate, simulationEnd: auto.endDate };
			expect(sameOutput(auto, runModel(pinned))).toBe(true);
		}, 60_000);
	}

	// Crop demand options (engine 0.43.0, issue #54): unset, they change nothing,
	// bit for bit; set, every invariant still holds on a real-sized network.
	it(`${examples[0]!.name}: absent crop efficiencies and monthly effective rain give the identical run`, () => {
		const base = inputOf(examples[0]!);
		const before = runModel(base);
		const unset = structuredClone(base);
		unset.model.crops = unset.model.crops.map((c) => ({ ...c, irrigationEfficiency: null }));
		unset.settings = { ...unset.settings, effectiveRainFractionMonthly: null };
		expect(runModel(unset)).toEqual(before);
		// The annual fraction written out for every month is the same run too.
		const repeated = structuredClone(base);
		const annual = repeated.settings.effectiveRainFraction ?? defaultProjectSettings().effectiveRainFraction;
		repeated.settings = { ...repeated.settings, effectiveRainFractionMonthly: new Array(12).fill(annual) as never };
		expect(runModel(repeated).series).toEqual(before.series);
	}, 60_000);

	it(`${examples[0]!.name}: every invariant holds with per-crop efficiencies and a monthly effective-rain fraction`, () => {
		const input = inputOf(examples[0]!);
		input.model.crops = input.model.crops.map((c, i) => ({ ...c, irrigationEfficiency: [0.9, 0.75, 0.85][i % 3] }));
		input.settings = { ...input.settings, effectiveRainFractionMonthly: [0.5, 0.6, 0.7, 0.7, 0.7, 0.6, 0.5, 0.4, 0.3, 0.3, 0.4, 0.45] as never };
		expect(checkAll(input, 1)).toBeNull();
	}, 60_000);

	// Runoff from each unit's own rain (engine ≥ 1.78.0, docs/model.md §2.4h, issue #482): off, it changes nothing
	// to the bit (absent, null, catchment mode, unit records in the input or not); on, every invariant holds.
	it('per-unit rain off gives the identical run on every example', () => {
		for (const ex of examples) {
			const base = inputOf(ex);
			const before = JSON.stringify(runModel(base));
			for (const unitRain of [null, { mode: 'catchment' as const }]) {
				const off = structuredClone(base);
				off.settings = { ...off.settings, unitRain };
				Object.assign(off.series, unitRecords(off));
				for (const n of off.model.nodes) if (n.kind === 'farm') Object.assign(n, { mapMm: 600, mapSource: 'invented' });
				expect(JSON.stringify(runModel(off)), `${ex.name} ${JSON.stringify(unitRain)}`).toBe(before);
			}
		}
	}, 120_000);

	it('every invariant holds with per-unit rain on every example', () => {
		for (const ex of examples) {
			const input = inputOf(ex);
			input.settings = { ...input.settings, unitRain: { mode: 'perUnit', gaugeMapMm: 600, gaugeMapSource: 'invented gauge MAP' } };
			Object.assign(input.series, unitRecords(input));
			input.model.nodes.forEach((n, i) => {
				if (n.kind === 'farm' && i % 3 !== 0) Object.assign(n, { mapMm: 500 + 40 * i, mapSource: 'invented' });
			});
			const out = runModel(input);
			expect(out.summary.unitRain?.units.length, ex.name).toBeGreaterThan(1);
			expect(new Set(out.summary.unitRain!.units.map((u) => u.rule)).size, ex.name).toBeGreaterThan(1);
			expect(checkAll(input, 1), ex.name).toBeNull();
		}
	}, 180_000);

	// The GR4J-run timing budget lives in examples.perf.test.ts, its own vitest
	// project (run serially via `pnpm test:perf`, not part of `pnpm test`) —
	// see docs/followups.md "Wall-clock test flakes under load" (2026-09-24).
});
