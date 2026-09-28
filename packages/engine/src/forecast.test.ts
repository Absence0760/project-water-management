// Forecast mode (WP-2.12, ./forecast.ts, model.md § Forecast mode): where the
// forecast tail starts, the input without it, and the forecast run's summary.
// The random-network invariant is in forecast.invariants.test.ts.
import { describe, expect, it } from 'vitest';
import { fromEpochDay, toEpochDay } from './calendar';
import { forecastSplit, runForecastChecked, withoutForecastTail } from './forecast';
import { defaultZeroRainSettings, type ModelInput, type ModelOutput } from './project';
import { beforeForecast, fdcPercentileTable, historyDayCount } from './views/fdc';
import { RAIN_SOURCE_CODE } from './rainSourcePeriods';
import { runModelChecked } from './run';
import { randomInput } from './testing/fuzz';
import { checkForecastPrefix } from './testing/forecastInvariants';

const START = '2020-01-01';

/** A random network with rain replaced by `rain` from START (and a forecast when given). */
function withRain(rain: (number | null)[], forecast?: { startDate: string; values: (number | null)[] }, seed = 11): ModelInput {
	const x = randomInput(seed, { maxDays: 400 });
	x.series = { ...x.series, rain_catchment_mm: { startDate: START, values: rain } };
	delete x.series.rain_chirps_mm;
	delete x.series.rain_forecast_mm;
	if (forecast) x.series.rain_forecast_mm = forecast;
	x.settings = { ...x.settings, simulationStart: null, simulationEnd: null, rainSource: [], zeroRainRuns: { ...defaultZeroRainSettings(), mode: 'asRecorded' } };
	return x;
}

/** n days of alternating light rain. */
const record = (n: number) => Array.from({ length: n }, (_, i) => (i % 4 === 0 ? 3 : 0));

describe('forecastSplit', () => {
	it('has no forecast tail without a forecast series (positive control: runForecastChecked is runModelChecked)', () => {
		const x = withRain(record(200));
		expect(forecastSplit(x)).toMatchObject({ forecastFrom: null, lastObserved: '2020-07-18' });
		expect(withoutForecastTail(x)).toBe(x);
		const out = runForecastChecked(x);
		expect(out.forecastFrom).toBeNull();
		expect(out.summary.forecast).toBeUndefined();
		expect(JSON.stringify({ ...out, forecastFrom: undefined })).toBe(JSON.stringify(runModelChecked(x)));
	});

	it('starts the tail on the first forecast day after the last observed rain', () => {
		// Record to 2020-07-18 (200 days), forecast 2020-07-19 … 2020-08-01.
		const x = withRain(record(200), { startDate: '2020-07-19', values: new Array(14).fill(2) });
		const s = forecastSplit(x);
		expect(s).toMatchObject({ forecastFrom: '2020-07-19', lastObserved: '2020-07-18', endDate: '2020-08-01' });
		expect(s.source[199]).toBe(RAIN_SOURCE_CODE.catchment);
		expect(s.source[200]).toBe(RAIN_SOURCE_CODE.forecast);
	});

	it('a forecast overlapping observed rain: the record wins on its days, the tail starts after it', () => {
		const x = withRain(record(200), { startDate: '2020-07-10', values: new Array(20).fill(9) });
		const s = forecastSplit(x);
		expect(s.forecastFrom).toBe('2020-07-19');
		expect(s.source[190]).toBe(RAIN_SOURCE_CODE.catchment);
		// The input without the tail keeps the overlapping forecast days (history, never used) and cuts the rest.
		const trimmed = withoutForecastTail(x, s);
		expect(trimmed.series.rain_forecast_mm).toEqual({ startDate: '2020-07-10', values: new Array(9).fill(9) });
		expect(trimmed.settings.simulationEnd).toBe('2020-07-18');
		expect(checkForecastPrefix(x)).toBeNull();
	});

	it('gaps in the observed rain before the forecast: forecast rain filling a gap mid-record is history, not the tail', () => {
		const rain: (number | null)[] = record(200);
		for (let t = 100; t < 110; t++) rain[t] = null;
		// The forecast covers the gap and runs past the record.
		const x = withRain(rain, { startDate: '2020-04-05', values: new Array(120).fill(1) });
		const s = forecastSplit(x);
		expect(s.source[105]).toBe(RAIN_SOURCE_CODE.forecast);
		expect(s.forecastFrom).toBe('2020-07-19');
		expect(checkForecastPrefix(x)).toBeNull();
	});

	it('dry days between the last observed rain and a later forecast stay in the history', () => {
		// Recorded rain ends with blanks (a logger's padded tail); the forecast starts 3 days after the last reading.
		const rain: (number | null)[] = [...record(200), null, null];
		const x = withRain(rain, { startDate: '2020-07-22', values: new Array(10).fill(4) });
		const s = forecastSplit(x);
		expect(s).toMatchObject({ lastObserved: '2020-07-18', forecastFrom: '2020-07-22' });
		expect(Number.isNaN(s.source[201]!)).toBe(true);
		const trimmed = withoutForecastTail(x, s);
		expect(trimmed.series.rain_forecast_mm).toBeUndefined();
		expect(trimmed.settings.simulationEnd).toBe('2020-07-21');
		expect(checkForecastPrefix(x)).toBeNull();
	});

	it('has no tail when no day has observed rain (nothing to split from) or the run ends before the forecast', () => {
		const onlyForecast = withRain([], { startDate: START, values: new Array(60).fill(2) });
		delete onlyForecast.series.rain_catchment_mm;
		expect(forecastSplit(onlyForecast)).toMatchObject({ forecastFrom: null, lastObserved: null });
		const ended = withRain(record(200), { startDate: '2020-07-19', values: new Array(14).fill(2) });
		ended.settings = { ...ended.settings, simulationEnd: '2020-07-18' };
		expect(forecastSplit(ended).forecastFrom).toBeNull();
		expect(runForecastChecked(ended).forecastFrom).toBeNull();
	});
});

