// An uncertainty ensemble's options as stored and shown: the choices, their
// defaults and limits, the labels, and the diff of two ensembles' rules.
// Apart from the ensemble itself (./ensemble.ts), so the Runs panels and
// run comparison that show them don't load the model runs (issue #9).
import type { CalibrationBounds } from '../calibrate/params';
import { OBJECTIVE_LABELS, type ObjectiveId } from '../calibrate/objectives';
import type { CalibrationFlowKind } from '../project';
import type { Wr2012FlagLevel } from '../reference/wr2012';
import type { RunoffModelId } from '../runoff/types';
import { MIN_BAND_MEMBERS } from './bands';

export const ENSEMBLE_METHODS = ['lhs'] as const;
export type EnsembleMethod = (typeof ENSEMBLE_METHODS)[number];

/** 'recorded': the project's rain as a run uses it (station rain, CHIRPS where it is blank). 'chirps': bias-corrected CHIRPS on every day. */
export const RAIN_SOURCES = ['recorded', 'chirps'] as const;
export type RainSource = (typeof RAIN_SOURCES)[number];
export const RAIN_SOURCE_LABELS: Record<RainSource, string> = {
	recorded: 'Station rain, CHIRPS infill (as the run)',
	chirps: 'CHIRPS only (bias-corrected)'
};

export const RECORD_LABELS: Record<CalibrationFlowKind, string> = {
	flow_observed_m3s: 'gauge record',
	flow_logger_m3s: 'logger record'
};

/** Order of strictness of the WR2012 flag: a member passes at or below the threshold's level. */
export const WR2012_LEVELS: readonly Wr2012FlagLevel[] = ['ok', 'note', 'query', 'unusable'];

export interface AcceptanceThresholds {
	/** The skill score, scored on the member's own observed record before the split date. */
	objective: ObjectiveId;
	/** Lowest score kept. */
	minSkill: number;
	/**
	 * Worst WR2012 MAR flag kept (Phase 8, model.md §2.10c), judged on the
	 * member's natural flow. 'unusable' switches the check off. When the
	 * project sets a MAR band (settings.wr2012.calibrationPenalty), the MAR
	 * must also fall inside it. No reference: no check.
	 */
	wr2012MaxLevel: Wr2012FlagLevel;
	/** Largest |low-flow FDC volume bias| kept, % (Yilmaz et al. 2008, bottom 30 % of days); null = no check. */
	maxLowFlowBiasPct: number | null;
}

/** One sampled dimension, stored with the ensemble so the sample reproduces from the seed. */
export type EnsembleDimension =
	| { kind: 'param'; key: string; min: number; max: number; scale: 'linear' | 'log' }
	| { kind: 'pan'; min: number; max: number; scale: 'linear' }
	| { kind: 'rain'; values: RainSource[] }
	| { kind: 'record'; values: CalibrationFlowKind[] };

/** Everything that decides an ensemble, fully resolved: the server stores it and the browser runs it. */
export interface ResolvedEnsembleOptions {
	model: RunoffModelId;
	method: EnsembleMethod;
	/** Sampled members, not counting member 0 (the run's own parameters). */
	members: number;
	seed: number;
	bounds: CalibrationBounds;
	free: string[];
	/** Half-width of the additive pan-coefficient shift; 0 = not varied. */
	panOffset: number;
	rainSources: RainSource[];
	/** The first is the primary record: it sets the split date. */
	records: CalibrationFlowKind[];
	thresholds: AcceptanceThresholds;
	/** The LHS dimensions, in sample column order. */
	dimensions: EnsembleDimension[];
	/** Acceptance on the first half of the primary record's scored days; coverage on the second. */
	holdOut: 'secondHalf';
	percentiles: readonly [5, 50, 95];
	minMembers: number;
	/** Coverage below this share warns. */
	coverageWarning: number;
}

/** What a caller may ask for; the rest is resolved against the project (resolveEnsembleOptions). */
export interface EnsembleRequest {
	model?: RunoffModelId;
	members?: number;
	seed?: number;
	bounds?: CalibrationBounds;
	free?: string[];
	panOffset?: number;
	rainSources?: RainSource[];
	records?: CalibrationFlowKind[];
	thresholds?: Partial<AcceptanceThresholds>;
}

