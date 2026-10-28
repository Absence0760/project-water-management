// The regional GR4J prior for a project (issue #622 step 5, docs/model.md
// §2.10m, docs/api.md § Regional GR4J prior):
//
//   GET  /projects/:id/gr4j-prior          viewer  the prior for the catchment, or one calibration zone (?zone=), from a donor set (?dataset=)
//   POST /projects/:id/gr4j-prior/start    editor  "Start from the prior": write its p50s into that target's GR4J parameters, with a start record
//
// The target is what the fit it serves fits (engine priorTargetOf): with no
// calibration zone, the catchment; under zones (issue #555), the zone's own
// land units (each zone takes the prior built for its own units, never the
// catchment's, model.md §2.10m). Its attributes are what the app knows of
// it: the area, the run's mean annual rain and aridity, the soil grid's PAWC
// over the catchment boundary. Slope, clay, sand and forest stay unknown
// until a target's own HydroATLAS attributes load (docs/followups.md), so
// the donors are compared on those three and on distance. Its position is
// the zone's gauge on the map, else the boundary's centroid.
//
// Everything is read in one read-only transaction, as the user (the donors
// and soil grid are reference tables any signed-in user reads; the project's
// rows under RLS), then computed with no transaction open. The start
// re-derives the prior itself: the client only names the target and dataset.
import {
	currentPriorStart,
	ENGINE_VERSION,
	priorStartParams,
	priorTargetOf,
	regionalPrior,
	type CalibrationZone,
	type CatchmentAttributes,
	type ModelInput,
	type ParamPriors,
	type PriorProvenance,
	type PriorStartRecord,
	type PriorTargetInfo,
	type RegionalPrior
} from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { withUser, type Db } from '../db/tx.js';
import { donorDatasets, donorSetSha256, readDonors, toEngineDonor, type DonorDataset, type DonorRecord } from '../geo/gr4jDonors.js';
import type { Geometry } from '../geo/geojson.js';
import { referenceProvenance } from '../geo/referenceOrigin.js';
import { soilDatasets, summariseSoil, type SoilDataset, type SoilResult } from '../geo/soilGrid.js';
import { beginSettingsChange, recordModelRevision } from '../history/record.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { mergeSettings, patchSettings } from '../projects/settings.js';
import { loadModelInput } from '../runs/execute.js';

const Zone = z.string().regex(UUID, 'a gauge node id');
const Dataset = z.string().trim().min(1).max(50);

/** GET's query: the calibration zone (absent = the site's own zone, or with no zone the catchment) and the donor set (absent = the default). */
export const PriorQuery = z.object({ zone: Zone.optional(), dataset: Dataset.optional() }).strict();
/** POST …/start: the same choice in the body; `zone: null` is the site's own zone. */
export const PriorStart = z.object({ zone: Zone.nullable().optional(), dataset: Dataset.optional() }).strict();

/** Where the target's position came from. */
export type PositionFrom = 'gauge' | 'boundary';

export interface PriorTargetView {
	zoneNodeId: string | null;
	units: string[] | null;
	lon: number | null;
	lat: number | null;
	positionFrom: PositionFrom | null;
	attributes: CatchmentAttributes;
	pawcMm: number | null;
	/** Why the soil grid gave no PAWC; null when it did. */
	soilProblem: string | null;
	rainDays: number;
}

/** A donor the prior kept, with what the panel and the Map show of it. */
export interface PriorDonorView {
	id: string;
	lon: number;
	lat: number;
	areaKm2: number;
	weight: number;
	distanceKm: number;
	similarity: number | null;
	kgeFit: number;
	kgeValidation: number | null;
	params: DonorRecord['params'];
}

export interface PriorResponse {
	dataset: Pick<DonorDataset, 'dataset' | 'version' | 'source' | 'method' | 'attribution' | 'synthetic' | 'donorSetSha256' | 'donors'> | null;
	datasets: { dataset: string; version: string; synthetic: boolean; donors: number }[];
	soil: Pick<SoilDataset, 'dataset' | 'version' | 'attribution' | 'synthetic'> | null;
	target: PriorTargetView | null;
	/** The engine's prior; null with no donor set or no target. */
	prior: RegionalPrior | null;
	/** Why there is no prior to use (no donors, no boundary, …); null when there is one. */
	problem: string | null;
	/** The kept donors, in the prior's order. */
	donors: PriorDonorView[];
	/** The ranges a fit or a start would use (x1 from the soil relation when it has skill and the target a PAWC). */
	ranges: ParamPriors | null;
	provenance: PriorProvenance | null;
	/** The target's start record, while its parameters still hold what it wrote. */
	started: PriorStartRecord | null;
}

