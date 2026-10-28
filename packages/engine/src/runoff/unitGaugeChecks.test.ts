// The rain checks on a unit's own gauge (issue #500 decision 6) and on the reference gauge the
// monthly factors are fitted on (decision 1c), docs/model.md §2.4h. Synthetic catchment: invented
// values only (public repo).
import { describe, expect, it } from 'vitest';
import { monthOfEpochDay, toEpochDay } from '../calendar';
import { referenceCellSeriesKey, type DailySeries, type ModelInput, type UnitRainSettings } from '../project';
import { prepareRun } from '../prepare';
import { runModel } from '../run';
import { referenceFit, UNIT_RAIN_SOURCE, unitRainForcing } from './unitRain';
import { checkedReferenceGauge, checkedUnitGauge } from './unitGaugeChecks';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep
const START = '2015-01-01';
const D0 = toEpochDay(START);
const DAYS = toEpochDay('2021-01-01') - D0; // six whole calendar years
const at = (iso: string) => toEpochDay(iso) - D0;
const monthOf = (i: number) => monthOfEpochDay(D0 + i);
// Summer rain (Oct–Mar wet, Apr–Sep dry), so §2.4c's wet half of the year is Oct–Mar.
const season = (i: number) => (monthOf(i) >= 4 && monthOf(i) <= 9 ? 0.3 : 1.5);
const rainOf = (k: number, phase = 0) => Array.from({ length: DAYS }, (_, i) => season(i) * ((i + phase) % 13 === 0 ? 30 * k : (i + phase) % 4 === 0 ? 2 * k : 0));

// A suspect zero run: 2016-11-01 … 2017-02-28 (120 days in the wet half), recorded as 0.
const ZR_FROM = at('2016-11-01');
const ZR_TO = at('2017-02-28');
const withZeroRun = (v: (number | null)[]) => v.map((x, i) => (i >= ZR_FROM && i <= ZR_TO ? 0 : x));

// An accumulation: five blank days 2017-05-10 … 14, then 60 mm read on the 15th; CHIRPS rains
// 15 mm on the 10th–13th and nothing on the 14th–16th, so the reading looks like the run's rain.
const ACC_BLANK = [at('2017-05-10'), at('2017-05-14')] as const;
const ACC_READ = at('2017-05-15');
function withAccumulation(gauge: (number | null)[], chirps: number[]): void {
	for (let i = ACC_BLANK[0]; i <= ACC_BLANK[1]; i++) gauge[i] = null;
	gauge[ACC_READ] = 60;
	gauge[ACC_BLANK[0] - 1] = 0;
	for (let i = ACC_BLANK[0] - 1; i <= ACC_READ + 1; i++) chirps[i] = i <= ACC_BLANK[0] + 3 && i >= ACC_BLANK[0] ? 15 : 0;
}

/**
 * The catchment gauge and three land units above an outlet: A has its own gauge and CHIRPS (rule 1),
 * B a MAP against the gauge's MAP and its own CHIRPS (rule 2), C its CHIRPS and the reference cell.
 */
function catchment(unitRain: UnitRainSettings, opts: { unitGauge?: (number | null)[]; unitChirps?: number[]; catchmentGauge?: (number | null)[] } = {}): ModelInput {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const unit = (id: string, areaKm2: number, mapMm?: number) => ({ ...node, id, name: `Unit ${id}`, kind: 'farm' as const, downstreamNodeId: 'G', areaKm2, ...(mapMm ? { mapMm, mapSource: 'invented' } : {}) });
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, unitRain },
		model: {
			nodes: [{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 }, unit('A', 4), unit('B', 6, 900), unit('C', 3, 600)],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: opts.catchmentGauge ?? rainOf(1) },
			['rain_catchment_mm@A' as never]: { startDate: START, values: opts.unitGauge ?? rainOf(1, 1) },
			['rain_chirps_mm@A' as never]: { startDate: START, values: opts.unitChirps ?? rainOf(0.7, 1) },
			['rain_chirps_mm@B' as never]: { startDate: START, values: rainOf(0.6, 2) },
			['rain_chirps_mm@C' as never]: { startDate: START, values: rainOf(0.5, 0) },
			[referenceCellSeriesKey('C') as never]: { startDate: START, values: rainOf(0.5, 0) }
		}
	};
}

