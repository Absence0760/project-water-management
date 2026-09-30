// Seasonal outlooks (issue #53 R5, 063_seasonal_outlook.sql, docs/api.md
// § Seasonal outlooks, docs/model.md §2.15): writing one with its job,
// reading them back, and the job's own work (computeOutlook, called by
// jobs/handlers/outlook.ts).
import { randomUUID } from 'node:crypto';
import {
	ENGINE_VERSION,
	fromEpochDay,
	outlookAnalogues,
	outlookBaseAndSnapshot,
	outlookLevelProblems,
	outlookMember,
	outlookMemberInput,
	reviewTriggerBands,
	reviewTriggerTable,
	runModelWithoutChecks,
	runOutlookMember,
	summariseOutlook,
	toEpochDay,
	withDamStorage,
	withoutDroughtRestriction,
	type ModelInput,
	type OutlookAnalogue,
	type OutlookBaseRun,
	type OutlookExcluded,
	type OutlookMember,
	type ModelStateSnapshot,
	type OutlookSeason,
	type ReviewTriggerBandPlan,
	type ReviewTriggerRow,
	type ReviewTriggers,
	type ScenarioOp,
	type SeasonalOutlook,
	type TriggerBandMembers
} from '@water-management/engine';
import type { Db } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { JobError, LeaseLostError } from '../jobs/errors.js';
import { enqueueJob, type JobMeta, type JobStatus } from '../jobs/queue.js';
import { outlookSeasonFor, resolveOutlook, reviewDateFor } from '../projects/outlookSettings.js';
import { loadBaseInput } from '../scenarios/execute.js';
import { type CreateOutlookBody, OUTLOOK_YEARS_MAX, OUTLOOKS_KEPT, TRIGGER_BANDS_MAX } from './schema.js';

export type OutlookStatus = 'pending' | 'complete';

/** A demand level as stored: its id (its place, "0" …), label and demand.scale ops. */
export interface StoredLevel {
	id: string;
	label: string;
	ops: ScenarioOp[];
}

/** A water year the outlook left out: the engine's reasons, or over OUTLOOK_YEARS_MAX, or a member the engine refused. */
export type StoredExcluded = OutlookExcluded | { waterYear: number; reason: 'overLimit' | 'memberFailed' };

/** A member the engine refused: which level, which year, and the engine's words. */
export interface MemberFailure {
	levelId: string;
	label: string;
	waterYear: number;
	message: string;
}

/**
 * An outlook's result: the engine's SeasonalOutlook (summariseOutlook), its
 * `excluded` with the years this backend left out as well, and the members
 * the engine refused.
 */
export type OutlookResult = Omit<SeasonalOutlook, 'excluded'> & { excluded: StoredExcluded[]; failures: MemberFailure[] };

/** A trigger table as stored: the engine's ReviewTriggers without each band's whole outlook (its per-level summary stays). */
export type StoredTriggerTable = Omit<ReviewTriggers, 'rows'> & { rows: Omit<ReviewTriggerRow, 'outlook'>[] };

/**
 * An outlook's review triggers (issue #53 R6, docs/model.md §2.15a). The
 * table runs on the latest review date the base run's record holds (the
 * state on it is the record's), so it is a rule by storage band for that day
 * of the year; `reviewDate` is the outlook's own season's, the day the WUA
 * reads its dams and applies the rule. `table` is null when it couldn't be
 * drawn, with `problem` saying why.
 */
export interface StoredTriggers {
	reviewDate: string;
	table: StoredTriggerTable | null;
	problem: string | null;
	/** The table's analogue years left out (its own season, the record's edges, over the limit, a member refused). */
	excluded: StoredExcluded[];
	/** Members the engine refused, by band (its lower edge, m³). */
	failures: (MemberFailure & { bandFromM3: number })[];
}

