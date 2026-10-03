// Load a river network into river_reference (171; issue #345, docs/maps.md §
// River network). The operator's tool, run as the schema owner
// (`pnpm import:rivers`, or `pnpm dev:tiles:rivers` for HydroRIVERS); the app
// only reads the table.
//
// Input: one or more GeoJSON FeatureCollections of LineStrings or
// MultiLineStrings in WGS84, each feature a reach. HydroRIVERS' own fields
// are read as they come out of `ogr2ogr -f GeoJSON` (HYRIV_ID, ORD_STRA,
// UPLAND_SKM, LENGTH_KM, DIS_AV_CMS), or the same under readable names
// (reachId, strahler, upstreamKm2, lengthKm, dischargeM3s), with an optional
// `name` and `source`. Reaches below `minOrder` (Strahler) are left out, so
// a load can keep to the streams a catchment model cares about. A load
// replaces every row of its dataset, in one transaction.
import type pg from 'pg';
import { recordReferenceOrigin, type ReferenceOrigin } from './referenceOrigin.js';
import { checkGeometry, featureNameOf, type Geometry } from './geojson.js';
import { bboxOf } from './loadQuaternaries.js';

export interface RiverRecord {
	reachId: number;
	name: string;
	strahler: number | null;
	upstreamKm2: number | null;
	lengthKm: number | null;
	dischargeM3s: number | null;
	geometry: Geometry;
	bbox: [number, number, number, number];
	source: string;
}

const ID_KEYS = ['HYRIV_ID', 'reachId', 'reach_id', 'id', 'ID'];
const ORDER_KEYS = ['ORD_STRA', 'strahler', 'order', 'ORDER'];
const UPSTREAM_KEYS = ['UPLAND_SKM', 'upstreamKm2', 'upstream_km2'];
const LENGTH_KEYS = ['LENGTH_KM', 'lengthKm', 'length_km'];
const DISCHARGE_KEYS = ['DIS_AV_CMS', 'dischargeM3s', 'discharge_m3s'];
const NAME_KEYS = ['name', 'NAME', 'Name', 'RIVER_NAME'];

/** How many reaches one INSERT carries (the loader's batch). */
const BATCH = 500;

const num = (v: unknown): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const n = typeof v === 'number' ? v : Number(String(v).trim());
	return Number.isFinite(n) ? n : null;
};
const pick = (p: Record<string, unknown>, keys: readonly string[]) => keys.map((k) => p[k]).find((v) => v !== undefined && v !== null && v !== '');
/** A non-negative value under `max`, else null (the 171 CHECKs, said first). */
const bounded = (v: unknown, max: number): number | null => {
	const n = num(v);
	return n !== null && n >= 0 && n < max ? n : null;
};

/**
 * The reaches a set of GeoJSON files describes, with a problem per reach
 * skipped (and a count of those left out below `minOrder`, which aren't
 * problems). The source is the reach's own, else `defaultSource`. An id seen
 * twice is kept the first time.
 */
export function riverRecords(
	files: readonly { name: string; text: string }[],
	defaultSource: string,
	minOrder = 1
): { records: RiverRecord[]; problems: string[]; belowOrder: number } {
	const records: RiverRecord[] = [];
	const problems: string[] = [];
	const seen = new Set<number>();
	let belowOrder = 0;
	for (const f of files) {
		let fc: { type?: unknown; features?: unknown };
		try {
			fc = JSON.parse(f.text);
		} catch {
			problems.push(`${f.name}: not valid JSON`);
			continue;
		}
		if (fc?.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
			problems.push(`${f.name}: not a GeoJSON FeatureCollection`);
			continue;
		}
		(fc.features as { properties?: Record<string, unknown> | null; geometry?: unknown }[]).forEach((feat, i) => {
			const where = `${f.name} feature ${i + 1}`;
			const p = feat?.properties ?? {};
			const id = num(pick(p, ID_KEYS));
			if (id === null || !Number.isSafeInteger(id) || id <= 0) return problems.push(`${where}: no reach id (looked in ${ID_KEYS.join(', ')})`);
			const order = num(pick(p, ORDER_KEYS));
			const strahler = order !== null && Number.isInteger(order) && order >= 1 && order <= 15 ? order : null;
			if (minOrder > 1 && (strahler ?? 0) < minOrder) {
				belowOrder++;
				return;
			}
			if (seen.has(id)) return problems.push(`${where}: reach ${id} appears twice`);
			const checked = checkGeometry(feat?.geometry);
			if ('problem' in checked) return problems.push(`${where} (reach ${id}): ${checked.problem}`);
			if (checked.geometry.type !== 'LineString' && checked.geometry.type !== 'MultiLineString') return problems.push(`${where} (reach ${id}): not a line`);
			const source = typeof p.source === 'string' && p.source.trim() ? p.source.trim().slice(0, 500) : defaultSource;
			if (!source) return problems.push(`${where} (reach ${id}): no source (give the reach a "source" or pass --source)`);
			const name = pick(p, NAME_KEYS);
			seen.add(id);
			records.push({
				reachId: id,
				name: typeof name === 'string' ? featureNameOf(name) : '',
				strahler,
				upstreamKm2: bounded(pick(p, UPSTREAM_KEYS), 1e8),
				lengthKm: bounded(pick(p, LENGTH_KEYS), 1e5),
				dischargeM3s: bounded(pick(p, DISCHARGE_KEYS), 1e6),
				geometry: checked.geometry,
				bbox: bboxOf(checked.geometry),
				source
			});
		});
	}
	return { records, problems, belowOrder };
}

/**
 * Replace every row of `dataset` with `records`, in one transaction, as the
 * schema owner, in batches. `origin`: the reference-bucket file a production
 * load read (recorded with the data; referenceOrigin.ts), null for any other
 * replace. Returns how many rows it wrote.
 */
export async function replaceRivers(client: pg.ClientBase, dataset: string, records: readonly RiverRecord[], origin: ReferenceOrigin | null = null): Promise<number> {
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM river_reference WHERE dataset = $1', [dataset]);
		for (let i = 0; i < records.length; i += BATCH) {
			const batch = records.slice(i, i + BATCH);
			const col = <T>(f: (r: RiverRecord) => T) => batch.map(f);
			await client.query(
				`INSERT INTO river_reference (dataset, reach_id, name, strahler, upstream_km2, length_km, discharge_m3s, geometry, min_lon, min_lat, max_lon, max_lat, source)
				 SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::smallint[], $5::float8[], $6::float8[], $7::float8[], $8::jsonb[],
					$9::float8[], $10::float8[], $11::float8[], $12::float8[], $13::text[])`,
				[
					dataset,
					col((r) => r.reachId),
					col((r) => r.name),
					col((r) => r.strahler),
					col((r) => r.upstreamKm2),
					col((r) => r.lengthKm),
					col((r) => r.dischargeM3s),
					col((r) => JSON.stringify(r.geometry)),
					col((r) => r.bbox[0]),
					col((r) => r.bbox[1]),
					col((r) => r.bbox[2]),
					col((r) => r.bbox[3]),
					col((r) => r.source)
				]
			);
		}
		await recordReferenceOrigin(client, 'rivers', dataset, origin);
		await client.query('COMMIT');
		return records.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
