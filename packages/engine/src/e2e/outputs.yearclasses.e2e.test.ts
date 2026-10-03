// End-to-end: water-year classes, the outcome matrix and the licence-impact
// board (docs/model.md §2.14, §2.14a) over whole runs of a synthetic
// catchment. The classes are worked by hand from the run's natural_flow:
// complete water years only, Weibull plotting positions on the annual totals
// sorted wettest first, a year on a bound in the drier class, equal totals
// in one class. The matrix's cells are counted by hand from ewr_shortfall
// (days below the EWR) or the Reserve months; the board's waterfall from the
// water account. Synthetic values only.
import { describe, expect, it } from 'vitest';
import { toEpochDay, waterYearOf } from '../calendar';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { testCatchment } from '../outlook/testCatchment';
import { classifyRunWaterYears, classifyWaterYears } from '../views/yearClasses';
import { DEFAULT_OUTCOME_RISK_CUTOFFS, outcomeMatrix, outcomeRisk } from '../views/outcomeMatrix';
import { licenceImpactByYearClass } from '../views/licenceImpact';

function series(out: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string): number[] {
	const s = out.series.find((x) => x.nodeId === nodeId && x.key === key);
	if (!s) throw new Error(`no series ${nodeId}:${key}`);
	return s.values;
}

const wyLen = (wy: number) => toEpochDay(`${wy + 1}-10-01`) - toEpochDay(`${wy}-10-01`);

/** Complete water years of a run and their natural-flow totals, by hand. */
function annualTotals(out: ModelOutput): { complete: Map<number, number>; partial: number[] } {
	const q = series(out, null, 'natural_flow');
	const d0 = toEpochDay(out.startDate);
	const sums = new Map<number, { s: number; n: number }>();
	for (let t = 0; t < out.days; t++) {
		const wy = waterYearOf(d0 + t);
		const v = sums.get(wy) ?? { s: 0, n: 0 };
		v.s += q[t]!;
		v.n++;
		sums.set(wy, v);
	}
	const complete = new Map<number, number>();
	const partial: number[] = [];
	for (const [wy, v] of sums) (v.n === wyLen(wy) ? complete.set(wy, v.s) : partial.push(wy));
	return { complete, partial };
}

/** The value at exceedance rank h (1 = wettest) on totals sorted wettest first: linear between ranks, held at the ends. */
function atRank(desc: number[], h: number): number {
	if (h <= 1) return desc[0]!;
	if (h >= desc.length) return desc.at(-1)!;
	const lo = Math.floor(h);
	return desc[lo - 1]! + (h - lo) * (desc[lo]! - desc[lo - 1]!);
}

function handClasses(totals: Map<number, number>, k: number): { bounds: number[]; classOf: Map<number, number> } {
	const desc = [...totals.values()].sort((a, b) => b - a);
	const n = desc.length;
	const bounds = Array.from({ length: k - 1 }, (_, j0) => atRank(desc, ((k - (j0 + 1)) * (n + 1)) / k));
	const classOf = new Map<number, number>();
	for (const [wy, v] of totals) {
		let j = 0;
		while (j < bounds.length && v > bounds[j]!) j++; // on a bound: the drier class
		classOf.set(wy, j);
	}
	return { bounds, classOf };
}

const withFactor = (input: ModelInput, f: number): ModelInput => ({
	...input,
	model: { ...input.model, nodes: input.model.nodes.map((n) => (n.kind === 'farm' ? { ...n, demandFactor: new Array(12).fill(f) } : n)) }
});

