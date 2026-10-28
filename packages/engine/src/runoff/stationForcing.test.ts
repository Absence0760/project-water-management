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
import { stationAreaRain, stationPatchChoices } from './stationAreaRain';
import { catchmentMapOf, resolvePatch, stationAreaDays, stationPatchUsability, stationRatio, STATION_DAY_SOURCE } from './stationForcing';
import { checkedStationRecord } from './stationRecord';
import { pairingFactorOn } from './stationPairing';
import { goldenDiff, goldenFingerprint, type GoldenFingerprint } from '../testing/golden';
import { calibrate } from '../calibrate/calibrate';
import { fitFlowMethod, fitRecordCaveats, fitRecordFromReport, fitRecordStatus, flowMethodOf } from '../calibrate/provenance';
import { catchmentStationFingerprint, catchmentStationFingerprintChanged, catchmentStationFingerprintError, catchmentStationSettingChanged } from './stationFingerprint';
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
	const node = { sortOrder: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
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
	it('a chain: the first link with a value, a station patch already × its ratio, with its index', () => {
		const d = stationAreaDays({
			start: D0,
			days: 4,
			station: [10, null, null, null],
			ratio: 1.5,
			chain: [
				{ kind: 'station', values: [7, null, 6, null] },
				{ kind: 'station', values: null },
				{ kind: 'chirps', chirps: [99, 4, 4, null], pairing: fit(2) }
			]
		});
		expect(d.values).toEqual([15, 8, 6, null]);
		expect(Array.from(d.source)).toEqual([STATION_DAY_SOURCE.station, STATION_DAY_SOURCE.chirps, STATION_DAY_SOURCE.patch, STATION_DAY_SOURCE.none]);
		expect(Array.from(d.patchIndex)).toEqual([-1, 2, 0, -1]);
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

	it('reads the station × unit MAP ÷ station MAP on its days, and its own CHIRPS × its own pairing’s factors as is on the gaps and unreliable days', () => {
		const x = input();
		const out = runModel(x);
		const rec = checkedStationRecord(settingsOf(x), x.series, 'S')!.record.values;
		const chA = x.series['rain_chirps_mm@A']!.values as number[];
		const chB = x.series['rain_chirps_mm@B']!.values as number[];
		const fit = out.summary.stations!.pairings.find((p) => p.stationId === 'S' && p.areaId === 'A')!;
		const fitB = out.summary.stations!.pairings.find((p) => p.stationId === 'S' && p.areaId === 'B')!;
		expect(fit.refused).toBeNull();
		expect(fitB.refused).toBeNull();
		// S is twice A's CHIRPS on every shared day, and A reads S × 1.5 (900 ÷ 600): every month's factor is 3
		// (issue #612: fitted against the station's adjusted rain over the unit's own CHIRPS).
		for (const m of fit.months) expect(m.factor).toBeCloseTo(3, 12);
		expect(fit).toMatchObject({ areaId: 'A', areaName: 'Unit A', ratio: 1.5, chirpsAt: { unitId: 'A', unitName: 'Unit A' } });
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
				expect(a[t]).toBe(chA[t]! * pairingFactorOn(fit, D0 + t)!); // no MAP ratio on top: it is inside the factors
				expect(b[t]).toBe(chB[t]! * pairingFactorOn(fitB, D0 + t)!);
				gap++;
			}
		}
		for (const t of GAP) expect(rec[t]).toBeNull();
		for (let t = day(UNRELIABLE[0]); t <= day(UNRELIABLE[1]); t++) expect(rec[t]).toBeNull();
		expect(gap).toBeGreaterThanOrEqual(GAP.length + 5);
		// Two units, one station: one pairing each, since each corrects its own CHIRPS (issue #612).
		expect(out.summary.stations!.pairings.map((p) => [p.stationId, p.areaId])).toEqual([
			['S', 'A'],
			['S', 'B']
		]);
		const ua = out.summary.stations!.units.find((u) => u.nodeId === 'A')!;
		expect(ua).toMatchObject({ stationId: 'S', stationName: 'Station S', areaMapMm: 900, stationMapMm: 600, ratio: 1.5, ownRatio: 1.5, clamped: false, scaleToMap: true, correctedBy: 'S' });
		expect(ua.days).toEqual({ station, patch: 0, chirps: gap, fallback: 0, none: 0 });
		expect(ua.patches).toEqual([{ source: 'chirps', days: gap }]);
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
		const fitT = out.summary.stations!.pairings.find((p) => p.stationId === 'T' && p.areaId === 'A')!;
		expect(fitT.refused).toMatch(/4 complete calendar years/);
		const prep = prepareRun(x);
		const c = prep.aligned('rain_catchment_mm');
		const a = col(out, 'rain_unit', 'A');
		// Before T's record (2015–2016): the catchment rain, × 1.
		for (let t = 0; t < day('2017-01-01'); t += 37) expect(a[t]).toBe(Math.max(0, c[t]!));
		expect(out.summary.stations!.units.find((u) => u.nodeId === 'A')).toMatchObject({ correctedBy: null, days: { station: DAYS - day('2017-01-01'), patch: 0, chirps: 0, fallback: day('2017-01-01'), none: 0 } });
		// The run says so, with its stable code (engine ≥ 1.102.0, warningCodes.ts), the text exactly the warning's.
		const fell = out.summary.warningCodes!.filter((w) => w.code === 'rain.unit.catchmentFallback');
		expect(fell.map((w) => w.params.unit)).toEqual(expect.arrayContaining(['A', 'C']));
		for (const w of fell) expect(out.summary.warnings).toContain(w.text);
		expect(fell.find((w) => w.params.unit === 'A')!.params.days).toBe(day('2017-01-01'));
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
		expect(c.days).toEqual({ station: DAYS - day('2017-01-01'), patch: 0, chirps: 0, fallback: 0, none: 0 });
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
		const fit = base.summary.stations!.pairings.find((p) => p.stationId === 'S' && p.areaId === 'A')!;
		const { options } = resolveEnsembleOptions(x, { members: 30, rainSources: ['recorded', 'chirps'] });
		const member = ensembleContext(x, options).chirps!;
		expect((member.series[stationSeriesKey('S')]!.values as unknown[]).every((v) => v === null)).toBe(true);
		expect(member.settings.rainStations?.pinnedFactors?.['S|A']).toEqual(fit.months.map((m) => m.factor));
		expect(member.settings.rainStations?.pinnedFactors?.['S|']).toEqual(base.summary.stations!.pairings.find((p) => p.stationId === 'S' && p.areaId === null)!.months.map((m) => m.factor));
		const out = runModel(member);
		const chA = x.series['rain_chirps_mm@A']!.values as number[];
		const a = col(out, 'rain_unit', 'A');
		for (let t = 0; t < DAYS; t += 7) expect(a[t]).toBe(chA[t]! * pairingFactorOn(fit, D0 + t)!);
		expect(out.summary.stations!.catchment!.days).toMatchObject({ station: 0, chirps: DAYS });
	});

	it('the CHIRPS-only member keeps a rule-2 unit’s MAP ratio under a catchment station: ÷ (station MAP × r), engine 1.95.0, ER-30', () => {
		// C (MAP 750, no records of its own) runs rule 2 on the catchment rain × 750 ÷ (600 × r) (RS5): station × r on S's
		// days, which is at the catchment MAP's level (600 × r), and the catchment CHIRPS × S's factors on the others, at that
		// level already (no r). In the member S is blanked, so every day is a CHIRPS day, and C must keep the base run's
		// ratio, pinned, not one re-derived without the station.
		for (const scaleToMap of [true, false]) {
			const x = catchment({ unitRain: { mode: 'perUnit', gaugeMapMm: 600, gaugeMapSource: 'the station' }, rainStations: { catchment: { stationId: 'S', scaleToMap }, sites: SITES } });
			// Wet catchment CHIRPS on S's gaps (the fixture's are dry there), so the positive control below bites.
			const wet = [...(x.series.rain_chirps_mm!.values as number[])];
			for (const t of GAP) wet[t] = 5 + t;
			x.series.rain_chirps_mm = { startDate: START, values: wet };
			const base = runModel(x);
			const r = base.summary.stations!.catchment!.ratio;
			if (scaleToMap) expect(r).not.toBe(1);
			const ratio = 750 / (600 * r);
			const baseC = base.summary.unitRain!.units.find((u) => u.nodeId === 'C')!;
			expect(baseC.rule, String(scaleToMap)).toBe('gaugeMap');
			expect(baseC.gaugeMapFactor).toBeCloseTo(ratio, 12);
			const fit = base.summary.stations!.pairings.find((p) => p.stationId === 'S' && p.areaId === null)!;
			const { options } = resolveEnsembleOptions(x, { members: 30, rainSources: ['recorded', 'chirps'] });
			const out = runModel(ensembleContext(x, options).chirps!);
			expect(out.summary.stations!.catchment).toMatchObject({ ratio: r, days: { station: 0, chirps: DAYS } });
			const memberC = out.summary.unitRain!.units.find((u) => u.nodeId === 'C')!;
			expect(memberC).toMatchObject({ rule: 'gaugeMap', factor: baseC.factor, gaugeMapFactor: baseC.gaugeMapFactor });
			const chirps = x.series.rain_chirps_mm!.values as number[];
			const c = col(out, 'rain_unit', 'C');
			for (let t = 0; t < DAYS; t++) expect(c[t], `${scaleToMap} day ${t}`).toBeCloseTo(chirps[t]! * pairingFactorOn(fit, D0 + t)! * ratio, 9);
			// Positive control: on S's gaps the base run reads the same CHIRPS day, so the member reads what the base did.
			const cBase = col(base, 'rain_unit', 'C');
			for (const t of GAP) {
				expect(cBase[t], `${scaleToMap} gap ${t}`).toBeGreaterThan(0);
				expect(c[t], `${scaleToMap} gap ${t}`).toBeCloseTo(cBase[t]!, 12);
			}
		}
	});

	it('an outlook member keeps the stations and pins the base input’s pairing factors', () => {
		const x = catchment({ unitRain: PER_UNIT, rainStations: { units: { A: { stationId: 'S' } }, catchment: { stationId: 'S' }, sites: SITES } });
		const base = runModel(x);
		const member = outlookMemberInput(x, base, { decisionDate: '2020-06-01', seasonEnd: '2020-08-31' }, { waterYear: 2018, label: '2018/19', from: '2019-06-01', to: '2019-08-31' }).input;
		expect(member.stations).toEqual(x.stations);
		const factors = base.summary.stations!.pairings[0]!.months.map((m) => m.factor);
		expect(base.summary.stations!.pairings[0]!.areaId).toBeNull();
		expect(member.settings.rainStations?.pinnedFactors?.['S|']).toEqual(factors);
		expect(member.settings.rainStations?.pinnedFactors?.['S|A']).toEqual(base.summary.stations!.pairings[1]!.months.map((m) => m.factor));
		const out = runModel(member);
		expect(out.summary.stations!.pairings[0]!.pinned).toBe(true);
	});
});

