import { recessionCheck, type DailySeries } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { flowTick, recessionChart, recessionRows, recessionVerdict, sig3 } from './recession';

// Invented record: storms (20 mm) each followed by 12 dry days of exponential recession.
function record(peaks: number[], k: number) {
	const flow: number[] = [1, 1, 1];
	const rain: number[] = [20, 20, 20];
	for (const p of peaks) {
		flow.push(p);
		rain.push(20);
		for (let t = 1; t <= 12; t++) {
			flow.push(p * Math.exp(-k * t));
			rain.push(0);
		}
	}
	return { flow, rain };
}

const PEAKS = [2, 3, 5, 8, 12, 18, 25, 40, 60, 90];
const m3Day = (m3s: number[]): DailySeries => ({ startDate: '2001-10-01', values: m3s.map((v) => v * 86_400) });

function check(obsK: number, simK: number, peaks = PEAKS) {
	const obs = record(peaks, obsK);
	const sim = record(peaks, simK);
	const c = recessionCheck({
		flowKind: 'flow_observed_m3s',
		observedM3s: obs.flow,
		simulatedM3Day: m3Day(sim.flow).values as number[],
		rainMm: obs.rain,
		excluded: new Uint8Array(obs.flow.length)
	});
	return { c, observed: m3Day(obs.flow), simulated: m3Day(sim.flow) };
}

describe('recessionChart', () => {
	it('rebuilds the engine’s points from the stored series, on a shared sorted log₁₀ Q axis', () => {
		const { c, observed, simulated } = check(0.05, 0.1);
		const ch = recessionChart(c, observed, simulated);
		expect(ch.observedPoints).toBe(c.observed!.points);
		expect(ch.simulatedPoints).toBe(c.simulated!.points);
		expect(ch.xy.x.length).toBe(ch.observedPoints + ch.simulatedPoints);
		expect([...ch.xy.x].sort((a, b) => a - b)).toEqual(ch.xy.x);
		expect(ch.xy.ys).toHaveLength(4);
		// Each x carries exactly one point, observed or simulated.
		ch.xy.x.forEach((_, i) => expect([ch.xy.ys[0]![i], ch.xy.ys[1]![i]].filter((v) => v !== null)).toHaveLength(1));
		// An exponential recession: the fitted line equals the points (b = 1, −dQ/dt ∝ Q).
		ch.xy.x.forEach((_, i) => {
			const o = ch.xy.ys[0]![i];
			if (o != null) expect(ch.xy.ys[2]![i]).toBeCloseTo(o, 9);
		});
		expect(ch.series.map((s) => [s.style ?? 'line', s.color])).toEqual([
			['points', '--chart-obs'],
			['points', '--series-2'],
			['dashed', '--chart-obs'],
			['line', '--series-2']
		]);
		expect(ch.series[0]!.label).toBe('Observed (gauge)');
		expect(ch.series[2]!.label).toMatch(/^Observed fit: a = 0\.05, b = 1\.00$/);
	});

	it('draws nothing from a series that is not loaded, and says a fit is missing', () => {
		const { c, observed } = check(0.05, 0.05);
		const ch = recessionChart({ ...c, simulated: null }, observed, null);
		expect(ch.simulatedPoints).toBe(0);
		expect(ch.xy.ys[1]!.every((v) => v === null)).toBe(true);
		expect(ch.xy.ys[3]!.every((v) => v === null)).toBe(true);
		expect(ch.series[3]!.label).toBe('Simulated fit: too few points');
	});
});

describe('recessionRows, recessionVerdict and formats', () => {
	it('tabulates both fits', () => {
		const { c } = check(0.05, 0.1);
		const [o, s] = recessionRows(c);
		expect(o).toMatchObject({ label: 'Observed (gauge)', b: '1.00', points: c.observed!.points, segments: 10 });
		expect(s!.label).toBe('Simulated outflow');
		expect(Number(s!.rate) / Number(o!.rate)).toBeCloseTo(2, 1);
	});

	it('agrees, disagrees, or is not judged', () => {
		expect(recessionVerdict(check(0.05, 0.05).c)).toMatchObject({ ok: true, text: expect.stringMatching(/recedes 1\.0× faster .* Within the indicative limits/) });
		expect(recessionVerdict(check(0.03, 0.09).c)).toMatchObject({ ok: false, text: expect.stringMatching(/recedes 3\.0× faster .* Outside the indicative limits/) });
		expect(recessionVerdict(check(0.09, 0.03).c).text).toMatch(/3\.0× slower/);
		expect(recessionVerdict(check(0.05, 0.05, [5, 8]).c)).toEqual({ ok: null, text: 'Not judged: only 2 rain-free recession segments, fewer than the 8 a stable fit needs.' });
		const { c } = check(0.05, 0.05);
		expect(recessionVerdict({ ...c, simulated: null, agrees: false }).text).toMatch(/barely falls/);
	});

	it('writes three significant figures, and log₁₀ ticks as flows', () => {
		expect(sig3(0.012345)).toBe('0.0123');
		expect(sig3(1234.5)).toBe('1230');
		expect(sig3(0.00001234)).toBe('1.23e−5');
		expect(sig3(null)).toBe('–');
		expect(flowTick(-2)).toBe('0.01');
		expect(flowTick(Math.log10(2.5))).toBe('2.5');
	});
});
