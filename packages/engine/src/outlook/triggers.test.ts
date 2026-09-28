// Review triggers from the seasonal outlook (issue #53 R6, docs/model.md
// §2.15a), on the invented catchment (./testCatchment.ts) and on hand-made
// members.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, ModelOutput } from '../project';
import { runModelWithoutChecks } from '../run';
import { outlookAnalogue, resolveSeason, type OutlookSeason } from './season';
import { outlookMemberInput, runSeasonalOutlook, type OutlookMember } from './outlook';
import { testCatchment } from './testCatchment';
import {
	bandStartStorage,
	lowestBandFloor,
	defaultReviewDate,
	describeTriggerRow,
	reviewStorageHistory,
	reviewTriggerTable,
	runReviewTriggers,
	storageBands,
	tercileEdges,
	TRIGGER_MIN_HISTORY_YEARS,
	type ReviewStorageSample,
	type ReviewTriggerTableInput
} from './triggers';

const REVIEW = '2013-01-01';
const END = '2013-04-30';
const CAP = 450_000;
const levels = (fs: number[]) => fs.map((f) => ({ id: `f${f}`, label: `${Math.round(f * 100)} %`, ops: [{ op: 'demand.scale' as const, factor: f }] }));
const col = (out: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string) => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values;
const FORBIDDEN = /recommend|likely|should/i;

/**
 * The test catchment with both farms on the trigger supply rule: below a
 * quarter full a farm pumps from the river, so the emptier the dams on the
 * review date the more the river gives the pumps and the less reaches the
 * outlet's EWR (150 m³/day). Synthetic.
 */
function pumpedCatchment(): ModelInput {
	const x = testCatchment({ dailyApan: true, ewrM3Day: 150 });
	return {
		...x,
		model: {
			...x.model,
			nodes: x.model.nodes.map((n) => (n.kind === 'farm' ? { ...n, supplyRule: 'trigger' as const, pumpCapacityM3Day: n.id === 'a' ? 1000 : 600, supplyTriggerPct: 0.25, supplyStopPct: 0.4 } : n))
		}
	};
}

const plain = testCatchment({ dailyApan: true });
const plainBase = runModelWithoutChecks(plain);
const pumped = pumpedCatchment();
const pumpedBase = runModelWithoutChecks(pumped);

describe('the review date', () => {
	it('defaults to the first of the month holding the season’s middle day, pending O3', () => {
		expect(defaultReviewDate({ decisionDate: '2012-10-01', seasonEnd: '2013-04-30' })).toBe('2013-01-01');
		// 15 November – 15 May, middle 14 February 2012: 1 February.
		expect(defaultReviewDate({ decisionDate: '2011-11-15', seasonEnd: '2012-05-15' })).toBe('2012-02-01');
		// A season inside one month: its middle day.
		expect(defaultReviewDate({ decisionDate: '2013-03-01', seasonEnd: '2013-03-21' })).toBe('2013-03-11');
		// Two days: the second.
		expect(defaultReviewDate({ decisionDate: '2013-03-01', seasonEnd: '2013-03-02' })).toBe('2013-03-02');
		expect(() => defaultReviewDate({ decisionDate: '2013-03-01', seasonEnd: '2013-03-01' })).toThrow(/one day/);
	});

	it('is the same under a skewed TZ', () => {
		const seasons: OutlookSeason[] = [
			{ decisionDate: '2012-10-01', seasonEnd: '2013-04-30' },
			{ decisionDate: '2011-11-15', seasonEnd: '2012-05-15' }
		];
		const utc = seasons.map(defaultReviewDate);
		const hist = reviewStorageHistory(plain, plainBase, '2012-02-29');
		const tz = process.env.TZ;
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone;
				expect(seasons.map(defaultReviewDate)).toEqual(utc);
				expect(reviewStorageHistory(plain, plainBase, '2012-02-29')).toEqual(hist);
			}
		} finally {
			process.env.TZ = tz;
		}
	});

	it('must fall after the season’s decision date when that is given', () => {
		expect(() => runReviewTriggers(pumped, { decisionDate: '2013-01-01', reviewDate: '2013-01-01', seasonEnd: END, levels: levels([1]), baseRun: pumpedBase })).toThrow(/not after the season’s decision date|not after the season's decision date/);
		expect(() => runReviewTriggers(pumped, { reviewDate: '2013-05-01', seasonEnd: END, levels: levels([1]), baseRun: pumpedBase })).toThrow(RangeError);
	});
});

