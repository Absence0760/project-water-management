// Bit-identical guard for the rain forcing (issue #553). Rainfall stations
// (round 2) rewrite the per-unit forcing (./unitRain.ts) and the catchment
// forcing as "station × (area MAP ÷ station MAP), bias-corrected CHIRPS on the
// gaps", and today's projects must run exactly as before once migrated. Each
// case below runs one of today's forcing paths on a small synthetic catchment
// and pins a fingerprint of what came out:
// - `golden` (../testing/golden.ts): exact, which series exist, their
//   lengths and the summary's text; then per output series of rain and flow,
//   and for the rest together and the summary's numbers, a sum, sum of squares
//   and position-weighted sum, compared at 1e-9 relative. Not a hash of every
//   value's bits: identical code gives last-bit different floats on macOS
//   arm64 and on CI's Linux, so a bit hash can't hold on both.
// - `units`: per land unit, the rule, record and factor the run chose and
//   its days by source (summary.unitRain). A station rewrite may record
//   more (the station, both MAPs), never a different level or day count.
// An intended change of the forcing updates these values in the same change
// as its ENGINE_VERSION bump, saying why; any other difference is a bug.
// Synthetic catchment: invented values only (public repo). Builders follow
// ./unitRain.test.ts and ./unitRain.reference.test.ts.
import { describe, expect, it } from 'vitest';
import { toEpochDay } from '../calendar';
import { referenceCellSeriesKey, type ModelInput, type ModelOutput, type UnitRainSettings } from '../project';
import { runModel } from '../run';
import { goldenDiff, goldenFingerprint } from '../testing/golden';

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
	const units = out.summary.unitRain?.units.map((u) => ({ nodeId: u.nodeId, rule: u.rule, rainKey: u.rainKey, factor: u.factor === null ? null : Number(u.factor.toPrecision(9)), chirps: u.chirps?.source ?? null, days: u.days })) ?? null;
	// The EWR split's record (engine ≥ 1.94.0, issue #553 round 4) is new fields beside the old ones, not a change to them:
	// left out, so the rest of every case, the EWR split by the flow share included, is still pinned as it was. So are
	// the warnings' codes (engine ≥ 1.102.0, issue #611): each is a warning's text again, which `warnings` pins.
	const { unitRain: _unitRain, ewrSplit: _ewrSplit, warningCodes: _warningCodes, ...rest } = out.summary;
	const farms = rest.farms.map(({ ewrShare: _ewrShare, ...f }) => f);
	return { units, golden: goldenFingerprint(out, SUMMED, { ...rest, farms }) };
}

/**
 * Expected fingerprints, from the engine before rainfall stations' forcing: computed on
 * 195e66c86 (issue #553 round 1, pushed), which gives the same values on macOS and Linux; the shapes re-pinned at
 * engine 1.98.0, whose warnings name Model settings and Calibration (issue #586 round 3: text only, every series'
 * sums unchanged), and unitGauge's and reference's at 1.100.0, whose warnings write their days day first (#586 R4-O:
 * text only, every series' and the summary's sums unchanged), and fragmentation's at 1.105.0, whose run notes the
 * units its EWR shares put on the catchment rain (issue #615: a note's text only; the forcing, every series' and the
 * summary's sums unchanged). Print them with
 * `GOLDEN_PRINT=1 pnpm -C packages/engine exec vitest run src/runoff/unitRain.golden.test.ts`.
 */
