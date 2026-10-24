// Bit-identical guard for the rain forcing (issue #553). Rainfall stations
// (round 2) rewrite the per-unit forcing (./unitRain.ts) and the catchment
// forcing as "station × (area MAP ÷ station MAP), bias-corrected CHIRPS on the
// gaps", and today's projects must run exactly as before once migrated. Each
// case below runs one of today's forcing paths on a small synthetic catchment
// and pins a fingerprint of what came out:
// - `series`: a 64-bit hash over every output series' node, key and the bits
//   of every value. The non-negotiable pin: a different value anywhere fails.
// - `sums`: per output series of rain and flow, its sum to 6 significant
//   digits, so a failure shows where the run moved (diff these first).
// - `units`: per land unit, the rule, record and factor the run chose and
//   its days by source (summary.unitRain). A station rewrite may record
//   more (the station, both MAPs), never a different level or day count.
// - `summary`: a hash of the rest of the summary (warnings included).
// An intended change of the forcing updates these values in the same change
// as its ENGINE_VERSION bump, saying why; any other difference is a bug.
// Synthetic catchment: invented values only (public repo). Builders follow
// ./unitRain.test.ts and ./unitRain.reference.test.ts.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { referenceCellSeriesKey, type ModelInput, type ModelOutput, type UnitRainSettings } from '../project';
import { runModel } from '../run';
import { Hasher } from '../warmstart/plain';

const apan = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep
const START = '2015-01-01';
const DAYS = toEpochDay('2021-01-01') - toEpochDay(START); // six whole calendar years
const rainOf = (k: number, phase = 0) => Array.from({ length: DAYS }, (_, i) => ((i + phase) % 13 === 0 ? 30 * k : (i + phase) % 4 === 0 ? 2 * k : 0));
/** Blank a few runs of days (gaps the forcing has to fill). */
const withGaps = (v: (number | null)[], from: number[]): (number | null)[] => {
	const out = [...v];
	for (const t of from) for (let d = 0; d < 9; d++) out[t + d] = null;
	return out;
};

