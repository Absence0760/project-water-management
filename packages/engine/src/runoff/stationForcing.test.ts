// Rain from rainfall stations (issue #553, engine ≥ 1.91.0, docs/model.md
// §2.4i): the station rule for a land unit and for the catchment, its
// fallbacks, the summary, and that every input without settings.rainStations
// (or a unit without a station) runs as before, to the bit.
// Synthetic catchment: invented values only (public repo).
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { prepareRun } from '../prepare';
import { referenceCellSeriesKey, stationSeriesKey, type ModelInput, type RainStationSettings, type UnitRainSettings } from '../project';
import { runModel } from '../run';
import { applyScenario } from '../scenario/overrides';
import { sameOutput } from '../testing/invariants';
import { checkResume } from '../testing/warmstartInvariants';
import { outlookMemberInput } from '../outlook/outlook';
import { ensembleContext, resolveEnsembleOptions } from '../uncertainty/ensemble';
import { stationAreaRain } from './stationAreaRain';
import { catchmentMapOf, stationAreaDays, stationRatio, STATION_DAY_SOURCE } from './stationForcing';
import { checkedStationRecord } from './stationRecord';
import { pairingFactorOn } from './stationPairing';
import { goldenDiff, goldenFingerprint, type GoldenFingerprint } from '../testing/golden';
import { calibrate } from '../calibrate/calibrate';
import { fitFlowMethod, fitRecordCaveats, fitRecordFromReport, fitRecordStatus, flowMethodOf } from '../calibrate/provenance';
import { catchmentStationFingerprint, catchmentStationFingerprintError } from './stationFingerprint';
import { unitRainFingerprintChanged, unitRainFingerprintOfSummary } from './unitRainFingerprint';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep
const START = '2015-01-01';
const D0 = toEpochDay(START);
const DAYS = toEpochDay('2021-01-01') - D0; // six whole calendar years
const rainOf = (k: number, phase = 0) => Array.from({ length: DAYS }, (_, i) => ((i + phase) % 13 === 0 ? 30 * k : (i + phase) % 4 === 0 ? 2 * k : 0));
const day = (iso: string) => toEpochDay(iso) - D0;

/** Station S's gaps and its unreliable period, all in 2015, so its pairing keeps five complete years (2016–2020). */
const GAP = [day('2015-03-10'), day('2015-03-11'), day('2015-03-12')];
const UNRELIABLE: [string, string] = ['2015-06-01', '2015-06-05'];

/** A gauge with land units A–D (MAPs 900, 600, 750, 600 mm) above it; catchment rain, CHIRPS, two stations (S: MAP 600, T: MAP 500). */
function catchment(opts: { unitRain?: UnitRainSettings | null; rainStations?: RainStationSettings | null } = {}): ModelInput {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const unit = (id: string, areaKm2: number, mapMm: number) => ({ ...node, id, name: `Unit ${id}`, kind: 'farm' as const, downstreamNodeId: 'G', areaKm2, mapMm, mapSource: 'invented' });
	const s: (number | null)[] = rainOf(1.6, 1);
	for (const t of GAP) s[t] = null;
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, ...(opts.unitRain !== undefined ? { unitRain: opts.unitRain } : {}), ...(opts.rainStations !== undefined ? { rainStations: opts.rainStations } : {}) },
		model: {
			nodes: [{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 }, unit('A', 10, 900), unit('B', 6, 600), unit('C', 3, 750), unit('D', 1.5, 600)],
			crops: [{ id: 'c', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 100_000 }],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: rainOf(1) },
			rain_chirps_mm: { startDate: START, values: rainOf(0.7, 2) },
			// The CHIRPS of unit A, where S stands: S reads exactly twice it on every shared day, so S's factors are 2.
			'rain_chirps_mm@A': { startDate: START, values: rainOf(0.8, 1) },
			'rain_chirps_mm@B': { startDate: START, values: rainOf(0.5, 3) },
			[stationSeriesKey('S')]: { startDate: START, values: s },
			// T has a CHIRPS cell series of its own, but only four complete calendar years: its pairing is refused.
			[stationSeriesKey('T')]: { startDate: '2017-01-01', values: rainOf(1.2, 5).slice(day('2017-01-01')) },
			'rain_chirps_station_mm#T': { startDate: START, values: rainOf(1, 5) },
			flow_observed_m3s: { startDate: START, values: Array.from({ length: DAYS }, (_, i) => 0.1 + 0.4 * Math.exp(-(i % 13) / 3)) }
		},
		stations: {
			S: { name: 'Station S', mapMm: 600, mapSource: 'invented', lat: null, lon: null },
			T: { name: 'Station T', mapMm: 500, mapSource: 'invented', lat: null, lon: null }
		}
	};
}

const PER_UNIT: UnitRainSettings = { mode: 'perUnit' };
const SITES = { S: { unitId: 'A' } };
type Out = ReturnType<typeof runModel>;
const col = (out: Out, key: string, nodeId: string | null = null) => out.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
const settingsOf = (x: ModelInput) => prepareRun(x).settings;

