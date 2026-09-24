import { describe, expect, it } from 'vitest';
import { dds, reflect, type Bounds } from './dds';

const box = (n: number, min: number, max: number): Bounds[] => Array.from({ length: n }, () => ({ min, max }));
const sphere = (c: number[]) => (x: Float64Array) => x.reduce((s, v, i) => s + (v - c[i]!) ** 2, 0);
const rosenbrock = (x: Float64Array) => {
	let s = 0;
	for (let i = 0; i < x.length - 1; i++) s += 100 * (x[i + 1]! - x[i]! ** 2) ** 2 + (1 - x[i]!) ** 2;
	return s;
};
const rastrigin = (x: Float64Array) => 10 * x.length + x.reduce((s, v) => s + v * v - 10 * Math.cos(2 * Math.PI * v), 0);

describe('DDS', () => {
	it('finds the minimum of a shifted sphere', () => {
		const c = [1.5, -2, 30, 0.25];
		const res = dds(sphere(c), [...box(3, -5, 5), { min: 0, max: 100 }].map((b, i) => (i === 2 ? { min: 0, max: 100 } : b)), { budget: 2000, seed: 3 });
		expect(res.f).toBeLessThan(1e-3);
		res.x.forEach((v, i) => expect(v).toBeCloseTo(c[i]!, 1));
		expect(res.evaluations).toBe(2000);
	});

	it('finds the global basin of Rastrigin (many local minima) and the floor of Rosenbrock’s valley', () => {
		// Measured over seeds 1–8 at 5 000 evaluations: Rastrigin-4 ≤ 0.007,
		// Rosenbrock-2 ≤ 0.033, Rosenbrock-4 0.07–1.8 (from a start near 10³).
		// A coordinate-wise search creeps along a curved valley in 4-D: a known
		// DDS trait, not a defect; hydrological surfaces are rarely that narrow.
		for (const seed of [1, 2, 3]) {
			expect(dds(rastrigin, box(4, -5.12, 5.12), { budget: 5000, seed }).f).toBeLessThan(0.01);
			expect(dds(rosenbrock, box(2, -2, 2), { budget: 5000, seed }).f).toBeLessThan(0.05);
			expect(dds(rosenbrock, box(4, -2, 2), { budget: 5000, seed }).f).toBeLessThan(2);
		}
	});

	it('never evaluates outside the bounds, even with the optimum on an edge', () => {
		const bounds: Bounds[] = [
			{ min: 10, max: 3000 },
			{ min: -5, max: 3 },
			{ min: 1, max: 1000 },
			{ min: 0.5, max: 10 }
		];
		let outside = 0;
		const f = (x: Float64Array) => {
			x.forEach((v, i) => {
				if (v < bounds[i]!.min || v > bounds[i]!.max) outside++;
			});
			return x[0]! + x[1]! - x[2]! + x[3]!; // minimum at the corner (10, −5, 1000, 0.5)
		};
		const res = dds(f, bounds, { budget: 3000, seed: 9 });
		expect(outside).toBe(0);
		expect(res.x[0]).toBeLessThan(15);
		expect(res.x[2]).toBeGreaterThan(990);
	});

	it('is deterministic for a seed and differs between seeds', () => {
		const run = (seed: number) => dds(rastrigin, box(3, -5, 5), { budget: 400, seed });
		expect(run(5)).toEqual(run(5));
		expect(run(5).x).not.toEqual(run(6).x);
	});

	it('treats a non-finite objective as the worst value, starts from x0 when given, and can be stopped', () => {
		const res = dds((x) => (x[0]! > 0 ? NaN : x[0]! ** 2), box(1, -1, 1), { budget: 300, seed: 2, x0: [-0.9] });
		expect(res.x[0]).toBeLessThanOrEqual(0);
		expect(Math.abs(res.x[0]!)).toBeLessThan(0.05);
		const stopped = dds(sphere([0]), box(1, -1, 1), { budget: 1000, onEvaluation: (n) => n >= 50 });
		expect(stopped).toMatchObject({ evaluations: 50, stopped: true });
	});
});

describe('reflect', () => {
	it('mirrors at a bound, and falls back to the bound when the mirror leaves the other side', () => {
		const b = { min: 0, max: 10 };
		expect(reflect(-2, b)).toBe(2);
		expect(reflect(13, b)).toBe(7);
		expect(reflect(-25, b)).toBe(0);
		expect(reflect(31, b)).toBe(10);
		expect(reflect(4, b)).toBe(4);
	});
});
