// Invariants of the forecast-conditioned outlook (issue #620 step 6,
// docs/model.md §2.15d):
//  - a factor-1 mapping (each month mapped to the analogue's own total)
//    reproduces the ESP member to the bit, with the catchment's rain and with
//    each unit's own rain (§2.4h);
//  - members share the history: however their seasons are rescaled, members
//    re-run in full agree on every series before the decision date to the
//    bit, and from the snapshot their inputs differ only in the season's rain;
//  - the chances on every review date sum to 1, for the forecast and the
//    ESP, under random rules (each basis) and without one (the bands).
// Invented catchments and forecasts (public repo).
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { DroughtRestrictionRule, ModelInput, ModelOutput } from '../project';
import { Rng } from '../random';
import { runModelWithoutChecks } from '../run';
import { analogueMonthlyTotals, forecastMemberBaseRun, forecastMemberScratch, rankAnalogues, runForecastOutlook, seasonMonths } from './forecast';
import { syntheticSystem } from './forecastFixture';
import { outlookAnalogues, outlookBaseAndSnapshot, outlookMemberInput, outlookSeasonInput, runOutlookMember, runOutlookMemberRun, type OutlookBaseRun } from './outlook';
import type { OutlookSeason } from './season';
import { testCatchment } from './testCatchment';

const SEASON: OutlookSeason = { decisionDate: '2008-10-01', seasonEnd: '2009-04-30' };

/** Every series of two runs, value for value (Object.is: −0 and NaN too). */
function sameSeries(a: Pick<ModelOutput, 'series'>, b: Pick<ModelOutput, 'series'>, upTo = Number.POSITIVE_INFINITY) {
	expect(a.series.map((x) => `${x.nodeId}/${x.key}`)).toEqual(b.series.map((x) => `${x.nodeId}/${x.key}`));
	a.series.forEach((x, i) => {
		const y = b.series[i]!.values;
		const n = Math.min(x.values.length, upTo);
		for (let t = 0; t < n; t++) if (!Object.is(x.values[t], y[t])) throw new Error(`${x.nodeId}/${x.key} day ${t}: ${x.values[t]} vs ${y[t]}`);
	});
}

/** Unit a on its own CHIRPS levelled by its MAP, unit b on its own gauge (as outlook.unitRain.test.ts). */
function perUnit(): ModelInput {
	const input = testCatchment({ dailyApan: true });
	const rain = input.series.rain_catchment_mm!;
	const scaled = (k: number, lag: number) => ({ startDate: rain.startDate, values: rain.values.map((_, t) => (typeof rain.values[t + lag] === 'number' ? (rain.values[t + lag] as number) * k : 0)) });
	input.settings.unitRain = { mode: 'perUnit' };
	(input.series as Record<string, unknown>)['rain_chirps_mm@a'] = scaled(0.6, 1);
	(input.series as Record<string, unknown>)['rain_catchment_mm@b'] = scaled(1.3, 2);
	Object.assign(input.model.nodes[1]!, { mapMm: 900, mapSource: 'invented' });
	return input;
}

describe.each([
	['catchment rain', () => testCatchment({ dailyApan: true, recordWide: true })],
	['each unit’s own rain', perUnit]
])('a factor-1 mapping reproduces the ESP member to the bit (%s)', (_, make) => {
	const input = make();
	const { baseRun, snapshot } = outlookBaseAndSnapshot(input, SEASON.decisionDate);
	const { analogues } = outlookAnalogues(baseRun, SEASON);
	const candidates = analogues.map((a) => ({ analogue: a, totals: analogueMonthlyTotals(baseRun, SEASON, a) }));

	it.each(analogues.slice(0, 4).map((a) => [a.label, a] as const))('analogue %s', (_label, a) => {
		const own = analogueMonthlyTotals(baseRun, SEASON, a);
		expect(own.every((v) => v !== null)).toBe(true);
		const ranked = rankAnalogues(own, candidates);
		// Its own totals put it first (distance 0).
		expect(ranked[0]!.analogue).toEqual(a);
		const view = forecastMemberBaseRun(baseRun, SEASON, ranked, own);
		expect(view.months.every((m) => m.factor === 1 && m.patternYear === null)).toBe(true);
		const esp = runOutlookMemberRun(snapshot!, input, baseRun, SEASON, a);
		const fc = runOutlookMemberRun(snapshot!, input, view.baseRun, SEASON, view.analogue);
		sameSeries(fc.output!, esp.output!);
		expect(fc.member).toStrictEqual(esp.member);
		// runOutlookMember is runOutlookMemberRun without the run.
		expect(runOutlookMember(snapshot!, input, baseRun, SEASON, a)).toStrictEqual({ member: esp.member, problems: [] });
	});
});

