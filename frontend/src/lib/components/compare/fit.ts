// The fit behind each compared run's parameters (issue #4): its in-sample
// score next to its validation scores, from each run's stored fit record.
// Pure, so it is unit-tested; FitValidationCompare.svelte draws it.
import { describeFitRecord, fitRecordStatus, type ApanDailyFingerprint, type ChirpsFactorSet, type FitRecord, type FitScores, type ProjectSettings, type SeriesProvenance } from '@water-management/engine';
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

/**
 * Whether a run's own forcing (`settings`, its snapshot — pan coefficient,
 * A-pan evaporation, CHIRPS bias correction) has moved since its fit: '–'
 * with no record, 'unknown' when the run's settings weren't given (older
 * callers), else 'yes'/'no'.
 */
const forcingChangedText = (
	r: FitRecord | null,
	settings: Partial<ProjectSettings> | null | undefined,
	chirpsSource: SeriesProvenance | null | undefined,
	apanDaily: ApanDailyFingerprint | null | undefined,
	chirpsFactors: ChirpsFactorSet[] | null | undefined
): string => {
	if (!r) return '–';
	if (!settings) return 'unknown';
	const s = fitRecordStatus(settings, r, { chirpsSource, apanDaily, ...(chirpsFactors !== undefined ? { chirpsFactors } : {}) });
	return s.chirpsSourceChanged
		? 'yes (another CHIRPS product or version)'
		: s.apanDailyChanged
			? 'yes (another daily A-pan series)'
			: s.chirpsFactorsChanged
				? 'yes (the CHIRPS factors drifted)'
				: s.forcingChanged
				? 'yes'
				: 'no';
};

/**
 * Rows for the two runs' fit records; null when neither run has one. `settingsA`/
 * `settingsB` are each run's own settings snapshot (`run.inputs.settings`), used only
 * to say whether the pan coefficient or A-pan has changed since that run's fit.
 */
export function fitValidationRows(
	ra: FitRecord | null,
	rb: FitRecord | null,
	settingsA?: Partial<ProjectSettings> | null,
	settingsB?: Partial<ProjectSettings> | null,
	/** Each run's CHIRPS series product and version (its input snapshot); undefined when not recorded. */
	chirps: { a?: SeriesProvenance | null; b?: SeriesProvenance | null } = {},
	/** Each run's daily A-pan series (its input snapshot, issue #45); undefined when not known. */
	apanDaily: { a?: ApanDailyFingerprint | null; b?: ApanDailyFingerprint | null } = {},
	/** Each run's applied CHIRPS factor sets (chirpsFactorSets of its summary, issue #51); undefined when not known. */
	chirpsFactors: { a?: ChirpsFactorSet[] | null; b?: ChirpsFactorSet[] | null } = {}
): FitValidationRow[] | null {
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
		{ label: 'Parameters edited since fit', ...both((r) => (r.editedParams?.length ? `yes (${r.editedParams.join(', ')})` : 'no')) },
		{ label: 'Forcing changed since fit', a: forcingChangedText(ra, settingsA, chirps.a, apanDaily.a, chirpsFactors.a), b: forcingChangedText(rb, settingsB, chirps.b, apanDaily.b, chirpsFactors.b) }
	];
}
