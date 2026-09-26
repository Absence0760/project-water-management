// Pure logic for PanCoefficientHelper.svelte (issue #39, proposal point 2):
// suggest a monthly Class A pan coefficient from FAO-56 Table 5. The helper
// only fills the Settings form; the user owns the values and the note of
// where the RH and wind came from.
import {
	FAO56_FETCHES,
	FAO56_MAX_REDUCTION_PCT,
	fao56Kp,
	type Fao56Fetch,
	type Fao56KpResult,
	type PanSiting
} from '@water-management/engine';
import { WATER_YEAR_MONTHS } from '$lib/format/months';

export type HelperMonth = { rhPct: number | null; windMs: number | null };

export type HelperState = {
	siting: PanSiting;
	fetchM: Fao56Fetch;
	/** Stated FAO-56 bare-surroundings reduction, % (0–20); null/0 = none. */
	reductionPct: number | null;
	/** 12 water-year months, index 0 = Oct … 11 = Sep. */
	months: HelperMonth[];
	/** Free text: where the monthly RH and wind came from. Required to apply. */
	source: string;
};

export type Suggestion = {
	/** Per month: the Table 5 lookup, or null while that month is incomplete or invalid. */
	results: (Fao56KpResult | null)[];
	/** Per month: why it has no value (null when it has one, or is simply blank). */
	errors: (string | null)[];
	/** Why Apply is blocked, or null when every month has a value and the source is given. */
	blocker: string | null;
};

export const DEFAULT_FETCH: Fao56Fetch = 10;
export { FAO56_FETCHES as FETCH_OPTIONS };

export function newHelperState(): HelperState {
	return {
		siting: 'A',
		fetchM: DEFAULT_FETCH,
		reductionPct: null,
		months: Array.from({ length: 12 }, () => ({ rhPct: null, windMs: null })),
		source: ''
	};
}

function reasonOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export function suggest(state: HelperState): Suggestion {
	const reductionPct = state.reductionPct ?? 0;
	const badReduction = !Number.isFinite(reductionPct) || reductionPct < 0 || reductionPct > FAO56_MAX_REDUCTION_PCT;
	const results: (Fao56KpResult | null)[] = [];
	const errors: (string | null)[] = [];
	state.months.forEach((m) => {
		if (m.rhPct === null || m.windMs === null || badReduction) {
			results.push(null);
			errors.push(null);
			return;
		}
		try {
			results.push(fao56Kp({ siting: state.siting, rhPct: m.rhPct, windMs: m.windMs, fetchM: state.fetchM, reductionPct }));
			errors.push(null);
		} catch (e) {
			results.push(null);
			errors.push(reasonOf(e));
		}
	});
	let blocker: string | null = null;
	const missing = state.months.map((m, i) => (m.rhPct === null || m.windMs === null ? WATER_YEAR_MONTHS[i] : null)).filter(Boolean);
	const invalid = errors.map((e, i) => (e ? WATER_YEAR_MONTHS[i] : null)).filter(Boolean);
	if (badReduction) blocker = `The reduction must be 0–${FAO56_MAX_REDUCTION_PCT} %`;
	else if (invalid.length) blocker = `Check the RH (0–100 %) and wind (≥ 0 m/s) in ${invalid.join(', ')}`;
	else if (missing.length) blocker = `Enter the mean RH and wind for ${missing.join(', ')}`;
	else if (!state.source.trim()) blocker = 'Say where the RH and wind came from';
	return { results, errors, blocker };
}

/**
 * The note to keep with the applied values: the Table 5 siting, fetch and any
 * reduction, plus the user's own source for the RH and wind.
 */
export function provenanceNote(state: HelperState): string {
	const surround = state.siting === 'A' ? 'green crop' : 'dry fallow';
	const reduction = state.reductionPct ? `, reduced by ${state.reductionPct} %` : '';
	return `FAO-56 Table 5, Case ${state.siting}, ${state.fetchM} m ${surround} fetch${reduction}; RH and wind: ${state.source.trim()}`;
}

/** The 12 suggested values and the note, or null while Apply is blocked. */
export function applied(state: HelperState): { values: number[]; note: string } | null {
	const s = suggest(state);
	if (s.blocker) return null;
	return { values: s.results.map((r) => r!.kp), note: provenanceNote(state) };
}