export interface OutlookRow {
	id: string;
	name: string;
	baseRunId: string;
	/** The base run's label and date, for "Based on run X". */
	baseRun: { id: string; label: string; createdAt: string };
	decisionDate: string;
	seasonEnd: string;
	/** The season's review date (R6); null = no trigger table. */
	reviewDate: string | null;
	/** The share asked for; null = the engine's DEFAULT_PLANNING_SHARE (O6). */
	planningShare: number | null;
	levels: StoredLevel[];
	analogueYears: number[] | null;
	status: OutlookStatus;
	engineVersion: string | null;
	/** The job computing it (null once the 30-day purge removed it): a dead job's error says why an outlook stayed pending. */
	job: { id: string; status: JobStatus; error: string | null; progress: number | null } | null;
	createdBy: string | null;
	createdAt: string;
	completedAt: string | null;
	/** Only on GET …/outlooks/:outlookId, and only when complete. */
	result?: OutlookResult | null;
	/** Likewise; null without a review date. */
	triggers?: StoredTriggers | null;
}

const outlookSelect = (withResult: boolean) => `SELECT o.id, o.name, o.base_run_id AS "baseRunId",
	jsonb_build_object('id', r.id, 'label', r.label, 'createdAt', r.created_at) AS "baseRun",
	o.decision_date AS "decisionDate", o.season_end AS "seasonEnd", o.review_date AS "reviewDate", o.planning_share AS "planningShare",
	o.levels, o.analogue_years AS "analogueYears", o.status, o.engine_version AS "engineVersion",
	CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object('id', j.id, 'status', j.status, 'error', j.last_error, 'progress', j.progress) END AS job,
	u.display_name AS "createdBy", o.created_at AS "createdAt", o.completed_at AS "completedAt"${withResult ? ', o.result, o.triggers' : ''}
	FROM seasonal_outlook o JOIN model_run r ON r.id = o.base_run_id
	LEFT JOIN job j ON j.id = o.job_id LEFT JOIN app_user u ON u.id = o.created_by`;

/**
 * Write an outlook and its job, as the transaction's user (an editor, RLS),
 * and keep the project's newest OUTLOOKS_KEPT. The base run is checked first
 * (loadBaseInput: 404 when it isn't this project's, 409 for a scenario or
 * forecast run or one that can't be rebuilt), and the season resolved: the
 * body's, or the project's setting from the base run's newest state; a
 * season the run can't start (no day before the decision date in the run, or
 * the decision date on its first day) is a 422 here, not a dead job later.
 * Wake the worker after the commit.
 */
