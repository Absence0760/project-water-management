// The forecast-conditioned outlook (issue #620 step 6, docs/model.md §2.15d):
// the quantile map and the CRPS on hand-computed cases, the nearest analogue,
// the rescaling and the zero-month rule, the restriction chances, the skill
// gate and the off switch. Invented catchment and forecasts (public repo).
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput } from '../project';
import { runModelWithoutChecks } from '../run';
import {
	analogueMonthlyTotals,
	FORECAST_MIN_HINDCAST_YEARS,
	forecastMemberBaseRun,
	rankAnalogues,
	runForecastOutlook,
	seasonMonths,
	type RankedAnalogue,
	type SeasonalForecastSystem,
	type SeasonalHindcastSystem
} from './forecast';
import { monthRain, syntheticSystem, type SyntheticKind } from './forecastFixture';
import { outlookAnalogues, runSeasonalOutlook, type OutlookBaseRun } from './outlook';
import { applyQuantileMap, fitQuantileMap } from './qm';
import { outlookAnalogue, resolveSeason, type OutlookSeason } from './season';
import { crpsEnsemble, crpss } from './skill';
import { testCatchment } from './testCatchment';

describe('quantile map (hand-computed)', () => {
	// Forecast 10, 20, 30, 40 at Hazen positions 0.125 … 0.875; observed 5, 15 at 0.25 and 0.75.
	const m = fitQuantileMap([40, 10, 30, 20], [15, 5]);

	it('maps inside the forecast range through the observed quantiles, held at the observed ends', () => {
		expect(applyQuantileMap(m, 20)).toBeCloseTo(7.5, 12); // p 0.375 → 5 + 0.25 × 10
		expect(applyQuantileMap(m, 25)).toBeCloseTo(10, 12); // p 0.5
		expect(applyQuantileMap(m, 10)).toBe(5); // p 0.125, below the observed 0.25: held at 5
		expect(applyQuantileMap(m, 40)).toBe(15);
	});

	it('carries the end corrections on multiplicatively outside the forecast range', () => {
		expect(applyQuantileMap(m, 50)).toBeCloseTo((15 * 50) / 40, 12);
		expect(applyQuantileMap(m, 5)).toBeCloseTo((5 * 5) / 10, 12);
		expect(applyQuantileMap(m, 0)).toBe(0);
	});

	it('puts a block of ties at the mean of its positions', () => {
		// 0, 0 at 0.125 and 0.375 → 0.25; observed 0, 4, 8, 12 at 0.125 … 0.875 → 0 + (0.25 − 0.125) ÷ 0.25 × 4 = 2.
		const t = fitQuantileMap([0, 0, 10, 20], [12, 0, 8, 4]);
		expect(applyQuantileMap(t, 0)).toBeCloseTo(2, 12);
		// 10 at 0.625 → 8; 15 halfway to 20's 0.875 → 0.75 → 10.
		expect(applyQuantileMap(t, 10)).toBeCloseTo(8, 12);
		expect(applyQuantileMap(t, 15)).toBeCloseTo(10, 12);
		// Above a top of 0 (every forecast 0): plus x.
		expect(applyQuantileMap(fitQuantileMap([0, 0], [3]), 2)).toBe(5);
	});

	it('is increasing and never negative', () => {
		const q = fitQuantileMap([3, 0, 0, 7, 12, 12, 30], [1, 4, 9, 2, 25]);
		let last = -1;
		for (let x = 0; x <= 60; x += 0.25) {
			const y = applyQuantileMap(q, x);
			expect(y).toBeGreaterThanOrEqual(last);
			last = y;
		}
	});

	it('refuses empty samples and values that are not rain', () => {
		expect(() => fitQuantileMap([], [1])).toThrow(RangeError);
		expect(() => fitQuantileMap([1, -1], [1])).toThrow(RangeError);
		expect(() => applyQuantileMap(m, Number.NaN)).toThrow(RangeError);
	});
});

