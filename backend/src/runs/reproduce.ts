// "Check reproduction" (roadmap WP-3.1): re-run a stored run from its stored
// inputs (loadRunInput, 021_series_blob.sql) with the engine the server has
// now, and say whether the summary and every daily output come out the same.
// docs/api.md § Runs, docs/data-model.md § Stored run inputs.
import { canonicalJson, ENGINE_VERSION, fromEpochDay, runModelChecked, toEpochDay, type ModelInput, type ModelOutput } from '@water-management/engine';
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { loadRunInput, RunInputError } from './execute.js';

/** Most differences listed; the rest are counted in `truncated`. */
export const REPRODUCE_DIFFERENCES_MAX = 50;

/** One way a reproduction differs from the stored run. */
export type ReproductionDifference =
	/** A value in the run summary: `path` like `farms[2].deficitDays` or `ewrAssurance`. */
	| { kind: 'summary'; path: string }
	/** A daily output whose values differ: on how many days, the first, and the largest difference. */
	| { kind: 'series'; key: string; nodeId: string | null; label: string; days: number; firstDate: string; maxAbsDiff: number | null }
	/** A daily output the stored run has and the reproduction doesn't, or the other way round. */
	| { kind: 'series_missing' | 'series_extra'; key: string; nodeId: string | null; label: string };

export type ReproductionStatus =
	/** Same summary and every daily output, value for value. */
	| 'identical'
	| 'differs'
	/** Saved before runs stored their input series (021): only hashes were kept. */
	| 'not_reproducible'
	/** A stored input fails its check against the run's own record: never presented as the run. */
	| 'inconsistent'
	/** Today's engine refuses the stored input (a rule added since): `message` says why. */
	| 'failed';

export interface Reproduction {
	status: ReproductionStatus;
	identical: boolean;
	engineVersionThen: string;
	engineVersionNow: string;
	differences: ReproductionDifference[];
	/** Differences beyond REPRODUCE_DIFFERENCES_MAX, not listed. */
	truncated: number;
	/** Why, for not_reproducible, inconsistent and failed. */
	message?: string;
}

/** A stored daily output (run_series), as the database hands it back. */
export interface StoredSeries {
	nodeId: string | null;
	key: string;
	label: string | null;
	values: (number | null)[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The paths where two JSON values differ, depth first, as run summaries are
 * stored (so NaN and undefined have already become null or gone). Arrays of
 * the same length are compared element by element; anything else that isn't
 * equal is one difference at its own path.
 */
export function jsonDifferences(a: unknown, b: unknown, path = '', out: string[] = []): string[] {
	if (isObject(a) && isObject(b)) {
		for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) jsonDifferences(a[k], b[k], path ? `${path}.${k}` : k, out);
		return out;
	}
	if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
		a.forEach((x, i) => jsonDifferences(x, b[i], `${path}[${i}]`, out));
		return out;
	}
	const same = a === undefined || b === undefined ? a === b : canonicalJson(a) === canonicalJson(b);
	if (!same) out.push(path || '(summary)');
	return out;
}

/**
 * Compare a reproduction's output with the stored run: the summary (as JSON
 * storage normalises it) and each daily output (non-finite stored as null,
 * as storeRun writes them). Pure, so it is unit-tested without a database.
 */
