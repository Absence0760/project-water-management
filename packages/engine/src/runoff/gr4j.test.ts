// GR4J against hand-worked days (the expected values are the equations of
// issue #4 §2 evaluated step by step, independently of gr4j.ts), its unit
// hydrographs, and the model invariants of testing/runoff.ts.
import { describe, expect, it } from 'vitest';
import { Rng } from '../testing/fuzz';
import { checkDailyBalance, checkEventScale, checkMonotonicity, checkSteadyState, modelRunner, randomForcing, randomParams } from '../testing/runoff';
import { gr4j, sh1, sh2, uhOrdinates } from './gr4j';
import { GR4J_PARAMS, type Gr4jParams } from './params';
import type { DayFluxes } from './types';

const day = (): DayFluxes => ({ qMm: 0, aetMm: 0, exchangeMm: 0 });
const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 12);

describe('GR4J, hand-worked days', () => {
	// X1 = 100, X2 = 0, X3 = 50, X4 = 2; S = 50, R = 25, empty queues.
	const p: Gr4jParams = { x1: 100, x2: 0, x3: 50, x4: 2 };
	const st = gr4j.init(p);
	const out = day();

	it('day 1: 30 mm rain, 5 mm PET', () => {
		expect(st.s).toBe(50);
		expect(st.r).toBe(25);
		gr4j.step(p, st, 30, 5, out);
		// Pn = 25, En = 0; tanh(25/100) = 0.24491866240370913.
		// Ps = 100·(1 − 0.5²)·tanh / (1 + 0.5·tanh) = 16.364868792716077 → S = 66.36486879271608
		// Perc = S·(1 − [1 + (4S/900)⁴]^−¼) = 0.1249837345584617 → S = 66.23988505815763
		close(st.s, 66.23988505815763);
		// Pr = Perc + Pn − Ps = 8.760114941842385
		// UH1 ordinates (X4 = 2): [0.5^2.5, 1 − 0.5^2.5]; today's Q9 = 0.9·Pr·0.1767766952966369 = 1.3937257528538287
		// UH2 ordinates: [0.0883883…, 0.4116117…, 0.4116117…, 0.0883883…]; Q1 = 0.1·Pr·0.08838834764831845 = 0.07742920849187937
		// R = 25 + Q9 = 26.39372575285383; Qr = R·(1 − [1 + (R/50)⁴]^−¼) = 0.4888446727230847 → R = 25.904881080130743
		close(st.r, 25.904881080130743);
		// Q = Qr + Qd = 0.4888446727230847 + 0.07742920849187937
		close(out.qMm, 0.566273881214964);
		// AET = min(P, E) + Es = 5 + 0
		close(out.aetMm, 5);
		expect(out.exchangeMm).toBe(0);
	});

	it('day 2: dry, 4 mm PET, yesterday’s routed water still arriving', () => {
		gr4j.step(p, st, 0, 4, out);
		// En = 4; Es = S·(2 − S/X1)·tanh(0.04) / (1 + (1 − S/X1)·tanh(0.04)) = 3.495040840462376 → S = 62.74484421769525
		// Perc = 0.09450678061029393 → S = 62.65033743708496
		close(st.s, 62.65033743708496);
		// Q9 = 0.9·8.7601…·0.8232233 (day-1 rain, 2nd ordinate) + 0.9·Perc·0.1767767 = 6.505413631527789
		// Q1 = 0.1·8.7601…·0.4116117 + 0.1·Perc·0.0883883 = 0.3614118684182105
		// R = 25.9049 + Q9; Qr = 1.2909117958361926 → R = 31.11938291582234
		close(st.r, 31.11938291582234);
		close(out.qMm, 1.652323664254403);
		// AET = min(0, 4) + Es
		close(out.aetMm, 3.495040840462376);
	});

	it('groundwater export is clipped at an empty direct-flow path and reported as applied', () => {
		// X2 = −2, X3 = 50, X4 = 1; S = 20, R = 40 (fill 0.2 and 0.8 set by hand), 10 mm rain, no PET.
		const q: Gr4jParams = { x1: 100, x2: -2, x3: 50, x4: 1 };
		const s = gr4j.init(q);
		s.s = 20;
		s.r = 40;
		const o = day();
		gr4j.step(q, s, 10, 0, o);
		// F = X2·(40/50)^3.5 = −0.915893443583914. R = max(0, 40 + Q9 + F) = 39.643013330622026.
		// Qr = 3.1668049067730863. Q1 = 0.03105037634477439, so Qd = max(0, Q1 + F) = 0 (clipped).
		close(o.qMm, 3.1668049067730863);
		// Applied exchange = (R − 40 − Q9) + (Qd − Q1) = F − Q1: only what could actually leave.
		close(o.exchangeMm, -0.9469438199286878);
	});
});