export async function createOutlook(db: Db, projectId: string, body: CreateOutlookBody): Promise<{ outlook: OutlookRow; job: JobMeta }> {
	const base = await loadBaseInput(db, projectId, body.baseRunId);
	const { rows } = await db.query<{ start: string; end: string; settings: unknown }>(
		`SELECT r.start_date AS start, r.end_date AS "end", p.settings FROM model_run r JOIN project p ON p.id = r.project_id WHERE r.project_id = $1 AND r.id = $2`,
		[projectId, body.baseRunId]
	);
	const run = rows[0]!;
	const setting = resolveOutlook(run.settings);
	let season: OutlookSeason;
	if (body.decisionDate !== undefined && body.seasonEnd !== undefined) {
		const d = toEpochDay(body.decisionDate);
		if (d <= toEpochDay(run.start) || d - 1 > toEpochDay(run.end)) {
			throw new ApiError(422, `the decision date must fall after the base run's first day (${run.start}) and at most the day after its last (${run.end}): the season starts from the run's state on the day before`);
		}
		season = { decisionDate: body.decisionDate, seasonEnd: body.seasonEnd };
	} else {
		const s = outlookSeasonFor(setting.season, run.start, run.end);
		if (!s) throw new ApiError(422, `the base run (${run.start} to ${run.end}) holds no decision date of the project's season with a day before it`);
		season = s;
	}
	// The review date (R6): the body's, else the setting's (or the engine's default) when the catchment has a farm dam to band; null = no table.
	const dams = base.model.nodes.some((n) => n.kind === 'farm' && n.damCapacityM3 > 0);
	let reviewDate: string | null = null;
	if (typeof body.reviewDate === 'string') {
		if (!dams) throw new ApiError(422, 'review triggers need a farm dam: their bands are dam storage (give no review date for an outlook without them)');
		if (body.reviewDate <= season.decisionDate || body.reviewDate > season.seasonEnd) {
			throw new ApiError(422, `the review date must fall after the decision date (${season.decisionDate}) and on or before the season end (${season.seasonEnd})`);
		}
		reviewDate = body.reviewDate;
	} else if (body.reviewDate === undefined && dams) {
		// A season from the request that the setting's month and day don't fall in takes the engine's default for it; the project's own season must fit its setting.
		const r = reviewDateFor(setting.review, season);
		const fallback = 'error' in r && body.decisionDate !== undefined ? reviewDateFor(null, season) : r;
		if ('error' in fallback) throw new ApiError(422, `the project's review date setting doesn't fit this season: ${fallback.error}`);
		reviewDate = fallback.date;
	}
	const levels: StoredLevel[] = body.levels.map((l, i) => ({ id: String(i), label: l.label, ops: l.ops }));
	const outlookId = randomUUID();
	// The job first, so the outlook row can name it (the guard checks it is this project's outlook job).
	const { job } = await enqueueJob(db, { projectId, kind: 'outlook', payload: { outlookId }, maxAttempts: 2 });
	await db.query(
		`INSERT INTO seasonal_outlook (id, project_id, base_run_id, job_id, name, decision_date, season_end, planning_share, levels, analogue_years, review_date)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
		[
			outlookId,
			projectId,
			body.baseRunId,
			job.id,
			body.name,
			season.decisionDate,
			season.seasonEnd,
			body.planningShare ?? setting.planningShare,
			JSON.stringify(levels),
			body.analogueYears ?? null,
			reviewDate
		]
	);
	await db.query(
		`DELETE FROM seasonal_outlook WHERE id IN (
			SELECT id FROM seasonal_outlook WHERE project_id = $1 ORDER BY created_at DESC, id DESC OFFSET $2)`,
		[projectId, OUTLOOKS_KEPT]
	);
	return { outlook: (await getOutlook(db, projectId, outlookId, false))!, job };
}

/** A project's outlooks, newest first, optionally of one base run, without their results (RLS: viewer). */
export async function listOutlooks(db: Db, projectId: string, q: { baseRunId?: string } = {}): Promise<OutlookRow[]> {
	const { rows } = await db.query<OutlookRow>(
		`${outlookSelect(false)} WHERE o.project_id = $1 AND ($2::uuid IS NULL OR o.base_run_id = $2)
		 ORDER BY o.created_at DESC, o.id DESC LIMIT ${OUTLOOKS_KEPT}`,
		[projectId, q.baseRunId ?? null]
	);
	return rows;
}

/** One outlook of a project, with its result by default; null when there is none (RLS: viewer). */
export async function getOutlook(db: Db, projectId: string, outlookId: string, withResult = true): Promise<OutlookRow | null> {
	const { rows } = await db.query<OutlookRow>(`${outlookSelect(withResult)} WHERE o.project_id = $1 AND o.id = $2`, [projectId, outlookId]);
	return rows[0] ?? null;
}

/** Queued or running outlook jobs the user has, in any project they can still see. */
export async function pendingOutlookJobs(db: Db): Promise<number> {
	// Count and enqueue one request at a time per user (the lock is held to
	// commit), so a burst of requests can't all pass the cap together.
	await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('outlook_job_cap:' || app_current_user_id()::text, 0))`);
	const { rows } = await db.query<{ n: number }>(
		`SELECT count(*)::int AS n FROM job WHERE kind = 'outlook' AND acting_user_id = app_current_user_id() AND status IN ('queued', 'running', 'failed')`
	);
	return rows[0]?.n ?? 0;
}

