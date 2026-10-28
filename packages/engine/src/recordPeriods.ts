// Periods of one stored record, named by its series id (issue #611 slice 2,
// engine ≥ 1.102.0, docs/model.md §2.4i and §2.10h):
//
// - settings.flowMissing: series id → the periods of that flow record to
//   treat as missing. Unlike settings.calibrationExclusions, which leaves a
//   period out of every record's scores, it blanks the days of one record
//   only, where the run reads it (prepareRun, before anything aligns it): the
//   calibration statistics, the EWR test on the observed record, the
//   plausibility checks, the fit's problem and its per-day classes
//   (`missing`) all see a gap there, and the record's gap fill
//   (settings.flowGapFill) may fill it like any other gap, the filled day
//   then following settings.qualityFlags.infilled. The stored series never
//   changes, and no flow record drives the simulation, so the water balance
//   is untouched.
// - settings.rainStations.unreliable, widened from the rainfall stations to
//   every rain record: the alternative catchment gauge
//   (`rain_catchment_alt_mm`, read through §2.4e's rain-source periods) is
//   blanked here too, before the rain-source periods read it; a unit's own
//   gauge after its §2.4c/§2.4d checks (./runoff/unitGaugeChecks.ts), as a
//   station's is (./runoff/stationRecord.ts), so the period never looks like a
//   blank outage. The catchment gauge's own days are settings.zeroRainRuns
//   .missing's, as before.
// - settings.checksKept: the data-check items (ids `<check>:<seriesId>:<start>:<end>`)
//   the user kept as recorded. No run effect, but one: a kept outlier or
//   flat stretch of a flow record is no longer `suspect` there
//   (./calibrate/dayFlags.ts), so "keep" means the record is scored as read.
//
// A record is matched by DailySeries.seriesId, which the backend sets on every
// stored series it reads (and a run's snapshot keeps). A series without one (an
// input made by hand, a run stored before it) matches nothing.
import { isIsoDate, toEpochDay } from './calendar';
import { exclusionRange, sanitizeExclusions, type CalibrationExclusion } from './calibrate/provenance';
import { CALIBRATION_FLOW_KINDS, SERIES_KIND_LABELS, type DailySeries, type ModelInput, type ProjectSettings } from './project';

/** settings.flowMissing: series id → the periods of that flow record treated as missing. */
export type FlowMissingSettings = Record<string, CalibrationExclusion[]>;

/** Most flow records settings.flowMissing may name. */
export const FLOW_MISSING_RECORDS_MAX = 50;

/** The flow kinds a record of settings.flowMissing may be: the calibration records and the reference gauge, at the outlet or a gauge. */
export const FLOW_RECORD_KINDS = [...CALIBRATION_FLOW_KINDS, 'flow_reference_m3s'] as const;
/** The rain kinds whose records settings.rainStations.unreliable may name: a station or a unit's own gauge (`rain_catchment_mm`), the alternative gauge. */
export const RAIN_RECORD_KINDS = ['rain_catchment_mm', 'rain_catchment_alt_mm'] as const;

const FLOW_KINDS: ReadonlySet<string> = new Set(FLOW_RECORD_KINDS);

/** Whether a series key is a flow record: an outlet flow kind, or a gauge's `<kind>@<node>`. */
export function isFlowRecordKey(key: string): boolean {
	if (key.includes('#')) return false;
	const at = key.indexOf('@');
	return FLOW_KINDS.has(at < 0 ? key : key.slice(0, at));
}

/** A key JSON.parse keeps but a plain object would answer from its prototype (`__proto__`, `constructor`, `prototype`); never written. */
function unsafeKey(k: string): boolean {
	return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

/**
 * settings.flowMissing as the engine reads it: an object of series id → a
 * period list (sanitizeExclusions's rules). A malformed entry is dropped with
 * a warning (the API refuses it on save); an empty list is dropped silently.
 * Null when absent, so settings without it normalise as before.
 */
export function resolveFlowMissing(raw: unknown, warnings: string[]): FlowMissingSettings | null {
	if (raw == null) return null;
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		warnings.push('flow missing periods are not an object of series id → periods; ignored');
		return null;
	}
	const out: FlowMissingSettings = {};
	for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
		if (!id || unsafeKey(id)) continue;
		const periods = sanitizeExclusions(list, warnings, 'flow missing period');
		if (periods.length) out[id] = periods;
	}
	return out;
}

