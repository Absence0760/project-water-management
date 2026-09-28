import { describe, expect, it } from 'vitest';
import {
	FAO56_FETCHES,
	FAO56_TABLE5,
	FAO56_WIND_CLASSES,
	fao56Kp,
	fao56KpMonthly,
	fao56RhClass,
	fao56WindClass,
	type WindClass
} from './fao56Table5';

// FAO-56 Table 5 as printed (https://www.fao.org/4/x0490e/x0490e08.htm): one
// line per wind class × fetch row; the first three numbers are Case A (RH low,
// medium, high), the last three Case B. Transcribed separately from the
// module's case-by-case layout, so a slip in either shows up here.
const PRINTED = `
light      1    .55 .65 .75   .7  .8  .85
light      10   .65 .75 .85   .6  .7  .8
light      100  .7  .8  .85   .55 .65 .75
light      1000 .75 .85 .85   .5  .6  .7
moderate   1    .5  .6  .65   .65 .75 .8
moderate   10   .6  .7  .75   .55 .65 .7
moderate   100  .65 .75 .8    .5  .6  .65
moderate   1000 .7  .8  .8    .45 .55 .6
strong     1    .45 .5  .6    .6  .65 .7
strong     10   .55 .6  .65   .5  .55 .65
strong     100  .6  .65 .7    .45 .5  .6
strong     1000 .65 .7  .75   .4  .45 .55
veryStrong 1    .4  .45 .5    .5  .6  .65
veryStrong 10   .45 .55 .6    .45 .5  .55
veryStrong 100  .5  .6  .65   .4  .45 .5
veryStrong 1000 .55 .6  .65   .35 .4  .45
`;

// A representative RH and wind inside each class.
const RH = { low: 25, medium: 55, high: 85 } as const;
const WIND: Record<WindClass, number> = { light: 1, moderate: 3.5, strong: 6.5, veryStrong: 10 };

const cells = PRINTED.trim()
	.split('\n')
	.flatMap((line) => {
		const [wind, fetch, ...v] = line.trim().split(/\s+/);
		const n = v.map(Number);
		return (['low', 'medium', 'high'] as const).flatMap((rh, j) => [
			{ siting: 'A' as const, wind: wind as WindClass, fetchM: Number(fetch), rh, kp: n[j]! },
			{ siting: 'B' as const, wind: wind as WindClass, fetchM: Number(fetch), rh, kp: n[j + 3]! }
		]);
	});

describe('FAO-56 Table 5', () => {
	it('covers every cell: 2 cases × 4 wind × 4 fetch × 3 RH', () => {
		expect(cells).toHaveLength(96);
		for (const s of ['A', 'B'] as const) {
			expect(Object.keys(FAO56_TABLE5[s])).toEqual([...FAO56_WIND_CLASSES]);
			for (const w of FAO56_WIND_CLASSES) {
				expect(FAO56_TABLE5[s][w]).toHaveLength(FAO56_FETCHES.length);
				for (const row of FAO56_TABLE5[s][w]) expect(row).toHaveLength(3);
			}
		}
	});

	it.each(cells)('Case $siting, $wind wind, $fetchM m fetch, RH $rh → $kp', ({ siting, wind, fetchM, rh, kp }) => {
		const r = fao56Kp({ siting, rhPct: RH[rh], windMs: WIND[wind], fetchM });
		expect(r.kp).toBe(kp);
		expect(r.tableKp).toBe(kp);
		expect(r.reductionPct).toBe(0);
		expect(r.cell).toEqual({ siting, rhClass: rh, windClass: wind, fetchM });
		expect(r.note).toContain(`Case ${siting}`);
		expect(r.note).not.toContain('reduced');
	});
});

describe('class boundaries (Table 5 wording)', () => {
	it('RH: "low < 40", "medium 40 - 70", "high > 70" — 40 and 70 are both medium', () => {
		expect(fao56RhClass(0)).toBe('low');
		expect(fao56RhClass(39.99)).toBe('low');
		expect(fao56RhClass(40)).toBe('medium');
		expect(fao56RhClass(70)).toBe('medium');
		expect(fao56RhClass(70.01)).toBe('high');
		expect(fao56RhClass(100)).toBe('high');
	});

	it('wind: "light < 2", "moderate 2-5", "strong 5-8", "very strong > 8" — 2 and 5 are moderate, 8 is strong', () => {
		expect(fao56WindClass(0)).toBe('light');
		expect(fao56WindClass(1.99)).toBe('light');
		expect(fao56WindClass(2)).toBe('moderate');
		expect(fao56WindClass(5)).toBe('moderate');
		expect(fao56WindClass(5.01)).toBe('strong');
		expect(fao56WindClass(8)).toBe('strong');
		expect(fao56WindClass(8.01)).toBe('veryStrong');
	});

	it('the boundary picks that class’s cell', () => {
		// Case A, 10 m: moderate/medium 0.70; light/medium 0.75; strong/high 0.65.
		expect(fao56Kp({ siting: 'A', rhPct: 40, windMs: 2, fetchM: 10 }).kp).toBe(0.7);
		expect(fao56Kp({ siting: 'A', rhPct: 70, windMs: 5, fetchM: 10 }).kp).toBe(0.7);
		expect(fao56Kp({ siting: 'A', rhPct: 70, windMs: 1.9, fetchM: 10 }).kp).toBe(0.75);
		expect(fao56Kp({ siting: 'A', rhPct: 71, windMs: 8, fetchM: 10 }).kp).toBe(0.65);
	});
});

