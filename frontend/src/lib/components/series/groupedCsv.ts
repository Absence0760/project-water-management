// The Data tab's CSV of the grouped series (issue #553 round 5, docs/ui.md §
// Data): one row per day over every column's span, one column per series,
// built in the browser because the derived columns (an area's station ×
// ratio, its corrected CHIRPS and its rain used, ./derivedRain.ts) are
// computed when viewed and never stored.
//
// - Compact (the default): the rainfall stations, the average catchment
//   rainfall (with a station for the catchment), each unit's rain used, the
//   flow records.
// - Full: every stored series, group by group, then each area's derived
//   columns and the day's source of its rain used.
//
// Both open with `#` lines saying what each area's rain is made of (its
// station, the MAPs, the ratio and the correction), as the backend's CSVs
// carry their provenance line (backend/src/export/csv.ts): a leading `#`
// line is skipped by our own readers and read as one cell by others. Text a
// user typed is kept to one harmless cell: header cells that a spreadsheet
// would read as a formula get an apostrophe, and a comment line's commas,
// quotes and control characters are percent-encoded. Pure: no DOM.
import { fromEpochDay, toEpochDay, type SeriesMeta } from '@water-management/engine';
import { kindLabel } from '#lib/series/kinds.js';
import type { Daily } from './coverage';
import type { AreaRainLines, UnitChainLines } from './derivedRain';
import type { SeriesGroup } from './groups';

export type ExportSize = 'compact' | 'full';

/** UTF-8 byte-order mark: without it Excel reads the file as ANSI and mangles "m³". */
export const BOM = '﻿';
export const EOL = '\r\n';

export interface CsvColumn {
	header: string;
	startDate: string;
	values: ArrayLike<number | string | null>;
}

/** A header or text cell: RFC 4180-quoted when needed, a leading = + - @ tab or CR behind an apostrophe (OWASP "CSV injection"). */
export function textCell(v: string): string {
	const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A `#` line kept to one cell: its `%`, commas, quotes and control characters percent-encoded (decodeURIComponent reads it back). */
export function commentLine(text: string): string {
	return `# ${text.replace(/[%,"\x00-\x1f\x7f-\x9f\u2028\u2029]/g, encodeURIComponent)}`;
}

const numCell = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '');

/** The CSV text (with BOM): the `#` lines, a `date` header row, then one row per day from the earliest column's first day to the latest's last. */
export function datedCsv(comments: readonly string[], columns: readonly CsvColumn[]): string {
	const lines = comments.map(commentLine);
	lines.push(['date', ...columns.map((c) => textCell(c.header))].join(','));
	if (columns.length) {
		const starts = columns.map((c) => toEpochDay(c.startDate));
		const d0 = Math.min(...starts);
		const d1 = Math.max(...columns.map((c, i) => starts[i]! + c.values.length - 1));
		for (let d = d0; d <= d1; d++) {
			const cells = [fromEpochDay(d)];
			for (let i = 0; i < columns.length; i++) {
				const v = columns[i]!.values[d - starts[i]!];
				cells.push(v == null ? '' : typeof v === 'number' ? numCell(v) : textCell(v));
			}
			lines.push(cells.join(','));
		}
	}
	return BOM + lines.join(EOL) + EOL;
}

/** One area's derived lines and how they're described: the catchment (nodeId null) or a land unit. */
export interface ExportArea {
	nodeId: string | null;
	name: string;
	/** groups.ts areaSentence. */
	sentence: string | null;
	lines: AreaRainLines | null;
	/** A unit without a station under per-unit rain: its §2.4h chain (issue #613 slice 2), in place of `lines`. */
	chain?: UnitChainLines | null;
	/** Why the lines couldn't be computed, when they couldn't. */
	error?: string | null;
}

const seriesName = (s: Pick<SeriesMeta, 'name' | 'kind'>) => s.name || kindLabel(s.kind);
const seriesHeader = (s: Pick<SeriesMeta, 'name' | 'kind' | 'unit'>) => `${seriesName(s)} (${s.unit || (s.kind.endsWith('_mm') ? 'mm' : 'm³/s')})`;
const areaHeader = (a: ExportArea, what: string) => `${a.nodeId === null ? 'Average catchment rainfall' : a.name}: ${what}`;