describe('outputs e2e: water-year classes from a run (§2.14)', () => {
	it('8 complete years in terciles: Weibull bounds on ranks 6 and 3, classes 3 / 3 / 2', () => {
		const out = runModel(testCatchment({ start: '2000-10-01', end: '2008-09-30', seed: 31 }));
		const c = classifyRunWaterYears(out);
		const { complete } = annualTotals(out);
		expect(c.method).toBe('terciles');
		expect(c.years.map((y) => y.waterYear)).toEqual([...complete.keys()].sort());
		const h = handClasses(complete, 3);
		const desc = [...complete.values()].sort((a, b) => b - a);
		// (n + 1) a multiple of k: the bounds are years' totals exactly.
		expect(h.bounds).toEqual([desc[5], desc[2]]);
		c.boundsM3.forEach((b, i) => expect(b).toBeCloseTo(h.bounds[i]!, 3));
		for (const y of c.years) {
			expect(y.naturalM3).toBeCloseTo(complete.get(y.waterYear)!, 3);
			expect(['dry', 'normal', 'wet'].indexOf(y.classId), `${y.waterYear}`).toBe(h.classOf.get(y.waterYear));
		}
		expect(c.classes.map((x) => x.waterYears.length)).toEqual([3, 3, 2]);
	});

	it('part years at either end (2 Oct start, 29 Sep end) are excluded as partial and never ranked', () => {
		const out = runModel(testCatchment({ start: '2000-10-02', end: '2008-09-29', seed: 31 }));
		const c = classifyRunWaterYears(out);
		expect(c.excluded).toEqual([
			{ waterYear: 2000, label: '2000/01', reason: 'partial' },
			{ waterYear: 2007, label: '2007/08', reason: 'partial' }
		]);
		expect(c.years.map((y) => y.waterYear)).toEqual([2001, 2002, 2003, 2004, 2005, 2006]);
		const { complete } = annualTotals(out);
		const h = handClasses(complete, 3);
		c.boundsM3.forEach((b, i) => expect(b).toBeCloseTo(h.bounds[i]!, 3));
	});

	it('auto: terciles at 24 complete years, quintiles at 25', () => {
		const out25 = runModel(testCatchment({ start: '1980-10-01', end: '2005-09-30', seed: 2 }));
		const c25 = classifyRunWaterYears(out25);
		expect(c25.years).toHaveLength(25);
		expect(c25.method).toBe('quintiles');
		const h = handClasses(annualTotals(out25).complete, 5);
		c25.boundsM3.forEach((b, i) => expect(b).toBeCloseTo(h.bounds[i]!, 3));
		for (const y of c25.years) expect(['veryDry', 'dry', 'normal', 'wet', 'veryWet'].indexOf(y.classId)).toBe(h.classOf.get(y.waterYear));
		// One day fewer: the last year is part, 24 complete.
		const q = series(out25, null, 'natural_flow');
		const c24 = classifyWaterYears({ startDate: out25.startDate, naturalM3Day: q.slice(0, -1) });
		expect(c24.years).toHaveLength(24);
		expect(c24.method).toBe('terciles');
	});

	it('equal totals share a class, and a total on a bound goes to the drier class (leap years summed over 366 days)', () => {
		// Five complete water years 2003/04 … 2007/08 (2003/04 and 2007/08 have 29 Feb). Daily flows chosen so the
		// annual totals are 10, 20, 20, 30 and 40 thousand m³ exactly.
		const totals = [10_000, 20_000, 20_000, 30_000, 40_000];
		const q: number[] = [];
		for (let i = 0; i < 5; i++) {
			const n = wyLen(2003 + i);
			for (let t = 0; t < n; t++) q.push(t === 0 ? totals[i]! - (n - 1) * 0 : 0);
		}
		const c = classifyWaterYears({ startDate: '2003-10-01', naturalM3Day: q }, { method: 'terciles' });
		// Weibull ranks 4 and 2 on 40, 30, 20, 20, 10: bounds 20 000 and 30 000.
		expect(c.boundsM3).toEqual([20_000, 30_000]);
		expect(c.years.map((y) => y.classId)).toEqual(['dry', 'dry', 'dry', 'normal', 'wet']);
	});

	it('a year with a non-finite day is excluded as missingDays', () => {
		const out = runModel(testCatchment({ start: '2000-10-01', end: '2006-09-30', seed: 31 }));
		const q = [...series(out, null, 'natural_flow')];
		q[toEpochDay('2003-02-01') - toEpochDay(out.startDate)] = Number.NaN;
		const c = classifyWaterYears({ startDate: out.startDate, naturalM3Day: q });
		expect(c.excluded).toEqual([{ waterYear: 2002, label: '2002/03', reason: 'missingDays' }]);
		expect(c.years.map((y) => y.waterYear)).not.toContain(2002);
	});
});

