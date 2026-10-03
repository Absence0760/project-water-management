// The job worker trusts nothing a job row says (docs/security.md § Background
// jobs), swept over the live handler registry so a new kind is covered the
// day it is added:
//
//   1. Every kind re-checks the acting user's role when it runs: queued while
//      they held the handler's role, then demoted or removed, the job is dead
//      with nothing run (positive control: at the role, the same job gets past
//      the check to its payload). Only the kinds in LOWER_THAN_EDITOR run for
//      less than an editor, each with its reason.
//   2. A job queued in project A whose payload names project B's object (a
//      feed, report, sweep, outlook or run), by someone who can edit both,
//      touches nothing of B; B's own job with the same payload does (positive
//      control). Every kind whose payload names an id is in the sweep (an
//      evidence pack's render included).
//
// FEED_FETCHER and REPORT_RENDERER are `sqs` here, with the queue send
// captured: a fetch or render is then visible as the message it would send,
// with no network and no Chromium.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[] }));
vi.mock('./transport.js', async (orig) => ({
	...(await orig<typeof import('./transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: Record<string, unknown>) => void sent.push(message)
}));

import { asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { FIXTURE_CELL } from '../feeds/fixtures.js';
import { rank, type Role } from '../projects/access.js';
import { handlers } from './handlers/index.js';
import { enqueueJob } from './queue.js';
import { JOB_KINDS, type JobKind } from './registry.js';
import { runTick } from './runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

const cleanup: string[] = [];
/** Projects holding an issued evidence pack: the schema keeps them (112), so their pending jobs are retired instead. */
const kept = new Set<string>();
beforeEach(() => {
	vi.stubEnv('FEED_FETCHER', 'sqs');
	vi.stubEnv('FETCH_REQUESTS_QUEUE_URL', 'memory://fetch-requests');
	vi.stubEnv('REPORT_RENDERER', 'sqs');
	vi.stubEnv('RENDER_REQUESTS_QUEUE_URL', 'memory://render-requests');
});
afterEach(async () => {
	sent.length = 0;
	vi.unstubAllEnvs();
	// Each project goes with its jobs, so no later file's tick picks them up.
	for (const pid of cleanup.splice(0)) {
		if (kept.has(pid)) await retirePendingJobs(pid);
		else await asOwner('DELETE FROM project WHERE id = $1', [pid]);
	}
});

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const jobRow = async (id: string) => (await asOwner('SELECT status, last_error FROM job WHERE id = $1', [id]))[0] as { status: string; last_error: string | null };
const enqueue = (u: User, projectId: string, kind: JobKind, payload: Record<string, unknown>) =>
	withUser(u.id, (db) => enqueueJob(db, { projectId, kind, payload, maxAttempts: 1 }));

async function member(owner: User, projectId: string, u: User, role: 'viewer' | 'editor' | 'owner') {
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
}

async function project(owner: User, name: string) {
	const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	cleanup.push(id);
	return id;
}

const START = '2000-10-01';
/** A farm dam draining to an outlet, two water years of invented rain, one saved run. */
async function catchment(owner: User, name: string) {
	const projectId = await project(owner, name);
	const outlet = node('Outlet', null);
	const farm = node('Farm', outlet.id, { pctRunoffToDam: 1, damCapacityM3: 80_000, damInitialPct: 0.5, damMinPct: 0 });
	const crop = { id: randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 150_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 730 }, (_, i) => (i % 3 === 0 ? 8 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'base' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	return { projectId, farmId: farm.id as string, runId: run.body.run.id as string };
}

/** An observed record on a catchment (a quarter of its rain, invented), so a calibration or an ensemble can start on it. */
async function withFlow(owner: User, projectId: string) {
	const flow = Array.from({ length: 730 }, (_, i) => (i % 3 === 0 ? 0.4 : 0.1));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: START, values: flow })).status).toBe(200);
}