// The patching priority (issue #612, engine ≥ 1.105.0, docs/model.md §2.4i): station P (MAP 450) covers the whole
// span but is blank on S's second gap day, so the chain's order shows on S's gap days.
const P_BLANK = GAP[1]!;
function withP(rs: RainStationSettings, opts: { unitRain?: UnitRainSettings | null; pMap?: number | null } = {}): ModelInput {
	const x = catchment({
		unitRain: opts.unitRain === undefined ? PER_UNIT : opts.unitRain,
		rainStations: { sites: SITES, unreliable: { S: [UNRELIABLE] }, ...rs }
	});
	const p: (number | null)[] = rainOf(1.1, 7).map((v) => v + 0.5);
	p[P_BLANK] = null;
	x.series = {
		...x.series,
		[stationSeriesKey('P')]: { startDate: START, values: p }
	};
	x.stations = {
		...x.stations!,
		P: {
			name: 'Station P',
			mapMm: opts.pMap === undefined ? 450 : opts.pMap,
			mapSource: 'invented',
			lat: null,
			lon: null
		}
	};
	return x;
}

describe('the patching priority (issue #612)', () => {
	it('a gap takes the first source in order with a reading: P × unit MAP ÷ P’s MAP, then the unit’s corrected CHIRPS', () => {
		const x = withP({
			units: {
				A: {
					stationId: 'S',
					patch: [{ source: 'station', stationId: 'P' }, { source: 'chirps' }]
				}
			}
		});
		const out = runModel(x);
		const rec = checkedStationRecord(settingsOf(x), x.series, 'S')!.record.values;
		const p = x.series[stationSeriesKey('P')]!.values;
		const chA = x.series['rain_chirps_mm@A']!.values as number[];
		const fit = out.summary.stations!.pairings.find((q) => q.areaId === 'A')!;
		const a = col(out, 'rain_unit', 'A');
		let patched = 0;
		let chirps = 0;
		for (let t = 0; t < DAYS; t++) {
			if (rec[t] != null) expect(a[t]).toBe(rec[t]! * 1.5);
			else if (p[t] != null) {
				expect(a[t]).toBe(p[t]! * 2); // 900 ÷ 450: P's own ratio, not S's
				patched++;
			} else {
				expect(a[t]).toBe(chA[t]! * pairingFactorOn(fit, D0 + t)!);
				chirps++;
			}
		}
		expect(chirps).toBe(1); // P_BLANK
		const gaps = patched + chirps;
		const u = out.summary.stations!.units.find((v) => v.nodeId === 'A')!;
		expect(u.days).toEqual({
			station: DAYS - gaps,
			patch: patched,
			chirps,
			fallback: 0,
			none: 0
		});
		expect(u.patches).toEqual([
			{
				source: 'station',
				stationId: 'P',
				stationName: 'Station P',
				stationMapMm: 450,
				ownRatio: 2,
				ratio: 2,
				clamped: false,
				skipped: null,
				gapDays: gaps,
				fills: patched,
				days: patched
			},
			{ source: 'chirps', days: chirps }
		]);
		// Patch days count as station days (a gauge × MAP ratio) in the unit rain summary.
		const sa = out.summary.unitRain!.units.find((v) => v.nodeId === 'A')!;
		expect(sa.days.gaugeMap).toBe(DAYS - gaps + patched);
		// The Data tab's sources: a patch day names its station and its place.
		const r = stationAreaRain(x, 'A')!;
		expect(r.rainMm).toEqual(a);
		const days = r.source.flatMap((v, t) => (v === 'patch' ? [t] : []));
		expect(days).toHaveLength(patched);
		for (const t of days) expect([r.patchStationId[t], r.patchPlace[t]]).toEqual(['P', 1]);
		expect(r.patchStationId[P_BLANK]).toBeNull();
		expect(r.source[P_BLANK]).toBe('chirps');
	});

	it('the order is the priority: CHIRPS first leaves P nothing to fill', () => {
		const out = runModel(
			withP({
				units: {
					A: {
						stationId: 'S',
						patch: [{ source: 'chirps' }, { source: 'station', stationId: 'P' }]
					}
				}
			})
		);
		const u = out.summary.stations!.units.find((v) => v.nodeId === 'A')!;
		expect(u.days.patch).toBe(0);
		expect(u.patches![0]).toMatchObject({
			source: 'chirps',
			days: u.days.chirps
		});
		expect(u.patches![1]).toMatchObject({
			source: 'station',
			stationId: 'P',
			days: 0
		});
		expect((u.patches![1] as { fills: number }).fills).toBeGreaterThan(0); // it could have: the count is its own, not after CHIRPS
	});

	it('an empty list patches nothing: the gaps go to the next fallback (the catchment rain here)', () => {
		const out = runModel(withP({ units: { A: { stationId: 'S', patch: [] } } }));
		const u = out.summary.stations!.units.find((v) => v.nodeId === 'A')!;
		expect(u).toMatchObject({
			correctedBy: null,
			patches: [],
			days: { patch: 0, chirps: 0 }
		});
		expect(u.days.fallback).toBeGreaterThan(0);
		expect(out.summary.stations!.pairings).toEqual([]); // no CHIRPS in the chain: no pairing fitted
	});

	it('absent, null and [CHIRPS] run the same, to the bit', () => {
		const plain = runModel(withP({ units: { A: { stationId: 'S' } } }));
		for (const patch of [null, [{ source: 'chirps' as const }]]) expect(sameOutput(runModel(withP({ units: { A: { stationId: 'S', patch } } })), plain), JSON.stringify(patch)).toBe(true);
	});

	it('a patch station with no MAP is skipped under scaling (warned), and read × 1 with scaling off', () => {
		const patch = [{ source: 'station' as const, stationId: 'P' }, { source: 'chirps' as const }];
		const out = runModel(withP({ units: { A: { stationId: 'S', patch } } }, { pMap: null }));
		const u = out.summary.stations!.units.find((v) => v.nodeId === 'A')!;
		expect(u.patches![0]).toMatchObject({
			skipped: 'it has no MAP to scale its rain to the area’s MAP by',
			days: 0
		});
		expect(u.days.patch).toBe(0);
		expect(out.summary.warnings).toContain('station: "Unit A"’s patch station "Station P" is skipped: it has no MAP to scale its rain to the area’s MAP by');
		const off = runModel(withP({ units: { A: { stationId: 'S', scaleToMap: false, patch } } }, { pMap: null }));
		const v = off.summary.stations!.units.find((w) => w.nodeId === 'A')!;
		expect(v.patches![0]).toMatchObject({ skipped: null, ratio: 1 });
		expect(v.days.patch).toBeGreaterThan(0);
		const x = withP({ units: { A: { stationId: 'S', scaleToMap: false, patch } } }, { pMap: null });
		const p = x.series[stationSeriesKey('P')]!.values;
		expect(col(off, 'rain_unit', 'A')[GAP[0]!]).toBe(p[GAP[0]!]);
	});

	it('a patch station that fills none of the main station’s gaps warns, and changes nothing', () => {
		// T's record starts in 2017, after every gap of S.
		const x = withP({
			units: {
				A: {
					stationId: 'S',
					patch: [{ source: 'station', stationId: 'T' }, { source: 'chirps' }]
				}
			}
		});
		const out = runModel(x);
		const u = out.summary.stations!.units.find((v) => v.nodeId === 'A')!;
		expect(u.patches![0]).toMatchObject({
			source: 'station',
			stationId: 'T',
			skipped: null,
			fills: 0,
			days: 0
		});
		expect(out.summary.warnings.some((w) => w.startsWith('station: "Unit A"’s patch station "Station T" has no reading on any of the main station’s'))).toBe(true);
		expect(col(out, 'rain_unit', 'A')).toEqual(col(runModel(withP({ units: { A: { stationId: 'S' } } })), 'rain_unit', 'A'));
	});

	it('the catchment follows the same rule: P × catchment MAP ÷ P’s MAP on S’s gaps, as station-like catchment rain', () => {
		const x = withP(
			{
				catchment: {
					stationId: 'S',
					patch: [{ source: 'station', stationId: 'P' }]
				}
			},
			{ unitRain: null }
		);
		const out = runModel(x);
		const map = (10 * 900 + 6 * 600 + 3 * 750 + 1.5 * 600) / 20.5;
		const rec = checkedStationRecord(settingsOf(x), x.series, 'S')!.record.values;
		const p = x.series[stationSeriesKey('P')]!.values;
		const used = col(out, 'rain_used');
		for (let t = 0; t < DAYS; t++) if (rec[t] == null && p[t] != null) expect(used[t]).toBeCloseTo(p[t]! * (map / 450), 12);
		const c = out.summary.stations!.catchment!;
		expect(c.days.patch).toBeGreaterThan(0);
		expect(c.days.chirps).toBe(0); // no CHIRPS in its chain
		const r = stationAreaRain(x, null)!;
		expect(r.rainMm).toEqual(used);
		expect(r.source.filter((v) => v === 'patch')).toHaveLength(c.days.patch!);
		expect(r.patchStationId.filter((v) => v === 'P')).toHaveLength(c.days.patch!);
	});

	it('a resumed run keeps the chain (to the bit)', () => {
		const x = withP({
			units: {
				A: {
					stationId: 'S',
					patch: [{ source: 'station', stationId: 'P' }, { source: 'chirps' }]
				}
			},
			catchment: {
				stationId: 'S',
				patch: [{ source: 'station', stationId: 'P' }, { source: 'chirps' }]
			}
		});
		for (const k of [0, 400]) expect(checkResume(x, k)).toBeNull();
	});
});