describe('outputs e2e: the outcome matrix over demand levels (§2.14)', () => {
	const base = testCatchment({ start: '2000-10-01', end: '2012-09-30', seed: 8, ewrM3Day: 1_500 });
	const levels = [1, 0.85, 0.7].map((f) => ({ id: `${f * 100}`, label: `${f * 100} %`, run: runModel(withFactor(base, f)) }));
	const classes = classifyRunWaterYears(levels[0]!.run);

	it('days below the EWR: each cell is Σ days with ewr_shortfall < 0 ÷ Σ days over its class’s years, with the risk label from the cut-offs', () => {
		const m = outcomeMatrix(levels, classes);
		expect(m.metric).toBe('daysBelowEwr');
		expect(m.cutoffsAreDefault).toBe(true);
		levels.forEach((l, li) => {
			const sh = series(l.run, null, 'ewr_shortfall');
			const d0 = toEpochDay(l.run.startDate);
			classes.classes.forEach((band, ci) => {
				let days = 0;
				let below = 0;
				let met = 0;
				for (const wy of band.waterYears) {
					const from = toEpochDay(`${wy}-10-01`) - d0;
					let b = 0;
					for (let t = from; t < from + wyLen(wy); t++) if (sh[t]! < 0) b++;
					days += wyLen(wy);
					below += b;
					if (b === 0) met++;
				}
				const cell = m.cells[li]![ci]!;
				expect(cell.nYears).toBe(band.waterYears.length);
				expect(cell.yearsMet).toBe(met);
				if (band.waterYears.length >= 3) {
					expect(cell.value!).toBeCloseTo(below / days, 12);
					const c = DEFAULT_OUTCOME_RISK_CUTOFFS.daysBelowEwr;
					expect(cell.risk).toBe(cell.value! <= c.lower ? 'lower' : cell.value! <= c.increasing ? 'increasing' : 'high');
				} else expect(cell.value).toBeNull();
			});
		});
	});

	it('Reserve months met: with a rule table in every level’s run the matrix counts each classed year’s months, met ÷ assessed', () => {
		const rw = testCatchment({ start: '2000-10-01', end: '2012-09-30', seed: 8, ewrM3Day: 1_500, recordWide: true });
		const lv = [1, 0.7].map((f) => ({ id: `${f}`, label: `${f}`, run: runModel(withFactor(rw, f)) }));
		const cls = classifyRunWaterYears(lv[0]!.run);
		const m = outcomeMatrix(lv, cls);
		expect(m.metric).toBe('reserveMonthsMet');
		lv.forEach((l, li) => {
			const months = l.run.summary.ewrAssurance!.find((s) => s.isOutlet)!.months;
			cls.classes.forEach((band, ci) => {
				const mine = months.filter((x) => band.waterYears.includes(x.waterYear));
				const cell = m.cells[li]![ci]!;
				if (cell.value !== null) expect(cell.value).toBeCloseTo(mine.filter((x) => x.met).length / mine.length, 12);
				// Every Reserve month of a classed year counted exactly once.
				expect(cell.years.reduce((s, y) => s + y.units, 0)).toBe(mine.length);
			});
		});
		// One level without the table: every cell falls back to days below the EWR, with a warning.
		const mixed = outcomeMatrix([lv[0]!, levels[1]!], cls);
		expect(mixed.metric).toBe('daysBelowEwr');
		expect(mixed.warnings.length).toBeGreaterThan(0);
	});

	it('risk labels: a value on a cut-off counts to the lower risk', () => {
		const c = DEFAULT_OUTCOME_RISK_CUTOFFS;
		expect(outcomeRisk('daysBelowEwr', c.daysBelowEwr.lower)).toBe('lower');
		expect(outcomeRisk('daysBelowEwr', c.daysBelowEwr.increasing)).toBe('increasing');
		expect(outcomeRisk('reserveMonthsMet', c.reserveMonthsMet.lower)).toBe('lower');
		expect(outcomeRisk('reserveMonthsMet', c.reserveMonthsMet.increasing)).toBe('increasing');
		expect(outcomeRisk('reserveMonthsMet', 0.749999)).toBe('high');
	});
});

