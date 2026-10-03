// The catchment map (issue #288, roadmap WP-3.12; 152_catchment_map.sql,
// docs/api.md § Catchment map, docs/maps.md).
//
//   GET    /projects/:id/map/features                   features, sources, nodes' area sources (viewer)
//   GET    /projects/:id/map/linked-nodes               the ids of the nodes a feature is linked to (viewer)
//   POST   /projects/:id/map/features                   place one feature: a point from the coordinates form, or a geometry (editor)
//   PATCH  /projects/:id/map/features/:fid              rename, re-kind, link to a node, move (editor)
//   DELETE /projects/:id/map/features/:fid              (editor); its import goes with its last feature
//   POST   /projects/:id/map/features/:fid/split        a polygon cut in two along a drawn line, both parts saved together (editor)
//   POST   /projects/:id/map/import/preview             a GeoJSON file read and checked, each feature's kind proposed; saves nothing (editor)
//   POST   /projects/:id/map/import                     a GeoJSON file, checked on the server, with the reviewed kinds (editor)
//   POST   /projects/:id/nodes/:nodeId/area-from-map    accept a polygon's area as a farm's area (editor)
//   GET    /projects/:id/map/quaternary?lon=&lat=       the quaternary at a point and its reference values, proposed (viewer)
//
// Every geometry passes geo/geojson.ts; every area is computed here
// (geo/area.ts). Nothing on the map changes the model by itself: an area
// enters it only through area-from-map (recorded as a model revision with
// the feature named), and the quaternary lookup only proposes values the
// hydrologist accepts in Settings.
import { createHash } from 'node:crypto';
import { hasNameControlChars, NAME_CONTROL_MESSAGE } from '@water-management/engine';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { AreaBasis, basisText, takenAreaM2 } from '../delineation/areaBasis.js';
import { beginModelChange, recordAudit, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, mustChange, notFound } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { geometryAreaM2, polygonAreaM2 } from './area.js';
import { partsWithin } from './splitCheck.js';
import {
	centerOf,
	checkGeometry,
	FEATURE_NAME_MAX,
	featureNameOf,
	GEO_MAX_BYTES,
	GEO_MAX_FEATURES,
	KIND_GEOMETRY,
	overlapProblem,
	parseGeoJson,
	proposeKinds,
	type GeoProblem,
	type Geometry,
	type ParsedFeature,
	type Position
} from './geojson.js';
import { quaternaryAt, quaternaryDatasets } from './quaternary.js';
import { configuredWater, traceDam, TraceRefused, type MinOccurrence } from '../delineation/damTrace.js';
import { countMapCompute } from '../delineation/throttle.js';
import { DAM_POSITIONS, type DamPosition } from '../delineation/subcatchments.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';

export const MAP_FEATURE_KINDS = ['catchment_boundary', 'farm_parcel', 'dam', 'gauge', 'river', 'other'] as const;
export type MapFeatureKind = (typeof MAP_FEATURE_KINDS)[number];

/** The import's own body cap: the file (GEO_MAX_BYTES) as a JSON string, with room for its escapes (app.ts exempts this path from the general 4 MB). */
export const MAP_IMPORT_BODY_MAX = GEO_MAX_BYTES + 2 * 1024 * 1024;
/** The paths app.ts lets past the general body limit, to these routes' own (the import and its preview). */
export const MAP_IMPORT_PATH = /^\/projects\/[^/]+\/map\/import(\/preview)?$/;

/** The geometry types each kind may have (the 152 CHECKs, said first for a clear 400). */
const KIND_TYPES: Record<MapFeatureKind, readonly Geometry['type'][]> = KIND_GEOMETRY;
/**
 * The kinds whose polygon may become a hydrological unit's catchment area: a
 * farm parcel, or an "other" polygon the editor drew for the purpose. A dam's
 * water surface or the whole catchment's boundary is never one unit's area.
 */
export const AREA_KINDS: readonly MapFeatureKind[] = ['farm_parcel', 'other'];
/** The node kinds a feature of each kind may stand for. */
export const KIND_NODES: Record<MapFeatureKind, readonly string[]> = {
	catchment_boundary: [],
	farm_parcel: ['farm', 'user'],
	dam: ['farm', 'user'],
	gauge: ['gauge'],
	river: [],
	other: ['farm', 'user', 'gauge']
};
const KIND_LABEL: Record<MapFeatureKind, string> = {
	catchment_boundary: 'a catchment boundary',
	farm_parcel: 'a farm parcel',
	dam: 'a dam',
	gauge: 'a gauge',
	river: 'a river',
	other: 'an other feature'
};

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

const uuid = z.string().regex(UUID, 'not a valid id');
/** A feature name typed into a route: one line (issue #385; the Map draws it as a label), at most FEATURE_NAME_MAX characters. */
const Name = z.string().trim().max(FEATURE_NAME_MAX).refine((s) => !hasNameControlChars(s), NAME_CONTROL_MESSAGE);
const Lon = z.number().finite().min(-180).max(180);
const Lat = z.number().finite().min(-90).max(90);

