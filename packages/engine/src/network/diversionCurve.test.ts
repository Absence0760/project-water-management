// Diversion curves on river off-takes (engine 1.113.0, docs/model.md §2.6a):
// the share of the river's flow an off-take sized by `diversionCurve` diverts,
// MIN(maxShare, a · x^b ÷ 100), x the flow in the curve's unit. The worked
// example is a canal of the shape the client's hydrologist gave (2026-11-02),
// with invented numbers: 2000 · x^−0.9 percent, at most 95 %. Its flow unit is
// still open with him, so every candidate unit is pinned here.
import { describe, expect, it } from 'vitest';
import { DIVERSION_FLOW_UNIT_M3_DAY, DIVERSION_FLOW_UNITS, type DiversionFlowUnit, type Transfer } from '../project';
import { Rng } from '../random';
import { diversionCurveOf, diversionCurveProblem, diversionShareOf, diversionWant, offtakeOf, type DiversionCurve } from './offtake';

const curve = (over: Partial<DiversionCurve> = {}): DiversionCurve => ({ a: 2000, b: -0.9, maxShare: 0.95, m3DayPerUnit: DIVERSION_FLOW_UNIT_M3_DAY['L/s'], natural: false, ...over });
const canal = (unit: DiversionFlowUnit) => curve({ m3DayPerUnit: DIVERSION_FLOW_UNIT_M3_DAY[unit] });
const rule = (over: Partial<Transfer> = {}): Transfer => ({
	id: 'o',
	fromNodeId: 'S',
	toNodeId: 'C',
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: 0.25,
	dailyCapM3: null,
	minStoragePct: 0,
	enabled: true,
	priority: 0,
	source: 'river',
	sizing: 'diversionCurve',
	diversionCoefficient: 2000,
	diversionExponent: -0.9,
	diversionMaxPct: 0.95,
	diversionFlowUnit: 'L/s',
	...over
});

describe('the flow units', () => {
	it('are m³/day per one of each: 1 L/s = 86.4 m³/day, 1 m³/s = 86 400, 1 Ml/day = 1 000', () => {
		expect(DIVERSION_FLOW_UNIT_M3_DAY).toEqual({ 'L/s': 86.4, 'm3/s': 86_400, 'm3/day': 1, 'Ml/day': 1_000 });
		expect([...DIVERSION_FLOW_UNITS]).toEqual(Object.keys(DIVERSION_FLOW_UNIT_M3_DAY));
	});
});

describe('diversionShareOf', () => {
	it('reads the curve in L/s: 2000 × x^−0.9 percent, capped at 95 %', () => {
		const c = canal('L/s');
		// 1 000 L/s (86 400 m³/day): 2000 × 1000^−0.9 = 3.99 %.
		expect(diversionShareOf(c, 86_400)).toBeCloseTo((2000 * Math.pow(1000, -0.9)) / 100, 12);
		expect(diversionShareOf(c, 86_400)).toBeCloseTo(0.0399, 4);
		// 100 L/s: 31.7 %; 20 L/s: 135 %, held at 95 %.
		expect(diversionShareOf(c, 8_640)).toBeCloseTo(0.317, 4);
		expect(diversionShareOf(c, 1_728)).toBe(0.95);
		// The cap binds below a · x^b = 95: x = (95 / 2000)^(1 / −0.9) ≈ 29.5 L/s.
		const knee = Math.pow(95 / 2000, 1 / -0.9);
		expect(knee).toBeCloseTo(29.54, 2);
		expect(diversionShareOf(c, knee * 86.4 * 0.999)).toBe(0.95);
		expect(diversionShareOf(c, knee * 86.4 * 1.001)).toBeLessThan(0.95);
	});

	it('in m³/s or Ml/day the same curve is 95 % at every flow a small river carries', () => {
		// a · x^b ≥ 95 % for x ≤ 29.5 units: 29.5 m³/s is 2.5 million m³/day, 29.5 Ml/day 29 500 m³/day.
		for (const x of [1, 100, 10_000, 1_000_000]) expect(diversionShareOf(canal('m3/s'), x), `${x} m³/day in m³/s`).toBe(0.95);
		for (const x of [1, 100, 10_000]) expect(diversionShareOf(canal('Ml/day'), x), `${x} m³/day in Ml/day`).toBe(0.95);
		expect(diversionShareOf(canal('Ml/day'), 86_400)).toBeCloseTo((2000 * Math.pow(86.4, -0.9)) / 100, 12);
		// In m³/day the curve is below the cap above 29.5 m³/day.
		expect(diversionShareOf(canal('m3/day'), 1_000)).toBeCloseTo((2000 * Math.pow(1000, -0.9)) / 100, 12);
	});

	it('diverts nothing from a dry river, or a flow that is not a number', () => {
		const c = canal('L/s');
		for (const x of [0, -1, -0, Number.NaN, Number.NEGATIVE_INFINITY]) expect(diversionShareOf(c, x), String(x)).toBe(0);
	});

	it('holds the cap as x → 0 with b < 0 (x^b runs to +∞), and with no cap takes at most all of it', () => {
		expect(diversionShareOf(canal('L/s'), Number.MIN_VALUE)).toBe(0.95);
		expect(diversionShareOf(curve({ maxShare: 1 }), 1e-300)).toBe(1);
	});

	it('reads b = 0 as a fixed percentage, and b > 0 as a share rising with the flow', () => {
		expect(diversionShareOf(curve({ a: 40, b: 0, maxShare: 1, m3DayPerUnit: 1 }), 12_345)).toBeCloseTo(0.4, 15);
		const up = curve({ a: 1, b: 0.5, maxShare: 1, m3DayPerUnit: 1 });
		expect(diversionShareOf(up, 100)).toBeCloseTo(0.1, 15);
		expect(diversionShareOf(up, 1e6)).toBe(1);
	});
});

