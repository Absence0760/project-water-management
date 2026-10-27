// Data + filter logic behind the Data tab's "Preview all data" dialog
// (SeriesPreviewDialog.svelte): one wide table, one row per day across the
// union of every input series' period, one column per series plus columns
// for how the model used that day's data. No Svelte, no DOM — pure and unit
// tested directly.
//
// The "how the model used it" columns are computed with the engine's own
// prepareRun (./run.ts) and its rain.ts gap-fill/CHIRPS bias correction —
// not reimplemented here. The only logic written locally is the trivial
// "which of the three already-resolved rain values is present" pick, which
// mirrors the one-liner runoff/simulate.ts's runoffForcing and the legacy
// flow.ts's rainUsed already use (neither is reusable directly: one needs PET
// settings unrelated to this table, the other is model-private and applies a
// threshold that is a natural-flow detail, not part of gap-fill itself).
import {
	compareSeriesNames,
	hasRainInput,
	isLandUnit,
	chirpsFactorOn,
	exclusionRanges,
	fromEpochDay,
	prepareRun,
	SERIES_KINDS,
	resolveDataQuality,
	seriesRowFlags,
	toEpochDay,
	type DailySeries,
	type ModelInput,
	type NetworkNode,
	type ProjectModel,
	type ProjectSettings,
	type SeriesKind,
	type SeriesMeta,
	type StationRainDaySource
} from '@water-management/engine';
import { dayPrefix, fmtNum } from '#lib/format/number.js';
import { seriesKindLabel } from '#lib/series/kinds.js';
import { firstOutletSeries } from '#lib/series/pick.js';
import type { Daily } from './coverage';
import type { AreaRainLines } from './derivedRain';
import { asksStation } from './station';

export type PreviewFlag = 'missing' | 'negative' | 'outlier' | 'flatline';

export const FLAG_LABEL: Record<PreviewFlag, string> = {
	missing: 'Missing',
	negative: 'Negative',
	outlier: 'Outlier',
	flatline: 'Flat-line'
};

export interface PreviewSeriesCell {
	value: number | null;
	flags: PreviewFlag[];
	/** Flow series only: the same value in m³/day; null for a rain series or a missing day. */
	m3Day: number | null;
}

export type RainSource = 'catchment' | 'chirps' | 'forecast' | 'none';

export interface PreviewDerivedCell {
	rainUsedMm: number | null;
	/** null = outside the model's run window (no rain series at all, or before/after the simulation period). */
	rainSource: RainSource | null;
	/** This calendar month's CHIRPS bias factor, when a CHIRPS series exists and one could be fitted. */
	chirpsFactor: number | null;
	/** CHIRPS as the model reads it: bias-corrected on the days it fills in for blank catchment rain, as stored otherwise. */
	chirpsCorrectedMm: number | null;
	excluded: boolean;
	exclusionReason: string | null;
}

export interface PreviewRow {
	date: string;
	/** Keyed by series id. */
	series: Record<string, PreviewSeriesCell>;
	derived: PreviewDerivedCell;
}

export interface PreviewColumn {
	id: string;
	label: string;
	unit: string;
	/** `area`: an area's rain under its station (issue #553), derived when viewed and never stored. */
	group: 'series' | 'derived' | 'area';
	/**
	 * Set for a `series` column and its `m3day:` companion — which series row it highlights — and for an area's raw
	 * lines in its own view (the station, the area's CHIRPS), so the row filters and the flags read that series there.
	 */
	seriesId?: string;
	/** Set for an `area` column: whose rain (null: the average catchment rainfall) and which line. */
	area?: { nodeId: string | null; line: AreaLine };
	/**
	 * The header's HelpTip key ($lib/help/content): `series.<SeriesKind>` for a
	 * raw series, `preview.<column>` for a derived one. The Date column's own
	 * key is PREVIEW_DATE_HELP_KEY.
	 */
	helpKey: string;
}

/**
 * The unit the column header shows after its label, or null when there's none
 * or the label already names it (a flow series' m³/day column is labelled
 * "… (m³/day)" so the column picker can tell it from the m³/s column; its
 * header shouldn't then read "(m³/day)(m³/day)").
 */
export function headerUnit(col: Pick<PreviewColumn, 'label' | 'unit'>): string | null {
	if (!col.unit || col.label.endsWith(`(${col.unit})`)) return null;
	return col.unit;
}

/** The Date column's HelpTip key (the Date column isn't a PreviewColumn). */
export const PREVIEW_DATE_HELP_KEY = 'preview.date';