export const CreateFeature = z
	.object({
		kind: z.enum(MAP_FEATURE_KINDS),
		name: Name.optional(),
		nodeId: uuid.nullable().optional(),
		/** A point from the coordinates form … */
		lon: Lon.optional(),
		lat: Lat.optional(),
		/** … or any geometry (checked by geo/geojson.ts). */
		geometry: z.unknown().optional(),
		/**
		 * The outline was traced from the water occurrence data (issue #326 C2,
		 * POST …/map/dam-trace): where it was clicked, the share asked for, and
		 * whether it was adjusted after. The server traces it again and refuses
		 * an outline called unadjusted that isn't the trace; the method goes in
		 * the feature's description and the audit event.
		 */
		traced: z
			.object({
				lon: Lon,
				lat: Lat,
				minOccurrence: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(75)]) satisfies z.ZodType<MinOccurrence>,
				edited: z.boolean()
			})
			.strict()
			.optional()
	})
	.strict()
	.refine((b) => (b.geometry === undefined) === (b.lon !== undefined && b.lat !== undefined), 'give either a longitude and latitude, or a geometry')
	.refine((b) => !b.traced || (b.geometry !== undefined && (b.kind === 'dam' || b.kind === 'other')), 'a traced outline is saved as a dam (or an other area), with its geometry');

/** The kinds a polygon split in two may be (issue #326 C2): the shape's own kind, or for the boundary (which stays whole) the kind of its parts. */
export const SPLIT_KINDS: readonly MapFeatureKind[] = ['catchment_boundary', 'farm_parcel', 'dam', 'other'];
/** How far the parts' areas may be from the shape's: the cut's corners are rounded to 7 decimals. */
const SPLIT_AREA_TOLERANCE = 0.001;

export const SplitFeature = z
	.object({
		/** The two parts, each a polygon (checked by geo/geojson.ts), together the shape. */
		parts: z.array(z.unknown()).length(2),
		/** Each part's name; omitted: the first keeps the shape's, the second is "<name> (part 2)". */
		names: z.array(Name).length(2).optional(),
		/** Splitting the catchment boundary: what its parts become (it stays whole). Default "other". */
		as: z.enum(['farm_parcel', 'other']).optional()
	})
	.strict();

export const EditFeature = z
	.object({
		kind: z.enum(MAP_FEATURE_KINDS).optional(),
		name: Name.optional(),
		nodeId: uuid.nullable().optional(),
		/** A dam polygon's position against its river (194): null = not said, the outline decides (subcatchments.ts damOutflow). */
		damPosition: z.enum(DAM_POSITIONS).nullable().optional(),
		lon: Lon.optional(),
		lat: Lat.optional(),
		geometry: z.unknown().optional()
	})
	.strict()
	.refine((b) => b.geometry === undefined || (b.lon === undefined && b.lat === undefined), 'give either a longitude and latitude, or a geometry')
	.refine((b) => (b.lon === undefined) === (b.lat === undefined), 'give both a longitude and a latitude');

/** One feature of the file as the editor reviewed it (issue #326 D2): its place in the file, the kind, the name and the node it stands for. */
const ReviewedFeature = z
	.object({
		index: z.number().int().min(1),
		kind: z.enum(MAP_FEATURE_KINDS),
		/** Omitted: the name read from the file. */
		name: Name.optional(),
		/** Omitted: linked by name, as a one-kind import does; null: no node. */
		nodeId: uuid.nullable().optional()
	})
	.strict();

export const ImportBody = z
	.object({
		fileName: z.string().trim().min(1).max(255),
		/** Every feature one kind: one catchment boundary (its polygons together), or features of that kind (the one-kind import, kept for API callers). */
		kind: z.enum(MAP_FEATURE_KINDS).optional(),
		/** Or each feature's own kind, name and node, from the review (every feature in the file, once). */
		features: z.array(ReviewedFeature).min(1).max(GEO_MAX_FEATURES).optional(),
		/**
		 * With `features`: a reviewed row marked as the boundary replaces the
		 * project's current one only with this set (the review's "Replace the
		 * current boundary" tick); without it that import is refused (409). The
		 * one-kind `kind: 'catchment_boundary'` import names the whole file the
		 * boundary and replaces it as before.
		 */
		replaceBoundary: z.boolean().optional(),
		text: z.string().min(1)
	})
	.strict()
	.refine((b) => (b.kind === undefined) !== (b.features === undefined), 'give either one kind for the whole file, or each feature’s kind');

export const ImportPreviewBody = z
	.object({
		fileName: z.string().trim().min(1).max(255),
		text: z.string().min(1)
	})
	.strict();

export const AreaFromMap = z
	.object({
		featureId: uuid,
		/** Which of a delineated feature's areas to take (195): its gross area (the default), or its effective one, without what drains into pans. */
		basis: AreaBasis.optional()
	})
	.strict();

export const QuaternaryQuery = z
	.object({
		lon: z.coerce.number().finite().min(-180).max(180),
		lat: z.coerce.number().finite().min(-90).max(90)
	})
	.strict();

export interface FeatureRow {
	id: string;
	kind: MapFeatureKind;
	name: string;
	node_id: string | null;
	node_name: string | null;
	geometry: Geometry;
	properties: Record<string, string>;
	area_m2: number | null;
	non_contributing_m2: number | null;
	dam_position: DamPosition | null;
	source_id: string | null;
	created_by_name: string | null;
	created_at: Date;
	updated_at: Date;
}

export interface MapFeature {
	id: string;
	kind: MapFeatureKind;
	name: string;
	nodeId: string | null;
	nodeName: string | null;
	geometry: Geometry;
	properties: Record<string, string>;
	/** Geodesic area of a polygon, m² (computed on the server); null for points and lines. */
	areaM2: number | null;
	/** Of its area, what drains into pans (m²), when it was made from a delineation that looked (195); null when unknown. Its effective area is areaM2 less it. */
	nonContributingM2: number | null;
	/** A dam polygon's position against its river as the editor said (194); null = not said (always null for anything else). */
	damPosition: DamPosition | null;
	/** A point at its middle (lon, lat): the point itself, a polygon's centroid, a line's middle vertex. */
	center: Position;
	sourceId: string | null;
	createdBy: string | null;
	createdAt: string;
	updatedAt: string;
}

