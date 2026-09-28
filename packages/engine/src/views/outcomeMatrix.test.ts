import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import type { EwrAssuranceMonth, EwrAssuranceSite } from '../reserve/assurance';
import { runModel } from '../run';
import { randomInput } from '../testing/fuzz';
import {
	DEFAULT_OUTCOME_RISK_CUTOFFS,
	describeOutcomeCell,
	OUTCOME_MIN_YEARS,
	OUTCOME_RISK_CUTOFFS_PENDING_HYDROLOGIST,
	outcomeMatrix,
	outcomeRisk,
	validateOutcomeCutoffs,
	type OutcomeLevelInput,
	type OutcomeRiskCutoffs
} from './outcomeMatrix';
import { classifyRunWaterYears, classifyWaterYears } from './yearClasses';

// Synthetic record: nine complete water years 2000/01 … 2008/09 with annual
// natural totals 100 … 900 (so terciles: 2000–02 dry, 2003–05 normal,
// 2006–08 wet), from 1 October 2000.
const START = '2000-10-01';
const YEARS = 9;
const wyDays = (wy: number) => toEpochDay(`${wy + 1}-10-01`) - toEpochDay(`${wy}-10-01`);
const classes = (() => {
	const q: number[] = [];
	for (let i = 0; i < YEARS; i++) for (let d = 0; d < wyDays(2000 + i); d++) q.push(((i + 1) * 100) / wyDays(2000 + i));
	return classifyWaterYears({ startDate: START, naturalM3Day: q });
})();

/** A run whose outlet is below the EWR on `below(wy)` days at the start of each water year. */
function ewrRun(below: (wy: number) => number, years = YEARS, start = START): OutcomeLevelInput['run'] {
	const values: number[] = [];
	const wy0 = Number(start.slice(0, 4));
	for (let i = 0; i < years; i++) {
		const wy = wy0 + i;
		for (let d = 0; d < wyDays(wy); d++) values.push(d < below(wy) ? -5 : 0);
	}
	return { startDate: start, series: [{ nodeId: null, key: 'ewr_shortfall', label: '', unit: 'm³/day', values }], summary: {} as never };
}

/** A Reserve site whose months not met per water year are `notMet(wy)`. */
function site(notMet: (wy: number) => number, opts: { nodeId?: string | null; isOutlet?: boolean } = {}): EwrAssuranceSite {
	const months: EwrAssuranceMonth[] = [];
	for (let i = 0; i < YEARS; i++) {
		const wy = 2000 + i;
		for (let m = 0; m < 12; m++) {
			months.push({ year: m < 3 ? wy : wy + 1, month: ((m + 9) % 12) + 1, waterYear: wy, days: 30, natural: 1, percentile: 50, beyond: null, required: 1, actual: 1, met: m >= notMet(wy), deficitM3: 0 });
		}
	}
	return { nodeId: opts.nodeId ?? null, isOutlet: opts.isOutlet ?? true, months } as EwrAssuranceSite;
}
const withReserve = (run: OutcomeLevelInput['run'], ...sites: EwrAssuranceSite[]): OutcomeLevelInput['run'] => ({ ...run, summary: { ewrAssurance: sites } as never });