function forcing(x: ModelInput) {
	const p = prepareRun(x);
	const warnings: string[] = [];
	const built = unitRainForcing(
		{ settings: p.settings, series: x.series, nodes: x.model.nodes, startDate: p.startDate, days: p.days, aligned: p.aligned, chirpsCorrection: p.chirpsCorrection },
		warnings
	)!;
	expect(p.startDate).toBe(START);
	return { ...built, warnings, prep: p, unit: (id: string) => built.units.find((u) => u.nodeId === id)! };
}

describe('a unit’s own gauge gets the catchment’s §2.4c and §2.4d checks (decision 6)', () => {
	it('positive control: a gauge with nothing suspect runs as recorded, every day from the gauge, no warning', () => {
		const f = forcing(catchment({ mode: 'perUnit' }));
		const a = f.unit('A');
		const stored = rainOf(1, 1);
		for (let t = 0; t < DAYS; t++) {
			expect(a.source[t]).toBe(UNIT_RAIN_SOURCE.unitGauge);
			expect(a.rainMm[t]).toBe(stored[t]);
		}
		expect(f.warnings.filter((w) => w.includes('"Unit A"’s own gauge'))).toEqual([]);
	});

	it('a suspect zero run falls to the unit’s own CHIRPS (levelled) on the days CHIRPS reads more than the fill threshold', () => {
		const gauge = withZeroRun(rainOf(1, 1));
		const chirps = rainOf(0.7, 1);
		const f = forcing(catchment({ mode: 'perUnit' }, { unitGauge: gauge }));
		const a = f.unit('A');
		const level = a.recipe.chirps!;
		let aside = 0;
		for (let t = ZR_FROM; t <= ZR_TO; t++) {
			if (chirps[t]! > 2) {
				aside++;
				expect(a.source[t]).toBe(UNIT_RAIN_SOURCE.unitChirps);
				expect(a.rainMm[t]).toBeGreaterThan(0);
				if (level.source === 'map') expect(a.rainMm[t]).toBeCloseTo(chirps[t]! * level.factor, 9);
			} else {
				// CHIRPS read at most drizzle: the gauge's dry day is kept (§2.4c fill threshold).
				expect(a.source[t]).toBe(UNIT_RAIN_SOURCE.unitGauge);
				expect(a.rainMm[t]).toBe(0);
			}
		}
		expect(aside).toBeGreaterThan(0);
		// Outside the run, the gauge as recorded.
		expect(a.source[ZR_FROM - 1]).toBe(UNIT_RAIN_SOURCE.unitGauge);
		expect(a.source[ZR_TO + 1]).toBe(UNIT_RAIN_SOURCE.unitGauge);
		expect(f.warnings).toContain(
			`unit rain: "Unit A"’s own gauge is treated as missing on ${aside} days of flagged zero runs (§2.4c, with the catchment’s settings): its CHIRPS (levelled), then the next link of its rule, stands in. The stored series is unchanged.`
		);
	});

	it('zero-run mode "as recorded" keeps the run, as the catchment’s does, and says so', () => {
		const gauge = withZeroRun(rainOf(1, 1));
		const x = catchment({ mode: 'perUnit' }, { unitGauge: gauge });
		x.settings.zeroRainRuns = { mode: 'asRecorded' } as never;
		const f = forcing(x);
		const a = f.unit('A');
		for (let t = ZR_FROM; t <= ZR_TO; t++) expect(a.source[t]).toBe(UNIT_RAIN_SOURCE.unitGauge);
		// The flagged run takes in the zeros either side of the stretch too, so it is at least 120 days.
		const note = f.warnings.find((w) => w.startsWith('unit rain: "Unit A"’s own gauge has flagged zero runs on '));
		expect(note).toMatch(/on (\d+) days run as recorded \(dry\): Model settings → Rain gaps → Flagged rain → Flagged zero runs is "Run as recorded \(dry\)"\.$/);
		expect(Number(note!.match(/on (\d+) days/)![1])).toBeGreaterThanOrEqual(120);
		expect(f.warnings.some((w) => w.includes('"Unit A"’s own gauge is treated as missing'))).toBe(false);
	});

	it('the catchment’s dated lists name the catchment gauge’s days, so they leave the unit’s gauge alone', () => {
		const x = catchment({ mode: 'perUnit' });
		x.settings.zeroRainRuns = { missing: [{ start: '2016-01-01', end: '2016-01-31', reason: 'catchment logger fault' }] } as never;
		const a = forcing(x).unit('A');
		for (let t = at('2016-01-01'); t <= at('2016-01-31'); t++) expect(a.source[t]).toBe(UNIT_RAIN_SOURCE.unitGauge);
	});

	it('a multi-day accumulation spreads within the unit’s record, in proportion to its CHIRPS', () => {
		const gauge: (number | null)[] = rainOf(1, 1);
		const chirps = rainOf(0.7, 1);
		withAccumulation(gauge, chirps);
		const f = forcing(catchment({ mode: 'perUnit' }, { unitGauge: gauge, unitChirps: chirps }));
		const a = f.unit('A');
		let total = 0;
		for (let t = ACC_BLANK[0]; t <= ACC_READ; t++) {
			expect(a.source[t]).toBe(UNIT_RAIN_SOURCE.unitGauge);
			total += a.rainMm[t]!;
		}
		expect(total).toBeCloseTo(60, 9);
		for (let t = ACC_BLANK[0]; t < ACC_BLANK[0] + 4; t++) expect(a.rainMm[t]).toBeCloseTo(15, 9);
		expect(a.rainMm[ACC_READ]).toBeCloseTo(0, 9);
		expect(f.warnings.some((w) => w.startsWith('unit rain: "Unit A"’s own gauge has 1 multi-day accumulation spread over 6 run days (60 mm)'))).toBe(true);
	});

	it('positive control: the same reading on a day CHIRPS rains too is one day’s rain, kept on its day', () => {
		const gauge: (number | null)[] = rainOf(1, 1);
		const chirps = rainOf(0.7, 1);
		withAccumulation(gauge, chirps);
		chirps[ACC_READ] = 50;
		const a = forcing(catchment({ mode: 'perUnit' }, { unitGauge: gauge, unitChirps: chirps })).unit('A');
		expect(a.rainMm[ACC_READ]).toBe(60);
		for (let t = ACC_BLANK[0]; t <= ACC_BLANK[1]; t++) expect(a.source[t]).toBe(UNIT_RAIN_SOURCE.unitChirps);
	});

	it('the checks read the whole record, so a day’s value doesn’t depend on the window', () => {
		const x = catchment({ mode: 'perUnit' }, { unitGauge: withZeroRun(rainOf(1, 1)) });
		const s = prepareRun(x).settings;
		const whole = checkedUnitGauge(s, x.series, 'A', D0, DAYS)!.values;
		const part = checkedUnitGauge(s, x.series, 'A', D0 + ZR_FROM + 10, 30)!.values;
		expect(part).toEqual(whole.slice(ZR_FROM + 10, ZR_FROM + 40));
	});
});