describe('without settings.rainStations, or for a unit without a station', () => {
	it('an input without the setting, with an empty one, or with station series and no assignment runs as before, to the bit', () => {
		for (const unitRain of [null, PER_UNIT]) {
			const base = catchment({ unitRain });
			delete (base as { stations?: unknown }).stations;
			const plain = runModel(base);
			for (const rainStations of [null, {}, { units: {} }, { catchment: null, sites: SITES }]) {
				const out = runModel({ ...catchment({ unitRain, rainStations }) });
				expect(sameOutput(out, plain), JSON.stringify(rainStations)).toBe(true);
				expect(out.summary.stations).toBeUndefined();
			}
		}
	});

	it('assigning a station to unit A leaves units B, C and D on their §2.4h rain to the bit', () => {
		const plain = runModel(catchment({ unitRain: PER_UNIT }));
		const out = runModel(catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'S' } }, sites: SITES } }));
		for (const id of ['B', 'C', 'D']) {
			const a = col(out, 'rain_unit', id);
			const b = col(plain, 'rain_unit', id);
			expect(a.every((v, t) => Object.is(v, b[t])), id).toBe(true);
		}
		expect(out.summary.unitRain!.units.find((u) => u.nodeId === 'A')!.rule).toBe('station');
		expect(out.summary.unitRain!.units.find((u) => u.nodeId === 'B')!.rule).toBe(plain.summary.unitRain!.units.find((u) => u.nodeId === 'B')!.rule);
	});
});

describe('the daily rule (stationAreaDays)', () => {
	const fit = (factor: number) => ({
		stationId: 'S', stationName: 'S', chirpsAt: { cell: true as const }, refused: null, fitFrom: null, fitTo: null, commonYears: 5, days: 0, pinned: true,
		months: Array.from({ length: 12 }, (_, m) => ({ month: m + 1, sharedDays: 0, gaugeMm: 0, chirpsMm: 0, ownFactor: null, factor: m === 0 ? factor : 1, clamped: false, fitted: true, outsideBand: false }))
	});
	it('station × ratio on its days, CHIRPS × the month factor (no ratio) on the others, null when neither', () => {
		const d = stationAreaDays({ start: D0, days: 4, station: [10, null, null, null], ratio: 1.5, chirps: [99, 4, null, 2], pairing: fit(2) });
		expect(d.values).toEqual([15, 8, null, 4]);
		expect(Array.from(d.source)).toEqual([STATION_DAY_SOURCE.station, STATION_DAY_SOURCE.chirps, STATION_DAY_SOURCE.none, STATION_DAY_SOURCE.chirps]);
	});
	it('a refused pairing leaves the CHIRPS unread', () => {
		const d = stationAreaDays({ start: D0, days: 2, station: [null, 3], ratio: 1, chirps: [4, 4], pairing: { ...fit(2), refused: 'too short', months: [] } });
		expect(d.values).toEqual([null, 3]);
	});
	it('the ratio: both ways, clamped to 0.25–4, × 1 without scaling or a MAP', () => {
		expect(stationRatio(900, 600, true)).toEqual({ ratio: 1.5, ownRatio: 1.5, clamped: false });
		expect(stationRatio(300, 600, true)).toEqual({ ratio: 0.5, ownRatio: 0.5, clamped: false });
		expect(stationRatio(9000, 600, true)).toEqual({ ratio: 4, ownRatio: 15, clamped: true });
		expect(stationRatio(100, 600, true).ratio).toBe(0.25);
		expect(stationRatio(900, 600, false)).toEqual({ ratio: 1, ownRatio: null, clamped: false });
		expect(stationRatio(null, 600, true)).toEqual({ ratio: 1, ownRatio: null, clamped: false });
	});
	it('the catchment MAP: the setting, else the land units’ area-weighted mean, else none', () => {
		const nodes = catchment().model.nodes;
		expect(catchmentMapOf(null, nodes).mapMm).toBeCloseTo((10 * 900 + 6 * 600 + 3 * 750 + 1.5 * 600) / 20.5, 12);
		expect(catchmentMapOf({ catchmentMapMm: 700, catchmentMapSource: 'study' }, nodes)).toMatchObject({ mapMm: 700, fromUnits: false, mapSource: 'study' });
		const noMap = nodes.map((n) => (n.id === 'D' ? { ...n, mapMm: null } : n));
		expect(catchmentMapOf(null, noMap)).toMatchObject({ mapMm: null, fromUnits: true, missing: ['Unit D'] });
	});
});

