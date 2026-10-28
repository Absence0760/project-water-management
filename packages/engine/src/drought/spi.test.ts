// The drought badge's statistics against independent reference values (docs/model.md §2.15b, issue #620).
// The references were computed in Python with no shared code: P(a, x) in closed form where one exists and else by Simpson's rule, Φ⁻¹ by
// statistics.NormalDist, and the L-moments from their order-statistic definition (Hosking 1990 eq. 2.4),
// not the probability-weighted moments the engine uses.
import { afterEach, describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from '../calendar';
import { Rng } from '../random';
import type { DailySeries } from '../project';
import {
	accumulate,
	addMonths,
	DROUGHT_CLASS_LABEL,
	droughtBadge,
	droughtClass,
	droughtReference,
	driestIndex,
	gammaFit,
	gammaProbability,
	logLogisticFit,
	logLogisticProbability,
	monthlyTotals,
	standardize,
	standardizedIndex,
	waterBalance
} from './spi';
import { gammaP, lnGamma, normalQuantile, sampleLMoments } from './stats';

describe('special functions', () => {
	it('ln Γ matches known values', () => {
		expect(lnGamma(5)).toBeCloseTo(Math.log(24), 12);
		expect(lnGamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 12);
		expect(lnGamma(0.1)).toBeCloseTo(2.2527126517342055, 12);
		expect(lnGamma(30.5)).toBeCloseTo(72.9534711841694, 9);
	});

	it('P(a, x) is the gamma CDF: closed forms and quadrature references', () => {
		for (const x of [0.01, 0.5, 2, 7, 30]) {
			expect(gammaP(1, x)).toBeCloseTo(1 - Math.exp(-x), 12);
		}
		// P(1/2, x) = erf(√x): erf(1) = 0.8427007929497149.
		expect(gammaP(0.5, 1)).toBeCloseTo(0.8427007929497149, 12);
		// P(5/2, x) = erf(√x) − 2√(x/π) e^−x (1 + 2x/3); P(7, x) = 1 − e^−x Σ_{k<7} x^k/k!.
		expect(gammaP(2.5, 1)).toBeCloseTo(0.15085496391539044, 12);
		expect(gammaP(2.5, 4)).toBeCloseTo(0.8437643724222776, 12);
		expect(gammaP(7, 12)).toBeCloseTo(0.9541776931113489, 12);
		// Simpson's rule, 400 000 intervals.
		expect(gammaP(7.3, 3.1)).toBeCloseTo(0.02904649595633875, 10);
		expect(gammaP(7.3, 12)).toBeCloseTo(0.9432037319951061, 10);
		expect(gammaP(3, 0)).toBe(0);
		expect(gammaP(0, 1)).toBeNaN();
	});

	it('Φ⁻¹ matches statistics.NormalDist', () => {
		expect(normalQuantile(0.5)).toBe(0);
		expect(normalQuantile(0.975)).toBeCloseTo(1.9599639845400536, 12);
		expect(normalQuantile(0.001)).toBeCloseTo(-3.090232306167813, 12);
		expect(normalQuantile(0.3)).toBeCloseTo(-0.5244005127080407, 12);
		expect(normalQuantile(1e-10)).toBeCloseTo(-6.361340902404056, 10);
		expect(normalQuantile(0)).toBe(-Infinity);
		expect(normalQuantile(1)).toBe(Infinity);
		expect(normalQuantile(1.2)).toBeNaN();
	});
});

/** 30 three-month rain totals (mm), two of them zero. */
const SPI_SAMPLE = [
	112.4, 85.0, 0.0, 143.9, 67.2, 98.5, 201.3, 55.1, 120.0, 77.7, 133.3, 91.4, 0.0, 160.2, 48.9, 105.6, 88.8, 174.5, 62.3, 115.0, 99.9, 140.1, 70.4,
	83.6, 127.8, 58.0, 190.7, 102.2, 79.5, 111.1
];
/** 30 three-month climatic water balances P − PET (mm). */
const SPEI_SAMPLE = [
	-120.5, -80.2, -45.0, 10.3, -150.8, -95.1, -60.6, 25.4, -110.0, -70.7, -30.3, -200.2, -88.8, -55.5, 5.5, -130.1, -99.9, -40.4, -75.0, -160.6,
	-20.2, -115.5, -65.3, 35.7, -140.4, -85.8, -50.0, -105.2, -10.1, -90.9
];

describe('SPI: the gamma mixed with zeros', () => {
	it('fits Thom’s maximum-likelihood approximation over the non-zero totals', () => {
		const fit = gammaFit(SPI_SAMPLE)!;
		expect(fit.n).toBe(30);
		expect(fit.zeros).toBe(2);
		expect(fit.alpha).toBeCloseTo(7.6443777557324255, 10);
		expect(fit.beta).toBeCloseTo(14.036459660766639, 9);
	});

	it('gives the reference SPI values, a zero total at the centre of the zeros’ mass', () => {
		const fit = gammaFit(SPI_SAMPLE)!;
		const spi = (x: number) => standardize(gammaProbability(x, fit));
		expect(spi(30)).toBeCloseTo(-1.4980588349220874, 9);
		expect(spi(100)).toBeCloseTo(0.014550401422077322, 9);
		expect(spi(250)).toBeCloseTo(2.8529442128397027, 9);
		expect(spi(0)).toBeCloseTo(-1.6606976105540416, 10);
	});

	it('refuses a sample too short, too often dry or with no spread', () => {
		expect(gammaFit(SPI_SAMPLE.slice(0, 19))).toBeNull();
		expect(gammaFit([...new Array(15).fill(0), ...SPI_SAMPLE.slice(0, 9).map((v) => v + 1)])).toBeNull();
		expect(gammaFit(new Array(25).fill(50))).toBeNull();
	});
});

describe('SPEI: the log-logistic by L-moments', () => {
	it('computes the L-moments the order-statistic definition gives', () => {
		const lm = sampleLMoments(SPEI_SAMPLE)!;
		expect(lm.l1).toBeCloseTo(-74.00666666666666, 10);
		expect(lm.l2).toBeCloseTo(32.45103448275862, 10);
		expect(lm.t3).toBeCloseTo(0.02292755840807018, 12);
	});

	it('fits Hosking’s generalised logistic and gives the reference SPEI values', () => {
		const fit = logLogisticFit(SPEI_SAMPLE)!;
		expect(fit.xi).toBeCloseTo(-75.23021798338256, 9);
		expect(fit.alpha).toBeCloseTo(32.42298143847935, 9);
		expect(fit.k).toBeCloseTo(-0.02292755840807018, 12);
		const spei = (x: number) => standardize(logLogisticProbability(x, fit));
		expect(spei(-180)).toBeCloseTo(-1.8295747157845061, 9);
		expect(spei(-70)).toBeCloseTo(0.10085415166818701, 9);
		expect(spei(20)).toBeCloseTo(1.5975398121196591, 9);
	});

	it('is 0 or 1 past the distribution’s bound, so the index clamps at ±3', () => {
		const lower = { xi: 0, alpha: 10, k: -0.2, n: 30 }; // bounded below at ξ + α/k = −50
		expect(logLogisticProbability(-60, lower)).toBe(0);
		expect(standardize(logLogisticProbability(-60, lower))).toBe(-3);
		const upper = { xi: 0, alpha: 10, k: 0.2, n: 30 }; // bounded above at 50
		expect(standardize(logLogisticProbability(60, upper))).toBe(3);
	});
});

const day = (start: string, i: number) => fromEpochDay(toEpochDay(start) + i);

describe('monthly totals', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});

	it('keeps whole months only and leaves a month with a missing day without a total, whatever the time zone (rule 7)', () => {
		// 15 Jan 2001 to 10 Apr 2001, 1 mm a day; 20 Feb missing.
		const start = '2001-01-15';
		const n = toEpochDay('2001-04-10') - toEpochDay(start) + 1;
		const s: DailySeries = { startDate: start, values: Array.from({ length: n }, (_, i) => (day(start, i) === '2001-02-20' ? null : 1)) };
		for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
			process.env.TZ = zone;
			expect(monthlyTotals(s)).toEqual({ firstMonth: '2001-02', values: [null, 31] });
		}
	});

	it('stops at the last whole month up to lastDay', () => {
		const s: DailySeries = { startDate: '2001-01-01', values: new Array(365).fill(2) };
		expect(monthlyTotals(s, '2001-03-31')).toEqual({ firstMonth: '2001-01', values: [62, 56, 62] });
		expect(monthlyTotals(s, '2001-03-30')).toEqual({ firstMonth: '2001-01', values: [62, 56] });
		expect(monthlyTotals(s, '2000-12-31')).toBeNull();
		expect(monthlyTotals({ startDate: '2001-01-02', values: new Array(20).fill(1) })).toBeNull();
	});

	it('accumulates over k months and P − PET month by month', () => {
		const m = { firstMonth: '2001-01', values: [1, 2, null, 4, 5, 6] };
		expect(accumulate(m, 2).values).toEqual([null, 3, null, null, 9, 11]);
		expect(waterBalance(m, { firstMonth: '2001-02', values: [1, 1, 1, 1, 1] }).values).toEqual([null, 1, null, 3, 4, 5]);
		expect(addMonths('2001-11', 3)).toBe('2002-02');
		expect(addMonths('2001-01', -1)).toBe('2000-12');
	});
});