describe('rule 2 scales the checked catchment rain', () => {
	it('a day the catchment’s zero-run check sets aside falls to the unit’s own CHIRPS, not the gauge’s 0 × the ratio', () => {
		const x = catchment({ mode: 'perUnit', gaugeMapMm: 600, gaugeMapSource: 'invented isohyet' }, { catchmentGauge: withZeroRun(rainOf(1)) });
		const f = forcing(x);
		const b = f.unit('B');
		expect(b.recipe.rule).toBe('gaugeMap');
		const c = f.prep.aligned('rain_catchment_mm');
		let aside = 0;
		for (let t = ZR_FROM; t <= ZR_TO; t++) {
			if (c[t] === null) {
				aside++;
				expect(b.source[t]).toBe(UNIT_RAIN_SOURCE.unitChirps);
			} else expect(b.source[t]).toBe(UNIT_RAIN_SOURCE.gaugeMap);
		}
		// No catchment CHIRPS, so the fill threshold keeps no day: the whole run is set aside.
		expect(aside).toBe(ZR_TO - ZR_FROM + 1);
		// Positive control: the last rain before the run, the scaled gauge (unit MAP 900 ÷ gauge MAP 600).
		let wet = ZR_FROM - 1;
		while (!(rainOf(1)[wet]! > 0)) wet--;
		expect(b.source[wet]).toBe(UNIT_RAIN_SOURCE.gaugeMap);
		expect(b.rainMm[wet]).toBeCloseTo(rainOf(1)[wet]! * 1.5, 12);
	});
});

