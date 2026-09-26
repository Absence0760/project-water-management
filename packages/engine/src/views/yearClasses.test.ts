import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { Rng } from '../random';
import { durationQuantile } from '../reserve/assurance';
import type { ModelOutput } from '../project';
import { classifyRunWaterYears, classifyWaterYears, resolveYearClassMethod, YEAR_CLASS_QUINTILE_MIN_YEARS } from './yearClasses';

// Synthetic natural flow: water year i (from 1 Oct of `firstWy` + i) carries
// `totals[i]` m³, spread evenly over its days.
function naturalSeries(firstWy: number, totals: readonly number[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < totals.length; i++) {
		const from = toEpochDay(`${firstWy + i}-10-01`);
		const to = toEpochDay(`${firstWy + i + 1}-10-01`);
		for (let d = from; d < to; d++) out.push(totals[i]! / (to - from));
	}
	return out;
}
const input = (totals: readonly number[], firstWy = 2000) => ({ startDate: `${firstWy}-10-01`, naturalM3Day: naturalSeries(firstWy, totals) });
const byClass = (r: ReturnType<typeof classifyWaterYears>) => Object.fromEntries(r.classes.map((c) => [c.id, c.waterYears]));

describe('resolveYearClassMethod', () => {
	it('switches auto from terciles to quintiles at 25 complete years', () => {
		expect(YEAR_CLASS_QUINTILE_MIN_YEARS).toBe(25);
		expect(resolveYearClassMethod('auto', 24)).toBe('terciles');
		expect(resolveYearClassMethod('auto', 25)).toBe('quintiles');
		expect(resolveYearClassMethod('terciles', 40)).toBe('terciles');
		expect(resolveYearClassMethod('quintiles', 3)).toBe('quintiles');
	});
});