describe('members share the history', () => {
	const input = testCatchment({ dailyApan: true, recordWide: true });
	const base = runModelWithoutChecks(input);
	const { analogues } = outlookAnalogues(base, SEASON);
	const a = analogues[3]!;
	const candidates = [{ analogue: a, totals: analogueMonthlyTotals(base, SEASON, a) }];
	const rng = new Rng(5);
	const views = [0, 1, 2].map(() => forecastMemberBaseRun(base, SEASON, rankAnalogues(candidates[0]!.totals, candidates), seasonMonths(SEASON).map(() => rng.float(0, 120))).baseRun);

	it('members re-run in full share their history to the bit, however their seasons are rescaled', () => {
		const cut = toEpochDay(SEASON.decisionDate) - toEpochDay(base.startDate);
		const runs = views.map((v) => runModelWithoutChecks(outlookMemberInput(input, v, SEASON, a).input));
		// The seasons differ…
		const rain = (o: ModelOutput) => o.series.find((x) => x.nodeId === null && x.key === 'rain_final')!.values.slice(cut);
		expect(rain(runs[0]!)).not.toEqual(rain(runs[1]!));
		// …the histories don't (each member's statistics are refitted on its history up to the decision date, model.md §2.15).
		for (const r of runs.slice(1)) sameSeries(r, runs[0]!, cut);
	});

	it('from the snapshot, members differ only in their season’s rain', () => {
		const inputs = views.map((v) => outlookSeasonInput(input, v, SEASON, a).input);
		const { rain_forecast_mm: _r0, ...rest0 } = inputs[0]!.series;
		for (const m of inputs.slice(1)) {
			const { rain_forecast_mm: r, ...rest } = m.series;
			expect(r).not.toEqual(_r0);
			expect(rest).toStrictEqual(rest0);
			expect(m.settings).toStrictEqual(inputs[0]!.settings);
			expect(m.model).toBe(inputs[0]!.model);
		}
	});
});

describe('the chances sum to 1 on every review date', () => {
	const CASES = 6;
	const HINDCAST = Array.from({ length: 22 }, (_, i) => 1986 + i);
	const randomRule = (rng: Rng): DroughtRestrictionRule => {
		const n = rng.int(1, 4);
		const below = Array.from({ length: n }, () => rng.float(0.05, 0.95)).sort((x, y) => y - x);
		const md = ['10-15', '11-01', '12-01', '01-01', '02-01', '03-15'].filter(() => rng.bool(0.5));
		const basis = (['total', 'dams', 'own'] as const)[rng.int(0, 2)]!;
		return {
			reviewDates: md.length ? md : ['01-01'],
			levels: below.map((b, i) => ({ belowPct: b, cuts: { crops: Math.min(1, 0.1 * (i + 1)) } })),
			basis,
			...(basis === 'dams' ? { damNodeIds: ['a'] } : {})
		};
	};
	it.each(Array.from({ length: CASES }, (_, k) => k + 1))('seed %i', (seed) => {
		const rng = new Rng(seed * 97);
		const input = testCatchment({ start: '1985-10-01', end: '2009-09-30', seed });
		const rule = seed % 3 === 0 ? null : randomRule(rng);
		const unrestricted = runModelWithoutChecks(input);
		if (rule) input.settings.droughtRestriction = rule;
		const sys = [0, 1].map((i) => syntheticSystem(unrestricted, { id: `s-${i}`, kind: i ? 'climatology' : 'skilful', members: rng.int(1, 5), initMonth: 10, leads: rng.int(2, 7), hindcastYears: HINDCAST, forecastYear: 2008, seed: seed + i }));
		const r = runForecastOutlook(input, { ...SEASON, baseRun: unrestricted, forecasts: sys.map((x) => x.forecast), hindcasts: sys.map((x) => x.hindcast), skill: false });
		expect(r.status).toBe('ready');
		expect(r.chances.length).toBeGreaterThan(0);
		expect(r.chances.map((c) => c.basis)).toEqual(r.chances.map(() => (rule ? 'rule' : 'bands')));
		for (const c of [...r.chances, ...r.espChances]) {
			expect(c.categories.reduce((a, x) => a + x.chance, 0)).toBeCloseTo(1, 12);
			for (const x of c.categories) expect(x.chance).toBeGreaterThanOrEqual(0);
		}
		expect(r.members.reduce((a, m) => a + m.weight, 0)).toBeCloseTo(1, 12);
	});
});

// The base run a view is built from is never changed in place.
it('building a member leaves the base run as it was', () => {
	const input = testCatchment();
	const base: OutlookBaseRun = runModelWithoutChecks(input);
	const before = base.series.map((x) => x.values.slice());
	const { analogues } = outlookAnalogues(base, SEASON);
	const c = analogues.map((a) => ({ analogue: a, totals: analogueMonthlyTotals(base, SEASON, a) }));
	forecastMemberBaseRun(base, SEASON, rankAnalogues([50, 50, 50, 50, 50, 50, 50], c), [50, 50, 50, 50, 50, 50, 50]);
	expect(base.series.map((x) => x.values)).toEqual(before);
});

// Members built one after another on one scratch copy are the members built alone.
it('a scratch copy reused across members gives each the member built alone', () => {
	const input = testCatchment();
	const base: OutlookBaseRun = runModelWithoutChecks(input);
	const { analogues } = outlookAnalogues(base, SEASON);
	const c = analogues.map((a) => ({ analogue: a, totals: analogueMonthlyTotals(base, SEASON, a) }));
	const rng = new Rng(9);
	const scratch = forecastMemberScratch(base);
	for (let k = 0; k < 8; k++) {
		const mapped = seasonMonths(SEASON).map(() => (rng.bool(0.2) ? 0.4 : rng.float(0, 150)));
		const ranked = rankAnalogues(mapped, c);
		const alone = forecastMemberBaseRun(base, SEASON, ranked, mapped);
		const reused = forecastMemberBaseRun(base, SEASON, ranked, mapped, scratch);
		expect(reused.months).toEqual(alone.months);
		sameSeries(reused.baseRun, alone.baseRun);
	}
	expect(() => forecastMemberBaseRun(runModelWithoutChecks(input), SEASON, rankAnalogues([1], c), [1], scratch)).toThrow(/another base run/);
});
