// Automated calibration's pre-declared rules (issue #153, calibration
// research: "Automated calibration with pre-declared rules", docs/model.md
// §2.10j): the settings group, settings.calibrationRules. Kept apart from
// ./rules.ts (the filters and selection) and ./auto.ts (the run) so
// project.ts can load the defaults without the scoring code. Every choice a person makes after seeing a fit's
// scores (which days to leave out, which forcing, which fit to keep) is made
// here instead, by a rule set stored with the project and fixed before any
// result is seen, so the calibrate → review → refit loop can run without
// anyone steering it towards a score. An assessor then challenges the rules,
// not the result.
//
// - Exclusions: a water year is left out when more than `maxFlaggedShare` of
//   its observed days carry a quality flag (./dayFlags.ts flaggedDayMask:
//   extrapolated, suspect or infilled), each with a reason naming the rule.
// - Forcing: each listed pan coefficient (the project's own, or a preset) is
//   one set of cases. Nothing else about the forcing varies.
// - Cases: every forcing × bounds × objective, each a full fit with the
//   split-sample and dry → wet tests.
// - Selection: the case with the best score on a validation test (never
//   in-sample) among those that pass the filters: MAR inside the WR2012
//   band, parameters inside Perrin et al.'s typical range.
//
// `revision` counts changes (the backend bumps it on every save that changes
// a rule, and clears `signedOff`), and a fit record keeps the rules it ran
// under, so a fit is reproducible and a rule change shows in run comparison.
// The defaults are drafts until the hydrologist signs them off (#90,
// "Automated calibration rules"); until then a fit they pick is not evidence.
import { PAN_COEFFICIENT_PRESETS } from '../project';
import { CALIBRATION_BOUNDS, DEFAULT_STARTS, MAX_STARTS, type CalibrationBounds } from './params';

/** Model runs per optimisation a rule set may ask for. */
export const RULE_BUDGET_MIN = 50;
export const RULE_BUDGET_MAX = 10_000;
/** Largest seed: the engine's generator takes a 32-bit integer. */
export const RULE_SEED_MAX = 2 ** 31 - 1;
import { OBJECTIVE_LABELS, OBJECTIVES, type ObjectiveId } from './objectives';

/** The validation tests a rule set can select by: the dry → wet test, the split-sample test, or the other observed record. */
export const SELECTION_TESTS = ['dryWet', 'split', 'independent'] as const;
export type SelectionTest = (typeof SELECTION_TESTS)[number];

export const SELECTION_TEST_LABEL: Record<SelectionTest, string> = {
	dryWet: 'dry → wet test (wet years)',
	split: 'split-sample test (other half)',
	independent: 'the other observed record'
};

/** 'project' (the project's own pan coefficient row) or a PAN_COEFFICIENT_PRESETS id. */
export type RulePan = string;

export interface CalibrationRules {
	/** 1 for a project's first rule set; the server adds 1 on every save that changes a rule. */
	revision: number;
	exclusions: {
		/**
		 * Leave a water year out when more than this share (0–1) of its
		 * observed days in the calibration window are flagged. null = no
		 * exclusions by rule.
		 */
		maxFlaggedShare: number | null;
	};
	forcing: {
		/** Pan coefficients to fit under, each its own cases: 'project' or a preset id. */
		pan: RulePan[];
	};
	cases: {
		bounds: CalibrationBounds[];
		objectives: ObjectiveId[];
	};
	selection: {
		/** The validation test whose held-out score picks the fit. */
		test: SelectionTest;
		/** The score on that test (a FitScores efficiency, higher is better). */
		score: ObjectiveId;
	};
	/**
	 * How each fit searches: the seed, the starts of each full fit and the
	 * model runs per optimisation. Part of the rules, not chosen at run time,
	 * so the rules can't be re-run with other seeds until one scores well.
	 */
	run: { seed: number; starts: number; budget: number };
	filters: {
		/** Simulated natural MAR inside the WR2012 band (the penalty's band when set, else the check's query threshold). */
		wr2012Mar: boolean;
		/** Every fitted parameter inside Perrin et al.'s (2003) typical range. */
		typicalParams: boolean;
	};
	/** Who signed the rules off, and when (ISO date); null = draft rules, not yet signed off. */
	signedOff: { by: string; on: string } | null;
}

/** Most cases (forcing × bounds × objective) a rule set may ask for: each is a full fit with validation, in the browser. */
export const RULE_CASES_MAX = 8;
/** Longest name kept with a sign-off. */
export const SIGNED_OFF_BY_MAX = 200;

