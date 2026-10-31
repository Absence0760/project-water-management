// The areal rainfall correction's "from a MAP" helper (docs/model.md §2.4g, docs/ui.md § Calibration settings):
// an independent catchment MAP ÷ the mean annual rain of the forcing the correction scales, as one flat factor
// with a source note, shown before it is applied. Pure, so it is unit-tested; the forcing itself is read by
// arealForcing.ts (lazy: it prepares a run in the browser), the panel is ArealMapHelper.svelte.
import {
	AREAL_RAIN_FACTOR_MAX,
	AREAL_RAIN_FACTOR_MIN,
	arealFactorFromMap,
	outsideArealRainBand,
	PE_SOURCE_MAX,
	waterYearLabel
} from '@water-management/engine';
import { withFactorEveryMonth, type EditableArealRain } from './arealRain';

/** The forcing the areal factor scales, before it: catchment rain ?? corrected CHIRPS ?? forecast, day by day (null = no value). */
export interface ArealForcing {
	startDate: string;
	rainMm: (number | null)[];
}

/**
 * The day's catchment forcing before the areal correction, as the engine's runoffForcing reads it (catchment rain,
 * else corrected CHIRPS, else forecast; a negative value counts as 0), but a day with none stays null rather than
 * dry, so arealFactorFromMap leaves its water year out instead of averaging it as a dry day.
 */
export function forcingRain(catchment: readonly (number | null)[], chirps: readonly (number | null)[], forecast: readonly (number | null)[], days: number): (number | null)[] {
	const out: (number | null)[] = new Array(days);
	for (let t = 0; t < days; t++) {
		const v = catchment[t] ?? chirps[t] ?? forecast[t] ?? null;
		out[t] = v === null || !Number.isFinite(v) ? null : Math.max(0, v);
	}
	return out;
}

/** Decimals the factor is proposed to: the factor field's own (ArealRainBody's NumberInput). */
export const AREAL_MAP_DECIMALS = 3;

export type ArealMapProposal =
	| { ok: false; problem: string }
	| {
			ok: true;
			/** The factor as filled in, to AREAL_MAP_DECIMALS. */
			factor: number;
			meanAnnualMm: number;
			waterYears: number[];
			/** The factor lies outside the 0.5–2 band every run warns about (still applied: worth checking). */
			outsideBand: boolean;
			/** The source note the correction would get. */
			note: string;
	  };

/** "WY 2001/02–2023/24 (23 complete water years)", or one year alone. */
export function waterYearsSpan(years: readonly number[]): string {
	if (!years.length) return 'no complete water year';
	const first = years[0]!;
	const last = years[years.length - 1]!;
	const n = years.length;
	const count = `${n} complete water year${n === 1 ? '' : 's'}`;
	// The years need not be consecutive: the count says how many the span holds.
	return first === last ? `WY ${waterYearLabel(first)} (${count})` : `WY ${waterYearLabel(first)}–${waterYearLabel(last)} (${count})`;
}

const mm = (v: number) => `${Math.round(v)} mm`;

/** The source note: the MAP and its reference ÷ the forcing's mean over its complete years = the factor. At most PE_SOURCE_MAX characters. */
export function arealMapNote(mapMm: number, reference: string, meanAnnualMm: number, waterYears: readonly number[], factor: number): string {
	const ref = reference.trim().replace(/\s+/g, ' ');
	const tail = ` ÷ the GR4J rain’s mean annual ${mm(meanAnnualMm)} over ${waterYearsSpan(waterYears)} = × ${factor.toFixed(AREAL_MAP_DECIMALS)}`;
	const head = `Catchment MAP ${mapMm} mm`;
	// The reference is the one part a person writes: it gives way first when the note would pass the limit.
	const room = PE_SOURCE_MAX - head.length - tail.length - ' ()'.length;
	const r = ref.length > room ? `${ref.slice(0, Math.max(0, room - 1)).trimEnd()}…` : ref;
	return `${head}${r ? ` (${r})` : ''}${tail}`;
}

/**
 * The factor an entered MAP gives over the forcing: refused (with why) for no MAP, a forcing with no complete
 * water year or no rain, or a factor outside the 0.25–4 the correction takes (more likely two series that
 * don't describe the same area, or a unit error, model.md §2.4g).
 */
export function proposeArealFromMap(mapMm: number | null, reference: string, forcing: ArealForcing): ArealMapProposal {
	if (mapMm === null || !(Number.isFinite(mapMm) && mapMm > 0)) return { ok: false, problem: 'Enter the catchment’s MAP in mm.' };
	const r = arealFactorFromMap(mapMm, forcing.rainMm, forcing.startDate);
	if (!r) return { ok: false, problem: 'The rain GR4J runs on has no complete water year (October to September, every day with a value) with rain, so there is no mean to divide by.' };
	const factor = Number(r.factor.toFixed(AREAL_MAP_DECIMALS));
	if (factor < AREAL_RAIN_FACTOR_MIN || factor > AREAL_RAIN_FACTOR_MAX)
		return {
			ok: false,
			problem: `${mapMm} mm ÷ ${mm(r.meanAnnualMm)} gives × ${factor}, outside the ${AREAL_RAIN_FACTOR_MIN}–${AREAL_RAIN_FACTOR_MAX} the correction takes: check the MAP’s units and that it is this catchment’s.`
		};
	return { ok: true, factor, meanAnnualMm: r.meanAnnualMm, waterYears: r.waterYears, outsideBand: outsideArealRainBand(factor), note: arealMapNote(mapMm, reference, r.meanAnnualMm, r.waterYears, factor) };
}

/** Why the proposal can't be applied yet, or null: the MAP's reference is required, as the source note is. */
export function arealMapBlocker(p: ArealMapProposal | null, reference: string): string | null {
	if (!p) return 'Work the factor out first';
	if (!p.ok) return p.problem.replace(/\.$/, '');
	if (!reference.trim()) return 'Say where the MAP comes from: it goes into the source note';
	return null;
}

/** The correction with the proposal applied: the factor in every month, method Independent MAP, the note as the source. */
export function withArealMapProposal(a: EditableArealRain, p: Extract<ArealMapProposal, { ok: true }>): EditableArealRain {
	return { ...withFactorEveryMonth(a, p.factor), method: 'map', source: p.note };
}
