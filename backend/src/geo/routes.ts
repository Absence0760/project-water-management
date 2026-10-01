// The catchment map (issue #288, roadmap WP-3.12; 152_catchment_map.sql,
// docs/api.md § Catchment map, docs/maps.md).
//
//   GET    /projects/:id/map/features                   features, sources, nodes' area sources (viewer)
//   POST   /projects/:id/map/features                   place one feature: a point from the coordinates form, or a geometry (editor)
//   PATCH  /projects/:id/map/features/:fid              rename, re-kind, link to a node, move (editor)
//   DELETE /projects/:id/map/features/:fid              (editor); its import goes with its last feature
//   POST   /projects/:id/map/import                     a GeoJSON file, checked on the server (editor)
//   POST   /projects/:id/nodes/:nodeId/area-from-map    accept a polygon's area as a farm's area (editor)
//   GET    /projects/:id/map/quaternary?lon=&lat=       the quaternary at a point and its reference values, proposed (viewer)
//
// Every geometry passes geo/geojson.ts; every area is computed here
// (geo/area.ts). Nothing on the map changes the model by itself: an area
// enters it only through area-from-map (recorded as a model revision with
// the feature named), and the quaternary lookup only proposes values the
// hydrologist accepts in Settings.
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { beginModelChange, recordAudit, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError, mustChange, notFound } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { centerOf, checkGeometry, FEATURE_NAME_MAX, GEO_MAX_BYTES, parseGeoJson, type Geometry, type ParsedFeature, type Position } from './geojson.js';
import { quaternaryAt, quaternaryDatasets } from './quaternary.js';

export const MAP_FEATURE_KINDS = ['catchment_boundary', 'farm_parcel', 'dam', 'gauge', 'river', 'other'] as const;
export type MapFeatureKind = (typeof MAP_FEATURE_KINDS)[number];

/** The import's own body cap: the file (GEO_MAX_BYTES) as a JSON string, with room for its escapes (app.ts exempts this path from the general 4 MB). */
export const MAP_IMPORT_BODY_MAX = GEO_MAX_BYTES + 2 * 1024 * 1024;
/** The path app.ts lets past the general body limit, to this route's own. */
export const MAP_IMPORT_PATH = /^\/projects\/[^/]+\/map\/import$/;

/** The geometry types each kind may have (the 152 CHECKs, said first for a clear 400). */
const KIND_TYPES: Record<MapFeatureKind, readonly Geometry['type'][]> = {
	catchment_boundary: ['Polygon', 'MultiPolygon'],
	farm_parcel: ['Polygon', 'MultiPolygon'],
	dam: ['Point', 'Polygon', 'MultiPolygon'],
	gauge: ['Point'],
	river: ['LineString', 'MultiLineString'],
	other: ['Point', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']
};
/**
 * The kinds whose polygon may become a hydrological unit's catchment area: a
 * farm parcel, or an "other" polygon the editor drew for the purpose. A dam's
 * water surface or the whole catchment's boundary is never one unit's area.
 */
export const AREA_KINDS: readonly MapFeatureKind[] = ['farm_parcel', 'other'];
/** The node kinds a feature of each kind may stand for. */
const KIND_NODES: Record<MapFeatureKind, readonly string[]> = {
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
const Name = z.string().trim().max(FEATURE_NAME_MAX);
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
		geometry: z.unknown().optional()
	})
	.strict()
	.refine((b) => (b.geometry === undefined) === (b.lon !== undefined && b.lat !== undefined), 'give either a longitude and latitude, or a geometry');

export const EditFeature = z
	.object({
		kind: z.enum(MAP_FEATURE_KINDS).optional(),
		name: Name.optional(),
		nodeId: uuid.nullable().optional(),
		lon: Lon.optional(),
		lat: Lat.optional(),
		geometry: z.unknown().optional()
	})
	.strict()
	.refine((b) => b.geometry === undefined || (b.lon === undefined && b.lat === undefined), 'give either a longitude and latitude, or a geometry')
	.refine((b) => (b.lon === undefined) === (b.lat === undefined), 'give both a longitude and a latitude');

export const ImportBody = z
	.object({
		fileName: z.string().trim().min(1).max(255),
		/** What the file's features are: one catchment boundary (its polygons together), or features of one kind. */
		kind: z.enum(MAP_FEATURE_KINDS),
		text: z.string().min(1)
	})
	.strict();

export const AreaFromMap = z.object({ featureId: uuid }).strict();

export const QuaternaryQuery = z
	.object({
		lon: z.coerce.number().finite().min(-180).max(180),
		lat: z.coerce.number().finite().min(-90).max(90)
	})
	.strict();

interface FeatureRow {
	id: string;
	kind: MapFeatureKind;
	name: string;
	node_id: string | null;
	node_name: string | null;
	geometry: Geometry;
	properties: Record<string, string>;
	area_m2: number | null;
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
	/** A point at its middle (lon, lat): the point itself, a polygon's centroid, a line's middle vertex. */
	center: Position;
	sourceId: string | null;
	createdBy: string | null;
	createdAt: string;
	updatedAt: string;
}

