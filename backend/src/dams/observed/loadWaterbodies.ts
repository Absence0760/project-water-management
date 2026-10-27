// Load DE Africa Waterbodies polygons into waterbody_reference (257; issue
// #604 R5, docs/maps.md § Waterbodies). The operator's tool, run as the schema
// owner: `pnpm import:waterbodies` locally, load-reference.yml's `waterbodies`
// kind in production (geo/referenceLoad.ts, the migrate Lambda). The app only
// reads the table, through the worker's match (match.ts).
//
// Input: a GeoJSON FeatureCollection of Polygon / MultiPolygon features in
// WGS84, each with its uid in a `uid` (or `UID`) property: the v0.0.3
// historical extent clipped to the operator's region with ogr2ogr (the recipe
// is in docs/maps.md). Optionally only the features whose box meets `bbox`
// (w, s, e, n) are kept. A load replaces every row of its dataset, in one
// transaction; a uid another dataset holds moves to this one.
import type pg from 'pg';
import { geometryAreaM2 } from '../../geo/area.js';
import { checkGeometry, type Geometry } from '../../geo/geojson.js';
import { bboxOf } from '../../geo/loadQuaternaries.js';
import { recordReferenceOrigin, type ReferenceOrigin } from '../../geo/referenceOrigin.js';
import { WATERBODY_UID } from './handover.js';

export interface WaterbodyRecord {
	uid: string;
	geometry: Extract<Geometry, { type: 'Polygon' | 'MultiPolygon' }>;
	bbox: [number, number, number, number];
	areaM2: number;
}

/** The committed synthetic set's label. */
export const SYNTHETIC_WATERBODIES = 'synthetic';
/** What every row of a load records as its source when none is given. */
export const WATERBODIES_SOURCE = 'Digital Earth Africa Waterbodies v0.0.3, historical extent (CC BY 4.0)';
/** At most this many polygons a load: a clip of one region, not the continent (~700 000). */
export const MAX_WATERBODIES = 200_000;
const BATCH = 2000;

/** The file's polygons as records, with the features it skipped and why (a sentence each). */
export function waterbodyRecords(doc: unknown, bbox: [number, number, number, number] | null = null): { records: WaterbodyRecord[]; problems: string[]; outside: number } {
	const problems: string[] = [];
	const records: WaterbodyRecord[] = [];
	let outside = 0;
	const fc = doc as { type?: unknown; features?: unknown };
	if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) return { records, problems: ['the file is not a GeoJSON FeatureCollection'], outside };
	const seen = new Set<string>();
	for (const [i, f] of (fc.features as { properties?: Record<string, unknown> | null; geometry?: unknown }[]).entries()) {
		const props = f?.properties ?? {};
		const uid = String(props.uid ?? props.UID ?? '').trim();
		if (!WATERBODY_UID.test(uid)) {
			problems.push(`feature ${i + 1}: no uid (a 6–12 character geohash in "uid")`);
			continue;
		}
		if (seen.has(uid)) {
			problems.push(`feature ${i + 1}: uid ${uid} is listed twice`);
			continue;
		}
		const checked = checkGeometry(f?.geometry);
		if ('problem' in checked) {
			problems.push(`feature ${i + 1} (${uid}): ${checked.problem}`);
			continue;
		}
		const g = checked.geometry;
		if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') {
			problems.push(`feature ${i + 1} (${uid}): a ${g.type}, not a polygon`);
			continue;
		}
		const box = bboxOf(g);
		if (bbox && (box[2] < bbox[0] || box[0] > bbox[2] || box[3] < bbox[1] || box[1] > bbox[3])) {
			outside++;
			continue;
		}
		const areaM2 = geometryAreaM2(g) ?? 0;
		if (!(areaM2 > 0)) {
			problems.push(`feature ${i + 1} (${uid}): no area`);
			continue;
		}
		seen.add(uid);
		records.push({ uid, geometry: g, bbox: box, areaM2 });
	}
	if (records.length > MAX_WATERBODIES) return { records: [], problems: [`the file holds ${records.length} waterbodies; clip it to your region (at most ${MAX_WATERBODIES})`], outside };
	return { records, problems, outside };
}

/** Replace `dataset` with `records`, as the schema owner, in one transaction; `origin` is the production file it came from. */
export async function replaceWaterbodies(client: pg.ClientBase, dataset: string, records: readonly WaterbodyRecord[], source: string, origin: ReferenceOrigin | null = null): Promise<number> {
	await client.query('BEGIN');
	try {
		await client.query('DELETE FROM waterbody_reference WHERE dataset = $1', [dataset]);
		for (let i = 0; i < records.length; i += BATCH) {
			const b = records.slice(i, i + BATCH);
			await client.query(
				`INSERT INTO waterbody_reference (uid, dataset, geometry, min_lon, min_lat, max_lon, max_lat, area_m2, source)
				 SELECT t.uid, $1, t.g, t.w, t.s, t.e, t.n, t.a, $2
				 FROM unnest($3::text[], $4::jsonb[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[]) AS t(uid, g, w, s, e, n, a)
				 ON CONFLICT (uid) DO UPDATE SET dataset = EXCLUDED.dataset, geometry = EXCLUDED.geometry, min_lon = EXCLUDED.min_lon, min_lat = EXCLUDED.min_lat,
					max_lon = EXCLUDED.max_lon, max_lat = EXCLUDED.max_lat, area_m2 = EXCLUDED.area_m2, source = EXCLUDED.source, loaded_at = now()`,
				[
					dataset,
					source,
					b.map((r) => r.uid),
					b.map((r) => JSON.stringify(r.geometry)),
					b.map((r) => r.bbox[0]),
					b.map((r) => r.bbox[1]),
					b.map((r) => r.bbox[2]),
					b.map((r) => r.bbox[3]),
					b.map((r) => r.areaM2)
				]
			);
		}
		await recordReferenceOrigin(client, 'waterbodies', dataset, origin);
		await client.query('COMMIT');
		return records.length;
	} catch (e) {
		await client.query('ROLLBACK');
		throw e;
	}
}
