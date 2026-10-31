// Calibration zones (engine 1.106.0, issue #555, docs/model.md §2.10n) on the
// invented example catchments `pnpm seed:examples` loads. The guard the issue
// asks for: a project with only the outlet ticked (no calibration zone, the []
// migration 270 stores, or every gauge's row unticked) runs and fits to the
// bit as it did before zones existed, under both flow generation methods. And
// a ticked zone with its own parameters keeps every engine invariant.
//
// Calibration locations (engine 1.110.0, issue #659): the migration guard. A
// project in the shape stored before them (its site at the outlet, or at an
// inner gauge) runs and fits to the bit as it does in the shape
// 289_calibration_locations.sql moves it to (the API's locatedSettings, which
// migration-289.db.test.ts holds the SQL to), on every example catchment and
// the Showcase.
import {
	CALIBRATION_FLOW_KINDS,
	calibrate,
	calibrateStepwise,
	gaugeSeriesKey,
	newCalibrationZone,
	runModel,
	type CalibrationZone,
	type ModelInput
} from '@water-management/engine';
import { checkAll, sameOutput } from '@water-management/engine/testing';
import { describe, expect, it } from 'vitest';
import { buildExamples, inputOf } from '../../scripts/examples/catchments.js';
import { buildShowcase } from '../../scripts/examples/showcase.js';
import { locatedSettings } from '../projects/calibrationSite.js';

const examples = buildExamples({ fit: false });

const perUnit = (input: ModelInput): ModelInput => ({ ...input, settings: { ...input.settings, unitRain: { mode: 'perUnit', gaugeMapMm: 600, gaugeMapSource: 'invented gauge MAP' } } as never });
const withZones = (input: ModelInput, zones: unknown): ModelInput => ({ ...input, settings: { ...input.settings, calibrationZones: zones } as never });

/** The example's inner gauges that a land unit drains to (the outlet excluded), by node id. */
function innerGauges(input: ModelInput): string[] {
	const nodes = input.model.nodes;
	const below = (id: string) => {
		const out: string[] = [];
		let cur = nodes.find((n) => n.id === id)?.downstreamNodeId ?? null;
		while (cur && !out.includes(cur)) {
			out.push(cur);
			cur = nodes.find((n) => n.id === cur)?.downstreamNodeId ?? null;
		}
		return out;
	};
	const reached = new Set(nodes.filter((n) => n.kind === 'farm' && n.areaKm2 > 0).flatMap((n) => below(n.id)));
	return nodes.filter((n) => n.kind === 'gauge' && n.downstreamNodeId !== null && reached.has(n.id)).map((n) => n.id).sort();
}

describe('calibration zones on the example catchments', () => {
	for (const ex of examples) {
		it(`${ex.name}: only the outlet ticked runs and fits bit-identically, with no unitRain stored and with a gauge MAP`, () => {
			for (const base of [inputOf(ex), perUnit(inputOf(ex))]) {
				const gauges = innerGauges(base);
				const unticked: CalibrationZone[] = gauges.map((id) => ({ ...newCalibrationZone(id), gr4j: { x1: 900, x2: 0, x3: 220, x4: 3.1 } }));
				const bare = runModel(base);
				for (const zones of [[], unticked]) {
					const input = withZones(base, zones);
					expect(sameOutput(bare, runModel(input)), `${ex.name} ${JSON.stringify(zones).slice(0, 40)}`).toBe(true);
					const opts = { budget: 40, validate: true, seed: 4 } as const;
					const one = calibrate(base, opts);
					expect(calibrate(input, opts)).toEqual(one);
					const stepwise = calibrateStepwise(input, opts);
					expect(stepwise.steps.map((s) => s.report)).toEqual([one]);
				}
			}
		}, 180_000);
	}

	it('a ticked zone with its own parameters keeps every invariant (Per unit)', () => {
		let zoned = 0;
		for (const ex of examples) {
			const input = perUnit(inputOf(ex));
			const gauge = innerGauges(input)[0];
			if (!gauge) continue;
			const z = withZones(input, [{ ...newCalibrationZone(gauge), enabled: true, gr4j: { x1: 900, x2: 0, x3: 220, x4: 3.1 } }]);
			const out = runModel(z);
			expect(out.summary.unitRain?.zones?.[0]?.nodeId, ex.name).toBe(gauge);
			expect(out.summary.unitRain!.zones![0]!.units.length, ex.name).toBeGreaterThan(0);
			expect(sameOutput(out, runModel(input)), ex.name).toBe(false);
			expect(checkAll(z, 1), ex.name).toBeNull();
			zoned++;
		}
		expect(zoned).toBeGreaterThan(0);
	}, 180_000);
});