describe('CRPS and CRPSS (hand-computed)', () => {
	it('is the mean error less half the mean spread', () => {
		// |1 − 2| ÷ 2 + |3 − 2| ÷ 2 = 1; spread 2 × ¼ × 2 = 1, half 0.5.
		expect(crpsEnsemble([1, 3], null, 2)).toBeCloseTo(0.5, 12);
		// Weights 3 : 1 on 0 and 10 at 0: error 2.5, spread 2 × ¾ × ¼ × 10 = 3.75, half 1.875.
		expect(crpsEnsemble([0, 10], [3, 1], 0)).toBeCloseTo(0.625, 12);
		// One member: the absolute error.
		expect(crpsEnsemble([7], null, 4)).toBe(3);
	});

	it('scores against the reference', () => {
		expect(crpss([1, 1], [2, 2])).toBeCloseTo(0.5, 12);
		expect(crpss([3], [2])).toBeCloseTo(-0.5, 12);
		expect(crpss([1], [0])).toBeNull();
		expect(crpss([], [])).toBeNull();
	});
});

/** A hand-built base run: rain_final from 2000-01-01, the values given by a function of the day. */
function handRun(days: number, rain: (date: string, t: number) => number): OutlookBaseRun {
	const values: number[] = [];
	const r0 = toEpochDay('2000-01-01');
	for (let t = 0; t < days; t++) values.push(rain(new Date((r0 + t) * 86_400_000).toISOString().slice(0, 10), t));
	return { startDate: '2000-01-01', days, series: [{ nodeId: null, key: 'rain_final', label: 'Rain', unit: 'mm', values }] as OutlookBaseRun['series'] };
}