describe('a land unit on its station', () => {
	const input = () => catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'S' }, B: { stationId: 'S' } }, sites: SITES, unreliable: { S: [UNRELIABLE] } } });

	it('reads the station × unit MAP ÷ station MAP on its days, and its own CHIRPS × S’s factors as is on the gaps and unreliable days', () => {
		const x = input();
		const out = runModel(x);
		const rec = checkedStationRecord(settingsOf(x), x.series, 'S')!.record.values;
		const chA = x.series['rain_chirps_mm@A']!.values as number[];
		const chB = x.series['rain_chirps_mm@B']!.values as number[];
		const fit = out.summary.stations!.pairings.find((p) => p.stationId === 'S')!;
		expect(fit.refused).toBeNull();
		// S is twice A's CHIRPS on every shared day: every month's factor is 2.
		for (const m of fit.months) expect(m.factor).toBeCloseTo(2, 12);
		const a = col(out, 'rain_unit', 'A');
		const b = col(out, 'rain_unit', 'B');
		let station = 0;
		let gap = 0;
		for (let t = 0; t < DAYS; t++) {
			if (rec[t] != null) {
				expect(a[t]).toBe(rec[t]! * 1.5); // 900 ÷ 600
				expect(b[t]).toBe(rec[t]! * 1); // 600 ÷ 600
				station++;
			} else {
				const k = pairingFactorOn(fit, D0 + t)!;
				expect(a[t]).toBe(chA[t]! * k); // no MAP ratio on top
				expect(b[t]).toBe(chB[t]! * k);
				gap++;
			}
		}
		for (const t of GAP) expect(rec[t]).toBeNull();
		for (let t = day(UNRELIABLE[0]); t <= day(UNRELIABLE[1]); t++) expect(rec[t]).toBeNull();
		expect(gap).toBeGreaterThanOrEqual(GAP.length + 5);
		// Two units, one station: one pairing.
		expect(out.summary.stations!.pairings.map((p) => p.stationId)).toEqual(['S']);
		const ua = out.summary.stations!.units.find((u) => u.nodeId === 'A')!;
		expect(ua).toMatchObject({ stationId: 'S', stationName: 'Station S', areaMapMm: 900, stationMapMm: 600, ratio: 1.5, ownRatio: 1.5, clamped: false, scaleToMap: true, correctedBy: 'S' });
		expect(ua.days).toEqual({ station, chirps: gap, fallback: 0, none: 0 });
		expect(ua.setAside).toEqual({ checks: 0, unreliable: 5 });
		const sa = out.summary.unitRain!.units.find((u) => u.nodeId === 'A')!;
		expect(sa).toMatchObject({ rule: 'station', rainKey: 'rain_station_mm#S', factor: 1.5, factorSource: 'gaugeMap' });
		expect(sa.days.gaugeMap + sa.days.unitChirps).toBe(DAYS);
	});

	it('scaleToMap false runs the station as it is; a clamped ratio warns', () => {
		const x = catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'S', scaleToMap: false }, C: { stationId: 'S' } }, sites: SITES } });
		x.model.nodes.find((n) => n.id === 'C')!.mapMm = 9000;
		const out = runModel(x);
		const rec = checkedStationRecord(settingsOf(x), x.series, 'S')!.record.values;
		const t = rec.findIndex((v) => v != null && v > 0);
		expect(col(out, 'rain_unit', 'A')[t]).toBe(rec[t]);
		expect(col(out, 'rain_unit', 'C')[t]).toBe(rec[t]! * 4);
		expect(out.summary.stations!.units.find((u) => u.nodeId === 'C')).toMatchObject({ ratio: 4, ownRatio: 15, clamped: true });
		expect(out.summary.warnings.some((w) => w.includes('"Unit C" on "Station S"') && w.includes('clamped'))).toBe(true);
	});

	it('a refused pairing (four complete years) sends the gaps to the catchment forcing, and a unit without CHIRPS too', () => {
		const x = catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'T' }, C: { stationId: 'S' } }, sites: SITES } });
		const out = runModel(x);
		const fitT = out.summary.stations!.pairings.find((p) => p.stationId === 'T')!;
		expect(fitT.refused).toMatch(/4 complete calendar years/);
		const prep = prepareRun(x);
		const c = prep.aligned('rain_catchment_mm');
		const a = col(out, 'rain_unit', 'A');
		// Before T's record (2015–2016): the catchment rain, × 1.
		for (let t = 0; t < day('2017-01-01'); t += 37) expect(a[t]).toBe(Math.max(0, c[t]!));
		expect(out.summary.stations!.units.find((u) => u.nodeId === 'A')).toMatchObject({ correctedBy: null, days: { station: DAYS - day('2017-01-01'), chirps: 0, fallback: day('2017-01-01'), none: 0 } });
		// C has no CHIRPS of its own: S's gaps fall to the catchment forcing.
		const uc = out.summary.stations!.units.find((u) => u.nodeId === 'C')!;
		expect(uc.correctedBy).toBeNull();
		expect(uc.days.chirps).toBe(0);
		expect(uc.days.fallback).toBeGreaterThan(0);
	});

	it('a station missing from the input warns, and the unit keeps its §2.4h rule', () => {
		const plain = runModel(catchment({ unitRain: PER_UNIT }));
		const out = runModel(catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'nowhere' } } } }));
		expect(out.summary.warnings.some((w) => w.includes('"nowhere" has no record'))).toBe(true);
		const a = col(out, 'rain_unit', 'A');
		const b = col(plain, 'rain_unit', 'A');
		expect(a.every((v, t) => Object.is(v, b[t]))).toBe(true);
		expect(out.summary.stations).toBeUndefined();
	});

	it('stationAreaRain gives the run’s rain_unit and its sources', () => {
		const x = input();
		const out = runModel(x);
		const r = stationAreaRain(x, 'A')!;
		expect(r.rainMm).toEqual(col(out, 'rain_unit', 'A'));
		expect(r.forcing).toEqual(out.summary.stations!.units.find((u) => u.nodeId === 'A'));
		expect(r.source.filter((s) => s === 'station').length).toBe(r.forcing.days.station);
		expect(stationAreaRain(x, 'C')).toBeNull();
	});

	it('a resumed run pins the station rule and the pairing factors (to the bit)', () => {
		for (const k of [0, 400, 1500]) expect(checkResume(input(), k)).toBeNull();
	});
});

