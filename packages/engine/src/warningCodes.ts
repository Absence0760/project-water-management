// Stable codes for the run warnings (engine ≥ 1.102.0, issue #611 phase 2):
// summary.warningCodes lists each coded warning as { code, params, text }
// beside summary.warnings, whose strings are unchanged (expand, then
// contract). A page can then group, count and link a warning by its code
// instead of matching its English (frontend runs/credibility.ts), and the
// warnings page can offer "go to setting" from the catalogue's `setting`.
//
// Only the actionable warnings carry a code so far: the data checks, the rain
// chain (zero runs, accumulations, the CHIRPS and gap-product fallbacks, rain
// stations and unit gauges), calibration, its zones included, and a unit area
// from an earlier map outline (issue #646 F6). The unit-share notes (the EWR
// split and the retired flow-share method, issues #615 and #616) stay uncoded
// for now; the area-fragmentation, High/Low-MAP and areaMismatches warnings
// went with the flow-share methods in engine 1.105.0. An uncoded warning is in
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
	 * Data page (load or rename a series), or for a `map.` code on the Map, not a setting.
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

	// The map (mapAreas.ts): a unit's area is from an earlier outline of its polygon (issue #646 F6): params { unit, modelKm2, mapKm2 }.
	// The fix is on the Map (warnings/fixes.ts), not a setting.
	'map.areaFromEarlierOutline': { setting: null, group: 'check' },

	// Calibration (run.ts): the record scored, its site and its window.
	'calibration.noObserved': { setting: 'set-record', group: 'check' },
	'calibration.allExcluded': { setting: 'set-record', group: 'check' },
	'calibration.noValuesInWindow': { setting: 'set-record', group: 'check' },
	'calibration.noValuesInPeriod': { setting: 'set-period', group: 'check' },
	'calibration.windowReversed': { setting: 'set-record', group: 'check' },
	'calibration.flowKindMissing': { setting: 'set-record', group: 'check' },
	'calibration.defaultGaugePick': { setting: 'set-record', group: 'check' },
	'calibration.site.unusable': { setting: 'set-record', group: 'check' },
	'calibration.site.noRecord': { setting: 'set-record', group: 'check' },
	// Calibration zones (calibrate/zones.ts, engine 1.106.0, issue #555): a stored row that can't be read (params
	// { node?, reason? }), a ticked row that can't define a zone
	// ({ node, reason }), a zone not fitted yet ({ node, name }), and the parts that read only the site's zone
	// ({ units, zones }).
	'calibration.zone.notList': { setting: 'set-record', group: 'check' },
	'calibration.zone.noGauge': { setting: 'set-record', group: 'check' },
	'calibration.zone.duplicate': { setting: 'set-record', group: 'check' },
	'calibration.zone.badParams': { setting: 'set-record', group: 'check' },
	'calibration.zone.unusable': { setting: 'set-record', group: 'check' },
	'calibration.zone.unfitted': { setting: 'set-fit', group: 'check' },
	'calibration.zone.siteOnlyElsewhere': { setting: 'set-record', group: 'note' }
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
 * The codes the engine gave its warning texts during one run. Warnings travel as plain strings: ~40 helpers return
 * string[] that their callers merge with push(...), so a code can't ride along on the array. `warn` records it in the
 * innermost open scope instead (runs are synchronous, so a stack nests: a run started inside another, a forecast's
 * history run or a calibration's, records into its own), and the run reads its scope back for its summary's final
 * warnings. Outside any scope `warn` records nothing, so no code outlives its run or leaks into another.
 */
export interface WarningScope {
	/**
	 * The coded warnings among `warnings`, in their order: each text takes the next code recorded for that text in this
	 * scope, once (a warning pushed twice, coded twice, repeats; a copy pushed uncoded beyond what was recorded stays
	 * uncoded). Params are this scope's own.
	 */
	codesOf(warnings: readonly string[]): CodedWarning[];
}

type Recorded = Map<string, { code: WarningCode; params: WarningParams }[]>;
const scopes: Recorded[] = [];

/** Run `body` with a scope of its own for the codes `warn` records; the scope closes when it returns or throws. */
export function withWarningScope<T>(body: (scope: WarningScope) => T): T {
	const recorded: Recorded = new Map();
	scopes.push(recorded);
	const scope: WarningScope = {
		codesOf(warnings) {
			const used = new Map<string, number>();
			const out: CodedWarning[] = [];
			for (const text of warnings) {
				const k = used.get(text) ?? 0;
				const hit = recorded.get(text)?.[k];
				if (!hit) continue;
				used.set(text, k + 1);
				out.push({ code: hit.code, params: hit.params, text });
			}
			return out;
		}
	};
	try {
		return body(scope);
	} finally {
		scopes.splice(scopes.lastIndexOf(recorded), 1);
	}
}

/**
 * A run warning with its code: returns `text` (push it onto the warnings as before), and records the code and params
 * in the run's scope for summary.warningCodes. Use at the push site: `warnings.push(warn('rain.none', {}, '…'))`.
 */
export function warn(code: WarningCode, params: WarningParams, text: string): string {
	const recorded = scopes.at(-1);
	if (recorded) {
		const list = recorded.get(text);
		if (list) list.push({ code, params });
		else recorded.set(text, [{ code, params }]);
	}
	return text;
}
