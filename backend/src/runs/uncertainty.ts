// Uncertainty bands per run (issue #4 phase 9, 014_run_uncertainty.sql,
// docs/api.md § Uncertainty bands, docs/security.md § Authorization).
//
// The ensemble is heavy (hundreds of model runs), so the browser runs it in
// the calibration worker. The server makes it un-cherry-pickable and checks
// it instead:
//   1. POST …/uncertainty resolves the options against the run's own inputs
//      and inserts a started row; the database draws the seed.
//   2. The browser fetches the run's inputs (…/model-input), runs exactly
//      those options with that seed, and posts the members.
//   3. POST …/uncertainty/:uid/result regenerates the whole sample, re-runs
//      member 0 and three members picked at random, and only then summarises
//      the bands itself and completes the row, once.
import { randomInt } from 'node:crypto';
import {
	ENGINE_VERSION,
	ENSEMBLE_MEMBERS_MAX,
	OBJECTIVES,
	pairedMembers,
	pairedRefusal,
	resolveEnsembleOptions,
	summariseEnsemble,
	summarisePaired,
	verifyEnsemble,
	verifyPaired,
	type EnsembleHeader,
	type MemberResult,
	type ModelInput,
	type PairedMember,
	type RecordCoverage,
	type ResolvedEnsembleOptions,
	type RunInputsSnapshot,
	withoutForecastTail
} from '@water-management/engine';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthEnv } from '../auth/middleware.js';
import { type Db, withUser } from '../db/tx.js';
import { readJson } from '../http/body.js';
import { ApiError } from '../http/errors.js';
import { requireRole, UUID } from '../projects/access.js';
import { loadModelInput, loadRunInput, RunInputError, seriesHash } from './execute.js';

/** Random members the server re-runs besides member 0 (docs/security.md § Authorization). */
export const CHECKED_MEMBERS = 3;

/**
 * The exact input a run used. A run saved since 021_series_blob stored its
 * input series, so it is rebuilt from them (loadRunInput) whatever has
 * happened to the project's data since. An older run kept only hashes: its
 * settings and model snapshot are used with the project's series, which must
 * still hash to the snapshot's, else 409.
 */
export async function runModelInput(db: Db, projectId: string, runId: string): Promise<ModelInput> {
	if (!UUID.test(runId)) throw new ApiError(404, 'not found');
	const { rows } = await db.query<{ inputs: RunInputsSnapshot & { settings: ModelInput['settings']; model: ModelInput['model'] }; trigger: string }>(
		'SELECT inputs, "trigger" FROM model_run WHERE project_id = $1 AND id = $2',
		[projectId, runId]
	);
	const snap = rows[0]?.inputs;
	if (!snap) throw new ApiError(404, 'not found');
	try {
		const input = await loadRunInput(db, runId);
		// A forecast run (WP-2.12) stores its input with the forecast tail; its figures, and so its bands, are the history's.
		return rows[0]!.trigger === 'forecast' ? withoutForecastTail(input) : input;
	} catch (err) {
		if (!(err instanceof RunInputError) || err.problem !== 'not_reproducible') throw err;
	}
	const current = await loadModelInput(db, projectId);
	const kinds = new Set([...Object.keys(snap.series ?? {}), ...Object.keys(current.series)]);
	const changed = [...kinds].filter((k) => {
		const a = snap.series?.[k] as { startDate: string; length: number; valuesSha256?: string } | undefined;
		const b = current.series[k as keyof ModelInput['series']];
		return !a || !b || a.startDate !== b.startDate || a.length !== b.values.length || a.valuesSha256 !== seriesHash(b.values);
	});
	if (changed.length) {
		throw new ApiError(
			409,
			`the project's data changed since this run (${changed.sort().join(', ')}); run the model again to get bands for the current data`
		);
	}
	return { settings: snap.settings, model: snap.model, series: current.series };
}

const RAIN = z.enum(['recorded', 'chirps']);
const RECORD = z.enum(['flow_observed_m3s', 'flow_logger_m3s']);
const LEVEL = z.enum(['ok', 'note', 'query', 'unusable']);