/** A polygon's centroid (planar, in degrees: a catchment is small enough), the area-weighted mean of its outer rings'; null with no area. */
export function centroidOf(g: Geometry): [number, number] | null {
	const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
	let a = 0;
	let cx = 0;
	let cy = 0;
	for (const rings of polys) {
		const ring = rings[0] ?? [];
		for (let i = 0; i + 1 < ring.length; i++) {
			const [x0, y0] = ring[i]!;
			const [x1, y1] = ring[i + 1]!;
			const cross = x0! * y1! - x1! * y0!;
			a += cross;
			cx += (x0! + x1!) * cross;
			cy += (y0! + y1!) * cross;
		}
	}
	if (Math.abs(a) < 1e-15) return null;
	return [cx / (3 * a), cy / (3 * a)];
}

/** The target's attributes: area, MAP and aridity from the project; the rest unknown (no BasinATLAS for a target yet). */
export function targetAttributes(t: Pick<PriorTargetInfo, 'areaKm2' | 'mapMm' | 'aridity'>): CatchmentAttributes {
	return { aridity: t.aridity, mapMm: t.mapMm, slopeDeg: null, clayPct: null, sandPct: null, forestPct: null, areaKm2: t.areaKm2 };
}

/** The ranges a fit or start uses: the donors', with x1's from the soil relation when it was used at the target's PAWC. */
export function priorRanges(p: Extract<RegionalPrior, { ok: true }>): { ranges: ParamPriors; x1From: 'donors' | 'soil' } {
	return p.soilX1 ? { ranges: { ...p.params, x1: p.soilX1 }, x1From: 'soil' } : { ranges: p.params, x1From: 'donors' };
}

interface Loaded {
	input: ModelInput;
	stored: unknown;
	dataset: DonorDataset | null;
	datasets: DonorDataset[];
	donors: DonorRecord[];
	soil: SoilDataset | null;
	soilResult: SoilResult | null;
	boundary: Geometry | null;
	gauge: [number, number] | null;
	referenceLoad: PriorProvenance['referenceLoad'];
}

/** Everything the prior needs, read as the user (the caller checks the role first). */
async function load(db: Db, projectId: string, zone: string | null, wanted: string | undefined): Promise<Loaded> {
	const datasets = await donorDatasets(db);
	const dataset = wanted === undefined ? (datasets[0] ?? null) : (datasets.find((d) => d.dataset === wanted) ?? null);
	if (wanted !== undefined && !dataset) throw new ApiError(400, `No donor set “${wanted}” is loaded.`);
	const donors = dataset ? await readDonors(db, dataset.dataset) : [];
	const { rows: b } = await db.query<{ geometry: Geometry }>(
		`SELECT geometry FROM map_feature WHERE project_id = $1 AND kind = 'catchment_boundary' ORDER BY created_at, id LIMIT 1`,
		[projectId]
	);
	const boundary = b[0]?.geometry ?? null;
	const { rows: g } = zone
		? await db.query<{ geometry: Geometry }>(
				`SELECT geometry FROM map_feature WHERE project_id = $1 AND kind = 'gauge' AND node_id = $2 AND geometry ->> 'type' = 'Point' ORDER BY created_at, id LIMIT 1`,
				[projectId, zone]
			)
		: { rows: [] };
	const gp = g[0]?.geometry;
	const gauge = gp?.type === 'Point' ? ([gp.coordinates[0], gp.coordinates[1]] as [number, number]) : null;
	const soil = (await soilDatasets(db))[0] ?? null;
	const soilResult = soil && boundary ? await summariseSoil(db, soil, boundary) : null;
	const line = dataset ? (await referenceProvenance(db)).find((r) => r.kind === 'gr4j-donors' && r.dataset === dataset.dataset) : undefined;
	const referenceLoad = line ? { loadedAt: line.recordedOn, upstreamVersion: line.version, licence: line.licence } : null;
	const { rows: p } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [projectId]);
	return { input: await loadModelInput(db, projectId), stored: p[0]?.settings, dataset, datasets, donors, soil, soilResult, boundary, gauge, referenceLoad };
}

