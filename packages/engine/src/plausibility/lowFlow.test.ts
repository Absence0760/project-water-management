import { describe, expect, it } from 'vitest';
import { LOW_FLOW_MIN_DAYS, LOW_FLOW_POINTS, lowFlowCurves, lowFlowWarning, type LowFlowInput } from './lowFlow';
import type { DrySeason } from './season';

const season: DrySeason = { months: [11, 12, 1, 2, 3, 4], source: 'flow_observed_m3s' };
const q90 = LOW_FLOW_POINTS.indexOf(90);

/** n dry-season days; the gauge reads 1 … n m³/s (shuffled order doesn't matter), the model k × that. */
function input(n: number, k: number, over: Partial<LowFlowInput> = {}): LowFlowInput {
	const obs = Array.from({ length: n }, (_, t) => t + 1);
	return {
		season,
		inSeason: new Uint8Array(n).fill(1),
		runoffModel: 'gr4j',
		observed: { flow_observed_m3s: obs },
		calibrationKind: 'flow_observed_m3s',
		simulatedM3Day: obs.map((v) => v * k * 86_400),
		naturalM3Day: obs.map((v) => v * 3 * 86_400),
		excluded: new Uint8Array(n),
		...over
	};
}

describe('lowFlowCurves', () => {
	it('reads Q90 off the Weibull positions: 1 … 100 m³/s gives 10.1 (hand-worked)', () => {
		// Sorted high → low, the i-th at i ÷ 101: 90 % sits at i = 90.9, between 11 (i = 90) and 10 (i = 91).
		const lf = lowFlowCurves(input(100, 2))!;
		const gauge = lf.curves.find((c) => c.source === 'flow_observed_m3s')!;
		expect(gauge.days).toBe(100);
		expect(gauge.flowsM3s[q90]).toBeCloseTo(10.1, 12);
		expect(lf.comparison).toMatchObject({ flowKind: 'flow_observed_m3s', days: 100, observedQ90M3s: expect.closeTo(10.1, 12), simulatedQ90M3s: expect.closeTo(20.2, 12) });
		expect(lf.comparison!.ratio).toBeCloseTo(2, 12);
		// Exactly a factor of 2 is still within it.
		expect(lf.comparison!.withinFactor).toBe(true);
		expect(lowFlowWarning(lf)).toBeNull();
	});

	it('lists gauge, simulated, natural, then simulated on the gauge days; curves never rise', () => {
		const lf = lowFlowCurves(input(120, 1))!;
		expect(lf.curves.map((c) => [c.source, c.pairedWith])).toEqual([
			['flow_observed_m3s', null],
			['simulated_outflow', null],
			['natural_flow', null],
			['simulated_outflow', 'flow_observed_m3s']
		]);
		for (const c of lf.curves) for (let i = 1; i < c.flowsM3s.length; i++) expect(c.flowsM3s[i]!).toBeLessThanOrEqual(c.flowsM3s[i - 1]!);
		expect(lf.points).toEqual([...LOW_FLOW_POINTS]);
		expect(lf.runoffModel).toBe('gr4j');
	});

	it('warns when the model is more than a factor 2 off, either way', () => {
		const high = lowFlowCurves(input(100, 2.5))!;
		expect(high.comparison!.withinFactor).toBe(false);
		expect(lowFlowWarning(high)).toMatch(/Q90 is 25\.25 m³\/s against 10\.10 m³\/s observed \(2\.5× higher\)/);
		const low = lowFlowCurves(input(100, 0.25))!;
		expect(lowFlowWarning(low)).toMatch(/4\.0× lower/);
	});

	it('writes a small Q90 to two significant figures, never as 0.000 (issue #45)', () => {
		// The gauge reads 1 … 100 L/s (observed Q90 0.0101 m³/s); the model 3 % of it (Q90 0.000303 m³/s, once written "0.000").
		const n = 100;
		const obs = Array.from({ length: n }, (_, t) => (t + 1) / 1000);
		const lf = lowFlowCurves(input(n, 1, { observed: { flow_observed_m3s: obs }, simulatedM3Day: obs.map((v) => v * 0.03 * 86_400) }))!;
		const text = lowFlowWarning(lf)!;
		expect(text).toMatch(/Q90 is 0\.0003 m³\/s against 0\.010 m³\/s observed/);
		expect(text).not.toMatch(/0\.000 m³\/s/);
	});

	it('uses only dry-season days, leaves excluded days out of the observed and paired curves', () => {
		const n = 200;
		const x = input(n, 1);
		x.inSeason = Uint8Array.from({ length: n }, (_, t) => (t < 150 ? 1 : 0));
		x.excluded = Uint8Array.from({ length: n }, (_, t) => (t < 20 ? 1 : 0));
		const lf = lowFlowCurves(x)!;
		expect(lf.curves.find((c) => c.source === 'flow_observed_m3s')!.days).toBe(130);
		expect(lf.curves.find((c) => c.source === 'simulated_outflow' && c.pairedWith === null)!.days).toBe(150);
		expect(lf.curves.find((c) => c.pairedWith === 'flow_observed_m3s')!.days).toBe(130);
	});

	it('counts flows below 0.001 m³/s as 0.001 in the ratio: a dry gauge and a dry model agree', () => {
		const n = 100;
		const x = input(n, 1, { observed: { flow_observed_m3s: new Array(n).fill(0) }, simulatedM3Day: new Array(n).fill(0.0005 * 86_400) });
		expect(lowFlowCurves(x)!.comparison).toMatchObject({ ratio: 1, withinFactor: true });
		// A model still flowing at 0.01 m³/s where the gauge read 0 is 10× the floor.
		const y = input(n, 1, { observed: { flow_observed_m3s: new Array(n).fill(0) }, simulatedM3Day: new Array(n).fill(0.01 * 86_400) });
		expect(lowFlowCurves(y)!.comparison!.ratio).toBeCloseTo(10, 9);
	});

	it('drops curves with fewer than 90 days, and compares only the calibration record', () => {
		const short = lowFlowCurves(input(LOW_FLOW_MIN_DAYS - 1, 5))!;
		expect(short.curves).toEqual([]);
		expect(short.comparison).toBeNull();
		const logger = lowFlowCurves(input(100, 5, { calibrationKind: 'flow_logger_m3s' }))!;
		expect(logger.comparison).toBeNull();
		expect(logger.curves.some((c) => c.source === 'flow_observed_m3s')).toBe(true);
	});

	it('is null without a dry season', () => {
		expect(lowFlowCurves(input(100, 1, { season: null }))).toBeNull();
		expect(lowFlowWarning(null)).toBeNull();
	});
});
