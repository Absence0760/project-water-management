// The validation statement of a run (roadmap WP-3.13, model.md §2.10f): how
// far its results can be trusted, from what the run itself recorded. Pure:
// it reads the stored summary, so it works on any saved run without
// re-running the model. Ratings are Moriasi et al. (2007), with their caveat:
// those thresholds were set for monthly flows, and a daily fit scores lower
// for the same skill (calibration research CR-6). They describe; they are not
// pass marks.
import type { CalibrationFlowKind, RunSummary } from '../project';
import type { SeriesKind } from '../project';
import type { Limitation } from './limitations';
import { KNOWN_LIMITATIONS } from './limitations.generated';

export type MoriasiRating = 'very good' | 'good' | 'satisfactory' | 'unsatisfactory';

/** Moriasi et al. (2007) Table 4, streamflow: NSE. */
export function moriasiNse(nse: number | null | undefined): MoriasiRating | null {
	if (nse == null || !Number.isFinite(nse)) return null;
	if (nse > 0.75) return 'very good';
	if (nse > 0.65) return 'good';
	if (nse > 0.5) return 'satisfactory';
	return 'unsatisfactory';
}

/** Moriasi et al. (2007) Table 4, streamflow: PBIAS in percent. */
export function moriasiPbias(pbias: number | null | undefined): MoriasiRating | null {
	if (pbias == null || !Number.isFinite(pbias)) return null;
	const a = Math.abs(pbias);
	if (a < 10) return 'very good';
	if (a < 15) return 'good';
	if (a < 25) return 'satisfactory';
	return 'unsatisfactory';
}

export const MORIASI_CAVEAT =
	'Ratings from Moriasi et al. (2007), whose thresholds were set for monthly flows. This run is scored on daily flows, which score lower for the same skill, so read them as a guide, not a pass mark.';

/**
 * The engine build's own test results (WP-3.13): the web release workflow
 * runs the engine's invariant suite and a soak, then writes this record
 * (scripts/release/engine-build.mjs) for the site build to inject
 * (frontend/vite.config.ts `__ENGINE_BUILD__`). A build without one (local,
 * e2e, CI) says the build's results were not recorded rather than claiming them.
 */
export interface EngineBuild {
	version: string;
	gitSha: string;
	invariantsPassed: boolean;
	soakCases: number;
}

/**
 * The build record as the site build injected it (a JSON string, or empty),
 * or null when there is none or it isn't one: a malformed record is never
 * shown as a result.
 */
export function parseEngineBuild(raw: string | null | undefined): EngineBuild | null {
	if (!raw) return null;
	let v: unknown;
	try {
		v = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof v !== 'object' || v === null) return null;
	const o = v as Record<string, unknown>;
	if (typeof o.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(o.version)) return null;
	if (typeof o.gitSha !== 'string' || !/^[0-9a-f]{7,40}$/.test(o.gitSha)) return null;
	if (typeof o.invariantsPassed !== 'boolean') return null;
	if (typeof o.soakCases !== 'number' || !Number.isInteger(o.soakCases) || o.soakCases < 0) return null;
	return { version: o.version, gitSha: o.gitSha, invariantsPassed: o.invariantsPassed, soakCases: o.soakCases };
}

export interface ValidationMetric {
	id: 'nse' | 'pbias' | 'kge' | 'logNse';
	label: string;
	value: number | null;
	/** Moriasi rating where the paper gives one (NSE, PBIAS); null otherwise. */
	rating: MoriasiRating | null;
}

export interface FlaggedYear {
	seriesKind: SeriesKind;
	/** The water year's first day (1 October), ISO. */
	start: string;
	end: string | null;
	/** Catchment rain ÷ CHIRPS over the days both have a reading. */
	ratio: number;
}