/**
 * The draft defaults (#90, "Automated calibration rules"): a water year with
 * more than 20 % flagged days is left out; the project's own forcing; wide
 * and typical bounds on KGE′; the best dry → wet KGE′ among fits whose MAR
 * is inside the WR2012 band and whose parameters are typical.
 */
export function defaultCalibrationRules(): CalibrationRules {
	return {
		revision: 1,
		exclusions: { maxFlaggedShare: 0.2 },
		forcing: { pan: ['project'] },
		cases: { bounds: ['wide', 'typical'], objectives: ['kgePrime'] },
		selection: { test: 'dryWet', score: 'kgePrime' },
		run: { seed: 1, starts: DEFAULT_STARTS, budget: 1500 },
		filters: { wr2012Mar: true, typicalParams: true },
		signedOff: null
	};
}

/** Pan choices a rule set may list: the project's own row, then the presets. */
export const rulePanOptions = (): { id: RulePan; label: string }[] => [
	{ id: 'project', label: 'The project’s pan coefficient' },
	...PAN_COEFFICIENT_PRESETS.map((p) => ({ id: p.id, label: p.label }))
];

export const rulePanLabel = (id: RulePan): string => rulePanOptions().find((o) => o.id === id)?.label ?? id;

/** The preset's 12 values (water-year order), or null for 'project'. */
export function rulePanValues(id: RulePan): number[] | null {
	if (id === 'project') return null;
	const p = PAN_COEFFICIENT_PRESETS.find((x) => x.id === id);
	return p ? [...p.values] : null;
}

/** How many cases a rule set runs. */
export const ruleCaseCount = (r: Pick<CalibrationRules, 'forcing' | 'cases'>): number => r.forcing.pan.length * r.cases.bounds.length * r.cases.objectives.length;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const dupe = (list: readonly string[]) => list.find((v, i) => list.indexOf(v) !== i);

/**
 * The first problem with a rule set, or null: shared by the backend's
 * validation, the Settings form and the engine.
 */
