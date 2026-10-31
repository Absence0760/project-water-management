// unitAreaRain (issue #613 slice 2): a unit without a station, its §2.4h links
// beside the run's rain_unit. Synthetic catchment: invented values only.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import type { ModelInput, UnitRainSettings } from '../project';
import { runModel } from '../run';
import { stationAreaRain } from './stationAreaRain';
import { stationSeriesKey } from '../project';
import { unitAreaRain, type UnitAreaRain } from './unitAreaRain';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const START = '2015-01-01';
const DAYS = toEpochDay('2021-01-01') - toEpochDay(START);
const rainOf = (k: number, phase = 0) => Array.from({ length: DAYS }, (_, i) => ((i + phase) % 13 === 0 ? 30 * k : (i + phase) % 4 === 0 ? 2 * k : 0));

function catchment(unitRain: UnitRainSettings): ModelInput {
	const node = { sortOrder: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const unit = (id: string, areaKm2: number, mapMm?: number) => ({ ...node, id, name: `Unit ${id}`, kind: 'farm' as const, downstreamNodeId: 'G', areaKm2, ...(mapMm ? { mapMm, mapSource: 'invented' } : {}) });
	const gauge: (number | null)[] = rainOf(1.3, 2);
	for (const t of [10, 11, 12, 400]) gauge[t] = null;
	const catchmentRain: (number | null)[] = rainOf(1);
	for (const t of [20, 21]) catchmentRain[t] = null;
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, unitRain },
		model: {
			nodes: [{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 }, unit('A', 10), unit('B', 6, 700), unit('C', 3, 750), unit('D', 1.5)],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: catchmentRain },
			'rain_catchment_mm@A': { startDate: START, values: gauge },
			'rain_chirps_mm@A': { startDate: START, values: rainOf(0.8, 1) },
			'rain_chirps_mm@C': { startDate: '2014-06-01', values: [...new Array(214).fill(1), ...rainOf(0.5, 3)] },
			flow_observed_m3s: { startDate: START, values: Array.from({ length: DAYS }, (_, i) => 0.1 + 0.4 * Math.exp(-(i % 13) / 3)) }
		}
	};
}

type Out = ReturnType<typeof runModel>;
const col = (out: Out, nodeId: string) => out.series.find((s) => s.nodeId === nodeId && s.key === 'rain_unit')!.values;

/** Each day's rain used is the link its source names (to the bit), and a dry day reads none. */
function linksAgree(r: UnitAreaRain): void {
	for (let t = 0; t < r.rainMm.length; t++) {
		const s = r.source[t]!;
		const link = s === 'unitGauge' ? r.ownGauge![t] : s === 'gaugeMap' ? r.gaugeScaled![t] : s === 'unitChirps' ? r.chirpsLevelled![t] : undefined;
		if (link !== undefined) expect(r.rainMm[t], `${r.nodeId} day ${t} (${s})`).toBe(Math.max(0, link!));
		if (s === 'none') expect(r.rainMm[t]).toBe(0);
	}
}

describe('unitAreaRain', () => {
	it('rules 1 and 2: the own gauge, then the catchment gauge × MAP ratio, to the bit with the run', () => {
		const x = catchment({ mode: 'perUnit', gaugeMapMm: 500, gaugeMapSource: 'invented' });
		const out = runModel(x);
		const a = unitAreaRain(x, 'A')!;
		expect(a.rule).toBe('unitGauge');
		expect(a.rainMm).toEqual(col(out, 'A'));
		expect(a.ownGauge![10]).toBeNull();
		expect(a.ownGauge![0]).toBe((x.series['rain_catchment_mm@A']!.values as number[])[0]);
		// A has no MAP: no ratio, so its gauge's gaps fill from its CHIRPS (raw: no MAP to level it, no §2.4b factors).
		expect(a.gaugeScaled).toBeNull();
		expect(a.source[10]).toBe('unitChirps');
		expect(a.chirpsLevelled).toEqual(a.chirpsRaw);
		linksAgree(a);
		const b = unitAreaRain(x, 'B')!;
		expect(b).toMatchObject({ rule: 'gaugeMap', mapMm: 700, gaugeMapMm: 500, ownGauge: null, chirpsRaw: null, chirpsLevelled: null });
		expect(b.gaugeScaled![0]).toBe((x.series.rain_catchment_mm!.values[0] as number) * (700 / 500));
		expect(b.rainMm).toEqual(col(out, 'B'));
		expect(b.source[20]).toBe('none');
		expect(b.source[0]).toBe('gaugeMap');
		linksAgree(b);
	});

	it('rules 3 and 4: own CHIRPS levelled to the MAP, and the catchment rain', () => {
		const x = catchment({ mode: 'perUnit' });
		const out = runModel(x);
		const c = unitAreaRain(x, 'C')!;
		expect(c.rule).toBe('unitChirps');
		expect(c.recipe.chirps?.source).toBe('map');
		const k = (c.recipe.chirps as { factor: number }).factor;
		expect(c.chirpsLevelled![0]).toBe(c.chirpsRaw![0]! * k);
		expect(c.rainMm).toEqual(col(out, 'C'));
		expect(c.source.every((s) => s === 'unitChirps' || s === 'none')).toBe(true);
		linksAgree(c);
		const d = unitAreaRain(x, 'D')!;
		expect(d).toMatchObject({ rule: 'catchment', ownGauge: null, gaugeScaled: null, chirpsRaw: null, chirpsLevelled: null, mapMm: null, gaugeMapMm: null });
		expect(d.rainMm).toEqual(col(out, 'D'));
		expect(d.source[0]).toBe('catchment');
		expect(d.source[20]).toBe('none');
	});

	it('null for a node that isn’t a land unit and for a unit on its station; the retired catchment mode reads as Per unit', () => {
		expect(unitAreaRain(catchment({ mode: 'catchment' }), 'A')).toEqual(unitAreaRain(catchment({ mode: 'perUnit' }), 'A'));
		expect(unitAreaRain(catchment({ mode: 'perUnit' }), 'G')).toBeNull();
		expect(unitAreaRain(catchment({ mode: 'perUnit' }), 'nope')).toBeNull();
		const x = catchment({ mode: 'perUnit' });
		(x.series as Record<string, unknown>)[stationSeriesKey('S')] = { startDate: START, values: rainOf(1.6, 1) };
		x.stations = { S: { name: 'Station S', mapMm: 600, mapSource: 'invented', lat: null, lon: null } };
		x.settings.rainStations = { units: { B: { stationId: 'S' } } };
		expect(stationAreaRain(x, 'B')).not.toBeNull();
		expect(unitAreaRain(x, 'B')).toBeNull();
		// The others keep their chain beside it, to the bit.
		expect(unitAreaRain(x, 'C')!.rainMm).toEqual(col(runModel(x), 'C'));
	});
});
