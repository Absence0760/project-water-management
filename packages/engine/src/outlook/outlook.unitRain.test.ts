// The seasonal outlook under runoff from each unit's own rain (engine ≥
// 1.78.0, docs/model.md §2.4h, §2.15): each member runs a unit's season on
// that unit's own forcing, the base run's rain_unit on the analogue days,
// with its rule and factors as the base run had them; a unit on the
// catchment rule keeps the catchment rain. Invented catchment (public repo).
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { unitForecastSeriesKey, type ModelInput, type ModelOutput } from '../project';
import { captureModelState, runModelFrom, runModelWithoutChecks } from '../run';
import { checkAll } from '../testing/invariants';
import { outlookMemberInput, outlookSeasonInput } from './outlook';
import { outlookAnalogue, resolveSeason, type OutlookSeason } from './season';
import { testCatchment } from './testCatchment';

const SEASON: OutlookSeason = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30' };
const col = (out: Pick<ModelOutput, 'series'>, nodeId: string | null, key: string) => out.series.find((x) => x.nodeId === nodeId && x.key === key)?.values;

/** Unit a on its own CHIRPS levelled by its MAP (rule 3), unit b on its own gauge (rule 1). */
function ownRecords(): ModelInput {
	const input = testCatchment();
	const rain = input.series.rain_catchment_mm!;
	const scaled = (k: number, lag: number) => ({ startDate: rain.startDate, values: rain.values.map((_, t) => (typeof rain.values[t + lag] === 'number' ? (rain.values[t + lag] as number) * k : 0)) });
	input.settings.unitRain = { mode: 'perUnit' };
	(input.series as Record<string, unknown>)['rain_chirps_mm@a'] = scaled(0.6, 1);
	(input.series as Record<string, unknown>)['rain_catchment_mm@b'] = scaled(1.3, 2);
	Object.assign(input.model.nodes[1]!, { mapMm: 900, mapSource: 'invented' });
	return input;
}

/** Both units on the MAP ratio of the catchment gauge (rule 2). */
function gaugeMap(): ModelInput {
	const input = testCatchment();
	input.settings.unitRain = { mode: 'perUnit', gaugeMapMm: 500, gaugeMapSource: 'invented' };
	Object.assign(input.model.nodes[1]!, { mapMm: 650, mapSource: 'invented' });
	Object.assign(input.model.nodes[2]!, { mapMm: 420, mapSource: 'invented' });
	return input;
}