export function calibrationRulesError(r: CalibrationRules): string | null {
	const share = r.exclusions.maxFlaggedShare;
	if (share !== null && !(Number.isFinite(share) && share > 0 && share < 1)) return 'the flagged-day share must be above 0 % and below 100 %';
	const pans = rulePanOptions().map((o) => o.id);
	if (!r.forcing.pan.length) return 'list at least one pan coefficient';
	const badPan = r.forcing.pan.find((p) => !pans.includes(p));
	if (badPan) return `unknown pan coefficient "${badPan}"`;
	if (!r.cases.bounds.length) return 'list at least one set of bounds';
	if (r.cases.bounds.some((b) => !CALIBRATION_BOUNDS.includes(b))) return 'unknown bounds';
	if (!r.cases.objectives.length) return 'list at least one objective';
	if (r.cases.objectives.some((o) => !OBJECTIVES.includes(o))) return 'unknown objective';
	for (const [what, list] of [
		['pan coefficient', r.forcing.pan],
		['bounds', r.cases.bounds],
		['objective', r.cases.objectives]
	] as const) {
		const d = dupe(list);
		if (d) return `the ${what} "${d}" is listed twice`;
	}
	const n = ruleCaseCount(r);
	if (n > RULE_CASES_MAX) return `the rules ask for ${n} fits, more than ${RULE_CASES_MAX}: each is a full fit with validation`;
	if (!SELECTION_TESTS.includes(r.selection.test)) return 'unknown selection test';
	if (!OBJECTIVES.includes(r.selection.score)) return 'unknown selection score';
	const { seed, starts, budget } = r.run;
	if (!Number.isInteger(seed) || seed < 0 || seed > RULE_SEED_MAX) return `the seed must be a whole number from 0 to ${RULE_SEED_MAX}`;
	if (!Number.isInteger(starts) || starts < 1 || starts > MAX_STARTS) return `the starts must be a whole number from 1 to ${MAX_STARTS}`;
	if (!Number.isInteger(budget) || budget < RULE_BUDGET_MIN || budget > RULE_BUDGET_MAX) return `the model runs per fit must be a whole number from ${RULE_BUDGET_MIN} to ${RULE_BUDGET_MAX}`;
	if (r.signedOff) {
		if (!r.signedOff.by.trim()) return 'a sign-off needs a name';
		if (r.signedOff.by.length > SIGNED_OFF_BY_MAX) return `the sign-off name is longer than ${SIGNED_OFF_BY_MAX} characters`;
		if (!ISO.test(r.signedOff.on) || Number.isNaN(Date.parse(`${r.signedOff.on}T00:00:00Z`))) return 'the sign-off date must be YYYY-MM-DD';
	}
	return null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Stored rules over the defaults, group by group; an invalid set falls back
 * to the defaults with a warning (the backend refuses one on save; this
 * guards older or imported settings).
 */
export function resolveCalibrationRules(raw: unknown, warnings: string[] = []): CalibrationRules {
	const d = defaultCalibrationRules();
	if (raw == null) return d;
	if (!isObj(raw)) {
		warnings.push('calibration rules are not an object; the default rules are used');
		return d;
	}
	const group = <K extends keyof CalibrationRules>(k: K): CalibrationRules[K] =>
		(isObj(raw[k]) ? { ...(d[k] as object), ...(raw[k] as object) } : d[k]) as CalibrationRules[K];
	const r: CalibrationRules = {
		revision: Number.isInteger(raw.revision) && (raw.revision as number) >= 1 ? (raw.revision as number) : d.revision,
		exclusions: group('exclusions'),
		forcing: group('forcing'),
		cases: group('cases'),
		selection: group('selection'),
		run: group('run'),
		filters: group('filters'),
		signedOff: isObj(raw.signedOff) ? (raw.signedOff as CalibrationRules['signedOff']) : null
	};
	const err = calibrationRulesError(r);
	if (err) {
		warnings.push(`calibration rules: ${err}; the default rules are used`);
		return { ...d, revision: r.revision };
	}
	// A copy by value: the rules are plain JSON, and the Settings form passes a reactive proxy, which structuredClone refuses.
	return JSON.parse(JSON.stringify(r)) as CalibrationRules;
}

/** The rules without their revision and sign-off: what decides a fit. */
export const rulesContent = (r: CalibrationRules) => ({ exclusions: r.exclusions, forcing: r.forcing, cases: r.cases, selection: r.selection, run: r.run, filters: r.filters });

/** Two rule sets decide fits the same way (revision and sign-off aside). */
export const sameRules = (a: CalibrationRules, b: CalibrationRules): boolean => JSON.stringify(rulesContent(a)) === JSON.stringify(rulesContent(b));

const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;

/** The rules in one line each, for the Settings summary, the fit panel and run comparison. */
export function rulesLines(r: CalibrationRules): { subject: string; text: string }[] {
	const s = r.exclusions.maxFlaggedShare;
	return [
		{ subject: 'Exclusions', text: s === null ? 'none by rule' : `a water year with more than ${pct(s)} of its observed days flagged` },
		{ subject: 'Forcing', text: r.forcing.pan.map(rulePanLabel).join('; ') },
		{ subject: 'Fits', text: `${r.cases.bounds.join(' and ')} bounds × ${r.cases.objectives.map((o) => OBJECTIVE_LABELS[o]).join(', ')} (${ruleCaseCount(r)} fits)` },
		{ subject: 'Keep', text: `the best ${OBJECTIVE_LABELS[r.selection.score]} on the ${SELECTION_TEST_LABEL[r.selection.test]}` },
		{ subject: 'Search', text: `seed ${r.run.seed}, ${r.run.starts} start${r.run.starts === 1 ? '' : 's'} per fit, ${r.run.budget} model runs per optimisation` },
		{
			subject: 'Filters',
			text:
				[r.filters.wr2012Mar ? 'MAR inside the WR2012 band' : null, r.filters.typicalParams ? 'parameters in the typical range' : null].filter(Boolean).join('; ') ||
				'none'
		}
	];
}

/** What changed between two rule sets, for run comparison. */
export function calibrationRulesChanges(a: CalibrationRules, b: CalibrationRules): { subject: string; text: string }[] {
	const out: { subject: string; text: string }[] = [];
	const la = rulesLines(a);
	const lb = rulesLines(b);
	lb.forEach((l, i) => {
		if (l.text !== la[i]!.text) out.push({ subject: `Calibration rules: ${l.subject.toLowerCase()}`, text: `Calibration rules, ${l.subject.toLowerCase()}: ${la[i]!.text} → ${l.text}` });
	});
	const signed = (r: CalibrationRules) => (r.signedOff ? `signed off by ${r.signedOff.by} on ${r.signedOff.on}` : 'draft (not signed off)');
	if (JSON.stringify(a.signedOff) !== JSON.stringify(b.signedOff)) out.push({ subject: 'Calibration rules: sign-off', text: `Calibration rules: ${signed(a)} → ${signed(b)}` });
	return out;
}