const EXPECTED: Record<string, ReturnType<typeof fingerprint>> = {
	fragmentation: {
		units: null,
		golden: {
			shape: "ad7590d5bbce8db0",
			series: {
				"natural_flow@": {
					sum: 31197362.536312077,
					sumSq: 682389166341.8011,
					weighted: 46690807.66942088
				},
				"rain_used@": {
					sum: 6075.606086317099,
					sumSq: 154196.7429588687,
					weighted: 9091.751153247114
				},
				"rain_final@": {
					sum: 6075.606086317099,
					sumSq: 154196.7429588687,
					weighted: 9116.611604221993
				},
				"rain_chirps_corrected@": {
					sum: 6075.6060863170915,
					sumSq: 154584.25088477324,
					weighted: 9099.594332462266
				},
				"rain_source@": {
					sum: 54,
					sumSq: 108,
					weighted: 80.98116947472747
				},
				"runoff@A": {
					sum: 15218225.62746929,
					sumSq: 162376958082.52243,
					weighted: 22867938.671876054
				},
				"runoff@B": {
					sum: 9130935.376481563,
					sumSq: 58455704909.70805,
					weighted: 13668958.874868605
				},
				"runoff@C": {
					sum: 4565467.688240781,
					sumSq: 14613926227.427013,
					weighted: 6853819.218362335
				},
				"runoff@D": {
					sum: 2282733.8441203907,
					sumSq: 3653481556.8567533,
					weighted: 3418921.1872040555
				},
				"runoff@E": {
					sum: 0,
					sumSq: 0,
					weighted: 0
				}
			},
			rest: {
				sum: 229643351.51594248,
				sumSq: 3695731270526.909,
				weighted: 344271323.2373167
			},
			summary: {
				sum: 811622845.1103017,
				sumSq: 37018642926996580,
				weighted: 1162797645.542868
			}
		}
	},
	gaugeMap: {
		units: [
			{
				nodeId: "A",
				rule: "gaugeMap",
				rainKey: "rain_catchment_mm",
				factor: 1.26153846,
				chirps: null,
				days: {
					unitGauge: 0,
					gaugeMap: 2165,
					unitChirps: 0,
					catchment: 27,
					forecast: 0,
					none: 0
				}
			},
			{
				nodeId: "B",
				rule: "gaugeMap",
				rainKey: "rain_catchment_mm",
				factor: 1.07692308,
				chirps: null,
				days: {
					unitGauge: 0,
					gaugeMap: 2165,
					unitChirps: 0,
					catchment: 27,
					forecast: 0,
					none: 0
				}
			},
			{
				nodeId: "C",
				rule: "gaugeMap",
				rainKey: "rain_catchment_mm",
				factor: 0.830769231,
				chirps: null,
				days: {
					unitGauge: 0,
					gaugeMap: 2165,
					unitChirps: 0,
					catchment: 27,
					forecast: 0,
					none: 0
				}
			},
			{
				nodeId: "D",
				rule: "catchment",
				rainKey: null,
				factor: null,
				chirps: null,
				days: {
					unitGauge: 0,
					gaugeMap: 0,
					unitChirps: 0,
					catchment: 2192,
					forecast: 0,
					none: 0
				}
			}
		],
		golden: {
			shape: "767f9b8c73543fe1",
			series: {
				"natural_flow@": {
					sum: 42767824.923284635,
					sumSq: 1279086326104.07,
					weighted: 63990839.93238497
				},
				"rain_used@": {
					sum: 6837.051652106906,
					sumSq: 195269.1811888269,
					weighted: 10231.205143935493
				},
				"rain_unit@A": {
					sum: 7664.610755046147,
					sumSq: 245400.92299537142,
					weighted: 11500.956177633896
				},
				"runoff_natural@A": {
					sum: 26747146.119774573,
					sumSq: 504384069508.73175,
					weighted: 40048667.22133255
				},
				"rain_unit@B": {
					sum: 6542.960400649123,
					sumSq: 178831.72556176473,
					weighted: 9773.51605326715
				},
				"runoff_natural@B": {
					sum: 11043533.485691858,
					sumSq: 85631781639.41232,
					weighted: 16563680.847966172
				},
				"rain_unit@C": {
					sum: 5047.426594786547,
					sumSq: 106423.12484451124,
					weighted: 7583.666474884545
				},
				"runoff_natural@C": {
					sum: 2694411.4736978137,
					sumSq: 5027350064.734289,
					weighted: 4041709.402088238
				},
				"rain_unit@D": {
					sum: 6075.606086317099,
					sumSq: 154196.7429588687,
					weighted: 9147.28358299822
				},
				"runoff_natural@D": {
					sum: 2282733.844120391,
					sumSq: 3653481556.8567533,
					weighted: 3417865.6573240925
				},
				"rain_final@": {
					sum: 6075.606086317099,
					sumSq: 154196.7429588687,
					weighted: 9104.409059793381
				},
				"rain_chirps_corrected@": {
					sum: 6075.6060863170915,
					sumSq: 154584.25088477324,
					weighted: 9134.328027182208
				},
				"rain_source@": {
					sum: 54,
					sumSq: 108,
					weighted: 82.35480673934588
				},
				"runoff@A": {
					sum: 26747146.119774573,
					sumSq: 504384069508.73175,
					weighted: 40038296.655299865
				},
				"runoff@B": {
					sum: 11043533.485691858,
					sumSq: 85631781639.41232,
					weighted: 16561641.0277877
				},
				"runoff@C": {
					sum: 2694411.4736978137,
					sumSq: 5027350064.734289,
					weighted: 4040271.0797816576
				},
				"runoff@D": {
					sum: 2282733.844120391,
					sumSq: 3653481556.8567533,
					weighted: 3419597.3679210213
				},
				"runoff@E": {
					sum: 0,
					sumSq: 0,
					weighted: 0
				}
			},
			rest: {
				sum: 299099989.73522234,
				sumSq: 6564622585880.288,
				weighted: 448581011.1485276
			},
			summary: {
				sum: 989767913.92053,
				sumSq: 50607962698027100,
				weighted: 1583024596.4515326
			}
		}
	},
	unitGauge: {
		units: [
			{
				nodeId: "A",
				rule: "unitGauge",
				rainKey: "rain_catchment_mm@A",
				factor: 1,
				chirps: "map",
				days: {
					unitGauge: 2165,
					gaugeMap: 0,
					unitChirps: 27,
					catchment: 0,
					forecast: 0,
					none: 0
				}
			},
			{
				nodeId: "B",
				rule: "unitGauge",
				rainKey: "rain_catchment_mm@B",
				factor: 1,
				chirps: null,
				days: {
					unitGauge: 2183,
					gaugeMap: 0,
					unitChirps: 0,
					catchment: 9,
					forecast: 0,
					none: 0
				}
			},
			{
				nodeId: "C",
				rule: "gaugeMap",
				rainKey: "rain_catchment_mm",
				factor: 0.923076923,
				chirps: null,
				days: {
					unitGauge: 0,
					gaugeMap: 2165,
					unitChirps: 0,
					catchment: 27,
					forecast: 0,
					none: 0
				}
			},
			{
				nodeId: "D",
				rule: "catchment",
				rainKey: null,
				factor: null,
				chirps: null,
				days: {
					unitGauge: 0,
					gaugeMap: 0,
					unitChirps: 0,
					catchment: 2192,
					forecast: 0,
					none: 0
				}
			}
		],
		golden: {
			shape: "7a38a3338456e296",
			series: {
				"natural_flow@": {
					sum: 40724533.36977918,
					sumSq: 1093760319015.4503,
					weighted: 61098806.84190648
				},
				"rain_used@": {
					sum: 6668.559844145411,
					sumSq: 81873.18025691037,
					weighted: 9951.937412450321
				},
				"rain_unit@A": {
					sum: 7823.411235955126,
					sumSq: 256506.9265408381,
					weighted: 11714.336011193374
				},
				"runoff_natural@A": {
					sum: 28113048.809715513,
					sumSq: 567984265385.5486,
					weighted: 42272862.909268476
				},
				"rain_unit@B": {
					sum: 5422.200000000051,
					sumSq: 123387.96000000105,
					weighted: 8114.405748265613
				},
				"runoff_natural@B": {
					sum: 6658307.448812635,
					sumSq: 31098284961.333908,
					weighted: 10012005.14570123
				},
				"rain_unit@C": {
					sum: 5608.251771985052,
					sumSq: 131386.5738821122,
					weighted: 8426.296083205047
				},
				"runoff_natural@C": {
					sum: 3670443.2671306105,
					sumSq: 9416909039.3587,
					weighted: 5505301.833079158
				},
				"rain_unit@D": {
					sum: 6075.606086317099,
					sumSq: 154196.7429588687,
					weighted: 9147.28358299822
				},
				"runoff_natural@D": {
					sum: 2282733.844120391,
					sumSq: 3653481556.8567533,
					weighted: 3417865.6573240925
				},
				"rain_final@": {
					sum: 6075.606086317099,
					sumSq: 154196.7429588687,
					weighted: 9104.409059793381
				},
				"rain_chirps_corrected@": {
					sum: 6075.6060863170915,
					sumSq: 154584.25088477324,
					weighted: 9134.328027182208
				},
				"rain_source@": {
					sum: 54,
					sumSq: 108,
					weighted: 82.35480673934588
				},
				"runoff@A": {
					sum: 28113048.809715513,
					sumSq: 567984265385.5486,
					weighted: 42077987.76243269
				},
				"runoff@B": {
					sum: 6658307.448812635,
					sumSq: 31098284961.333908,
					weighted: 9961216.489551252
				},
				"runoff@C": {
					sum: 3670443.2671306105,
					sumSq: 9416909039.3587,
					weighted: 5504596.652986572
				},
				"runoff@D": {
					sum: 2282733.844120391,
					sumSq: 3653481556.8567533,
					weighted: 3419597.3679210213
				},
				"runoff@E": {
					sum: 0,
					sumSq: 0,
					weighted: 0
				}
			},
			rest: {
				sum: 286829849.0081203,
				sumSq: 6049010096767.797,
				weighted: 430010838.6098504
			},
			summary: {
				sum: 955516585.914377,
				sumSq: 47606578153491030,
				weighted: 1530237223.4568274
			}
		}
	},
	reference: {
		units: [
			{
				nodeId: "A",
				rule: "unitChirps",
				rainKey: "rain_chirps_mm@A",
				factor: null,
				chirps: "reference",
				days: {
					unitGauge: 0,
					gaugeMap: 0,
					unitChirps: 2192,
					catchment: 0,
					forecast: 0,
					none: 0
				}
			},
			{
				nodeId: "B",
				rule: "unitChirps",
				rainKey: "rain_chirps_mm@B",
				factor: null,
				chirps: "reference",
				days: {
					unitGauge: 0,
					gaugeMap: 0,
					unitChirps: 2192,
					catchment: 0,
					forecast: 0,
					none: 0
				}
			},
			{
				nodeId: "C",
				rule: "unitChirps",
				rainKey: "rain_chirps_mm@C",
				factor: null,
				chirps: "reference",
				days: {
					unitGauge: 0,
					gaugeMap: 0,
					unitChirps: 2192,
					catchment: 0,
					forecast: 0,
					none: 0
				}
			},
			{
				nodeId: "D",
				rule: "unitChirps",
				rainKey: "rain_chirps_mm@D",
				factor: null,
				chirps: "reference",
				days: {
					unitGauge: 0,
					gaugeMap: 0,
					unitChirps: 2192,
					catchment: 0,
					forecast: 0,
					none: 0
				}
			}
		],
		golden: {
			shape: "3f3c4380773662dd",
			series: {
				"natural_flow@": {
					sum: 17320217.189539496,
					sumSq: 238686148947.09683,
					weighted: 25987194.187847637
				},
				"rain_used@": {
					sum: 4848.5987944623,
					sumSq: 41887.457682041946,
					weighted: 7233.9949280078945
				},
				"rain_unit@A": {
					sum: 5399.999999999999,
					sumSq: 127713.53967753821,
					weighted: 8081.963997386218
				},
				"runoff_natural@A": {
					sum: 11214331.555272585,
					sumSq: 106251452068.6369,
					weighted: 16841814.975173954
				},
				"rain_unit@B": {
					sum: 4499.999999999984,
					sumSq: 88731.13327050027,
					weighted: 6815.101653916233
				},
				"runoff_natural@B": {
					sum: 3840622.897196889,
					sumSq: 11843307583.487495,
					weighted: 5753015.7441533245
				},
				"rain_unit@C": {
					sum: 3599.9999999999964,
					sumSq: 56550.02219839709,
					weighted: 5376.749330092646
				},
				"runoff_natural@C": {
					sum: 875976.2405204996,
					sumSq: 537855973.5435629,
					weighted: 1315078.702557115
				},
				"rain_unit@D": {
					sum: 5064.183524318248,
					sumSq: 112296.0676694329,
					weighted: 7555.501575936826
				},
				"runoff_natural@D": {
					sum: 1389286.4965494808,
					sumSq: 1602669131.122388,
					weighted: 2087972.8630524282
				},
				"rain_final@": {
					sum: 6075.606086317099,
					sumSq: 154196.7429588687,
					weighted: 9104.409059793381
				},
				"rain_chirps_corrected@": {
					sum: 6075.6060863170915,
					sumSq: 154584.25088477324,
					weighted: 9134.328027182208
				},
				"rain_source@": {
					sum: 54,
					sumSq: 108,
					weighted: 82.35480673934588
				},
				"runoff@A": {
					sum: 11214331.555272585,
					sumSq: 106251452068.6369,
					weighted: 16781540.532428034
				},
				"runoff@B": {
					sum: 3840622.897196889,
					sumSq: 11843307583.487495,
					weighted: 5762422.622808372
				},
				"runoff@C": {
					sum: 875976.2405204996,
					sumSq: 537855973.5435629,
					weighted: 1312007.6969750081
				},
				"runoff@D": {
					sum: 1389286.4965494808,
					sumSq: 1602669131.122388,
					weighted: 2085637.663139998
				},
				"runoff@E": {
					sum: 0,
					sumSq: 0,
					weighted: 0
				}
			},
			rest: {
				sum: 146286963.26412824,
				sumSq: 2008003184960.1018,
				weighted: 219270590.17158538
			},
			summary: {
				sum: 572222606.251005,
				sumSq: 21962615921885264,
				weighted: 804403598.9802934
			}
		}
	}
};

describe('the rain forcing stays unchanged (issue #553 guard)', () => {
	for (const [name, build] of Object.entries(CASES))
		it(name, () => {
			const got = fingerprint(runModel(build()));
			if (process.env.GOLDEN_PRINT) console.log(name, JSON.stringify(got));
			const want = EXPECTED[name]!;
			expect(got.units).toEqual(want.units);
			expect(goldenDiff(got.golden, want.golden)).toEqual([]);
		});

	it('runs every case twice to the same fingerprint (it is deterministic)', () => {
		for (const build of Object.values(CASES)) expect(fingerprint(runModel(build()))).toEqual(fingerprint(runModel(build())));
	});
});
