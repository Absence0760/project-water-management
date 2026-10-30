// Calibration zones (engine 1.106.0, issue #555, docs/model.md §2.10n) on the
// invented example catchments `pnpm seed:examples` loads. The guard the issue
// asks for: a project with only the outlet ticked (no calibration zone, the []
// migration 270 stores, or every gauge's row unticked) runs and fits to the
// bit as it did before zones existed, under both flow generation methods. And
// a ticked zone with its own parameters keeps every engine invariant.
import { calibrate, calibrateStepwise, newCalibrationZone, runModel, type CalibrationZone, type ModelInput } from '@water-management/engine';
import { checkAll, sameOutput } from '@water-management/engine/testing';
import { describe, expect, it } from 'vitest';
import { buildExamples, inputOf } from '../../scripts/examples/catchments.js';

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