describe('storage bands', () => {
	it('reads the base run’s storage at the end of the day before the review date, every year the run holds it', () => {
		const h = reviewStorageHistory(plain, plainBase, REVIEW);
		// The record runs 2000-10-01 … 2013-09-30: 1 January of 2001 … 2013.
		expect(h.map((x) => x.waterYear)).toEqual(Array.from({ length: 13 }, (_, i) => 2000 + i));
		const r0 = toEpochDay(plainBase.startDate);
		for (const x of h) {
			const t = toEpochDay(x.date) - 1 - r0;
			expect(x.storageM3).toBe(col(plainBase, 'a', 'dam_storage')![t]! + col(plainBase, 'b', 'dam_storage')![t]!);
		}
		// 29 February reads 28 February in a common year, as the analogues do.
		expect(reviewStorageHistory(plain, plainBase, '2012-02-29').map((x) => x.date).slice(0, 4)).toEqual(['2001-02-28', '2002-02-28', '2003-02-28', '2004-02-29']);
		expect(reviewStorageHistory({ ...plain, model: { ...plain.model, nodes: plain.model.nodes.map((n) => ({ ...n, damCapacityM3: 0 })) } }, plainBase, REVIEW)).toEqual([]);
	});

	it('default edges are the terciles of that history (type 7); fewer than three years give none', () => {
		const s = (v: number[]): ReviewStorageSample[] => v.map((storageM3, i) => ({ waterYear: 2000 + i, date: `${2001 + i}-01-01`, storageM3 }));
		// Sorted 0, 30, 60, 90: h = 3 × ⅓ = 1 → 30; h = 2 → 60.
		const [lo, hi] = tercileEdges(s([90, 0, 60, 30]));
		expect(lo).toBeCloseTo(30, 9);
		expect(hi).toBeCloseTo(60, 9);
		expect(tercileEdges(s([5, 6]))).toEqual([]);
	});

	it('draws bands over 0 … capacity from sorted inner edges, leaving out and naming edges it cannot use', () => {
		const { bands, warnings } = storageBands([300_000, 100_000, 0, -5, 100_000, CAP + 1, Number.NaN], CAP);
		expect(bands).toEqual([
			{ fromM3: 0, toM3: 100_000 },
			{ fromM3: 100_000, toM3: 300_000 },
			{ fromM3: 300_000, toM3: CAP }
		]);
		expect(warnings).toHaveLength(5);
		expect(warnings.join(' | ')).toMatch(/not above empty.*not above empty.*repeated.*above the dams' capacity.*not a number|not a number/);
		// An edge at the capacity: a top band of full dams only.
		expect(storageBands([CAP], CAP).bands).toEqual([
			{ fromM3: 0, toM3: CAP },
			{ fromM3: CAP, toM3: CAP }
		]);
		expect(storageBands([], CAP).bands).toEqual([{ fromM3: 0, toM3: CAP }]);
	});

	it('starts a band from its lower edge (or middle), shared over the dams pro rata to capacity', () => {
		const at = bandStartStorage(plain, { fromM3: 150_000, toM3: 300_000 });
		expect(at.totalM3).toBe(150_000);
		// Farm A holds 300 000 m³ of the 450 000, Farm B 150 000: each a third full.
		expect(at.storageM3ByDam.a).toBeCloseTo(100_000, 6);
		expect(at.storageM3ByDam.b).toBeCloseTo(50_000, 6);
		const mid = bandStartStorage(plain, { fromM3: 150_000, toM3: 300_000 }, 'midpoint');
		expect(mid.totalM3).toBe(225_000);
		expect(mid.storageM3ByDam.a! / 300_000).toBeCloseTo(mid.storageM3ByDam.b! / 150_000, 12);
		// The bottom band from empty dams; the full band exactly full; a band past either end clamped, so no dam is ever over or under.
		expect(bandStartStorage(plain, { fromM3: 0, toM3: 100 }).storageM3ByDam).toEqual({ a: 0, b: 0 });
		expect(bandStartStorage(plain, { fromM3: CAP, toM3: CAP }).storageM3ByDam).toEqual({ a: 300_000, b: 150_000 });
		expect(bandStartStorage(plain, { fromM3: 2 * CAP, toM3: 3 * CAP }).storageM3ByDam).toEqual({ a: 300_000, b: 150_000 });
		expect(bandStartStorage(plain, { fromM3: -10, toM3: 0 }, 'midpoint').totalM3).toBe(0);
	});
});

describe('the trigger table', () => {
	// Edges at 200 000 and 400 000 m³; demand from 100 % down to 10 %.
	const table = runReviewTriggers(pumped, { reviewDate: REVIEW, seasonEnd: END, levels: levels([1, 0.7, 0.5, 0.3, 0.1]), edgesM3: [200_000, 400_000], baseRun: pumpedBase });
	// The lowest storage the base run had on 1 January (engine ≥ 1.11.0): where the lowest band runs from.
	const driest = Math.min(...reviewStorageHistory(pumped, pumpedBase, REVIEW).map((x) => x.storageM3));

	it('picks, per band, the highest level that meets the planning rule, fullest band first', () => {
		expect(table.nYears).toBe(12);
		expect(table.enoughYears).toBe(true);
		expect(table.metric).toBe('daysBelowEwr');
		expect(table.bandSource).toBe('explicit');
		expect(table.rows.map((r) => [r.band.fromM3, r.band.toM3, r.startStorageM3])).toEqual([
			[400_000, CAP, 400_000],
			[200_000, 400_000, 200_000],
			[0, 200_000, driest]
		]);
		expect(driest).toBeGreaterThan(0);
		expect(driest).toBeLessThan(200_000);
		expect(table.lowestOnRecordM3).toBe(driest);
		expect(table.rows.map((r) => r.startFrom ?? null)).toEqual([null, null, 'lowestOnRecord']);
		expect(table.rows.map((r) => r.level?.id ?? null)).toEqual(['f0.7', 'f0.3', null]);
		for (const r of table.rows) {
			expect(r.nYears).toBe(12);
			expect(r.outlook.decisionDate).toBe(REVIEW);
			expect(r.outlook.startStorageM3).toBe(r.startStorageM3);
			// The row is the band outlook's planning figure.
			expect(r.level?.id ?? null).toBe(r.outlook.planning.levelId);
			expect(r.metYears).toBe(r.outlook.planning.yearsMet);
			expect(r.perLevel.map((l) => l.levelId)).toEqual(['f1', 'f0.7', 'f0.5', 'f0.3', 'f0.1']);
			for (const l of r.perLevel) expect(l.meets).toBe(l.yearsMet >= 0.8 * 12);
			if (r.level) expect(r.perLevel.find((l) => l.meets)!.levelId).toBe(r.level.id);
		}
		expect(table.monotone).toBe(true);
		expect(table.notes).toEqual([]);
	});

	it('reports a band where no level meets the rule, as data', () => {
		const bottom = table.rows[2]!;
		expect(bottom.reason).toBe('noLevelMeets');
		expect(bottom.metYears).toBeNull();
		expect(table.warnings).toContain('From 0 m³: no demand level met the requirement in at least 80 % of the analogue years.');
	});

	it('says each row in counted years, never “recommend”, “likely” or “should”', () => {
		const [top, mid, bottom] = table.rows.map((r) => describeTriggerRow(table, r));
		expect(top).toBe(`At or above 400 000 m³ on 1 January 2013: 70 % met the EWR on every day of the season in ${table.rows[0]!.metYears} of 12 analogue years.`);
		expect(mid).toBe(`At or above 200 000 m³ on 1 January 2013: 30 % met the EWR on every day of the season in ${table.rows[1]!.metYears} of 12 analogue years.`);
		const on = `${String(Math.round(driest)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} m³`;
		expect(bottom!.startsWith(`Below 200 000 m³ on 1 January 2013 (run from the lowest storage on record for the date, ${on}): `)).toBe(true);
		expect(bottom).toMatch(/^Below 200 000 m³ on 1 January 2013 \(run from the lowest storage on record for the date, [\d ]+ m³\): no demand level met the EWR on every day of the season in at least 80 % of the 12 analogue years; the most was \d+ of 12, at \d+ %\.$/);
		for (const s of [top, mid, bottom]) expect(s).not.toMatch(FORBIDDEN);
		const midpoint = { ...table, representative: 'midpoint' as const };
		expect(describeTriggerRow(midpoint, { ...table.rows[1]!, startStorageM3: 300_000 })).toMatch(/^At or above 200 000 m³ on 1 January 2013 \(run from 300 000 m³\): /);
	});

	it('the lowest band runs from the lowest storage on record for the date, else from empty dams (engine ≥ 1.11.0)', () => {
		const sample = (storageM3: number, waterYear: number): ReviewStorageSample => ({ waterYear, date: `${waterYear + 1}-01-01`, storageM3 });
		const hist = [sample(250_000, 2001), sample(90_000, 2002), sample(310_000, 2003)];
		expect(lowestBandFloor(hist, { fromM3: 0, toM3: 200_000 })).toEqual({ floorM3: 90_000, fromRecord: true, warning: null });
		// No year below the band's upper edge: that band never happened on the date, so it keeps empty dams, and says so.
		const above = lowestBandFloor(hist, { fromM3: 0, toM3: 90_000 });
		expect(above).toMatchObject({ floorM3: 0, fromRecord: false });
		expect(above.warning).toBe('No year of the record had less than 90 000 m³ in the dams on the review date, so the lowest band runs from empty dams.');
		expect(lowestBandFloor([], { fromM3: 0, toM3: CAP })).toMatchObject({ floorM3: 0, fromRecord: false, warning: expect.stringMatching(/^No year of the record holds the review date/) });
		// Shared pro rata to capacity like every band.
		const start = bandStartStorage(plain, { fromM3: 90_000, toM3: 200_000 });
		expect(start).toEqual({ totalM3: 90_000, storageM3ByDam: { a: 60_000, b: 30_000 } });
		// An edge at or below the driest year: the lowest band keeps empty dams, and the table says why.
		const t = runReviewTriggers(pumped, { reviewDate: REVIEW, seasonEnd: END, levels: levels([0.3]), edgesM3: [driest], analogueYears: [2004], baseRun: pumpedBase });
		expect(t.rows.at(-1)).toMatchObject({ startStorageM3: 0 });
		expect(t.rows.at(-1)!.startFrom).toBeUndefined();
		expect(t.lowestOnRecordM3).toBeNull();
		expect(t.warnings.some((w) => w.startsWith('No year of the record had less than'))).toBe(true);
		expect(describeTriggerRow(t, t.rows.at(-1)!)).toMatch(/\(run from empty dams\)/);
		// Midpoint: the lowest band's middle is between the driest start and its upper edge.
		const mid = runReviewTriggers(pumped, { reviewDate: REVIEW, seasonEnd: END, levels: levels([0.3]), edgesM3: [200_000], analogueYears: [2004], baseRun: pumpedBase, representative: 'midpoint' });
		expect(mid.rows.at(-1)!.startStorageM3).toBeCloseTo((driest + 200_000) / 2, 6);
	});

	it('with too few analogue years, gives no level for any band and says so', () => {
		const t = runReviewTriggers(pumped, { reviewDate: REVIEW, seasonEnd: END, levels: levels([1, 0.3]), edgesM3: [200_000], analogueYears: [2003, 2004], baseRun: pumpedBase });
		expect(t.enoughYears).toBe(false);
		expect(t.rows.map((r) => [r.level, r.reason])).toEqual([
			[null, 'notEnoughYears'],
			[null, 'notEnoughYears']
		]);
		expect(t.warnings.filter((w) => w.startsWith('Only 2 analogue years'))).toHaveLength(1);
		expect(describeTriggerRow(t, t.rows[0]!)).toBe('At or above 200 000 m³ on 1 January 2013: only 2 analogue years, not enough to judge (at least 10 are needed).');
		expect(t.monotone).toBe(true);
	});

	it('draws tercile bands from the base run’s history on the review date by default', () => {
		const t = runReviewTriggers(pumped, { reviewDate: REVIEW, seasonEnd: END, levels: levels([0.3]), analogueYears: [2004], baseRun: pumpedBase });
		expect(t.bandSource).toBe('historicalTerciles');
		expect(t.history).toEqual(reviewStorageHistory(pumped, pumpedBase, REVIEW));
		const edges = tercileEdges(t.history);
		expect(t.rows.map((r) => r.band.fromM3).reverse()).toEqual([0, ...edges]);
		expect(t.history.length).toBeGreaterThanOrEqual(TRIGGER_MIN_HISTORY_YEARS);
		expect(t.warnings.some((w) => w.includes('tercile'))).toBe(false);
	});

	it('warns when the history is short, and uses one band when it holds fewer than three years', () => {
		const short = { ...pumped, series: { ...pumped.series, rain_catchment_mm: { ...pumped.series.rain_catchment_mm!, values: pumped.series.rain_catchment_mm!.values.slice(0, 365 * 5 + 200) } } };
		const b = runModelWithoutChecks(short);
		const six = runReviewTriggers(short, { reviewDate: '2005-01-01', seasonEnd: '2005-04-30', levels: levels([0.3]), baseRun: b });
		// 1 January 2001 … 2006 (the record ends in April 2006).
		expect(six.history).toHaveLength(6);
		expect(six.warnings).toContain(`The tercile bands come from only 6 years of storage on the review date (at least ${TRIGGER_MIN_HISTORY_YEARS} are needed for them to mean much).`);
		const two = runReviewTriggers(short, { reviewDate: '2002-01-01', seasonEnd: '2002-04-30', levels: levels([0.3]), baseRun: runModelWithoutChecks({ ...short, settings: { ...short.settings, simulationEnd: '2002-06-30' } }) });
		expect(two.bandSource).toBe('wholeRange');
		expect(two.rows.map((r) => r.band)).toEqual([{ fromM3: 0, toM3: CAP }]);
		expect(two.warnings.some((w) => w.startsWith('Only 2 years of storage on the review date'))).toBe(true);
	});

	it('reports a level that isn’t demand.scale without running it, and needs a farm dam', () => {
		const t = runReviewTriggers(pumped, {
			reviewDate: REVIEW,
			seasonEnd: END,
			edgesM3: [200_000],
			analogueYears: [2004],
			baseRun: pumpedBase,
			levels: [{ id: 'dam', label: 'Bigger dam', ops: [{ op: 'node.set', nodeId: 'a', field: 'damCapacityM3', value: 1e6 }] }, ...levels([0.5])]
		});
		for (const r of t.rows) {
			expect(r.outlook.levels[0]!.problems[0]).toMatch(/only demand.scale ops/);
			expect(r.perLevel.map((l) => l.levelId)).toEqual(['f0.5']);
		}
		const noDams = { ...pumped, model: { ...pumped.model, nodes: pumped.model.nodes.map((n) => ({ ...n, damCapacityM3: 0, supplyRule: 'damFirst' as const })) } };
		expect(() => runReviewTriggers(noDams, { reviewDate: REVIEW, seasonEnd: END, levels: levels([1]) })).toThrow(/farm dam/);
	});

	it('is deterministic, and the same under a skewed TZ', () => {
		const opts = { reviewDate: REVIEW, seasonEnd: END, levels: levels([1, 0.3]), edgesM3: [200_000], analogueYears: [2003, 2004], baseRun: pumpedBase };
		const utc = runReviewTriggers(pumped, opts);
		const tz = process.env.TZ;
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone;
				expect(runReviewTriggers(pumped, opts)).toEqual(utc);
			}
		} finally {
			process.env.TZ = tz;
		}
	});
});

