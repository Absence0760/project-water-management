// The validation statement of a run (roadmap WP-3.13, model.md §2.10f): how
// far its results can be trusted, from what the run itself recorded. Pure:
// it reads the stored summary, so it works on any saved run without
// re-running the model. Ratings are Moriasi et al. (2007), with their caveat:
// those thresholds were set for monthly flows, and a daily fit scores lower
// for the same skill (calibration research CR-6). They describe; they are not
// pass marks.
import type { CalibrationFlowKind, RunSummary } from '../project';
import type { SeriesKind } from '../project';
import { errataFor, type Erratum } from './errata';
import { ENGINE_ERRATA } from './errata.generated';
import type { Limitation } from './limitations';
import { KNOWN_LIMITATIONS } from './limitations.generated';
import type { MethodologyVersion } from './methodology';
import { METHODOLOGY } from './methodology.generated';

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
 * The engine build's own test results, injected at build time from CI
 * (WP-3.13). Not wired yet (docs/followups.md): until it is, a statement says
 * the build's results were not recorded rather than claiming them.
 */
export interface EngineBuild {
	version: string;
	gitSha: string;
	invariantsPassed: boolean;
	soakCases: number;
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
	/** Every data-quality check that fired, as its one-sentence text. */
	dataQuality: string[];
	/** The engine's self-checks on this run (./verify); null on runs from before they existed. */
	selfChecks: { passed: boolean; failed: string[] } | null;
	/** Open engine-audit.md items (generated). */
	limitations: readonly Limitation[];
	/** Known bugs of the run's engine version (docs/engine-errata.md, generated). */
	errata: Erratum[];
	/** The methodology statement current in this build (docs/methodology), by version and hash. */
	methodology: Pick<MethodologyVersion, 'version' | 'sha256'>;
}

export interface ValidationInput {
	summary: RunSummary;
	engineVersion: string;
	legacy: boolean;
	/** The engine of the automatic fit the run's parameters came from (settings.fitRecord.engineVersion); null for entered parameters. */
	fitEngineVersion?: string | null;
}

/** The validation statement of one saved run. */
export function validationStatement(
	run: ValidationInput,
	build: EngineBuild | null = null,
	limitations: readonly Limitation[] = KNOWN_LIMITATIONS,
	errata: readonly Erratum[] = ENGINE_ERRATA
): ValidationStatement {
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
		dataQuality: [...checks.map((x) => x.text), ...(s.dataQuality?.areaMismatches?.length ? [`${s.dataQuality.areaMismatches.length} farm area(s) differ from high + low MAP area by more than 1 %.`] : [])],
		selfChecks: s.verification ? { passed: s.verification.passed, failed: s.verification.checks.filter((k) => !k.passed).map((k) => k.label) } : null,
		limitations,
		errata: errataFor(run.engineVersion, errata, run.fitEngineVersion ?? null),
		methodology: { version: METHODOLOGY.version, sha256: METHODOLOGY.sha256 }
	};
}
