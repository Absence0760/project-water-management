// Stable codes for the run warnings (engine ≥ 1.102.0, issue #611 phase 2):
// summary.warningCodes lists each coded warning as { code, params, text }
// beside summary.warnings, whose strings are unchanged (expand, then
// contract). A page can then group, count and link a warning by its code
// instead of matching its English (frontend runs/credibility.ts), and the
// warnings page can offer "go to setting" from the catalogue's `setting`.
//
// Only the actionable warnings carry a code so far: the data checks, the rain
// chain (zero runs, accumulations, the CHIRPS and gap-product fallbacks, rain
// stations and unit gauges) and calibration. The area-fragmentation,
// High/Low-MAP, areaMismatches and EWR-split warnings stay uncoded on purpose:
// issues #615–#617 remove or reword them. An uncoded warning is in
// summary.warnings only, as before. docs/model.md § Run warning codes.
//
// A module of its own, exported as `@water-management/engine/warnings`, so a
// page that only reads the catalogue doesn't load the model.

/** A coded warning's figures and names, the ones its text is built from. */
export type WarningParams = Record<string, string | number>;

/**
 * How a results page groups a warning: 'note', how the engine handled the input data as it was set up to (informative,
 * not a reason to doubt the run); 'check', something to look at before relying on the run.
 */
export type WarningGroup = 'note' | 'check';

export interface WarningCodeInfo {
	/**
	 * The settings panel that changes what the warning reports, by its anchor id (frontend settings/sections.ts:
	 * `set-…` on Model settings or Calibration, `set-unit-rain` inside Flow generation); null when the fix is on the
	 * Data page (load or rename a series), not a setting.
	 */
	setting: string | null;
	group: WarningGroup;
}

/** Every warning code, with the panel it links to and its group. Add a code here before using it. */
export const WARNING_CODES = {
	// Data checks (quality.ts seriesChecks, doublemass.ts doubleMassCheck): params { series, days }.
	'data.negative': { setting: 'set-quality', group: 'check' },
	'data.outlier': { setting: 'set-quality', group: 'check' },
	'data.flatline': { setting: 'set-quality', group: 'note' },
	'data.zerorun': { setting: 'set-quality', group: 'note' },
	'data.lowvschirps': { setting: 'set-quality', group: 'check' },
	'data.doublemass': { setting: 'set-rain', group: 'check' },
	// The gauge and logger records disagree (quality.ts agreementWarning): params { years }.
	'data.flowAgreement': { setting: 'set-record', group: 'check' },

	// Catchment rain: zero runs (rain.ts zeroRainWarnings, keepDryDoubtWarnings).
	'rain.zeroRun.missing': { setting: 'set-rain', group: 'note' },
	'rain.zeroRun.keptDry': { setting: 'set-rain', group: 'check' },
	'rain.zeroRun.chirpsDry': { setting: 'set-rain', group: 'check' },
	'rain.zeroRun.asRecorded': { setting: 'set-rain', group: 'check' },
	'rain.keepDry.doubtful': { setting: 'set-rain', group: 'check' },
	// Catchment rain: accumulations (accumulation.ts accumulationWarnings).
	'rain.accumulation.spread': { setting: 'set-rain', group: 'note' },
	'rain.accumulation.noChirps': { setting: 'set-rain', group: 'check' },
	'rain.accumulation.setAside': { setting: 'set-rain', group: 'check' },
	'rain.accumulation.kept': { setting: 'set-rain', group: 'check' },
	'rain.accumulation.asRecorded': { setting: 'set-rain', group: 'check' },
	'rain.accumulation.noReading': { setting: 'set-rain', group: 'check' },
	// CHIRPS standing in for blank catchment rain (rain.ts chirpsCorrectionWarning, chirpsQuantileMapFallbackWarning;
	// doublemass.ts doubleMassRunWarning).
	'rain.chirps.corrected': { setting: 'set-rain', group: 'note' },
	'rain.chirps.uncorrected': { setting: 'set-rain', group: 'check' },
	'rain.chirps.quantileMapFallback': { setting: 'set-rain', group: 'check' },
	'rain.chirps.doubleMassBreak': { setting: 'set-rain', group: 'check' },
	// The gap-filling product (gapRain.ts gapRainWarnings): params { product, … }.
	'rain.gapProduct.absent': { setting: 'set-rain', group: 'check' },
	'rain.gapProduct.uncorrected': { setting: 'set-rain', group: 'check' },
	'rain.gapProduct.corrected': { setting: 'set-rain', group: 'check' },
	'rain.gapProduct.doubleMassBreak': { setting: 'set-rain', group: 'check' },
	// Rain source periods (rainSourcePeriods.ts rainSourcePeriodWarnings).
	'rain.sourcePeriod': { setting: 'set-rain', group: 'check' },
	// Days with no rain value at all, run dry (run.ts missingRainWarning), and a run with no rain series.
	'rain.missingDays': { setting: 'set-rain', group: 'check' },
	'rain.none': { setting: null, group: 'check' },
	// Two CHIRPS series where the run reads one (seriesChoice.ts chirpsChoiceWarnings): rename one on the Data page.
	'rain.chirpsShadowed': { setting: null, group: 'check' },

	// Rain stations (runoff/stationForcing.ts, runoff/stationRecord.ts): params { station, … }. The station's own
	// lists are under Flow generation; its zero-run and accumulation handling follows the catchment's Rain gaps.
	'rain.station.noRecord': { setting: 'set-share', group: 'check' },
	'rain.station.unreliableInvalid': { setting: 'set-share', group: 'check' },
	'rain.station.unreliable': { setting: 'set-share', group: 'check' },
	'rain.station.zeroRun.missing': { setting: 'set-rain', group: 'check' },
	'rain.station.zeroRun.asRecorded': { setting: 'set-rain', group: 'check' },
	'rain.station.accumulation.spread': { setting: 'set-rain', group: 'check' },
	'rain.station.accumulation.setAside': { setting: 'set-rain', group: 'check' },
	'rain.station.accumulation.asRecorded': { setting: 'set-rain', group: 'check' },
	// A unit's own gauge (runoff/unitGaugeChecks.ts unitGaugeCheckWarnings): params { unit, … }.
	'rain.unitGauge.zeroRun.missing': { setting: 'set-rain', group: 'check' },
	'rain.unitGauge.zeroRun.asRecorded': { setting: 'set-rain', group: 'check' },
	'rain.unitGauge.accumulation.spread': { setting: 'set-rain', group: 'check' },
	'rain.unitGauge.accumulation.setAside': { setting: 'set-rain', group: 'check' },
	'rain.unitGauge.accumulation.asRecorded': { setting: 'set-rain', group: 'check' },
	'rain.unitGauge.unreliable': { setting: 'set-rain', group: 'check' },
	// A unit's rain rule fell back to the catchment's rain (runoff/unitRain.ts).
	'rain.unit.catchmentFallback': { setting: 'set-unit-rain', group: 'check' },

	// Calibration (run.ts): the record scored, its site and its window.
	'calibration.noObserved': { setting: 'set-record', group: 'check' },
	'calibration.allExcluded': { setting: 'set-record', group: 'check' },
	'calibration.noValuesInWindow': { setting: 'set-record', group: 'check' },
	'calibration.noValuesInPeriod': { setting: 'set-period', group: 'check' },
	'calibration.windowReversed': { setting: 'set-record', group: 'check' },
	'calibration.flowKindMissing': { setting: 'set-record', group: 'check' },
	'calibration.defaultGaugePick': { setting: 'set-record', group: 'check' },
	'calibration.site.unusable': { setting: 'set-record', group: 'check' },
	'calibration.site.noRecord': { setting: 'set-record', group: 'check' }
} as const satisfies Record<string, WarningCodeInfo>;

