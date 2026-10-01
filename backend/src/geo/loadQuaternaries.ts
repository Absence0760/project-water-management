// Load a quaternary dataset into quaternary_reference (146; issue #288 phase
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
// code,area_km2,map_mm,mar_mm3,oct,nov,dec,jan,feb,mar,apr,may,jun,jul,aug,sep,period_start,period_end).
// A load replaces every row of its dataset, in one transaction.
import type pg from 'pg';
import { geometryAreaM2 } from './area.js';
import { checkGeometry, type Geometry } from './geojson.js';

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
	source: string;
}

export const CODE = /^[A-Z][0-9]{2}[A-Z]$/;
const CODE_KEYS = ['code', 'QUATERNARY', 'QUATERN', 'Quaternary', 'quaternary', 'QUAT', 'QCODE'];
const MONTHS = ['oct', 'nov', 'dec', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];

const num = (v: unknown): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const n = typeof v === 'number' ? v : Number(String(v).trim());
	return Number.isFinite(n) ? n : null;
};

function bboxOf(g: Geometry): [number, number, number, number] {
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
			periodEnd: get('period_end')
		});
	}
	return { values, problems };
}

/**
 * The records a boundaries file (and optional values) describes, with a
 * problem per feature skipped. The source is the feature's `source`
 * property, else `defaultSource`. With no area given, the polygon's own
 * geodesic area is used.
 */
export function quaternaryRecords(
	boundaries: unknown,
	defaultSource: string,
	values: Map<string, Partial<QuaternaryRecord>> = new Map()
): { records: QuaternaryRecord[]; problems: string[] } {
	const problems: string[] = [];
	const records: QuaternaryRecord[] = [];
	const fc = boundaries as { type?: unknown; features?: unknown };
	if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return { records, problems: ['the boundaries file is not a GeoJSON FeatureCollection'] };
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
			source
		});
	});
	return { records, problems };
}

/** Replace every row of `dataset` with `records`, in one transaction, as the schema owner. Returns how many rows it wrote. */
export async function replaceDataset(client: pg.ClientBase, dataset: string, records: readonly QuaternaryRecord[]): Promise<number> {
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM quaternary_reference WHERE dataset = $1', [dataset]);
		for (const r of records) {
			await client.query(
				`INSERT INTO quaternary_reference (code, dataset, geometry, min_lon, min_lat, max_lon, max_lat, area_km2, map_mm, mar_mm3, monthly_mm3, period_start, period_end, source)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
				 ON CONFLICT (code) DO UPDATE SET dataset = EXCLUDED.dataset, geometry = EXCLUDED.geometry,
					min_lon = EXCLUDED.min_lon, min_lat = EXCLUDED.min_lat, max_lon = EXCLUDED.max_lon, max_lat = EXCLUDED.max_lat,
					area_km2 = EXCLUDED.area_km2, map_mm = EXCLUDED.map_mm, mar_mm3 = EXCLUDED.mar_mm3, monthly_mm3 = EXCLUDED.monthly_mm3,
					period_start = EXCLUDED.period_start, period_end = EXCLUDED.period_end, source = EXCLUDED.source, loaded_at = now()`,
				[r.code, dataset, JSON.stringify(r.geometry), ...r.bbox, r.areaKm2, r.mapMm, r.marMm3, r.monthlyMm3, r.periodStart, r.periodEnd, r.source]
			);
		}
		await client.query('COMMIT');
		return records.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
