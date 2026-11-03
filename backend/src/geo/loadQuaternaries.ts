// Load a quaternary dataset into quaternary_reference (152; issue #288 phase
// 2, docs/maps.md § Quaternary dataset). The operator's tool, run as the
// schema owner (`pnpm import:quaternaries`); the app only reads the table.
//
// Input: a GeoJSON FeatureCollection of quaternary polygons in WGS84 (the
// DWS quaternary boundaries, converted from the shapefile with
// `ogr2ogr -t_srs EPSG:4326 -f GeoJSON …`), each feature's code in a
// `code` / `QUATERNARY` / `QUATERN` / `Quaternary` property, and the
// reference values either as properties of the same feature (areaKm2, mapMm,
// marMm3, monthlyMm3 [12, Oct … Sep, Mm³], periodStart, periodEnd, source)
// or from a CSV keyed by code (the WR2012 tables, transcribed:
// code,area_km2,map_mm,mar_mm3,oct,nov,dec,jan,feb,mar,apr,may,jun,jul,aug,sep,period_start,period_end,
// optionally with mae_mm,evap_zone).
//
// WR2012's evaporation (310; docs/maps.md § WR2012 S-pan): each quaternary's
// mean annual S-pan evaporation (MAE, mm; `maeMm` / `mae_mm`) and its
// evaporation zone (`evapZone` / `evap_zone`), and each zone's monthly
// distribution as % of MAE, from `--evap-zones <csv>` (zone,oct,…,sep) or the
// boundaries file's top-level `evapZones` member ([{ zone, pct: [12] }], what
// `--out` writes). A zone's 12 percentages must each be 0 or more and add up
// to 95–105, or the zone is skipped, named; a quaternary whose zone has no
// distribution in the load is listed as skipped for evaporation and loaded
// without its MAE and zone.
//
// A load replaces every row of its dataset (quaternaries and zones), in one
// transaction.
//
// Production (decided 2026-11-02, docs/maps.md § Sources, Quaternary dataset):
// `pnpm import:quaternaries … --out <file>` writes the boundaries with the
// values on each feature's properties (quaternaryFeatureCollection), one file
// that load-reference.yml's `quaternaries` kind reads (referenceLoad.ts), and
// every row is stored with QUATERNARY_SOURCE (or the load's own source), never
// the file's.
import type pg from 'pg';
import { geometryAreaM2 } from './area.js';
import { checkGeometry, type Geometry } from './geojson.js';
import { recordReferenceOrigin, type ReferenceOrigin } from './referenceOrigin.js';

/**
 * The credit a production load stores on every row, shown with every value
 * the lookup proposes: the outlines' publisher (DWS) and the values' study
 * (WR2012, Water Research Commission). docs/maps.md § Sources records it;
 * the Data sources page credits each half (dataCredits.ts, the test checks the words).
 */
export const QUATERNARY_SOURCE =
	'Quaternary catchments: Department of Water and Sanitation (DWS). ' + 'Reference values: WR2012, Water Resources of South Africa 2012 Study (Water Research Commission, 2015).';

export interface QuaternaryRecord {
	code: string;
	geometry: Geometry;
	bbox: [number, number, number, number];
	areaKm2: number | null;
	mapMm: number | null;
	marMm3: number | null;
	monthlyMm3: number[] | null;
	periodStart: number | null;
	periodEnd: number | null;
	/** Mean annual S-pan evaporation, mm a year; with evapZone, or neither. */
	maeMm: number | null;
	evapZone: string | null;
	source: string;
}

/** An evaporation zone's monthly distribution: % of MAE, Oct … Sep. */
export interface EvapZone {
	zone: string;
	pct: number[];
}

/** What a load writes: the quaternaries and their dataset's evaporation zones. */
export interface QuaternaryLoad {
	records: readonly QuaternaryRecord[];
	zones: readonly EvapZone[];
}

/** An evaporation zone's label: WR2012's are a number and a letter (e.g. 7A); upper-cased on load. */
export const EVAP_ZONE = /^[A-Z0-9]{1,8}$/;
/** A zone's 12 percentages add up to within this range, or it is skipped (WR2012's tables are rounded). */
export const EVAP_ZONE_TOTAL: readonly [number, number] = [95, 105];
/** The largest MAE a load takes, mm a year (the column's CHECK). */
export const MAE_MAX_MM = 5000;

export const CODE = /^[A-Z][0-9]{2}[A-Z]$/;
const CODE_KEYS = ['code', 'QUATERNARY', 'QUATERN', 'Quaternary', 'quaternary', 'QUAT', 'QCODE'];
const MONTHS = ['oct', 'nov', 'dec', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];