describe('against the plain outlook', () => {
	it('review date = decision date: the band holding the base run’s storage reproduces the plain outlook', () => {
		// On 1 October 2012 both dams are full in the base run, so the full band's start (pro rata: each full) is the history's own state.
		const season: OutlookSeason = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30' };
		const t = toEpochDay(season.decisionDate) - 1 - toEpochDay(plainBase.startDate);
		expect([col(plainBase, 'a', 'dam_storage')![t], col(plainBase, 'b', 'dam_storage')![t]]).toEqual([300_000, 150_000]);
		const lv = levels([1, 0.7]);
		const years = [2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012].map((y) => y - 1);
		const outlook = runSeasonalOutlook(plain, { ...season, levels: lv, analogueYears: years, baseRun: plainBase });
		const table = runReviewTriggers(plain, { reviewDate: season.decisionDate, seasonEnd: season.seasonEnd, levels: lv, edgesM3: [CAP], analogueYears: years, baseRun: plainBase });
		const full = table.rows[0]!;
		expect(full.band).toEqual({ fromM3: CAP, toM3: CAP });
		expect(full.outlook.planning).toEqual(outlook.planning);
		expect(full.outlook.startStorageM3).toBe(outlook.startStorageM3);
		for (const [i, l] of outlook.levels.entries()) {
			const got = full.outlook.levels[i]!;
			for (const [k, y] of l.years.entries()) {
				const g = got.years[k]!;
				expect(g.ewr).toEqual(y.ewr);
				for (const key of ['seasonEndStorageM3', 'demandM3', 'suppliedM3'] as const) expect(Math.abs(g[key]! - y[key]!), `${l.id} ${y.label} ${key}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(y[key]!)));
			}
		}
	});

	it('a member with the history’s own storage is the plain member; the base may not already carry a reset', () => {
		const season: OutlookSeason = { decisionDate: REVIEW, seasonEnd: END };
		const a = outlookAnalogue(resolveSeason(season), 2004);
		const t = toEpochDay(REVIEW) - 1 - toEpochDay(pumpedBase.startDate);
		const own = { a: col(pumpedBase, 'a', 'dam_storage')![t]!, b: col(pumpedBase, 'b', 'dam_storage')![t]! };
		const x = runModelWithoutChecks(outlookMemberInput(pumped, pumpedBase, season, a).input);
		const y = runModelWithoutChecks(outlookMemberInput(pumped, pumpedBase, season, a, [], { storageM3: own }).input);
		for (const s of x.series) expect(col(y, s.nodeId, s.key), `${s.nodeId}/${s.key}`).toEqual(s.values);
		const withReset = { ...pumped, settings: { ...pumped.settings, damStorageReset: { date: REVIEW, storageM3: own } } };
		expect(() => outlookMemberInput(withReset, pumpedBase, season, a)).toThrow(/storage reset/);
	});
});

// ---------------------------------------------------------------------------
// Hand-made members: monotonicity notes
// ---------------------------------------------------------------------------

function member(waterYear: number, below: number): OutlookMember {
	return {
		waterYear,
		label: `${waterYear}`,
		analogueFrom: `${waterYear + 1}-01-01`,
		analogueTo: `${waterYear + 1}-04-30`,
		seasonEndStorageM3: 0,
		storageM3ByDam: {},
		demandM3: 100,
		suppliedM3: 100,
		demandMet: 1,
		userDemandM3: 0,
		userSuppliedM3: 0,
		userDemandMet: null,
		ewrDays: { days: 120, below },
		reserve: null
	};
}

describe('monotonicity across bands', () => {
	const season: OutlookSeason = { decisionDate: REVIEW, seasonEnd: END };
	const years = Array.from({ length: 10 }, (_, i) => 2000 + i);
	/** A band whose levels (high demand, then low) met the EWR in the given numbers of the 10 years. */
	const band = (fromM3: number, metHigh: number, metLow: number): ReviewTriggerTableInput['bands'][number] => ({
		band: { fromM3, toM3: fromM3 + 100 },
		startStorageM3: fromM3,
		storageM3ByDam: {},
		levels: [
			{ id: 'hi', label: '100 %', problems: [], members: years.map((y, i) => ({ ...member(y, i < metHigh ? 0 : 3), demandM3: 200 })) },
			{ id: 'lo', label: '50 %', problems: [], members: years.map((y, i) => member(y, i < metLow ? 0 : 3)) }
		]
	});
	const input = (bands: ReviewTriggerTableInput['bands']): ReviewTriggerTableInput => ({
		reviewDate: REVIEW,
		seasonEnd: END,
		model: plain.model,
		analogues: years.map((y) => outlookAnalogue(resolveSeason(season), y)),
		excluded: [],
		bands,
		representative: 'lowerEdge',
		bandSource: 'explicit',
		history: []
	});

	it('reports a fuller band that picked a lower level, and does not smooth it', () => {
		// Emptiest first: 0 m³ → 100 % (9 of 10), 100 m³ → 50 % (8 of 10), 200 m³ → 100 % again.
		const t = reviewTriggerTable(input([band(0, 9, 10), band(100, 5, 8), band(200, 9, 10)]));
		expect(t.rows.map((r) => r.level?.id)).toEqual(['hi', 'lo', 'hi']);
		expect(t.monotone).toBe(false);
		expect(t.notes).toContain('From 100 m³ the level picked is 50 %, lower than 100 % from 0 m³: a fuller start picked a lower level.');
		expect(t.notes).toContain('100 %: met in 5 of 10 years from 100 m³, fewer than 9 from 0 m³.');
		expect(t.notes).toContain('50 %: met in 8 of 10 years from 100 m³, fewer than 10 from 0 m³.');
		expect(t.warnings.some((w) => w.startsWith('The table is not monotone in storage'))).toBe(true);
		for (const n of [...t.notes, ...t.warnings]) expect(n).not.toMatch(FORBIDDEN);
	});

	it('a fuller band that loses its level altogether is a lower pick too', () => {
		const t = reviewTriggerTable(input([band(0, 2, 9), band(100, 2, 3)]));
		expect(t.rows.map((r) => r.level?.id ?? null)).toEqual([null, 'lo']);
		expect(t.monotone).toBe(false);
	});

	it('a monotone table has no notes', () => {
		const t = reviewTriggerTable(input([band(0, 2, 8), band(100, 8, 10), band(200, 10, 10)]));
		expect(t.rows.map((r) => r.level?.id)).toEqual(['hi', 'hi', 'lo']);
		expect(t.monotone).toBe(true);
		expect(t.notes).toEqual([]);
		expect(() => reviewTriggerTable(input([]))).toThrow(/at least one band/);
	});
});
