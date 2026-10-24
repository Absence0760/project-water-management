// The Data tab's derived rain lines (issue #553 round 5): the rain used is the
// run's own, to the bit, and the corrected CHIRPS and station × ratio are the
// products the run makes on its CHIRPS and station days. Synthetic catchment:
// invented values only (public repo).
import { describe, expect, it } from 'vitest';
import { runModel, stationSeriesKey, toEpochDay, type ModelInput, type RainStationSettings } from '@water-management/engine';
import { areaRainLines, sourceCounts, sourceLanes, sourceSummary } from './derivedRain';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const START = '2015-01-01';
const D0 = toEpochDay(START);
const DAYS = toEpochDay('2021-01-01') - D0; // six whole calendar years
const rainOf = (k: number, phase = 0) => Array.from({ length: DAYS }, (_, i) => ((i + phase) % 13 === 0 ? 30 * k : (i + phase) % 4 === 0 ? 2 * k : 0));
const GAP = [69, 70, 71]; // 11–13 March 2015: S has no reading

function input(rainStations: RainStationSettings, perUnit = true): ModelInput {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const unit = (id: string, areaKm2: number, mapMm: number) => ({ ...node, id, name: `Unit ${id}`, kind: 'farm' as const, downstreamNodeId: 'G', areaKm2, mapMm, mapSource: 'invented' });
	const s: (number | null)[] = rainOf(1.6, 1);
	for (const t of GAP) s[t] = null;
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, ...(perUnit ? { unitRain: { mode: 'perUnit' } } : {}), rainStations },
		model: {
			nodes: [{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 }, unit('A', 10, 900), unit('B', 6, 600)],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: rainOf(1) },
			rain_chirps_mm: { startDate: START, values: rainOf(0.7, 2) },
			'rain_chirps_mm@A': { startDate: START, values: rainOf(0.8, 1) },
			'rain_chirps_mm@B': { startDate: START, values: rainOf(0.5, 3) },
			[stationSeriesKey('S')]: { startDate: START, values: s },
			// Four complete calendar years only: a pairing on T is refused.
			[stationSeriesKey('T')]: { startDate: '2017-01-01', values: rainOf(1.2, 5).slice(toEpochDay('2017-01-01') - D0) },
			flow_observed_m3s: { startDate: START, values: Array.from({ length: DAYS }, (_, i) => 0.1 + 0.4 * Math.exp(-(i % 13) / 3)) }
		},
		stations: {
			S: { name: 'Station S', mapMm: 600, mapSource: 'invented', lat: null, lon: null },
			T: { name: 'Station T', mapMm: 500, mapSource: 'invented', lat: null, lon: null }
		}
	};
}

type Out = ReturnType<typeof runModel>;
const col = (out: Out, key: string, nodeId: string | null = null) => out.series.find((s) => s.nodeId === nodeId && s.key === key)!.values;
const SITES = { S: { unitId: 'A' } };