const num = (v: unknown): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const n = typeof v === 'number' ? v : Number(String(v).trim());
	return Number.isFinite(n) ? n : null;
};

/** A geometry's bounding box: west, south, east, north. */
export function bboxOf(g: Geometry): [number, number, number, number] {
	let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
	const walk = (c: unknown): void => {
		if (Array.isArray(c) && typeof c[0] === 'number') {
			const [x, y] = c as [number, number];
			x0 = Math.min(x0, x);
			y0 = Math.min(y0, y);
			x1 = Math.max(x1, x);
			y1 = Math.max(y1, y);
		} else if (Array.isArray(c)) c.forEach(walk);
	};
	walk(g.coordinates);
	return [x0, y0, x1, y1];
}

/** A CSV of values keyed by code (header row; columns as the file comment says), as a map. */
export function parseValuesCsv(text: string): { values: Map<string, Partial<QuaternaryRecord>>; problems: string[] } {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
	const problems: string[] = [];
	const values = new Map<string, Partial<QuaternaryRecord>>();
	if (!lines.length) return { values, problems: ['the values file is empty'] };
	const head = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
	const col = (name: string) => head.indexOf(name);
	if (col('code') < 0) return { values, problems: ['the values file has no "code" column'] };
	for (const [i, line] of lines.slice(1).entries()) {
		const cells = line.split(',').map((c) => c.trim());
		const code = (cells[col('code')] ?? '').toUpperCase();
		if (!CODE.test(code)) {
			problems.push(`values row ${i + 2}: "${code}" is not a quaternary code`);
			continue;
		}
		const get = (name: string) => (col(name) >= 0 ? num(cells[col(name)]) : null);
		const monthly = MONTHS.map(get);
		values.set(code, {
			areaKm2: get('area_km2'),
			mapMm: get('map_mm'),
			marMm3: get('mar_mm3'),
			monthlyMm3: monthly.every((v) => v !== null) ? (monthly as number[]) : null,
			periodStart: get('period_start'),
			periodEnd: get('period_end'),
			maeMm: get('mae_mm'),
			evapZone: col('evap_zone') >= 0 ? zoneLabel(cells[col('evap_zone')]) : null
		});
	}
	return { values, problems };
}

/** A zone label as stored (trimmed, upper case), or null when empty. */
const zoneLabel = (v: unknown): string | null => {
	if (v === null || v === undefined) return null;
	const z = String(v).trim().toUpperCase();
	return z ? z : null;
};

/** Why a zone's distribution can't be loaded, or null: 12 numbers, each 0 or more, adding up to 95–105. */
export function evapZoneProblem(zone: string, pct: readonly (number | null)[]): string | null {
	if (!EVAP_ZONE.test(zone)) return `evaporation zone "${zone}" is not a zone label (letters and digits, at most 8)`;
	if (pct.length !== 12 || pct.some((v) => v === null || !Number.isFinite(v))) return `evaporation zone ${zone}: needs a percentage for each of the 12 months`;
	if (pct.some((v) => v! < 0)) return `evaporation zone ${zone}: a month's percentage is negative`;
	const total = pct.reduce<number>((a, b) => a + b!, 0);
	if (total < EVAP_ZONE_TOTAL[0] || total > EVAP_ZONE_TOTAL[1])
		return `evaporation zone ${zone}: its months add up to ${Math.round(total * 10) / 10} %, not ${EVAP_ZONE_TOTAL[0]}–${EVAP_ZONE_TOTAL[1]} %`;
	return null;
}

/** Zones from a list of { zone, pct } (the boundaries file's `evapZones`), each checked; a bad or repeated one is skipped, named. */
function checkedZones(list: readonly { zone: unknown; pct: readonly unknown[] | null }[]): { zones: Map<string, EvapZone>; problems: string[] } {
	const zones = new Map<string, EvapZone>();
	const problems: string[] = [];
	for (const z of list) {
		const zone = zoneLabel(z.zone) ?? '';
		const pct = (z.pct ?? []).map(num);
		const problem = evapZoneProblem(zone, pct);
		if (problem) problems.push(`${problem}; zone skipped`);
		else if (zones.has(zone)) problems.push(`evaporation zone ${zone} appears twice; the second skipped`);
		else zones.set(zone, { zone, pct: pct as number[] });
	}
	return { zones, problems };
}