/** What an editor may choose; everything else is resolved against the run (the model is the run's own). */
const StartBody = z.union([
	z.object({ baselineId: z.string().uuid() }).strict(),
	z
		.object({
			request: z
				.object({
					members: z.number().int().optional(),
					bounds: z.enum(['wide', 'typical']).optional(),
					free: z.array(z.string().max(40)).max(10).optional(),
					panOffset: z.number().optional(),
					rainSources: z.array(RAIN).max(2).optional(),
					records: z.array(RECORD).max(2).optional(),
					thresholds: z
						.object({
							objective: z.enum(OBJECTIVES).optional(),
							minSkill: z.number().optional(),
							wr2012MaxLevel: LEVEL.optional(),
							maxLowFlowBiasPct: z.number().nullable().optional()
						})
						.strict()
						.optional()
				})
				.strict()
		})
		.strict()
]);

const num = z.number().finite();
const MetricsSchema = z
	.object({
		ewrDaysNotMet: num,
		ewrDaysNotMetByMonth: z.array(num).length(12),
		shortfallMm3: num,
		marNaturalMm3: num,
		marOutflowMm3: num,
		annualNaturalMm3: z.array(num).max(400),
		annualOutflowMm3: z.array(num).max(400),
		curtailmentM3Day: z.record(z.string().max(80), num),
		reserveRate: z.record(z.string().max(80), num.nullable()),
		fdcM3Day: z.array(z.array(num).max(20)).length(12)
	})
	.strict();

const MemberSchema = z
	.object({
		index: z.number().int().min(0),
		reference: z.boolean(),
		params: z.record(z.string().max(40), num),
		panOffset: num,
		rain: RAIN,
		record: RECORD,
		scores: z
			.object({
				skill: num.nullable(),
				lowFlowBiasPct: num.nullable(),
				wr2012Level: LEVEL.nullable(),
				wr2012MarMm3: num.nullable(),
				wr2012InBand: z.boolean().nullable()
			})
			.strict(),
		accepted: z.boolean(),
		rejected: z.array(z.enum(['skill', 'wr2012', 'lowFlow'])).max(3),
		metrics: MetricsSchema.nullable()
	})
	.strict();

const CoverageSchema = z
	.object({
		record: RECORD,
		heldOutDays: z.number().int().min(0),
		inside: z.number().int().min(0).nullable(),
		fraction: num.nullable(),
		warning: z.boolean()
	})
	.strict();

const EnsembleResultBody = z
	.object({
		members: z.array(MemberSchema).max(ENSEMBLE_MEMBERS_MAX + 1),
		coverage: z.array(CoverageSchema).max(2)
	})
	.strict();

const PairedResultBody = z
	.object({ members: z.array(z.object({ index: z.number().int().min(0), metrics: MetricsSchema }).strict()).max(ENSEMBLE_MEMBERS_MAX + 1) })
	.strict();

interface Row {
	id: string;
	runId: string;
	baselineId: string | null;
	baselineRunId: string | null;
	runoffModel: string;
	engineVersion: string;
	method: string;
	seed: number;
	members: number;
	options: ResolvedEnsembleOptions;
	status: 'started' | 'complete';
	accepted: number | null;
	summary: unknown;
	createdAt: string;
	createdBy: string | null;
	createdById: string;
	completedAt: string | null;
}

const COLUMNS = `u.id, u.run_id AS "runId", u.baseline_id AS "baselineId", b.run_id AS "baselineRunId",
	u.runoff_model AS "runoffModel", u.engine_version AS "engineVersion", u.method, u.seed::int AS seed, u.members,
	u.options, u.status, u.accepted, u.summary, u.created_at AS "createdAt", au.display_name AS "createdBy",
	u.created_by AS "createdById", u.completed_at AS "completedAt"`;
const FROM = `FROM run_uncertainty u JOIN app_user au ON au.id = u.created_by LEFT JOIN run_uncertainty b ON b.id = u.baseline_id`;

async function loadRow(db: Db, projectId: string, runId: string, uid: string, withResult = false) {
	if (!UUID.test(runId) || !UUID.test(uid)) throw new ApiError(404, 'not found');
	const { rows } = await db.query<Row & { result?: unknown }>(
		`SELECT ${COLUMNS}${withResult ? ', u.result' : ''} ${FROM} WHERE u.project_id = $1 AND u.run_id = $2 AND u.id = $3`,
		[projectId, runId, uid]
	);
	if (!rows[0]) throw new ApiError(404, 'not found');
	return rows[0];
}

/** An engine refusal ("the CHIRPS-only rain source is not available: …") is the user's to fix: 400 with its message. */
function engine<T>(f: () => T): T {
	try {
		return f();
	} catch (err) {
		if (err instanceof ApiError) throw err;
		throw new ApiError(400, err instanceof Error ? err.message : String(err));
	}
}

