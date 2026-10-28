// The outlook conditioned on the ENSO and SAM state (issue #620, docs/model.md
// §2.15c): which months are read, the distance, k, the reasons none is drawn,
// that no year's state reads its own season, and that the ESP part of an
// outlook is unchanged when the conditioned one is asked for. Invented index
// values only.
import { describe, expect, it } from 'vitest';
import { runModelWithoutChecks } from '../run';
import type { ScenarioOp } from '../scenario/ops';
import {
	CLIMATE_ANALOGUE_MIN_CANDIDATES,
	CLIMATE_INDEX_MAX_LAG_MONTHS,
	climateAnalogueCount,
	climateConditionedOutlook,
	selectClimateAnalogues,
	type MonthlyIndexSeries
} from './climate';
import { OUTLOOK_MIN_YEARS, runSeasonalOutlook, summariseOutlook, type OutlookMember, type OutlookSummaryInput } from './outlook';
import { outlookAnalogue, resolveSeason, type OutlookSeason } from './season';
import { testCatchment } from './testCatchment';

const SEASON: OutlookSeason = { decisionDate: '2020-10-01', seasonEnd: '2021-04-30' };
const s = resolveSeason(SEASON);
const analoguesOf = (years: number[]) => years.map((wy) => outlookAnalogue(s, wy));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

/** A monthly series from `first` ("YYYY-MM") through `last`, valued by f(year, month 1–12). */
function series(id: 'oni' | 'aao', first: string, last: string, f: (y: number, m: number) => number | null): MonthlyIndexSeries {
	const i0 = Number(first.slice(0, 4)) * 12 + Number(first.slice(5)) - 1;
	const i1 = Number(last.slice(0, 4)) * 12 + Number(last.slice(5)) - 1;
	return { id, firstMonth: first, values: range(i0, i1).map((i) => f(Math.floor(i / 12), (i % 12) + 1)) };
}

/** Invented smooth indices, different every year and month. */
const oniF = (y: number, m: number) => Math.round((1.2 * Math.sin((2 * Math.PI * (y * 12 + m)) / 50) + 0.4 * Math.sin((y * 12 + m) / 7)) * 100) / 100;
const aaoF = (y: number, m: number) => Math.round((Math.sin((2 * Math.PI * (y * 12 + m)) / 9) + 0.6 * Math.cos((y * 12 + m) / 4)) * 1000) / 1000;
const INDICES = [series('oni', '1950-01', '2020-09', oniF), series('aao', '1979-01', '2020-09', aaoF)];