/** A CSV of evaporation zones (header `zone,oct,nov,…,sep`, % of MAE), each checked. */
export function parseEvapZonesCsv(text: string): { zones: Map<string, EvapZone>; problems: string[] } {
	const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
	if (!lines.length) return { zones: new Map(), problems: ['the evaporation zones file is empty'] };
	const head = lines[0]!.split(',').map((h) => h.trim().toLowerCase());
	const missing = ['zone', ...MONTHS].filter((h) => !head.includes(h));
	if (missing.length) return { zones: new Map(), problems: [`the evaporation zones file has no ${missing.map((m) => `"${m}"`).join(', ')} column${missing.length === 1 ? '' : 's'}`] };
	const rows = lines.slice(1).map((line) => {
		const cells = line.split(',').map((c) => c.trim());
		return { zone: cells[head.indexOf('zone')], pct: MONTHS.map((m) => cells[head.indexOf(m)] ?? null) };
	});
	return checkedZones(rows);
}

/** The boundaries file's `evapZones` member (what --out writes), or none. */
function zonesInFile(fc: { evapZones?: unknown }): { zones: Map<string, EvapZone>; problems: string[] } {
	if (fc.evapZones === undefined || fc.evapZones === null) return { zones: new Map(), problems: [] };
	if (!Array.isArray(fc.evapZones)) return { zones: new Map(), problems: ['the boundaries file\'s "evapZones" is not a list; no zone loaded'] };
	return checkedZones(fc.evapZones.map((z: { zone?: unknown; pct?: unknown }) => ({ zone: z?.zone, pct: Array.isArray(z?.pct) ? z.pct : null })));
}

/**
 * The records a boundaries file (and optional values) describes, with a
 * problem per feature skipped. The source is the feature's `source`
 * property, else `defaultSource`. With no area given, the polygon's own
 * geodesic area is used. The evaporation zones are `zones` when given (the
 * --evap-zones file), else the file's own `evapZones`; a quaternary whose MAE
 * or zone is missing, or whose zone isn't among them, is loaded without its
 * evaporation and listed as skipped for it.
 */
export function quaternaryRecords(
	boundaries: unknown,
	defaultSource: string,
	values: Map<string, Partial<QuaternaryRecord>> = new Map(),
	zones?: Map<string, EvapZone>
): { records: QuaternaryRecord[]; zones: EvapZone[]; problems: string[] } {
	const problems: string[] = [];
	const records: QuaternaryRecord[] = [];
	const fc = boundaries as { type?: unknown; features?: unknown; evapZones?: unknown };
	if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return { records, zones: [], problems: ['the boundaries file is not a GeoJSON FeatureCollection'] };
	let zoneMap = zones;
	if (!zoneMap) {
		const inFile = zonesInFile(fc);
		problems.push(...inFile.problems);
		zoneMap = inFile.zones;
	}
	const seen = new Set<string>();
	fc.features.forEach((f: { properties?: Record<string, unknown> | null; geometry?: unknown }, i: number) => {
		const p = f?.properties ?? {};
		const code = String(CODE_KEYS.map((k) => p[k]).find((v) => v !== undefined && v !== null) ?? '').trim().toUpperCase();
		if (!CODE.test(code)) return problems.push(`feature ${i + 1}: no quaternary code (looked in ${CODE_KEYS.join(', ')})`);
		if (seen.has(code)) return problems.push(`feature ${i + 1}: ${code} appears twice`);
		const checked = checkGeometry(f?.geometry);
		if ('problem' in checked) return problems.push(`feature ${i + 1} (${code}): ${checked.problem}`);
		if (checked.geometry.type !== 'Polygon' && checked.geometry.type !== 'MultiPolygon') return problems.push(`feature ${i + 1} (${code}): not a polygon`);
		const v = values.get(code) ?? {};
		const monthlyProp = Array.isArray(p.monthlyMm3) && p.monthlyMm3.length === 12 && p.monthlyMm3.every((x) => num(x) !== null) ? (p.monthlyMm3 as unknown[]).map((x) => num(x)!) : null;
		const source = typeof p.source === 'string' && p.source.trim() ? p.source.trim().slice(0, 500) : defaultSource;
		if (!source) return problems.push(`feature ${i + 1} (${code}): no source (give the feature a "source" or pass --source)`);
		const areaKm2 = v.areaKm2 ?? num(p.areaKm2) ?? geometryAreaM2(checked.geometry)! / 1e6;
		// Evaporation: both the MAE and a zone with a distribution, or neither (the columns' pair CHECK).
		let maeMm = v.maeMm ?? num(p.maeMm);
		let evapZone = v.evapZone ?? zoneLabel(p.evapZone);
		if (maeMm !== null || evapZone !== null) {
			const why =
				maeMm === null
					? `evaporation zone ${evapZone} but no MAE`
					: !(maeMm > 0 && maeMm < MAE_MAX_MM)
						? `MAE ${maeMm} mm is not above 0 and below ${MAE_MAX_MM}`
						: evapZone === null
							? 'an MAE but no evaporation zone'
							: !zoneMap.has(evapZone)
								? `evaporation zone ${evapZone} has no monthly distribution in this load`
								: null;
			if (why) {
				problems.push(`${code}: ${why}; loaded without its evaporation`);
				maeMm = null;
				evapZone = null;
			}
		}
		seen.add(code);
		records.push({
			code,
			geometry: checked.geometry,
			bbox: bboxOf(checked.geometry),
			areaKm2: areaKm2 > 0 ? areaKm2 : null,
			mapMm: v.mapMm ?? num(p.mapMm),
			marMm3: v.marMm3 ?? num(p.marMm3),
			monthlyMm3: v.monthlyMm3 ?? monthlyProp,
			periodStart: v.periodStart ?? num(p.periodStart),
			periodEnd: v.periodEnd ?? num(p.periodEnd),
			maeMm,
			evapZone,
			source
		});
	});
	return { records, zones: [...zoneMap.values()], problems };
}