export const toFeature = (r: FeatureRow): MapFeature => ({
	id: r.id,
	kind: r.kind,
	name: r.name,
	nodeId: r.node_id,
	nodeName: r.node_name,
	geometry: r.geometry,
	properties: r.properties,
	areaM2: r.area_m2,
	nonContributingM2: r.non_contributing_m2,
	damPosition: r.dam_position,
	center: centerOf(r.geometry),
	sourceId: r.source_id,
	createdBy: r.created_by_name,
	createdAt: r.created_at.toISOString(),
	updatedAt: r.updated_at.toISOString()
});

const SELECT_FEATURES = `
	SELECT f.id, f.kind, f.name, f.node_id, n.name AS node_name, f.geometry, f.properties, f.area_m2, f.non_contributing_m2, f.dam_position, f.source_id,
		u.display_name AS created_by_name, f.created_at, f.updated_at
	FROM map_feature f
	LEFT JOIN node n ON n.id = f.node_id
	LEFT JOIN app_user u ON u.id = f.created_by
	WHERE f.project_id = $1`;

export async function loadFeature(db: Db, projectId: string, fid: string): Promise<FeatureRow> {
	if (!UUID.test(fid)) throw notFound();
	const { rows } = await db.query<FeatureRow>(`${SELECT_FEATURES} AND f.id = $2`, [projectId, fid]);
	if (!rows[0]) throw notFound();
	return rows[0];
}

/** A geometry from a request: a point from lon/lat, or a checked geometry; 400 with what is wrong. */
function requestGeometry(b: { lon?: number; lat?: number; geometry?: unknown }): { geometry: Geometry; areaM2: number | null } | null {
	if (b.lon !== undefined && b.lat !== undefined) return { geometry: { type: 'Point', coordinates: [b.lon, b.lat] }, areaM2: null };
	if (b.geometry === undefined) return null;
	const checked = checkGeometry(b.geometry);
	if ('problem' in checked) throw new ApiError(400, `The geometry ${checked.problem}.`);
	return checked;
}

function assertKindFits(kind: MapFeatureKind, g: Geometry) {
	if (!KIND_TYPES[kind].includes(g.type)) {
		throw new ApiError(400, `${cap(KIND_LABEL[kind])} can't be a ${g.type}; it is a ${KIND_TYPES[kind].join(' or ')}.`);
	}
}

/** The node a feature stands for must be one of the project's, of a kind that fits (the 152 trigger, said first for a clear 400). */
async function assertNodeFits(db: Db, projectId: string, kind: MapFeatureKind, nodeId: string | null | undefined) {
	if (!nodeId) return;
	const { rows } = await db.query<{ kind: string }>('SELECT kind::text AS kind FROM node WHERE id = $1 AND project_id = $2', [nodeId, projectId]);
	if (!rows[0]) throw new ApiError(400, 'That node is not in this project.');
	if (!KIND_NODES[kind].includes(rows[0].kind)) {
		throw new ApiError(400, KIND_NODES[kind].length ? `${cap(KIND_LABEL[kind])} can stand for a ${KIND_NODES[kind].join(' or ')} node, not a ${rows[0].kind}.` : `${cap(KIND_LABEL[kind])} stands for no node.`);
	}
}

/** The project's one catchment boundary goes, and its import with it when that was the import's last feature. */
export async function removeBoundary(db: Db, projectId: string): Promise<string | null> {
	const { rows } = await db.query<{ id: string; source_id: string | null }>(
		`DELETE FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' RETURNING id, source_id`,
		[projectId]
	);
	if (rows[0]?.source_id) await dropSourceIfEmpty(db, projectId, rows[0].source_id);
	return rows[0]?.id ?? null;
}

/** The project's catchment boundary (its name), or null when it has none. */
export async function currentBoundary(db: Db, projectId: string): Promise<{ name: string } | null> {
	const { rows } = await db.query<{ name: string }>(`SELECT name FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' ORDER BY created_at LIMIT 1`, [projectId]);
	return rows[0] ? { name: rows[0].name } : null;
}

const DUPLICATE_FILE = 'This file was imported already. Delete its features first to import it again.';

async function dropSourceIfEmpty(db: Db, projectId: string, sourceId: string) {
	await db.query('DELETE FROM geo_source s WHERE s.id = $1 AND s.project_id = $2 AND NOT EXISTS (SELECT 1 FROM map_feature f WHERE f.source_id = s.id)', [
		sourceId,
		projectId
	]);
}

/** A feature an import inserts. `nodeId` undefined: linked to the node of the same name, if one of a fitting kind. */
interface ImportRow {
	kind: MapFeatureKind;
	name: string;
	nodeId?: string | null;
	geometry: Geometry;
	areaM2: number | null;
	properties: Record<string, string>;
}
type Made = { problems: GeoProblem[]; rows: ImportRow[] };

const boundaryName = (name: string, fileName: string) => name || featureNameOf(fileName.replace(/\.(geo)?json$/i, ''));
const mismatch = (f: ParsedFeature, kind: MapFeatureKind): GeoProblem => ({
	feature: f.index,
	message: `is a ${f.geometry.type}; ${KIND_LABEL[kind]} is a ${KIND_TYPES[kind].join(' or ')}`
});