const toFeature = (r: FeatureRow): MapFeature => ({
	id: r.id,
	kind: r.kind,
	name: r.name,
	nodeId: r.node_id,
	nodeName: r.node_name,
	geometry: r.geometry,
	properties: r.properties,
	areaM2: r.area_m2,
	center: centerOf(r.geometry),
	sourceId: r.source_id,
	createdBy: r.created_by_name,
	createdAt: r.created_at.toISOString(),
	updatedAt: r.updated_at.toISOString()
});

const SELECT_FEATURES = `
	SELECT f.id, f.kind, f.name, f.node_id, n.name AS node_name, f.geometry, f.properties, f.area_m2, f.source_id,
		u.display_name AS created_by_name, f.created_at, f.updated_at
	FROM map_feature f
	LEFT JOIN node n ON n.id = f.node_id
	LEFT JOIN app_user u ON u.id = f.created_by
	WHERE f.project_id = $1`;

async function loadFeature(db: Db, projectId: string, fid: string): Promise<FeatureRow> {
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
async function removeBoundary(db: Db, projectId: string): Promise<string | null> {
	const { rows } = await db.query<{ id: string; source_id: string | null }>(
		`DELETE FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' RETURNING id, source_id`,
		[projectId]
	);
	if (rows[0]?.source_id) await dropSourceIfEmpty(db, projectId, rows[0].source_id);
	return rows[0]?.id ?? null;
}

async function dropSourceIfEmpty(db: Db, projectId: string, sourceId: string) {
	await db.query('DELETE FROM geo_source s WHERE s.id = $1 AND s.project_id = $2 AND NOT EXISTS (SELECT 1 FROM map_feature f WHERE f.source_id = s.id)', [
		sourceId,
		projectId
	]);
}

/** The features an import makes of a file's features: one boundary (all its polygons together), or one feature each. */
function importedFeatures(kind: MapFeatureKind, parsed: ParsedFeature[], fileName: string): { problems: { feature: number | null; message: string }[]; rows: { name: string; geometry: Geometry; areaM2: number | null; properties: Record<string, string> }[] } {
	const problems = parsed
		.filter((f) => !KIND_TYPES[kind].includes(f.geometry.type))
		.map((f) => ({ feature: f.index, message: `is a ${f.geometry.type}; ${KIND_LABEL[kind]} is a ${KIND_TYPES[kind].join(' or ')}` }));
	if (problems.length) return { problems, rows: [] };
	if (kind !== 'catchment_boundary') return { problems, rows: parsed.map((f) => ({ name: f.name, geometry: f.geometry, areaM2: f.areaM2, properties: f.properties })) };
	const polygons = parsed.flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []));
	const geometry: Geometry = polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0]! } : { type: 'MultiPolygon', coordinates: polygons };
	return {
		problems,
		rows: [
			{
				name: parsed[0]!.name || fileName.replace(/\.(geo)?json$/i, '').slice(0, FEATURE_NAME_MAX),
				geometry,
				areaM2: parsed.reduce((s, f) => s + (f.areaM2 ?? 0), 0),
				properties: parsed.length === 1 ? parsed[0]!.properties : {}
			}
		]
	};
}

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
			const { rows: nodes } = await db.query<{ id: string; name: string; kind: string; area_km2: number; area_source: 'typed' | 'map'; area_feature_id: string | null }>(
				'SELECT id, name, kind::text AS kind, area_km2, area_source, area_feature_id FROM node WHERE project_id = $1 ORDER BY sort_order, name',
				[id]
			);
			return c.json({
				features: rows.map(toFeature),
				sources: sources.map((s) => ({ id: s.id, fileName: s.file_name, sha256: s.sha256, crs: s.crs, importedAt: s.imported_at.toISOString(), importedBy: s.imported_by, features: s.features })),
				nodes: nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind, areaKm2: n.area_km2, areaSource: n.area_source, areaFeatureId: n.area_feature_id })),
				quaternaryDatasets: await quaternaryDatasets(db)
			});
		})
	)
	.post('/:id/map/features', async (c) => {
		const body = CreateFeature.parse(await readJson(c));
		const id = c.req.param('id');
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const g = requestGeometry(body)!;
			assertKindFits(body.kind, g.geometry);
			await assertNodeFits(db, id, body.kind, body.nodeId);
			if (body.kind === 'catchment_boundary') await removeBoundary(db, id);
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO map_feature (project_id, kind, name, node_id, geometry, area_m2, created_by)
				 VALUES ($1, $2, $3, $4, $5, $6, app_current_user_id()) RETURNING id`,
				[id, body.kind, body.name ?? '', body.nodeId ?? null, JSON.stringify(g.geometry), g.areaM2]
			);
			const feature = toFeature(await loadFeature(db, id, rows[0]!.id));
			await recordAudit(db, id, 'map.feature_created', { featureId: feature.id, kind: feature.kind, name: feature.name, nodeId: feature.nodeId });
			return c.json({ feature }, 201);
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
			if (kind === 'catchment_boundary' && before.kind !== 'catchment_boundary') await removeBoundary(db, id);
			mustChange(
				await db.query(
					`UPDATE map_feature SET kind = $3, name = $4, node_id = $5, geometry = $6, area_m2 = $7
					 WHERE id = $1 AND project_id = $2`,
					[fid, id, kind, body.name ?? before.name, nodeId, JSON.stringify(g?.geometry ?? before.geometry), g ? g.areaM2 : before.area_m2]
				)
			);
			const feature = toFeature(await loadFeature(db, id, fid));
			await recordAudit(db, id, 'map.feature_changed', { featureId: fid, kind, name: feature.name, moved: g !== null, nodeId: feature.nodeId });
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
	.post(
		'/:id/map/import',
		bodyLimit({
			maxSize: MAP_IMPORT_BODY_MAX,
			onError: (c) => c.json({ error: `GeoJSON file larger than ${GEO_MAX_BYTES / 1024 / 1024} MB; simplify it or split it` }, 413)
		}),
		async (c) => {
			const body = ImportBody.parse(await readJson(c));
			const id = c.req.param('id');
			return withUser(c.get('userId'), async (db) => {
				await requireRole(db, id, 'editor');
				const parsed = parseGeoJson(body.text);
				const made = parsed.problems.length ? { problems: parsed.problems, rows: [] } : importedFeatures(body.kind, parsed.features, body.fileName);
				if (made.problems.length) throw new ApiError(422, 'The file was not imported: fix the problems listed and upload it again.', made.problems);
				const sha256 = createHash('sha256').update(body.text, 'utf8').digest('hex');
				const { rows: dup } = await db.query('SELECT 1 FROM geo_source WHERE project_id = $1 AND sha256 = $2', [id, sha256]);
				if (dup[0]) throw new ApiError(409, 'This file was imported already. Delete its features first to import it again.');
				if (body.kind === 'catchment_boundary') await removeBoundary(db, id);
				const { rows: src } = await db.query<{ id: string }>(
					`INSERT INTO geo_source (project_id, file_name, sha256, crs, imported_by) VALUES ($1, $2, $3, 'EPSG:4326', app_current_user_id()) RETURNING id`,
					[id, body.fileName, sha256]
				);
				const sourceId = src[0]!.id;
				// A feature named like a node of a kind it can stand for is linked to it (the editor can change the link); nothing else follows from it.
				const { rows: nodes } = await db.query<{ id: string; name: string; kind: string }>('SELECT id, name, kind::text AS kind FROM node WHERE project_id = $1', [id]);
				const byName = (name: string) => nodes.find((n) => KIND_NODES[body.kind].includes(n.kind) && n.name.trim().toLowerCase() === name.trim().toLowerCase())?.id ?? null;
				const ids: string[] = [];
				for (const r of made.rows) {
					const { rows: ins } = await db.query<{ id: string }>(
						`INSERT INTO map_feature (project_id, kind, name, node_id, geometry, properties, area_m2, source_id, created_by)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, app_current_user_id()) RETURNING id`,
						[id, body.kind, r.name, r.name ? byName(r.name) : null, JSON.stringify(r.geometry), JSON.stringify(r.properties), r.areaM2, sourceId]
					);
					ids.push(ins[0]!.id);
				}
				await recordAudit(db, id, 'map.imported', { sourceId, fileName: body.fileName, kind: body.kind, features: made.rows.length, sha256 });
				// In the file's order (one transaction: created_at can't tell them apart).
				const { rows } = await db.query<FeatureRow>(`${SELECT_FEATURES} AND f.source_id = $2`, [id, sourceId]);
				const at = new Map(ids.map((x, i) => [x, i]));
				rows.sort((a, b) => at.get(a.id)! - at.get(b.id)!);
				return c.json({ source: { id: sourceId, fileName: body.fileName, sha256 }, features: rows.map(toFeature) }, 201);
			});
		}
	)
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
			const change = await beginModelChange(db, id);
			const areaKm2 = f.area_m2 / 1e6;
			await db.query(`UPDATE node SET area_km2 = $3, area_source = 'map', area_feature_id = $4 WHERE id = $1 AND project_id = $2`, [nodeId, id, areaKm2, f.id]);
			const label = f.name ? `“${f.name}”` : KIND_LABEL[f.kind];
			const revision = await recordModelRevision(db, id, {
				source: 'model_put',
				before: change.before,
				reason: `Area of ${n[0].name} from the map: ${label} (${areaKm2.toFixed(3)} km², computed from its polygon)`.slice(0, 500)
			});
			return c.json({ nodeId, areaKm2, areaSource: 'map', areaFeatureId: f.id, revisionId: revision?.id ?? null });
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
