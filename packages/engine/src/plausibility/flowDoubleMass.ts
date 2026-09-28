// Double-mass curve of observed flow against catchment rain (engine ≥ 0.25.0,
// docs/model.md §2.10d, issue #4 phase 6 plausibility check 3).
//
// Cumulative observed flow against cumulative rain is a straight line while
// the catchment, its development and the gauge stay the same (Searcy &
// Hardison 1960). A kink means one of them changed: new use upstream (more
// irrigation, new farm dams), or the gauge (a rating change, silt, a weir
// bypassed or drowned in floods). The break detection is the rain-vs-CHIRPS
// check's (../doublemass.ts doubleMassSegments): water-year totals over the
// days both have a value, up to two breaks by BIC, reported at a slope change
// of DOUBLE_MASS_MIN_CHANGE confirmed by Pettitt or the BIC gain.
//
// The flow/rain ratio is not linear in rain: a run of dry years gives a lower
// ratio on its own. So each break is set against the simulated outflow over
// the same days, which has the same rain and fixed development: the change
// the model doesn't share (`unexplained`) is what the catchment or gauge did.
// Then, a hint, not a verdict (confirm with the gauge's records and the
// development history):
//   - |unexplained| < DOUBLE_MASS_MIN_CHANGE: 'rain', the model shows the same
//     change, so the rain did it;
//   - a fall that the dry season takes more of than the wet season (by
//     FLOW_DM_SEASON_MARGIN): 'newUse', since abstraction and dams filling take
//     a larger share of low flows;
//   - a fall the wet season takes more of: 'gauge', as a weir that is bypassed
//     or drowned under-reads floods;
//   - a rise: 'gauge', which new use can't cause (or use that stopped);
//   - otherwise 'unclear'.
import { DOUBLE_MASS_MIN_CHANGE, doubleMassSegments, type DoubleMassBreak, type DoubleMassSegment } from '../doublemass';
import type { CalibrationFlowKind } from '../project';
import { isFlow } from './season';
import { waterYearLabel, waterYearOf } from '../calendar';

const SEC_PER_DAY = 86_400;

/** A water year is judged with this many days with both flow and rain … */
export const FLOW_DM_MIN_DAYS = 300;
/** … and at least this much rain on them, mm. */
export const FLOW_DM_MIN_RAIN_MM = 100;
/** Fewer judged years than this: no result (as the rain-vs-CHIRPS check). */
export const FLOW_DM_MIN_YEARS = 10;
/** A fall is put down to one season when that season's unexplained change is this much larger. */
export const FLOW_DM_SEASON_MARGIN = 0.1;

export type FlowBreakHint = 'rain' | 'newUse' | 'gauge' | 'unclear';

export interface FlowDoubleMassYear {
	waterYear: number;
	days: number;
	rainMm: number;
	/** Observed and simulated outflow over the same days, mm over the catchment. */
	observedMm: number;
	simulatedMm: number;
	/** observedMm ÷ rainMm: the year's observed runoff ratio. */
	ratio: number;
	cumRainMm: number;
	cumObservedMm: number;
	cumSimulatedMm: number;
}

export interface FlowDoubleMassBreak extends DoubleMassBreak {
	/** Simulated outflow ÷ rain over the same segments. */
	simulatedSlopeBefore: number;
	simulatedSlopeAfter: number;
	/** (1 + change) ÷ (1 + simulated change) − 1; null when a simulated slope is 0. */
	unexplained: number | null;
	/** The same, dry-season and wet-season flow only; null without a dry season or with a zero volume. */
	unexplainedDry: number | null;
	unexplainedWet: number | null;
	hint: FlowBreakHint;
}

export interface FlowDoubleMass {
	flowKind: CalibrationFlowKind;
	years: FlowDoubleMassYear[];
	skippedYears: number[];
	/** Σ observed ÷ Σ rain over the judged years (a runoff ratio). */
	wholeSlope: number;
	segments: DoubleMassSegment[];
	breaks: FlowDoubleMassBreak[];
}

export interface FlowDoubleMassInput {
	flowKind: CalibrationFlowKind;
	start: number;
	observedM3s: ArrayLike<number | null>;
	simulatedM3Day: ArrayLike<number>;
	rainMm: readonly (number | null)[];
	areaKm2: number;
	/** 1 on dry-season run days; null when the run has no dry season. */
	inSeason: Uint8Array | null;
	/** 1 on days the calibration exclusions leave out. */
	excluded: Uint8Array;
}

interface YearSums {
	days: number;
	rain: number;
	obs: number;
	sim: number;
	obsDry: number;
	simDry: number;
}