describe('the catchment on its station', () => {
	const input = (rs: RainStationSettings = {}) => catchment({ rainStations: { catchment: { stationId: 'S' }, sites: SITES, ...rs } });

	it('rain used = S × catchment MAP ÷ S’s MAP on its days, the catchment CHIRPS × S’s factors as is on the others', () => {
		const x = input();
		const out = runModel(x);
		const map = (10 * 900 + 6 * 600 + 3 * 750 + 1.5 * 600) / 20.5;
		const ratio = map / 600;
		const rec = checkedStationRecord(settingsOf(x), x.series, 'S')!.record.values;
		const ch = x.series.rain_chirps_mm!.values as number[];
		const fit = out.summary.stations!.pairings[0]!;
		const used = col(out, 'rain_used');
		for (let t = 0; t < DAYS; t++) {
			if (rec[t] != null) expect(used[t]).toBe(rec[t]! * ratio);
			else expect(used[t]).toBe(ch[t]! * pairingFactorOn(fit, D0 + t)!);
		}
		expect(out.summary.stations).toMatchObject({ catchmentMapMm: map, catchmentMapFromUnits: true, units: [] });
		expect(out.summary.stations!.catchment).toMatchObject({ nodeId: null, stationId: 'S', ratio, correctedBy: 'S', areaMapMm: map });
		// The catchment gauge isn't read, nor fitted against.
		expect(out.summary.chirpsCorrection?.mode ?? 'none').toBe('none');
		expect(stationAreaRain(x, null)!.rainMm).toEqual(used);
	});

	it('an entered catchment MAP replaces the units’ mean; demand and every reader see the same catchment rain', () => {
		const x = input({ catchmentMapMm: 1200, catchmentMapSource: 'a study' });
		const out = runModel(x);
		expect(out.summary.stations).toMatchObject({ catchmentMapMm: 1200, catchmentMapFromUnits: false });
		expect(out.summary.stations!.catchment!.ratio).toBe(2);
		expect(col(out, 'rain_final')).toEqual(col(out, 'rain_used'));
	});

	it('a refused pairing leaves the gaps to the forecast (dry here), and a missing station runs the catchment rain as before', () => {
		const out = runModel(catchment({ rainStations: { catchment: { stationId: 'T' } } }));
		const c = out.summary.stations!.catchment!;
		expect(c.correctedBy).toBeNull();
		expect(c.days).toEqual({ station: DAYS - day('2017-01-01'), chirps: 0, fallback: 0, none: 0 });
		const plain = runModel(catchment());
		const missing = runModel(catchment({ rainStations: { catchment: { stationId: 'nowhere' } } }));
		expect(col(missing, 'rain_used')).toEqual(col(plain, 'rain_used'));
		expect(missing.summary.warnings.some((w) => w.includes('"nowhere" has no record'))).toBe(true);
	});

	it('under per-unit rain, a unit without a station reads the catchment station forcing in its chain', () => {
		const x = catchment({ unitRain: PER_UNIT, rainStations: { catchment: { stationId: 'S' }, sites: SITES } });
		x.series = { ...x.series };
		delete x.series['rain_chirps_mm@A'];
		delete x.series['rain_chirps_mm@B'];
		const out = runModel(x);
		const prep = prepareRun(x);
		const c = prep.aligned('rain_catchment_mm');
		const ch = prep.aligned('rain_chirps_mm');
		// Unit D, no records of its own and no gauge MAP: rule 4, the catchment forcing.
		const d = col(out, 'rain_unit', 'D');
		for (let t = 0; t < DAYS; t += 11) expect(d[t]).toBe(Math.max(0, c[t] ?? ch[t] ?? 0));
	});

	it('rule 2 under a catchment station divides by the MAP level that rain is at (station MAP × r): station × unit MAP ÷ station MAP', () => {
		for (const scaleToMap of [true, false]) {
			const x = catchment({ unitRain: { mode: 'perUnit', gaugeMapMm: 600, gaugeMapSource: 'the station' }, rainStations: { catchment: { stationId: 'S', scaleToMap }, sites: SITES } });
			const out = runModel(x);
			const r = out.summary.stations!.catchment!.ratio;
			if (scaleToMap) expect(r).toBeCloseTo(((10 * 900 + 6 * 600 + 3 * 750 + 1.5 * 600) / 20.5) / 600, 12);
			else expect(r).toBe(1);
			const rec = checkedStationRecord(settingsOf(x), x.series, 'S')!.record.values;
			const c = col(out, 'rain_unit', 'C');
			expect(out.summary.unitRain!.units.find((u) => u.nodeId === 'C')!.rule).toBe('gaugeMap');
			// C (MAP 750, no records of its own): rule 2 on the catchment rain station × r, × 750 ÷ (600 × r).
			for (let t = 0; t < DAYS; t++) if (rec[t] != null) expect(c[t]).toBeCloseTo(rec[t]! * (750 / 600), 12);
		}
	});

	it('a §2.4h reference gauge of rain_catchment_mm is fitted on the station-forced catchment rain (station × r), not the stored gauge', () => {
		const x = catchment({ unitRain: { mode: 'perUnit', reference: { gauge: 'rain_catchment_mm', unitId: 'A' } }, rainStations: { catchment: { stationId: 'S' }, sites: SITES } });
		const cell = rainOf(0.9, 4);
		x.series = { ...x.series, [referenceCellSeriesKey('A')]: { startDate: START, values: cell } };
		const out = runModel(x);
		const ratio = out.summary.stations!.catchment!.ratio;
		expect(ratio).not.toBe(1);
		const rec = checkedStationRecord(settingsOf(x), x.series, 'S', { fitExcludeAccumulations: true })!.record.values;
		const stored = x.series.rain_catchment_mm!.values as number[];
		let jan = 0;
		let janStored = 0;
		for (let t = 0; t < DAYS; t++) {
			if (new Date((D0 + t) * 86_400_000).getUTCMonth() !== 0) continue;
			if (rec[t] != null) jan += rec[t]! * ratio;
			janStored += stored[t]!;
		}
		const m = out.summary.unitRain!.reference!.months[0]!;
		expect(m.gaugeMm).toBeCloseTo(jan, 9);
		expect(Math.abs(m.gaugeMm - janStored)).toBeGreaterThan(1);
	});

	it('a resumed run pins the catchment pairing (to the bit)', () => {
		for (const k of [0, 700]) expect(checkResume(input(), k)).toBeNull();
	});
});