/** The features an import makes of a file's features, all one kind: one boundary (all its polygons together), or one feature each. */
function importedFeatures(kind: MapFeatureKind, parsed: ParsedFeature[], fileName: string): Made {
	const problems = parsed.filter((f) => !KIND_TYPES[kind].includes(f.geometry.type)).map((f) => mismatch(f, kind));
	if (problems.length) return { problems, rows: [] };
	if (kind !== 'catchment_boundary') return { problems, rows: parsed.map((f) => ({ kind, name: f.name, geometry: f.geometry, areaM2: f.areaM2, properties: f.properties })) };
	const polygons = parsed.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []));
	const geometry: Geometry = polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0]! } : { type: 'MultiPolygon', coordinates: polygons };
	// One boundary of overlapping polygons would count the overlap twice in its area.
	const overlap = overlapProblem(polygons);
	if (overlap) {
		const message =
			overlap === 'overlap'
				? 'The file’s polygons overlap, so as one catchment boundary their overlap would count twice; merge them into one polygon (QGIS: Dissolve) and upload it again.'
				: 'The file’s polygons are too complex to check for overlaps as one catchment boundary; simplify them, or merge them into one polygon.';
		return { problems: [{ feature: null, message }], rows: [] };
	}
	return {
		problems,
		rows: [
			{
				kind,
				name: boundaryName(parsed[0]!.name, fileName),
				geometry,
				areaM2: parsed.reduce((s, f) => s + (f.areaM2 ?? 0), 0),
				properties: parsed.length === 1 ? parsed[0]!.properties : {}
			}
		]
	};
}

/**
 * The features an import makes from the review (issue #326 D2): each feature
 * the kind, name and node the editor gave it. Every feature of the file must
 * be listed once; each kind must fit its geometry, each node its kind (the
 * same rules as placing a feature), and a file holds at most one boundary.
 */
async function reviewedFeatures(db: Db, projectId: string, parsed: ParsedFeature[], reviewed: z.infer<typeof ReviewedFeature>[], fileName: string): Promise<Made> {
	const byIndex = new Map(reviewed.map((r) => [r.index, r]));
	if (byIndex.size !== reviewed.length || reviewed.length !== parsed.length || parsed.some((f) => !byIndex.has(f.index))) {
		throw new ApiError(400, `List every feature in the file once: it has ${parsed.length}.`);
	}
	const problems: GeoProblem[] = [];
	const boundaries = reviewed.filter((r) => r.kind === 'catchment_boundary').map((r) => r.index);
	if (boundaries.length > 1) {
		problems.push({ feature: null, message: `A file holds at most one catchment boundary; features ${boundaries.join(', ')} are each marked as one.` });
	}
	const nodeIds = [...new Set(reviewed.flatMap((r) => (r.nodeId ? [r.nodeId] : [])))];
	const { rows: nodes } = nodeIds.length
		? await db.query<{ id: string; kind: string }>('SELECT id, kind::text AS kind FROM node WHERE project_id = $1 AND id = ANY($2::uuid[])', [projectId, nodeIds])
		: { rows: [] };
	const nodeKind = new Map(nodes.map((n) => [n.id, n.kind]));
	const rows: ImportRow[] = [];
	for (const f of parsed) {
		const r = byIndex.get(f.index)!;
		if (!KIND_TYPES[r.kind].includes(f.geometry.type)) {
			problems.push(mismatch(f, r.kind));
			continue;
		}
		if (r.nodeId) {
			const k = nodeKind.get(r.nodeId);
			// Not a choice the review offers: a request naming another project's node is refused outright, as placing a feature is.
			if (!k) throw new ApiError(400, `Feature ${f.index} stands for a node that is not in this project.`);
			if (!KIND_NODES[r.kind].includes(k)) {
				problems.push({ feature: f.index, message: KIND_NODES[r.kind].length ? `is ${KIND_LABEL[r.kind]}, which can stand for a ${KIND_NODES[r.kind].join(' or ')} node, not a ${k}` : `is ${KIND_LABEL[r.kind]}, which stands for no node` });
			}
		}
		const name = r.name ?? f.name;
		rows.push({
			kind: r.kind,
			name: r.kind === 'catchment_boundary' ? boundaryName(name, fileName) : name,
			...(r.nodeId !== undefined ? { nodeId: r.nodeId } : {}),
			geometry: f.geometry,
			areaM2: f.areaM2,
			properties: f.properties
		});
	}
	return problems.length ? { problems, rows: [] } : { problems, rows };
}

/** A polygon's one outline (a Polygon with no holes, or a MultiPolygon of one such part), or null. */
function oneRing(g: Geometry): Position[] | null {
	if (g.type === 'Polygon') return g.coordinates.length === 1 ? g.coordinates[0]! : null;
	if (g.type === 'MultiPolygon') return g.coordinates.length === 1 && g.coordinates[0]!.length === 1 ? g.coordinates[0]![0]! : null;
	return null;
}

const bboxOf = (ring: readonly Position[]): [number, number, number, number] => [
	Math.min(...ring.map((p) => p[0])),
	Math.min(...ring.map((p) => p[1])),
	Math.max(...ring.map((p) => p[0])),
	Math.max(...ring.map((p) => p[1]))
];

/**
 * A traced dam outline's method (issue #326 C2): the server traces the click
 * again with its own raster, so the dataset named is the one it holds, and an
 * outline sent as unadjusted must be that trace exactly.
 */