const SEC_PER_DAY = 86_400;
const EMPTY_MODEL: ProjectModel = { nodes: [], crops: [], cropAreas: [], transfers: [] };

/** The series id `Preview` on a row opens the dialog scrolled/highlighted to. */
export const seriesColumnId = (seriesId: string): string => `series:${seriesId}`;
export const m3DayColumnId = (seriesId: string): string => `m3day:${seriesId}`;

/** One column per series in `list` (same order, labels and units as the Input time series table), plus a m³/day column for each flow series and the derived "how the model used it" columns. */
export function buildPreviewColumns(list: readonly SeriesMeta[]): PreviewColumn[] {
	const label = (s: SeriesMeta) => `${seriesKindLabel(s)}${s.name ? ` · ${s.name}` : ''}`;
	const seriesCols: PreviewColumn[] = list.map((s) => ({
		id: seriesColumnId(s.id),
		label: label(s),
		unit: s.unit,
		group: 'series',
		seriesId: s.id,
		helpKey: `series.${s.kind}`
	}));
	const flowCols: PreviewColumn[] = list
		.filter((s) => s.kind.startsWith('flow_'))
		.map((s) => ({
			id: m3DayColumnId(s.id),
			label: `${label(s)} (m³/day)`,
			unit: 'm³/day',
			group: 'derived',
			seriesId: s.id,
			helpKey: 'preview.flowM3Day'
		}));
	const hasRain = list.some((s) => s.kind.startsWith('rain_'));
	const hasChirps = list.some((s) => s.kind === 'rain_chirps_mm');
	const derivedCols: PreviewColumn[] = [
		...(hasRain ? [{ id: 'rainUsed', label: 'Rain used (model)', unit: 'mm', group: 'derived' as const, helpKey: 'preview.rainUsed' }] : []),
		...(hasChirps
			? [
					{ id: 'chirpsFactor', label: 'CHIRPS bias factor', unit: '×', group: 'derived' as const, helpKey: 'preview.chirpsFactor' },
					{ id: 'chirpsCorrected', label: 'CHIRPS (corrected)', unit: 'mm', group: 'derived' as const, helpKey: 'preview.chirpsCorrected' }
				]
			: []),
		{ id: 'excluded', label: 'Excluded from calibration', unit: '', group: 'derived' as const, helpKey: 'preview.excluded' }
	];
	return [...seriesCols, ...flowCols, ...derivedCols];
}

/**
 * The first series of each kind by name — the same rule a run uses (lib/series/pick.ts, byte order),
 * among the outlet's: a flow record attached to a gauge node (084_gauge_records) is that gauge's, never the outlet's.
 */
function firstByKind(list: readonly SeriesMeta[], valuesById: Readonly<Record<string, Daily>>): Partial<Record<SeriesKind, DailySeries>> {
	const out: Partial<Record<SeriesKind, DailySeries>> = {};
	for (const k of SERIES_KINDS) {
		const s = firstOutletSeries(list, k);
		const d = s && valuesById[s.id];
		if (d) out[k] = d;
	}
	return out;
}

type DerivedByDate = Map<string, Omit<PreviewDerivedCell, 'excluded' | 'exclusionReason'>>;

/**
 * Per-day rain-used/source and CHIRPS bias correction, over prepareRun's own
 * run window. Empty when the project has no rain series at all, or when
 * prepareRun rejects the settings (e.g. a simulation end before its start) —
 * the table still shows the raw series columns then, just none of the
 * rain-derived ones.
 */
function buildDerivedByDate(list: readonly SeriesMeta[], valuesById: Readonly<Record<string, Daily>>, settings: ProjectSettings): DerivedByDate {
	const out: DerivedByDate = new Map();
	const series = firstByKind(list, valuesById);
	// A rain-source period's series counts as rain too (engine ≥ 1.69.0, hasRainInput).
	if (!hasRainInput(series, settings.rainSource)) return out;

	let prepared: ReturnType<typeof prepareRun>;
	try {
		prepared = prepareRun({ settings: settings as unknown as ModelInput['settings'], model: EMPTY_MODEL, series });
	} catch {
		return out;
	}

	const catchment = prepared.aligned('rain_catchment_mm');
	const chirps = prepared.aligned('rain_chirps_mm');
	const forecast = prepared.aligned('rain_forecast_mm');
	const d0 = toEpochDay(prepared.startDate);
	for (let t = 0; t < prepared.days; t++) {
		const c = catchment[t] ?? null;
		const ch = chirps[t] ?? null;
		const f = forecast[t] ?? null;
		const rainSource: RainSource = c !== null ? 'catchment' : ch !== null ? 'chirps' : f !== null ? 'forecast' : 'none';
		out.set(fromEpochDay(d0 + t), {
			rainUsedMm: c ?? ch ?? f,
			rainSource,
			// The day's own fit segment's factor with a CHIRPS fit period (engine ≥ 0.29.0), else its calendar month's.
			chirpsFactor: chirpsFactorOn(prepared.chirpsCorrection, d0 + t),
			chirpsCorrectedMm: ch
		});
	}
	return out;
}