/** The runoff model the run used (absent = legacy, as model_run's other readers). */
const runModelOf = (input: ModelInput) => (input.settings.runoffModel as string | undefined) ?? 'legacy';

export const uncertaintyRoutes = new Hono<AuthEnv>()
	// The run's own input, for running an ensemble in the browser (viewer: a
	// viewer may reproduce a stored ensemble; only an editor can store one).
	.get('/:id/runs/:runId/model-input', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			return c.json({ input: await runModelInput(db, id, runId) });
		});
	})
	.get('/:id/runs/:runId/uncertainty', async (c) => {
		const { id, runId } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			if (!UUID.test(runId)) throw new ApiError(404, 'not found');
			const { rows: run } = await db.query('SELECT 1 FROM model_run WHERE project_id = $1 AND id = $2', [id, runId]);
			if (!run.length) throw new ApiError(404, 'not found');
			const { rows } = await db.query<Row>(`SELECT ${COLUMNS} ${FROM} WHERE u.project_id = $1 AND u.run_id = $2 ORDER BY u.created_at DESC`, [id, runId]);
			return c.json({ ensembles: rows });
		});
	})
	.get('/:id/runs/:runId/uncertainty/:uid', async (c) => {
		const { id, runId, uid } = c.req.param();
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'viewer');
			return c.json({ ensemble: await loadRow(db, id, runId, uid, true) });
		});
	})
	.post('/:id/runs/:runId/uncertainty', async (c) => {
		const { id, runId } = c.req.param();
		const body = StartBody.parse(await readJson(c));
		return withUser(c.get('userId'), async (db) => {
			await requireRole(db, id, 'editor');
			const input = await runModelInput(db, id, runId);
			let options: ResolvedEnsembleOptions;
			let notes: string[] = [];
			let baselineId: string | null = null;
			if ('baselineId' in body) {
				const { rows } = await db.query<{ runId: string; status: string; baselineId: string | null; options: ResolvedEnsembleOptions; result: { header: EnsembleHeader } | null }>(
					`SELECT run_id AS "runId", status, baseline_id AS "baselineId", options, result FROM run_uncertainty WHERE project_id = $1 AND id = $2`,
					[id, body.baselineId]
				);
				const base = rows[0];
				if (!base) throw new ApiError(404, 'baseline ensemble not found');
				if (base.status !== 'complete' || base.baselineId || !base.result) throw new ApiError(400, 'a paired band needs a complete ensemble of the baseline run');
				if (base.runId === runId) throw new ApiError(400, 'a paired band compares two different runs');
				const refusal = engine(() => pairedRefusal(input, { options: base.options, header: base.result!.header }));
				if (refusal) throw new ApiError(400, `no paired band: ${refusal}`);
				options = base.options;
				baselineId = body.baselineId;
			} else {
				// The seed is drawn by the database (run_uncertainty_start); 0 is a placeholder it replaces.
				({ options, notes } = engine(() => resolveEnsembleOptions(input, { ...body.request, model: runModelOf(input) as ResolvedEnsembleOptions['model'], seed: 0 })));
			}
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO run_uncertainty (project_id, run_id, baseline_id, runoff_model, engine_version, method, seed, members, options, created_by)
				 VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, app_current_user_id()) RETURNING id`,
				[id, runId, baselineId, options.model, ENGINE_VERSION, options.method, options.members, JSON.stringify(options)]
			);
			return c.json({ ensemble: await loadRow(db, id, runId, rows[0]!.id), notes }, 201);
		});
	})
	// Verifying re-runs members with the engine: read in one transaction,
	// verify with none open, store in a second, so it holds no pooled
	// connection while the engine runs (docs/architecture.md § A model run).
	.post('/:id/runs/:runId/uncertainty/:uid/result', async (c) => {
		const { id, runId, uid } = c.req.param();
		const raw = await readJson(c);
		const userId = c.get('userId');
		/** Who may store it: an editor, the one who started it, while it is still started on today's engine. Checked in both transactions. */
		const storable = async (db: Db) => {
			await requireRole(db, id, 'editor');
			const row = await loadRow(db, id, runId, uid);
			if (row.status !== 'started') throw new ApiError(409, 'this ensemble is already stored; start a new one to run it again');
			if (row.createdById !== userId) throw new ApiError(403, 'only whoever started an ensemble can store its result');
			if (row.engineVersion !== ENGINE_VERSION) throw new ApiError(409, `this ensemble was started on engine ${row.engineVersion}; start a new one`);
			return row;
		};
		const read = await withUser(
			userId,
			async (db) => {
				const row = await storable(db);
				const input = await runModelInput(db, id, runId);
				if (!row.baselineId) return { row, input, paired: false as const, body: EnsembleResultBody.parse(raw) };
				const body = PairedResultBody.parse(raw);
				const { rows } = await db.query<{ result: { header: EnsembleHeader; members: MemberResult[] } }>('SELECT result FROM run_uncertainty WHERE id = $1', [row.baselineId]);
				return { row, input, paired: true as const, body, base: rows[0]!.result };
			},
			{ readOnly: true }
		);
		const { row, input } = read;
		const random = () => randomInt(0, 2 ** 32) / 2 ** 32;
		let summary: unknown;
		let result: unknown;
		let accepted: number;
		if (read.paired) {
			const { base, body } = read;
			const kept = pairedMembers(base);
			const { mismatches, header } = engine(() => verifyPaired(input, row.options, base.header, kept, body.members as PairedMember[], CHECKED_MEMBERS, random));
			if (mismatches.length || !header) throw new ApiError(422, 'the posted pairs do not reproduce', mismatches);
			const s = summarisePaired({ options: row.options, header: base.header, members: base.members }, { header, members: body.members as PairedMember[] });
			summary = s;
			accepted = s.members;
			result = { engineVersion: ENGINE_VERSION, header, members: body.members };
		} else {
			const { body } = read;
			const members = body.members as MemberResult[];
			const { mismatches, header } = engine(() => verifyEnsemble(input, row.options, members, CHECKED_MEMBERS, random));
			if (mismatches.length || !header) throw new ApiError(422, 'the posted ensemble does not reproduce', mismatches);
			const coverage = body.coverage as RecordCoverage[];
			const bad = coverageMismatch(row.options, header, members, coverage);
			if (bad) throw new ApiError(422, 'the posted ensemble does not reproduce', [bad]);
			const s = summariseEnsemble({ options: row.options, header, members, coverage });
			summary = s;
			accepted = s.accepted;
			result = { engineVersion: ENGINE_VERSION, header, members, coverage };
		}
		return withUser(userId, async (db) => {
			// Still theirs to store: an editor removed meanwhile gets 403/404, and of two posts only the first stores (status).
			await storable(db);
			const { rowCount } = await db.query(`UPDATE run_uncertainty SET status = 'complete', accepted = $2, summary = $3, result = $4 WHERE id = $1 AND status = 'started'`, [
				uid,
				accepted,
				JSON.stringify(summary),
				JSON.stringify(result)
			]);
			if (rowCount !== 1) throw new ApiError(409, 'this ensemble is already stored; start a new one to run it again');
			return c.json({ ensemble: await loadRow(db, id, runId, uid) });
		});
	});

/**
 * The coverage rows must be the options' records with the header's held-out
 * days, withheld exactly when too few members were kept, and consistent with
 * their own counts. (The inside count itself needs every kept member's daily
 * flow: "Reproduce" in the app re-runs them all.)
 */
export function coverageMismatch(options: ResolvedEnsembleOptions, header: EnsembleHeader, members: readonly MemberResult[], coverage: readonly RecordCoverage[]): string | null {
	const kept = members.filter((m) => m.accepted).length;
	if (coverage.length !== header.records.length) return `${coverage.length} coverage rows, expected ${header.records.length}`;
	for (let i = 0; i < coverage.length; i++) {
		const c = coverage[i]!;
		const h = header.records[i]!;
		if (c.record !== h.record || c.heldOutDays !== h.heldOutDays) return `coverage row ${i} is not the ${h.record} with ${h.heldOutDays} held-out days`;
		const gated = kept < options.minMembers || h.heldOutDays === 0;
		if (gated !== (c.inside === null) || gated !== (c.fraction === null)) return `coverage row ${i} ${gated ? 'must be withheld' : 'is missing'}`;
		if (c.inside !== null && c.fraction !== null) {
			if (c.inside > c.heldOutDays || Math.abs(c.fraction - c.inside / c.heldOutDays) > 1e-5) return `coverage row ${i} is inconsistent`;
			if (c.warning !== c.inside / c.heldOutDays < options.coverageWarning) return `coverage row ${i} has the wrong warning`;
		} else if (c.warning) return `coverage row ${i} warns without a band`;
	}
	return null;
}