export const ENSEMBLE_DEFAULTS = {
	members: 300,
	seed: 1,
	bounds: 'typical' as CalibrationBounds,
	panOffset: 0.1,
	thresholds: { objective: 'kgePrime', minSkill: 0.5, wr2012MaxLevel: 'query', maxLowFlowBiasPct: 50 } as AcceptanceThresholds
};
export const ENSEMBLE_MEMBERS_MIN = MIN_BAND_MEMBERS;
export const ENSEMBLE_MEMBERS_MAX = 1000;
export const PAN_OFFSET_MAX = 0.3;
/** The FAO-56 range of Class A pan coefficients: a shifted month stays inside it (or at the project's own value, if that is outside). */
export const PAN_SHIFT_RANGE: readonly [number, number] = [0.35, 0.85];
/** Share of run days CHIRPS must cover for the CHIRPS-only rain source. */
export const CHIRPS_ONLY_MIN_COVERAGE = 0.99;
export const COVERAGE_WARNING = 0.7;
/** Exceedance % of the monthly flow-duration curves. */
export const FDC_POINTS: readonly number[] = [5, 10, 20, 30, 50, 70, 80, 90, 95, 99];

export type RejectReason = 'skill' | 'wr2012' | 'lowFlow';


/** An objective's label without its parenthesis: "KGE′". */
export const objectiveShortLabel = (o: ObjectiveId) => OBJECTIVE_LABELS[o].replace(/ \(.*\)$/, '');

export const REJECT_LABELS: Record<RejectReason, string> = { skill: 'skill score', wr2012: 'WR2012 check', lowFlow: 'low-flow check' };

// ---------------------------------------------------------------------------
// Diffing two ensembles' rules
// ---------------------------------------------------------------------------

export interface OptionChange {
	label: string;
	a: string;
	b: string;
}

const dimText = (o: ResolvedEnsembleOptions) =>
	o.dimensions.map((d) => (d.kind === 'param' ? `${d.key} ${d.min}–${d.max} (${d.scale})` : d.kind === 'pan' ? `pan ±${d.max}` : `${d.kind}: ${d.values.join(', ')}`)).join('; ');

/** What differs between two ensembles' options (thresholds first): stored thresholds, diffed. */
export function diffEnsembleOptions(a: ResolvedEnsembleOptions, b: ResolvedEnsembleOptions): OptionChange[] {
	const rows: [string, (o: ResolvedEnsembleOptions) => string][] = [
		['Skill score', (o) => objectiveShortLabel(o.thresholds.objective)],
		['Lowest skill kept', (o) => String(o.thresholds.minSkill)],
		['Worst WR2012 flag kept', (o) => (o.thresholds.wr2012MaxLevel === 'unusable' ? 'no check' : o.thresholds.wr2012MaxLevel)],
		['Largest low-flow bias kept', (o) => (o.thresholds.maxLowFlowBiasPct === null ? 'no check' : `±${o.thresholds.maxLowFlowBiasPct} %`)],
		['Runoff model', (o) => o.model],
		['Method', (o) => o.method],
		['Members', (o) => String(o.members)],
		['Seed', (o) => String(o.seed)],
		['Bounds', (o) => o.bounds],
		['Pan coefficient shift', (o) => (o.panOffset > 0 ? `±${o.panOffset}` : 'not varied')],
		['Rain sources', (o) => o.rainSources.map((x) => RAIN_SOURCE_LABELS[x]).join(', ')],
		['Observed records', (o) => o.records.map((x) => RECORD_LABELS[x]).join(', ')],
		['Sampled dimensions', dimText],
		['Fewest kept for percentiles', (o) => String(o.minMembers)],
		['Coverage warning below', (o) => `${Math.round(o.coverageWarning * 100)} %`]
	];
	return rows.flatMap(([label, f]) => {
		const x = f(a);
		const y = f(b);
		return x === y ? [] : [{ label, a: x, b: y }];
	});
}

// ---------------------------------------------------------------------------
// The project's declared rule (issue #71, docs/design/evidence-report.md ER3)
// ---------------------------------------------------------------------------

/**
 * The uncertainty rule a project declares for its evidence
 * (`settings.evidenceUncertaintyRule`; design ER3, gaming measure G4): the
 * sample size, bounds, pan-coefficient shift and acceptance thresholds an
 * evidence report's cited ensemble must have run with. Declared before anyone
 * sees a band, and versioned with the settings (the change history names who
 * set it and when), so an applicant can't try thresholds until a band is kind.
 * Absent or null = not declared: an evidence report then cites no ensemble.
 */
export interface DeclaredUncertaintyRule {
	members: number;
	bounds: CalibrationBounds;
	panOffset: number;
	thresholds: AcceptanceThresholds;
}

const RULE_BOUNDS: readonly CalibrationBounds[] = ['wide', 'typical'];