/**
 * One row per day across the union of every series in `list` that has loaded
 * values (min start to max end), joining each series' own value + quality
 * flags (engine `seriesRowFlags` — the same rules `checkSeries` reports, not
 * reimplemented) and the derived "how the model used it" columns.
 */
export function buildPreviewRows(list: readonly SeriesMeta[], valuesById: Readonly<Record<string, Daily>>, settings: ProjectSettings): PreviewRow[] {
	const withData = list.filter((s) => valuesById[s.id]);
	if (withData.length === 0) return [];

	let minDay = Infinity;
	let maxDay = -Infinity;
	for (const s of withData) {
		const d = valuesById[s.id]!;
		const d0 = toEpochDay(d.startDate);
		minDay = Math.min(minDay, d0);
		maxDay = Math.max(maxDay, d0 + d.values.length - 1);
	}

	// The project's data-quality limits (engine ≥ 1.20.0), as a run applies them.
	const dq = resolveDataQuality(settings.dataQuality);
	const flagsById = new Map<string, ReturnType<typeof seriesRowFlags> | null>();
	for (const s of withData) {
		const d = valuesById[s.id]!;
		flagsById.set(s.id, (SERIES_KINDS as readonly string[]).includes(s.kind) ? seriesRowFlags(s.kind as SeriesKind, d, dq) : null);
	}

	const derivedByDate = buildDerivedByDate(list, valuesById, settings);
	const exclusions = exclusionRanges(settings.calibrationExclusions ?? []);

	const rows: PreviewRow[] = [];
	for (let day = minDay; day <= maxDay; day++) {
		const date = fromEpochDay(day);
		const seriesCells: Record<string, PreviewSeriesCell> = {};
		for (const s of withData) {
			const d = valuesById[s.id]!;
			const d0 = toEpochDay(d.startDate);
			const i = day - d0;
			const inRange = i >= 0 && i < d.values.length;
			const raw = inRange ? d.values[i] : null;
			const value = raw == null || !Number.isFinite(raw) ? null : raw;
			const flags: PreviewFlag[] = [];
			if (value === null) flags.push('missing');
			const f = inRange ? flagsById.get(s.id) : null;
			if (f) {
				if (f.negative[i]) flags.push('negative');
				if (f.outlier[i]) flags.push('outlier');
				if (f.flatline[i]) flags.push('flatline');
			}
			seriesCells[s.id] = { value, flags, m3Day: value !== null && s.kind.startsWith('flow_') ? value * SEC_PER_DAY : null };
		}
		const drv = derivedByDate.get(date);
		const excl = exclusions.find((r) => r.start <= date && date <= r.end);
		rows.push({
			date,
			series: seriesCells,
			derived: {
				rainUsedMm: drv?.rainUsedMm ?? null,
				rainSource: drv?.rainSource ?? null,
				chirpsFactor: drv?.chirpsFactor ?? null,
				chirpsCorrectedMm: drv?.chirpsCorrectedMm ?? null,
				excluded: excl !== undefined,
				exclusionReason: excl?.reason ?? null
			}
		});
	}
	return rows;
}

export interface PreviewFilterState {
	query: string;
	missingOnly: boolean;
	flaggedOnly: boolean;
	/** Series ids whose column is currently shown; the toggles and a value comparison look only at these. */
	visibleSeriesIds: readonly string[];
}

const COMPARISON = /^(>=|<=|==|>|<|=)\s*(-?\d+(?:\.\d+)?)$/;

/**
 * Parses a value-comparison query ("> 20", ">=20", "= 0", "==0", "< 5") into a
 * predicate; null when `query` isn't that shape (so the caller falls back to
 * a date-prefix match).
 */