describe('outcomeMatrix: days below the pragmatic EWR', () => {
	// 100 %: 30 days below in dry years, 5 in normal, 0 in wet; 70 %: 3 in dry, 0 else.
	const full = ewrRun((wy) => (wy <= 2002 ? 30 : wy <= 2005 ? 5 : 0));
	const cut = ewrRun((wy) => (wy <= 2002 ? 3 : 0));
	const m = outcomeMatrix(
		[
			{ id: 'd100', label: '100 %', run: full },
			{ id: 'd70', label: '70 %', run: cut }
		],
		classes
	);

	it('uses days below the EWR without a rule table, one row per level and a column per class', () => {
		expect(m.metric).toBe('daysBelowEwr');
		expect(m.siteNodeId).toBeNull();
		expect(m.method).toBe('terciles');
		expect(m.levels).toEqual([
			{ id: 'd100', label: '100 %' },
			{ id: 'd70', label: '70 %' }
		]);
		expect(m.classes.map((c) => [c.id, c.nYears])).toEqual([
			['dry', 3],
			['normal', 3],
			['wet', 3]
		]);
		expect(m.cells.map((row) => row.map((c) => [c.levelId, c.classId]))).toEqual([
			[['d100', 'dry'], ['d100', 'normal'], ['d100', 'wet']],
			[['d70', 'dry'], ['d70', 'normal'], ['d70', 'wet']]
		]);
		expect(m.warnings).toEqual([]);
	});

	it('pools the share of days below over the class, and counts years met in full', () => {
		const dryDays = [2000, 2001, 2002].reduce((s, wy) => s + wyDays(wy), 0);
		const dry = m.cells[0]![0]!;
		expect(dry.nYears).toBe(3);
		expect(dry.enoughYears).toBe(true);
		expect(dry.value).toBeCloseTo(90 / dryDays, 12);
		expect(dry.years.map((y) => [y.waterYear, y.count, y.units, y.met])).toEqual([
			[2000, 30, wyDays(2000), false],
			[2001, 30, wyDays(2001), false],
			[2002, 30, wyDays(2002), false]
		]);
		expect(dry.yearsMet).toBe(0);
		expect(m.cells[0]![2]).toMatchObject({ value: 0, yearsMet: 3, risk: 'lower' });
		expect(m.cells[1]![0]!.value).toBeCloseTo(9 / dryDays, 12);
	});

	it('labels cells by the default cut-offs and marks them as defaults', () => {
		expect(m.cutoffsAreDefault).toBe(true);
		expect(m.cutoffs).toEqual(DEFAULT_OUTCOME_RISK_CUTOFFS);
		// 30 of ~365 days = 8.2 % → increasing (above 5 %, at most 20 %); 5 days = 1.4 % → lower.
		expect(m.cells[0]!.map((c) => c.risk)).toEqual(['increasing', 'lower', 'lower']);
		expect(m.cells[1]!.map((c) => c.risk)).toEqual(['lower', 'lower', 'lower']);
	});

	it('takes cut-offs as a parameter', () => {
		const strict: OutcomeRiskCutoffs = { reserveMonthsMet: { lower: 1, increasing: 0.5 }, daysBelowEwr: { lower: 0, increasing: 0.02 } };
		const s = outcomeMatrix([{ id: 'd100', label: '100 %', run: full }], classes, { cutoffs: strict });
		expect(s.cutoffsAreDefault).toBe(false);
		expect(s.cells[0]!.map((c) => c.risk)).toEqual(['high', 'increasing', 'lower']);
	});

	it('only counts classed water years: a part year in the run is left out', () => {
		// Starts 1 April 2000: 2000/01 … 2008/09 are complete, 1999/00 is a part year.
		const values = [...new Array(toEpochDay(START) - toEpochDay('2000-04-01')).fill(-1), ...ewrRun(() => 0).series[0]!.values];
		const run = { startDate: '2000-04-01', series: [{ nodeId: null, key: 'ewr_shortfall', label: '', unit: 'm³/day', values }], summary: {} as never };
		const r = outcomeMatrix([{ id: 'a', label: 'A', run }], classes);
		expect(r.cells[0]!.map((c) => c.value)).toEqual([0, 0, 0]);
		expect(r.cells[0]!.flatMap((c) => c.years.map((y) => y.waterYear))).not.toContain(1999);
	});
});

