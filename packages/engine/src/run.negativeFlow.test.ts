// A negative flow is a "no reading" placeholder, never a flow (engine 1.16.0,
// issue #51, prepare.ts alignFlow): the run reads it as missing, as the DWS
// import does, so the calibration statistics, the fit's problem and the
// observed_flow series all skip it.
import { describe, expect, it } from 'vitest';
import { prepareCalibration } from './calibrate/calibrate';
import type { ModelInput } from './project';
import { runModelChecked } from './run';
import { randomInput } from './testing/fuzz';

/** A random network with an observed record, `placeholder` on three of its days (null = a plain gap). */
function withObserved(placeholder: number | null): ModelInput {
	const x = randomInput(11, { maxDays: 400 });
	const rain = Array.from({ length: 300 }, (_, i) => (i % 4 === 0 ? 6 : 0));
	const values: (number | null)[] = Array.from({ length: 300 }, (_, i) => 0.02 + 0.01 * Math.sin(i / 9));
	for (const i of [10, 50, 90]) values[i] = placeholder;
	x.series = { rain_catchment_mm: { startDate: '2020-01-01', values: rain }, flow_observed_m3s: { startDate: '2020-01-01', values } };
	x.settings = {
		...x.settings,
		simulationStart: null,
		simulationEnd: null,
		rainSource: [],
		calibrationFlowKind: 'flow_observed_m3s',
		calibrationStart: null,
		calibrationEnd: null,
		calibrationExclusions: []
	};
	return x;
}

describe('negative observed flow (issue #51)', () => {
	it('is read as missing: the calibration equals the one with gaps on those days', () => {
		const gaps = runModelChecked(withObserved(null));
		for (const sentinel of [-999, -1]) {
			const out = runModelChecked(withObserved(sentinel));
			expect(out.summary.calibration, String(sentinel)).toEqual(gaps.summary.calibration);
			const obs = out.series.find((s) => s.nodeId === null && s.key === 'observed_flow')!.values;
			expect(Number.isNaN(obs[10]!)).toBe(true);
			// The data-quality warning names them and says what the run did.
			expect(out.summary.warnings.some((w) => /negative value.*Flow can't be negative.*treats these days as missing/.test(w))).toBe(true);
		}
		// Positive control: the record is scored on its other days.
		expect(gaps.summary.calibration!.days).toBeGreaterThan(0);
	});

	it('is left out of the fit’s problem too', () => {
		const a = prepareCalibration(withObserved(null));
		const b = prepareCalibration(withObserved(-999));
		expect(Array.from(b.observed).map((v) => (Number.isNaN(v) ? null : v))).toEqual(Array.from(a.observed).map((v) => (Number.isNaN(v) ? null : v)));
	});
});