export function parseValueComparison(query: string): ((v: number) => boolean) | null {
	const m = COMPARISON.exec(query.trim());
	if (!m) return null;
	const n = Number(m[2]);
	if (!Number.isFinite(n)) return null;
	switch (m[1]) {
		case '>':
			return (v) => v > n;
		case '>=':
			return (v) => v >= n;
		case '<':
			return (v) => v < n;
		case '<=':
			return (v) => v <= n;
		default:
			return (v) => v === n; // '=' or '=='
	}
}

/** The stored series whose values a set of columns shows: its series columns, and an area's raw lines in its own view. */
export const shownSeriesIds = (cols: readonly PreviewColumn[]): string[] => [
	...new Set(cols.filter((c) => c.seriesId && (c.group === 'series' || c.area)).map((c) => c.seriesId!))
];

/**
 * Filters `rows` for the Preview dialog's search box + toggles. A query
 * starting with a comparison operator ("> 20", "= 0") tests the visible
 * series' values that day; anything else is a date (dayPrefix: "2015",
 * "Mar 2015", "14 Mar 2015", "2015-03-14"), which is never scoped to visible series (a date
 * is a property of the row, not of one series' column). Missing/flagged only
 * look at the visible series columns only, combined with the query by AND.
 */
export function filterPreviewRows(rows: readonly PreviewRow[], { query, missingOnly, flaggedOnly, visibleSeriesIds }: PreviewFilterState): PreviewRow[] {
	const q = query.trim();
	const cmp = q ? parseValueComparison(q) : null;
	// The rows show their days day first, so "Mar 2015" or "14 Mar 2015" finds them as well as an ISO prefix.
	const date = dayPrefix(q);
	return rows.filter((r) => {
		if (missingOnly && !visibleSeriesIds.some((id) => r.series[id]?.value === null)) return false;
		if (flaggedOnly && !visibleSeriesIds.some((id) => (r.series[id]?.flags.length ?? 0) > 0)) return false;
		if (!q) return true;
		if (cmp) return visibleSeriesIds.some((id) => r.series[id] && r.series[id]!.value !== null && cmp(r.series[id]!.value!));
		return r.date.startsWith(date);
	});
}

// --- Each area's rain under its station (issue #553 round 5, docs/ui.md § Data) ---
// The columns the Data tab's Full CSV has per area (groupedCsv.ts): station × ratio, corrected CHIRPS, rain used
// and where each day's rain used came from. The lines are computed by SeriesTab (derivedRain.ts, the engine's
// stationAreaRain over the model input a run reads) and handed in; nothing here runs the engine.

export type AreaLine = 'stationRaw' | 'stationScaled' | 'chirpsRaw' | 'chirpsCorrected' | 'rainUsed' | 'source';

/** One area as the dialog gets it: the catchment (nodeId null) or a land unit, its lines, or why they couldn't be computed. */
export interface PreviewArea {
	nodeId: string | null;
	name: string;
	lines: AreaRainLines | null;
	error?: string | null;
}

export const areaColumnId = (nodeId: string | null, line: AreaLine): string => `area:${nodeId ?? 'catchment'}:${line}`;
export const areaTitle = (a: Pick<PreviewArea, 'nodeId' | 'name'>): string => (a.nodeId === null ? 'Average catchment rainfall' : a.name);

/**
 * Every line an area has, in the order a view shows them (issue #613). `inAll`: the line is one of the "All" view's
 * columns (the Full CSV's four); the station as recorded and the area's CHIRPS as stored are columns of their own
 * there already (stored series), so they sit beside their adjusted lines only in an area's own view.
 */
const AREA_LINES: readonly { line: AreaLine; what: string; unit: string; helpKey: string; inAll: boolean }[] = [
	{ line: 'stationRaw', what: 'station raw', unit: 'mm', helpKey: 'preview.areaStationRaw', inAll: false },
	{ line: 'stationScaled', what: 'station × ratio', unit: 'mm', helpKey: 'preview.areaStationScaled', inAll: true },
	{ line: 'chirpsRaw', what: 'CHIRPS raw', unit: 'mm', helpKey: 'preview.areaChirpsRaw', inAll: false },
	{ line: 'chirpsCorrected', what: 'CHIRPS corrected', unit: 'mm', helpKey: 'preview.areaChirpsCorrected', inAll: true },
	{ line: 'rainUsed', what: 'rain used', unit: 'mm', helpKey: 'preview.areaRainUsed', inAll: true },
	{ line: 'source', what: 'rain used from', unit: '', helpKey: 'preview.areaRainFrom', inAll: true }
];