/** Σ farm dam storage at the end of the day before the decision date in the base run; null without a dam. */
function startStorage(input: ModelInput, baseRun: OutlookBaseRun, decisionDate: string): number | null {
	const t = toEpochDay(decisionDate) - 1 - toEpochDay(baseRun.startDate);
	let sum = 0;
	let dams = 0;
	for (const n of input.model.nodes) {
		if (n.kind !== 'farm' || !(n.damCapacityM3 > 0)) continue;
		const v = baseRun.series.find((s) => s.nodeId === n.id && s.key === 'dam_storage')?.values[t];
		sum += typeof v === 'number' && Number.isFinite(v) ? v : 0;
		dams++;
	}
	return dams ? sum : null;
}

/**
 * The outlook job's work, in the job's transaction as the user who asked
 * (docs/model.md §2.15): re-run the base run's stored input (the base run's
 * state and rain, on this engine), pick the analogue years (the engine's
 * outlookAnalogues; beyond OUTLOOK_YEARS_MAX the newest, the rest listed as
 * `overLimit`), then for every level whose ops apply, every analogue year as
 * one member, each stored as it finishes. The history runs once: the base
 * run also captures the model's state on the decision date
 * (outlookBaseAndSnapshot, engine ≥ 1.1.0, docs/model.md §2.16), and each
 * member runs only the season from it (runOutlookMember). A base run that
 * ends before the decision date has no snapshot; the level probe below then
 * fails the job with the engine's words, as before. A member the engine refuses is stored as
 * failed with the engine's words and the outlook carries on: a level refused
 * in every year is reported as not run, and a year some other level was
 * refused in is left out of every level (`memberFailed`), so the levels are
 * compared on the same years. Then summariseOutlook is the result.
 * `progress` is called after each member (0–100); a false answer (the lease
 * was lost) stops with nothing stored. Returns false when there was nothing
 * to do (the outlook was deleted, or is already complete).
 */