describe('GR4J unit hydrographs', () => {
	it('X4 = 2 gives the hand-worked ordinates', () => {
		const o1 = uhOrdinates(sh1, 2, 2);
		expect(Array.from(o1)).toEqual([0.5 ** 2.5, 1 - 0.5 ** 2.5]);
		const o2 = uhOrdinates(sh2, 2, 4);
		close(o2[0]!, 0.08838834764831845);
		close(o2[1]!, 0.41161165235168157);
		close(o2[2]!, 0.4116116523516815);
		close(o2[3]!, 0.08838834764831849);
	});

	it('ordinates are non-negative, sum to 1, and have lengths ⌈X4⌉ and ⌈2·X4⌉ for any X4 in bounds', () => {
		const spec = GR4J_PARAMS.find((s) => s.key === 'x4')!;
		const rng = new Rng(4);
		const x4s = [spec.min, spec.max, 1, 2, 2.5, 3, ...Array.from({ length: 500 }, () => rng.float(spec.min, spec.max))];
		for (const x4 of x4s) {
			const st = gr4j.init({ x1: 100, x2: 0, x3: 50, x4 });
			expect(st.ord1.length, `X4 ${x4}`).toBe(Math.ceil(x4));
			expect(st.ord2.length, `X4 ${x4}`).toBe(Math.ceil(2 * x4));
			for (const ord of [st.ord1, st.ord2]) {
				expect(Math.min(...ord), `X4 ${x4}`).toBeGreaterThanOrEqual(0);
				expect(ord.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14);
			}
		}
	});

	it('S-curves are continuous at X4 and 2·X4', () => {
		for (const x4 of [0.5, 1.7, 4.2]) {
			expect(sh1(x4 - 1e-12, x4)).toBeCloseTo(sh1(x4, x4), 9);
			expect(sh2(x4 + 1e-12, x4)).toBeCloseTo(sh2(x4, x4), 9);
			expect(sh2(2 * x4 - 1e-12, x4)).toBeCloseTo(1, 9);
		}
	});
});

describe('GR4J model invariants (issue #4 §4)', () => {
	const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
	const CASES = Number(env.FUZZ_CASES ?? 400);

	it(`daily and whole-run balance, bounds, monotonicity: ${CASES} random parameter sets and forcings`, () => {
		const failures: string[] = [];
		for (let seed = 1; seed <= CASES && failures.length < 3; seed++) {
			const rng = new Rng(seed);
			const closed = randomParams(rng, GR4J_PARAMS);
			const open = randomParams(rng, GR4J_PARAMS, { freeFixed: true });
			const f = randomForcing(rng, rng.int(1, 1500));
			const fill = rng.pick([0, 0.5, 1, rng.next()]);
			const bad =
				checkDailyBalance(gr4j, closed, f, fill) ??
				checkDailyBalance(gr4j, open, f, fill) ??
				checkMonotonicity(modelRunner(gr4j, closed, fill), f, rng);
			if (bad) failures.push(`seed ${seed} ${JSON.stringify({ closed, open, fill })}: ${bad}`);
		}
		expect(failures.join('\n')).toBe('');
	}, Math.max(60_000, CASES * 100));

	it('event scale: a storm on a dry catchment returns at most its rain, and bigger storms shed a larger share', () => {
		const rng = new Rng(11);
		const sets = [Object.fromEntries(GR4J_PARAMS.map((s) => [s.key, s.default])) as unknown as Gr4jParams, ...Array.from({ length: 200 }, () => randomParams(rng, GR4J_PARAMS))];
		for (const p of sets) {
			for (const pet of [0, 3, 8]) expect(checkEventScale(modelRunner(gr4j, p), pet), JSON.stringify({ p, pet })).toBeNull();
		}
	});

	it('steady state: constant rain above PET converges to Q = P − AET from any starting state', () => {
		const rng = new Rng(12);
		for (let i = 0; i < 40; i++) {
			const p = randomParams(rng, GR4J_PARAMS);
			const [P0, E0] = rng.pick([
				[5, 2],
				[10, 0],
				[0.5, 0.4],
				[3, 2.9]
			] as const);
			expect(checkSteadyState(gr4j, p, P0, E0), JSON.stringify({ p, P0, E0 })).toBeNull();
		}
	});
});
