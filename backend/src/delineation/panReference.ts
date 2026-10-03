// What a pan is cross-checked against (pans.ts PanReference; the follow-up
// "Cross-check a pan against the river network", docs/design/pans-research.md
// § Storage on a river): the river network's reaches (river_reference, 171:
// HydroRIVERS where the operator loaded it), the register of dams
// (dam_register_reference, 157) and the project's own rivers and dams
// (map_feature: drawn ones; one added from the network is read there).
// Only data already loaded; read as the user, so RLS decides
// which project's features come back, over the boxes of the depressions that
// passed the pan tests (pans.ts asks only then).
import type { Position } from '../geo/geojson.js';
import type { Db } from '../db/tx.js';
import type { PanReference, PanReferenceLoader } from './pans.js';

type Lines = Position[] | Position[][];
const linesOf = (c: Lines): Position[][] => (typeof c[0]?.[0] === 'number' ? [c as Position[]] : (c as Position[][]));

/** The reference over `boxes` ([west, south, east, north]): every reach, register dam and project river or dam meeting one. */
export async function loadPanReference(db: Db, projectId: string | null, boxes: readonly [number, number, number, number][]): Promise<PanReference> {
	if (!boxes.length) return { rivers: [], dams: [] };
	const cols = [0, 1, 2, 3].map((k) => boxes.map((b) => b[k]!));
	// One bounding-box probe a box (river_reference_bbox_idx), each reach once; only reaches HydroSHEDS routes to the sea (196):
	// its lines run through pans too, traced on a filled DEM, and an endorheic reach's water ends in a sink anyway.
	const { rows: reaches } = await db.query<{ geometry: { coordinates: Lines } }>(
		`SELECT DISTINCT ON (r.dataset, r.reach_id) r.geometry
		   FROM unnest($1::float8[], $2::float8[], $3::float8[], $4::float8[]) AS b(w, s, e, n)
		   JOIN river_reference r ON r.max_lon >= b.w AND r.min_lon <= b.e AND r.max_lat >= b.s AND r.min_lat <= b.n
		  WHERE r.endorheic IS FALSE`,
		cols
	);
	const { rows: register } = await db.query<{ lon: number; lat: number }>(
		`SELECT DISTINCT d.register_no, d.lon, d.lat
		   FROM unnest($1::float8[], $2::float8[], $3::float8[], $4::float8[]) AS b(w, s, e, n)
		   JOIN dam_register_reference d ON d.lon BETWEEN b.w AND b.e AND d.lat BETWEEN b.s AND b.n`,
		cols
	);
	const features = projectId
		? (
				// A river added from the network (its `ref`, geo/rivers.ts riverRef) is the reference's reach: read there, with its flag.
				await db.query<{ kind: 'river' | 'dam'; geometry: { type: string; coordinates: unknown } }>(
					`SELECT kind, geometry FROM map_feature
					  WHERE project_id = $1 AND kind IN ('river', 'dam') AND (kind = 'dam' OR coalesce(properties ->> 'ref', '') NOT LIKE 'river-network:%')`,
					[projectId]
				)
			).rows
		: [];
	const ref: PanReference = {
		// A reach is drawn from its upper end (reach.ts reads its start as where the reaches above join it).
		rivers: reaches.flatMap((r) => linesOf(r.geometry.coordinates).map((line) => ({ line, directed: true }))),
		dams: register.map((d) => [[d.lon, d.lat] as Position])
	};
	for (const f of features) {
		const g = f.geometry;
		if (f.kind === 'river' && (g.type === 'LineString' || g.type === 'MultiLineString')) {
			// Drawn either way round on the map.
			for (const line of linesOf(g.coordinates as Lines)) ref.rivers.push({ line, directed: false });
		} else if (f.kind === 'dam') {
			if (g.type === 'Point') ref.dams.push([g.coordinates as Position]);
			else if (g.type === 'Polygon') ref.dams.push((g.coordinates as Position[][])[0]!);
			else if (g.type === 'MultiPolygon') for (const poly of g.coordinates as Position[][][]) ref.dams.push(poly[0]!);
		}
	}
	return ref;
}

/** A loader that reads the reference through `run` (a transaction as the user: withUser, or a job's own). */
export function panReferenceLoader(run: <T>(fn: (db: Db) => Promise<T>) => Promise<T>, projectId: string | null): PanReferenceLoader {
	return (boxes) => run((db) => loadPanReference(db, projectId, boxes));
}
