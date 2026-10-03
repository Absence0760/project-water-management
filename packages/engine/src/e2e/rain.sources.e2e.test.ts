// End-to-end: rain-source periods (docs/model.md §2.4e), forecast mode
// (§2.4f) and the areal rainfall correction (§2.4g), through runModel /
// prepareRun / runForecastChecked on invented catchments.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput } from '../project';
import { runModel } from '../run';
import { prepareRun } from '../prepare';
import { forecastSplit, runForecastChecked, withoutForecastTail } from '../forecast';
import { fromEpochDay, toEpochDay } from '../calendar';

const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const NODE = {
	sortOrder: 0,
	areaHiKm2: 0,
	areaLoKm2: 0,
	flowShareManual: null,
	pctUpstreamToDam: 0,
	pctRunoffToDam: 0,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0
};
function catchment(series: ModelInput['series'], settings: Record<string, unknown> = {}): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', apanMm: APAN as never, gr4j: { warmupDays: 0 }, ...settings } as unknown as ModelInput['settings'],
		model: {
			nodes: [
				{ ...NODE, id: 'G', name: 'Outlet gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
				{ ...NODE, id: 'F', name: 'Unit A', kind: 'farm', downstreamNodeId: 'G', areaKm2: 10 }
			] as never,
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series
	};
}
const col = (out: ModelOutput, key: string) => out.series.find((s) => s.nodeId === null && s.key === key)?.values;
const monthOf = (day: number) => Number(fromEpochDay(day).slice(5, 7));
const wyIndex = (m: number) => (m + 2) % 12;
const span = (from: string, to: string) => {
	const a = toEpochDay(from);
	return Array.from({ length: toEpochDay(to) - a + 1 }, (_, i) => a + i);
};
const h = (d: number) => 1 + (((d % 7) + 7) % 7);
const PROV = { source: 'invented hydrologist', fittedFrom: '2000-10-01', fittedTo: '2005-09-30', method: 'invented ratio' };

// --- rain-source periods (§2.4e) ---------------------------------------------