/** A daily series of `years` whole years from 1 Jan `from`, seasonal rain with random monthly wetness. */
function synthetic(from: number, years: number, seed = 7) {
	const rng = new Rng(seed);
	const start = `${from}-01-01`;
	const n = toEpochDay(`${from + years}-01-01`) - toEpochDay(start);
	const rain: number[] = [];
	const pet: number[] = [];
	let month = -1;
	let wet = 1;
	for (let i = 0; i < n; i++) {
		const d = day(start, i);
		const m = Number(d.slice(5, 7));
		if (m !== month) {
			month = m;
			wet = Math.exp(0.5 * rng.normal());
		}
		const season = 1 + 0.8 * Math.cos(((m - 1) / 12) * 2 * Math.PI);
		rain.push(rng.bool(0.3) ? 6 * season * wet * rng.float(0.2, 1.8) : 0);
		pet.push(4 + 2 * Math.cos(((m - 1) / 12) * 2 * Math.PI) + rng.float(-0.5, 0.5));
	}
	return { rain: { startDate: start, values: rain } as DailySeries, pet: { startDate: start, values: pet } as DailySeries };
}

describe('the indices over a record', () => {
	it('uses 1991–2020 when the record covers it, else the whole record', () => {
		const long = monthlyTotals(synthetic(1985, 40).rain)!;
		expect(droughtReference(accumulate(long, 3))).toEqual({ kind: 'standard', from: 1991, to: 2020 });
		const late = monthlyTotals(synthetic(2000, 25).rain)!;
		expect(droughtReference(accumulate(late, 12))).toEqual({ kind: 'record', from: 2000, to: 2024 });
	});

	it('is roughly standard normal over its reference years and rises with the rain', () => {
		const m = monthlyTotals(synthetic(1981, 44).rain)!;
		const s = standardizedIndex(m, 3, 'spi');
		expect(s.reference?.kind).toBe('standard');
		expect(s.reference?.minYears).toBe(30);
		const ref = s.values.filter((v, i): v is number => v !== null && Number(addMonths(m.firstMonth, i).slice(0, 4)) >= 1991 && Number(addMonths(m.firstMonth, i).slice(0, 4)) <= 2020);
		const mean = ref.reduce((a, v) => a + v, 0) / ref.length;
		const sd = Math.sqrt(ref.reduce((a, v) => a + (v - mean) ** 2, 0) / ref.length);
		expect(Math.abs(mean)).toBeLessThan(0.05);
		expect(Math.abs(sd - 1)).toBeLessThan(0.08);
		// Within one calendar month, a wetter accumulation never has a lower index.
		const acc = accumulate(m, 3).values;
		const jan = s.values.flatMap((v, i) => (v !== null && i % 12 === 0 ? [[acc[i]!, v] as const] : [])).sort((a, b) => a[0] - b[0]);
		for (let i = 1; i < jan.length; i++) expect(jan[i]![1]).toBeGreaterThanOrEqual(jan[i - 1]![1]);
	});
});