describe('outcomeMatrix: fewer than three years', () => {
	it('flags a cell with too few years, with no value and no risk', () => {
		expect(OUTCOME_MIN_YEARS).toBe(3);
		// The run covers only 2000/01 … 2004/05: dry 3 years, normal 2, wet 0.
		const run = ewrRun(() => 100, 5);
		const m = outcomeMatrix([{ id: 'a', label: '100 %', run }], classes);
		const [dry, normal, wet] = m.cells[0]!;
		expect(dry).toMatchObject({ nYears: 3, enoughYears: true, risk: 'high' });
		expect(normal).toMatchObject({ nYears: 2, enoughYears: false, value: null, risk: null });
		expect(normal!.years).toHaveLength(2);
		expect(wet).toMatchObject({ nYears: 0, enoughYears: false, value: null, risk: null, yearsMet: 0 });
		expect(m.warnings).toEqual(['100 %: its run does not cover 4 classed water year(s); those cells count the years it does.']);
	});
});

describe('outcomeMatrix: Reserve months met', () => {
	const base = ewrRun(() => 0);
	it('uses the rule table when every level has one at the site', () => {
		// 100 %: dry years miss 3 months, normal 1 in 2003 only, wet none.
		const m = outcomeMatrix(
			[
				{ id: 'd100', label: '100 %', run: withReserve(base, site((wy) => (wy <= 2002 ? 3 : wy === 2003 ? 1 : 0))) },
				{ id: 'd70', label: '70 %', run: withReserve(base, site(() => 0)) }
			],
			classes
		);
		expect(m.metric).toBe('reserveMonthsMet');
		expect(m.siteNodeId).toBeNull();
		const [dry, normal, wet] = m.cells[0]!;
		expect(dry).toMatchObject({ nYears: 3, value: 27 / 36, yearsMet: 0, risk: 'increasing' });
		expect(dry!.years.map((y) => [y.count, y.units])).toEqual([
			[9, 12],
			[9, 12],
			[9, 12]
		]);
		expect(normal).toMatchObject({ value: 35 / 36, yearsMet: 2, risk: 'lower' });
		expect(wet).toMatchObject({ value: 1, yearsMet: 3, risk: 'lower' });
		expect(m.cells[1]!.every((c) => c.value === 1 && c.risk === 'lower')).toBe(true);
	});

	it('reads the named gauge rather than the outlet', () => {
		const run = withReserve(base, site(() => 0), site(() => 12, { nodeId: 'gauge-1', isOutlet: false }));
		const m = outcomeMatrix([{ id: 'a', label: 'A', run }], classes, { siteNodeId: 'gauge-1' });
		expect(m.siteNodeId).toBe('gauge-1');
		expect(m.cells[0]!.map((c) => [c.value, c.risk])).toEqual([
			[0, 'high'],
			[0, 'high'],
			[0, 'high']
		]);
	});

	it('falls back to days below the EWR for every level when only some have the table, and says so', () => {
		const m = outcomeMatrix(
			[
				{ id: 'a', label: 'A', run: withReserve(base, site(() => 0)) },
				{ id: 'b', label: 'B', run: base }
			],
			classes
		);
		expect(m.metric).toBe('daysBelowEwr');
		expect(m.warnings[0]).toMatch(/Only some demand levels have a Reserve rule table/);
	});

	it('honours a forced metric, and refuses reserveMonthsMet without a table', () => {
		const run = withReserve(base, site(() => 0));
		expect(outcomeMatrix([{ id: 'a', label: 'A', run }], classes, { metric: 'daysBelowEwr' }).metric).toBe('daysBelowEwr');
		expect(() => outcomeMatrix([{ id: 'b', label: 'B', run: base }], classes, { metric: 'reserveMonthsMet' })).toThrow(/no Reserve rule table.*b/);
	});

	it('refuses duplicate level ids and a run without the EWR series', () => {
		expect(() => outcomeMatrix([{ id: 'a', label: 'A', run: base }, { id: 'a', label: 'A2', run: base }], classes)).toThrow(/duplicate/);
		expect(() => outcomeMatrix([{ id: 'x', label: 'X', run: { startDate: START, series: [], summary: {} as never } }], classes)).toThrow(/ewr_shortfall/);
	});
});