describe('carry-through', () => {
	it('a scenario run keeps the input’s stations', () => {
		const x = catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'S' } }, catchment: { stationId: 'S' }, sites: SITES } });
		const r = applyScenario(x, []);
		expect(r.input.stations).toEqual(x.stations);
		expect(sameOutput(runModel(r.input), runModel(x))).toBe(true);
	});

	it('the ensemble’s CHIRPS-only member blanks the stations: every area reads its CHIRPS × the base’s pinned pairing factors', () => {
		const x = catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'S' } }, catchment: { stationId: 'S' }, sites: SITES } });
		const base = runModel(x);
		const fit = base.summary.stations!.pairings.find((p) => p.stationId === 'S')!;
		const { options } = resolveEnsembleOptions(x, { members: 30, rainSources: ['recorded', 'chirps'] });
		const member = ensembleContext(x, options).chirps!;
		expect((member.series[stationSeriesKey('S')]!.values as unknown[]).every((v) => v === null)).toBe(true);
		expect(member.settings.rainStations?.pinnedFactors?.S).toEqual(fit.months.map((m) => m.factor));
		const out = runModel(member);
		const chA = x.series['rain_chirps_mm@A']!.values as number[];
		const a = col(out, 'rain_unit', 'A');
		for (let t = 0; t < DAYS; t += 7) expect(a[t]).toBe(chA[t]! * pairingFactorOn(fit, D0 + t)!);
		expect(out.summary.stations!.catchment!.days).toMatchObject({ station: 0, chirps: DAYS });
	});

	it('an outlook member keeps the stations and pins the base input’s pairing factors', () => {
		const x = catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'S' } }, catchment: { stationId: 'S' }, sites: SITES } });
		const base = runModel(x);
		const member = outlookMemberInput(x, base, { decisionDate: '2020-06-01', seasonEnd: '2020-08-31' }, { waterYear: 2018, label: '2018/19', from: '2019-06-01', to: '2019-08-31' }).input;
		expect(member.stations).toEqual(x.stations);
		const factors = base.summary.stations!.pairings[0]!.months.map((m) => m.factor);
		expect(member.settings.rainStations?.pinnedFactors?.S).toEqual(factors);
		const out = runModel(member);
		expect(out.summary.stations!.pairings[0]!.pinned).toBe(true);
	});
});