/** A gauge with four land units above it (A–D) and a no-area farm E; catchment gauge rain and catchment CHIRPS over six years, observed flow at the outlet. */
function catchment(unitRain: UnitRainSettings | 'absent'): ModelInput {
	const node = { sortOrder: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
	const unit = (id: string, areaKm2: number) => ({ ...node, id, name: `Unit ${id}`, kind: 'farm' as const, downstreamNodeId: 'G', areaKm2 });
	return {
		settings: { runoffModel: 'gr4j', apanMm: apan as never, ...(unitRain !== 'absent' ? { unitRain } : {}) },
		model: {
			nodes: [{ ...node, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 }, unit('A', 10), unit('B', 6), unit('C', 3), unit('D', 1.5), unit('E', 0)],
			crops: [{ id: 'c', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [{ nodeId: 'A', cropId: 'c', areaM2: 100_000 }],
			transfers: []
		},
		series: {
			rain_catchment_mm: { startDate: START, values: withGaps(rainOf(1), [40, 700, 1500]) },
			rain_chirps_mm: { startDate: START, values: rainOf(0.8, 1) },
			flow_observed_m3s: { startDate: START, values: Array.from({ length: DAYS }, (_, i) => 0.1 + 0.4 * Math.exp(-(i % 13) / 3)) }
		}
	};
}

const set = (x: ModelInput, key: string, values: (number | null)[]) => ((x.series as Record<string, unknown>)[key] = { startDate: START, values });
const setMap = (x: ModelInput, id: string, mapMm: number) => Object.assign(x.model.nodes.find((n) => n.id === id)!, { mapMm, mapSource: 'invented' });

/** Today's forcing paths, one case each. */
const CASES: Record<string, () => ModelInput> = {
	/** Fragmentation: unitRain off, GR4J once on the catchment gauge with corrected CHIRPS on its gaps. */
	fragmentation: () => catchment('absent'),
	/** perUnit, rule 2: the catchment gauge (with gaps) × unit MAP ÷ gauge MAP; D has no MAP (rule 4). */
	gaugeMap: () => {
		const x = catchment({ mode: 'perUnit', gaugeMapMm: 650, gaugeMapSource: 'invented gauge MAP' });
		setMap(x, 'A', 820);
		setMap(x, 'B', 700);
		setMap(x, 'C', 540);
		return x;
	},
	/** perUnit, rule 1: A and B their own gauge (`rain_catchment_mm@<unit>`, with gaps), A's gaps from its CHIRPS; C rule 2; D rule 4. */
	unitGauge: () => {
		const x = catchment({ mode: 'perUnit', gaugeMapMm: 650, gaugeMapSource: 'invented gauge MAP' });
		set(x, 'rain_catchment_mm@A', withGaps(rainOf(1.3, 2), [10, 400, 1800]));
		set(x, 'rain_chirps_mm@A', rainOf(0.8, 1));
		set(x, 'rain_catchment_mm@B', withGaps(rainOf(0.9, 5), [900]));
		setMap(x, 'A', 900);
		setMap(x, 'C', 600);
		return x;
	},
	/** perUnit, rule 3 under the reference gauge's monthly factors (the catchment gauge against the cell under C), each unit × k_unit where it has a MAP. */
	reference: () => {
		const x = catchment({ mode: 'perUnit', reference: { gauge: 'rain_catchment_mm', unitId: 'C' } });
		set(x, 'rain_chirps_mm@A', rainOf(0.7, 1));
		set(x, 'rain_chirps_mm@B', rainOf(0.6, 2));
		set(x, 'rain_chirps_mm@C', rainOf(0.5, 0));
		set(x, 'rain_chirps_mm@D', rainOf(0.4, 3));
		set(x, referenceCellSeriesKey('C'), rainOf(0.5).map((v, i) => (i % 97 === 0 ? null : v * (1 + 0.3 * Math.sin(i / 58)))));
		setMap(x, 'A', 900);
		setMap(x, 'B', 750);
		setMap(x, 'C', 600);
		return x;
	}
};

/** The output series the forcing reaches first: the rain each run or unit read, where it came from, and the flow it made. */
const SUMMED = /^(rain_used|rain_final|rain_chirps_corrected|rain_source|rain_unit|runoff_natural|runoff|natural_flow)$/;

function fingerprint(out: ModelOutput) {
	const h = new Hasher();
	for (const s of out.series) {
		h.text(s.nodeId ?? '').text(s.key).number(s.values.length);
		for (const v of s.values) h.number(v);
	}
	const sums: Record<string, number> = {};
	for (const s of out.series)
		if (SUMMED.test(s.key)) sums[`${s.key}@${s.nodeId ?? ''}`] = Number(s.values.reduce((a, v) => a + v, 0).toPrecision(6));
	const units = out.summary.unitRain?.units.map((u) => ({ nodeId: u.nodeId, rule: u.rule, rainKey: u.rainKey, factor: u.factor === null ? null : Number(u.factor.toPrecision(9)), chirps: u.chirps?.source ?? null, days: u.days })) ?? null;
	const { unitRain: _unitRain, ...rest } = out.summary;
	return { series: h.digest(), sums, units, summary: new Hasher().text(JSON.stringify(rest)).digest() };
}

/**
 * Expected fingerprints, from the engine before rainfall stations (issue #553 round 1): the
 * parent of the commit that added this file gives the same values. Print them with
 * `GOLDEN_PRINT=1 pnpm -C packages/engine exec vitest run src/runoff/unitRain.golden.test.ts`.
 */
const EXPECTED: Record<string, ReturnType<typeof fingerprint>> = {
	fragmentation: {
		series: '102424779164e0da',
		sums: {
			'natural_flow@': 31197400,
			'rain_used@': 6075.61,
			'rain_final@': 6075.61,
			'rain_chirps_corrected@': 6075.61,
			'rain_source@': 54,
			'runoff@A': 15218200,
			'runoff@B': 9130940,
			'runoff@C': 4565470,
			'runoff@D': 2282730,
			'runoff@E': 0
		},
		units: null,
		summary: '9f9a12280e29d969'
	},
	gaugeMap: {
		series: '370eb278c4d9bdc3',
		sums: {
			'natural_flow@': 42767800,
			'rain_used@': 6837.05,
			'rain_unit@A': 7664.61,
			'runoff_natural@A': 26747100,
			'rain_unit@B': 6542.96,
			'runoff_natural@B': 11043500,
			'rain_unit@C': 5047.43,
			'runoff_natural@C': 2694410,
			'rain_unit@D': 6075.61,
			'runoff_natural@D': 2282730,
			'rain_final@': 6075.61,
			'rain_chirps_corrected@': 6075.61,
			'rain_source@': 54,
			'runoff@A': 26747100,
			'runoff@B': 11043500,
			'runoff@C': 2694410,
			'runoff@D': 2282730,
			'runoff@E': 0
		},
		units: [
			{
				nodeId: 'A',
				rule: 'gaugeMap',
				rainKey: 'rain_catchment_mm',
				factor: 1.26153846,
				chirps: null,
				days: { unitGauge: 0, gaugeMap: 2165, unitChirps: 0, catchment: 27, forecast: 0, none: 0 }
			},
			{
				nodeId: 'B',
				rule: 'gaugeMap',
				rainKey: 'rain_catchment_mm',
				factor: 1.07692308,
				chirps: null,
				days: { unitGauge: 0, gaugeMap: 2165, unitChirps: 0, catchment: 27, forecast: 0, none: 0 }
			},
			{
				nodeId: 'C',
				rule: 'gaugeMap',
				rainKey: 'rain_catchment_mm',
				factor: 0.830769231,
				chirps: null,
				days: { unitGauge: 0, gaugeMap: 2165, unitChirps: 0, catchment: 27, forecast: 0, none: 0 }
			},
			{
				nodeId: 'D',
				rule: 'catchment',
				rainKey: null,
				factor: null,
				chirps: null,
				days: { unitGauge: 0, gaugeMap: 0, unitChirps: 0, catchment: 2192, forecast: 0, none: 0 }
			}
		],
		summary: '3218f881e68dd310'
	},
	unitGauge: {
		series: '34a6572c07845e2b',
		sums: {
			'natural_flow@': 40724500,
			'rain_used@': 6668.56,
			'rain_unit@A': 7823.41,
			'runoff_natural@A': 28113000,
			'rain_unit@B': 5422.2,
			'runoff_natural@B': 6658310,
			'rain_unit@C': 5608.25,
			'runoff_natural@C': 3670440,
			'rain_unit@D': 6075.61,
			'runoff_natural@D': 2282730,
			'rain_final@': 6075.61,
			'rain_chirps_corrected@': 6075.61,
			'rain_source@': 54,
			'runoff@A': 28113000,
			'runoff@B': 6658310,
			'runoff@C': 3670440,
			'runoff@D': 2282730,
			'runoff@E': 0
		},
		units: [
			{
				nodeId: 'A',
				rule: 'unitGauge',
				rainKey: 'rain_catchment_mm@A',
				factor: 1,
				chirps: 'map',
				days: { unitGauge: 2165, gaugeMap: 0, unitChirps: 27, catchment: 0, forecast: 0, none: 0 }
			},
			{
				nodeId: 'B',
				rule: 'unitGauge',
				rainKey: 'rain_catchment_mm@B',
				factor: 1,
				chirps: null,
				days: { unitGauge: 2183, gaugeMap: 0, unitChirps: 0, catchment: 9, forecast: 0, none: 0 }
			},
			{
				nodeId: 'C',
				rule: 'gaugeMap',
				rainKey: 'rain_catchment_mm',
				factor: 0.923076923,
				chirps: null,
				days: { unitGauge: 0, gaugeMap: 2165, unitChirps: 0, catchment: 27, forecast: 0, none: 0 }
			},
			{
				nodeId: 'D',
				rule: 'catchment',
				rainKey: null,
				factor: null,
				chirps: null,
				days: { unitGauge: 0, gaugeMap: 0, unitChirps: 0, catchment: 2192, forecast: 0, none: 0 }
			}
		],
		summary: 'ab52b76e25e889ef'
	},
	reference: {
		series: 'c95d231cbe299669',
		sums: {
			'natural_flow@': 17320200,
			'rain_used@': 4848.6,
			'rain_unit@A': 5400,
			'runoff_natural@A': 11214300,
			'rain_unit@B': 4500,
			'runoff_natural@B': 3840620,
			'rain_unit@C': 3600,
			'runoff_natural@C': 875976,
			'rain_unit@D': 5064.18,
			'runoff_natural@D': 1389290,
			'rain_final@': 6075.61,
			'rain_chirps_corrected@': 6075.61,
			'rain_source@': 54,
			'runoff@A': 11214300,
			'runoff@B': 3840620,
			'runoff@C': 875976,
			'runoff@D': 1389290,
			'runoff@E': 0
		},
		units: [
			{
				nodeId: 'A',
				rule: 'unitChirps',
				rainKey: 'rain_chirps_mm@A',
				factor: null,
				chirps: 'reference',
				days: { unitGauge: 0, gaugeMap: 0, unitChirps: 2192, catchment: 0, forecast: 0, none: 0 }
			},
			{
				nodeId: 'B',
				rule: 'unitChirps',
				rainKey: 'rain_chirps_mm@B',
				factor: null,
				chirps: 'reference',
				days: { unitGauge: 0, gaugeMap: 0, unitChirps: 2192, catchment: 0, forecast: 0, none: 0 }
			},
			{
				nodeId: 'C',
				rule: 'unitChirps',
				rainKey: 'rain_chirps_mm@C',
				factor: null,
				chirps: 'reference',
				days: { unitGauge: 0, gaugeMap: 0, unitChirps: 2192, catchment: 0, forecast: 0, none: 0 }
			},
			{
				nodeId: 'D',
				rule: 'unitChirps',
				rainKey: 'rain_chirps_mm@D',
				factor: null,
				chirps: 'reference',
				days: { unitGauge: 0, gaugeMap: 0, unitChirps: 2192, catchment: 0, forecast: 0, none: 0 }
			}
		],
		summary: 'e36887de38e5aa07'
	}
};

describe('the rain forcing stays bit-identical (issue #553 guard)', () => {
	for (const [name, build] of Object.entries(CASES))
		it(name, () => {
			const got = fingerprint(runModel(build()));
			if (process.env.GOLDEN_PRINT) console.log(name, JSON.stringify(got));
			const want = EXPECTED[name]!;
			// The readable parts first, so a failure shows where the run moved before the hashes say that it did.
			expect(got.units).toEqual(want.units);
			expect(got.sums).toEqual(want.sums);
			expect(got.series).toBe(want.series);
			expect(got.summary).toBe(want.summary);
		});

	it('runs every case twice to the same bits (the fingerprint is deterministic)', () => {
		for (const build of Object.values(CASES)) expect(fingerprint(runModel(build()))).toEqual(fingerprint(runModel(build())));
	});
});
