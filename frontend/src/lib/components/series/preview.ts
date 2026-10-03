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
	hasRainInput,
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
	type ProjectModel,
	type ProjectSettings,
	type SeriesKind,
	type SeriesMeta
} from '@water-management/engine';
import { kindLabel } from '$lib/series/kinds';
import type { Daily } from './coverage';

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
	group: 'series' | 'derived';
	/** Set for a `series` column and its `m3day:` companion — which series row it highlights. */
	seriesId?: string;
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
	const label = (s: SeriesMeta) => `${kindLabel(s.kind)}${s.name ? ` · ${s.name}` : ''}`;
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
 * The first series of each kind by name — the same rule the model uses (SeriesTab's own `first`, model.md),
 * among the outlet's: a flow record attached to a gauge node (084_gauge_records) is that gauge's, never the outlet's.
 */
function firstByKind(list: readonly SeriesMeta[], valuesById: Readonly<Record<string, Daily>>): Partial<Record<SeriesKind, DailySeries>> {
	const out: Partial<Record<SeriesKind, DailySeries>> = {};
	for (const k of SERIES_KINDS) {
		const s = [...list].filter((x) => x.kind === k && !x.siteNodeId).sort((a, b) => a.name.localeCompare(b.name))[0];
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

/**
 * Filters `rows` for the Preview dialog's search box + toggles. A query
 * starting with a comparison operator ("> 20", "= 0") tests the visible
 * series' values that day; anything else is a date prefix ("2015",
 * "2015-03", "2015-03-14"), which is never scoped to visible series (a date
 * is a property of the row, not of one series' column). Missing/flagged only
 * look at the visible series columns only, combined with the query by AND.
 */
export function filterPreviewRows(rows: readonly PreviewRow[], { query, missingOnly, flaggedOnly, visibleSeriesIds }: PreviewFilterState): PreviewRow[] {
	const q = query.trim();
	const cmp = q ? parseValueComparison(q) : null;
	return rows.filter((r) => {
		if (missingOnly && !visibleSeriesIds.some((id) => r.series[id]?.value === null)) return false;
		if (flaggedOnly && !visibleSeriesIds.some((id) => (r.series[id]?.flags.length ?? 0) > 0)) return false;
		if (!q) return true;
		if (cmp) return visibleSeriesIds.some((id) => r.series[id] && r.series[id]!.value !== null && cmp(r.series[id]!.value!));
		return r.date.startsWith(q);
	});
}