/** Why `v` isn't a declared rule, or null when it is one (the settings route's check). */
export function declaredRuleError(v: unknown): string | null {
	if (v === null) return null;
	if (!v || typeof v !== 'object' || Array.isArray(v)) return 'expected an object or null';
	const r = v as Record<string, unknown>;
	const extra = Object.keys(r).filter((k) => !['members', 'bounds', 'panOffset', 'thresholds'].includes(k));
	if (extra.length) return `unknown field ${extra[0]}`;
	if (!Number.isInteger(r.members) || (r.members as number) < ENSEMBLE_MEMBERS_MIN || (r.members as number) > ENSEMBLE_MEMBERS_MAX)
		return `members must be a whole number from ${ENSEMBLE_MEMBERS_MIN} to ${ENSEMBLE_MEMBERS_MAX}`;
	if (!RULE_BOUNDS.includes(r.bounds as CalibrationBounds)) return 'bounds must be wide or typical';
	if (typeof r.panOffset !== 'number' || !Number.isFinite(r.panOffset) || r.panOffset < 0 || r.panOffset > PAN_OFFSET_MAX)
		return `pan offset must be from 0 to ${PAN_OFFSET_MAX}`;
	const t = r.thresholds as Record<string, unknown> | null | undefined;
	if (!t || typeof t !== 'object' || Array.isArray(t)) return 'thresholds are required';
	const textra = Object.keys(t).filter((k) => !['objective', 'minSkill', 'wr2012MaxLevel', 'maxLowFlowBiasPct'].includes(k));
	if (textra.length) return `unknown threshold ${textra[0]}`;
	if (typeof t.objective !== 'string' || !Object.hasOwn(OBJECTIVE_LABELS, t.objective)) return 'unknown skill score';
	if (typeof t.minSkill !== 'number' || !Number.isFinite(t.minSkill) || t.minSkill < -10 || t.minSkill > 1) return 'the lowest skill kept must be from −10 to 1';
	if (!WR2012_LEVELS.includes(t.wr2012MaxLevel as Wr2012FlagLevel)) return 'the worst WR2012 flag kept must be ok, note, query or unusable';
	if (t.maxLowFlowBiasPct !== null && (typeof t.maxLowFlowBiasPct !== 'number' || !Number.isFinite(t.maxLowFlowBiasPct) || t.maxLowFlowBiasPct <= 0 || t.maxLowFlowBiasPct > 1000))
		return 'the largest low-flow bias kept must be above 0 and at most 1000 %, or none';
	return null;
}

const ruleRows: [string, (r: DeclaredUncertaintyRule) => string][] = [
	['Skill score', (r) => objectiveShortLabel(r.thresholds.objective)],
	['Lowest skill kept', (r) => String(r.thresholds.minSkill)],
	['Worst WR2012 flag kept', (r) => (r.thresholds.wr2012MaxLevel === 'unusable' ? 'no check' : r.thresholds.wr2012MaxLevel)],
	['Largest low-flow bias kept', (r) => (r.thresholds.maxLowFlowBiasPct === null ? 'no check' : `±${r.thresholds.maxLowFlowBiasPct} %`)],
	['Members', (r) => String(r.members)],
	['Bounds', (r) => r.bounds],
	['Pan coefficient shift', (r) => (r.panOffset > 0 ? `±${r.panOffset}` : 'not varied')]
];

/** A declared rule in one line, for the settings diff and the report. */
export function declaredRuleText(v: unknown): string {
	if (v === null || v === undefined) return 'not declared';
	if (declaredRuleError(v)) return 'not a valid rule';
	return ruleRows.map(([label, f]) => `${label.toLowerCase()} ${f(v as DeclaredUncertaintyRule)}`).join(', ');
}

/**
 * Where an ensemble's resolved options depart from the declared rule, as
 * rows `{ label, a: declared, b: the ensemble's }`; empty when it follows the
 * rule. The ensemble's own seed, records and rain sources are not part of the
 * rule (the database draws the seed; the records are the project's).
 */
export function declaredRuleMismatches(rule: DeclaredUncertaintyRule, o: ResolvedEnsembleOptions): OptionChange[] {
	const asRule: DeclaredUncertaintyRule = { members: o.members, bounds: o.bounds, panOffset: o.panOffset, thresholds: o.thresholds };
	return ruleRows.flatMap(([label, f]) => {
		const a = f(rule);
		const b = f(asRule);
		return a === b ? [] : [{ label, a, b }];
	});
}

/** The request an editor's "start the declared ensemble" sends (resolveEnsembleOptions fills the rest). */
export const declaredRuleRequest = (r: DeclaredUncertaintyRule): EnsembleRequest => ({
	members: r.members,
	bounds: r.bounds,
	panOffset: r.panOffset,
	thresholds: { ...r.thresholds }
});