describe('calibration locations on the example catchments and the Showcase: the migration guard (issue #659)', () => {
	/** The input in the shape 289 stores, with the truth about the outlet record the migration reads. */
	const migrated = (input: ModelInput): ModelInput => {
		const outletRecord = CALIBRATION_FLOW_KINDS.some((k) => input.series[k] !== undefined);
		return { ...input, settings: locatedSettings(input.settings, input.model.nodes, outletRecord) };
	};
	/** Settings as stored before 1.110.0: none of the locations' keys. */
	const legacy = (input: ModelInput, extra: Record<string, unknown> = {}): ModelInput => {
		const { calibrateAtOutlet: _a, calibrationRest: _r, unitParamsFrom: _u, ...rest } = input.settings as Record<string, unknown>;
		return { ...input, settings: { ...rest, ...extra } as ModelInput['settings'] };
	};
	const opts = { budget: 20, validate: false, seed: 5 } as const;
	let innerSites = 0;
	let fitted = 0;

	for (const ex of [...examples, buildShowcase({ fit: false })]) {
		it(`${ex.name}: the site at the outlet, and at an inner gauge with a ticked zone above it, run and fit the same before and after`, () => {
			const base = legacy(inputOf(ex));
			const cases: [string, ModelInput][] = [['outlet', base]];
			const gauge = innerGauges(base)[0];
			if (gauge) {
				// The gauge's own record (any synthetic one: only the shapes are compared).
				const rec = base.series.flow_observed_m3s ?? base.series.flow_logger_m3s;
				const series = rec ? { ...base.series, [gaugeSeriesKey('flow_observed_m3s', gauge)]: rec } : base.series;
				cases.push(['inner gauge', { ...legacy(base, { calibrationSiteNodeId: gauge }), series }]);
				innerSites++;
			}
			for (const [what, raw] of cases) {
				const moved = migrated(raw);
				expect(moved.settings, `${ex.name} ${what}: positive control, the shape changed`).not.toEqual(raw.settings);
				expect(sameOutput(runModel(raw), runModel(moved)), `${ex.name} ${what}: run`).toBe(true);
				if (!rec(raw)) continue;
				const a = calibrateStepwise(raw, opts);
				fitted++;
				const b = calibrateStepwise(moved, opts);
				expect(b.steps.map((x) => x.zoneNodeId), `${ex.name} ${what}: steps`).toEqual(a.steps.map((x) => x.zoneNodeId));
				expect(b.steps.map((x) => x.report), `${ex.name} ${what}: reports`).toEqual(a.steps.map((x) => x.report));
			}
		}, 300_000);
	}

	it('positive control: the guard compared an inner site and fits', () => {
		expect(innerSites).toBeGreaterThan(0);
		expect(fitted).toBeGreaterThan(innerSites);
	});
});

/** Whether the input has a record a fit can score at its headline: the outlet's (or, at an inner site, the gauge's). */
const rec = (input: ModelInput): boolean => Object.keys(input.series).some((k) => k.startsWith('flow_observed_m3s') || k.startsWith('flow_logger_m3s'));
