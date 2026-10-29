// Reading a unit's observed actual ET and the run to compare it with (issue
// #623 step 5; docs/api.md § Observed actual ET). Every query runs in the
// caller's withUser transaction, so RLS decides what is read: et_observation
// (276) lets a project's viewers read it, and a farmer only their own units'.
import type { Db } from '../../db/tx.js';
import type { EtObservationIn, EtSource, ModelledIn } from './compare.js';
import { SSEBOP_ATTRIBUTION, WAPOR_ATTRIBUTION } from './upstream.js';

/** The credit each source's values carry wherever they show (WaPOR: CC BY 4.0 asks for it). */
export const ET_ATTRIBUTION: Record<EtSource, string> = { wapor: WAPOR_ATTRIBUTION, ssebop: SSEBOP_ATTRIBUTION };

/** Every observation of the unit, oldest first. */
export async function etObservationsOf(db: Db, projectId: string, nodeId: string): Promise<EtObservationIn[]> {
	const { rows } = await db.query<EtObservationIn>(
		`SELECT source, dekad::text AS dekad, eta_mm_day AS "etaMmDay", valid_share AS "validShare", area_m2 AS "areaM2", mask
		 FROM et_observation WHERE project_id = $1 AND node_id = $2
		 ORDER BY dekad, source`,
		[projectId, nodeId]
	);
	return rows;
}

/** The series the comparison reads (./compare.ts). */
const KEYS = ['gross_demand', 'effective_rain', 'crop_requirement', 'demand', 'supplied'] as const;

/** The run the observations are compared with, and the unit's series and planted area in it. */
export interface EtCompareRun {
	id: string;
	label: string;
	createdAt: string;
	engineVersion: string;
	forecastFrom: string | null;
	/** Whether the run's model has the unit. */
	hasUnit: boolean;
	/** Σ the unit's planted areas in the run's model snapshot (m²), crops the model has only. */
	plantedAreaM2: number;
	/** The unit's series, or null when the run has none for it (not a unit then, or an older engine). */
	modelled: ModelledIn | null;
}

/**
 * The run: `runId` when given (null when it isn't this project's), else the
 * project's newest by created_at, as the Dams tab's comparison picks
 * (dams/observed/read.ts compareRun). Only the unit's series are read.
 */
export async function etCompareRun(db: Db, projectId: string, runId: string | null, nodeId: string): Promise<EtCompareRun | null> {
	const { rows } = await db.query<{
		id: string;
		label: string;
		created_at: Date;
		engine_version: string;
		start_date: string;
		forecast_from: string | null;
		planted: number | null;
		has_unit: boolean;
	}>(
		`SELECT r.id, r.label, r.created_at, r.engine_version, r.start_date::text AS start_date, r.summary->'forecast'->>'from' AS forecast_from,
			(SELECT sum((a->>'areaM2')::float8) FROM jsonb_array_elements(COALESCE(r.inputs->'model'->'cropAreas', '[]'::jsonb)) a
			 WHERE a->>'nodeId' = $3::text AND jsonb_typeof(a->'areaM2') = 'number'
				-- A row naming a crop the model lacks is skipped by the engine (buildDemand), so its area is no demand's.
				AND a->>'cropId' IN (SELECT c->>'id' FROM jsonb_array_elements(COALESCE(r.inputs->'model'->'crops', '[]'::jsonb)) c)) AS planted,
			EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(r.inputs->'model'->'nodes', '[]'::jsonb)) n WHERE n->>'id' = $3::text) AS has_unit
		 FROM model_run r WHERE r.project_id = $1 AND ($2::uuid IS NULL OR r.id = $2::uuid)
		 ORDER BY r.created_at DESC, r.id LIMIT 1`,
		[projectId, runId, nodeId]
	);
	const r = rows[0];
	if (!r) return null;
	const { rows: series } = await db.query<{ key: string; values: (number | null)[] }>(
		`SELECT key, "values" FROM run_series
		 WHERE run_id = $1 AND node_id = $2 AND (key = ANY($3::text[]) OR key LIKE 'object\\_demand@%' OR key LIKE 'object\\_supplied@%')`,
		[r.id, nodeId, KEYS]
	);
	const byKey = new Map(series.map((s) => [s.key, s.values]));
	const objects = (prefix: string) => {
		const list = series.filter((s) => s.key.startsWith(prefix)).map((s) => s.values);
		if (!list.length) return undefined;
		// A missing day in any object is a missing day of the sum (compare.ts treats it as a partial dekad).
		return list[0]!.map((_, i) => list.reduce<number | null>((s, v) => (s === null || typeof v[i] !== 'number' ? null : s + (v[i] as number)), 0));
	};
	const have = KEYS.every((k) => byKey.has(k));
	return {
		id: r.id,
		label: r.label,
		createdAt: r.created_at.toISOString(),
		engineVersion: r.engine_version,
		forecastFrom: r.forecast_from,
		hasUnit: r.has_unit,
		plantedAreaM2: r.planted ?? 0,
		modelled: have
			? {
					startDate: r.start_date,
					grossDemand: byKey.get('gross_demand')!,
					effectiveRain: byKey.get('effective_rain')!,
					cropRequirement: byKey.get('crop_requirement')!,
					demand: byKey.get('demand')!,
					supplied: byKey.get('supplied')!,
					objectDemand: objects('object_demand@'),
					objectSupplied: objects('object_supplied@')
				}
			: null
	};
}