describe('the reference fit reads the checked gauge rain (decision 1c)', () => {
	const shared = (gauge: (number | null)[], cell: (number | null)[], m: number) => {
		let n = 0;
		let g = 0;
		for (let i = 0; i < DAYS; i++)
			if (monthOf(i) === m && gauge[i] != null && gauge[i]! >= 0 && cell[i] != null) {
				n++;
				g += gauge[i]!;
			}
		return { n, g };
	};

	it('the catchment gauge: days the zero-run check sets aside are left out, and the fit says it read the checked rain', () => {
		const gauge = withZeroRun(rainOf(1));
		const x = catchment({ mode: 'perUnit', reference: { gauge: 'rain_catchment_mm', unitId: 'C' } }, { catchmentGauge: gauge });
		const out = runModel(x);
		const fit = out.summary.unitRain!.reference!;
		expect(fit.gaugeChecked).toBe(true);
		const cell = rainOf(0.5, 0);
		// December: 31 days of the zero run set aside out of six Decembers.
		const asStored = shared(gauge, cell, 12);
		expect(fit.months[11]!.sharedDays).toBe(asStored.n - 31);
		expect(fit.months[11]!.gaugeMm).toBeCloseTo(asStored.g, 9); // the set-aside days were 0 mm
		// Positive control: a month the run doesn't touch reads every shared day.
		expect(fit.months[5]!.sharedDays).toBe(shared(gauge, cell, 6).n);
		// The same fit on the series as stored keeps the run's zeros, and so a lower factor.
		const stored = referenceFit(x.settings.unitRain, x.series, x.model.nodes, [])!;
		expect(stored.gaugeChecked).toBe(false);
		expect(stored.months[11]!.sharedDays).toBe(asStored.n);
		expect(stored.months[11]!.ownFactor!).toBeLessThan(fit.months[11]!.ownFactor!);
	});

	it('a unit’s own gauge: an accumulation window is left out of the fit, as §2.4b’s fit leaves it out (its spread days are CHIRPS-shaped)', () => {
		const gauge: (number | null)[] = rainOf(1, 1);
		const chirps = rainOf(0.7, 1);
		withAccumulation(gauge, chirps);
		const x = catchment({ mode: 'perUnit', reference: { gauge: 'rain_catchment_mm@A', unitId: 'C' } }, { unitGauge: gauge, unitChirps: chirps });
		const s = prepareRun(x).settings;
		// The run spreads the window (rule 1 above); the fit's record has its days blank.
		expect(checkedUnitGauge(s, x.series, 'A', D0 + ACC_BLANK[0], 6)!.values.map((v) => Math.round(v! * 1e9) / 1e9)).toEqual([15, 15, 15, 15, 0, 0]);
		const checked = checkedReferenceGauge(s, x.series, 'rain_catchment_mm@A')!;
		expect(checked.startDate).toBe(START);
		expect(checked.values.slice(ACC_BLANK[0], ACC_READ + 1)).toEqual([null, null, null, null, null, null]);
		// Positive control: the days either side are read.
		expect(checked.values[ACC_BLANK[0] - 1]).toBe(0);
		expect(checked.values[ACC_READ + 1]).toBe(gauge[ACC_READ + 1]);
		const fit = runModel(x).summary.unitRain!.reference!;
		expect(fit.gaugeChecked).toBe(true);
		const cell = rainOf(0.5, 0);
		const may = shared(gauge, cell, 5);
		// As stored, the 60 mm reading day is shared; the fit leaves it (and the blank days) out.
		expect(fit.months[4]!.sharedDays).toBe(may.n - 1);
		expect(fit.months[4]!.gaugeMm).toBeCloseTo(may.g - 60, 9);
	});

	it('the catchment gauge: an accumulation window is left out of the fit too', () => {
		const gauge: (number | null)[] = rainOf(1);
		const chirps = rainOf(0.7);
		withAccumulation(gauge, chirps);
		const x = catchment({ mode: 'perUnit', reference: { gauge: 'rain_catchment_mm', unitId: 'C' } }, { catchmentGauge: gauge });
		x.series.rain_chirps_mm = { startDate: START, values: chirps };
		const p = prepareRun(x);
		// The run spreads it (the rain rule 2 scales) …
		expect(p.accumulation!.info.spreadWindows).toBe(1);
		expect(p.aligned('rain_catchment_mm')[ACC_BLANK[0]]).toBeCloseTo(15, 9);
		// … and the fit leaves its days out.
		const checked = checkedReferenceGauge(p.settings, x.series, 'rain_catchment_mm')!;
		expect(checked.values.slice(ACC_BLANK[0], ACC_READ + 1)).toEqual([null, null, null, null, null, null]);
		expect(checked.values[ACC_BLANK[0] - 1]).toBe(0);
		const fit = runModel(x).summary.unitRain!.reference!;
		const may = shared(gauge, rainOf(0.5, 0), 5);
		expect(fit.months[4]!.sharedDays).toBe(may.n - 1);
		expect(fit.months[4]!.gaugeMm).toBeCloseTo(may.g - 60, 9);
	});

	it('a unit’s own gauge: days its zero-run check sets aside are left out', () => {
		const gauge = withZeroRun(rainOf(1, 1));
		const chirps = rainOf(0.7, 1);
		const x = catchment({ mode: 'perUnit', reference: { gauge: 'rain_catchment_mm@A', unitId: 'C' } }, { unitGauge: gauge });
		const fit = runModel(x).summary.unitRain!.reference!;
		const cell = rainOf(0.5, 0);
		let asideInJan = 0;
		for (let i = ZR_FROM; i <= ZR_TO; i++) if (monthOf(i) === 1 && chirps[i]! > 2) asideInJan++;
		expect(asideInJan).toBeGreaterThan(0);
		expect(fit.months[0]!.sharedDays).toBe(shared(gauge, cell, 1).n - asideInJan);
	});

	it('the checked record of a gauge that isn’t there is null', () => {
		const x = catchment({ mode: 'perUnit' });
		const s = prepareRun(x).settings;
		expect(checkedReferenceGauge(s, x.series, 'rain_catchment_mm@nobody')).toBeNull();
		expect(checkedReferenceGauge(s, { ...x.series, rain_catchment_mm: undefined as unknown as DailySeries }, 'rain_catchment_mm')).toBeNull();
	});
});