async function tracedMethod(t: { lon: number; lat: number; minOccurrence: MinOccurrence; edited: boolean }, g: Geometry): Promise<{ description: string; dataset: string }> {
	const water = configuredWater();
	if (!water) throw new ApiError(409, 'Tracing is off: the server has no water occurrence data (WATER_URL is empty).');
	let trace;
	try {
		trace = await traceDam(water, [t.lon, t.lat], t.minOccurrence);
	} catch (err) {
		if (err instanceof TraceRefused) throw new ApiError(422, err.message, { reason: err.code });
		logEvent('error', { event: 'dam_trace_failed', ...safeError(err) });
		throw new ApiError(503, 'The water occurrence data could not be read just now. Try again; if it keeps failing, the operator should check WATER_URL.');
	}
	if (!t.edited && JSON.stringify(trace.geometry) !== JSON.stringify(g)) {
		throw new ApiError(400, 'That outline isn’t the one traced there. Save it as adjusted, or trace it again.');
	}
	const lat = `${Math.abs(t.lat).toFixed(4)}° ${t.lat < 0 ? 'S' : 'N'}`;
	const lon = `${Math.abs(t.lon).toFixed(4)}° ${t.lon < 0 ? 'W' : 'E'}`;
	const attribution = trace.dataset.attribution && trace.dataset.attribution !== 'synthetic' ? ` ${trace.dataset.attribution}.` : '';
	const description =
		`Traced from ${trace.dataset.label} (${trace.methodVersion}): water in at least ${t.minOccurrence} % of the observations, clicked at ${lat}, ${lon}` +
		`${t.edited ? '; then adjusted by hand' : ''}. Check it against the map.${attribution}`;
	return { description: description.slice(0, 500), dataset: trace.dataset.label };
}

const sha256Of = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

type NodeRef = { id: string; name: string; kind: string };
const projectNodes = async (db: Db, projectId: string) =>
	(await db.query<NodeRef>('SELECT id, name, kind::text AS kind FROM node WHERE project_id = $1 ORDER BY sort_order, name', [projectId])).rows;

/** A feature named like a node of a kind it can stand for is linked to it (the editor can change the link); nothing else follows from it. */
const nodeByName =
	(nodes: readonly NodeRef[]) =>
	(kind: MapFeatureKind, name: string): string | null =>
		name.trim() ? (nodes.find((n) => KIND_NODES[kind].includes(n.kind) && n.name.trim().toLowerCase() === name.trim().toLowerCase())?.id ?? null) : null;

const importLimit = () =>
	bodyLimit({
		maxSize: MAP_IMPORT_BODY_MAX,
		onError: (c) => c.json({ error: `GeoJSON file larger than ${GEO_MAX_BYTES / 1024 / 1024} MB; simplify it or split it` }, 413)
	});