describe('resolvePatch and stationPatchUsability', () => {
	it('drops what can’t be a source, a second CHIRPS, a repeated station and the main station, each with a warning', () => {
		const w: string[] = [];
		expect(resolvePatch(undefined, 'S', 'u', w)).toEqual([{ source: 'chirps' }]);
		expect(resolvePatch([], 'S', 'u', w)).toEqual([]);
		expect(w).toEqual([]);
		expect(
			resolvePatch(
				[{ source: 'station', stationId: 'S' }, { source: 'station', stationId: 'P' }, { source: 'chirps' }, { source: 'station', stationId: 'P' }, { source: 'chirps' }, { source: 'cloud' }, null],
				'S',
				'u',
				w
			)
		).toEqual([{ source: 'station', stationId: 'P' }, { source: 'chirps' }]);
		expect(w).toHaveLength(5);
		expect(resolvePatch('chirps', 'S', 'u', w)).toEqual([{ source: 'chirps' }]);
		const many = Array.from({ length: 10 }, (_, i) => ({
			source: 'station',
			stationId: `X${i}`
		}));
		expect(resolvePatch(many, 'S', 'u', [])).toHaveLength(8);
	});

	it('usable when it reads on some of the main station’s gaps; else the reason, always with the fill count', () => {
		const main = [1, null, null, 2, null];
		expect(
			stationPatchUsability({
				main,
				patch: [5, 6, null, 7, 8],
				scaleToMap: true,
				stationMapMm: 500
			})
		).toMatchObject({ usable: true, reason: null, gapDays: 3, fills: 2 });
		expect(
			stationPatchUsability({
				main,
				patch: [5, null, null, 7, null],
				scaleToMap: true,
				stationMapMm: 500
			})
		).toMatchObject({
			usable: false,
			gapDays: 3,
			fills: 0,
			reason: 'it has no reading on any of the main station’s 3 gap days in the run window'
		});
		expect(
			stationPatchUsability({
				main,
				patch: [5, 6, 6, 7, 8],
				scaleToMap: true,
				stationMapMm: null
			}).reason
		).toBe('it has no MAP to scale its rain to the unit’s MAP');
		expect(
			stationPatchUsability({
				main,
				patch: [5, 6, 6, 7, 8],
				scaleToMap: false,
				stationMapMm: null
			}).usable
		).toBe(true);
		expect(
			stationPatchUsability({
				main,
				patch: null,
				scaleToMap: true,
				stationMapMm: 500
			}).reason
		).toBe('it has no record');
		expect(
			stationPatchUsability({
				main,
				patch: main,
				isMain: true,
				scaleToMap: true,
				stationMapMm: 500
			}).reason
		).toBe('it is the main station');
		expect(
			stationPatchUsability({
				main,
				patch: [5, 6, 6, 7, 8],
				scaleToMap: true,
				stationMapMm: 500,
				record: { startDate: '2020-01-01', values: [null, 1, 2, null] }
			})
		).toMatchObject({ from: '2020-01-02', to: '2020-01-03' });
	});

	it('stationPatchChoices: every station of the input against a unit’s main station, over the run window', () => {
		const x = withP({ units: { A: { stationId: 'S' } } });
		const c = stationPatchChoices(x, { stationId: 'S' });
		expect(Object.keys(c)).toEqual(['P', 'S', 'T']);
		expect(c.S).toMatchObject({
			usable: false,
			reason: 'it is the main station'
		});
		expect(c.T).toMatchObject({ usable: false, fills: 0 });
		expect(c.T!.reason).toMatch(/^it has no reading on any of the main station’s \d+ gap days/);
		expect(c.P).toMatchObject({
			usable: true,
			gapDays: GAP.length + 5,
			fills: GAP.length + 5 - 1
		});
	});
});