export interface ValidationStatement {
	engineVersion: string;
	/** The build's invariant suite and soak results; null until CI injects them. */
	build: EngineBuild | null;
	/** A legacy (b023 workbook) run: workbook comparison only, never evidence (audit H1). */
	legacy: boolean;
	calibration: {
		flowKind: CalibrationFlowKind | null;
		days: number;
		windowStart: string | null;
		windowEnd: string | null;
		metrics: ValidationMetric[];
		caveat: string;
	} | null;
	/** Audit W1: natural flow ÷ rain on the catchment; above 1 is physically impossible. */
	runoffCoefficient: { value: number; plausible: boolean } | null;
	/** Water years whose catchment rain reads far below CHIRPS (quality.ts 'lowvschirps'). */
	flaggedYears: FlaggedYear[];
	/**
	 * True when a run from before engine 1.30.1 kept only the first
	 * OLD_EXAMPLE_CAP flagged years and hit that cap, so `flaggedYears` may
	 * be short; the data-quality line still names every year. Re-running on
	 * the current engine lists them all.
	 */
	flaggedYearsMayBeCut: boolean;
	/** Every data-quality check that fired, as its one-sentence text. */
	dataQuality: string[];
	/** The engine's self-checks on this run (./verify); null on runs from before they existed. */
	selfChecks: { passed: boolean; failed: string[] } | null;
	/** Open engine-audit.md items (generated). */
	limitations: readonly Limitation[];
}

export interface ValidationInput {
	summary: RunSummary;
	engineVersion: string;
	legacy: boolean;
}

/** Up to engine 1.30.0 the low-vs-CHIRPS check kept this many flagged years as examples (quality.ts MAX_EXAMPLES). */
const OLD_EXAMPLE_CAP = 5;

/** a < b for two X.Y.Z versions (an unparsable one counts as old). */
function versionBefore(a: string, b: string): boolean {
	const pa = a.split('.').map(Number);
	const pb = b.split('.').map(Number);
	if (pa.length !== 3 || pa.some((n) => !Number.isInteger(n))) return true;
	for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]!;
	return false;
}

/** The validation statement of one saved run. */
export function validationStatement(run: ValidationInput, build: EngineBuild | null = null, limitations: readonly Limitation[] = KNOWN_LIMITATIONS): ValidationStatement {
	const s = run.summary;
	const c = s.calibration;
	const checks = s.dataQuality?.seriesChecks ?? [];
	const rc = s.catchment.runoffCoefficient;
	return {
		engineVersion: run.engineVersion,
		// A build's results speak for its own version only.
		build: build && build.version === run.engineVersion ? build : null,
		legacy: run.legacy,
		calibration:
			c && c.days > 0
				? {
						flowKind: c.flowKind ?? null,
						days: c.days,
						windowStart: c.windowStart ?? null,
						windowEnd: c.windowEnd ?? null,
						metrics: [
							{ id: 'nse', label: 'Nash–Sutcliffe efficiency (NSE)', value: c.nse, rating: moriasiNse(c.nse) },
							{ id: 'pbias', label: 'Percent bias (PBIAS, %)', value: c.pbias, rating: moriasiPbias(c.pbias) },
							{ id: 'kge', label: 'Kling–Gupta efficiency (KGE)', value: c.kge ?? null, rating: null },
							{ id: 'logNse', label: 'NSE of log flows (low flows)', value: c.logNse ?? null, rating: null }
						],
						caveat: MORIASI_CAVEAT
					}
				: null,
		runoffCoefficient: rc == null || !Number.isFinite(rc) ? null : { value: rc, plausible: rc <= 1 },
		flaggedYears: checks
			.filter((x) => x.check === 'lowvschirps')
			.flatMap((x) => x.examples.map((e) => ({ seriesKind: x.seriesKind, start: e.date, end: e.endDate ?? null, ratio: e.value }))),
		flaggedYearsMayBeCut: versionBefore(run.engineVersion, '1.30.1') && checks.some((x) => x.check === 'lowvschirps' && x.examples.length >= OLD_EXAMPLE_CAP),
		dataQuality: [...checks.map((x) => x.text), ...(s.dataQuality?.areaMismatches?.length ? [`${s.dataQuality.areaMismatches.length} farm area(s) differ from high + low MAP area by more than 1 %.`] : [])],
		selfChecks: s.verification ? { passed: s.verification.passed, failed: s.verification.checks.filter((k) => !k.passed).map((k) => k.label) } : null,
		limitations
	};
}