/** The prior from what `load` read (no transaction open: the target's climate takes a run's preparation). */
export function computePrior(l: Loaded, zone: string | null): PriorResponse {
	const settings = mergeSettings(l.stored);
	const base: PriorResponse = {
		dataset: l.dataset
			? {
					dataset: l.dataset.dataset,
					version: l.dataset.version,
					source: l.dataset.source,
					method: l.dataset.method,
					attribution: l.dataset.attribution,
					synthetic: l.dataset.synthetic,
					donorSetSha256: l.dataset.donorSetSha256,
					donors: l.dataset.donors
				}
			: null,
		datasets: l.datasets.map((d) => ({ dataset: d.dataset, version: d.version, synthetic: d.synthetic, donors: d.donors })),
		soil: l.soil ? { dataset: l.soil.dataset, version: l.soil.version, attribution: l.soil.attribution, synthetic: l.soil.synthetic } : null,
		target: null,
		prior: null,
		problem: null,
		donors: [],
		ranges: null,
		provenance: null,
		started: null
	};
	let info: PriorTargetInfo;
	try {
		info = priorTargetOf(l.input, zone);
	} catch (err) {
		throw new ApiError(400, err instanceof Error ? err.message : 'the target can’t be read');
	}
	const centre = l.boundary ? centroidOf(l.boundary) : null;
	const pos = l.gauge ?? centre;
	const pawcMm = l.soilResult && !('problem' in l.soilResult) ? l.soilResult.pawcMm : null;
	const target: PriorTargetView = {
		zoneNodeId: info.zoneNodeId,
		units: info.units,
		lon: pos?.[0] ?? null,
		lat: pos?.[1] ?? null,
		positionFrom: l.gauge ? 'gauge' : centre ? 'boundary' : null,
		attributes: targetAttributes(info),
		pawcMm,
		soilProblem: !l.soil ? 'no soil water capacity grid is loaded' : !l.boundary ? 'there is no catchment boundary on the map' : l.soilResult && 'problem' in l.soilResult ? l.soilResult.problem : null,
		rainDays: info.rainDays
	};
	const started = currentPriorStart((settings as { gr4jPrior?: PriorStartRecord[] | null }).gr4jPrior, info.zoneNodeId, zoneParams(settings, info.zoneNodeId));
	const out: PriorResponse = { ...base, target, started };
	if (!l.dataset) return { ...out, problem: 'No GR4J donor basins are loaded (the operator loads them: docs/deployment.md § Reference datasets).' };
	if (target.lon === null || target.lat === null) return { ...out, problem: 'There is no catchment boundary on the map, so the catchment has no position to compare donors by: draw or import it on the Map first.' };
	const donors = l.donors.map(toEngineDonor);
	const prior = regionalPrior({ lon: target.lon, lat: target.lat, attributes: target.attributes, pawcMm }, donors);
	if (!prior.ok) return { ...out, prior, problem: `The prior can’t be built: ${prior.reason}.` };
	const byId = new Map(l.donors.map((d) => [d.id, d]));
	const { ranges, x1From } = priorRanges(prior);
	const provenance: PriorProvenance = {
		dataset: l.dataset.dataset,
		datasetVersion: l.dataset.version,
		synthetic: l.dataset.synthetic,
		donorSetSha256: l.dataset.donorSetSha256,
		donorSetHash: prior.donorSetHash,
		donorCount: prior.donorCount,
		k: prior.k,
		similarityWeight: prior.similarityWeight,
		donors: prior.donors.map((d) => ({ id: d.id, weight: d.weight })),
		leaveOneOutSkill: prior.leaveOneOut?.skill ?? null,
		leaveOneOutN: prior.leaveOneOut?.n ?? null,
		x1From,
		referenceLoad: l.referenceLoad,
		target: { zoneNodeId: info.zoneNodeId, units: info.units }
	};
	return {
		...out,
		prior,
		ranges,
		provenance,
		donors: prior.donors.map((u) => {
			const d = byId.get(u.id)!;
			return { id: d.id, lon: d.lon, lat: d.lat, areaKm2: d.areaKm2, weight: u.weight, distanceKm: u.distanceKm, similarity: u.similarity, kgeFit: d.kgeFit, kgeValidation: d.kgeValidation, params: d.params };
		})
	};
}