// Golden pins of the station paths (as ./unitRain.golden.test.ts pins today's, ../testing/golden.ts): exact
// series shape and summary text, then the rain and flow series' moments, the rest of the output and the numbers of
// summary.stations at 1e-9 relative (a bit hash can't hold across macOS and CI's Linux). An intended change of the
// station rule updates these in the same change as its ENGINE_VERSION bump; any other difference is a bug.
// GOLDEN_PRINT=1 prints them.
describe('the station paths stay unchanged (golden)', () => {
	const SUMMED = /^(rain_used|rain_final|rain_unit|runoff_natural|natural_flow)$/;
	const fingerprint = (out: Out) => goldenFingerprint(out, SUMMED, out.summary.stations);
	const CASES: Record<string, () => ModelInput> = {
		units: () => catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'S' }, B: { stationId: 'S', correctAgainst: 'S' }, C: { stationId: 'T' } }, sites: SITES, unreliable: { S: [UNRELIABLE] } } }),
		catchment: () => catchment({ rainStations: { catchment: { stationId: 'S' }, sites: SITES, unreliable: { S: [UNRELIABLE] } } }),
		both: () => catchment({ unitRain: PER_UNIT, rainStations: { catchment: { stationId: 'S' }, units: { A: { stationId: 'S', scaleToMap: false } }, catchmentMapMm: 700, catchmentMapSource: 'invented', sites: SITES } })
	};
	const EXPECTED: Record<string, GoldenFingerprint> = {
		units: {
			shape: "d0109dbbdce02042",
			series: {
				"natural_flow@": {
					sum: 128066827.65488726,
					sumSq: 12322294468981.275,
					weighted: 191590881.01926374
				},
				"rain_used@": {
					sum: 11708.702439024437,
					sumSq: 426076.32009518397,
					weighted: 17526.253977616107
				},
				"rain_unit@A": {
					sum: 14499.199999999877,
					sumSq: 879677.4400000048,
					weighted: 21776.149058473744
				},
				"runoff_natural@A": {
					sum: 87632065.14679271,
					sumSq: 6577981097196.878,
					weighted: 131478323.7500499
				},
				"rain_unit@B": {
					sum: 9664,
					sumSq: 390843.1999999973,
					weighted: 14484.739345887025
				},
				"runoff_natural@B": {
					sum: 25929635.20352118,
					sumSq: 489396273362.35394,
					weighted: 38796329.666292705
				},
				"rain_unit@C": {
					sum: 9310.80000000008,
					sumSq: 382944.4800000019,
					weighted: 13985.253121902873
				},
				"runoff_natural@C": {
					sum: 12221040.651818942,
					sumSq: 135464241181.33746,
					weighted: 18394389.13823712
				},
				"rain_unit@D": {
					sum: 6080,
					sumSq: 154120,
					weighted: 9143.040634291374
				},
				"runoff_natural@D": {
					sum: 2284086.6527544437,
					sumSq: 3657423148.8902645,
					weighted: 3419851.9519126806
				},
				"rain_final@": {
					sum: 6080,
					sumSq: 154120,
					weighted: 9102.37264618434
				}
			},
			rest: {
				sum: 939106316.3656577,
				sumSq: 66724202343827.79,
				weighted: 1406976650.0052392
			},
			summary: {
				sum: 31724.292682926836,
				sumSq: 32526085.046638917,
				weighted: 49787.40681428123
			}
		},
		catchment: {
			shape: "ec4d5ef6e927bac3",
			series: {
				"natural_flow@": {
					sum: 138623085.4897218,
					sumSq: 15134798380845.465,
					weighted: 207495758.86422086
				},
				"rain_used@": {
					sum: 12378.45853658533,
					sumSq: 641135.2665318329,
					weighted: 18534.396712514215
				},
				"rain_final@": {
					sum: 12378.45853658533,
					sumSq: 641135.2665318329,
					weighted: 18598.527332060243
				}
			},
			rest: {
				sum: 1012560294.6910626,
				sumSq: 67547501347099.91,
				weighted: 1517035258.1143231
			},
			summary: {
				sum: 23283.14634146342,
				sumSq: 21200486.972575862,
				weighted: 34815.677524233135
			}
		},
		both: {
			shape: "75c0ed02aeddb027",
			series: {
				"natural_flow@": {
					sum: 71115359.22886102,
					sumSq: 3682536249636.605,
					weighted: 106451406.03283477
				},
				"rain_used@": {
					sum: 8257.629268292743,
					sumSq: 223803.0314814928,
					weighted: 12348.901461089721
				},
				"rain_unit@A": {
					sum: 9683.2,
					sumSq: 392253.43999999727,
					weighted: 14548.237066402382
				},
				"runoff_natural@A": {
					sum: 43411054.420888096,
					sumSq: 1375291381002.549,
					weighted: 65109267.84987923
				},
				"rain_unit@B": {
					sum: 3599.999999999979,
					sumSq: 54216.80968071774,
					weighted: 5423.116996600983
				},
				"runoff_natural@B": {
					sum: 1719329.4970369388,
					sumSq: 1842740815.3652272,
					weighted: 2578325.660730049
				},
				"rain_unit@C": {
					sum: 11299.866666666727,
					sumSq: 533908.3555555585,
					weighted: 16932.787710604553
				},
				"runoff_natural@C": {
					sum: 17323316.87395721,
					sumSq: 228273767179.6699,
					weighted: 26053530.49314315
				},
				"rain_unit@D": {
					sum: 11299.866666666727,
					sumSq: 533908.3555555585,
					weighted: 17045.17066402378
				},
				"runoff_natural@D": {
					sum: 8661658.436978605,
					sumSq: 57068441794.91747,
					weighted: 12955509.454962527
				},
				"rain_final@": {
					sum: 11299.866666666727,
					sumSq: 533908.3555555585,
					weighted: 16881.28695077635
				}
			},
			rest: {
				sum: 539877311.4503478,
				sumSq: 18628451479368.44,
				weighted: 809508693.7585994
			},
			summary: {
				sum: 26921.133333333346,
				sumSq: 27113181.522222236,
				weighted: 40970.035513709954
			}
		}
	};
	for (const [name, build] of Object.entries(CASES))
		it(name, () => {
			const got = fingerprint(runModel(build()));
			if (process.env.GOLDEN_PRINT) console.log(name, JSON.stringify(got));
			expect(goldenDiff(got, EXPECTED[name]!)).toEqual([]);
		});
});

