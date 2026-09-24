import { describe, expect, it } from 'vitest';
import { computeNaturalFlow } from '../flow';
import { defaultProjectSettings } from '../project';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import { NATURAL_FLOW, RUNOFF_MODELS } from '.';

describe('runoff model seam', () => {
	it('defaults to the legacy model', () => {
		expect(defaultProjectSettings().runoffModel).toBe('legacy');
		expect(RUNOFF_MODELS).toContain('legacy');
		expect(Object.keys(NATURAL_FLOW).sort()).toEqual([...RUNOFF_MODELS].sort());
	});

	it('legacy natural flow is computeNaturalFlow, bit for bit', () => {
		const rain = Array.from({ length: 400 }, (_, i) => (i < 30 ? 0 : i % 13 === 0 ? 5 + (i % 7) * 9 : i % 5 === 0 ? 1.5 : 0));
		const pitman = Array.from({ length: 400 }, (_, i) => 0.02 + (i % 11) / 1000);
		const input = randomInput(5);
		input.settings = { calibration: { ...defaultProjectSettings().calibration, baseFlowInitial: 0 } };
		input.series = {
			rain_catchment_mm: { startDate: '2020-03-01', values: rain },
			flow_pitman_m3s: { startDate: '2020-03-01', values: pitman }
		};
		const out = runModel(input);
		const area = input.model.nodes.filter((n) => n.kind === 'farm').reduce((t, n) => t + n.areaKm2, 0);
		const direct = computeNaturalFlow(
			{ ...defaultProjectSettings().calibration, baseFlowInitial: 0, catchmentAreaKm2: area },
			{ startDate: '2020-03-01', days: 400, rainCatchmentMm: rain, rainChirpsMm: [], rainForecastMm: [], flowPitmanM3s: pitman }
		);
		expect(out.series.find((s) => s.nodeId === null && s.key === 'natural_flow')!.values).toEqual(direct.naturalFlowM3Day);
		// baseFlowInitial 0 makes the first dry days fall back to Pitman, which the run reports.
		expect(direct.pitmanDays).toBeGreaterThan(0);
		expect(out.summary.warnings).toContain(
			`${direct.pitmanDays} days of natural flow are Pitman flow: the rain model gave 0 on those days, so the series mixes two sources`
		);
	});

	it('an explicit "legacy" gives the same run as the default', () => {
		for (const seed of [3, 17, 42]) {
			const input = randomInput(seed);
			const explicit = structuredClone(input);
			explicit.settings.runoffModel = 'legacy';
			expect(JSON.stringify(runModel(explicit))).toBe(JSON.stringify(runModel(input)));
		}
	});

	it('an unknown model warns and falls back to the default', () => {
		const input = randomInput(3);
		(input.settings as Record<string, unknown>).runoffModel = 'pitman';
		const out = runModel(input);
		expect(out.summary.warnings).toContain('unknown runoff model "pitman"; using legacy');
		const base = randomInput(3);
		expect(out.series).toEqual(runModel(base).series);
	});
});
