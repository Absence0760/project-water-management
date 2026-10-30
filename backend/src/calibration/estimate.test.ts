// The work-based time estimate behind refusing calibration rules and server
// ensembles (./estimate.ts): it reads the model's size, never a clock, so the
// same project and rules always get the same yes or no, however busy the
// server is (the e2e flake of 2026-10-30: a loaded CI runner timed a 2.6 ms
// run at 23 ms and refused rules it accepts locally).
import { defaultCalibrationRules, planAutoCalibration, type ModelInput } from '@water-management/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build, EXAMPLES, inputOf } from '../../scripts/examples/catchments.js';
import { caseSeconds, ensembleSeconds, evaluationSeconds, modelSize, runSeconds, WORKER_SLOWDOWN, type ModelSize } from './estimate.js';
import { AUTO_CASE_SECONDS_MAX } from './schema.js';
import { CalibrationRefused, planCalibration } from './store.js';

const example = (): ModelInput => {
	const input = inputOf(build(EXAMPLES[0]!, { fit: false }));
	return { ...input, settings: { ...input.settings, runoffModel: 'gr4j' } };
};
/** The example over its first `days` days, with the rules' search set to `starts` × `budget`. */
const sized = (days: number, starts: number, budget: number): ModelInput => {
	const input = example();
	const start = input.series.rain_catchment_mm!.startDate;
	const end = new Date(Date.parse(start) + (days - 1) * 86_400_000).toISOString().slice(0, 10);
	return {
		...input,
		settings: { ...input.settings, simulationStart: start, simulationEnd: end, calibrationRules: { ...defaultCalibrationRules(), run: { seed: 1, starts, budget } } }
	};
};
/** planCalibration's answer: the plan's case count, or the refusal's message. */
const decide = (input: ModelInput, maxSeconds?: number): string => {
	try {
		return `ok ${planCalibration(input, maxSeconds).cases.length}`;
	} catch (err) {
		if (err instanceof CalibrationRefused) return `refused: ${err.message}`;
		throw err;
	}
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe('the time estimate', () => {
	it('reads the model’s size from the input: the run’s days, the nodes, the units with an area and the GR4J warm-up', () => {
		const input = sized(400, 1, 50);
		const nodes = input.model.nodes;
		expect(modelSize(input)).toEqual({ days: 400, nodes: nodes.length, units: nodes.filter((n) => n.areaKm2 > 0).length, warmupDays: 365 });
		expect(modelSize({ ...input, settings: { ...input.settings, gr4j: { warmupDays: 1000 } } as never }).warmupDays).toBe(1000);
		// An invalid warm-up runs as the default, so it costs as the default.
		expect(modelSize({ ...input, settings: { ...input.settings, gr4j: { warmupDays: -5 } } as never }).warmupDays).toBe(365);
	});

	it('is the envelope’s formula on the worker: pinned, so a change to a constant is a change to this test', () => {
		const s: ModelSize = { days: 5000, nodes: 10, units: 8, warmupDays: 365 };
		// 5000 × (3 + 2 × 10) + 365 × 0.2 × 8 + 100 × 10 + 500 = 117 084 µs on the measuring machine.
		expect(evaluationSeconds(s)).toBeCloseTo((WORKER_SLOWDOWN * 117_084) / 1e6, 9);
		// 5000 × (10 + 4 × 10) + 365 × 0.2 × 8 + 300 × 10 + 20 000 = 273 584 µs.
		expect(runSeconds(s)).toBeCloseTo((WORKER_SLOWDOWN * 273_584) / 1e6, 9);
		expect(caseSeconds({ caseEvaluations: 1000 }, s)).toBeCloseTo(1000 * evaluationSeconds(s) + 5 * runSeconds(s), 9);
		expect(ensembleSeconds(60, s)).toBeCloseTo(61 * runSeconds(s), 9);
	});

	it('grows with every dimension it reads', () => {
		const s: ModelSize = { days: 2000, nodes: 5, units: 4, warmupDays: 365 };
		for (const more of [{ days: 2001 }, { nodes: 6 }, { units: 5 }, { warmupDays: 366 }]) {
			expect(evaluationSeconds({ ...s, ...more })).toBeGreaterThan(evaluationSeconds(s));
			expect(runSeconds({ ...s, ...more })).toBeGreaterThan(runSeconds(s));
		}
		expect(caseSeconds({ caseEvaluations: 701 }, s)).toBeGreaterThan(caseSeconds({ caseEvaluations: 700 }, s));
	});
});

describe('planCalibration', () => {
	it('gives the same answer under a clock that crawls, races or stands still: it never reads one', () => {
		const inputs = [sized(400, 1, 50), sized(400, 5, 1500), example()];
		const calm = inputs.map((i) => decide(i));
		let t = 0;
		const now = vi.spyOn(performance, 'now');
		for (const step of [0, 1, 50, 60_000]) {
			now.mockImplementation(() => (t += step));
			expect(inputs.map((i) => decide(i))).toEqual(calm);
		}
		expect(now).not.toHaveBeenCalled();
		// Both answers are covered: a small search runs, the default search on fifteen years is refused.
		expect(calm[0]).toBe('ok 2');
		expect(calm[2]).toMatch(/^refused: each fit would take up to about \d+ minutes on the server \(10500 model runs\)/);
	});

	it('refuses just past the limit and runs just under it, saying how long and how many model runs', () => {
		const input = sized(1000, 2, 400);
		const seconds = caseSeconds(planAutoCalibration(input), modelSize(input));
		expect(decide(input, seconds)).toBe('ok 2');
		const refused = decide(input, seconds * 0.999);
		expect(refused).toBe(
			`refused: each fit would take up to about ${Math.ceil(seconds / 60)} minutes on the server (${400 * (2 + 2)} model runs), more than a background job may run (${(seconds * 0.999) / 60} minutes): lower the model runs per fit or the starts in the calibration rules`
		);
	});

	it('runs the default search on a short record, as the e2e project’s (it flapped when the estimate was a stopwatch)', () => {
		// Four months of record, as the e2e seeded project has: the default search (5 starts × 1500) inside 4 minutes on
		// this five-node example (about 2), and every time.
		const input = sized(120, 5, 1500);
		expect(caseSeconds(planAutoCalibration(input), modelSize(input))).toBeLessThan(AUTO_CASE_SECONDS_MAX);
		expect(decide(input)).toBe('ok 2');
	});

	it('still refuses what the engine refuses, as the rules’ to fix', () => {
		const input = sized(400, 1, 50);
		const noFlow = { ...input, series: { ...input.series, flow_observed_m3s: undefined, flow_logger_m3s: undefined } };
		expect(decide(noFlow)).toMatch(/^refused: /);
	});
});