/** The target's current GR4J parameters: a zone row's (null until fitted: the catchment's), else the catchment's. */
function zoneParams(settings: ReturnType<typeof mergeSettings>, zone: string | null) {
	if (zone === null) return settings.gr4j;
	const row = (settings.calibrationZones ?? []).find((z) => z.nodeId === zone);
	return row?.gr4j ?? null;
}

/** The donor set's SHA-256 still matches the table (a stale dataset row would cite a set that is no longer there). */
export const donorsMatch = (l: Pick<Loaded, 'dataset' | 'donors'>) => !l.dataset || donorSetSha256(l.donors) === l.dataset.donorSetSha256;

const fmt = (x: number) => (Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(2));

export const priorRoutes = new Hono<AuthEnv>()
	.get('/:id/gr4j-prior', async (c) => {
		const id = c.req.param('id');
		const q = PriorQuery.parse(c.req.query());
		const loaded = await withUser(
			c.get('userId'),
			async (db) => {
				await requireRole(db, id, 'viewer');
				return load(db, id, q.zone ?? null, q.dataset);
			},
			{ readOnly: true }
		);
		return c.json(computePrior(loaded, q.zone ?? null));
	})
	.post('/:id/gr4j-prior/start', async (c) => {
		const id = c.req.param('id');
		const body = PriorStart.parse(await readJson(c));
		const zone = body.zone ?? null;
		const userId = c.get('userId');
		const loaded = await withUser(
			userId,
			async (db) => {
				await requireRole(db, id, 'editor');
				return load(db, id, zone, body.dataset);
			},
			{ readOnly: true }
		);
		if (!donorsMatch(loaded)) throw new ApiError(409, 'The donor set changed while it was read: try again.');
		const p = computePrior(loaded, zone);
		if (!p.ranges || !p.provenance || !p.prior?.ok) throw new ApiError(400, p.problem ?? 'There is no prior to start from.');
		const params = priorStartParams(p.ranges);
		const record: PriorStartRecord = { appliedAt: new Date().toISOString(), engineVersion: ENGINE_VERSION, params, ranges: p.ranges, provenance: p.provenance };
		const out = await withUser(userId, async (db) => {
			await requireRole(db, id, 'editor');
			const before = await beginSettingsChange(db, id);
			const { rows } = await db.query<{ settings: unknown }>('SELECT settings FROM project WHERE id = $1', [id]);
			const stored = rows[0]?.settings;
			const current = mergeSettings(stored);
			const others = ((current as { gr4jPrior?: PriorStartRecord[] | null }).gr4jPrior ?? []).filter((r) => (r?.provenance?.target?.zoneNodeId ?? null) !== zone);
			let patch: Record<string, unknown>;
			if (zone === null) patch = { gr4j: { ...current.gr4j, ...params } };
			else {
				const zones = (current.calibrationZones ?? []) as CalibrationZone[];
				if (!zones.some((z) => z.nodeId === zone)) throw new ApiError(400, 'That gauge is not a calibration zone of the project.');
				patch = { calibrationZones: zones.map((z) => (z.nodeId === zone ? { ...z, gr4j: { ...params } } : z)) };
			}
			patch.gr4jPrior = [...others, record];
			await db.query('UPDATE project SET settings = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(patchSettings(stored, patch))]);
			const n = p.provenance!.donors.length;
			const where = zone === null ? 'GR4J’s parameters' : 'the calibration zone’s GR4J parameters';
			const reason =
				`${where} started from the regional prior: X1 ${fmt(params.x1)} mm, X3 ${fmt(params.x3)} mm, X4 ${fmt(params.x4)} days, the medians of ${n} donor basin${n === 1 ? '' : 's'} ` +
				`of donor set “${p.provenance!.dataset}” (${p.provenance!.datasetVersion}, SHA-256 ${p.provenance!.donorSetSha256.slice(0, 12)}…)${p.provenance!.x1From === 'soil' ? ', X1 from the soil water capacity relation' : ''}; not calibrated.`;
			const revision = await recordModelRevision(db, id, { source: 'settings_patch', before, reason: reason.slice(0, 500) });
			return { params, record, revisionId: revision?.id ?? null };
		});
		return c.json(out);
	});