/**
 * The records as one GeoJSON FeatureCollection with their values on each
 * feature's properties, and the evaporation zones as its `evapZones` member:
 * the file `pnpm import:quaternaries … --out` writes and a production load
 * (kind `quaternaries`) reads back through quaternaryRecords.
 */
export function quaternaryFeatureCollection(
	records: readonly QuaternaryRecord[],
	zones: readonly EvapZone[] = []
): {
	type: 'FeatureCollection';
	evapZones: EvapZone[];
	features: { type: 'Feature'; properties: Record<string, unknown>; geometry: Geometry }[];
} {
	return {
		type: 'FeatureCollection',
		evapZones: zones.map((z) => ({ zone: z.zone, pct: [...z.pct] })),
		features: records.map((r) => ({
			type: 'Feature',
			properties: {
				code: r.code,
				areaKm2: r.areaKm2,
				mapMm: r.mapMm,
				marMm3: r.marMm3,
				monthlyMm3: r.monthlyMm3,
				periodStart: r.periodStart,
				periodEnd: r.periodEnd,
				maeMm: r.maeMm,
				evapZone: r.evapZone,
				source: r.source
			},
			geometry: r.geometry
		}))
	};
}

/**
 * Replace every row of `dataset` with the load's quaternaries and evaporation
 * zones, in one transaction, as the schema owner, recording the bucket file a
 * production load read (`origin`; a local import names none, which clears the
 * record). Returns how many quaternaries it wrote.
 */
export async function replaceDataset(client: pg.ClientBase, dataset: string, load: QuaternaryLoad, origin: ReferenceOrigin | null = null): Promise<number> {
	const { records, zones } = load;
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM quaternary_reference WHERE dataset = $1', [dataset]);
		await client.query('DELETE FROM quaternary_evap_zone WHERE dataset = $1', [dataset]);
		for (const z of zones) await client.query('INSERT INTO quaternary_evap_zone (dataset, zone, pct) VALUES ($1, $2, $3)', [dataset, z.zone, z.pct]);
		for (const r of records) {
			await client.query(
				`INSERT INTO quaternary_reference (code, dataset, geometry, min_lon, min_lat, max_lon, max_lat, area_km2, map_mm, mar_mm3, monthly_mm3, period_start, period_end, mae_mm, evap_zone, source)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
				 ON CONFLICT (code) DO UPDATE SET dataset = EXCLUDED.dataset, geometry = EXCLUDED.geometry,
					min_lon = EXCLUDED.min_lon, min_lat = EXCLUDED.min_lat, max_lon = EXCLUDED.max_lon, max_lat = EXCLUDED.max_lat,
					area_km2 = EXCLUDED.area_km2, map_mm = EXCLUDED.map_mm, mar_mm3 = EXCLUDED.mar_mm3, monthly_mm3 = EXCLUDED.monthly_mm3,
					period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, mae_mm = EXCLUDED.mae_mm, evap_zone = EXCLUDED.evap_zone,
					source = EXCLUDED.source, loaded_at = now()`,
				[r.code, dataset, JSON.stringify(r.geometry), ...r.bbox, r.areaKm2, r.mapMm, r.marMm3, r.monthlyMm3, r.periodStart, r.periodEnd, r.maeMm, r.evapZone, r.source]
			);
		}
		await recordReferenceOrigin(client, 'quaternaries', dataset, origin);
		await client.query('COMMIT');
		return records.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