describe('the bare-surroundings reduction', () => {
	it('is applied as the stated percentage and named in the note', () => {
		const r = fao56Kp({ siting: 'B', rhPct: 30, windMs: 6, fetchM: 1000, reductionPct: 20 });
		expect(r.tableKp).toBe(0.4);
		expect(r.kp).toBe(0.32);
		expect(r.reductionPct).toBe(20);
		expect(r.note).toContain('reduced by 20 % to 0.32');
		expect(fao56Kp({ siting: 'A', rhPct: 55, windMs: 3, fetchM: 10, reductionPct: 10 }).kp).toBe(0.63);
		expect(fao56Kp({ siting: 'A', rhPct: 55, windMs: 3, fetchM: 10, reductionPct: 5 }).kp).toBe(0.665);
	});

	it('is never applied unless stated', () => {
		expect(fao56Kp({ siting: 'B', rhPct: 30, windMs: 6, fetchM: 1000 }).kp).toBe(0.4);
		expect(fao56Kp({ siting: 'B', rhPct: 30, windMs: 6, fetchM: 1000, reductionPct: 0 }).kp).toBe(0.4);
	});

	it.each([-1, 20.5, NaN, Infinity])('rejects a reduction of %s', (reductionPct) => {
		expect(() => fao56Kp({ siting: 'A', rhPct: 50, windMs: 3, fetchM: 10, reductionPct })).toThrow(RangeError);
	});
});

describe('input validation', () => {
	it.each([NaN, -0.1, 100.1, Infinity])('rejects RH %s', (rhPct) => {
		expect(() => fao56Kp({ siting: 'A', rhPct, windMs: 3, fetchM: 10 })).toThrow(RangeError);
	});
	it.each([NaN, -0.1, Infinity])('rejects wind %s', (windMs) => {
		expect(() => fao56Kp({ siting: 'A', rhPct: 50, windMs, fetchM: 10 })).toThrow(RangeError);
	});
	it.each([0, 5, 50, 500, 2000, NaN])('rejects a fetch Table 5 does not tabulate (%s m); no interpolation', (fetchM) => {
		expect(() => fao56Kp({ siting: 'A', rhPct: 50, windMs: 3, fetchM })).toThrow(/fetch/);
	});
	it('rejects an unknown siting', () => {
		expect(() => fao56Kp({ siting: 'C' as 'A', rhPct: 50, windMs: 3, fetchM: 10 })).toThrow(RangeError);
	});
});

describe('fao56KpMonthly', () => {
	it('looks up each water-year month (Oct … Sep) from its own RH and wind', () => {
		// A dry, windy summer and a calm, humid winter at one Case A, 10 m site.
		const months = [
			{ rhPct: 55, windMs: 3 }, // Oct: moderate / medium → 0.70
			{ rhPct: 45, windMs: 4 }, // Nov
			{ rhPct: 40, windMs: 4.5 }, // Dec
			{ rhPct: 35, windMs: 4.5 }, // Jan: moderate / low → 0.60
			{ rhPct: 38, windMs: 4 }, // Feb
			{ rhPct: 50, windMs: 3 }, // Mar
			{ rhPct: 60, windMs: 2.5 }, // Apr
			{ rhPct: 72, windMs: 2 }, // May: moderate / high → 0.75
			{ rhPct: 80, windMs: 1.5 }, // Jun: light / high → 0.85
			{ rhPct: 82, windMs: 1.5 }, // Jul
			{ rhPct: 78, windMs: 1.8 }, // Aug
			{ rhPct: 65, windMs: 2.5 } // Sep: moderate / medium → 0.70
		];
		expect(fao56KpMonthly(months, 'A', 10)).toEqual([0.7, 0.7, 0.7, 0.6, 0.6, 0.7, 0.7, 0.75, 0.85, 0.85, 0.85, 0.7]);
		expect(fao56KpMonthly(months, 'A', 10, 10)[8]).toBe(0.765);
	});

	it('needs exactly 12 months and valid inputs in every month', () => {
		expect(() => fao56KpMonthly(Array(11).fill({ rhPct: 50, windMs: 3 }), 'A', 10)).toThrow(/12/);
		const bad = Array.from({ length: 12 }, (_, i) => ({ rhPct: i === 4 ? NaN : 50, windMs: 3 }));
		expect(() => fao56KpMonthly(bad, 'A', 10)).toThrow(RangeError);
	});
});