/**
 * The kinds that run for someone below editor, and why that's safe. Every
 * other kind needs an editor. A new kind lands here only with its reason.
 */
const LOWER_THAN_EDITOR: Partial<Record<JobKind, { role: Role; why: string }>> = {
	report_render: { role: 'viewer', why: 'a viewer can already read everything the PDF holds (the report route); emailing others is refused to viewers by POST /reports' }
};

/**
 * The kinds that also run for one role below their own (JobHandler.alsoRole),
 * exactly that role, with the handler checking what it may do there.
 */
const ALSO_ROLE: Partial<Record<JobKind, { role: Role; why: string }>> = {
	yield: {
		role: 'contributor',
		why: "an applicant's yield of a dam of their own application; yieldInputFor refuses any other target (yield/contributor.db.test.ts, 096_contributor_yield)"
	},
	applicant_pack_render: {
		role: 'contributor',
		why: "an applicant's copy of an issued pack of their own application; the handler refuses anyone app_applicant_pack_meta doesn't answer (evidence/applicant-copy.db.test.ts)"
	}
};

describe('every job kind re-checks the acting user’s role when it runs', () => {
	it('every kind has a handler, none runs for less than a viewer, and only the allowlisted kinds run for less than an editor', () => {
		expect(Object.keys(handlers).sort()).toEqual([...JOB_KINDS].sort());
		for (const kind of JOB_KINDS) {
			const role = handlers[kind]!.role;
			expect(rank[role], kind).toBeGreaterThanOrEqual(rank.viewer);
			expect(role, kind).toBe(LOWER_THAN_EDITOR[kind]?.role ?? 'editor');
			expect(handlers[kind]!.alsoRole, kind).toBe(ALSO_ROLE[kind]?.role);
		}
	});

	it.each(JOB_KINDS.map((k) => [k]))('%s: dead, nothing run, once its user is below the handler’s role (positive control: at the role it passes the check)', async (kind) => {
		const handler = handlers[kind]!;
		const role = handler.role as 'viewer' | 'editor';
		// A payload no handler accepts: the job stops at the first check it fails, and runs nothing either way.
		const probe = { securityProbe: true };
		expect(handler.payload.safeParse(probe).success).toBe(false);

		const owner = await signUp(`RoleOwner-${kind}`);
		const u = await signUp(`RoleUser-${kind}`);
		const pid = await project(owner, `Role ${kind}`);
		await member(owner, pid, u, role);

		// Positive control: at the role, the check passes and the payload is what stops it.
		const { job: atRole } = await enqueue(u, pid, kind, probe);
		await tick();
		expect(await jobRow(atRole.id)).toEqual({ status: 'dead', last_error: 'the job’s payload is not valid' });

		const refused = `the user who queued this job no longer has the ${role} role on the project`;
		// Its extra role, exactly (a contributor, not a viewer): past the check, to the payload.
		const also = handler.alsoRole;
		if (also) {
			const a = await signUp(`RoleAlso-${kind}`);
			expect((await owner.call('POST', `/projects/${pid}/members`, { email: a.email, role: also })).status).toBe(201);
			const { job: atAlso } = await withUser(u.id, (db) => enqueueJob(db, { projectId: pid, kind, payload: probe, maxAttempts: 1 }));
			await asOwner('UPDATE job SET acting_user_id = $2 WHERE id = $1', [atAlso.id, a.id]);
			await tick();
			expect(await jobRow(atAlso.id)).toEqual({ status: 'dead', last_error: 'the job’s payload is not valid' });
		}
		// Demoted one rung (an editor to viewer), where there is one below that still reads the project.
		if (role === 'editor') {
			const { job: demoted } = await enqueue(u, pid, kind, probe);
			expect((await owner.call('PATCH', `/projects/${pid}/members/${u.id}`, { role: 'viewer' })).status).toBe(200);
			await tick();
			expect(await jobRow(demoted.id)).toEqual({ status: 'dead', last_error: refused });
			expect((await owner.call('PATCH', `/projects/${pid}/members/${u.id}`, { role })).status).toBe(200);
		}
		// Removed from the project.
		const { job: removed } = await enqueue(u, pid, kind, probe);
		expect((await owner.call('DELETE', `/projects/${pid}/members/${u.id}`)).status).toBeLessThan(300);
		await tick();
		expect(await jobRow(removed.id)).toEqual({ status: 'dead', last_error: refused });
	});
});

