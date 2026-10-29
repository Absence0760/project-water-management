// The Scenarios tab's future climate (issue #621 slice 5, 282_climate_factors;
// docs/api.md § Future climate, docs/scenarios.md § Future climate): the
// monthly change factors over a project's catchment, worked out by a
// `climate_factors` job from the copy, stored, and read back by the picker,
// which adds one case's factors to a scenario as a `climate.delta` op.
import type { FutureFactorTable } from '@water-management/engine';
import { z } from 'zod';
import type { Db } from '../db/tx.js';
import { JOB_META, type JobMeta } from '../jobs/queue.js';
import { catchmentBoundary } from './store.js';

/** Factor tables kept per project; the job deletes older ones. */
export const CLIMATE_FACTORS_KEPT = 3;

/** Nothing to say: the job reads the project's boundary and every model the copy holds. */
export const ClimateFactorsPayload = z.object({}).strict();
/** One pending table per project (job_dedupe_idx). */
export const CLIMATE_FACTORS_DEDUPE_KEY = 'climate_factors';

export interface ClimateFactorsRow {
	id: string;
	jobId: string | null;
	factors: FutureFactorTable;
	warnings: string[];
	boundarySha256: string;
	createdBy: string | null;
	createdAt: string;
}

/** The project's newest factor table, under the reader's RLS; null when none. */
export async function latestClimateFactors(db: Db, projectId: string): Promise<ClimateFactorsRow | null> {
	const { rows } = await db.query<Omit<ClimateFactorsRow, 'createdAt'> & { createdAt: Date }>(
		`SELECT f.id, f.job_id AS "jobId", f.factors, f.warnings, f.boundary_sha256 AS "boundarySha256", u.display_name AS "createdBy", f.created_at AS "createdAt"
		 FROM climate_factors f LEFT JOIN app_user u ON u.id = f.created_by
		 WHERE f.project_id = $1 ORDER BY f.created_at DESC, f.id DESC LIMIT 1`,
		[projectId]
	);
	const r = rows[0];
	return r ? { ...r, createdAt: r.createdAt.toISOString() } : null;
}

/** The newest job of `kind` for the project whose payload has `match` (every key equal), under the reader's RLS; null when none. */
export async function latestJobOf(db: Db, projectId: string, kind: 'climate_factors' | 'future_yield', match: Record<string, string> = {}): Promise<JobMeta | null> {
	const { rows } = await db.query<JobMeta>(
		`SELECT ${JOB_META} FROM job j JOIN app_user u ON u.id = j.acting_user_id
		 WHERE j.project_id = $1 AND j.kind = $2 AND j.payload @> $3::jsonb
		 ORDER BY j.created_at DESC, j.id DESC LIMIT 1`,
		[projectId, kind, JSON.stringify(match)]
	);
	return rows[0] ?? null;
}

/** What the picker reads: the newest table, whether the boundary changed since (or is gone), and the newest job. */
export async function climateFactorsState(db: Db, projectId: string): Promise<{ factors: ClimateFactorsRow | null; boundary: 'same' | 'changed' | 'none'; job: JobMeta | null }> {
	const [factors, b, job] = [await latestClimateFactors(db, projectId), await catchmentBoundary(db, projectId), await latestJobOf(db, projectId, 'climate_factors')];
	const boundary = !b ? 'none' : factors && factors.boundarySha256 !== b.sha256 ? 'changed' : 'same';
	return { factors, boundary, job };
}