describe('rain-source periods with fixed factors', () => {
	const days = span('2018-10-01', '2020-09-30');
	const d0 = days[0]!;
	const primary = days.map((d) => 10 * h(d)); // a broken era: 10 × CHIRPS
	const alt = days.map((d) => 0.5 + (d % 3));
	// Water-year order: Oct 1.1, Nov 1.2, … Sep 2.2
	const factorsWy = Array.from({ length: 12 }, (_, i) => Math.round((1.1 + 0.1 * i) * 10) / 10);

	it('inside the period rain = alternative × the factor of the day’s month (water-year order setting); outside, the primary', () => {
		const out = runModel(
			catchment(
				{ rain_catchment_mm: { startDate: fromEpochDay(d0), values: primary }, rain_catchment_alt_mm: { startDate: fromEpochDay(d0), values: alt } },
				{ rainSource: [{ start: '2019-03-01', end: '2019-12-31', series: 'rain_catchment_alt_mm', factors: factorsWy, provenance: PROV, reason: 'invented gauge move' }] }
			)
		);
		const used = col(out, 'rain_used')!;
		const src = col(out, 'rain_source')!;
		for (const iso of ['2019-03-01', '2019-06-15', '2019-10-01', '2019-12-31']) {
			const d = toEpochDay(iso);
			expect(used[d - d0]).toBeCloseTo(alt[d - d0]! * factorsWy[wyIndex(monthOf(d))]!, 12);
			expect(src[d - d0]).toBe(1);
		}
		for (const iso of ['2019-02-28', '2020-01-01']) {
			const d = toEpochDay(iso);
			expect(used[d - d0]).toBe(primary[d - d0]);
			expect(src[d - d0]).toBe(0);
		}
	});

	it('a period ending exactly on the run’s first day and one starting exactly on its last day', () => {
		const out = runModel(
			catchment(
				{ rain_catchment_mm: { startDate: fromEpochDay(d0), values: primary }, rain_catchment_alt_mm: { startDate: fromEpochDay(d0), values: alt } },
				{
					simulationStart: '2019-05-31',
					simulationEnd: '2019-07-01',
					rainSource: [
						{ start: '2019-05-01', end: '2019-05-31', series: 'rain_catchment_alt_mm', factors: factorsWy, provenance: PROV, reason: 'invented A' },
						{ start: '2019-07-01', end: '2019-08-31', series: 'rain_catchment_alt_mm', factors: factorsWy, provenance: PROV, reason: 'invented B' }
					]
				}
			)
		);
		const used = col(out, 'rain_used')!;
		const a = toEpochDay('2019-05-31');
		const b = toEpochDay('2019-07-01');
		expect(out.days).toBe(b - a + 1);
		expect(used[0]).toBeCloseTo(alt[a - d0]! * factorsWy[wyIndex(5)]!, 12);
		expect(used[1]).toBe(primary[a + 1 - d0]);
		expect(used[b - a]).toBeCloseTo(alt[b - d0]! * factorsWy[wyIndex(7)]!, 12);
		expect(out.summary.rainSource!.periods[0]!.runDays).toBe(1);
		expect(out.summary.rainSource!.periods[1]!.runDays).toBe(1);
	});

	it('the run window extends to the alternative series inside a period past the primary record', () => {
		const prim = days.filter((d) => d <= toEpochDay('2020-03-31')).map((d) => 10 * h(d));
		const prep = prepareRun(
			catchment(
				{ rain_catchment_mm: { startDate: fromEpochDay(d0), values: prim }, rain_catchment_alt_mm: { startDate: fromEpochDay(d0), values: alt } },
				{ rainSource: [{ start: '2020-01-01', end: '2020-06-30', series: 'rain_catchment_alt_mm', factors: factorsWy, provenance: PROV, reason: 'invented' }] }
			)
		);
		expect(fromEpochDay(prep.end)).toBe('2020-06-30');
	});

	it('the primary days of a period are left out of the CHIRPS fit: a primary at 10 × CHIRPS inside the period moves no factor', () => {
		const long = span('2014-10-01', '2020-09-30');
		const L0 = long[0]!;
		const c = long.map((d) => (d >= toEpochDay('2019-10-01') && d <= toEpochDay('2020-03-31') ? 10 * h(d) : 2 * h(d)));
		c[long.length - 1] = null as never; // a gap for CHIRPS to fill
		const out = runModel(
			catchment(
				{ rain_catchment_mm: { startDate: fromEpochDay(L0), values: c }, rain_chirps_mm: { startDate: fromEpochDay(L0), values: long.map(h) }, rain_catchment_alt_mm: { startDate: '2019-10-01', values: new Array(183).fill(3) } },
				{ rainSource: [{ start: '2019-10-01', end: '2020-03-31', series: 'rain_catchment_alt_mm', factors: new Array(12).fill(1), provenance: PROV, reason: 'invented' }] }
			)
		);
		for (const m of out.summary.chirpsCorrection!.months) expect(m.factor).toBeCloseTo(2, 12);
		expect(col(out, 'rain_used')![long.length - 1]).toBeCloseTo(2 * h(long[long.length - 1]!), 12);
	});

	it('a day the alternative series lacks falls to CHIRPS × factor, then forecast', () => {
		const long = span('2014-10-01', '2020-09-30');
		const L0 = long[0]!;
		const c = long.map((d) => 2 * h(d));
		const altS = new Array<number | null>(31).fill(4);
		altS[10] = null;
		const out = runModel(
			catchment(
				{ rain_catchment_mm: { startDate: fromEpochDay(L0), values: c }, rain_chirps_mm: { startDate: fromEpochDay(L0), values: long.map(h) }, rain_catchment_alt_mm: { startDate: '2019-01-01', values: altS as never } },
				{ rainSource: [{ start: '2019-01-01', end: '2019-01-31', series: 'rain_catchment_alt_mm', factors: new Array(12).fill(1.5), provenance: PROV, reason: 'invented' }] }
			)
		);
		const d = toEpochDay('2019-01-11');
		expect(col(out, 'rain_used')![d - L0]).toBeCloseTo(2 * h(d), 12);
		expect(col(out, 'rain_source')![d - L0]).toBe(2);
		expect(col(out, 'rain_used')![d - 1 - L0]).toBeCloseTo(6, 12);
	});
});

// --- forecast mode (§2.4f) ---------------------------------------------------