describe('selectClimateAnalogues: the months read', () => {
	it('reads ONI centred two months before the decision month and AAO over the three months before it', () => {
		const sel = selectClimateAnalogues(SEASON, analoguesOf(range(1985, 2019)), INDICES);
		expect(sel.problem).toBeNull();
		expect(sel.indices.map((w) => [w.id, w.from, w.to, w.lagMonths])).toEqual([
			['oni', '2020-08', '2020-08', 0],
			['aao', '2020-07', '2020-09', 0]
		]);
		expect(sel.indices[0]!.value).toBe(oniF(2020, 8));
		expect(sel.indices[1]!.value).toBeCloseTo((aaoF(2020, 7) + aaoF(2020, 8) + aaoF(2020, 9)) / 3, 12);
		// Each year over the same calendar months of its own season start.
		const y2001 = sel.years.find((y) => y.waterYear === 2001)!;
		expect(y2001.values.oni).toBe(oniF(2001, 8));
		expect(y2001.values.aao).toBeCloseTo((aaoF(2001, 7) + aaoF(2001, 8) + aaoF(2001, 9)) / 3, 12);
	});

	it('steps back a month when the copy doesn’t hold the newest, every year alike, at most CLIMATE_INDEX_MAX_LAG_MONTHS', () => {
		const late = [series('oni', '1950-01', '2020-07', oniF), INDICES[1]!];
		const sel = selectClimateAnalogues(SEASON, analoguesOf(range(1985, 2019)), late);
		expect(sel.indices[0]).toMatchObject({ from: '2020-07', to: '2020-07', lagMonths: 1, value: oniF(2020, 7) });
		expect(sel.years.find((y) => y.waterYear === 2001)!.values.oni).toBe(oniF(2001, 7));

		const tooLate = [series('oni', '1950-01', `2020-0${8 - 2 - CLIMATE_INDEX_MAX_LAG_MONTHS}`, oniF), INDICES[1]!];
		const none = selectClimateAnalogues(SEASON, analoguesOf(range(1985, 2019)), tooLate);
		expect(none.problem?.reason).toBe('indexNotHeld');
		expect(none.problem?.message).toBe(
			'The ONI isn’t held for the months before 2020-10-01 (it needs 2020-06 or later; the copy holds it to 2020-04), so no past seasons can be matched to this one.'
		);
		expect(none.years).toEqual([]);
		expect(selectClimateAnalogues(SEASON, analoguesOf(range(1985, 2019)), [INDICES[0]!]).problem?.message).toMatch(/^The AAO isn’t held .*; the copy holds none\)/);
	});

	it('never reads a month of the season itself, nor ONI’s season reaching into it', () => {
		const sel = selectClimateAnalogues(SEASON, analoguesOf(range(1985, 2019)), INDICES);
		// ONI centred on September (ASO) and AAO in October are after the decision date: changing them changes nothing.
		const bump = (x: MonthlyIndexSeries, month: number) => ({ ...x, values: x.values.map((v, i) => (((i + Number(x.firstMonth.slice(5)) - 1) % 12) + 1 === month ? 9 : v)) });
		expect(selectClimateAnalogues(SEASON, analoguesOf(range(1985, 2019)), [bump(INDICES[0]!, 9), bump(INDICES[1]!, 10)])).toEqual(sel);
		// Positive control: August's ONI does.
		expect(selectClimateAnalogues(SEASON, analoguesOf(range(1985, 2019)), [bump(INDICES[0]!, 8), INDICES[1]!])).not.toEqual(sel);
	});
});

describe('selectClimateAnalogues: the distance and k', () => {
	it('ranks by the equally weighted RMS of the standardised differences, ties to the newer year', () => {
		const sel = selectClimateAnalogues(SEASON, analoguesOf(range(1985, 2019)), INDICES);
		const [oni, aao] = sel.indices;
		const sd = (v: number[]) => {
			const m = v.reduce((a, b) => a + b, 0) / v.length;
			return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
		};
		expect(oni!.scale).toBeCloseTo(sd(sel.years.map((y) => y.values.oni)), 12);
		expect(aao!.scale).toBeCloseTo(sd(sel.years.map((y) => y.values.aao)), 12);
		for (const y of sel.years) {
			const d = Math.sqrt((((y.values.oni - oni!.value) / oni!.scale) ** 2 + ((y.values.aao - aao!.value) / aao!.scale) ** 2) / 2);
			expect(y.distance).toBeCloseTo(d, 12);
		}
		for (let i = 1; i < sel.years.length; i++) {
			const [a, b] = [sel.years[i - 1]!, sel.years[i]!];
			expect(a.distance < b.distance || (a.distance === b.distance && a.waterYear > b.waterYear)).toBe(true);
		}
		// Two years with the same state: the newer one ranks first.
		const flat = [series('oni', '1950-01', '2020-09', () => 0.5), series('aao', '1979-01', '2020-09', () => -0.2)];
		const tie = selectClimateAnalogues(SEASON, analoguesOf(range(1985, 2019)), flat);
		expect(tie.years.slice(0, 3).map((y) => [y.waterYear, y.distance])).toEqual([
			[2019, 0],
			[2018, 0],
			[2017, 0]
		]);
	});

	it('keeps a third of the candidates, never fewer than OUTLOOK_MIN_YEARS, and none below CLIMATE_ANALOGUE_MIN_CANDIDATES', () => {
		expect(CLIMATE_ANALOGUE_MIN_CANDIDATES).toBe(2 * OUTLOOK_MIN_YEARS);
		expect([20, 29, 30, 31, 35, 40, 44].map(climateAnalogueCount)).toEqual([10, 10, 10, 10, 12, 13, 15]);
		const sel = selectClimateAnalogues(SEASON, analoguesOf(range(1981, 2019)), INDICES);
		expect(sel.nCandidates).toBe(39);
		expect(sel.k).toBe(13);
		expect(sel.years.filter((y) => y.chosen).map((y) => y.waterYear)).toEqual(sel.years.slice(0, 13).map((y) => y.waterYear));

		const few = selectClimateAnalogues(SEASON, analoguesOf(range(2001, 2019)), INDICES);
		expect(few).toMatchObject({ nCandidates: 19, k: 0, years: [], problem: { reason: 'tooFewYears' } });
		expect(few.problem!.message).toBe('Only 19 past seasons with both indices: at least 20 are needed, or the 10 nearest would be half the record.');
	});

	it('lists the years an index doesn’t reach (AAO from 1979) and leaves them out', () => {
		const sel = selectClimateAnalogues(SEASON, analoguesOf(range(1970, 2019)), INDICES);
		// Water year 1978's season starts October 1978: its AAO months (July–September 1978) are before the AAO's first.
		expect(sel.missing).toEqual(range(1970, 1978));
		expect(sel.nCandidates).toBe(41);
	});
});

