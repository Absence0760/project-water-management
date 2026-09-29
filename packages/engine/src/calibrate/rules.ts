// Automated calibration's filters and selection (issue #153,
// docs/model.md §2.10j): what a rule set (./rulesSettings.ts) checks on each
// fit, and which fit it keeps. The exclusion rule's per-year shares are
// ./dayFlags.ts flaggedYearExclusions.
import { GR4J_PARAMS } from '../runoff/params';
import type { Wr2012Report } from '../reference/wr2012';
import type { ParamSet } from './params';

export type FilterId = 'wr2012Mar' | 'typicalParams';
export type FilterStatus = 'pass' | 'fail' | 'notApplicable';
export interface FilterResult {
	id: FilterId;
	status: FilterStatus;
	detail: string;
}

export const FILTER_LABEL: Record<FilterId, string> = {
	wr2012Mar: 'MAR inside the WR2012 band',
	typicalParams: 'Parameters in the typical range'
};

const fmt = (v: number, d = 3) => String(Math.round(v * 10 ** d) / 10 ** d);

/** Every fitted parameter inside GR4J's typical range (Perrin et al. 2003, the `typical` bounds). */
export function typicalParamsFilter(params: ParamSet, free: readonly string[]): FilterResult {
	const outside = GR4J_PARAMS.filter((p) => free.includes(p.key) && p.typical && (params[p.key]! < p.typical[0] || params[p.key]! > p.typical[1]));
	return outside.length
		? {
				id: 'typicalParams',
				status: 'fail',
				detail: outside.map((p) => `${p.key.toUpperCase()} ${fmt(params[p.key]!)} is outside ${p.typical![0]}–${p.typical![1]} ${p.unit}`).join('; ')
			}
		: { id: 'typicalParams', status: 'pass', detail: 'every fitted parameter is inside its typical range' };
}

/**
 * Simulated natural MAR inside the WR2012 band: the calibration penalty's
 * band (marLowMm3 … marHighMm3, already at the catchment's scale) when both
 * ends are set, else within the check's query threshold (the flag is 'ok' or
 * 'note'). Not applicable without a WR2012 reference.
 */
export function wr2012MarFilter(w: Wr2012Report | null | undefined, band: { marLowMm3: number | null; marHighMm3: number | null }): FilterResult {
	if (!w) return { id: 'wr2012Mar', status: 'notApplicable', detail: 'no WR2012 reference in Settings, so the MAR could not be checked' };
	const sim = w.flag.basis === 'overlap' && w.overlap ? w.overlap.simulatedMarMm3 : w.whole.simulatedMarMm3;
	if (band.marLowMm3 !== null && band.marHighMm3 !== null) {
		const inside = sim >= band.marLowMm3 && sim <= band.marHighMm3;
		return {
			id: 'wr2012Mar',
			status: inside ? 'pass' : 'fail',
			detail: `natural MAR ${fmt(sim)} Mm³/a is ${inside ? 'inside' : 'outside'} the band ${fmt(band.marLowMm3)}–${fmt(band.marHighMm3)} Mm³/a`
		};
	}
	const ok = w.flag.level === 'ok' || w.flag.level === 'note';
	const dev = w.flag.deviationPct;
	return {
		id: 'wr2012Mar',
		status: ok ? 'pass' : 'fail',
		detail: `natural MAR ${fmt(sim)} Mm³/a is ${dev === null ? 'not comparable with' : `${fmt(Math.abs(dev), 1)} % ${dev >= 0 ? 'above' : 'below'}`} the scaled WR2012 MAR (${ok ? 'within' : 'beyond'} the query threshold)`
	};
}

/** What selection reads of one case. */
export interface CaseVerdictInput {
	/** The case couldn't be fitted (an error), or was cancelled. */
	error: string | null;
	/** The held-out score on the rules' test; null when the record doesn't allow the test. */
	score: number | null;
	/** Why the score is missing, when it is. */
	scoreMissing?: string;
	filters: FilterResult[];
}

/**
 * Which cases may be kept, why the others may not, and the one kept: the
 * highest score among the eligible, the first on a tie; null when none is
 * eligible. Never an in-sample score.
 */
export function selectCase(cases: readonly CaseVerdictInput[]): { chosen: number | null; eligible: boolean[]; reasons: string[][] } {
	const reasons = cases.map((c) => {
		if (c.error) return [c.error];
		const out: string[] = [];
		if (c.score === null || !Number.isFinite(c.score)) out.push(c.scoreMissing ?? 'no validation score');
		for (const f of c.filters) if (f.status === 'fail') out.push(`${FILTER_LABEL[f.id]}: ${f.detail}`);
		return out;
	});
	const eligible = reasons.map((r) => r.length === 0);
	let chosen: number | null = null;
	cases.forEach((c, i) => {
		if (eligible[i] && (chosen === null || c.score! > cases[chosen]!.score!)) chosen = i;
	});
	return { chosen, eligible, reasons };
}