describe('outlook members under per-unit rain', () => {
	const s = resolveSeason(SEASON);
	const own = outlookAnalogue(s, 2012); // the season's own year: the member's season is the history

	it('runs each unit’s season on its own forcing: an analogue equal to the history gives the base run’s unit rain and runoff', () => {
		const input = ownRecords();
		const base = runModelWithoutChecks(input);
		expect(base.summary.unitRain!.units.map((u) => u.rule)).toEqual(['unitChirps', 'unitGauge']);
		const m = outlookMemberInput(input, base, SEASON, own);
		expect(m.problems).toEqual([]);
		expect(Object.keys(m.input.series).filter((k) => k.startsWith('rain_forecast_mm@')).sort()).toEqual([unitForecastSeriesKey('a'), unitForecastSeriesKey('b')]);
		const out = runModelWithoutChecks(m.input);
		const i0 = toEpochDay(SEASON.decisionDate) - toEpochDay(base.startDate);
		const j0 = toEpochDay(SEASON.decisionDate) - toEpochDay(out.startDate);
		for (const id of ['a', 'b']) {
			expect(col(out, id, 'rain_unit')!.slice(j0, j0 + s.days), id).toEqual(col(base, id, 'rain_unit')!.slice(i0, i0 + s.days));
			expect(out.summary.unitRain!.units.find((u) => u.nodeId === id)!.days.forecast).toBe(s.days);
		}
		// Not the catchment level: unit a's CHIRPS runs × its MAP factor, well off the catchment's rain.
		const final = col(base, null, 'rain_final')!.slice(i0, i0 + s.days);
		const sum = (v: number[]) => v.reduce((x, y) => x + y, 0);
		expect(Math.abs(sum(col(out, 'a', 'rain_unit')!.slice(j0, j0 + s.days)) - sum(final))).toBeGreaterThan(0.05 * sum(final));
		expect(checkAll(m.input, 1)).toBeNull();
	});

	it('a member with every unit on the MAP ratio runs as before the units’ own season rain', () => {
		const input = gaugeMap();
		const base = runModelWithoutChecks(input);
		expect(base.summary.unitRain!.units.map((u) => u.rule)).toEqual(['gaugeMap', 'gaugeMap']);
		const m = outlookMemberInput(input, base, SEASON, outlookAnalogue(s, 2005)).input;
		const old = structuredClone(m);
		for (const k of Object.keys(old.series)) if (k.startsWith('rain_forecast_mm@')) delete (old.series as Record<string, unknown>)[k];
		const now = runModelWithoutChecks(m);
		const before = runModelWithoutChecks(old);
		for (const x of before.series) expect(col(now, x.nodeId, x.key), `${x.nodeId}/${x.key}`).toEqual(x.values);
		expect(now.summary.farms).toEqual(before.summary.farms);
	});

	it('a unit on the catchment rule keeps the catchment rain', () => {
		const input = ownRecords();
		delete (input.series as Record<string, unknown>)['rain_chirps_mm@a'];
		const base = runModelWithoutChecks(input);
		expect(base.summary.unitRain!.units[0]!.rule).toBe('catchment');
		const out = runModelWithoutChecks(outlookMemberInput(input, base, SEASON, outlookAnalogue(s, 2005)).input);
		const j0 = toEpochDay(SEASON.decisionDate) - toEpochDay(out.startDate);
		expect(col(out, 'a', 'rain_unit')!.slice(j0)).toEqual(col(out, null, 'rain_final')!.slice(j0));
	});

	it('a member from the snapshot keeps the base run’s rules and factors, and runs each unit on the analogue’s unit rain', () => {
		const input = ownRecords();
		const base = runModelWithoutChecks(input);
		const a = outlookAnalogue(s, 2005);
		const warm = runModelFrom(captureModelState(input, SEASON.decisionDate), outlookSeasonInput(input, base, SEASON, a).input);
		const pick = (o: ModelOutput) => o.summary.unitRain!.units.map((u) => [u.nodeId, u.rule, u.factor, u.chirps]);
		expect(pick(warm)).toEqual(pick(base));
		const i0 = toEpochDay(a.from) - toEpochDay(base.startDate);
		for (const id of ['a', 'b']) expect(col(warm, id, 'rain_unit'), id).toEqual(col(base, id, 'rain_unit')!.slice(i0, i0 + s.days));
	});

	it('the re-run member pins the base run’s rules and factors too, so its season is the snapshot member’s to the bit', () => {
		const input = ownRecords();
		const base = runModelWithoutChecks(input);
		const a = outlookAnalogue(s, 2005);
		const warm = runModelFrom(captureModelState(input, SEASON.decisionDate), outlookSeasonInput(input, base, SEASON, a).input);
		const cold = runModelWithoutChecks(outlookMemberInput(input, base, SEASON, a).input);
		const i0 = toEpochDay(SEASON.decisionDate) - toEpochDay(cold.startDate);
		for (const x of warm.series) {
			const c = col(cold, x.nodeId, x.key);
			if (c) expect(x.values, `${x.nodeId}/${x.key}`).toEqual(c.slice(i0));
		}
		// Its history is the base run's: the cut record isn't refitted.
		expect(col(cold, 'a', 'rain_unit')!.slice(0, i0)).toEqual(col(base, 'a', 'rain_unit')!.slice(0, i0));
	});
});