describe('outcomeRisk', () => {
	const c = DEFAULT_OUTCOME_RISK_CUTOFFS;
	it('defaults are placeholders pending the hydrologist', () => {
		expect(OUTCOME_RISK_CUTOFFS_PENDING_HYDROLOGIST).toBe(true);
		expect(Object.isFrozen(c)).toBe(true);
	});

	it('reserveMonthsMet: lower at or above `lower`, increasing at or above `increasing`, else high', () => {
		// lower: positive at the cut-off, negative just below it
		expect(outcomeRisk('reserveMonthsMet', c.reserveMonthsMet.lower)).toBe('lower');
		expect(outcomeRisk('reserveMonthsMet', 1)).toBe('lower');
		expect(outcomeRisk('reserveMonthsMet', c.reserveMonthsMet.lower - 1e-9)).not.toBe('lower');
		// increasing
		expect(outcomeRisk('reserveMonthsMet', c.reserveMonthsMet.lower - 1e-9)).toBe('increasing');
		expect(outcomeRisk('reserveMonthsMet', c.reserveMonthsMet.increasing)).toBe('increasing');
		expect(outcomeRisk('reserveMonthsMet', c.reserveMonthsMet.increasing - 1e-9)).not.toBe('increasing');
		// high
		expect(outcomeRisk('reserveMonthsMet', c.reserveMonthsMet.increasing - 1e-9)).toBe('high');
		expect(outcomeRisk('reserveMonthsMet', 0)).toBe('high');
		expect(outcomeRisk('reserveMonthsMet', c.reserveMonthsMet.increasing)).not.toBe('high');
	});

	it('daysBelowEwr: lower at or below `lower`, increasing at or below `increasing`, else high', () => {
		expect(outcomeRisk('daysBelowEwr', 0)).toBe('lower');
		expect(outcomeRisk('daysBelowEwr', c.daysBelowEwr.lower)).toBe('lower');
		expect(outcomeRisk('daysBelowEwr', c.daysBelowEwr.lower + 1e-9)).not.toBe('lower');
		expect(outcomeRisk('daysBelowEwr', c.daysBelowEwr.lower + 1e-9)).toBe('increasing');
		expect(outcomeRisk('daysBelowEwr', c.daysBelowEwr.increasing)).toBe('increasing');
		expect(outcomeRisk('daysBelowEwr', c.daysBelowEwr.increasing + 1e-9)).not.toBe('increasing');
		expect(outcomeRisk('daysBelowEwr', c.daysBelowEwr.increasing + 1e-9)).toBe('high');
		expect(outcomeRisk('daysBelowEwr', 1)).toBe('high');
		expect(outcomeRisk('daysBelowEwr', c.daysBelowEwr.increasing)).not.toBe('high');
	});

	it('validates cut-offs: shares, in the right order', () => {
		expect(() => validateOutcomeCutoffs(DEFAULT_OUTCOME_RISK_CUTOFFS)).not.toThrow();
		const bad: OutcomeRiskCutoffs[] = [
			{ ...c, reserveMonthsMet: { lower: 0.5, increasing: 0.8 } },
			{ ...c, daysBelowEwr: { lower: 0.3, increasing: 0.1 } },
			{ ...c, daysBelowEwr: { lower: -0.1, increasing: 0.1 } },
			{ ...c, reserveMonthsMet: { lower: 1.2, increasing: 0.5 } },
			{ ...c, reserveMonthsMet: { lower: Number.NaN, increasing: 0.5 } }
		];
		for (const b of bad) {
			expect(() => validateOutcomeCutoffs(b)).toThrow(RangeError);
			expect(() => outcomeMatrix([], classes, { cutoffs: b })).toThrow(RangeError);
		}
	});
});