describe('members: the nearest analogue and the rescaling', () => {
	// A January–February season; analogue W starts in January of W + 1.
	const season: OutlookSeason = { decisionDate: '2003-01-01', seasonEnd: '2003-02-28' };
	const s = resolveSeason(season);
	// 2000: January dry, February 2 mm a day; 2001: 1 mm a day every day; 2002: 3 mm every other day.
	const base = handRun(1461, (date, t) => (date.startsWith('2000-01') ? 0 : date.startsWith('2000') ? 2 : date.startsWith('2001') ? 1 : date.startsWith('2002') ? (t % 2 ? 0 : 3) : 0.5));
	const A = (wy: number) => outlookAnalogue(s, wy);
	const cand = [1999, 2000, 2001].map((wy) => ({ analogue: A(wy), totals: analogueMonthlyTotals(base, season, A(wy)) }));

	it('reads each analogue’s whole calendar months', () => {
		expect(seasonMonths(season).map((m) => [m.month, m.firstDay, m.lastDay])).toEqual([
			['2003-01', 0, 30],
			['2003-02', 31, 58]
		]);
		expect(cand.map((c) => c.totals)).toEqual([
			[0, 58],
			[31, 28],
			[45, 42]
		]);
	});

	it('ranks by the standardised RMS distance, ties to the newer year', () => {
		const r = rankAnalogues([31, 28], cand);
		expect(r.map((x) => x.analogue.waterYear)).toEqual([2000, 2001, 1999]);
		expect(r[0]!.distance).toBe(0);
		// Hand: sd(0, 31, 48) and sd(58, 28, 42); 1999's differences −31 and 30.
		const sdOf = (v: number[]) => {
			const m = v.reduce((a, b) => a + b, 0) / v.length;
			return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1));
		};
		const d1999 = Math.sqrt(((-31 / sdOf([0, 31, 45])) ** 2 + (30 / sdOf([58, 28, 42])) ** 2) / 2);
		expect(r[2]!.distance).toBeCloseTo(d1999, 12);
		// A month the member doesn't give doesn't count; equal distances go to the newer year.
		expect(rankAnalogues([null, 35], cand).map((x) => x.analogue.waterYear)).toEqual([2001, 2000, 1999]);
	});

	it('rescales each month to the mapped total, every unit alike, and leaves other days as recorded', () => {
		const unit = { nodeId: 'u', key: 'rain_unit', label: 'Unit rain', unit: 'mm', values: base.series[0]!.values.map((v) => v * 2) };
		const withUnit: OutlookBaseRun = { ...base, series: [...base.series, unit] as OutlookBaseRun['series'] };
		const ranked = rankAnalogues([62, 14], cand);
		expect(ranked[0]!.analogue.waterYear).toBe(2000);
		const v = forecastMemberBaseRun(withUnit, season, ranked, [62, 14]);
		expect(v.months.map((m) => m.factor)).toEqual([2, 0.5]);
		const a = toEpochDay(A(2000).from) - toEpochDay(base.startDate);
		const rain = v.baseRun.series.find((x) => x.nodeId === null)!.values;
		const u = v.baseRun.series.find((x) => x.nodeId === 'u')!.values;
		for (let i = 0; i < s.days; i++) {
			expect(rain[a + i]).toBe(base.series[0]!.values[a + i]! * (i < 31 ? 2 : 0.5));
			expect(u[a + i]).toBe(unit.values[a + i]! * (i < 31 ? 2 : 0.5));
		}
		expect(rain.slice(0, a)).toEqual(base.series[0]!.values.slice(0, a));
		expect(rain.slice(a + s.days)).toEqual(base.series[0]!.values.slice(a + s.days));
		// The base run is not touched.
		expect(base.series[0]!.values[a]).toBe(1);
	});

	it('zero-month rule: a dry month asked for rain takes the next-nearest analogue’s pattern, rescaled', () => {
		// 1999's January (2000-01) is dry; the member wants 31 mm in January and 58 in February.
		const byDistance = rankAnalogues([31, 58], cand);
		const ranked: RankedAnalogue[] = [byDistance.find((x) => x.analogue.waterYear === 1999)!, ...byDistance.filter((x) => x.analogue.waterYear !== 1999)];
		expect(ranked[0]!.analogue.waterYear).toBe(1999);
		const v = forecastMemberBaseRun(base, season, ranked, [31, 58]);
		const donor = ranked[1]!;
		expect(v.months[0]).toMatchObject({ mappedMm: 31, analogueMm: 0, patternYear: donor.analogue.waterYear, factor: 31 / donor.totals[0]! });
		expect(v.months[1]).toMatchObject({ factor: 1, patternYear: null });
		const a = toEpochDay(A(1999).from) - toEpochDay(base.startDate);
		const p = toEpochDay(donor.analogue.from) - toEpochDay(base.startDate);
		const rain = v.baseRun.series[0]!.values;
		let jan = 0;
		for (let i = 0; i < 31; i++) {
			expect(rain[a + i]).toBe(base.series[0]!.values[p + i]! * (31 / donor.totals[0]!));
			jan += rain[a + i]!;
		}
		expect(jan).toBeCloseTo(31, 10);
	});

	it('zero-month rule: under the pattern minimum the month stays dry, and with no analogue to borrow from it says so', () => {
		const only: RankedAnalogue[] = [{ ...cand[0]!, distance: 0 }];
		const small = forecastMemberBaseRun(base, season, only, [0.6, 58]);
		expect(small.months[0]).toMatchObject({ factor: 1, patternYear: null });
		expect(small.warnings).toEqual([]);
		const none = forecastMemberBaseRun(base, season, only, [20, 58]);
		expect(none.months[0]).toMatchObject({ factor: 1, patternYear: null });
		expect(none.warnings[0]).toMatch(/stays dry/);
		// An analogue month under the minimum with a few millimetres, asked for under the minimum: rescaled to what was asked.
		const drizzle = handRun(1461, (date) => (date === '2000-01-10' ? 0.2 : date.startsWith('2000-01') ? 0 : 1));
		const d0 = { analogue: A(1999), totals: analogueMonthlyTotals(drizzle, season, A(1999)), distance: 0 };
		expect(d0.totals[0]).toBeCloseTo(0.2, 12);
		const dz = forecastMemberBaseRun(drizzle, season, [d0], [0.9, d0.totals[1]!]);
		expect(dz.months[0]!.factor).toBeCloseTo(4.5, 12);
		expect(dz.baseRun.series[0]!.values[9]).toBeCloseTo(0.9, 12);
		// Asked for nothing: every day dry.
		const dry = forecastMemberBaseRun(base, season, [{ ...cand[1]!, distance: 0 }], [0, 28]);
		expect(dry.months[0]!.factor).toBe(0);
	});
});

// ─── The whole outlook on the invented catchment ─────────────────────────────

const SEASON: OutlookSeason = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30' };
const HINDCAST_YEARS = Array.from({ length: 24 }, (_, i) => 1988 + i);

