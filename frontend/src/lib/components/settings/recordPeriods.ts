// The periods settings keep per stored record, by its series id (engine ≥
// 1.102.0, issue #611, docs/model.md §2.4i and §2.10h): settings.flowMissing
// (a flow record's missing periods, on Calibration → Calibration record) and
// settings.rainStations.unreliable, widened to every rain record (Model
// settings → Rain gaps → Flagged rain). The lists the two forms show, their
// labels, and how a record's list is written back.
import { FLOW_RECORD_KINDS, isIsoDate, RAIN_RECORD_KINDS, seriesDisplayName, type RainStationSettings } from '@water-management/engine';
import { tidyStations } from './flowGeneration';

/** A record a list belongs to, as a form names it. */
export interface RecordOption {
	id: string;
	label: string;
}

/** Most unreliable periods one rain record may keep (backend RAIN_STATION_PERIODS_MAX). */
export const UNRELIABLE_PERIODS_MAX = 200;

type SeriesLike = { id: string; kind: string; name: string; siteNodeId?: string | null };

/**
 * The records of `kinds` among the project's series, each named by its series' name (else its kind) and, for a
 * gauge's or a unit's own record, the node it is attached to; sorted by that label.
 */
export function recordOptions(series: readonly SeriesLike[] | null | undefined, kinds: readonly string[], nodeName: (id: string) => string | null | undefined = () => null): RecordOption[] {
	return (series ?? [])
		.filter((s) => kinds.includes(s.kind))
		.map((s) => {
			const site = s.siteNodeId ? (nodeName(s.siteNodeId) ?? 'a unit no longer in the model') : null;
			return { id: s.id, label: `${seriesDisplayName(s.kind, s.name)}${site ? ` (${site})` : ''}` };
		})
		.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : 1));
}

/** The rain records whose unreliable periods count: every catchment rain series, a unit's own gauge, the alternative gauge. */
export const rainRecordOptions = (series: readonly SeriesLike[] | null | undefined, nodeName?: (id: string) => string | null | undefined) =>
	recordOptions(series, RAIN_RECORD_KINDS, nodeName);

/** The flow records settings.flowMissing may name. */
export const flowRecordOptions = (series: readonly SeriesLike[] | null | undefined, nodeName?: (id: string) => string | null | undefined) => recordOptions(series, FLOW_RECORD_KINDS, nodeName);

/**
 * Records a stored map names that the series list doesn't (deleted since, restorable under their id), so the form
 * still shows their lists: each as "a deleted series", after the listed ones.
 */
export function withUnlisted(options: readonly RecordOption[], stored: Record<string, unknown> | null | undefined): RecordOption[] {
	const known = new Set(options.map((o) => o.id));
	return [...options, ...Object.keys(stored ?? {}).filter((id) => !known.has(id)).sort().map((id) => ({ id, label: 'A deleted series' }))];
}

/** `map` with record `id`'s list set to `list` (removed when empty); null when no record keeps a list. */
export function withRecordList<T>(map: Record<string, T[]> | null | undefined, id: string, list: readonly T[]): Record<string, T[]> | null {
	const out: Record<string, T[]> = { ...(map ?? {}) };
	if (list.length) out[id] = [...list];
	else delete out[id];
	return Object.keys(out).length ? out : null;
}

/** settings.rainStations with rain record `id`'s unreliable periods set to `list`; null when nothing is left in it (flowGeneration tidyStations). */
export function withUnreliable(rs: RainStationSettings | null | undefined, id: string, list: readonly [string, string][]): RainStationSettings | null {
	return tidyStations({ ...(rs ?? {}), unreliable: withRecordList(rs?.unreliable, id, list) ?? {} });
}

/** Why a rain record's unreliable periods can't be saved, or null: real dates, each period in order, at most UNRELIABLE_PERIODS_MAX. */
export function unreliableError(list: readonly [string, string][]): string | null {
	if (list.length > UNRELIABLE_PERIODS_MAX) return `At most ${UNRELIABLE_PERIODS_MAX} unreliable periods a record: merge neighbouring periods into one`;
	for (let i = 0; i < list.length; i++) {
		const [from, to] = list[i]!;
		if (!isIsoDate(from) || !isIsoDate(to)) return `Unreliable period ${i + 1}: give both dates`;
		if (from > to) return `Unreliable period ${i + 1}: ends before it starts`;
	}
	return null;
}