describe('describeOutcomeCell', () => {
	const cell = (over: Partial<Parameters<typeof describeOutcomeCell>[1]>) => ({
		levelId: 'a',
		classId: 'dry' as const,
		nYears: 9,
		enoughYears: true,
		yearsMet: 7,
		value: 0.94,
		risk: 'lower' as const,
		years: [],
		...over
	});

	it('counts years, never "likely"', () => {
		const texts = [
			describeOutcomeCell('reserveMonthsMet', cell({}), 'Dry'),
			describeOutcomeCell('daysBelowEwr', cell({ yearsMet: 1, value: 0.12 }), 'Very dry'),
			describeOutcomeCell('daysBelowEwr', cell({ nYears: 2, enoughYears: false, value: null, risk: null }), 'Wet'),
			describeOutcomeCell('daysBelowEwr', cell({ nYears: 1, enoughYears: false, value: null, risk: null }), 'Wet'),
			describeOutcomeCell('reserveMonthsMet', cell({ nYears: 0, enoughYears: false, value: null, risk: null, yearsMet: 0 }), 'Normal')
		];
		expect(texts).toEqual([
			'Reserve met in every month in 7 of 9 dry years (94 % of months met).',
			'EWR met on every day in 1 of 9 very dry years (below it on 12 % of days).',
			'Only 2 wet years in the record: not enough years to judge.',
			'Only 1 wet year in the record: not enough years to judge.',
			'No normal years in the record: not enough years to judge.'
		]);
		for (const t of texts) expect(t).not.toMatch(/likely|probab|chance/i);
	});
});

describe('outcomeMatrix on real runs', () => {
	it('accounts for every day below the EWR, and every Reserve month, of the classed years', () => {
		let reserveSeen = 0;
		for (const seed of [3, 11, 29, 47, 61, 88]) {
			const run = runModel(randomInput(seed, { maxDays: 3000, maxNodes: 6 }));
			const yc = classifyRunWaterYears(run);
			const classed = new Set(yc.years.map((y) => y.waterYear));
			const m = outcomeMatrix([{ id: 'base', label: 'Base', run }], yc, { metric: 'daysBelowEwr' });
			const cells = m.cells[0]!;
			const short = run.series.find((x) => x.nodeId === null && x.key === 'ewr_shortfall')!.values;
			const d0 = toEpochDay(run.startDate);
			let below = 0;
			let days = 0;
			for (let t = 0; t < short.length; t++) {
				if (!classed.has(waterYearOf(d0 + t))) continue;
				days++;
				if (short[t]! < 0) below++;
			}
			const sum = (f: (y: { units: number; count: number }) => number) => cells.reduce((s, c) => s + c.years.reduce((a, y) => a + f(y), 0), 0);
			expect(sum((y) => y.count)).toBe(below);
			expect(sum((y) => y.units)).toBe(days);
			expect(cells.reduce((s, c) => s + c.nYears, 0)).toBe(yc.years.length);
			for (const c of cells) {
				if (c.value === null) continue;
				expect(c.value).toBeGreaterThanOrEqual(0);
				expect(c.value).toBeLessThanOrEqual(1);
			}

			const outlet = run.summary.ewrAssurance?.find((x) => x.isOutlet);
			if (outlet) {
				reserveSeen++;
				const r = outcomeMatrix([{ id: 'base', label: 'Base', run }], yc);
				expect(r.metric).toBe('reserveMonthsMet');
				const months = outlet.months.filter((x) => classed.has(x.waterYear));
				const rc = r.cells[0]!;
				expect(rc.reduce((s, c) => s + c.years.reduce((a, y) => a + y.units, 0), 0)).toBe(months.length);
				expect(rc.reduce((s, c) => s + c.years.reduce((a, y) => a + y.count, 0), 0)).toBe(months.filter((x) => x.met).length);
			}
		}
		expect(reserveSeen).toBeGreaterThan(0);
	});
});