describe('runForecastChecked', () => {
	const x = withRain(record(365), { startDate: '2020-12-31', values: new Array(14).fill(0) });

	it('keeps every summary and every historical series of the run without the tail, to the bit', () => {
		expect(checkForecastPrefix(x)).toBeNull();
		const out = runForecastChecked(x);
		const hist = runModelChecked(withoutForecastTail(x));
		expect(out.forecastFrom).toBe('2020-12-31');
		expect(out.endDate).toBe('2021-01-13');
		expect(hist.endDate).toBe('2020-12-30');
		expect(out.summary.farms).toEqual(hist.summary.farms);
		expect(out.summary.curtailment).toEqual(hist.summary.curtailment);
		expect(out.summary.catchment).toEqual(hist.summary.catchment);
	});

	it('summarises the forecast days per farm and at the outlet, and adds the rain_source column', () => {
		const out = runForecastChecked(x);
		const f = out.summary.forecast!;
		expect(f).toMatchObject({ from: '2020-12-31', to: '2021-01-13', days: 14, lastObserved: '2020-12-30', rainMm: 0 });
		const farms = x.model.nodes.filter((n) => n.kind === 'farm');
		expect(f.perFarm.map((p) => p.nodeId)).toEqual(farms.map((n) => n.id));
		// Recomputed from the stored series over the 14 days.
		const series = (id: string, key: string) => out.series.find((s) => s.nodeId === id && s.key === key)!.values.slice(-14);
		for (const p of f.perFarm) {
			const demand = series(p.nodeId, 'demand').reduce((a, b) => a + b, 0);
			expect(p.demandM3).toBeCloseTo(demand, 6);
			expect(p.deficitDays).toBe(series(p.nodeId, 'deficit').filter((v) => v > 1e-6).length);
			const cap = farms.find((n) => n.id === p.nodeId)!.damCapacityM3;
			const storage = series(p.nodeId, 'dam_storage');
			if (cap > 0) {
				expect(p.minDamPct).toBeCloseTo(Math.min(...storage) / cap, 12);
				expect(p.minDamDate).toBe(fromEpochDay(toEpochDay('2020-12-31') + storage.indexOf(Math.min(...storage))));
			} else expect([p.minDamPct, p.minDamDate]).toEqual([null, null]);
		}
		expect(f.outletEwrDaysAtRisk).toBe(series(null as unknown as string, 'ewr_shortfall').filter((v) => v < 0).length);
		const source = out.series.find((s) => s.nodeId === null && s.key === 'rain_source')!.values;
		expect(source).toHaveLength(out.days);
		expect(source[out.days - 15]).toBe(RAIN_SOURCE_CODE.catchment);
		expect(source.slice(-14)).toEqual(new Array(14).fill(RAIN_SOURCE_CODE.forecast));
	});

	it('names the forecast days in forecastRain but not in the warnings (the summaries leave them out)', () => {
		const out = runForecastChecked(x);
		expect(out.summary.forecastRain).toMatchObject({ days: 14, from: '2020-12-31', to: '2021-01-13' });
		expect(out.summary.warnings.some((w) => w.includes('use forecast rain'))).toBe(false);
		// Positive control: the ordinary run of the same input does warn.
		expect(runModelChecked(x).summary.warnings.some((w) => w.includes('use forecast rain'))).toBe(true);
	});
});

describe('flow-duration table of a forecast run (issue #51)', () => {
	// A wet forecast: 14 days of 40 mm after the record, so the tail moves the curve if ranked.
	const x = withRain(record(200), { startDate: '2020-07-19', values: new Array(14).fill(40) });
	const flowsOf = (out: ModelOutput) =>
		Object.fromEntries(
			(
				[
					['natural', 'natural_flow'],
					['simulated', 'simulated_outflow']
				] as const
			).map(([r, k]) => [r, out.series.find((s) => s.nodeId === null && s.key === k)!.values])
		);

	it('ranks only the history: equal to the ordinary run’s table, the forecast days counted as left out', () => {
		const forecastRun = runForecastChecked(x);
		const ordinary = runModelChecked(withoutForecastTail(x));
		expect(forecastRun.forecastFrom).toBe('2020-07-19');
		const t = fdcPercentileTable(flowsOf(forecastRun), { startDate: forecastRun.startDate, forecastFrom: forecastRun.forecastFrom });
		const o = fdcPercentileTable(flowsOf(ordinary), { startDate: ordinary.startDate, forecastFrom: null });
		expect(t.wholeRun).toEqual(o.wholeRun);
		expect(t.runDays).toBe(200);
		expect(t.forecastDays).toBe(14);
		expect(o.forecastDays).toBe(0);
		// Positive control: ranked with the tail, the wet forecast does move the high flows.
		const withTail = fdcPercentileTable(flowsOf(forecastRun));
		expect(withTail.runDays).toBe(214);
		expect(withTail.wholeRun[0]!.q10).not.toBe(o.wholeRun[0]!.q10);
	});

	it('beforeForecast and historyDayCount cut a series at the first forecast day', () => {
		expect(historyDayCount('2020-01-01', '2020-07-19')).toBe(200);
		expect(historyDayCount('2020-01-01', null)).toBeNull();
		const v = [1, 2, 3, 4];
		expect(beforeForecast(v, '2020-01-01', '2020-01-03')).toEqual([1, 2]);
		expect(beforeForecast(v, '2020-01-01', undefined)).toBe(v);
		expect(beforeForecast(v, '2020-01-01', '2020-02-01')).toBe(v);
	});
});