describe('areaRainLines for a unit', () => {
	const x = input({ units: { A: { stationId: 'S' }, B: { stationId: 'S', correctAgainst: 'T' } }, sites: SITES });
	const out = runModel(x);

	it('the rain used is the run’s rain_unit, to the bit, with the run’s day counts', () => {
		const a = areaRainLines(x, 'A')!;
		expect(a.rainUsed).toEqual(col(out, 'rain_unit', 'A'));
		const forcing = out.summary.stations!.units.find((u) => u.nodeId === 'A')!;
		expect(a.forcing).toEqual(forcing);
		expect(sourceCounts(a.source).station).toBe(forcing.days.station);
		expect(sourceCounts(a.source).chirps).toBe(forcing.days.chirps);
		expect(a.forcing.ratio).toBe(900 / 600);
	});

	it('on a station day the rain used is the station × ratio, on a CHIRPS day the corrected CHIRPS', () => {
		const a = areaRainLines(x, 'A')!;
		const fit = out.summary.stations!.pairings.find((p) => p.stationId === 'S')!;
		expect(a.factors).toEqual(fit.months.map((m) => m.factor));
		let station = 0;
		let chirps = 0;
		for (let t = 0; t < a.rainUsed.length; t++) {
			if (a.source[t] === 'station') {
				station++;
				expect(a.rainUsed[t]).toBe(a.stationScaled[t]);
			} else if (a.source[t] === 'chirps') {
				chirps++;
				expect(a.rainUsed[t]).toBe(a.chirpsCorrected![t]);
			}
		}
		expect(station).toBeGreaterThan(0);
		expect(chirps).toBe(GAP.length);
		// The corrected CHIRPS covers every day of the unit's CHIRPS, not only the gaps: raw × the month's factor.
		const march = 70; // 12 March 2015
		expect(a.chirpsCorrected![march]).toBe(a.chirpsRaw![march]! * a.factors![2]!);
		expect(a.chirpsRaw).toEqual(rainOf(0.8, 1));
		expect(a.stationRaw[GAP[0]!]).toBeNull();
	});

	it('a refused pairing gives no corrected CHIRPS and says why; its gaps fall to the next fallback', () => {
		const b = areaRainLines(x, 'B')!;
		expect(b.correctAgainst).toBe('T');
		// T stands in no unit and has no cell series of its own, so its pairing has no CHIRPS to fit on.
		expect(b.refused).toMatch(/no CHIRPS at the station/);
		expect(b.factors).toBeNull();
		expect(b.chirpsCorrected).toBeNull();
		expect(b.chirpsRaw).not.toBeNull();
		expect(b.rainUsed).toEqual(col(out, 'rain_unit', 'B'));
		expect(sourceCounts(b.source).chirps).toBe(0);
	});

	it('null for a unit without a station, or with per-unit rain off', () => {
		expect(areaRainLines(input({ units: { A: { stationId: 'S' } }, sites: SITES }), 'B')).toBeNull();
		expect(areaRainLines(input({ units: { A: { stationId: 'S' } }, sites: SITES }, false), 'A')).toBeNull();
	});
});

describe('areaRainLines for the catchment', () => {
	it('the rain used is the run’s rain_used, the catchment CHIRPS corrected against the catchment’s station', () => {
		const x = input({ catchment: { stationId: 'S' }, sites: SITES }, false);
		const out = runModel(x);
		const c = areaRainLines(x, null)!;
		expect(c.rainUsed).toEqual(col(out, 'rain_used'));
		expect(c.chirpsRaw).toEqual(rainOf(0.7, 2));
		for (let t = 0; t < c.rainUsed.length; t++) if (c.source[t] === 'chirps') expect(c.rainUsed[t]).toBe(c.chirpsCorrected![t]);
		const map = (10 * 900 + 6 * 600) / 16;
		expect(c.forcing.ratio).toBe(map / 600);
		expect(areaRainLines(input({ units: { A: { stationId: 'S' } } }, false), null)).toBeNull();
	});
});

describe('the source strip and summary', () => {
	it('one lane per source other than the station, its days as ranges and in words', () => {
		const lanes = sourceLanes('2021-01-30', ['station', 'chirps', 'chirps', 'station', 'fallback', 'chirps']);
		expect(lanes.map((l) => l.label)).toEqual(['Corrected CHIRPS', 'Next fallback']);
		expect(lanes[0]!.ranges).toEqual([
			{ start: '2021-01-31', end: '2021-02-01' },
			{ start: '2021-02-04', end: '2021-02-04' }
		]);
		expect(lanes[0]!.text).toBe('3 days from corrected CHIRPS (the station has no reading, or it was set aside)');
		expect(lanes[1]!.text).toMatch(/^1 day from the next fallback/);
		expect(sourceLanes('2021-01-01', ['station', 'station'])).toEqual([]);
		expect(sourceSummary(['station', 'station', 'chirps', 'none'])).toBe('2 days from the station, 1 from corrected CHIRPS, 1 with no rain from any source.');
	});
});
