// Sensitivity runs (CR-21, docs/model.md §2.10g): the factors, their default
// ranges and thresholds, the result's types and the verdict. Kept apart from
// ./sensitivity.ts, which runs the model, so a page that shows a result or
// re-judges it at another threshold doesn't load the run (engineSplit.test.ts
// in the frontend: this module must stay light).

export const SENSITIVITY_FACTORS = ['rain', 'pan', 'lakeEvap', 'abstraction', 'damStorage'] as const;
export type SensitivityFactor = (typeof SENSITIVITY_FACTORS)[number];
/** The factors set by a multiplier (initial dam storage is empty against full). */
export type ScaledFactor = Exclude<SensitivityFactor, 'damStorage'>;

export const SENSITIVITY_FACTOR_LABELS: Record<SensitivityFactor, string> = {
	rain: 'Rain',
	pan: 'Pan coefficient',
	lakeEvap: 'Dam evaporation factor',
	abstraction: 'Abstraction (demand)',
	damStorage: 'Initial dam storage'
};

export interface FactorRange {
	low: number;
	high: number;
}

/**
 * The default multipliers. Rain ±10 % and abstraction ±30 % are CR-21's; the
 * pan coefficient's ±15 % is CR-21's too, and the dam lake-evaporation
 * factor takes the same ±15 %: 0.64–0.86 around the default 0.75, a little
 * wider than open water's 0.7–0.8 × Class-A pan (Linsley et al. 1982,
 * docs/model.md §2.7a), since a farm dam's depth and siting are rarely
 * known. Judgements pending the hydrologist, not published bounds.
 */
export const SENSITIVITY_RANGES: Record<ScaledFactor, FactorRange> = {
	rain: { low: 0.9, high: 1.1 },
	pan: { low: 0.85, high: 1.15 },
	lakeEvap: { low: 0.85, high: 1.15 },
	abstraction: { low: 0.7, high: 1.3 }
};

/** The compliance metric a site's verdict is judged on. */
export type SensitivityMetric = 'reserveRate' | 'daysMet';

/**
 * The default decision thresholds (share, 0–1). A Reserve rule table states
 * the requirement but not the share of months that must meet it, and the
 * pragmatic EWR has no pass mark either, so both are project choices: 0.8
 * until the hydrologist or the licensing authority gives one.
 */
export const SENSITIVITY_THRESHOLDS: Record<SensitivityMetric, number> = { reserveRate: 0.8, daysMet: 0.8 };

export const SENSITIVITY_METRIC_LABELS: Record<SensitivityMetric, string> = {
	reserveRate: 'months meeting the Reserve rule table',
	daysMet: 'days the EWR was met'
};

export interface SensitivityOptions {
	/** Multipliers per factor (each within (0, 2], low < 1 < high not required but low ≠ high). Defaults SENSITIVITY_RANGES. */
	ranges?: Partial<Record<ScaledFactor, FactorRange>>;
	/** Decision thresholds, 0–1. Defaults SENSITIVITY_THRESHOLDS. */
	thresholds?: Partial<Record<SensitivityMetric, number>>;
	/** Leave these factors out. */
	skip?: SensitivityFactor[];
	onProgress?: (p: { done: number; total: number }) => void;
}

export interface SensitivitySite {
	/** 'outlet', or the gauge's node id. */
	key: string;
	name: string;
	isOutlet: boolean;
	/** The site has a Reserve rule table with a monthly compliance rate. */
	hasRuleTable: boolean;
}

/** One run's EWR results at one site. */
export interface SiteValues {
	/** Days the EWR was not met over the reporting window. */
	daysNotMet: number;
	/** 1 − daysNotMet ÷ the window's days. */
	daysMet: number;
	/** Volume short of the EWR over the reporting window, Mm³ (≥ 0). */
	shortfallMm3: number;
	/** Months meeting the site's Reserve rule table (0–1) over the run's complete months; null without a table. */
	reserveRate: number | null;
}

export interface SensitivityCase {
	/** The multiplier, or for damStorage the share full (0 = empty, 1 = full). */
	setting: number;
	/** Short label: "× 0.9", "empty". */
	label: string;
	/** Per site, in `sites` order. */
	values: SiteValues[];
}

export interface FactorResult {
	factor: SensitivityFactor;
	label: string;
	low: SensitivityCase;
	high: SensitivityCase;
	/** Notes on how it was applied ("2 series scaled", "3 dams"). */
	notes: string[];
}

export type SensitivityVerdictKind = 'meets' | 'fails' | 'notDeterminable' | 'noData';

export interface SiteVerdict {
	key: string;
	metric: SensitivityMetric;
	threshold: number;
	central: number | null;
	/** The envelope over the central run and every factor's low and high. */
	min: number | null;
	max: number | null;
	verdict: SensitivityVerdictKind;
	/** One sentence. */
	text: string;
}

export interface SensitivityResult {
	engineVersion: string;
	reportStart: string;
	reportEnd: string;
	days: number;
	sites: SensitivitySite[];
	central: SiteValues[];
	factors: FactorResult[];
	/** Factors not run, and why. */
	skipped: { factor: SensitivityFactor; label: string; reason: string }[];
	ranges: Record<ScaledFactor, FactorRange>;
	thresholds: Record<SensitivityMetric, number>;
	verdicts: SiteVerdict[];
}


const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;

/** The verdict at one site: the envelope against the threshold. */
export function siteVerdict(site: SensitivitySite, all: SiteValues[], central: SiteValues, thresholds: Record<SensitivityMetric, number>): SiteVerdict {
	const metric: SensitivityMetric = site.hasRuleTable ? 'reserveRate' : 'daysMet';
	const threshold = thresholds[metric];
	const xs = all.map((v) => v[metric]).filter((v): v is number => v !== null && Number.isFinite(v));
	const c = central[metric];
	const what = SENSITIVITY_METRIC_LABELS[metric];
	if (!xs.length || c === null) {
		return { key: site.key, metric, threshold, central: c, min: null, max: null, verdict: 'noData', text: `${site.name}: no ${what} to judge.` };
	}
	const min = Math.min(...xs);
	const max = Math.max(...xs);
	const range = min === max ? pct(min) : `${pct(min)} to ${pct(max)}`;
	const at = `${what} ${range} across the sensitivity runs (central ${pct(c)}), against a threshold of ${pct(threshold)}`;
	let verdict: SensitivityVerdictKind;
	let text: string;
	if (min >= threshold) {
		verdict = 'meets';
		text = `${site.name}: meets the threshold on every sensitivity run: ${at}.`;
	} else if (max < threshold) {
		verdict = 'fails';
		text = `${site.name}: below the threshold on every sensitivity run: ${at}.`;
	} else {
		verdict = 'notDeterminable';
		text = `${site.name}: not determinable with current data: ${at}, and the range crosses it.`;
	}
	return { key: site.key, metric, threshold, central: c, min, max, verdict, text };
}