/**
 * One case per kind whose payload names an object: queue B's own job for it
 * (through the app), and read what that job changes in B.
 */
interface CrossCase {
	/** B's job, and the id of the B object it is about. */
	queue(owner: User, b: Awaited<ReturnType<typeof catchment>>): Promise<{ jobId: string; ref: string }>;
	/** B's state that the job would change. */
	effect(ref: string): Promise<unknown>;
}

const feedCols = (id: string) =>
	asOwner('SELECT fetch_job_id, consecutive_failures, last_error IS NOT NULL AS failed FROM data_feed WHERE id = $1', [id]).then((r) => r[0]);
const sentFor = (key: string, id: string) => sent.filter((m) => m[key] === id).length;

async function feedOf(owner: User, projectId: string) {
	const res = await owner.call('POST', `/projects/${projectId}/feeds`, { source: 'chirps', config: { cells: [{ ...FIXTURE_CELL(), weight: 1 }] } });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.feed.id as string;
}

/**
 * An issued evidence pack of a project's run, planted past evidence_pack_guard
 * (replica role, as cross-project-refs.security.db.test.ts arranges its
 * packs): issuing one through the API needs an issuable report, which these
 * catchments lack, and the sweep needs only the row. Its project is then
 * kept (evidence_pack_guard refuses deleting it), so afterEach retires its
 * jobs rather than deleting it.
 */
