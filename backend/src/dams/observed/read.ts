// Reading a project's dam observations and the run to compare them with
// (issue #604 R5-B; docs/api.md § Dams seen from space). Every query runs in
// the caller's withUser transaction, so RLS decides what is read: the
// observation and match tables (257) let a project's viewers read them, and a
// farmer only their own farm's dams.
import type { Db } from '../../db/tx.js';
import { DEAFRICA_ATTRIBUTION } from './upstream.js';
import { compareDam, fullAreaOf, type CompareResult, type DamNodeIn, type FullArea, type MatchStatus, type ObservationIn } from './compare.js';

/** The credit every view of the observations carries (CC BY 4.0 asks for it where the values show). */
export const OBSERVED_ATTRIBUTION = DEAFRICA_ATTRIBUTION;

/** A dam polygon on the map and how it matched a Waterbodies polygon. */
export interface ObservedFeature {
	id: string;
	name: string;
	nodeId: string | null;
	/** null when the matcher hasn't looked at it yet. */
	match: { status: MatchStatus; damShare: number | null; waterbodyShare: number | null } | null;
}

/** The project's dam polygons (points have no outline to see), with their Waterbodies match; only `nodeId`'s when given. */
export async function observedFeatures(db: Db, projectId: string, nodeId?: string): Promise<ObservedFeature[]> {
	const { rows } = await db.query<{ id: string; name: string; node_id: string | null; status: MatchStatus | null; dam_share: number | null; waterbody_share: number | null }>(
		`SELECT f.id, f.name, f.node_id, m.status, m.dam_share, m.waterbody_share
		 FROM map_feature f
		 LEFT JOIN dam_waterbody_match m ON m.feature_id = f.id AND m.project_id = f.project_id
		 WHERE f.project_id = $1 AND f.kind = 'dam' AND f.geometry->>'type' IN ('Polygon', 'MultiPolygon')
			AND ($2::uuid IS NULL OR f.node_id = $2::uuid)
		 ORDER BY f.name, f.id`,
		[projectId, nodeId ?? null]
	);
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		nodeId: r.node_id,
		match: r.status ? { status: r.status, damShare: r.dam_share, waterbodyShare: r.waterbody_share } : null
	}));
}

/** Every observation of these polygons, oldest first. */
export async function observationsOf(db: Db, projectId: string, featureIds: readonly string[]): Promise<ObservationIn[]> {
	if (!featureIds.length) return [];
	const { rows } = await db.query<ObservationIn>(
		`SELECT feature_id AS "featureId", source, obs_date::text AS date, wet_area_m2 AS "wetAreaM2", pct_observed AS "pctObserved"
		 FROM dam_observation WHERE project_id = $1 AND feature_id = ANY($2::uuid[])
		 ORDER BY obs_date, source, feature_id`,
		[projectId, featureIds]
	);
	return rows;
}

/** The run the observations are compared with, and the dam nodes and dam_area series it stored for the units asked about. */
export interface CompareRun {
	id: string;
	label: string;
	createdAt: string;
	engineVersion: string;
	startDate: string;
	forecastFrom: string | null;
	nodes: Map<string, DamNodeIn & { name?: string }>;
	damArea: Map<string, (number | null)[]>;
}

/**
 * The run: `runId` when given (null when it isn't this project's), else the
 * project's newest by created_at, the run the Dams tab shows
 * (overview/latestRun.ts pickRuns). Its model's nodes and its dam_area series
 * only for `nodeIds`.
 */
export async function compareRun(db: Db, projectId: string, runId: string | null, nodeIds: readonly string[]): Promise<CompareRun | null> {
	const { rows } = await db.query<{
		id: string;
		label: string;
		created_at: Date;
		engine_version: string;
		start_date: string;
		forecast_from: string | null;
		nodes: (DamNodeIn & { id: string; name?: string })[] | null;
	}>(
		`SELECT r.id, r.label, r.created_at, r.engine_version, r.start_date::text AS start_date, r.summary->'forecast'->>'from' AS forecast_from,
			(SELECT jsonb_agg(n) FROM jsonb_array_elements(COALESCE(r.inputs->'model'->'nodes', '[]'::jsonb)) n WHERE n->>'id' = ANY($3::text[])) AS nodes
		 FROM model_run r WHERE r.project_id = $1 AND ($2::uuid IS NULL OR r.id = $2::uuid)
		 ORDER BY r.created_at DESC, r.id LIMIT 1`,
		[projectId, runId, nodeIds]
	);
	const r = rows[0];
	if (!r) return null;
	const { rows: series } = nodeIds.length
		? await db.query<{ node_id: string; values: (number | null)[] }>(
				`SELECT node_id, "values" FROM run_series WHERE run_id = $1 AND key = 'dam_area' AND node_id = ANY($2::uuid[])`,
				[r.id, nodeIds]
			)
		: { rows: [] };
	return {
		id: r.id,
		label: r.label,
		createdAt: r.created_at.toISOString(),
		engineVersion: r.engine_version,
		startDate: r.start_date,
		forecastFrom: r.forecast_from,
		nodes: new Map((r.nodes ?? []).map((n) => [n.id, n])),
		damArea: new Map(series.map((s) => [s.node_id, s.values]))
	};
}

/** One unit's dam (or one polygon linked to no unit), compared. */
export interface ObservedDam {
	/** The unit the polygons stand for; null for a polygon linked to none (listed, never compared). */
	nodeId: string | null;
	features: ObservedFeature[];
	/** The full-supply area the run used; null with no run, no dam in it, or no unit. */
	fullArea: FullArea | null;
	/** Whether the run stored a dam_area for the unit. */
	inRun: boolean;
	points: CompareResult['points'];
	summary: CompareResult['summary'];
}

/**
 * Group the polygons by unit and compare each unit's with the run. A polygon
 * linked to no unit is its own entry, never compared (nothing models it).
 */
export function compareAll(features: readonly ObservedFeature[], observations: readonly ObservationIn[], run: CompareRun | null): ObservedDam[] {
	const groups = new Map<string, ObservedFeature[]>();
	for (const f of features) {
		const k = f.nodeId ?? `feature:${f.id}`;
		const g = groups.get(k);
		if (g) g.push(f);
		else groups.set(k, [f]);
	}
	const out: ObservedDam[] = [];
	for (const fs of groups.values()) {
		const nodeId = fs[0]!.nodeId;
		const values = nodeId ? run?.damArea.get(nodeId) : undefined;
		const full = nodeId && run && values ? fullAreaOf(run.nodes.get(nodeId), run.engineVersion) : null;
		const r = compareDam({
			features: fs.map((f) => ({ id: f.id, match: f.match?.status ?? null })),
			observations,
			modelled: values && full ? { startDate: run!.startDate, values } : null,
			forecastFrom: run?.forecastFrom ?? null,
			full
		});
		out.push({ nodeId, features: fs, fullArea: full, inRun: !!values, points: r.points, summary: r.summary });
	}
	return out;
}