describe('classifyWaterYears', () => {
	it('uses terciles for 24 years and quintiles for 25 under auto', () => {
		const t24 = classifyWaterYears(input(Array.from({ length: 24 }, (_, i) => (i + 1) * 1e6)));
		expect(t24.requested).toBe('auto');
		expect(t24.method).toBe('terciles');
		expect(t24.classes.map((c) => c.id)).toEqual(['dry', 'normal', 'wet']);
		expect(t24.boundsM3).toHaveLength(2);

		const q25 = classifyWaterYears(input(Array.from({ length: 25 }, (_, i) => (i + 1) * 1e6)));
		expect(q25.method).toBe('quintiles');
		expect(q25.classes.map((c) => c.id)).toEqual(['veryDry', 'dry', 'normal', 'wet', 'veryWet']);
		expect(q25.classes.map((c) => c.waterYears.length)).toEqual([5, 5, 5, 5, 5]);
		// The driest five water years (2000 … 2004) are very dry.
		expect(q25.classes[0]!.waterYears).toEqual([2000, 2001, 2002, 2003, 2004]);
	});

	it('honours an explicit method whatever the record length', () => {
		expect(classifyWaterYears(input([1, 2, 3, 4, 5, 6]), { method: 'quintiles' }).method).toBe('quintiles');
		const r = classifyWaterYears(input(Array.from({ length: 30 }, (_, i) => i + 1)), { method: 'terciles' });
		expect(r.requested).toBe('terciles');
		expect(r.method).toBe('terciles');
	});

	it('refuses an unknown method', () => {
		expect(() => classifyWaterYears(input([1, 2, 3]), { method: 'deciles' as never })).toThrow(RangeError);
	});

	it('prints bounds in m³ from Weibull positions on the annual totals', () => {
		// Nine years 100 … 900 (not in order). Sorted high → low, the bounds
		// sit at ranks (2/3)·10 = 6.67 and (1/3)·10 = 3.33: 333.3 and 666.7.
		const totals = [500, 100, 900, 300, 700, 200, 800, 400, 600];
		const r = classifyWaterYears(input(totals));
		expect(r.boundsM3[0]).toBeCloseTo(1000 / 3, 6);
		expect(r.boundsM3[1]).toBeCloseTo(2000 / 3, 6);
		expect(r.classes[0]).toMatchObject({ id: 'dry', label: 'Dry', lowerM3: null });
		expect(r.classes[0]!.upperM3).toBe(r.boundsM3[0]);
		expect(r.classes[1]!.lowerM3).toBe(r.boundsM3[0]);
		expect(r.classes[1]!.upperM3).toBe(r.boundsM3[1]);
		expect(r.classes[2]!.upperM3).toBeNull();
		const wyOf = (total: number) => 2000 + totals.indexOf(total);
		expect(byClass(r)).toEqual({
			dry: [100, 200, 300].map(wyOf).sort(),
			normal: [400, 500, 600].map(wyOf).sort(),
			wet: [700, 800, 900].map(wyOf).sort()
		});
		expect(r.years.map((y) => y.label)[0]).toBe('2000/01');
		for (const y of r.years) expect(y.naturalM3).toBeCloseTo(totals[y.waterYear - 2000]!, 6);
		expect(r.excluded).toEqual([]);
	});

	it('puts a year exactly on a bound in the drier class', () => {
		// Eight years: ranks (2/3)·9 = 6 and (1/3)·9 = 3 are whole, so the
		// bounds are the 300 and 600 years' own totals.
		const r = classifyWaterYears(input([100, 200, 300, 400, 500, 600, 700, 800]));
		const y300 = r.years.find((y) => y.waterYear === 2002)!;
		const y600 = r.years.find((y) => y.waterYear === 2005)!;
		expect(r.boundsM3).toEqual([y300.naturalM3, y600.naturalM3]);
		expect(y300.classId).toBe('dry');
		expect(y600.classId).toBe('normal');
		expect(r.classes.map((c) => c.waterYears.length)).toEqual([3, 3, 2]);
	});

	it("matches the Reserve's Weibull duration quantile, held at the ends", () => {
		const rng = new Rng(53);
		for (let trial = 0; trial < 50; trial++) {
			const n = 1 + Math.floor(rng.next() * 40);
			const totals = Array.from({ length: n }, () => Math.round(rng.next() * 1e7));
			const r = classifyWaterYears(input(totals));
			const k = r.classes.length;
			const values = r.years.map((y) => y.naturalM3);
			r.boundsM3.forEach((b, j) => expect(b).toBeCloseTo(durationQuantile(values, 100 * (1 - (j + 1) / k))!, 3));
			for (let j = 1; j < r.boundsM3.length; j++) expect(r.boundsM3[j]!).toBeGreaterThanOrEqual(r.boundsM3[j - 1]!);
		}
		// Two years: both tercile ranks fall outside 1 … n, so the bounds hold at the ends.
		const two = classifyWaterYears(input([100, 200]));
		expect(two.boundsM3).toEqual([two.years[0]!.naturalM3, two.years[1]!.naturalM3]);
		expect(byClass(two)).toEqual({ dry: [2000], normal: [2001], wet: [] });
	});

	it('keeps equal annual totals in one class', () => {
		const r = classifyWaterYears(input([500, 500, 500, 500, 100, 900]));
		const classes = new Set(r.years.filter((y) => y.naturalM3 === r.years[0]!.naturalM3).map((y) => y.classId));
		expect(classes.size).toBe(1);
	});

	it('leaves out part water years at either end and years with a missing day', () => {
		// 15 June 2000 … 20 March 2005: complete water years 2000 … 2003;
		// 1999/00 and 2004/05 are part years. A NaN day in 2002 excludes it.
		const start = '2000-06-15';
		const days = toEpochDay('2005-03-20') - toEpochDay(start) + 1;
		const q = Array.from({ length: days }, (_, t) => 1000 + (toEpochDay(start) + t) % 7);
		q[toEpochDay('2003-01-10') - toEpochDay(start)] = Number.NaN;
		const r = classifyWaterYears({ startDate: start, naturalM3Day: q });
		expect(r.years.map((y) => y.waterYear)).toEqual([2000, 2001, 2003]);
		expect(r.excluded).toEqual([
			{ waterYear: 1999, label: '1999/00', reason: 'partial' },
			{ waterYear: 2002, label: '2002/03', reason: 'missingDays' },
			{ waterYear: 2004, label: '2004/05', reason: 'partial' }
		]);
		for (const y of r.years) expect(y.days).toBe(toEpochDay(`${y.waterYear + 1}-10-01`) - toEpochDay(`${y.waterYear}-10-01`));
	});

	it('finds the same water years under a skewed TZ', () => {
		const tz = process.env.TZ;
		const q = input([3, 1, 2], 2000);
		const utc = classifyWaterYears(q);
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone;
				expect(classifyWaterYears(q)).toEqual(utc);
			}
		} finally {
			process.env.TZ = tz;
		}
		expect(utc.years.map((y) => y.waterYear)).toEqual([2000, 2001, 2002]);
	});

	it('counts a run ending on 29 September as a part year', () => {
		const q = naturalSeries(2000, [1, 2, 3]).slice(0, -1);
		const r = classifyWaterYears({ startDate: '2000-10-01', naturalM3Day: q });
		expect(r.years.map((y) => y.waterYear)).toEqual([2000, 2001]);
		expect(r.excluded).toEqual([{ waterYear: 2002, label: '2002/03', reason: 'partial' }]);
	});

	it('returns no bounds and empty classes without a complete year', () => {
		const r = classifyWaterYears({ startDate: '2001-01-01', naturalM3Day: new Array(100).fill(5) });
		expect(r.boundsM3).toEqual([]);
		expect(r.years).toEqual([]);
		expect(r.classes.every((c) => c.waterYears.length === 0 && c.lowerM3 === null && c.upperM3 === null)).toBe(true);
		expect(r.excluded).toEqual([{ waterYear: 2000, label: '2000/01', reason: 'partial' }]);
		expect(classifyWaterYears({ startDate: '2001-01-01', naturalM3Day: [] }).excluded).toEqual([]);
	});
});

describe('classifyRunWaterYears', () => {
	it("reads the run's outlet natural_flow, not a node's", () => {
		const natural = naturalSeries(2000, [300, 100, 200]);
		const run = {
			startDate: '2000-10-01',
			series: [
				{ nodeId: 'farm-a', key: 'natural_flow', label: '', unit: 'm³/day', values: natural.map(() => 1) },
				{ nodeId: null, key: 'natural_flow', label: 'Natural flow', unit: 'm³/day', values: natural }
			]
		} as Pick<ModelOutput, 'startDate' | 'series'>;
		const r = classifyRunWaterYears(run);
		expect(byClass(r)).toEqual({ dry: [2001], normal: [2002], wet: [2000] });
	});

	it('throws when the run has no natural flow', () => {
		expect(() => classifyRunWaterYears({ startDate: '2000-10-01', series: [] })).toThrow(/natural_flow/);
	});
});