describe('the CHIRPS level (issue #612): a gap day sits at the area’s MAP', () => {
	it('a run made only of CHIRPS days has the unit’s MAP as its mean annual rain, when the station’s MAP is its own mean annual', () => {
		for (const [mapA, phase] of [
			[900, 1],
			[450, 3],
			[1300, 5]
		] as const) {
			const x = catchment({
				unitRain: PER_UNIT,
				rainStations: { units: { A: { stationId: 'S' } }, sites: SITES }
			});
			x.model.nodes.find((n) => n.id === 'A')!.mapMm = mapA;
			x.series = {
				...x.series,
				'rain_chirps_mm@A': {
					startDate: START,
					values: rainOf(0.8, phase).map((v, i) => v * (1 + 0.3 * Math.sin(i / 40)))
				}
			};
			const s = x.series[stationSeriesKey('S')]!.values;
			const years = DAYS / 365.25;
			const meanAnnual = s.reduce<number>((acc, v) => acc + (v ?? 0), 0) / years;
			x.stations!.S = { ...x.stations!.S!, mapMm: meanAnnual };
			const base = runModel(x);
			// The CHIRPS-only member: S blanked, every day CHIRPS × the base's pinned factors.
			const { options } = resolveEnsembleOptions(x, {
				members: 30,
				rainSources: ['recorded', 'chirps']
			});
			const out = runModel(ensembleContext(x, options).chirps!);
			expect(out.summary.stations!.units.find((u) => u.nodeId === 'A')!.days).toMatchObject({ station: 0, chirps: DAYS });
			const total = col(out, 'rain_unit', 'A').reduce((acc, v) => acc + (v ?? 0), 0);
			// Within 2 %: the gaps in S's record (left out of the fit) are the only difference.
			expect(Math.abs(total / years - mapA) / mapA, `MAP ${mapA}`).toBeLessThan(0.02);
			expect(base.summary.stations!.pairings[0]!.ratio).toBeCloseTo(mapA / meanAnnual, 12);
		}
	});
});

