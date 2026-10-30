// Calibration locations (engine 1.110.0, issue #659, docs/model.md §2.10n,
// docs/api.md § Projects): every gauge inside the network with a record of
// its own (a row of settings.calibrationZones) and the outlet (the top-level
// calibration settings, ticked by settings.calibrateAtOutlet) is a
// calibration location, and none is special. settings.calibrationSiteNodeId
// is the optional headline pointer; settings.unitParamsFrom gives a land unit
// another location's parameters.
//
// A save is checked here against the stored network and records:
// - each row new to the list must be a gauge inside the network with an
//   observed flow record attached to it (time_series.site_node_id,
//   084_gauge_records.sql), as the calibration site had to be since 1.41.0;
// - the locations as a whole (engine calibrationLocationsError): no gauge
//   twice, every ticked row a usable gauge (anywhere on the network: the "at
//   or below the site" refusal of #555 is gone), and a headline pointer that
//   is a ticked location (or the outlet's node with the outlet ticked);
// - settings.unitParamsFrom (engine unitParamsFromError): each key a land
//   unit of the project, each value a gauge with a row or the outlet node.
//   A borrowing cycle is not refused on save (a run doesn't care); the fit
//   and the Calibration page refuse it (engine locationFitPlan).
// A stored row or pointer whose gauge is later deleted blocks no save that
// leaves it alone: the run warns about it.
//
// Settings from before 1.110.0 (no boolean calibrateAtOutlet: an imported
// file, a restored run or revision) are stored in the locations' shape
// (locatedSettings), as 289_calibration_locations.sql moved the stored rows.
import {
	CALIBRATION_FLOW_KINDS,
	calibrationLocationsError,
	normalizeCalibrationLocations,
	unitParamsFromError,
	type ModelInput,
	type NetworkNode
} from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The nodes the location checks read. */
export type LocationNode = Pick<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId' | 'areaKm2'>;

/** The project's nodes, as the location checks read them. */
export async function locationNodes(db: Db, projectId: string): Promise<LocationNode[]> {
	const { rows } = await db.query<{ id: string; name: string; kind: NetworkNode['kind']; downstream_node_id: string | null; area_km2: number }>(
		'SELECT id, name, kind, downstream_node_id, area_km2 FROM node WHERE project_id = $1',
		[projectId]
	);
	return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, downstreamNodeId: r.downstream_node_id, areaKm2: r.area_km2 }));
}

/** Whether the project has an outlet record: a flow record with no site (084), what the outlet's location fits on. */
export async function hasOutletRecord(db: Db, projectId: string): Promise<boolean> {
	const { rows } = await db.query<{ has: boolean }>(
		'SELECT EXISTS (SELECT 1 FROM time_series WHERE project_id = $1 AND site_node_id IS NULL AND kind = ANY($2::text[])) AS has',
		[projectId, [...CALIBRATION_FLOW_KINDS]]
	);
	return rows[0]!.has;
}

/**
 * Settings in the calibration locations' shape: the engine's
 * normalizeCalibrationLocations, which 289_calibration_locations.sql does to
 * the stored rows (migration-289.db.test.ts holds the two to each other),
 * plus what only the API stores: a regional-prior start record whose target
 * was the legacy site's zone (zoneNodeId null) names that gauge. Settings
 * that have a boolean calibrateAtOutlet, and non-objects, come back as they
 * are. `hasOutletRecord` is the project's (hasOutletRecord), so an outlet
 * with no record isn't ticked.
 */
export function locatedSettings<T>(raw: T, nodes: readonly LocationNode[], outletRecord: boolean): T {
	if (!isObj(raw) || typeof raw.calibrateAtOutlet === 'boolean') return raw;
	const out = { ...(normalizeCalibrationLocations(raw as ModelInput['settings'], nodes, outletRecord) as Json) };
	const g = out.calibrateAtOutlet === false && typeof out.calibrationSiteNodeId === 'string' ? out.calibrationSiteNodeId : null;
	if (g !== null && Array.isArray(out.gr4jPrior)) {
		out.gr4jPrior = out.gr4jPrior.map((r: unknown) => {
			if (!isObj(r) || !isObj(r.provenance) || !isObj(r.provenance.target) || (r.provenance.target.zoneNodeId ?? null) !== null) return r;
			return { ...r, provenance: { ...r.provenance, target: { ...r.provenance.target, zoneNodeId: g } } };
		});
	}
	return out as T;
}