export const mapRoutes = new Hono<AuthEnv>()
	.get('/:id/map/features', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireRole(db, id, 'viewer');
			const { rows } = await db.query<FeatureRow>(`${SELECT_FEATURES} ORDER BY f.kind = 'catchment_boundary' DESC, f.kind, lower(f.name), f.created_at, f.id`, [id]);
			const { rows: sources } = await db.query<{ id: string; file_name: string; sha256: string; crs: string; imported_at: Date; imported_by: string | null; features: number }>(
				`SELECT s.id, s.file_name, s.sha256, s.crs, s.imported_at, u.display_name AS imported_by,
					(SELECT count(*)::integer FROM map_feature f WHERE f.source_id = s.id) AS features
				 FROM geo_source s LEFT JOIN app_user u ON u.id = s.imported_by
				 WHERE s.project_id = $1 ORDER BY s.imported_at DESC, s.id`,
				[id]
			);
			const { rows: nodes } = await db.query<{ id: string; name: string; kind: string; area_km2: number; area_source: 'typed' | 'map'; area_basis: AreaBasis | null; area_feature_id: string | null }>(
				'SELECT id, name, kind::text AS kind, area_km2, area_source, area_basis, area_feature_id FROM node WHERE project_id = $1 ORDER BY sort_order, name',
				[id]
			);
			return c.json({
				features: rows.map(toFeature),
				sources: sources.map((s) => ({ id: s.id, fileName: s.file_name, sha256: s.sha256, crs: s.crs, importedAt: s.imported_at.toISOString(), importedBy: s.imported_by, features: s.features })),
				nodes: nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind, areaKm2: n.area_km2, areaSource: n.area_source, areaBasis: n.area_basis, areaFeatureId: n.area_feature_id })),
				quaternaryDatasets: await quaternaryDatasets(db)
			});
		})
	)
	// Which nodes get a "Show on map" link on the Network, Hydrological units and
	// Dams pages (issue #326): only the ids, never a geometry. Viewer, like the
	// feature list: a farmer gets 403 (their farm view has no map).
	.get('/:id/map/linked-nodes', async (c) =>
		withUser(c.get('userId'), async (db) => {
			const id = c.req.param('id');
			await requireRole(db, id, 'viewer');
			const { rows } = await db.query<{ node_id: string }>(
				'SELECT DISTINCT node_id FROM map_feature WHERE project_id = $1 AND node_id IS NOT NULL ORDER BY node_id',
				[id]
			);
			return c.json({ nodeIds: rows.map((r) => r.node_id) });
		})
	)
	.post('/:id/map/features', async (c) => {
		const body = CreateFeature.parse(await readJson(c));
		const id = c.req.param('id');
		const userId = c.get('userId');
		// Checked before the trace below, so a viewer can't make the server read the raster.
		await withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			// The re-trace below counts as a trace (186_map_compute_throttle).
			if (body.traced) await countMapCompute(c, db, id, 'trace');
		});
		const g = requestGeometry(body)!;
		assertKindFits(body.kind, g.geometry);
		const traced = body.traced ? await tracedMethod(body.traced, g.geometry) : null;
		return withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			await assertNodeFits(db, id, body.kind, body.nodeId);
			if (body.kind === 'catchment_boundary') await removeBoundary(db, id);
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO map_feature (project_id, kind, name, node_id, geometry, properties, area_m2, created_by)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, app_current_user_id()) RETURNING id`,
				[id, body.kind, body.name ?? '', body.nodeId ?? null, JSON.stringify(g.geometry), JSON.stringify(traced ? { description: traced.description } : {}), g.areaM2]
			);
			const feature = toFeature(await loadFeature(db, id, rows[0]!.id));
			await recordAudit(db, id, 'map.feature_created', {
				featureId: feature.id,
				kind: feature.kind,
				name: feature.name,
				nodeId: feature.nodeId,
				...(traced ? { from: 'dam_trace', dataset: traced.dataset, minOccurrence: body.traced!.minOccurrence, edited: body.traced!.edited } : {})
			});
			return c.json({ feature }, 201);
		});
	})
	.post('/:id/map/features/:fid/split', async (c) => {
		// A polygon cut in two along a drawn line (issue #326 C2; the cut is made in the browser, draw/split.ts): both parts
		// pass checkGeometry, and together they must be the shape (their areas add up, each lies within it).
		const body = SplitFeature.parse(await readJson(c));
		const { id, fid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const before = await loadFeature(db, id, fid);
			const ring = oneRing(before.geometry);
			if (!SPLIT_KINDS.includes(before.kind) || !ring) throw new ApiError(400, 'Only a polygon of one outline (no holes, one part) can be split.');
			const parts = body.parts.map((p, i) => {
				const checked = checkGeometry(p);
				if ('problem' in checked) throw new ApiError(400, `Part ${i + 1} ${checked.problem}.`);
				if (checked.geometry.type !== 'Polygon' || checked.areaM2 === null) throw new ApiError(400, `Part ${i + 1} must be a polygon.`);
				return { geometry: checked.geometry, areaM2: checked.areaM2 };
			});
			// The shape's own area, not its stored one: a delineated piece's area_m2 is its cells' (start-6), its outline simplified.
			const whole = polygonAreaM2(ring ? [ring] : []);
			const sum = parts[0]!.areaM2 + parts[1]!.areaM2;
			const box = bboxOf(ring);
			const inside = parts.every((p) => p.geometry.coordinates[0]!.every(([x, y]) => x >= box[0] - 1e-6 && x <= box[2] + 1e-6 && y >= box[1] - 1e-6 && y <= box[3] + 1e-6));
			// Within the bounds and adding up isn't enough: each part must lie within the shape (splitCheck.ts).
			// Nor is each lying within it: the same half twice adds up too. The parts may share the cut, never overlap.
			if (
				!inside ||
				Math.abs(sum - whole) > SPLIT_AREA_TOLERANCE * whole + 1 ||
				partsWithin(ring, parts.map((p) => p.geometry.coordinates[0]!)) !== null ||
				overlapProblem(parts.map((p) => p.geometry.coordinates)) !== null
			) {
				throw new ApiError(400, 'The two parts are not this shape cut in two: together they must cover it exactly. Draw the line again.');
			}
			const label = before.name ? `“${before.name}”` : KIND_LABEL[before.kind];
			const description = `Split from ${label} along a drawn line.`.slice(0, 500);
			const ids: string[] = [];
			let into: MapFeatureKind;
			const insert = async (kind: MapFeatureKind, name: string, p: (typeof parts)[number]) => {
				const { rows } = await db.query<{ id: string }>(
					`INSERT INTO map_feature (project_id, kind, name, geometry, properties, area_m2, created_by)
					 VALUES ($1, $2, $3, $4, $5, $6, app_current_user_id()) RETURNING id`,
					[id, kind, name.slice(0, FEATURE_NAME_MAX), JSON.stringify(p.geometry), JSON.stringify({ description }), p.areaM2]
				);
				ids.push(rows[0]!.id);
			};
			if (before.kind === 'catchment_boundary') {
				// The boundary stays whole: its parts are new areas (sub-catchments to link to units, or parcels).
				into = body.as ?? 'other';
				const base = before.name || 'Catchment';
				await insert(into, body.names?.[0] || `${base} part 1`, parts[0]!);
				await insert(into, body.names?.[1] || `${base} part 2`, parts[1]!);
			} else {
				if (body.as) throw new ApiError(400, 'Only the catchment boundary’s parts take another kind; a split shape keeps its own.');
				into = before.kind;
				mustChange(
					// The pans figure was the whole outline's: neither part has one.
					await db.query(`UPDATE map_feature SET name = $3, geometry = $4, area_m2 = $5, non_contributing_m2 = NULL WHERE id = $1 AND project_id = $2`, [
						fid,
						id,
						(body.names?.[0] || before.name).slice(0, FEATURE_NAME_MAX),
						JSON.stringify(parts[0]!.geometry),
						parts[0]!.areaM2
					])
				);
				ids.push(fid);
				await insert(before.kind, body.names?.[1] || (before.name ? `${before.name} (part 2)` : ''), parts[1]!);
			}
			const features = await Promise.all(ids.map(async (fidN) => toFeature(await loadFeature(db, id, fidN))));
			await recordAudit(db, id, 'map.feature_split', {
				featureId: fid,
				kind: before.kind,
				name: before.name,
				into,
				parts: ids,
				areasKm2: parts.map((p) => Math.round(p.areaM2 / 1e4) / 100)
			});
			return c.json({ features }, 201);
		});
	})
	.patch('/:id/map/features/:fid', async (c) => {
		const body = EditFeature.parse(await readJson(c));
		const { id, fid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const before = await loadFeature(db, id, fid);
			const kind = body.kind ?? before.kind;
			const g = requestGeometry(body);
			assertKindFits(kind, g?.geometry ?? before.geometry);
			const nodeId = body.nodeId !== undefined ? body.nodeId : KIND_NODES[kind].length ? before.node_id : null;
			await assertNodeFits(db, id, kind, nodeId);
			// Only a dam polygon says where it stands against its river (194): asked of anything else, 400; kept while it stays one, else cleared.
			const damPolygon = kind === 'dam' && ['Polygon', 'MultiPolygon'].includes((g?.geometry ?? before.geometry).type);
			if (body.damPosition && !damPolygon) throw new ApiError(400, 'Only a dam drawn as its outline can be marked on or off the river; a point has no outflow of its own to place.');
			const damPosition = damPolygon ? (body.damPosition !== undefined ? body.damPosition : before.dam_position) : null;
			if (kind === 'catchment_boundary' && before.kind !== 'catchment_boundary') await removeBoundary(db, id);
			mustChange(
				await db.query(
					// A new outline drops the pans figure, which was the old outline's (195).
					`UPDATE map_feature SET kind = $3, name = $4, node_id = $5, geometry = $6, area_m2 = $7, dam_position = $8,
						non_contributing_m2 = CASE WHEN $9::boolean THEN NULL ELSE non_contributing_m2 END
					 WHERE id = $1 AND project_id = $2`,
					[fid, id, kind, body.name ?? before.name, nodeId, JSON.stringify(g?.geometry ?? before.geometry), g ? g.areaM2 : before.area_m2, damPosition, g !== null]
				)
			);
			const feature = toFeature(await loadFeature(db, id, fid));
			await recordAudit(db, id, 'map.feature_changed', {
				featureId: fid,
				kind,
				name: feature.name,
				moved: g !== null,
				nodeId: feature.nodeId,
				...(damPosition !== before.dam_position ? { damPosition: { from: before.dam_position, to: damPosition } } : {})
			});
			return c.json({ feature });
		});
	})
	.delete('/:id/map/features/:fid', async (c) => {
		const { id, fid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const f = await loadFeature(db, id, fid);
			mustChange(await db.query('DELETE FROM map_feature WHERE id = $1 AND project_id = $2', [fid, id]));
			if (f.source_id) await dropSourceIfEmpty(db, id, f.source_id);
			await recordAudit(db, id, 'map.feature_deleted', { featureId: fid, kind: f.kind, name: f.name });
			return c.body(null, 204);
		});
	})
	.post('/:id/map/import/preview', importLimit(), async (c) => {
		// The review before an import (issue #326 D2): the file read and checked as the import will, each feature's kind proposed; nothing is saved.
		const body = ImportPreviewBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const parsed = parseGeoJson(body.text);
			const sha256 = sha256Of(body.text);
			const { rows: dup } = await db.query('SELECT 1 FROM geo_source WHERE project_id = $1 AND sha256 = $2', [id, sha256]);
			const boundary = await currentBoundary(db, id);
			const proposals = proposeKinds(parsed.features, { hasBoundary: boundary !== null });
			const nodes = await projectNodes(db, id);
			const link = nodeByName(nodes);
			const refused = parsed.problems.flatMap((p) => (p.feature === null ? [] : [p.feature]));
			const features = [
				...parsed.features.map((f, i) => {
					const p = proposals[i]!;
					return {
						index: f.index,
						geometryType: f.geometry.type,
						name: f.name,
						areaM2: f.areaM2,
						kind: p.kind,
						kindFrom: p.from,
						...(p.note ? { note: p.note } : {}),
						nodeId: link(p.kind, f.name)
					};
				}),
				...[...new Set(refused)].map((index) => ({ index, geometryType: null, name: '', areaM2: null, kind: null, kindFrom: null, nodeId: null }))
			].sort((x, y) => x.index - y.index);
			// currentBoundary: a row imported as the boundary replaces it, so the review warns and asks for the tick.
			return c.json({ fileName: body.fileName, sha256, duplicate: dup.length > 0, currentBoundary: boundary, features, problems: parsed.problems, nodes });
		});
	})
	.post('/:id/map/import', importLimit(), async (c) => {
		const body = ImportBody.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const parsed = parseGeoJson(body.text);
			const made: Made = parsed.problems.length
				? { problems: parsed.problems, rows: [] }
				: body.features
					? await reviewedFeatures(db, id, parsed.features, body.features, body.fileName)
					: importedFeatures(body.kind!, parsed.features, body.fileName);
			if (made.problems.length) throw new ApiError(422, 'The file was not imported: fix the problems listed and upload it again.', made.problems);
			const sha256 = sha256Of(body.text);
			const { rows: dup } = await db.query('SELECT 1 FROM geo_source WHERE project_id = $1 AND sha256 = $2', [id, sha256]);
			if (dup[0]) throw new ApiError(409, DUPLICATE_FILE);
			if (made.rows.some((r) => r.kind === 'catchment_boundary')) {
				// A reviewed boundary row never replaces the current boundary silently: the editor ticks it (the one-kind import names the file the boundary).
				const boundary = body.features ? await currentBoundary(db, id) : null;
				if (boundary && body.replaceBoundary !== true) {
					throw new ApiError(
						409,
						`Importing this file replaces the current catchment boundary${boundary.name ? ` “${boundary.name}”` : ''}. Tick “Replace the current boundary” to import it, or set that row to another kind.`
					);
				}
				await removeBoundary(db, id);
			}
			// Two identical imports at once both pass the check above; the unique index (geo_source_sha_idx) stops the second, which gets the same answer.
			const { rows: src } = await db
				.query<{ id: string }>(
					`INSERT INTO geo_source (project_id, file_name, sha256, crs, imported_by) VALUES ($1, $2, $3, 'EPSG:4326', app_current_user_id()) RETURNING id`,
					[id, body.fileName, sha256]
				)
				.catch((err: unknown) => {
					if ((err as { code?: string; constraint?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'geo_source_sha_idx') throw new ApiError(409, DUPLICATE_FILE);
					throw err;
				});
			const sourceId = src[0]!.id;
			const link = nodeByName(await projectNodes(db, id));
			const ids: string[] = [];
			for (const r of made.rows) {
				const { rows: ins } = await db.query<{ id: string }>(
					`INSERT INTO map_feature (project_id, kind, name, node_id, geometry, properties, area_m2, source_id, created_by)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, app_current_user_id()) RETURNING id`,
					[id, r.kind, r.name, r.nodeId !== undefined ? r.nodeId : link(r.kind, r.name), JSON.stringify(r.geometry), JSON.stringify(r.properties), r.areaM2, sourceId]
				);
				ids.push(ins[0]!.id);
			}
			const kinds: Partial<Record<MapFeatureKind, number>> = {};
			for (const r of made.rows) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
			const kindNames = Object.keys(kinds);
			await recordAudit(db, id, 'map.imported', { sourceId, fileName: body.fileName, kind: kindNames.length === 1 ? kindNames[0] : 'mixed', kinds, features: made.rows.length, sha256 });
			// In the file's order (one transaction: created_at can't tell them apart).
			const { rows } = await db.query<FeatureRow>(`${SELECT_FEATURES} AND f.source_id = $2`, [id, sourceId]);
			const at = new Map(ids.map((x, i) => [x, i]));
			rows.sort((a, b) => at.get(a.id)! - at.get(b.id)!);
			return c.json({ source: { id: sourceId, fileName: body.fileName, sha256 }, features: rows.map(toFeature) }, 201);
		});
	})
	.post('/:id/nodes/:nodeId/area-from-map', async (c) => {
		const body = AreaFromMap.parse(await readJson(c));
		const { id, nodeId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			if (!UUID.test(nodeId)) throw notFound();
			const { rows: n } = await db.query<{ name: string; kind: string }>('SELECT name, kind::text AS kind FROM node WHERE id = $1 AND project_id = $2', [nodeId, id]);
			if (!n[0]) throw notFound();
			if (n[0].kind !== 'farm') throw new ApiError(400, 'Only a hydrological unit (a farm node) has a catchment area to set from the map.');
			const f = await loadFeature(db, id, body.featureId);
			if (f.area_m2 === null || f.area_m2 <= 0) throw new ApiError(400, 'That feature is not a polygon with an area.');
			if (!AREA_KINDS.includes(f.kind)) throw new ApiError(400, `${cap(KIND_LABEL[f.kind])}’s area is not a hydrological unit’s catchment area; use a farm parcel.`);
			const label = f.name ? `“${f.name}”` : KIND_LABEL[f.kind];
			// Gross unless the effective area (without what drains into pans) is asked for, and the feature has the figure (195).
			const basis = body.basis ?? 'gross';
			const areaKm2 = takenAreaM2(label, f.area_m2, f.non_contributing_m2, basis) / 1e6;
			const change = await beginModelChange(db, id);
			// A delineated piece's parcel stores its area from the DEM's cells (start-6), its outline simplified: say which.
			const outlineM2 = geometryAreaM2(f.geometry) ?? 0;
			const fromPolygon = Math.abs(outlineM2 - f.area_m2) <= 1e-6 * f.area_m2 + 0.01;
			await db.query(`UPDATE node SET area_km2 = $3, area_source = 'map', area_basis = $5, area_feature_id = $4 WHERE id = $1 AND project_id = $2`, [nodeId, id, areaKm2, f.id, basis]);
			const revision = await recordModelRevision(db, id, {
				source: 'model_put',
				before: change.before,
				reason: `Area of ${n[0].name} from the map: ${label} (${[`${areaKm2.toFixed(3)} km²`, basisText(basis, f.non_contributing_m2)].filter(Boolean).join(', ')}, ${fromPolygon ? 'computed from its polygon' : 'from the elevation model’s cells it was delineated from'})`.slice(0, 500)
			});
			return c.json({ nodeId, areaKm2, areaSource: 'map', areaBasis: basis, areaFeatureId: f.id, revisionId: revision?.id ?? null });
		});
	})
	.get('/:id/map/quaternary', async (c) => {
		const q = QuaternaryQuery.parse(c.req.query());
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			return c.json({ point: [q.lon, q.lat], quaternary: await quaternaryAt(db, [q.lon, q.lat]), datasets: await quaternaryDatasets(db) });
		});
	});