export type WarningCode = keyof typeof WARNING_CODES;

/** One coded run warning: its code, the figures and names it reports, and its text exactly as summary.warnings has it. */
export interface CodedWarning {
	code: WarningCode;
	params: WarningParams;
	text: string;
}

export const isWarningCode = (c: unknown): c is WarningCode => typeof c === 'string' && Object.hasOwn(WARNING_CODES, c);

/**
 * The codes the engine gave its warning texts. Warnings travel as plain strings: ~40 helpers return string[] that
 * their callers merge with push(...), so a code can't ride along on the array. `warn` keys it on the text instead,
 * and warningCodesOf reads it back for the summary's final warnings. Bounded: the oldest entries go past
 * REGISTRY_MAX, and `warn` moves a text it sees again to the newest end, so every text of the run being summarised is
 * still held (a run gives a few hundred at most). Two codes never build the same text (each template differs), so a
 * text maps to one code whichever run registered it, nested runs included.
 */
const registry = new Map<string, { code: WarningCode; params: WarningParams }>();
const REGISTRY_MAX = 4096;

/**
 * A run warning with its code: returns `text` (push it onto the warnings as before), and records the code and params
 * for summary.warningCodes. Use at the push site: `warnings.push(warn('rain.none', {}, '…'))`.
 */
export function warn(code: WarningCode, params: WarningParams, text: string): string {
	registry.delete(text);
	registry.set(text, { code, params });
	if (registry.size > REGISTRY_MAX) registry.delete(registry.keys().next().value!);
	return text;
}

/** The coded warnings among `warnings`, in their order (a repeated text repeats): summary.warningCodes. */
export function warningCodesOf(warnings: readonly string[]): CodedWarning[] {
	const out: CodedWarning[] = [];
	for (const text of warnings) {
		const hit = registry.get(text);
		if (hit) out.push({ code: hit.code, params: hit.params, text });
	}
	return out;
}
