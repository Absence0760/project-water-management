// Wall-clock performance budgets for the client-catchment workbook regression
// fixture, split out of run.test.ts (docs/followups.md, "Wall-clock test
// flakes under load", 2026-09-24). Asserting a hard millisecond ceiling
// inside the default `pnpm test` run flakes under load — a busy laptop or
// three workspaces' suites running in parallel can push any single run over
// budget with no engine regression involved. This file is its own vitest
// project (`perf`, see vitest.config.ts): excluded from `pnpm test`, run
// serially via `pnpm test:engine:perf` / the root `pnpm test:engine:perf`,
// and takes the median of several runs so one slow sample doesn't decide it
// (the same technique backend/src/model/examples.perf.test.ts uses).
//
// Needs the gitignored `data/client-catchment` fixture (from
// scripts/wbt-import/extract_project.py); skips with a named placeholder
// test when absent, same as run.test.ts.
import { describe, expect, it } from 'vitest';
import { runModel, runModelWith } from './run';
import { prepareCalibration } from './calibrate/calibrate';
import { toEpochDay } from './calendar';
import type { ModelInput } from './project';
import { loadClientCatchmentFixture } from './testing/client-catchment-fixture';

const fixture = await loadClientCatchmentFixture();

/** Median of `n` timed runs after one untimed warm-up. */
function medianMs(n: number, run: () => void): number {
	run();
	const ms = Array.from({ length: n }, () => {
		const t0 = performance.now();
		run();
		return performance.now() - t0;
	}).sort((a, b) => a - b);
	return ms[Math.floor(n / 2)]!;
}

describe.skipIf(!fixture)('runModel performance: client catchment (needs data/client-catchment)', () => {
	if (!fixture) {
		it('needs data/client-catchment', () => {});
		return;
	}
	const { modelInput, natural } = fixture;
	// Measured medians (2026-09-30, issue #284), the client catchment (its full network and daily record), Node 24 on the
	// 20-thread dev laptop with nothing else running, three runs of this file: 136–159 ms for the replay and
	// 143–150 ms with the rain model. So a run is about 0.15 s, which is what the in-browser previews
	// (frontend/src/lib/preview) lean on: the unsaved-edits preview runs the model twice. The 1 s budgets
	// leave room for a slower machine and a busy one; a median creeping towards them is a regression.

	it('runs the full catchment record well under a second (median of 7)', () => {
		const ms = medianMs(7, () => {
			runModelWith(modelInput, () => ({ naturalFlowM3Day: natural }));
		});
		expect(ms).toBeLessThan(1000);
	});

	it('end to end with the rain model stays well under a second (median of 7)', () => {
		const withRainModel: typeof modelInput = { ...modelInput, settings: { ...modelInput.settings, chirpsBiasCorrection: 'none' } };
		const ms = medianMs(7, () => {
			runModel(withRainModel);
		});
		expect(ms).toBeLessThan(1000);
	});
});

/**
 * A synthetic 12-unit catchment (issue #482): a chain of 12 land units to a gauge, daily rain from 1981 to
 * 2025, each unit with its own CHIRPS and a MAP
 * under settings.unitRain `perUnit`. Invented values only.
 */
function twelveUnits(perUnit: boolean): ModelInput {
	const start = '1981-01-01';
	const days = toEpochDay('2025-03-31') - toEpochDay(start) + 1;
	const rain = (k: number, phase: number) => Array.from({ length: days }, (_, i) => ((i + phase) % 11 === 0 ? 25 * k : (i + phase) % 3 === 0 ? 1.5 * k : 0));
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0.5, pctRunoffToDam: 0.5, damCapacityM3: 200_000, damInitialPct: 0.5, damMinPct: 0, divertCapacityM3Day: 2000, irrigationEfficiency: 0.8, returnFlowFraction: 0.1, damAreaFullM2: 40_000, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const nodes = [{ ...node, id: 'g', name: 'Gauge', kind: 'gauge' as const, downstreamNodeId: null, areaKm2: 0, damCapacityM3: 0 }];
	const series: Record<string, { startDate: string; values: number[] }> = {
		rain_catchment_mm: { startDate: start, values: rain(1, 0) },
		flow_observed_m3s: { startDate: start, values: Array.from({ length: days }, (_, i) => 0.2 + Math.exp(-(i % 11) / 3)) }
	};
	for (let u = 0; u < 12; u++) {
		const id = `u${String(u).padStart(2, '0')}`;
		nodes.push({ ...node, id, name: `Unit ${u + 1}`, kind: 'farm' as never, downstreamNodeId: u === 0 ? 'g' : `u${String(u - 1).padStart(2, '0')}`, areaKm2: 7 + 2 * u, ...({ mapMm: 500 + 30 * u, mapSource: 'invented' } as object) } as never);
		series[`rain_chirps_mm@${id}`] = { startDate: start, values: rain(0.6 + 0.05 * u, u) };
	}
	return {
		settings: { runoffModel: 'gr4j', apanMm: [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100] as never, ...(perUnit ? { unitRain: { mode: 'perUnit' as const } } : {}) },
		model: {
			nodes: nodes as never,
			crops: [{ id: 'c', name: 'Crop', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: nodes.slice(1).map((n) => ({ nodeId: n.id, cropId: 'c', areaM2: 50_000 })),
			transfers: []
		},
		series: series as never
	};
}

describe('runModel and calibration performance: per-unit rain on a synthetic 12-unit catchment (issue #482)', () => {
	// Measured medians (2026-10-09, Node 24, the 20-thread dev laptop, nothing else running; docs/model.md §2.4h):
	// a run 140 ms on the catchment rain, 295 ms per unit; a calibration evaluation 29 ms and 49 ms. The budgets
	// (1 s, 200 ms) leave room for a slower or busier machine; a median creeping towards them is a regression.
	const catchment = twelveUnits(false);
	const perUnit = twelveUnits(true);

	it('a run stays well under a second (median of 7)', () => {
		const base = medianMs(7, () => runModel(catchment));
		const ms = medianMs(7, () => runModel(perUnit));
		console.log(`12-unit run: catchment rain ${base.toFixed(1)} ms, per-unit rain ${ms.toFixed(1)} ms`);
		expect(ms).toBeLessThan(1000);
	});

	it('a calibration evaluation (12 GR4J runs and the network) stays well under 200 ms (median of 7)', () => {
		const pb0 = prepareCalibration(catchment);
		const pb = prepareCalibration(perUnit);
		const base = medianMs(7, () => pb0.simulate(pb0.startParams));
		const ms = medianMs(7, () => pb.simulate(pb.startParams));
		console.log(`12-unit calibration evaluation: catchment rain ${base.toFixed(1)} ms, per-unit rain ${ms.toFixed(1)} ms`);
		expect(ms).toBeLessThan(200);
	});
});