function setup(kinds: { id: string; kind: SyntheticKind; members?: number }[], over: (x: ModelInput) => void = () => {}) {
	const input = testCatchment({ start: '1985-10-01', end: '2013-09-30', seed: 3 });
	over(input);
	const baseRun = runModelWithoutChecks(input);
	const sys = kinds.map((k, i) => syntheticSystem(baseRun, { id: k.id, kind: k.kind, members: k.members ?? 4, initMonth: 10, leads: 7, hindcastYears: HINDCAST_YEARS, forecastYear: 2012, seed: 20 + i }));
	return { input, baseRun, forecasts: sys.map((x) => x.forecast), hindcasts: sys.map((x) => x.hindcast) };
}

describe('runForecastOutlook: off until the copy has a hindcast', () => {
	it('says so, and runs nothing, without a forecast or a hindcast', () => {
		// An input that would throw if anything ran.
		const nothing = {} as ModelInput;
		const f: SeasonalForecastSystem = { system: 'x-1', init: '2012-10', members: [{ monthlyMm: [1] }] };
		expect(runForecastOutlook(nothing, { ...SEASON, forecasts: [], hindcasts: [] })).toMatchObject({ status: 'off', reason: 'noForecast', leads: 'esp', members: [], chances: [], skill: null });
		expect(runForecastOutlook(nothing, { ...SEASON, forecasts: [f], hindcasts: [] })).toMatchObject({ status: 'off', reason: 'noHindcast', leads: 'esp' });
	});

	it('leaves out a system with too short a hindcast, and is off with none left', () => {
		const { input, baseRun, forecasts, hindcasts } = setup([{ id: 'a-1', kind: 'skilful' }]);
		const short: SeasonalHindcastSystem = { ...hindcasts[0]!, years: hindcasts[0]!.years.slice(0, FORECAST_MIN_HINDCAST_YEARS - 1) };
		const r = runForecastOutlook(input, { ...SEASON, baseRun, forecasts, hindcasts: [short] });
		expect(r).toMatchObject({ status: 'off', reason: 'noQualifyingSystem' });
		expect(r.systems[0]!.used).toBe(false);
		expect(r.systems[0]!.reason).toMatch(/19 hindcast years .* at least 20/);
		// A hindcast for another init month doesn't count.
		expect(runForecastOutlook(input, { ...SEASON, baseRun, forecasts, hindcasts: [{ ...hindcasts[0]!, initMonth: 11 }] }).systems[0]!.reason).toMatch(/no hindcast for its 10 init/);
	});

	it('leaves out a forecast that starts after the decision date, and takes the newest init on or before it', () => {
		const { input, baseRun, forecasts, hindcasts } = setup([{ id: 'a-1', kind: 'skilful', members: 2 }]);
		const late = { ...forecasts[0]!, init: '2012-12' };
		const r = runForecastOutlook(input, { ...SEASON, baseRun, forecasts: [late], hindcasts: [{ ...hindcasts[0]!, initMonth: 12 }], skill: false });
		expect(r).toMatchObject({ status: 'off', reason: 'noQualifyingSystem' });
		expect(r.systems[0]!.reason).toMatch(/starts after the decision date/);
		// A stale first system doesn't push out the current one: the newest init on or before the decision date is used.
		const stale = { ...forecasts[0]!, system: 'old-1', init: '2012-09' };
		const both = runForecastOutlook(input, { ...SEASON, baseRun, forecasts: [stale, forecasts[0]!], hindcasts, skill: false });
		expect(both.init).toBe('2012-10');
		expect(both.systems.map((x) => [x.system, x.used])).toEqual([
			['old-1', false],
			['a-1', true]
		]);
		expect(both.systems[0]!.reason).toMatch(/differs from the other systems' 2012-10/);
	});

	it('gives the same result under a skewed TZ', () => {
		const { input, baseRun, forecasts, hindcasts } = setup([{ id: 'a-1', kind: 'skilful', members: 2 }]);
		const opts = { ...SEASON, baseRun, forecasts, hindcasts, skill: false };
		const ref = runForecastOutlook(input, opts);
		const tz = process.env.TZ;
		try {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
				process.env.TZ = zone;
				expect(seasonMonths(SEASON).map((m) => m.month)).toEqual(['2012-10', '2012-11', '2012-12', '2013-01', '2013-02', '2013-03', '2013-04']);
				expect(runForecastOutlook(input, opts)).toStrictEqual(ref);
			}
		} finally {
			process.env.TZ = tz;
		}
	});

	it('leaves the ESP outlook as it was, to the bit', () => {
		const { input, baseRun, forecasts, hindcasts } = setup([{ id: 'a-1', kind: 'skilful', members: 2 }]);
		const levels = [{ id: 'f1', label: '100 %', ops: [] }];
		const before = runSeasonalOutlook(input, { ...SEASON, levels, baseRun });
		runForecastOutlook(input, { ...SEASON, baseRun, forecasts, hindcasts, skill: false });
		expect(runSeasonalOutlook(input, { ...SEASON, levels, baseRun })).toStrictEqual(before);
	});
});