async function issuedPack(projectId: string, runId: string, userId: string): Promise<string> {
	kept.add(projectId);
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		const { rows } = await client.query<{ id: string }>(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, status, manifest, manifest_sha256, report_version, engine_version, created_by, issued_at, issued_by)
			 VALUES (gen_random_uuid(), $1, $2, 1, 'issued', '{}', md5(random()::text) || md5(random()::text), 'evidence-1', 'x', $3, now(), $3) RETURNING id::text`,
			[projectId, runId, userId]
		);
		await client.query('COMMIT');
		return rows[0]!.id;
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		await client.end();
	}
}

/**
 * An issued pack of an application the project's owner made themselves
 * (so they are its party, app_applicant_pack_meta), planted as issuedPack
 * plants one: the applicant's copy (165_applicant_copy) needs a party.
 */
async function issuedApplicationPack(projectId: string, runId: string, userId: string): Promise<string> {
	kept.add(projectId);
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		const { rows: s } = await client.query<{ id: string }>(
			`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin, status, submitted_at)
			 VALUES ($1, 'Own application', $2, repeat('a', 64), $3, 'applicant', 'submitted', now()) RETURNING id::text`,
			[projectId, runId, userId]
		);
		const { rows: r } = await client.query<{ id: string }>(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, scenario_id) VALUES ($1, $2, 'x', '2000-01-01', '2000-01-02', '{}', $3) RETURNING id::text`,
			[projectId, userId, s[0]!.id]
		);
		const { rows } = await client.query<{ id: string }>(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, scenario_id, scenario_run_id, status, manifest, manifest_sha256, report_version, engine_version, created_by, issued_at, issued_by)
			 VALUES (gen_random_uuid(), $1, $2, 1, $4, $5, 'issued', '{}', md5(random()::text) || md5(random()::text), 'evidence-1', 'x', $3, now(), $3) RETURNING id::text`,
			[projectId, runId, userId, s[0]!.id, r[0]!.id]
		);
		await client.query('COMMIT');
		return rows[0]!.id;
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		await client.end();
	}
}

const CROSS: Partial<Record<JobKind, CrossCase>> = {
	delineate: {
		// B's click handed to the worker (191), against the committed synthetic DEM (its valley's dam wall): B's job proposes it.
		async queue(owner, b) {
			vi.stubEnv('DEM_URL', fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url)));
			const res = await owner.call('POST', `/projects/${b.projectId}/map/delineation`, { lon: 20.7428741, lat: -33.4262838, from: 'dam_wall', background: true });
			expect(res.status, JSON.stringify(res.body)).toBe(202);
			const [r] = await asOwner('SELECT job_id FROM delineation_request WHERE id = $1', [res.body.request.id]);
			return { jobId: r.job_id, ref: res.body.request.id };
		},
		effect: async (id) => (await asOwner('SELECT status, proposal_id IS NOT NULL AS proposed FROM delineation_request WHERE id = $1', [id]))[0]
	},
	applicant_pack_render: {
		// B's issued pack of an application its owner made, and that party's copy of it: with REPORT_RENDERER=sqs a render token and a render_pack message.
		async queue(owner, b) {
			const packId = await issuedApplicationPack(b.projectId, b.runId, owner.id);
			const { job } = await enqueue(owner, b.projectId, 'applicant_pack_render', { packId });
			return { jobId: job.id, ref: packId };
		},
		effect: async (id) => ({
			tokens: (await asOwner(`SELECT count(*)::int AS n FROM render_token WHERE pack_id = $1 AND purpose = 'applicant_pack'`, [id]))[0].n,
			sent: sentFor('packId', id)
		})
	},
	feed_fetch: {
		async queue(owner, b) {
			const feedId = await feedOf(owner, b.projectId);
			return { jobId: (await owner.call('POST', `/projects/${b.projectId}/feeds/${feedId}/run-now`)).body.job.id, ref: feedId };
		},
		effect: async (id) => ({ ...(await feedCols(id)), sent: sentFor('feedId', id) })
	},
	feed_ingest: {
		async queue(owner, b) {
			// B's fetch goes out first (its window recorded), then its answer comes back as a feed_ingest job.
			const feedId = await feedOf(owner, b.projectId);
			const fetch = (await owner.call('POST', `/projects/${b.projectId}/feeds/${feedId}/run-now`)).body.job.id;
			await tick();
			expect(await jobRow(fetch)).toMatchObject({ status: 'done' });
			const msg = sent.find((m) => m.feedId === feedId)!;
			const payload = { feedId, fetchJobId: msg.fetchJobId, feedVersion: msg.feedVersion, result: { ok: false, error: 'the source was down' } };
			return { jobId: (await enqueue(owner, b.projectId, 'feed_ingest', payload)).job.id, ref: feedId };
		},
		effect: async (id) => feedCols(id)
	},
	report_render: {
		async queue(owner, b) {
			const res = await owner.call('POST', `/projects/${b.projectId}/reports`, { runId: b.runId });
			expect(res.status).toBe(202);
			const [r] = await asOwner('SELECT id FROM report WHERE job_id = $1', [res.body.jobId]);
			return { jobId: res.body.jobId, ref: r.id };
		},
		effect: async (id) => ({ status: (await asOwner('SELECT status FROM report WHERE id = $1', [id]))[0].status, sent: sentFor('reportId', id) })
	},
	pack_render: {
		// B's issued pack, and B's render of it: with REPORT_RENDERER=sqs the render is a render token and a render_pack message.
		async queue(owner, b) {
			const packId = await issuedPack(b.projectId, b.runId, owner.id);
			const { job } = await enqueue(owner, b.projectId, 'pack_render', { packId });
			return { jobId: job.id, ref: packId };
		},
		effect: async (id) => ({
			tokens: (await asOwner('SELECT count(*)::int AS n FROM render_token WHERE pack_id = $1', [id]))[0].n,
			sent: sentFor('packId', id)
		})
	},
	pack_reproduce: {
		// B's issued pack (planted without a bundle), and B's re-run of it: it records no_bundle (154_pack_reproduce).
		async queue(owner, b) {
			const packId = await issuedPack(b.projectId, b.runId, owner.id);
			const { job } = await enqueue(owner, b.projectId, 'pack_reproduce', { packId });
			return { jobId: job.id, ref: packId };
		},
		effect: async (id) => (await asOwner('SELECT outcome FROM pack_reproduction WHERE pack_id = $1', [id])).map((r) => r.outcome)
	},
	sweep: {
		async queue(owner, b) {
			const res = await owner.call('POST', `/projects/${b.projectId}/sweeps`, { name: 's', baseRunId: b.runId, members: [{ name: 'm', ops: [{ op: 'demand.scale', factor: 0.9 }] }] });
			expect(res.status, JSON.stringify(res.body)).toBe(202);
			return { jobId: res.body.jobId, ref: res.body.sweep.id };
		},
		effect: async (id) => (await asOwner('SELECT status FROM scenario_sweep WHERE id = $1', [id]))[0].status
	},
	assessment: {
		// Two team scenarios on B's run that combine (two fields of one farm), and B's assessment of them.
		async queue(owner, b) {
			const scenario = async (name: string, ops: unknown[]) => {
				const res = await owner.call('POST', `/projects/${b.projectId}/scenarios`, { name, baseRunId: b.runId, ops });
				expect(res.status, JSON.stringify(res.body)).toBe(201);
				return res.body.scenario.id as string;
			};
			const s1 = await scenario('Bigger pump', [{ op: 'node.set', nodeId: b.farmId, field: 'divertCapacityM3Day', value: 9000 }]);
			const s2 = await scenario('Less demand', [{ op: 'demand.scale', factor: 0.9, nodeIds: [b.farmId] }]);
			const res = await owner.call('POST', `/projects/${b.projectId}/assessments`, { name: 'a', scenarioIds: [s1, s2] });
			expect(res.status, JSON.stringify(res.body)).toBe(202);
			return { jobId: res.body.jobId, ref: res.body.assessment.id };
		},
		effect: async (id) => (await asOwner('SELECT status FROM assessment WHERE id = $1', [id]))[0].status
	},
	auto_calibration: {
		// A run of B's calibration rules: a quick search, so B's own job fits its one case.
		async queue(owner, b) {
			await withFlow(owner, b.projectId);
			const rules = (await owner.call('GET', `/projects/${b.projectId}`)).body.project.settings.calibrationRules;
			const quick = { ...rules, run: { seed: 1, starts: 1, budget: 50 }, cases: { bounds: ['typical'], objectives: ['kgePrime'] }, selection: { test: 'split', score: 'kgePrime' } };
			expect((await owner.call('PATCH', `/projects/${b.projectId}`, { settings: { calibrationRules: quick } })).status).toBe(200);
			const res = await owner.call('POST', `/projects/${b.projectId}/auto-calibrations`, {});
			expect(res.status, JSON.stringify(res.body)).toBe(202);
			return { jobId: res.body.jobId, ref: res.body.calibration.id };
		},
		effect: async (id) => (await asOwner('SELECT status, jsonb_array_length(cases) AS n FROM auto_calibration WHERE id = $1', [id]))[0]
	},
	uncertainty: {
		// An ensemble started on B's run, and B's own job to compute it (as applying an automated fit queues one).
		async queue(owner, b) {
			await withFlow(owner, b.projectId);
			const run = (await owner.call('POST', `/projects/${b.projectId}/runs`, { label: 'with flow' })).body.run.id as string;
			const res = await owner.call('POST', `/projects/${b.projectId}/runs/${run}/uncertainty`, { request: { members: 30, thresholds: { minSkill: -10, maxLowFlowBiasPct: null, wr2012MaxLevel: 'unusable' } } });
			expect(res.status, JSON.stringify(res.body)).toBe(201);
			const { job } = await enqueue(owner, b.projectId, 'uncertainty', { uncertaintyId: res.body.ensemble.id });
			return { jobId: job.id, ref: res.body.ensemble.id };
		},
		effect: async (id) => (await asOwner('SELECT status FROM run_uncertainty WHERE id = $1', [id]))[0].status
	},
	outlook: {
		async queue(owner, b) {
			const body = { name: 'o', baseRunId: b.runId, decisionDate: '2001-10-01', seasonEnd: '2002-04-30', analogueYears: [2001], levels: [{ label: 'As is', ops: [] }] };
			const res = await owner.call('POST', `/projects/${b.projectId}/outlooks`, body);
			expect(res.status, JSON.stringify(res.body)).toBe(202);
			return { jobId: res.body.jobId, ref: res.body.outlook.id };
		},
		effect: async (id) => (await asOwner('SELECT status FROM seasonal_outlook WHERE id = $1', [id]))[0].status
	},
	yield: {
		async queue(owner, b) {
			const res = await owner.call('POST', `/projects/${b.projectId}/yield`, { nodeId: b.farmId, runId: b.runId, kind: 'firm' });
			expect(res.status, JSON.stringify(res.body)).toBe(202);
			return { jobId: res.body.jobId, ref: b.runId };
		},
		effect: async (id) => (await asOwner('SELECT count(*)::int AS n FROM yield_result WHERE run_id = $1', [id]))[0].n
	}
};

/** The payload keys that name an object: `feedId`, `reportId`, … (zod object shapes, read from the live registry). */
function idKeys(kind: JobKind): string[] {
	const shape = (handlers[kind]!.payload as unknown as { shape?: Record<string, unknown> }).shape;
	if (!shape) throw new Error(`${kind}: payload is not a zod object; teach idKeys to read it`);
	return Object.keys(shape).filter((k) => /Id$/.test(k));
}

describe('a job naming another project’s object touches nothing of it', () => {
	it('every kind whose payload names an object is in the sweep', () => {
		const naming = JOB_KINDS.filter((k) => idKeys(k).length > 0);
		expect(naming.length).toBeGreaterThan(0);
		expect(Object.keys(CROSS).sort()).toEqual([...naming].sort());
	});

	it.each(Object.keys(CROSS).map((k) => [k as JobKind]))('%s: queued in A with B’s payload, B is unchanged (positive control: B’s own job changes it)', async (kind) => {
		const c = CROSS[kind]!;
		// An owner of both: RLS lets them read B, so only the handler's project scoping stands between A's job and B.
		const owner = await signUp(`Cross-${kind}`);
		const a = await catchment(owner, `A ${kind}`);
		const b = await catchment(owner, `B ${kind}`);
		const { jobId: bJob, ref } = await c.queue(owner, b);
		// B's own job waits while A's runs.
		await asOwner(`UPDATE job SET run_after = now() + interval '1 day' WHERE id = $1`, [bJob]);
		const [{ payload }] = await asOwner('SELECT payload FROM job WHERE id = $1', [bJob]);
		// It names B's object (yield names a run or a scenario, so one of its id keys is enough).
		expect(idKeys(kind).some((k) => typeof payload[k] === 'string'), JSON.stringify(payload)).toBe(true);
		const before = await c.effect(ref);

		const { job: aJob } = await enqueue(owner, a.projectId, kind, payload);
		await tick();
		expect((await jobRow(aJob.id)).status).toMatch(/^(done|dead)$/);
		expect(await c.effect(ref)).toEqual(before);

		// Positive control: the same payload, as B's own job, does change B.
		await asOwner(`UPDATE job SET run_after = now() - interval '1 second' WHERE id = $1`, [bJob]);
		await tick();
		expect(await jobRow(bJob), JSON.stringify(await jobRow(bJob))).toMatchObject({ status: 'done' });
		expect(await c.effect(ref)).not.toEqual(before);
	});
});