/** Whether an area has a line: the CHIRPS lines only with CHIRPS of its own (the corrected one also needs a pairing that isn't refused). */
const hasLine = (lines: AreaRainLines, line: AreaLine) => (line === 'chirpsRaw' ? !!lines.chirpsRaw : line === 'chirpsCorrected' ? !!lines.chirpsCorrected : true);

/** Each area's columns for the "All" view, in the Full CSV's order and words; an area without lines adds none, and one without CHIRPS no corrected column. */
export function buildAreaColumns(areas: readonly PreviewArea[]): PreviewColumn[] {
	const out: PreviewColumn[] = [];
	for (const a of areas) {
		if (!a.lines) continue;
		for (const l of AREA_LINES) {
			if (!l.inAll || !hasLine(a.lines, l.line)) continue;
			out.push({ id: areaColumnId(a.nodeId, l.line), label: `${areaTitle(a)}: ${l.what}`, unit: l.unit, group: 'area', area: { nodeId: a.nodeId, line: l.line }, helpKey: l.helpKey });
		}
	}
	return out;
}

/**
 * One area's own view of its lines (issue #613): every line, the station raw and adjusted, the CHIRPS raw and
 * bias-corrected, the rain used and its source, each labelled with what it is made of. The ids are the "All"
 * view's, so a column hidden there is hidden here too.
 */
export function areaViewColumns(a: PreviewArea, stationName: (id: string) => string | null = () => null, chirpsSeriesId?: string): PreviewColumn[] {
	const lines = a.lines;
	if (!lines) return [];
	const f = lines.forcing;
	const station = f.stationName || stationName(f.stationId) || 'Station';
	const against = lines.correctAgainst === f.stationId ? station : (stationName(lines.correctAgainst) ?? 'a station no longer in the project');
	const name = a.nodeId === null ? 'Catchment' : a.name;
	const to = a.nodeId === null ? 'the catchment' : a.name;
	const label: Record<AreaLine, string> = {
		stationRaw: `${station} raw`,
		stationScaled: `${station} adjusted to ${to} (× ${fmtNum(f.ratio, 3)})`,
		chirpsRaw: `${name} CHIRPS raw`,
		chirpsCorrected: `${name} CHIRPS bias-corrected (f(m) against ${against})`,
		rainUsed: `${name} rain used`,
		source: `${name} rain used from`
	};
	return AREA_LINES.filter((l) => hasLine(lines, l.line)).map((l) => ({
		id: areaColumnId(a.nodeId, l.line),
		label: label[l.line],
		unit: l.unit,
		group: 'area' as const,
		area: { nodeId: a.nodeId, line: l.line },
		helpKey: l.helpKey,
		...(l.line === 'stationRaw' ? { seriesId: f.stationId } : l.line === 'chirpsRaw' && chirpsSeriesId ? { seriesId: chirpsSeriesId } : {})
	}));
}

// --- Views: which columns Preview all data shows (issue #613, docs/ui.md § Data) ---

/** A view's id, as the URL's `preview=` parameter carries it: all, unit:<node id>, stations, catchment or flow. */
export type PreviewViewId = string;

export interface PreviewView {
	id: PreviewViewId;
	label: string;
	/** Where the View select lists it: All first, then the land units, then the groups. */
	kind: 'all' | 'unit' | 'group';
}

export const PREVIEW_ALL: PreviewViewId = 'all';
export const unitViewId = (nodeId: string): PreviewViewId => `unit:${nodeId}`;

/**
 * The views the View select offers: All, each land unit by name in the model's order, then "All rainfall stations",
 * "Average catchment rainfall" (when Settings assigns the catchment a station) and "All flow", each only when it
 * would show something.
 */
export function previewViews(
	nodes: readonly NetworkNode[],
	settings: ProjectSettings | null | undefined,
	list: readonly Pick<SeriesMeta, 'kind' | 'siteNodeId'>[]
): PreviewView[] {
	const views: PreviewView[] = [{ id: PREVIEW_ALL, label: 'All', kind: 'all' }];
	for (const n of nodes) if (isLandUnit(n)) views.push({ id: unitViewId(n.id), label: n.name, kind: 'unit' });
	if (list.some(asksStation)) views.push({ id: 'stations', label: 'All rainfall stations', kind: 'group' });
	if (settings?.rainStations?.catchment?.stationId) views.push({ id: 'catchment', label: 'Average catchment rainfall', kind: 'group' });
	if (list.some((s) => s.kind.startsWith('flow_'))) views.push({ id: 'flow', label: 'All flow', kind: 'group' });
	return views;
}