describe('diversionWant', () => {
	it('is the share, read at the basis flow, of the river at the off-take', () => {
		const c = curve({ a: 1e4, b: -1, maxShare: 1, m3DayPerUnit: 1 });
		// Read at the river itself: 100 / x of x, 100 m³/day at any flow above 100.
		expect(diversionWant(c, 600, 600)).toBeCloseTo(100, 9);
		// Read at a natural flow of 1 000: 10 % of the 600 there.
		expect(diversionWant(c, 600, 1000)).toBeCloseTo(60, 9);
		// No river, nothing; no basis flow, nothing.
		expect(diversionWant(c, 0, 1000)).toBe(0);
		expect(diversionWant(c, 600, 0)).toBe(0);
	});

	// The invariants every curve holds, on random curves and flows.
	it('never wants more than the river, or more than the cap of it; the share never exceeds the cap', () => {
		const g = new Rng(20261102);
		for (let k = 0; k < 20_000; k++) {
			const c = curve({ a: g.logFloat(1e-3, 1e6), b: g.float(-3, 2), maxShare: g.bool(0.3) ? 1 : g.float(1e-3, 1), m3DayPerUnit: DIVERSION_FLOW_UNIT_M3_DAY[g.pick([...DIVERSION_FLOW_UNITS])] });
			const x = g.bool(0.05) ? 0 : g.logFloat(1e-6, 1e9);
			const basis = g.bool(0.5) ? x : g.logFloat(1e-6, 1e9);
			const s = diversionShareOf(c, basis);
			expect(s >= 0 && s <= c.maxShare, `share ${s}`).toBe(true);
			const w = diversionWant(c, x, basis);
			expect(w >= 0 && w <= x && w <= c.maxShare * x, `want ${w} of ${x}`).toBe(true);
		}
	});

	it('with b ≤ 0 the share never rises with the flow; with b ≥ −1 the volume never falls', () => {
		const g = new Rng(4077);
		for (let k = 0; k < 5_000; k++) {
			const b = g.float(-1, 0);
			const c = curve({ a: g.logFloat(1, 1e5), b, maxShare: g.float(0.05, 1), m3DayPerUnit: DIVERSION_FLOW_UNIT_M3_DAY[g.pick([...DIVERSION_FLOW_UNITS])] });
			const x1 = g.logFloat(1e-3, 1e8);
			const x2 = x1 * g.float(1, 100);
			expect(diversionShareOf(c, x2), `share at ${x2} vs ${x1}`).toBeLessThanOrEqual(diversionShareOf(c, x1) * (1 + 1e-12));
			expect(diversionWant(c, x2, x2), `volume at ${x2} vs ${x1}`).toBeGreaterThanOrEqual(diversionWant(c, x1, x1) * (1 - 1e-12));
		}
	});
});

describe('diversionCurveProblem', () => {
	it('takes a complete curve, the cap and the basis optional', () => {
		expect(diversionCurveProblem(rule())).toBeNull();
		expect(diversionCurveProblem(rule({ diversionMaxPct: null, diversionFlowBasis: null }))).toBeNull();
		expect(diversionCurveProblem(rule({ diversionFlowBasis: 'natural', diversionExponent: 0 }))).toBeNull();
	});

	it('refuses a coefficient that is not above 0, an exponent that is not a number, a cap outside (0, 100 %], an unknown unit or basis', () => {
		for (const a of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(diversionCurveProblem(rule({ diversionCoefficient: a })), String(a)).toMatch(/coefficient a/);
		for (const b of [null, undefined, Number.NaN, Number.NEGATIVE_INFINITY]) expect(diversionCurveProblem(rule({ diversionExponent: b })), String(b)).toMatch(/exponent b/);
		for (const m of [0, -0.1, 1.01, Number.NaN]) expect(diversionCurveProblem(rule({ diversionMaxPct: m })), String(m)).toMatch(/largest share/);
		for (const u of [null, undefined, 'l/s', 'cumecs']) expect(diversionCurveProblem(rule({ diversionFlowUnit: u as DiversionFlowUnit })), String(u)).toMatch(/flow unit must be one of L\/s, m3\/s, m3\/day, Ml\/day/);
		expect(diversionCurveProblem(rule({ diversionFlowBasis: 'observed' as 'natural' }))).toMatch(/modelled, natural/);
	});

	it('runs a complete curve as its plan, and an incomplete one as a rule that takes nothing, with a warning', () => {
		const w: string[] = [];
		const ok = offtakeOf(rule({ diversionFlowUnit: 'Ml/day', diversionFlowBasis: 'natural' }), 0, 1, 'River', 'Canal', w);
		expect(ok.sizing).toBe(2);
		expect(ok.diversion).toEqual({ a: 2000, b: -0.9, maxShare: 0.95, m3DayPerUnit: 1000, natural: true });
		expect(diversionCurveOf(rule({ diversionMaxPct: null })).maxShare).toBe(1);
		expect(w).toEqual([]);
		const bad = offtakeOf(rule({ diversionFlowUnit: null }), 0, 1, 'River', 'Canal', w);
		expect(bad.sizing).toBe(2);
		expect(bad.diversion).toBeNull();
		expect(w).toEqual(['river off-take River → Canal: sized by a diversion curve, but its flow unit must be one of L/s, m3/s, m3/day, Ml/day; it takes nothing']);
		// On any other sizing the curve's fields are inert.
		expect(offtakeOf(rule({ sizing: 'capacity', diversionCoefficient: null }), 0, 1, 'a', 'b', w).diversion).toBeNull();
	});
});
