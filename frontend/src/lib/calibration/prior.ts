// The regional GR4J prior on the Calibration page (issue #622 step 5,
// docs/ui.md § Calibration, docs/model.md §2.10m): what the panel shows of a
// prior (its ranges beside the parameters now, the donors, its leave-one-out
// skill, "no skill"), and how Fit automatically uses it (as a penalty, as the
// search box, or both). Pure, so it is unit-tested; RegionalPriorPanel.svelte
// and FitPanel.svelte are thin.
import {
	DEFAULT_PRIOR_WEIGHT,
	GR4J_PARAMS,
	PRIOR_MAX_WEIGHT,
	PRIOR_PARAMS,
	type CalibrationBounds,
	type CalibrationPrior,
	type FitBounds,
	type Gr4jParams,
	type ParamPriors,
	type PriorFitResult,
	type PriorProvenance
} from '@water-management/engine';
import type { Gr4jPrior } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';

/** How a fit uses the prior: not at all, as a penalty, as its search box, or both. */
export type PriorUse = 'off' | 'penalty' | 'bounds' | 'both';
export const PRIOR_USES: readonly PriorUse[] = ['off', 'penalty', 'bounds', 'both'];

export const PRIOR_USE_LABEL: Record<PriorUse, string> = {
	off: 'Off (default)',
	penalty: 'Penalty: pull toward its medians',
	bounds: 'Search box: its p10–p90',
	both: 'Penalty and search box'
};

/** The hint under the choice. */
export function priorUseHint(u: PriorUse): string {
	switch (u) {
		case 'off':
			return 'The regional prior (above) has no part in the fit.';
		case 'penalty':
			return 'Adds a cost for parameters far from the donors’ medians: a short record leans on the donors, a long one outweighs them.';
		case 'bounds':
			return 'Searches only inside the donors’ p10–p90 range of each parameter, with the bounds below set aside.';
		case 'both':
			return 'Searches inside the donors’ p10–p90 range and pulls toward their medians.';
	}
}

/** The box a fit searches: the prior's under 'bounds' and 'both', else the Bounds choice. */
export const fitBoundsOf = (use: PriorUse, bounds: CalibrationBounds): FitBounds => (use === 'bounds' || use === 'both' ? 'prior' : bounds);

/** Why the penalty weight can't be used, or null (only asked when the penalty is on). */
export function priorWeightError(use: PriorUse, weight: number | null): string | null {
	if (use !== 'penalty' && use !== 'both') return null;
	return weight !== null && Number.isFinite(weight) && weight > 0 && weight <= PRIOR_MAX_WEIGHT ? null : `The penalty weight must be over 0 and at most ${PRIOR_MAX_WEIGHT}.`;
}

/** The prior as the engine's calibrate() takes it, from the route's answer; null when there is no prior to use or the fit doesn't use one. */
export function calibrationPriorOf(p: Pick<Gr4jPrior, 'ranges' | 'provenance'> | null | undefined, use: PriorUse, weight: number | null): CalibrationPrior | null {
	if (use === 'off' || !p?.ranges || !p.provenance) return null;
	const w = use === 'penalty' || use === 'both' ? (weight ?? DEFAULT_PRIOR_WEIGHT) : 0;
	return { ranges: p.ranges, weight: w, provenance: p.provenance };
}

/** The key a stepwise fit's priors are kept under: the zone's gauge, '' for the calibration site's own zone. */
export const priorKey = (zoneNodeId: string | null) => zoneNodeId ?? '';

/** The prior's skill in words, and whether it has none (≤ 0; a null skill is unknown, not none). */
export function skillText(skill: number | null | undefined, n: number | null | undefined): { text: string; noSkill: boolean } {
	if (skill === null || skill === undefined) return { text: 'Not scored: too few donors to leave one out', noSkill: false };
	const of = n ? ` (leave-one-out over ${n} donors)` : '';
	if (!(skill > 0)) return { text: `${fmtNum(skill, 2)}${of}: no better than the donors’ plain median`, noSkill: true };
	return { text: `${fmtNum(skill, 2)}${of}`, noSkill: false };
}

export interface RangeRow {
	key: (typeof PRIOR_PARAMS)[number];
	label: string;
	unit: string;
	p10: string;
	p50: string;
	p90: string;
	/** The parameter now, '–' when not known. */
	current: string;
	/** Where the parameter now sits: inside the p10–p90, below, above; null when unknown or the range has no spread. */
	where: 'inside' | 'below' | 'above' | null;
}

const fmtParam = (v: number) => fmtNum(v, Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2);

/** One row per GR4J parameter: its p10, p50 and p90, and where the parameter now sits. */
export function rangeRows(ranges: ParamPriors, now: Partial<Gr4jParams> | null | undefined): RangeRow[] {
	return GR4J_PARAMS.map((spec) => {
		const r = ranges[spec.key];
		const v = now?.[spec.key];
		const spread = r.p90 > r.p10;
		return {
			key: spec.key,
			label: spec.label,
			unit: spec.unit,
			p10: fmtParam(r.p10),
			p50: fmtParam(r.p50),
			p90: fmtParam(r.p90),
			current: typeof v === 'number' ? fmtParam(v) : '–',
			where: typeof v !== 'number' || !spread ? null : v < r.p10 ? 'below' : v > r.p90 ? 'above' : 'inside'
		};
	});
}

/** The donor set in one line: "7 of 14 donors from “synthetic” (invented donors)". */
export const donorLine = (p: Pick<PriorProvenance, 'donors' | 'donorCount' | 'dataset' | 'synthetic'>) =>
	`${p.donors.length} of ${p.donorCount} donor${p.donorCount === 1 ? '' : 's'} from “${p.dataset}”${p.synthetic ? ' (invented donors)' : ''}`;

/** A fit record's prior in one line, for the fit record: what it did and where it came from. */
export function priorRecordLine(p: Pick<PriorFitResult, 'weight' | 'bounded' | 'provenance'>): string {
	const how = [p.weight > 0 ? `penalty weight ${fmtNum(p.weight, 2)}` : null, p.bounded ? 'searched its p10–p90 box' : null].filter(Boolean).join(', ');
	const sk = skillText(p.provenance.leaveOneOutSkill, p.provenance.leaveOneOutN);
	return `Regional prior: ${how}; ${donorLine(p.provenance)}, SHA-256 ${p.provenance.donorSetSha256.slice(0, 12)}…; skill ${sk.text}.`;
}

/** The prior choice a fit record implies (Search starts from the last fit, issue #554): the box and the use. */
export function priorUseOfRecord(r: { bounds: FitBounds; prior?: Pick<PriorFitResult, 'weight' | 'bounded'> }): { use: PriorUse; bounds: CalibrationBounds; weight: number | null } {
	const bounds: CalibrationBounds = r.bounds === 'prior' ? 'wide' : r.bounds;
	if (!r.prior) return { use: 'off', bounds, weight: null };
	const pen = r.prior.weight > 0;
	return { use: r.prior.bounded ? (pen ? 'both' : 'bounds') : pen ? 'penalty' : 'off', bounds, weight: pen ? r.prior.weight : null };
}