describe('fit provenance', () => {
	const ctxOf = (x: ModelInput) => ({ settings: settingsOf(x), validate: false, validationRecord: null, engineVersion: 'test', fittedAt: '2026-10-23T00:00:00Z' });
	const plain = catchment();
	const station = catchment({ rainStations: { catchment: { stationId: 'S' }, sites: SITES } });
	const plainRecord = fitRecordFromReport(calibrate(plain, { budget: 10, seed: 1 }), ctxOf(plain));
	const stationRecord = fitRecordFromReport(calibrate(station, { budget: 10, seed: 1 }), ctxOf(station));
	const now = (x: ModelInput) => ({ catchmentStation: catchmentStationFingerprint(runModel(x).summary.stations) });

	it('a fit records the catchment’s station, its MAP, ratio and pairing factors; one without a station records none', () => {
		expect(plainRecord.forcing!.catchmentStation).toBeUndefined();
		const fp = stationRecord.forcing!.catchmentStation!;
		expect(fp).toMatchObject({ stationId: 'S', scaleToMap: true, correctAgainst: 'S' });
		expect(fp.factors).toEqual(runModel(station).summary.stations!.pairings[0]!.months.map((m) => m.factor));
		expect(catchmentStationFingerprintError(JSON.parse(JSON.stringify(fp)))).toBeNull();
		expect(catchmentStationFingerprintError({ ...fp, factors: [1] })).toMatch(/12 numbers/);
		expect(fitRecordStatus(settingsOf(station), stationRecord, now(station)).catchmentStationChanged).toBeUndefined();
		expect(fitRecordStatus(settingsOf(station), stationRecord, now(station)).forcingChanged).toBe(false);
	});

	it('assigning a station since a fit is its own reason, not a CHIRPS factor drift (settings alone, and with a run)', () => {
		for (const n of [{}, now(station)]) {
			const st = fitRecordStatus(settingsOf(station), plainRecord, n);
			expect(st.catchmentStationChanged).toBe(true);
			expect(st.forcingChanged).toBe(true);
			expect(st.chirpsFactorsChanged).toBe(false);
			expect(fitRecordCaveats(st).some((c) => c.startsWith('The catchment’s rainfall station has changed'))).toBe(true);
		}
	});

	it('removing it since a fit, or its pairing factors drifting, reads the same', () => {
		expect(fitRecordStatus(settingsOf(plain), stationRecord, now(plain)).catchmentStationChanged).toBe(true);
		const drifted = structuredClone(stationRecord);
		drifted.forcing!.catchmentStation!.factors = drifted.forcing!.catchmentStation!.factors!.map((k, m) => (m === 6 ? k * 1.05 : k));
		expect(fitRecordStatus(settingsOf(station), drifted, now(station)).catchmentStationChanged).toBe(true);
		// Within 2 %: the same forcing.
		const close = structuredClone(stationRecord);
		close.forcing!.catchmentStation!.factors = close.forcing!.catchmentStation!.factors!.map((k) => k * 1.01);
		expect(fitRecordStatus(settingsOf(station), close, now(station)).catchmentStationChanged).toBeUndefined();
		// Settings alone (no run) can't see a drift, only an assignment change.
		expect(fitRecordStatus(settingsOf(station), drifted).catchmentStationChanged).toBeUndefined();
		const other = catchment({ rainStations: { catchment: { stationId: 'S', scaleToMap: false }, sites: SITES } });
		expect(fitRecordStatus(settingsOf(other), stationRecord).catchmentStationChanged).toBe(true);
	});

	it('a station unit’s pairing drift is caught from a run’s summary.stations', () => {
		const x = catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'S' } }, sites: SITES } });
		const out = runModel(x);
		const fit = unitRainFingerprintOfSummary(out.summary.unitRain, out.summary.stations)!;
		expect(fit.units.find((u) => u.nodeId === 'A')).toMatchObject({ rule: 'station', stationCorrectAgainst: 'S' });
		const drifted = structuredClone(fit);
		const a = drifted.units.find((u) => u.nodeId === 'A')!;
		a.stationFactors = a.stationFactors!.map((k, m) => (m === 0 ? k * 1.1 : k));
		expect(unitRainFingerprintChanged(drifted, fit)).toBe(true);
		expect(unitRainFingerprintChanged(fit, unitRainFingerprintOfSummary(runModel(x).summary.unitRain, runModel(x).summary.stations))).toBe(false);
	});

	// Settings → Flow generation (issue #553 round 3): the form has no run, so the settings alone must say a method switch and a unit's station change.
	describe('the Flow generation form, without a run', () => {
		const perUnit = catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'S' } }, sites: SITES } });
		const perUnitRecord = fitRecordFromReport(calibrate(perUnit, { budget: 10, seed: 1 }), ctxOf(perUnit));

		it('names the method a fit ran under and the one the settings choose', () => {
			expect(fitFlowMethod(plainRecord)).toBe('fragmentation');
			expect(fitFlowMethod(perUnitRecord)).toBe('perUnit');
			expect(fitFlowMethod({ forcing: undefined })).toBeNull();
			expect([undefined, null, { mode: 'catchment' }, { mode: 'perUnit' }, 'nonsense'].map(flowMethodOf)).toEqual(['fragmentation', 'fragmentation', 'fragmentation', 'perUnit', 'fragmentation']);
		});

		it('switching method marks the fit "not fitted for this method", either way, and no other change does', () => {
			for (const [settings, record] of [
				[settingsOf(perUnit), plainRecord],
				[settingsOf(plain), perUnitRecord]
			] as const) {
				const st = fitRecordStatus(settings, record);
				expect(st.methodChanged).toBe(true);
				expect(st.forcingChanged).toBe(true);
				const caveats = fitRecordCaveats(st);
				expect(caveats.filter((c) => c.startsWith('Parameters not fitted for this method'))).toHaveLength(1);
				// Said once, by its own caveat, not again as the general forcing one.
				expect(caveats.some((c) => c.startsWith('The potential evaporation GR4J runs on'))).toBe(false);
			}
			expect(fitRecordStatus(settingsOf(plain), plainRecord).methodChanged).toBeUndefined();
			expect(fitRecordStatus(settingsOf(perUnit), perUnitRecord).methodChanged).toBeUndefined();
			expect(fitRecordStatus(settingsOf(perUnit), perUnitRecord).forcingChanged).toBe(false);
			// A record from before forcing was recorded can't say its method.
			const { forcing: _f, ...bare } = plainRecord;
			expect(fitRecordStatus(settingsOf(perUnit), bare).methodChanged).toBeUndefined();
		});

		it('a unit given another station, none, or another correcting station is a forcing change; scaling alone needs a run', () => {
			const withUnits = (units: RainStationSettings['units']) => settingsOf(catchment({ unitRain: PER_UNIT, rainStations: { units, sites: SITES } }));
			expect(fitRecordStatus(withUnits({ A: { stationId: 'S' } }), perUnitRecord).forcingChanged).toBe(false);
			expect(fitRecordStatus(withUnits({ A: { stationId: 'T' } }), perUnitRecord).forcingChanged).toBe(true);
			expect(fitRecordStatus(withUnits({}), perUnitRecord).forcingChanged).toBe(true);
			expect(fitRecordStatus(withUnits({ A: { stationId: 'S' }, B: { stationId: 'S' } }), perUnitRecord).forcingChanged).toBe(true);
			expect(fitRecordStatus(withUnits({ A: { stationId: 'S', correctAgainst: 'T' } }), perUnitRecord).forcingChanged).toBe(true);
			expect(fitRecordStatus(withUnits({ A: { stationId: 'S', correctAgainst: 'S' } }), perUnitRecord).forcingChanged).toBe(false);
			expect(fitRecordStatus(withUnits({ A: { stationId: 'S', scaleToMap: false } }), perUnitRecord).forcingChanged).toBe(false);
			// A unit the fit never had (removed from the model since) isn't compared.
			expect(fitRecordStatus(withUnits({ A: { stationId: 'S' }, Z: { stationId: 'T' } }), perUnitRecord).forcingChanged).toBe(false);
			// A fit without stations, settings without stations: no change.
			const chain = catchment({ unitRain: PER_UNIT });
			expect(fitRecordStatus(settingsOf(chain), fitRecordFromReport(calibrate(chain, { budget: 10, seed: 1 }), ctxOf(chain))).forcingChanged).toBe(false);
		});
	});
});