/** The view `id` names when it is one of `views`, else All (a stale link: the unit was deleted, the station unassigned). */
export const resolveView = (views: readonly PreviewView[], id: string | null | undefined): PreviewViewId => (id && views.some((v) => v.id === id) ? id : PREVIEW_ALL);

/** What a view's columns are picked from, beside the "All" columns. */
export interface ViewContext {
	list: readonly SeriesMeta[];
	areas: readonly PreviewArea[];
}

/** The first of `list` by the run's own pick (byte order of the name), or undefined. */
const firstByName = <T extends Pick<SeriesMeta, 'name'>>(list: readonly T[]): T | undefined => [...list].sort((a, b) => compareSeriesNames(a.name, b.name))[0];

/**
 * The columns of a view, in its order. All: `columns` as they are (today's table). A land unit or the average
 * catchment rainfall: its own lines (areaViewColumns), then the series stored for it (sited at the unit, or the
 * catchment's own rain), each flow record with its m³/day beside it, less the CHIRPS series its CHIRPS raw line
 * already shows. All rainfall stations: the stations. All flow: every flow record with its m³/day, and the
 * calibration exclusions. `columns` is buildPreviewColumns + buildAreaColumns; a series column is taken from it, so
 * its label and help stay the All view's.
 */
export function columnsForView(view: PreviewViewId, columns: readonly PreviewColumn[], ctx: ViewContext): PreviewColumn[] {
	if (view === PREVIEW_ALL) return [...columns];
	const bySeries = (ids: readonly string[]) => {
		const out: PreviewColumn[] = [];
		for (const id of ids)
			for (const c of columns) if (c.seriesId === id && (c.group === 'series' || c.id === m3DayColumnId(id))) out.push(c);
		return out;
	};
	const names = new Map(ctx.list.filter(asksStation).map((s) => [s.id, s.name || 'Unnamed station']));
	const stationName = (id: string) => names.get(id) ?? null;
	const areaView = (nodeId: string | null, stored: readonly SeriesMeta[]) => {
		const area = ctx.areas.find((a) => a.nodeId === nodeId);
		// The CHIRPS series a run reads for the area is the CHIRPS raw line already.
		const shown = area?.lines?.chirpsRaw ? firstByName(stored.filter((s) => s.kind === 'rain_chirps_mm')) : undefined;
		const lines = area ? areaViewColumns(area, stationName, shown?.id) : [];
		return [...lines, ...bySeries(stored.filter((s) => s !== shown).map((s) => s.id))];
	};
	if (view === 'stations') return bySeries(ctx.list.filter(asksStation).map((s) => s.id));
	if (view === 'flow') return [...bySeries(ctx.list.filter((s) => s.kind.startsWith('flow_')).map((s) => s.id)), ...columns.filter((c) => c.id === 'excluded')];
	if (view === 'catchment') return areaView(null, ctx.list.filter((s) => !s.siteNodeId && s.kind.startsWith('rain_') && !asksStation(s)));
	if (view.startsWith('unit:')) {
		const nodeId = view.slice('unit:'.length);
		return areaView(nodeId, ctx.list.filter((s) => s.siteNodeId === nodeId));
	}
	return [...columns];
}

/** The source of a day's rain used, in words (the CSV writes the engine's codes: station, chirps, fallback, none). */
export const RAIN_FROM_LABEL: Record<StationRainDaySource, string> = {
	station: 'station',
	chirps: 'corrected CHIRPS',
	fallback: 'next fallback',
	none: 'no source (dry)'
};

/** The value of one area line on `date`: a number (mm), the source in words, or null outside the run window or with no value. */
export function areaCell(lines: AreaRainLines, line: AreaLine, date: string): number | string | null {
	const i = toEpochDay(date) - toEpochDay(lines.startDate);
	if (i < 0 || i >= lines.rainUsed.length) return null;
	if (line === 'source') return RAIN_FROM_LABEL[lines.source[i]!];
	const v =
		line === 'rainUsed'
			? lines.rainUsed[i]
			: line === 'stationScaled'
				? lines.stationScaled[i]
				: line === 'stationRaw'
					? lines.stationRaw[i]
					: line === 'chirpsRaw'
						? lines.chirpsRaw?.[i]
						: lines.chirpsCorrected?.[i];
	return v == null || !Number.isFinite(v) ? null : v;
}
