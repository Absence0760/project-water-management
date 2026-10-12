// A published DWS gauge record among a run's stored series (issue #523 G8,
// 232_small_catchments.sql; docs/security.md § The k rule on series).
//
// The outlet's observed flow is one of the use's series: natural flow less it
// is the farms' use upstream, so a share link and an applicant read it only
// past the k and dominance rules. But a record DWS Hydrological Services
// publishes is public already: hiding it below five holders protects no one
// and makes the app look secretive (the licensing assessors' review of #523).
// So a run marks the outlet's observed series that hold such a record, and
// the policies show those at any holder count.
//
// What counts, decided when the run reads its inputs (runs/execute.ts
// loadLiveInput, in the same statement as the values): an outlet flow record
// (flow_observed_m3s or flow_logger_m3s, no site) whose every reading a DWS
// data feed wrote (time_series.feed_id + feed_days, 031: a person's upload or
// edit releases the days it covers), from a river gauge (an H code,
// feeds/config.ts DWS_RIVER_GAUGE). Not the series' free-text `source`: an
// editor's word that a record is DWS's would let a private logger, labelled
// so by mistake, through. A DWS record imported from a workbook stays under
// the k rule until a DWS feed writes it (fail closed).
//
// A run that gap-filled the record (its `<key>_fill` series, engine ≥ 1.23.0)
// is not marked: a filled day may come from a donor record, a private logger
// among them, so the stored series is no longer DWS's alone. A scenario run
// is never marked (its plan carries no records): an applicant reads the gauge
// record from the published base run, where it is the same input.
import { type CalibrationFlowKind, OBSERVED_SERIES_LABEL } from '@water-management/engine';
import { DWS_RIVER_GAUGE } from '../feeds/config.js';

/** The outlet's flow records a DWS river gauge feed wrote whole, by kind: the station code. */
export type PublishedRecords = Partial<Record<CalibrationFlowKind, string>>;

/** What a marked series' run_series.meta carries beside its label and unit (232). */
export interface PublishedMeta {
	publishedBy: 'DWS';
	station: string;
}

/** The run_series keys an outlet flow record is stored under (engine run.ts). */
export const PUBLISHED_RECORD_KEYS = ['observed_flow', 'observed_flow_other'] as const;

const KIND_BY_LABEL = new Map(Object.entries(OBSERVED_SERIES_LABEL).map(([kind, label]) => [label, kind as CalibrationFlowKind]));

/** A station code a feed's config may hold, kept only when it is a DWS river gauge's. */
export function riverGauge(station: string | null | undefined): string | null {
	return typeof station === 'string' && DWS_RIVER_GAUGE.test(station) ? station : null;
}

/**
 * The meta to add to each of a run's output series that holds a published
 * DWS record, keyed `${key}` (outlet series only; a node's never). Reads the
 * engine's own labels to tell which record a key holds (OBSERVED_SERIES_LABEL).
 */
export function publishedRecordMeta(
	series: readonly { nodeId: string | null; key: string; label: string }[],
	records: PublishedRecords | undefined
): Map<string, PublishedMeta> {
	const out = new Map<string, PublishedMeta>();
	if (!records) return out;
	const outlet = new Set(series.filter((s) => s.nodeId === null).map((s) => s.key));
	for (const s of series) {
		if (s.nodeId !== null || !(PUBLISHED_RECORD_KEYS as readonly string[]).includes(s.key)) continue;
		// Gap-filled: a filled day may be a donor record's (module comment).
		if (outlet.has(`${s.key}_fill`)) continue;
		const kind = KIND_BY_LABEL.get(s.label);
		const station = kind ? riverGauge(records[kind]) : null;
		if (station) out.set(s.key, { publishedBy: 'DWS', station });
	}
	return out;
}
