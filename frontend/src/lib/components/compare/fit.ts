// The fit behind each compared run's parameters (issue #4): its in-sample
// score next to its validation scores, from each run's stored fit record.
// Pure, so it is unit-tested; FitValidationCompare.svelte draws it.
import { describeFitRecord, type FitRecord, type FitScores } from '@water-management/engine';
import { objectiveName } from '$lib/calibration/fit';

export interface FitValidationRow {
	label: string;
	a: string;
	b: string;
}

const NONE = 'none: parameters set by hand or imported';
const score = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(2));

/** A stored record, or null for a run without one (or saved before fit records). */
export function asFitRecord(v: unknown): FitRecord | null {
	return v && typeof v === 'object' && 'fittedAt' in v && 'objective' in v ? (v as FitRecord) : null;
}

/** Rows for the two runs' fit records; null when neither run has one. */
export function fitValidationRows(ra: FitRecord | null, rb: FitRecord | null): FitValidationRow[] | null {
	if (!ra && !rb) return null;
	const both = (f: (r: FitRecord) => string) => ({ a: ra ? f(ra) : '–', b: rb ? f(rb) : '–' });
	const at = (r: FitRecord, pick: (r: FitRecord) => { scores: FitScores } | null | undefined) => {
		const p = pick(r);
		return p ? score(p.scores[r.objective]) : 'not run';
	};
	return [
		{ label: 'Fit', a: ra ? describeFitRecord(ra) : NONE, b: rb ? describeFitRecord(rb) : NONE },
		{ label: 'Objective', ...both((r) => objectiveName(r.objective)) },
		{ label: 'Bounds', ...both((r) => (r.bounds === 'typical' ? 'typical (Perrin et al. 80 %)' : 'wide')) },
		{ label: 'Calibration period (in-sample)', ...both((r) => score(r.fit.scores[r.objective])) },
		{ label: 'Split-sample: other half', ...both((r) => at(r, (x) => x.splitSample?.validation)) },
		{ label: 'Dry → wet: wet years', ...both((r) => at(r, (x) => x.differential?.validation)) },
		{ label: 'Independent record', ...both((r) => at(r, (x) => x.independentRecord?.validation)) },
		{
			label: 'WR2012 MAR penalty',
			...both((r) => {
				const p = r.marPenalty;
				if (!p) return 'off';
				const target = p.marLowMm3 !== null && p.marHighMm3 !== null ? `${p.marLowMm3}–${p.marHighMm3} Mm³/a band` : 'WR2012';
				return `weight ${p.weight}, MAR ${score(p.marRatio)} × ${target}`;
			})
		},
		{ label: 'Parameters edited since fit', ...both((r) => (r.editedParams?.length ? `yes (${r.editedParams.join(', ')})` : 'no')) }
	];
}