/**
 * Why a gauge can't be given a row (a calibration location of its own), as
 * an ApiError: not a node of the project, the outlet or not a gauge, or no
 * observed flow record attached.
 */
export async function checkCalibrationSite(db: Db, projectId: string, siteNodeId: string, field = 'calibrationZones'): Promise<void> {
	const { rows } = await db.query<{ kind: string; downstream_node_id: string | null; records: number }>(
		`SELECT n.kind, n.downstream_node_id,
			(SELECT count(*)::int FROM time_series t WHERE t.project_id = n.project_id AND t.site_node_id = n.id AND t.kind = ANY($3::text[])) AS records
		 FROM node n WHERE n.project_id = $1 AND n.id = $2`,
		[projectId, siteNodeId, [...CALIBRATION_FLOW_KINDS]]
	);
	const n = rows[0];
	if (!n) throw new ApiError(400, `${field}: no such hydrological unit in this project`);
	if (n.kind !== 'gauge' || n.downstream_node_id === null)
		throw new ApiError(400, `${field}: a calibration location’s row is a gauge above the outlet (the outlet’s location is calibrateAtOutlet)`);
	if (n.records === 0) throw new ApiError(400, `${field}: that gauge has no observed flow record attached`);
}

const nodeIdsOf = (list: unknown): Set<string> =>
	new Set(Array.isArray(list) ? list.flatMap((z) => (isObj(z) && typeof z.nodeId === 'string' ? [z.nodeId] : [])) : []);

/** The keys of a settings patch the location checks read. */
export interface LocationPatch {
	calibrationZones?: unknown;
	calibrationSiteNodeId?: unknown;
	calibrateAtOutlet?: unknown;
	unitParamsFrom?: unknown;
}

/**
 * The calibration locations a save would store (`settings`, the patch over
 * `stored`), checked when the patch touches them: each row new to the list as
 * checkCalibrationSite, then the locations (calibrationLocationsError) and
 * the units' parameter sources (unitParamsFromError) against the network.
 * A row whose gauge is gone, and a stored headline pointer whose gauge is
 * gone, are left to the run to warn about.
 */
export async function checkCalibrationLocations(
	db: Db,
	projectId: string,
	patch: LocationPatch,
	settings: { calibrationZones?: { nodeId: string; enabled: boolean }[] | null; calibrationSiteNodeId?: string | null; calibrateAtOutlet?: boolean; unitParamsFrom?: Record<string, string> | null },
	stored: unknown
): Promise<void> {
	const touches = patch.calibrationZones !== undefined || patch.calibrationSiteNodeId !== undefined || patch.calibrateAtOutlet !== undefined;
	if (!touches && patch.unitParamsFrom === undefined) return;
	const was = isObj(stored) ? stored : {};
	const zones = settings.calibrationZones ?? [];
	if (patch.calibrationZones !== undefined) {
		const before = nodeIdsOf(was.calibrationZones);
		for (const z of zones) if (!before.has(z.nodeId)) await checkCalibrationSite(db, projectId, z.nodeId);
	}
	const nodes = await locationNodes(db, projectId);
	const ids = new Set(nodes.map((n) => n.id));
	if (touches) {
		const pointer = settings.calibrationSiteNodeId ?? null;
		// A stored pointer whose gauge has since been deleted doesn't block a save that leaves it as it was.
		const stalePointer = pointer !== null && !ids.has(pointer) && pointer === was.calibrationSiteNodeId;
		const err = calibrationLocationsError(nodes, {
			calibrationZones: zones.filter((z) => ids.has(z.nodeId)) as never,
			calibrationSiteNodeId: stalePointer ? null : pointer,
			calibrateAtOutlet: settings.calibrateAtOutlet
		});
		if (err) throw new ApiError(400, err.startsWith('headline') ? `calibrationSiteNodeId: ${err}` : `calibrationZones: ${err}`);
	}
	if (patch.unitParamsFrom !== undefined) {
		const err = unitParamsFromError(nodes, { calibrationZones: zones as never, unitParamsFrom: settings.unitParamsFrom ?? null });
		if (err) throw new ApiError(400, `unitParamsFrom: ${err}`);
	}
}