/** settings.checksKept as the engine reads it: the strings, each once; null when absent. */
export function resolveChecksKept(raw: unknown, warnings: string[]): string[] | null {
	if (raw == null) return null;
	if (!Array.isArray(raw)) {
		warnings.push('kept data checks are not a list; ignored');
		return null;
	}
	const out = [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.length > 0))];
	if (out.length !== raw.length) warnings.push('kept data checks: an entry that isn’t an item id, or one listed twice, is ignored');
	return out;
}

/** The inclusive epoch-day ranges of settings.rainStations.unreliable[seriesId] (malformed periods skipped: the station's own checks warn of them). */
export function unreliableRanges(settings: Pick<ProjectSettings, 'rainStations'>, seriesId: string | null | undefined): [number, number][] {
	if (!seriesId) return [];
	const periods = settings.rainStations?.unreliable?.[seriesId];
	if (!Array.isArray(periods)) return [];
	const out: [number, number][] = [];
	for (const p of periods) {
		const [from, to] = Array.isArray(p) ? p : [];
		if (isIsoDate(from) && isIsoDate(to) && from <= to) out.push([toEpochDay(from), toEpochDay(to)]);
	}
	return out;
}

/** `s` with the days of `ranges` blanked, and how many readings that removed; `s` itself when it removes none. */
export function blankRanges(s: DailySeries, ranges: readonly (readonly [number, number])[]): { series: DailySeries; blanked: number } {
	if (!ranges.length || !s.values.length) return { series: s, blanked: 0 };
	const d0 = toEpochDay(s.startDate);
	let values: (number | null)[] | null = null;
	let blanked = 0;
	for (const [from, to] of ranges) {
		const a = Math.max(from - d0, 0);
		const b = Math.min(to - d0, s.values.length - 1);
		for (let i = a; i <= b; i++) {
			if (s.values[i] === null) continue;
			values ??= s.values.slice();
			// A NaN or a negative reading is missing already; it is blanked, but isn't counted as a reading set aside.
			const v = s.values[i];
			if (typeof v === 'number' && Number.isFinite(v) && v >= 0) blanked++;
			values[i] = null;
		}
	}
	return values ? { series: { ...s, values }, blanked } : { series: s, blanked: 0 };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A flow record's key in words, for a warning. */
function flowRecordName(key: string): string {
	const at = key.indexOf('@');
	const kind = at < 0 ? key : key.slice(0, at);
	const label = (SERIES_KIND_LABELS as Record<string, string>)[kind] ?? kind;
	return at < 0 ? label : `${label} at a gauge`;
}

/**
 * The input's series with each record's own periods blanked: settings
 * .flowMissing on the flow records and settings.rainStations.unreliable on
 * the alternative catchment gauge, matched by DailySeries.seriesId (see the
 * header). A warning names each record that lost readings. Returns `series`
 * itself when nothing is blanked, so a project without either runs as
 * before. Idempotent.
 */
export function withRecordPeriods(settings: Pick<ProjectSettings, 'flowMissing' | 'rainStations'>, series: ModelInput['series'], warnings: string[]): ModelInput['series'] {
	const fm = settings.flowMissing;
	const altId = series.rain_catchment_alt_mm?.seriesId;
	const altRanges = altId ? unreliableRanges(settings, altId) : [];
	if ((!fm || !Object.keys(fm).length) && !altRanges.length) return series;
	let out: Record<string, DailySeries> | null = null;
	const all = series as Record<string, DailySeries | undefined>;
	for (const [key, s] of Object.entries(all)) {
		if (!s || unsafeKey(key)) continue;
		const ranges: [number, number][] =
			key === 'rain_catchment_alt_mm'
				? altRanges
				: fm && s.seriesId && isFlowRecordKey(key)
					? (fm[s.seriesId] ?? []).map((x) => {
							const r = exclusionRange(x);
							return [toEpochDay(r.start), toEpochDay(r.end)] as [number, number];
						})
					: [];
		const r = blankRanges(s, ranges);
		if (r.series === s) continue;
		(out ??= { ...(series as Record<string, DailySeries>) })[key] = r.series;
		if (r.blanked === 0) continue;
		warnings.push(
			key === 'rain_catchment_alt_mm'
				? `the alternative catchment gauge is treated as missing on ${plural(r.blanked, 'day')} the user marked unreliable, so the rain-source periods' next source stands in there. The stored series is unchanged.`
				: `${flowRecordName(key)}: ${plural(r.blanked, 'reading')} in its own missing periods (set under Calibration → Calibration record) are treated as missing: the calibration statistics, the fit, the EWR test on the observed record and the plausibility checks skip them, and the record's gap fill may fill them. The stored series is unchanged.`
		);
	}
	return (out ?? series) as ModelInput['series'];
}