describe('fit provenance of the pairing rule and the chain (issue #612)', () => {
	it('a fingerprint from before 1.105.0 (no marker) reads as changed, unit and catchment; another chain too', () => {
		const x = withP({
			units: { A: { stationId: 'S' } },
			catchment: { stationId: 'S' }
		});
		const out = runModel(x);
		const unit = unitRainFingerprintOfSummary(out.summary.unitRain, out.summary.stations)!;
		const a = unit.units.find((u) => u.nodeId === 'A')!;
		expect(a).toMatchObject({
			stationFit: 'adjusted',
			stationPatch: ['chirps']
		});
		expect(unitRainFingerprintChanged(unit, structuredClone(unit))).toBe(false);
		const old = structuredClone(unit);
		delete old.units.find((u) => u.nodeId === 'A')!.stationFit;
		delete old.units.find((u) => u.nodeId === 'A')!.stationPatch;
		expect(unitRainFingerprintChanged(old, unit)).toBe(true);
		const chain = structuredClone(unit);
		chain.units.find((u) => u.nodeId === 'A')!.stationPatch = ['station:P', 'chirps'];
		expect(unitRainFingerprintChanged(chain, unit)).toBe(true);
		const fp = catchmentStationFingerprint(out.summary.stations)!;
		expect(fp).toMatchObject({ stationFit: 'adjusted', patch: ['chirps'] });
		expect(catchmentStationFingerprintError(fp)).toBeNull();
		expect(catchmentStationFingerprintError({ ...fp, stationFit: 'raw' })).toMatch(/marker/);
		const { stationFit: _m, patch: _p, ...before } = fp;
		expect(catchmentStationFingerprintChanged(before, fp)).toBe(true);
		expect(catchmentStationFingerprintChanged({ ...fp, patch: ['station:P'] }, fp)).toBe(true);
		// The Settings form (no run): a chain other than the fit's is a change.
		expect(catchmentStationSettingChanged({ catchment: { stationId: 'S', patch: [{ source: 'chirps' }] } }, fp)).toBe(false);
		expect(
			catchmentStationSettingChanged(
				{
					catchment: {
						stationId: 'S',
						patch: [{ source: 'station', stationId: 'P' }, { source: 'chirps' }]
					}
				},
				fp
			)
		).toBe(true);
	});

	it('the Settings form sees a unit’s chain change against the fit', () => {
		const ctxOf = (x: ModelInput) => ({
			settings: settingsOf(x),
			validate: false,
			validationRecord: null,
			engineVersion: 'test',
			fittedAt: '2026-10-28T00:00:00Z'
		});
		const x = withP({ units: { A: { stationId: 'S' } } });
		const record = fitRecordFromReport(calibrate(x, { budget: 10, seed: 1 }), ctxOf(x));
		expect(fitRecordStatus(settingsOf(x), record).forcingChanged).toBe(false);
		const chained = withP({
			units: {
				A: {
					stationId: 'S',
					patch: [{ source: 'station', stationId: 'P' }, { source: 'chirps' }]
				}
			}
		});
		expect(fitRecordStatus(settingsOf(chained), record).forcingChanged).toBe(true);
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
			shape: "ac1555d75f0ec526",
			series: {
				"natural_flow@": {
					sum: 128449487.38522124,
					sumSq: 12411305812885.041,
					weighted: 192135434.12114853
				},
				"rain_used@": {
					sum: 11727.698612054523,
					sumSq: 426909.59848762874,
					weighted: 17548.738045071306
				},
				"rain_unit@A": {
					sum: 14524.799999999876,
					sumSq: 882570.2400000049,
					weighted: 21822.355599603572
				},
				"runoff_natural@A": {
					sum: 87886716.2949189,
					sumSq: 6630405712440.632,
					weighted: 131848114.54363628
				},
				"rain_unit@B": {
					sum: 9686.236924519457,
					sumSq: 392535.0123451333,
					weighted: 14522.674313401616
				},
				"runoff_natural@B": {
					sum: 26057643.78572906,
					sumSq: 495478118816.12683,
					weighted: 38978625.34355641
				},
				"rain_unit@C": {
					sum: 9310.80000000008,
					sumSq: 382944.4800000019,
					weighted: 13985.253121902873
				},
				"runoff_natural@C": {
					sum: 12221040.651818946,
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
				sum: 941785191.317333,
				sumSq: 67225262324328.68,
				weighted: 1410857194.2589192
			},
			summary: {
				sum: 52289.393773014956,
				sumSq: 53819957.745771684,
				weighted: 77631.11138236058
			}
		},
		catchment: {
			shape: "9ef861481d952b7d",
			series: {
				"natural_flow@": {
					sum: 139036884.13131243,
					sumSq: 15253739085967.236,
					weighted: 208092671.15366083
				},
				"rain_used@": {
					sum: 12399.004364569928,
					sumSq: 643128.281687236,
					weighted: 18560.278106540507
				},
				"rain_final@": {
					sum: 12399.004364569928,
					sumSq: 643128.281687236,
					weighted: 18638.883760659843
				}
			},
			rest: {
				sum: 1015456949.4520895,
				sumSq: 68071024411652.23,
				weighted: 1521261352.5445035
			},
			summary: {
				sum: 25414.456551038187,
				sumSq: 25721476.42279408,
				weighted: 37724.807020861255
			}
		},
		both: {
			shape: "521b4d9dcf0f2078",
			series: {
				"natural_flow@": {
					sum: 71118750.87790546,
					sumSq: 3682781115155.2305,
					weighted: 106456204.4606722
				},
				"rain_used@": {
					sum: 8257.839897304297,
					sumSq: 223803.33476563872,
					weighted: 12349.312072849607
				},
				"rain_unit@A": {
					sum: 9683.2,
					sumSq: 392253.43999999727,
					weighted: 14548.237066402382
				},
				"runoff_natural@A": {
					sum: 43411054.420888096,
					sumSq: 1375291381002.549,
					weighted: 65109267.849879235
				},
				"rain_unit@B": {
					sum: 3599.999999999979,
					sumSq: 54216.80968071774,
					weighted: 5423.116996600983
				},
				"runoff_natural@B": {
					sum: 1719329.4970369388,
					sumSq: 1842740815.3652284,
					weighted: 2578325.6607300495
				},
				"rain_unit@C": {
					sum: 11300.82619883047,
					sumSq: 533914.6496376487,
					weighted: 16934.60882467152
				},
				"runoff_natural@C": {
					sum: 17325577.973320175,
					sumSq: 228318495894.3953,
					weighted: 26056886.40737766
				},
				"rain_unit@D": {
					sum: 11300.82619883047,
					sumSq: 533914.6496376487,
					weighted: 17046.598075101854
				},
				"runoff_natural@D": {
					sum: 8662788.986660087,
					sumSq: 57079623973.59882,
					weighted: 12957146.950765396
				},
				"rain_final@": {
					sum: 11300.82619883047,
					sumSq: 533914.6496376487,
					weighted: 16882.320658865534
				}
			},
			rest: {
				sum: 539900904.9778585,
				sumSq: 18629409593374.035,
				weighted: 809543615.9372909
			},
			summary: {
				sum: 46986.50379941149,
				sumSq: 44512235.38133074,
				weighted: 71708.037692478
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

	// Settings → Model selection for flow generation (issue #553 round 3): the form has no run, so the settings alone must say a method switch and a unit's station change.
	describe('the Model selection for flow generation form, without a run', () => {
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