describe('the drought badge', () => {
	it('reads the last whole month of history, ignores the forecast days after it and shows a dry spell as dry', () => {
		const { rain, pet } = synthetic(1981, 44);
		// The last three months of history (Aug–Oct 2024) bone dry; November is forecast and very wet.
		const values = rain.values.map((v, i) => {
			const d = day(rain.startDate, i);
			if (d >= '2024-08-01' && d <= '2024-10-31') return 0;
			if (d >= '2024-11-01') return 50;
			return v;
		});
		const badge = droughtBadge({ rain: { ...rain, values }, pet, lastDay: '2024-11-12' });
		expect(badge.month).toBe('2024-10');
		expect(badge.firstMonth).toBe('1981-01');
		expect(badge.indices.map((i) => `${i.kind}-${i.scale}`)).toEqual(['spi-3', 'spi-6', 'spi-12', 'spei-3', 'spei-6', 'spei-12']);
		const spi3 = badge.indices[0]!;
		expect(spi3.value!).toBeLessThan(-1.5);
		expect(spi3.class).toMatch(/dry$/);
		expect(spi3.reference).toMatchObject({ kind: 'standard', from: 1991, to: 2020 });
		expect(badge.indices[3]!.value!).toBeLessThan(-1);
		expect(driestIndex(badge)!.value).toBe(Math.min(...badge.indices.map((i) => i.value!)));
	});

	it('says why an index has no value: no evaporation, a missing month, a record too short', () => {
		const { rain } = synthetic(1981, 44);
		const noPet = droughtBadge({ rain });
		expect(noPet.indices.filter((i) => i.kind === 'spei').map((i) => i.gap)).toEqual(['no-pet', 'no-pet', 'no-pet']);
		expect(noPet.indices[0]!.value).not.toBeNull();

		const holed = rain.values.slice();
		holed[holed.length - 3] = null;
		const missing = droughtBadge({ rain: { ...rain, values: holed } });
		expect(missing.indices.slice(0, 3).map((i) => i.gap)).toEqual(['missing-month', 'missing-month', 'missing-month']);

		const short = droughtBadge({ rain: synthetic(2010, 15).rain });
		expect(short.indices[0]).toMatchObject({ value: null, class: null, gap: 'short-record', reference: null });
		expect(driestIndex(short)).toBeNull();

		expect(droughtBadge({ rain: { startDate: '2001-01-05', values: [1, 2, 3] } })).toEqual({
			month: null,
			firstMonth: null,
			indices: expect.arrayContaining([expect.objectContaining({ value: null, gap: 'missing-month' })])
		});
	});

	it('classes values at the usual ±1, ±1.5 and ±2 boundaries', () => {
		expect([2, 1.99, 1.5, 1, 0.99, -0.99, -1, -1.49, -1.5, -1.99, -2].map(droughtClass)).toEqual([
			'extremely-wet',
			'very-wet',
			'very-wet',
			'moderately-wet',
			'near-normal',
			'near-normal',
			'moderately-dry',
			'moderately-dry',
			'severely-dry',
			'severely-dry',
			'extremely-dry'
		]);
		expect(DROUGHT_CLASS_LABEL['severely-dry']).toBe('Severely dry');
	});
});