describe('outputs e2e: licence impact by year class (§2.14a)', () => {
	const base = testCatchment({ start: '2000-10-01', end: '2012-09-30', seed: 8, ewrM3Day: 1_500 });
	// The application: Farm B plants a further 300 000 m² of vines.
	const app: ModelInput = { ...base, model: { ...base.model, cropAreas: base.model.cropAreas.map((c) => (c.nodeId === 'b' ? { ...c, areaM2: c.areaM2 + 300_000 } : c)) } };
	const bg = runModel(base);
	const ap = runModel(app);

	it('the waterfall is the class mean of each run’s water account; other closes it and Σ otherParts = other', () => {
		const li = licenceImpactByYearClass({ background: bg, application: ap });
		const rows = (o: ModelOutput) => new Map(o.summary.supplyAssurance!.waterAccount.years.map((r) => [r.waterYear!, r]));
		const b = rows(bg);
		const a = rows(ap);
		for (const c of li.classes) {
			if (!c.waterfall) continue;
			const mean = (f: (wy: number) => number) => c.waterYears.reduce((s, wy) => s + f(wy), 0) / c.waterYears.length;
			const w = c.waterfall;
			expect(w.naturalM3).toBeCloseTo(mean((wy) => b.get(wy)!.naturalFlowM3), 3);
			expect(w.existingUseM3).toBeCloseTo(mean((wy) => b.get(wy)!.consumptiveIrrigationM3 + b.get(wy)!.otherUseM3), 3);
			expect(w.proposedM3).toBeCloseTo(mean((wy) => a.get(wy)!.consumptiveIrrigationM3 - b.get(wy)!.consumptiveIrrigationM3), 3);
			expect(w.leftM3).toBeCloseTo(mean((wy) => a.get(wy)!.outflowM3), 3);
			expect(w.backgroundLeftM3).toBeCloseTo(mean((wy) => b.get(wy)!.outflowM3), 3);
			const parts = Object.values(w.otherParts).reduce((s, v) => s + v, 0);
			expect(Math.abs(parts - w.otherM3)).toBeLessThanOrEqual(1e-9 * w.naturalM3);
			expect(w.proposedM3).toBeGreaterThan(0);
			// Days below the EWR, by hand, and the verdict from them.
			const count = (o: ModelOutput) => {
				const sh = series(o, null, 'ewr_shortfall');
				const d0 = toEpochDay(o.startDate);
				let n = 0;
				for (const wy of c.waterYears) {
					const from = toEpochDay(`${wy}-10-01`) - d0;
					for (let t = from; t < from + wyLen(wy); t++) if (sh[t]! < 0) n++;
				}
				return n;
			};
			expect(c.below).toMatchObject({ background: count(bg), application: count(ap), change: count(ap) - count(bg) });
			const ch = count(ap) - count(bg);
			expect(c.verdict).toBe(ch > 0 ? 'moreBelow' : ch < 0 ? 'fewerBelow' : 'noChange');
		}
	});

	it('a run against itself: no proposed use, no change, the verdict noChange in every class with enough years', () => {
		const li = licenceImpactByYearClass({ background: bg, application: bg });
		for (const c of li.classes) {
			if (!c.enoughYears) {
				expect(c.verdict).toBe('notEnoughYears');
				continue;
			}
			expect(c.waterfall!.proposedM3).toBe(0);
			expect(c.waterfall!.otherParts.naturalDifferenceM3).toBe(0);
			expect(c.below!.change).toBe(0);
			expect(c.verdict).toBe('noChange');
		}
	});
});