describe('a unit’s own gauge honours settings.rainStations.unreliable under its series id (issue #611, engine ≥ 1.102.0)', () => {
	const GAUGE_ID = '00000000-0000-4000-8000-0000000000a1';
	/** The catchment with unit A's gauge named by its series id, and `periods` marked unreliable under `id`. */
	function marked(periods: [string, string][], id = GAUGE_ID, gauge?: (number | null)[]): ModelInput {
		const x = catchment({ mode: 'perUnit' }, gauge ? { unitGauge: gauge } : {});
		const key = 'rain_catchment_mm@A' as never;
		(x.series as Record<string, DailySeries>)[key] = { ...(x.series as Record<string, DailySeries>)[key]!, seriesId: GAUGE_ID };
		x.settings.rainStations = { unreliable: { [id]: periods } };
		return x;
	}
	const FROM = at('2016-01-01');
	const TO = at('2016-01-31');

	it('the period’s days fall to the unit’s own CHIRPS (levelled); the days around it stay the gauge’s, and the warning counts the readings', () => {
		const stored = rainOf(1, 1);
		const f = forcing(marked([['2016-01-01', '2016-01-31']]));
		const a = f.unit('A');
		for (let t = FROM; t <= TO; t++) expect(a.source[t]).toBe(UNIT_RAIN_SOURCE.unitChirps);
		expect(a.source[FROM - 1]).toBe(UNIT_RAIN_SOURCE.unitGauge);
		expect(a.rainMm[FROM - 1]).toBe(stored[FROM - 1]);
		expect(a.source[TO + 1]).toBe(UNIT_RAIN_SOURCE.unitGauge);
		expect(f.warnings).toContain(
			'unit rain: "Unit A"’s own gauge is treated as missing on 31 days the user marked unreliable: its CHIRPS (levelled), then the next link of its rule, stands in. The stored series is unchanged.'
		);
	});

	it('positive control: periods under another id, or a gauge without a series id, leave the gauge as recorded', () => {
		const other = forcing(marked([['2016-01-01', '2016-01-31']], '00000000-0000-4000-8000-0000000000ff')).unit('A');
		for (let t = FROM; t <= TO; t++) expect(other.source[t]).toBe(UNIT_RAIN_SOURCE.unitGauge);
		const x = marked([['2016-01-01', '2016-01-31']]);
		delete (x.series as Record<string, DailySeries>)['rain_catchment_mm@A']!.seriesId;
		const bare = forcing(x);
		for (let t = FROM; t <= TO; t++) expect(bare.unit('A').source[t]).toBe(UNIT_RAIN_SOURCE.unitGauge);
		expect(bare.warnings.some((w) => w.includes('marked unreliable'))).toBe(false);
	});

	it('is blanked after the checks: a period over an accumulation’s blank outage doesn’t make the outage longer, so the reading is still spread', () => {
		const gauge = rainOf(1, 1);
		const chirps = rainOf(0.7, 1);
		withAccumulation(gauge, chirps);
		const plain = checkedUnitGauge(prepareRun(catchment({ mode: 'perUnit' }, { unitGauge: gauge, unitChirps: chirps })).settings, catchment({ mode: 'perUnit' }, { unitGauge: gauge, unitChirps: chirps }).series, 'A', D0, DAYS)!;
		// A period ending the day before the blank outage: as stored, it would extend the outage the reading closes.
		const x = marked([['2017-05-01', '2017-05-09']], GAUGE_ID, gauge);
		(x.series as Record<string, DailySeries>)['rain_chirps_mm@A'] = { startDate: START, values: chirps };
		const s = prepareRun(x).settings;
		const got = checkedUnitGauge(s, x.series, 'A', D0, DAYS)!;
		expect(plain.spreadWindows).toBeGreaterThan(0);
		expect(got.spreadWindows).toBe(plain.spreadWindows);
		expect(got.spreadDays).toBe(plain.spreadDays);
		expect(got.values.slice(ACC_BLANK[0], ACC_READ + 1)).toEqual(plain.values.slice(ACC_BLANK[0], ACC_READ + 1));
		for (let t = at('2017-05-01'); t <= at('2017-05-09'); t++) expect(got.values[t]).toBeNull();
		expect(got.unreliableDays).toBe(9);
	});
});