describe('runForecastOutlook: the chances, the weights and the skill gate', () => {
	const { input, baseRun, forecasts, hindcasts } = setup([
		{ id: 'good-1', kind: 'skilful', members: 3 },
		{ id: 'clim-2', kind: 'climatology', members: 6 }
	]);
	const r = runForecastOutlook(input, { ...SEASON, baseRun, forecasts, hindcasts });

	it('uses every system with a long enough hindcast, weighted per system, not per member', () => {
		expect(r.status).toBe('ready');
		expect(r.init).toBe('2012-10');
		expect(r.systems.map((x) => [x.system, x.used, x.weight])).toEqual([
			['good-1', true, 0.5],
			['clim-2', true, 0.5]
		]);
		expect(r.systems[0]!.months.map((m) => m.month)).toEqual(['2012-10', '2012-11', '2012-12', '2013-01', '2013-02', '2013-03', '2013-04']);
		// Every hindcast year the record holds before the decision date.
		expect(r.systems[0]!.months.every((m) => m.years.length === 24)).toBe(true);
		const w = (id: string) => r.members.filter((m) => m.system === id).map((m) => m.weight);
		expect(w('good-1')).toEqual([1 / 6, 1 / 6, 1 / 6]);
		expect(w('clim-2')).toEqual(new Array(6).fill(1 / 12));
	});

	it('maps the skilful system’s wet bias out: its members’ totals sit near the season’s own', () => {
		const own = Array.from({ length: 7 }, (_, l) => monthRain(baseRun, 2012, 9 + l)).reduce((a, b) => a + b, 0);
		for (const m of r.members.filter((x) => x.system === 'good-1')) {
			const raw = forecasts[0]!.members[m.member]!.monthlyMm.reduce((a, b) => a + b, 0);
			const mapped = m.months.reduce((a, x) => a + (x.mappedMm ?? 0), 0);
			expect(Math.abs(mapped - own)).toBeLessThan(Math.abs(raw - own));
		}
	});

	it('gives the chance of each band on the default review date (no rule), summing to 1', () => {
		expect(r.chances.map((c) => [c.reviewDate, c.basis, c.categories.length])).toEqual([['2013-01-01', 'bands', 3]]);
		for (const c of [...r.chances, ...r.espChances]) expect(c.categories.reduce((a, x) => a + x.chance, 0)).toBeCloseTo(1, 12);
		// Each category's chance is its members' weight.
		const c = r.chances[0]!;
		c.categories.forEach((cat, i) => expect(cat.chance).toBeCloseTo(r.members.filter((m) => m.categories[0] === i).reduce((a, m) => a + m.weight, 0), 12));
		// Fullest band first.
		expect(c.categories[0]!.fromM3!).toBeGreaterThan(c.categories[2]!.fromM3!);
	});

	it('scores the hindcast years against the ESP, leaving each year out of its own map and analogue pool', () => {
		const sk = r.skill!;
		expect(sk.metric).toBe('crpssSeasonEndStorage');
		expect(sk.nYears).toBe(24);
		expect(sk.years.map((y) => y.year)).toEqual(HINDCAST_YEARS);
		expect(sk.years.every((y) => y.waterYear === y.year && y.systems.length === 2)).toBe(true);
		expect(sk.crpss).toBeCloseTo(crpss(sk.years.map((y) => y.crpsForecast), sk.years.map((y) => y.crpsEsp))!, 12);
		expect(r.leads).toBe(sk.crpss! > 0 ? 'forecast' : 'esp');
	});

	it('a skilful system beats the ESP; a confidently wrong one doesn’t, and then the ESP leads', () => {
		const good = setup([{ id: 'good-1', kind: 'skilful', members: 3 }]);
		const g = runForecastOutlook(good.input, { ...SEASON, baseRun: good.baseRun, forecasts: good.forecasts, hindcasts: good.hindcasts });
		expect(g.skill!.crpss!).toBeGreaterThan(0);
		expect(g.leads).toBe('forecast');
		const bad = setup([{ id: 'mirror-1', kind: 'mirror', members: 3 }]);
		const b = runForecastOutlook(bad.input, { ...SEASON, baseRun: bad.baseRun, forecasts: bad.forecasts, hindcasts: bad.hindcasts });
		expect(b.skill!.crpss!).toBeLessThan(0);
		expect(b.leads).toBe('esp');
		expect(b.warnings.join(' ')).toMatch(/no better than past weather/);
	});
});