describe('climateConditionedOutlook', () => {
	const scale = (f: number): ScenarioOp[] => [{ op: 'demand.scale', factor: f }];
	const input = testCatchment({ start: '1986-10-01', end: '2021-09-30', seed: 7 });
	const base = runModelWithoutChecks(input);
	const levels = [
		{ id: 'f1', label: '100 %', ops: scale(1) },
		{ id: 'f07', label: '70 %', ops: scale(0.7) }
	];
	const plain = runSeasonalOutlook(input, { ...SEASON, baseRun: base, levels });
	const withClimate = runSeasonalOutlook(input, { ...SEASON, baseRun: base, levels, climateIndices: INDICES });

	it('leaves the ESP outlook as it is, to the bit', () => {
		const { climate, ...esp } = withClimate;
		expect(esp).toEqual(plain);
		expect(plain.climate).toBeUndefined();
		expect(climate?.method).toBe('climateState');
	});

	it('summarises the ESP members of the chosen years alone, in the analogues’ order', () => {
		const c = withClimate.climate!;
		expect(c.selection.problem).toBeNull();
		const chosen = new Set(c.selection.years.filter((y) => y.chosen).map((y) => y.waterYear));
		expect(chosen.size).toBe(c.selection.k);
		expect(c.outlook!.nYears).toBe(c.selection.k);
		expect(c.outlook!.analogues.map((a) => a.waterYear)).toEqual(plain.analogues.filter((a) => chosen.has(a.waterYear)).map((a) => a.waterYear));
		for (const [i, l] of c.outlook!.levels.entries()) {
			const esp = plain.levels[i]!;
			// The very members the ESP ran: nothing is run again.
			expect(l.years).toEqual(esp.years.filter((y) => chosen.has(y.waterYear)));
		}
		// The same summary as summarising those members directly.
		const x: OutlookSummaryInput = {
			season: SEASON,
			model: input.model,
			analogues: plain.analogues.filter((a) => chosen.has(a.waterYear)),
			excluded: plain.excluded,
			levels: plain.levels.map((l) => ({ id: l.id, label: l.label, problems: l.problems, members: l.years.filter((y) => chosen.has(y.waterYear)) as OutlookMember[] })),
			startStorageM3: plain.startStorageM3
		};
		const direct = summariseOutlook(x);
		expect(c.outlook!.levels.map((l) => [l.seasonEndStorageM3, l.yearsEwrMet])).toEqual(direct.levels.map((l) => [l.seasonEndStorageM3, l.yearsEwrMet]));
		expect(c.outlook!.planning).toEqual(direct.planning);
	});

	it('draws no outlook when the selection has a problem', () => {
		const short = runSeasonalOutlook(input, { ...SEASON, baseRun: base, levels, climateIndices: [INDICES[0]!] });
		expect(short.climate).toMatchObject({ method: 'climateState', outlook: null, selection: { problem: { reason: 'indexNotHeld' } } });
		const sel = selectClimateAnalogues(SEASON, plain.analogues.slice(0, 5), INDICES);
		expect(climateConditionedOutlook({ season: SEASON, model: input.model, analogues: [], excluded: [], levels: [], startStorageM3: null }, sel).outlook).toBeNull();
	});
});