/** The `#` lines: what the file is, then each area's station, MAPs, ratio and correction (and, in Full, the factors). */
export function exportComments(size: ExportSize, areas: readonly ExportArea[], meta: { engineVersion: string; exportedOn: string }): string[] {
	const out = [`Data tab export (${size}); engine ${meta.engineVersion}; exported ${meta.exportedOn}; derived columns are computed from the stored inputs and are not stored`];
	for (const a of areas) {
		const who = a.nodeId === null ? 'Average catchment rainfall' : a.name;
		if (a.error) {
			out.push(`${who}: not computed (${a.error})`);
			continue;
		}
		if (a.sentence) out.push(`${who}: ${a.sentence}`);
		if (a.lines?.refused) out.push(`${who}: CHIRPS gaps not corrected; the pairing is refused (${a.lines.refused})`);
		if (a.chain) out.push(`${who}: no rainfall station; its rain follows rule ${a.chain.rule} of the per-unit chain (§2.4h)${a.chain.recipe.gaugeMapFactor !== null ? `, MAP ratio ${Math.round(a.chain.recipe.gaugeMapFactor * 1000) / 1000}` : ''}`);
		if (a.lines?.patches?.length)
			out.push(`${who}: station gaps patched from ${a.lines.patches.map((p) => `patch ${p.place}: ${p.stationName} × ${Math.round(p.ratio * 1000) / 1000}`).join(', then ')}`);
		if (size === 'full' && a.lines?.factors)
			out.push(
				`${who}: CHIRPS factors Jan to Dec ${a.lines.factors.map((k) => (Math.round(k * 1000) / 1000).toString()).join(' ')} (fitted for this area: its CHIRPS against ${a.lines.correctAgainst === a.lines.forcing.stationId ? a.lines.forcing.stationName : 'its correcting station'} adjusted to its MAP)`
			);
	}
	return out;
}

/**
 * The columns of an export: the stored series as the grouped list orders
 * them (Compact: stations and flow records only), and each area's derived
 * columns (Compact: its rain used; Full: station × ratio, each patch station ×
 * its ratio, corrected CHIRPS, rain used and the day's source, or for a unit without a station its §2.4h
 * links: own gauge checked, catchment gauge × MAP ratio, CHIRPS levelled).
 * An area without lines adds none.
 */
export function exportColumns(size: ExportSize, groups: readonly SeriesGroup<SeriesMeta>[], values: Readonly<Record<string, Daily>>, areas: readonly ExportArea[]): CsvColumn[] {
	const cols: CsvColumn[] = [];
	const stored = (s: SeriesMeta) => {
		const v = values[s.id];
		if (v) cols.push({ header: seriesHeader(s), startDate: v.startDate, values: v.values });
	};
	const area = (a: ExportArea) => {
		const ch = a.chain;
		if (!a.lines && ch) {
			// A §2.4h unit (issue #613 slice 2): each link its rule reads, then the rain used and the link of each day.
			if (size === 'full') {
				if (ch.ownGauge) cols.push({ header: areaHeader(a, 'own gauge, checked (mm)'), startDate: ch.startDate, values: ch.ownGauge });
				if (ch.gaugeScaled) cols.push({ header: areaHeader(a, 'catchment gauge × MAP ratio (mm)'), startDate: ch.startDate, values: ch.gaugeScaled });
				if (ch.chirpsLevelled) cols.push({ header: areaHeader(a, 'CHIRPS levelled (mm)'), startDate: ch.startDate, values: ch.chirpsLevelled });
			}
			cols.push({ header: areaHeader(a, 'rain used (mm)'), startDate: ch.startDate, values: ch.rainUsed });
			if (size === 'full') cols.push({ header: areaHeader(a, 'rain used from'), startDate: ch.startDate, values: ch.source });
			return;
		}
		const l = a.lines;
		if (!l) return;
		if (size === 'full') {
			cols.push({ header: areaHeader(a, 'station × ratio (mm)'), startDate: l.startDate, values: l.stationScaled });
			// Each patch station × its ratio, in the patching priority (issue #613 slice 3).
			for (const p of l.patches ?? []) cols.push({ header: areaHeader(a, `patch ${p.place}: ${p.stationName} × ratio (mm)`), startDate: l.startDate, values: p.scaled });
			if (l.chirpsCorrected) cols.push({ header: areaHeader(a, 'CHIRPS corrected (mm)'), startDate: l.startDate, values: l.chirpsCorrected });
		}
		cols.push({ header: areaHeader(a, 'rain used (mm)'), startDate: l.startDate, values: l.rainUsed });
		// The engine's codes, a patch day naming its station (issue #612): "patch 1: Ridge".
		if (size === 'full') cols.push({ header: areaHeader(a, 'rain used from'), startDate: l.startDate, values: l.source.map((s, i) => (s === 'patch' ? (l.patchFrom?.[i] ?? s) : s)) });
	};
	const catchment = areas.find((a) => a.nodeId === null);
	const units = areas.filter((a) => a.nodeId !== null);
	for (const g of groups) {
		if (size === 'compact' && g.id === 'other') continue;
		for (const it of g.items) {
			if (it.type === 'catchment') {
				if (catchment) area(catchment);
			} else if (it.type === 'unit') {
				if (size === 'full') it.series.forEach(stored);
				const a = units.find((u) => u.nodeId === it.unit.id);
				if (a) area(a);
			} else if (size === 'full' || g.id === 'stations' || g.id === 'flow') stored(it.series);
		}
	}
	return cols;
}

/** The whole file. */
export function groupedCsv(
	size: ExportSize,
	groups: readonly SeriesGroup<SeriesMeta>[],
	values: Readonly<Record<string, Daily>>,
	areas: readonly ExportArea[],
	meta: { engineVersion: string; exportedOn: string }
): string {
	return datedCsv(exportComments(size, areas, meta), exportColumns(size, groups, values, areas));
}