/** The double-mass check of observed flow against rain; null without a catchment area or with too few judged years. */
export function flowDoubleMass(x: FlowDoubleMassInput): FlowDoubleMass | null {
	if (!(x.areaKm2 > 0)) return null;
	const mmPerM3 = 1 / (x.areaKm2 * 1000); // 1 mm on 1 km² = 1000 m³
	const days = x.simulatedM3Day.length;
	const byYear = new Map<number, YearSums>();
	for (let t = 0; t < days; t++) {
		const o = x.observedM3s[t];
		const r = x.rainMm[t];
		if (!isFlow(o) || r == null || !(r >= 0) || x.excluded[t]) continue;
		const wy = waterYearOf(x.start + t);
		let y = byYear.get(wy);
		if (!y) byYear.set(wy, (y = { days: 0, rain: 0, obs: 0, sim: 0, obsDry: 0, simDry: 0 }));
		const om = o * SEC_PER_DAY * mmPerM3;
		const sm = x.simulatedM3Day[t]! * mmPerM3;
		y.days++;
		y.rain += r;
		y.obs += om;
		y.sim += sm;
		if (x.inSeason?.[t]) {
			y.obsDry += om;
			y.simDry += sm;
		}
	}
	const all = [...byYear.entries()].sort(([a], [b]) => a - b);
	const judged = all.filter(([, y]) => y.days >= FLOW_DM_MIN_DAYS && y.rain >= FLOW_DM_MIN_RAIN_MM);
	if (judged.length < FLOW_DM_MIN_YEARS) return null;
	const { wholeSlope, segments, breaks } = doubleMassSegments(judged.map(([waterYear, y]) => ({ waterYear, x: y.rain, y: y.obs, days: y.days })));

	const years: FlowDoubleMassYear[] = [];
	let cr = 0;
	let co = 0;
	let cs = 0;
	for (const [waterYear, y] of judged) {
		cr += y.rain;
		co += y.obs;
		cs += y.sim;
		years.push({ waterYear, days: y.days, rainMm: y.rain, observedMm: y.obs, simulatedMm: y.sim, ratio: y.obs / y.rain, cumRainMm: cr, cumObservedMm: co, cumSimulatedMm: cs });
	}
	/** Sums over the judged years from water year a to b inclusive. */
	const sums = (a: number, b: number) => {
		const s = { rain: 0, obs: 0, sim: 0, obsDry: 0, simDry: 0 };
		for (const [wy, y] of judged) {
			if (wy < a || wy > b) continue;
			s.rain += y.rain;
			s.obs += y.obs;
			s.sim += y.sim;
			s.obsDry += y.obsDry;
			s.simDry += y.simDry;
		}
		return s;
	};
	/** (after ÷ before) of obs ÷ sim, less 1; null when a volume is 0. */
	const shift = (ob: number, sb: number, oa: number, sa: number) => (ob > 0 && sb > 0 && sa > 0 ? oa / sa / (ob / sb) - 1 : null);
	const out: FlowDoubleMassBreak[] = breaks.map((b, j) => {
		const before = sums(segments[j]!.fromWaterYear, segments[j]!.toWaterYear);
		const after = sums(segments[j + 1]!.fromWaterYear, segments[j + 1]!.toWaterYear);
		const simBefore = before.sim / before.rain;
		const simAfter = after.sim / after.rain;
		const unexplained = shift(before.obs, before.sim, after.obs, after.sim);
		const unexplainedDry = x.inSeason ? shift(before.obsDry, before.simDry, after.obsDry, after.simDry) : null;
		const unexplainedWet = x.inSeason ? shift(before.obs - before.obsDry, before.sim - before.simDry, after.obs - after.obsDry, after.sim - after.simDry) : null;
		return { ...b, simulatedSlopeBefore: simBefore, simulatedSlopeAfter: simAfter, unexplained, unexplainedDry, unexplainedWet, hint: hintOf(unexplained, unexplainedDry, unexplainedWet) };
	});
	const judgedSet = new Set(judged.map(([wy]) => wy));
	return { flowKind: x.flowKind, years, skippedYears: all.map(([wy]) => wy).filter((wy) => !judgedSet.has(wy)), wholeSlope, segments, breaks: out };
}

/** The hint for one break (see the header). */
export function hintOf(unexplained: number | null, dry: number | null, wet: number | null): FlowBreakHint {
	if (unexplained === null) return 'unclear';
	if (Math.abs(unexplained) < DOUBLE_MASS_MIN_CHANGE) return 'rain';
	if (unexplained > 0) return 'gauge';
	if (dry === null || wet === null) return 'unclear';
	if (dry <= wet - FLOW_DM_SEASON_MARGIN) return 'newUse';
	if (wet <= dry - FLOW_DM_SEASON_MARGIN) return 'gauge';
	return 'unclear';
}

const RECORD: Record<CalibrationFlowKind, string> = { flow_observed_m3s: 'observed gauge', flow_logger_m3s: 'logger' };
const signedPct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v * 100))} %` : 'from 0');

const HINT_TEXT: Record<Exclude<FlowBreakHint, 'rain'>, string> = {
	newUse: 'the dry season lost more than the wet season, which points to new use upstream (abstraction, dams filling)',
	gauge: 'the pattern points to the gauge (a rating change, or floods bypassing or drowning the weir), not new use',
	unclear: 'the seasons don\'t say whether new use or the gauge did it'
};

/** The run warning for breaks the simulated outflow doesn't share, or null. */
export function flowDoubleMassWarning(dm: FlowDoubleMass | null): string | null {
	const real = dm?.breaks.filter((b) => b.hint !== 'rain') ?? [];
	if (!dm || !real.length) return null;
	const parts = real.map((b) => {
		const why = b.unexplained !== null && b.unexplained > 0 ? 'a rise new use can\'t cause: look at the gauge\'s rating, or use that stopped' : HINT_TEXT[b.hint as Exclude<FlowBreakHint, 'rain'>];
		const beyond = b.unexplained === null ? 'the simulated outflow is 0 on one side, so the model can\'t say how much the rain did' : `${signedPct(b.unexplained)} beyond what the model shows with the same rain`;
		return `after ${waterYearLabel(b.afterWaterYear)} (runoff ratio ${b.slopeBefore.toFixed(3)} → ${b.slopeAfter.toFixed(3)}, ${signedPct(b.change)}; ${beyond}; ${why})`;
	});
	return (
		`Observed flow against rain: the double-mass curve of the ${RECORD[dm.flowKind]} record against catchment rain (${dm.years.length} water years) changes slope ${parts.join(' and ')}. ` +
		'The model keeps development fixed over the run, so a real change in use would bias the fit before or after it. Check the gauge\'s records and the development history; the Plausibility checks panel has the table.'
	);
}