export async function computeOutlook(db: Db, projectId: string, outlookId: string, progress: (pct: number) => Promise<boolean>): Promise<boolean> {
	const { rows } = await db.query<{
		baseRunId: string;
		status: OutlookStatus;
		decisionDate: string;
		seasonEnd: string;
		reviewDate: string | null;
		planningShare: number | null;
		levels: StoredLevel[];
		analogueYears: number[] | null;
	}>(
		`SELECT base_run_id AS "baseRunId", status, decision_date AS "decisionDate", season_end AS "seasonEnd", review_date AS "reviewDate",
			planning_share AS "planningShare", levels, analogue_years AS "analogueYears"
		 FROM seasonal_outlook WHERE project_id = $1 AND id = $2`,
		[projectId, outlookId]
	);
	const o = rows[0];
	if (!o || o.status === 'complete') return false;
	// A base run that can no longer be rebuilt fails the job (an ApiError: no retry), the outlook stays pending.
	// Without the drought restriction rule (engine ≥ 1.54.0, withoutDroughtRestriction): the triggers become that
	// rule, and a demand level on top of it would cut twice; the history and every member run unrestricted.
	const base = withoutDroughtRestriction(await loadBaseInput(db, projectId, o.baseRunId));
	const season: OutlookSeason = { decisionDate: o.decisionDate, seasonEnd: o.seasonEnd };
	const { baseRun, snapshot } = outlookBaseAndSnapshot(base, season.decisionDate);
	let picked: { analogues: OutlookAnalogue[]; excluded: OutlookExcluded[] };
	try {
		picked = outlookAnalogues(baseRun, season, o.analogueYears ?? undefined);
	} catch (err) {
		// No rain_final: the base run has no rainfall to draw seasons from. The engine's words.
		throw new JobError(`the outlook can't run: ${(err as Error).message}`, { retry: false });
	}
	const excluded: StoredExcluded[] = [...picked.excluded];
	// The newest OUTLOOK_YEARS_MAX, in the engine's order; the older ones listed.
	const byYear = [...picked.analogues].sort((a, b) => b.waterYear - a.waterYear);
	const keep = new Set(byYear.slice(0, OUTLOOK_YEARS_MAX).map((a) => a.waterYear));
	for (const a of byYear.slice(OUTLOOK_YEARS_MAX)) excluded.push({ waterYear: a.waterYear, reason: 'overLimit' });
	const analogues = picked.analogues.filter((a) => keep.has(a.waterYear));

	// Which levels run: demand.scale only, and ops that apply (checked once, on the first analogue: the same model every year).
	const plan = o.levels.map((level) => {
		let problems = outlookLevelProblems(level);
		if (!problems.length) {
			const probe = analogues[0] ?? { waterYear: 0, label: '', from: season.decisionDate, to: season.seasonEnd };
			try {
				problems = outlookMemberInput(base, baseRun, season, probe, level.ops).problems;
			} catch (err) {
				// The dates or the base (a demand factor already on it): the whole outlook can't run, in the engine's words.
				throw new JobError(`the outlook can't run: ${(err as Error).message}`, { retry: false });
			}
		}
		return { level, problems };
	});
	const running = plan.filter((p) => !p.problems.length);
	const table = o.reviewDate ? planTriggerTable(base, baseRun, o.reviewDate, season, o.analogueYears) : null;
	const tableMembers = table && 'plan' in table ? table.plan.bands.length * running.length * table.analogues.length : 0;
	const total = running.length * analogues.length + tableMembers;
	let done = 0;
	const members = new Map<string, Map<number, OutlookMember>>();
	const failures: MemberFailure[] = [];
	for (const [position, { level, problems }] of plan.entries()) {
		const got = new Map<number, OutlookMember>();
		members.set(level.id, got);
		if (problems.length) continue;
		for (const a of analogues) {
			let member: OutlookMember | null = null;
			let failure = '';
			try {
				if (snapshot) {
					const r = runOutlookMember(snapshot, base, baseRun, season, a, level.ops);
					if (r.problems.length) failure = `model run failed: ${r.problems.join('; ')}`;
					member = r.member;
				} else {
					// Unreachable after the probe (it refuses a season the base run can't start from); kept so a member never silently skips.
					const { input } = outlookMemberInput(base, baseRun, season, a, level.ops);
					member = outlookMember(runModelWithoutChecks(input), input.model, season, a);
				}
			} catch (err) {
				// The engine's own words (plain text, never DB text).
				failure = `model run failed: ${(err as Error).message}`;
			}
			if (member) {
				got.set(a.waterYear, member);
				await db.query(
					`INSERT INTO seasonal_outlook_member (outlook_id, project_id, level_position, water_year, status, member) VALUES ($1, $2, $3, $4, 'done', $5)`,
					[outlookId, projectId, position, a.waterYear, JSON.stringify(member)]
				);
			} else {
				failures.push({ levelId: level.id, label: level.label, waterYear: a.waterYear, message: failure });
				await db.query(
					`INSERT INTO seasonal_outlook_member (outlook_id, project_id, level_position, water_year, status, problems) VALUES ($1, $2, $3, $4, 'failed', $5)`,
					[outlookId, projectId, position, a.waterYear, JSON.stringify([failure])]
				);
			}
			done++;
			// False only when the lease was lost (an outlook can't be cancelled): roll back, record nothing.
			if (!(await progress((100 * done) / total))) throw new LeaseLostError();
		}
	}

	// A level refused every year didn't run; a year a running level was refused in is left out of all of them.
	const levels = plan.map(({ level, problems }) => {
		const got = members.get(level.id)!;
		if (!problems.length && analogues.length && got.size === 0) {
			return { level, problems: [failures.find((f) => f.levelId === level.id)!.message] };
		}
		return { level, problems };
	});
	const failedYears = new Set(failures.filter((f) => !levels.find((l) => l.level.id === f.levelId)!.problems.length).map((f) => f.waterYear));
	for (const wy of [...failedYears].sort((a, b) => a - b)) excluded.push({ waterYear: wy, reason: 'memberFailed' });
	const kept = analogues.filter((a) => !failedYears.has(a.waterYear));
	const summary = summariseOutlook({
		season,
		model: base.model,
		analogues: kept,
		excluded: picked.excluded,
		levels: levels.map(({ level, problems }) => ({
			id: level.id,
			label: level.label,
			problems,
			members: problems.length ? [] : kept.map((a) => members.get(level.id)!.get(a.waterYear)!)
		})),
		startStorageM3: startStorage(base, baseRun, season.decisionDate),
		...(o.planningShare !== null ? { planningShare: o.planningShare } : {})
	});
	const result: OutlookResult = { ...summary, excluded, failures };

	// The review triggers (R6): every storage band × every level that ran × the table's analogue years.
	let triggers: StoredTriggers | null = null;
	if (o.reviewDate && table) {
		if ('problem' in table) triggers = { reviewDate: o.reviewDate, table: null, problem: table.problem, excluded: [], failures: [] };
		else {
			const tFailures: StoredTriggers['failures'] = [];
			const bands: TriggerBandMembers[] = [];
			for (const b of table.plan.bands) {
				const start = withDamStorage(table.snapshot, base, b.storageM3ByDam);
				const bandLevels: TriggerBandMembers['levels'] = [];
				for (const { level, problems } of levels) {
					if (problems.length) {
						bandLevels.push({ id: level.id, label: level.label, problems, members: [] });
						// A level refused in every year of the outlook was counted in `total`: count its members here too, so progress reaches 100.
						if (running.some((p) => p.level.id === level.id)) {
							done += table.analogues.length;
							if (!(await progress((100 * done) / total))) throw new LeaseLostError();
						}
						continue;
					}
					const got: OutlookMember[] = [];
					let refused: string | null = null;
					for (const a of table.analogues) {
						if (!refused) {
							try {
								const r = runOutlookMember(start, base, table.baseRun, table.season, a, level.ops);
								if (r.member) got.push(r.member);
								else refused = `model run failed: ${r.problems.join('; ')}`;
							} catch (err) {
								refused = `model run failed: ${(err as Error).message}`;
							}
							if (refused) tFailures.push({ levelId: level.id, label: level.label, waterYear: a.waterYear, message: refused, bandFromM3: b.band.fromM3 });
						}
						done++;
						// False only when the lease was lost: roll back, record nothing.
						if (!(await progress((100 * done) / total))) throw new LeaseLostError();
					}
					// A level refused in one year of a band isn't judged in that band (its years must all be there).
					bandLevels.push(refused ? { id: level.id, label: level.label, problems: [refused], members: [] } : { id: level.id, label: level.label, problems: [], members: got });
				}
				bands.push({ ...b, levels: bandLevels });
			}
			const t = reviewTriggerTable({
				reviewDate: table.season.decisionDate,
				seasonEnd: table.season.seasonEnd,
				model: base.model,
				analogues: table.analogues,
				excluded: table.pickedExcluded,
				bands,
				representative: table.plan.representative,
				bandSource: table.plan.bandSource,
				history: table.plan.history,
				lowestOnRecordM3: table.plan.lowestOnRecordM3,
				bandWarnings: table.plan.bandWarnings,
				...(o.planningShare !== null ? { planningShare: o.planningShare } : {})
			});
			triggers = { reviewDate: o.reviewDate, table: { ...t, rows: t.rows.map(({ outlook: _, ...r }) => r) }, problem: null, excluded: table.excluded, failures: tFailures };
		}
	}
	await db.query(`UPDATE seasonal_outlook SET status = 'complete', result = $2, engine_version = $3, triggers = $4 WHERE id = $1`, [
		outlookId,
		JSON.stringify(result),
		ENGINE_VERSION,
		triggers ? JSON.stringify(triggers) : null
	]);
	return true;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
/** Year y's day with month and day `md` ("MM-DD"); 29 February → 28 February in a common year. */
const dayOf = (y: number, md: string) => toEpochDay(`${String(y).padStart(4, '0')}-${md === '02-29' && !isLeap(y) ? '02-28' : md}`);

/** A trigger table's plan, or why it can't be drawn. */
type TriggerTablePlan =
	| { problem: string }
	| {
			season: OutlookSeason;
			baseRun: OutlookBaseRun;
			snapshot: ModelStateSnapshot;
			plan: ReviewTriggerBandPlan;
			analogues: OutlookAnalogue[];
			/** The engine's (the table's input). */
			pickedExcluded: OutlookExcluded[];
			/** The engine's and the ones over OUTLOOK_YEARS_MAX (what's stored). */
			excluded: StoredExcluded[];
	  };

/**
 * Where an outlook's trigger table runs and from what (docs/model.md §2.15a,
 * docs/api.md § Seasonal outlooks): the latest day with the review date's
 * month and day that the base run's state reaches (its day before inside the
 * run, after its first day), to the season end's month and day after it.
 * The outlook's own review date is usually past the base run's end (its
 * season starts from the run's newest state), so the table is a rule by
 * storage band for that day of the year, drawn where the record holds a
 * state. Then the history run once more to that day for its snapshot, the
 * engine's bands from the record's storage on that day in every year
 * (reviewTriggerBands), and the table's analogue years (the outlook's, else
 * every one but its own; the newest OUTLOOK_YEARS_MAX).
 */
function planTriggerTable(base: ModelInput, baseRun: OutlookBaseRun, reviewDate: string, season: OutlookSeason, analogueYears: number[] | null): TriggerTablePlan {
	const r0 = toEpochDay(baseRun.startDate);
	const r1 = r0 + baseRun.days - 1;
	const md = reviewDate.slice(5);
	const endMd = season.seasonEnd.slice(5);
	let y = Number(fromEpochDay(r1 + 1).slice(0, 4));
	if (dayOf(y, md) > r1 + 1) y--;
	const at = dayOf(y, md);
	if (at <= r0) return { problem: `the base run (${baseRun.startDate} to ${fromEpochDay(r1)}) holds no ${md} with a day before it, so the trigger table has no state to start from` };
	const end = dayOf(endMd >= md ? y : y + 1, endMd);
	const tableSeason: OutlookSeason = { decisionDate: fromEpochDay(at), seasonEnd: fromEpochDay(end) };
	let tBase: OutlookBaseRun;
	let snapshot: ModelStateSnapshot | null;
	try {
		({ baseRun: tBase, snapshot } = outlookBaseAndSnapshot(base, tableSeason.decisionDate));
	} catch (err) {
		// The engine's words; the outlook itself still completes, without a table.
		return { problem: `the model's state on ${tableSeason.decisionDate} couldn't be captured: ${(err as Error).message}` };
	}
	if (!snapshot) return { problem: `the model's state on ${tableSeason.decisionDate} couldn't be captured, so the trigger table can't be drawn` };
	let plan: ReviewTriggerBandPlan;
	try {
		plan = reviewTriggerBands(base, tBase, { reviewDate: tableSeason.decisionDate, seasonEnd: tableSeason.seasonEnd });
	} catch (err) {
		// The engine's words: no farm dam (the model changed since the outlook was asked for), a date it refuses.
		return { problem: (err as Error).message };
	}
	if (plan.bands.length > TRIGGER_BANDS_MAX) throw new JobError(`a trigger table of ${plan.bands.length} bands is over the limit of ${TRIGGER_BANDS_MAX}`, { retry: false });
	let picked: ReturnType<typeof outlookAnalogues>;
	try {
		picked = outlookAnalogues(tBase, tableSeason, analogueYears ?? undefined);
	} catch (err) {
		return { problem: (err as Error).message };
	}
	const byYear = [...picked.analogues].sort((a, b) => b.waterYear - a.waterYear);
	const keep = new Set(byYear.slice(0, OUTLOOK_YEARS_MAX).map((a) => a.waterYear));
	const excluded: StoredExcluded[] = [...picked.excluded, ...byYear.slice(OUTLOOK_YEARS_MAX).map((a) => ({ waterYear: a.waterYear, reason: 'overLimit' as const }))];
	return { season: tableSeason, baseRun: tBase, snapshot, plan, analogues: picked.analogues.filter((a) => keep.has(a.waterYear)), pickedExcluded: picked.excluded, excluded };
}