describe('forecast mode', () => {
	const obs = span('2020-10-01', '2021-03-10').map((d) => (d % 4 === 0 ? 15 : d % 3 === 0 ? 2 : 0));

	it('a forecast starting on the last observed day: the record wins that day and the tail starts the day after', () => {
		const input = catchment({ rain_catchment_mm: { startDate: '2020-10-01', values: obs }, rain_forecast_mm: { startDate: '2021-03-10', values: [50, 30, 20, 10, 5] } }, { gr4j: { warmupDays: 100 } });
		const split = forecastSplit(input);
		expect(split.lastObserved).toBe('2021-03-10');
		expect(split.forecastFrom).toBe('2021-03-11');
		const cut = withoutForecastTail(input, split);
		expect(cut.settings.simulationEnd).toBe('2021-03-10');
		expect(cut.series.rain_forecast_mm!.values).toEqual([50]);
		const fc = runForecastChecked(input);
		const hist = runModel(cut);
		const nf = col(fc, 'natural_flow')!;
		const nh = col(hist, 'natural_flow')!;
		expect(nf.length).toBe(nh.length + 4);
		// Causal: identical to the bit on the shared days (the warm-up cycles the history only).
		expect(nf.slice(0, nh.length)).toEqual(nh);
		expect(col(fc, 'rain_used')!.slice(-4)).toEqual([30, 20, 10, 5]);
		expect(fc.forecastFrom).toBe('2021-03-11');
	});

	it('dry days between the record and the forecast are history; forecast rain filling a gap inside the record is history too', () => {
		const withHole = obs.slice() as (number | null)[];
		withHole[20] = null;
		const fcSeries = new Array<number | null>(200).fill(null);
		fcSeries[20] = 9; // inside the record's gap
		for (let k = 0; k < 5; k++) fcSeries[obs.length + 3 + k] = 4; // three dry days after the record, then the tail
		const input = catchment({ rain_catchment_mm: { startDate: '2020-10-01', values: withHole as never }, rain_forecast_mm: { startDate: '2020-10-01', values: fcSeries as never } });
		const split = forecastSplit(input);
		expect(split.lastObserved).toBe('2021-03-10');
		expect(split.forecastFrom).toBe(fromEpochDay(toEpochDay('2021-03-10') + 4));
		const cut = withoutForecastTail(input, split);
		const out = runModel(cut);
		expect(col(out, 'rain_used')![20]).toBe(9);
		expect(out.endDate).toBe('2021-03-13');
	});

	it('no observed rain at all: no tail', () => {
		const split = forecastSplit(catchment({ rain_forecast_mm: { startDate: '2021-01-01', values: [1, 2, 3] } }));
		expect(split.forecastFrom).toBeNull();
	});
});

// --- areal rainfall correction (§2.4g) ----------------------------------------

describe('areal rainfall correction', () => {
	it('GR4J rain = rain_final × the water-year month’s factor; rain_final unchanged; rain_areal added; totals before/after recorded', () => {
		const days = span('2021-09-25', '2021-10-06'); // September → October, across the water-year boundary
		const rain = days.map((_, i) => 2 + i);
		const factors = [2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.5]; // Oct × 2, Sep × 0.5
		const out = runModel(catchment({ rain_catchment_mm: { startDate: '2021-09-25', values: rain } }, { arealRain: { factors, method: 'map', source: 'invented MAP 800 mm' } }));
		const used = col(out, 'rain_used')!;
		const fin = col(out, 'rain_final')!;
		const ar = col(out, 'rain_areal')!;
		for (let t = 0; t < days.length; t++) {
			const k = monthOf(days[t]!) === 10 ? 2 : 0.5;
			expect(used[t]).toBeCloseTo(rain[t]! * k, 12);
			expect(fin[t]).toBe(rain[t]);
			expect(ar[t]).toBeCloseTo(rain[t]! * k, 12);
		}
		const b = out.summary.runoff!;
		expect(b.rainMm).toBeCloseTo(used.reduce((s, v) => s + v, 0), 9);
		expect(b.arealRain!.rainBeforeMm).toBeCloseTo(rain.reduce((s, v) => s + v, 0), 9);
		// The runoff coefficient reads the corrected rain.
		const flow = col(out, 'natural_flow')!.reduce((s, v) => s + v, 0);
		expect(out.summary.catchment.runoffCoefficient).toBeCloseTo(flow / (b.rainMm * 10 * 1000), 12);
	});

	it('scales bias-corrected CHIRPS on gap days too (applied after every other rain step)', () => {
		const days = span('2016-10-01', '2020-09-30');
		const c = days.map((d) => (d > toEpochDay('2020-08-31') ? null : 2 * h(d)));
		const out = runModel(
			catchment(
				{ rain_catchment_mm: { startDate: '2016-10-01', values: c as never }, rain_chirps_mm: { startDate: '2016-10-01', values: days.map(h) } },
				{ arealRain: { factors: new Array(12).fill(1.5), method: 'stations', source: 'invented' } }
			)
		);
		const t = days.length - 1;
		expect(col(out, 'rain_used')![t]).toBeCloseTo(h(days[t]!) * 2 * 1.5, 12);
		expect(col(out, 'rain_final')![t]).toBeCloseTo(h(days[t]!) * 2, 12);
	});
});
