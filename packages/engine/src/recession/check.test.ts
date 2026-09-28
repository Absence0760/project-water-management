import { describe, expect, it } from 'vitest';
import { RECESSION_MIN_SEGMENTS, recessionCheck, recessionWarnings } from './check';
import { exponential, syntheticRecord } from './testSeries';

const PEAKS = [2, 3, 5, 8, 12, 18, 25, 40, 60, 90];

function input(obsK: number, simK: number, peaks = PEAKS) {
	const events = peaks.map((p) => ({ peakM3s: p, dryDays: 12 }));
	const obs = syntheticRecord(events, exponential(obsK));
	const sim = syntheticRecord(events, exponential(simK));
	return {
		flowKind: 'flow_observed_m3s' as const,
		observedM3s: obs.flowM3s,
		simulatedM3Day: sim.flowM3s.map((v) => v! * 86_400),
		rainMm: obs.rainMm,
		excluded: new Uint8Array(obs.flowM3s.length)
	};
}

describe('recessionCheck', () => {
	it('agrees when the model recedes like the river', () => {
		const r = recessionCheck(input(0.05, 0.05));
		expect(r.segments).toHaveLength(PEAKS.length);
		expect(r.observed!.b).toBeCloseTo(1, 6);
		expect(r.simulated!.b).toBeCloseTo(1, 6);
		expect(r.rateRatio).toBeCloseTo(1, 9);
		expect(r.bDiff).toBeCloseTo(0, 9);
		expect(r.agrees).toBe(true);
		expect(recessionWarnings(r)).toEqual([]);
	});

	it('warns when the simulated recession is 3× faster', () => {
		const r = recessionCheck(input(0.03, 0.09));
		expect(r.rateRatio).toBeGreaterThan(2.5);
		expect(r.agrees).toBe(false);
		const [w] = recessionWarnings(r);
		expect(w).toMatch(/^Recession diagnostics \(indicative\): on the 10 rain-free recession segments of the observed gauge record, at .* m³\/s the simulated flow recedes 3\.0× faster than the observed\./);
	});

	it('warns on b apart by more than 0.5 (a simulated linear reservoir against a non-linear river)', () => {
		const x = input(0.05, 0.05);
		// Observed −dQ/dt = 0.002·Q²; simulated stays exponential at the same days.
		const obs = syntheticRecord(PEAKS.map((p) => ({ peakM3s: p, dryDays: 12 })), (q0, t) => 1 / (1 / q0 + 0.002 * t));
		const r = recessionCheck({ ...x, observedM3s: obs.flowM3s });
		expect(r.bDiff!).toBeLessThan(-0.5);
		expect(r.agrees).toBe(false);
		expect(recessionWarnings(r)[0]).toMatch(/b is 1\.00 simulated against (1\.9\d|2\.0\d) observed \(more than 0\.5 apart\)/);
	});

	it(`does not judge fewer than ${RECESSION_MIN_SEGMENTS} segments, and doesn't warn about it`, () => {
		const r = recessionCheck(input(0.03, 0.09, PEAKS.slice(0, 3)));
		expect(r.segments).toHaveLength(3);
		expect(r.observed).not.toBeNull();
		expect(r.agrees).toBeNull();
		expect(recessionWarnings(r)).toEqual([]);
		const none = recessionCheck({ ...input(0.05, 0.05), rainMm: input(0.05, 0.05).rainMm.map(() => 30) });
		expect(none.segments).toEqual([]);
		expect(none.observed).toBeNull();
		expect(recessionWarnings(none)).toEqual([]);
	});

	it('leaves the calibration exclusions out', () => {
		const x = input(0.05, 0.05);
		const excluded = new Uint8Array(x.excluded.length).fill(1);
		expect(recessionCheck({ ...x, excluded }).segments).toEqual([]);
	});

	it('uses the observed segments for the simulated flow, and warns when the model does not fall on them', () => {
		const x = input(0.05, 0.05);
		const flat = x.simulatedM3Day.map(() => 86_400);
		const r = recessionCheck({ ...x, simulatedM3Day: flat });
		expect(r.segments).toHaveLength(PEAKS.length);
		expect(r.simulated).toBeNull();
		expect(r.agrees).toBe(false);
		expect(recessionWarnings(r)[0]).toContain('the simulated outflow barely falls');
	});

	it('nothing to say without a check', () => {
		expect(recessionWarnings(null)).toEqual([]);
		expect(recessionWarnings(undefined)).toEqual([]);
	});
});