export function reproductionDifferences(
	stored: { summary: unknown; startDate: string; series: readonly StoredSeries[] },
	again: Pick<ModelOutput, 'summary' | 'series'>
): { differences: ReproductionDifference[]; total: number } {
	const all: ReproductionDifference[] = jsonDifferences(stored.summary, JSON.parse(JSON.stringify(again.summary))).map((path) => ({ kind: 'summary', path }));
	const id = (nodeId: string | null, key: string) => `${nodeId ?? ''}|${key}`;
	const fresh = new Map(again.series.map((s) => [id(s.nodeId, s.key), s]));
	const start = toEpochDay(stored.startDate);
	for (const s of stored.series) {
		const label = s.label ?? s.key;
		const now = fresh.get(id(s.nodeId, s.key));
		fresh.delete(id(s.nodeId, s.key));
		if (!now) {
			all.push({ kind: 'series_missing', key: s.key, nodeId: s.nodeId, label });
			continue;
		}
		const values = now.values.map((v) => (Number.isFinite(v) ? v : null));
		let days = Math.abs(values.length - s.values.length);
		let first = days ? Math.min(values.length, s.values.length) : -1;
		let maxAbsDiff: number | null = null;
		for (let i = 0; i < Math.min(values.length, s.values.length); i++) {
			const x = s.values[i]!;
			const y = values[i]!;
			if (x === y) continue;
			days++;
			if (first < 0 || i < first) first = i;
			if (x !== null && y !== null) maxAbsDiff = Math.max(maxAbsDiff ?? 0, Math.abs(x - y));
		}
		if (days) all.push({ kind: 'series', key: s.key, nodeId: s.nodeId, label, days, firstDate: fromEpochDay(start + first), maxAbsDiff });
	}
	for (const s of fresh.values()) all.push({ kind: 'series_extra', key: s.key, nodeId: s.nodeId, label: s.label });
	return { differences: all.slice(0, REPRODUCE_DIFFERENCES_MAX), total: all.length };
}

/** What a reproduction needs from the database (loadReproduction): the stored run, its input and its daily outputs. */
interface StoredForReproduction {
	base: Omit<Reproduction, 'status' | 'message'>;
	summary: unknown;
	startDate: string;
	input: ModelInput;
	series: StoredSeries[];
}

/**
 * Read what re-running `runId` needs, under the caller's RLS: the stored run,
 * its input (loadRunInput) and its daily outputs. A finished Reproduction
 * when the input can't be rebuilt, else what reproduceStored needs.
 */
export async function loadReproduction(db: Db, projectId: string, runId: string): Promise<Reproduction | StoredForReproduction> {
	const { rows } = await db.query<{ engineVersion: string; startDate: string; summary: unknown }>(
		'SELECT engine_version AS "engineVersion", start_date AS "startDate", summary FROM model_run WHERE project_id = $1 AND id = $2',
		[projectId, runId]
	);
	const run = rows[0];
	if (!run) throw new ApiError(404, 'not found');
	const base = { engineVersionThen: run.engineVersion, engineVersionNow: ENGINE_VERSION, differences: [], truncated: 0, identical: false };
	let input;
	try {
		input = await loadRunInput(db, runId);
	} catch (err) {
		if (!(err instanceof RunInputError)) throw err;
		if (err.problem === 'not_found') throw new ApiError(404, 'not found');
		return { ...base, status: err.problem, message: err.message };
	}
	const { rows: series } = await db.query<StoredSeries>(
		`SELECT node_id AS "nodeId", key, meta->>'label' AS label, "values" FROM run_series WHERE run_id = $1`,
		[runId]
	);
	return { base, summary: run.summary, startDate: run.startDate, input, series };
}

/** Re-run a stored run with today's engine and compare. No database: the route calls it with no transaction open. */
export function reproduceStored(stored: StoredForReproduction): Reproduction {
	const { base, input } = stored;
	let again: ModelOutput;
	try {
		again = runModelChecked(input);
	} catch (err) {
		return { ...base, status: 'failed', message: `the current engine refuses this run's stored input: ${err instanceof Error ? err.message : String(err)}` };
	}
	const { differences, total } = reproductionDifferences(stored, again);
	return { ...base, status: total ? 'differs' : 'identical', identical: total === 0, differences, truncated: total - differences.length };
}

// The run is read in one transaction and re-run with none open, so a long
// run holds no pooled connection (docs/architecture.md § A model run).
export const reproduceRoutes = new Hono<AuthEnv>().get('/:id/runs/:runId/reproduce', async (c) => {
	const { id, runId } = c.req.param();
	const stored = await withUser(
		c.get('userId'),
		async (db) => {
			await requireRole(db, id, 'viewer');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			return loadReproduction(db, id, runId);
		},
		{ readOnly: true }
	);
	return c.json('status' in stored ? stored : reproduceStored(stored));
});