describe('runForecastOutlook: under a drought restriction rule', () => {
	const rule = { reviewDates: ['11-01', '01-01'], levels: [{ belowPct: 0.6, cuts: { crops: 0.2 } }, { label: 'Severe', belowPct: 0.3, cuts: { crops: 0.5 } }] };
	const { input, baseRun, forecasts, hindcasts } = setup([{ id: 'good-1', kind: 'skilful', members: 3 }], (x) => {
		x.settings.droughtRestriction = rule;
	});
	// The outlook reads the history without the rule (§2.15): pass a run of the input without it.
	const unrestricted = runModelWithoutChecks({ ...input, settings: { ...input.settings, droughtRestriction: null } });
	const r = runForecastOutlook(input, { ...SEASON, baseRun: unrestricted, forecasts, hindcasts, skill: false });

	it('gives each level’s chance on each of the rule’s review dates, from the storage share, summing to 1', () => {
		void baseRun;
		expect(r.chances.map((c) => c.reviewDate)).toEqual(['2012-11-01', '2013-01-01']);
		expect(r.chances[0]!.categories.map((c) => [c.id, c.label, c.belowPct])).toEqual([
			['level-0', 'No restriction', null],
			['level-1', 'Level 1', 0.6],
			['level-2', 'Severe', 0.3]
		]);
		const cap = 450_000;
		r.chances.forEach((c, k) => {
			expect(c.categories.reduce((a, x) => a + x.chance, 0)).toBeCloseTo(1, 12);
			for (const m of r.members) {
				const share = m.reviewStorageM3[k]! / cap;
				expect(m.categories[k]).toBe(share < 0.3 ? 2 : share < 0.6 ? 1 : 0);
			}
		});
		expect(r.skill).toBeNull();
	});

	it('refuses a base run made with the rule', () => {
		expect(() => runForecastOutlook(input, { ...SEASON, baseRun, forecasts, hindcasts, skill: false })).toThrow(/drought restriction rule/);
	});

	it('takes review dates given, inside the season only', () => {
		const g = runForecastOutlook(input, { ...SEASON, baseRun: unrestricted, forecasts, hindcasts, skill: false, reviewDates: ['2013-02-01'] });
		expect(g.chances.map((c) => c.reviewDate)).toEqual(['2013-02-01']);
		expect(() => runForecastOutlook(input, { ...SEASON, baseRun: unrestricted, forecasts, hindcasts, skill: false, reviewDates: ['2013-06-01'] })).toThrow(RangeError);
	});
});

describe('the analogue years a member can draw on', () => {
	it('are the ESP’s', () => {
		const { input, baseRun, forecasts, hindcasts } = setup([{ id: 'good-1', kind: 'skilful', members: 2 }]);
		const years = outlookAnalogues(baseRun, SEASON).analogues.map((a) => a.waterYear);
		const r = runForecastOutlook(input, { ...SEASON, baseRun, forecasts, hindcasts, skill: false, analogueYears: years.slice(0, 12) });
		expect(r.members.every((m) => years.slice(0, 12).includes(m.analogueYear))).toBe(true);
	});
});
