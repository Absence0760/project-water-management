// Automatic re-runs after new data (WP-2.11: 042_auto_rerun.sql,
// runs/autoRun.ts, jobs/handlers/rerun.ts, runs/execute.ts trimRuns,
// publish/autoPublish.ts): the setting gate, the debounce and its maximum
// wait, the dedupe, who may queue one, the auto run itself, the storage cap
// that keeps only the newest unkept auto run, and the opt-in auto-publish;
// and the scheduled forecast run a forecast feed's new days queue (WP-2.12).
//
// Runs under a skewed machine zone (CLAUDE.md rule 7): the debounce is
// timestamptz arithmetic and the label's day is a calendar day, so neither
// may move with it. DB test files run one at a time, so a tick here sees only
// this file's jobs.
process.env.TZ = 'Pacific/Kiritimati';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { FIXTURE_CELL } from '../feeds/fixtures.js';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { fetchWindow, utcToday } from '../feeds/fetch.js';
import { ingestResult } from '../feeds/ingest.js';
import { feedForJob } from '../feeds/store.js';
import { runTick } from '../jobs/runner.js';
import { onSeriesDaysChanged } from '../series/newData.js';
import { AUTO_RUN_MAX_WAIT_MINUTES, enqueueRerun, resolveAutoRun } from './autoRun.js';
import { executeRun, trimRuns } from './execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(() => vi.unstubAllEnvs());

const MIN = 60_000;

/** A project the engine can run (the jobs.db.test.ts fixture), with a farm so a run can be published. */
async function runnable(u: User, autoRun?: Record<string, unknown>) {
	const projectId = (await u.call('POST', '/projects', { name: 'Auto' })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 400 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	if (autoRun) expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { autoRun } })).status).toBe(200);
	return projectId;
}

/** Merge days into the catchment rain, as the Add data dialog does. */
const merge = (u: User, pid: string, startDate: string, values: number[]) =>
	u.call('POST', `/projects/${pid}/series/merge`, { kind: 'rain_catchment_mm', unit: 'mm', startDate, values });

const rerunJobs = async (pid: string) =>
	(await asOwner(
		`SELECT id, status, run_after, created_at, payload, acting_user_id FROM job WHERE project_id = $1 AND kind = 'rerun' ORDER BY created_at`,
		[pid]
	)) as { id: string; status: string; run_after: Date; created_at: Date; payload: Record<string, unknown>; acting_user_id: string }[];

const runs = async (pid: string) =>
	(await asOwner(`SELECT id, label, trigger, pinned FROM model_run WHERE project_id = $1 ORDER BY created_at, id`, [pid])) as {
		id: string;
		label: string;
		trigger: string;
		pinned: boolean;
	}[];

/** Make the project's pending re-run due now (tests can't wait out a debounce). */
const makeDue = (pid: string) => asOwner(`UPDATE job SET run_after = now() - interval '1 second' WHERE project_id = $1 AND kind = 'rerun' AND status = 'queued'`, [pid]);

describe('the new-data hook: gate, debounce and dedupe', () => {
	it('queues nothing while automatic runs are off (the default), and one re-run when on', async () => {
		const u = await signUp('AutoOff');
		const pid = await runnable(u);
		const res = await merge(u, pid, '2021-02-04', [3, 4]);
		expect(res.status).toBe(200);
		expect(res.body.rerunQueuedFor).toBeNull();
		expect(await rerunJobs(pid)).toHaveLength(0);
		expect((await u.call('GET', `/projects/${pid}`)).body.project).toMatchObject({ rerunQueuedFor: null, settings: { autoRun: { enabled: false, debounceMinutes: 15, publish: 'never' } } });

		// Positive control: turned on, the same kind of merge queues one.
		expect((await u.call('PATCH', `/projects/${pid}`, { settings: { autoRun: { enabled: true } } })).status).toBe(200);
		const on = await merge(u, pid, '2021-02-06', [5]);
		const jobs = await rerunJobs(pid);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({ status: 'queued', payload: { label: '', trigger: 'auto', cause: 'series' }, acting_user_id: u.id });
		expect(on.body.rerunQueuedFor).toBe(jobs[0]!.run_after.toISOString());
		// Due about 15 minutes out (the default debounce).
		const wait = jobs[0]!.run_after.getTime() - Date.now();
		expect(wait).toBeGreaterThan(14 * MIN);
		expect(wait).toBeLessThanOrEqual(15 * MIN);
		// The project says when, for the header.
		expect((await u.call('GET', `/projects/${pid}`)).body.project.rerunQueuedFor).toBe(on.body.rerunQueuedFor);
		await retirePendingJobs(pid);
	});

	it('an idempotent re-send queues nothing (no day changed)', async () => {
		const u = await signUp('AutoSame');
		const pid = await runnable(u, { enabled: true });
		await merge(u, pid, '2021-02-04', [3, 4]);
		const [job] = await rerunJobs(pid);
		await asOwner(`DELETE FROM job WHERE id = $1`, [job!.id]);
		const again = await merge(u, pid, '2021-02-04', [3, 4]);
		expect(again.body.rerunQueuedFor).toBeNull();
		expect(await rerunJobs(pid)).toHaveLength(0);
	});

	it('turning it on changes no input: the Runs tab’s "inputs changed" (updatedAt) stays put', async () => {
		const u = await signUp('AutoStamp');
		const pid = await runnable(u);
		const before = (await u.call('GET', `/projects/${pid}`)).body.project.updatedAt;
		await u.call('PATCH', `/projects/${pid}`, { settings: { autoRun: { enabled: true } } });
		expect((await u.call('GET', `/projects/${pid}`)).body.project.updatedAt).toBe(before);
		// The Settings form sends every setting: the same holds when only autoRun differs.
		const { settings } = (await u.call('GET', `/projects/${pid}`)).body.project;
		expect((await u.call('PATCH', `/projects/${pid}`, { settings: { ...settings, autoRun: { ...settings.autoRun, debounceMinutes: 5 } } })).status).toBe(200);
		const after = (await u.call('GET', `/projects/${pid}`)).body.project;
		expect(after.settings.autoRun).toEqual({ enabled: true, debounceMinutes: 5, publish: 'never' });
		expect(after.updatedAt).toBe(before);
		// Positive control: a model setting does move it.
		await u.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(151) } });
		expect((await u.call('GET', `/projects/${pid}`)).body.project.updatedAt > before).toBe(true);
	});

	it('three merges within the debounce make one job, pushed back each time, and one auto run', async () => {
		const u = await signUp('AutoThree');
		const pid = await runnable(u, { enabled: true, debounceMinutes: 30 });
		const due: string[] = [];
		for (const [i, day] of ['2021-02-04', '2021-02-05', '2021-02-06'].entries()) {
			const r = await merge(u, pid, day, [i + 1]);
			expect(r.status).toBe(200);
			due.push(r.body.rerunQueuedFor);
		}
		const jobs = await rerunJobs(pid);
		expect(jobs).toHaveLength(1);
		// Each merge moved it later (never earlier), and it is the one the last merge named.
		expect(Date.parse(due[1]!)).toBeGreaterThanOrEqual(Date.parse(due[0]!));
		expect(Date.parse(due[2]!)).toBeGreaterThanOrEqual(Date.parse(due[1]!));
		expect(jobs[0]!.run_after.toISOString()).toBe(due[2]);

		// Not due: a tick leaves it.
		await runTick();
		expect((await rerunJobs(pid))[0]!.status).toBe('queued');
		expect(await runs(pid)).toHaveLength(0);

		await makeDue(pid);
		await runTick();
		expect((await rerunJobs(pid))[0]!.status).toBe('done');
		// One auto run, labelled with the last observed day (2020-01-01 + 399 days = 2021-02-03, merged to 2021-02-06).
		expect(await runs(pid)).toEqual([expect.objectContaining({ label: 'Auto · data to 2021-02-06', trigger: 'auto' })]);
		const list = (await u.call('GET', `/projects/${pid}/runs`)).body.runs as { trigger: string }[];
		expect(list.map((r) => r.trigger)).toEqual(['auto']);
		const [created] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'run.created'`, [pid]);
		expect(created.subject).toMatchObject({ trigger: 'auto', label: 'Auto · data to 2021-02-06' });
	});

	it('caps the wait: a constantly-fed project runs no later than 2 h after the first new data', async () => {
		const u = await signUp('AutoCap');
		const pid = await runnable(u, { enabled: true, debounceMinutes: 30 });
		await merge(u, pid, '2021-02-04', [1]);
		// The first data arrived 110 minutes ago; another merge now would push the run 30 minutes out, past the cap.
		await asOwner(`UPDATE job SET created_at = now() - interval '110 minutes' WHERE project_id = $1 AND kind = 'rerun'`, [pid]);
		const r = await merge(u, pid, '2021-02-05', [2]);
		const [job] = await rerunJobs(pid);
		expect(job!.run_after.getTime()).toBe(job!.created_at.getTime() + AUTO_RUN_MAX_WAIT_MINUTES * MIN);
		expect(r.body.rerunQueuedFor).toBe(job!.run_after.toISOString());
		// Positive control: well inside the cap, the debounce wins.
		await asOwner(`UPDATE job SET created_at = now() - interval '10 minutes' WHERE project_id = $1 AND kind = 'rerun'`, [pid]);
		await merge(u, pid, '2021-02-06', [3]);
		const [pushed] = await rerunJobs(pid);
		const wait = pushed!.run_after.getTime() - Date.now();
		expect(wait).toBeGreaterThan(29 * MIN);
		expect(wait).toBeLessThanOrEqual(30 * MIN);
		await retirePendingJobs(pid);
	});

	it('leaves a pending manual re-run as it is (it reads the new data too), and queues a new one behind a running re-run', async () => {
		const u = await signUp('AutoManual');
		const pid = await runnable(u, { enabled: true });
		const manual = await u.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun', label: 'Nightly' });
		expect(manual.status).toBe(202);
		const r = await merge(u, pid, '2021-02-04', [1]);
		const jobs = await rerunJobs(pid);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]!.payload).toEqual({ label: 'Nightly' });
		expect(r.body.rerunQueuedFor).toBe(manual.body.job.runAfter ? new Date(manual.body.job.runAfter).toISOString() : null);

		// While a re-run runs, new data queues another (the claim holds it back until the first finishes).
		await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '5 minutes', lease_token = gen_random_uuid() WHERE id = $1`, [jobs[0]!.id]);
		await merge(u, pid, '2021-02-05', [2]);
		const after = await rerunJobs(pid);
		expect(after.map((j) => j.status)).toEqual(['running', 'queued']);
		expect(after[1]!.payload).toMatchObject({ trigger: 'auto' });
		await retirePendingJobs(pid);
	});

	it('a client can’t queue an auto re-run itself', async () => {
		const u = await signUp('AutoForge');
		const pid = await runnable(u, { enabled: true });
		expect((await u.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun', trigger: 'auto' })).status).toBe(400);
		expect((await u.call('POST', `/projects/${pid}/jobs`, { kind: 'rerun', cause: 'feed' })).status).toBe(400);
		expect(await rerunJobs(pid)).toHaveLength(0);
	});

	it('only an editor can queue one: viewers and strangers are refused, the editor is not', async () => {
		const owner = await signUp('AutoWho');
		const viewer = await signUp('AutoViewer');
		const stranger = await signUp('AutoStranger');
		const pid = await runnable(owner, { enabled: true });
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		await expect(withUser(viewer.id, (db) => enqueueRerun(db, pid, 'series'))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(stranger.id, (db) => enqueueRerun(db, pid, 'series'))).rejects.toMatchObject({ code: '42501' });
		// No user and no API key: nobody to run it as.
		await expect(withoutUser((db) => enqueueRerun(db, pid, 'ingest'))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => enqueueRerun(db, pid, 'bogus' as 'series'))).rejects.toMatchObject({ code: '22023' });
		// A plain insert with no user is still refused (job_enqueue, as in 016).
		await expect(withoutUser((db) => db.query(`INSERT INTO job (project_id, kind, acting_user_id) VALUES ($1, 'rerun', $2)`, [pid, owner.id]))).rejects.toMatchObject({
			code: '42501'
		});
		expect(await rerunJobs(pid)).toHaveLength(0);
		// Positive control.
		const q = await withUser(owner.id, (db) => enqueueRerun(db, pid, 'series'));
		expect(q).toMatchObject({ created: true });
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
	});

	it('an auto re-run whose project turned automatic runs off since does nothing', async () => {
		const u = await signUp('AutoLater');
		const pid = await runnable(u, { enabled: true });
		await merge(u, pid, '2021-02-04', [1]);
		await u.call('PATCH', `/projects/${pid}`, { settings: { autoRun: { enabled: false } } });
		await makeDue(pid);
		await runTick();
		expect((await rerunJobs(pid))[0]!.status).toBe('done');
		expect(await runs(pid)).toHaveLength(0);
	});

	it('a debounce of 0 is due at once', async () => {
		const u = await signUp('AutoNow');
		const pid = await runnable(u, { enabled: true, debounceMinutes: 0 });
		const r = await merge(u, pid, '2021-02-04', [1]);
		expect(Date.parse(r.body.rerunQueuedFor)).toBeLessThanOrEqual(Date.now());
		await runTick();
		expect(await runs(pid)).toEqual([expect.objectContaining({ trigger: 'auto' })]);
	});

	it('PUT (a whole-series upload) is new data too; a data feed’s merge is, as the feed’s acting user', async () => {
		const u = await signUp('AutoFeed');
		const pid = await runnable(u, { enabled: true });
		const put = await u.call('PUT', `/projects/${pid}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2020-01-01', values: [0.1, 0.2] });
		expect(put.status).toBe(200);
		expect(put.body.rerunQueuedFor).toEqual(expect.any(String));
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);

		const feedId = (await u.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ ...FIXTURE_CELL(), weight: 1 }] } })).body.feed.id as string;
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
		const ingest = (values: (number | null)[]) =>
			withUser(u.id, async (db) => ingestResult(db, (await feedForJob(db, pid, feedId))!, { ok: true, startDate: '2026-01-01', values, meta: {} }, { start: '1850-01-01', end: utcToday() }));
		await ingest([1, 2]);
		const jobs = await rerunJobs(pid);
		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({ payload: { trigger: 'auto', cause: 'feed' }, acting_user_id: u.id });
		// The same answer again changes no day, so it doesn't push the re-run back.
		const before = jobs[0]!.run_after.getTime();
		await asOwner(`UPDATE job SET run_after = run_after - interval '5 minutes' WHERE id = $1`, [jobs[0]!.id]);
		await ingest([1, 2]);
		expect((await rerunJobs(pid))[0]!.run_after.getTime()).toBe(before - 5 * MIN);
		await asOwner('DELETE FROM data_feed WHERE project_id = $1', [pid]);
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
	});

	it('the hook returns null when off or when no day changed, and the due time when on', async () => {
		const u = await signUp('AutoHook');
		const pid = await runnable(u);
		const change = { seriesId: crypto.randomUUID(), kind: 'rain_catchment_mm', name: '', daysChanged: 3, via: 'api_key' as const };
		expect(await withUser(u.id, (db) => onSeriesDaysChanged(db, pid, change))).toBeNull();
		expect(await rerunJobs(pid)).toHaveLength(0);
		await u.call('PATCH', `/projects/${pid}`, { settings: { autoRun: { enabled: true } } });
		expect(await withUser(u.id, (db) => onSeriesDaysChanged(db, pid, { ...change, daysChanged: 0 }))).toBeNull();
		expect(await rerunJobs(pid)).toHaveLength(0);
		// Positive control: on, with days changed.
		const due = await withUser(u.id, (db) => onSeriesDaysChanged(db, pid, change));
		const [job] = await rerunJobs(pid);
		expect(due).toBe(job!.run_after.toISOString());
		expect(job!.payload).toMatchObject({ trigger: 'auto', cause: 'ingest' });
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
	});

	it('the enqueue reads the setting with the same defaults as resolveAutoRun', async () => {
		const u = await signUp('AutoDefaults');
		const pid = await runnable(u);
		// Stored shapes the API would refuse, written straight in: each field falls back on its own, in SQL as in TS.
		for (const [stored, queued] of [
			[{ enabled: true }, true],
			[{ enabled: true, debounceMinutes: 500 }, true],
			[{ enabled: true, debounceMinutes: 7.5 }, true],
			[{ enabled: true, debounceMinutes: 'soon' }, true],
			[{ enabled: true, debounceMinutes: 42 }, true],
			[{ enabled: 'true' }, false],
			[{ debounceMinutes: 5 }, false],
			['on', false]
		] as const) {
			await asOwner(`UPDATE project SET settings = jsonb_set(settings, '{autoRun}', $2::jsonb) WHERE id = $1`, [pid, JSON.stringify(stored)]);
			const resolved = resolveAutoRun({ autoRun: stored });
			// due_at is stamped by Postgres's clock, which can run a few ms off this process's (docker's VM), so bound it by the database's own time.
			const dbNow = async () => ((await asOwner('SELECT clock_timestamp() AS t'))[0] as { t: Date }).t.getTime();
			const t0 = await dbNow();
			const q = await withUser(u.id, (db) => enqueueRerun(db, pid, 'series'));
			const t1 = await dbNow();
			expect(!!q, JSON.stringify(stored)).toBe(queued);
			expect(resolved.enabled, JSON.stringify(stored)).toBe(queued);
			if (q) {
				const due = Date.parse(q.runAfter);
				expect(due, JSON.stringify(stored)).toBeGreaterThanOrEqual(t0 + resolved.debounceMinutes * MIN);
				expect(due, JSON.stringify(stored)).toBeLessThanOrEqual(t1 + resolved.debounceMinutes * MIN);
			}
			await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
		}
	});

});

describe('trimRuns with auto runs', () => {
	it('keeps the newest auto run, manual runs, and pinned, cited or published auto runs; deletes older unkept auto runs', async () => {
		const u = await signUp('AutoTrim');
		const pid = await runnable(u);
		const auto = () => withUser(u.id, async (db) => (await executeRun(db, pid, 'auto', 'auto')).id);
		const manual = (await u.call('POST', `/projects/${pid}/runs`, { label: 'Modeller' })).body.run.id as string;
		const oldAuto = await auto();
		const pinnedAuto = await auto();
		expect((await u.call('PATCH', `/projects/${pid}/runs/${pinnedAuto}`, { pinned: true })).status).toBe(200);
		const publishedAuto = await auto();
		expect((await u.call('POST', `/projects/${pid}/publication`, { runId: publishedAuto })).status).toBe(201);
		const citedAuto = await auto();
		expect((await u.call('POST', `/projects/${pid}/scenarios`, { name: 'Base on auto', baseRunId: citedAuto, ops: [] })).status).toBe(201);
		const middle = await auto();
		const newest = await auto();

		const removed = await withUser(u.id, (db) => trimRuns(db, pid));
		// Positive control: the older unkept auto runs go.
		expect(removed.sort()).toEqual([oldAuto, middle].sort());
		const left = (await runs(pid)).map((r) => r.id);
		for (const id of [manual, pinnedAuto, publishedAuto, citedAuto, newest]) expect(left).toContain(id);
		expect(left).toHaveLength(5);
	});

	it('never lets auto runs push out a manual run: the manual cap counts manual runs only', async () => {
		const u = await signUp('AutoCapRuns');
		const pid = await runnable(u);
		const m1 = (await u.call('POST', `/projects/${pid}/runs`, { label: 'one' })).body.run.id as string;
		const m2 = (await u.call('POST', `/projects/${pid}/runs`, { label: 'two' })).body.run.id as string;
		for (let i = 0; i < 3; i++) await withUser(u.id, (db) => executeRun(db, pid, 'auto', 'auto'));
		// A cap of 2 manual runs: both stay, whatever the auto runs did; one auto run is left.
		await withUser(u.id, (db) => trimRuns(db, pid, 2));
		const left = await runs(pid);
		expect(left.filter((r) => r.trigger === 'manual').map((r) => r.id)).toEqual([m1, m2]);
		expect(left.filter((r) => r.trigger === 'auto')).toHaveLength(1);
		// Positive control: the manual cap still applies to manual runs.
		await withUser(u.id, (db) => trimRuns(db, pid, 1));
		expect((await runs(pid)).filter((r) => r.trigger === 'manual').map((r) => r.id)).toEqual([m2]);
	});
});

describe('auto-publish (settings.autoRun.publish)', () => {
	async function published(pid: string) {
		return (await asOwner(`SELECT run_id, note, restriction_level, restriction_pct, notice FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL`, [pid]))[0] as
			| { run_id: string; note: string; restriction_level: string; restriction_pct: string | null; notice: Record<string, string> }
			| undefined;
	}

	it('never publishes by default: publication stays a person’s act', async () => {
		const u = await signUp('PubNever');
		const pid = await runnable(u, { enabled: true, debounceMinutes: 0 });
		const first = (await u.call('POST', `/projects/${pid}/runs`, { label: 'baseline' })).body.run.id as string;
		expect((await u.call('POST', `/projects/${pid}/publication`, { runId: first })).status).toBe(201);
		await merge(u, pid, '2021-02-04', [1]);
		await runTick();
		expect((await runs(pid)).some((r) => r.trigger === 'auto')).toBe(true);
		expect((await published(pid))!.run_id).toBe(first);
	});

	it('if_no_new_warnings: replaces the current publication, carrying the WUA’s notice over', async () => {
		const u = await signUp('PubAuto');
		const pid = await runnable(u, { enabled: true, debounceMinutes: 0, publish: 'if_no_new_warnings' });
		const first = (await u.call('POST', `/projects/${pid}/runs`, { label: 'baseline' })).body.run.id as string;
		const restriction = { level: 'restricted', pct: 20, notice: { en: 'Irrigate at night only' } };
		expect((await u.call('POST', `/projects/${pid}/publication`, { runId: first, restriction })).status).toBe(201);
		// Published at 22:30 UTC: the next day in South Africa, the day the note names (the project's zone, 058).
		await asOwner(`UPDATE run_publication SET published_at = '2026-09-25T22:30:00Z' WHERE project_id = $1 AND superseded_at IS NULL`, [pid]);
		await merge(u, pid, '2021-02-04', [1]);
		await runTick();
		const autoRun = (await runs(pid)).find((r) => r.trigger === 'auto')!;
		const now = await published(pid);
		expect(now).toMatchObject({ run_id: autoRun.id, restriction_level: 'restricted', notice: { en: 'Irrigate at night only' } });
		expect(Number(now!.restriction_pct)).toBe(20);
		expect(now!.note).toMatch(/^Published automatically: .* the run published on 2026-09-26 didn't\.$/);
		const [audit] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'publication.published' ORDER BY created_at DESC, id DESC LIMIT 1`, [pid]);
		// The decision log (issue #119) records the notice it carried over and the auto run's own figures.
		expect(audit.subject).toMatchObject({ runId: autoRun.id, auto: true, restriction: { level: 'restricted', pct: 20, notice: { en: 'Irrigate at night only' } }, note: now!.note });
		expect(audit.subject.perFarm).toHaveLength(audit.subject.farms);
	});

	it('if_no_new_warnings: never makes the first publication, and holds back a run with a new warning', async () => {
		const u = await signUp('PubHeld');
		const pid = await runnable(u, { enabled: true, debounceMinutes: 0, publish: 'if_no_new_warnings' });
		await merge(u, pid, '2021-02-04', [1]);
		await runTick();
		expect((await runs(pid)).some((r) => r.trigger === 'auto')).toBe(true);
		expect(await published(pid)).toBeUndefined();

		const first = (await u.call('POST', `/projects/${pid}/runs`, { label: 'baseline' })).body.run.id as string;
		expect((await u.call('POST', `/projects/${pid}/publication`, { runId: first })).status).toBe(201);
		// A new warning: an invalid stored data-quality setting is a run warning
		// (engine resolveDataQuality) the published run didn't have.
		await asOwner(`UPDATE project SET settings = jsonb_set(settings, '{dataQuality}', '{"agreementMinDays": 0}'::jsonb) WHERE id = $1`, [pid]);
		await merge(u, pid, '2021-02-05', [2]);
		await runTick();
		const autos = (await runs(pid)).filter((r) => r.trigger === 'auto');
		const [warned] = await asOwner(`SELECT summary->'warnings' AS w FROM model_run WHERE id = $1`, [autos.at(-1)!.id]);
		expect((warned.w as string[]).length).toBeGreaterThan(0);
		expect((await published(pid))!.run_id).toBe(first);
	});
});

describe('scheduled forecast runs (a forecast feed’s new days, WP-2.12)', () => {
	const day = (n: number) => fromEpochDay(toEpochDay(utcToday()) + n);
	/** A whole 16-day CHIRPS-GEFS issue from `issued` days after today (≤ 0: its 16th day can't pass today + 15), every day `mm`. */
	const issue = (issued: number, mm: number) => ({ ok: true, startDate: day(issued), values: new Array(16).fill(mm), meta: { days: 16, issued: day(issued) } });

	/** A runnable project whose observed rain reaches `observedTo` days after today, with a CHIRPS-GEFS feed. */
	async function gefsProject(name: string, autoRun?: Record<string, unknown>, observedTo = -1) {
		const u = await signUp(name);
		const pid = await runnable(u, autoRun);
		const rain = Array.from({ length: 400 }, (_, i) => (i % 5 === 0 ? 10 : 0));
		expect((await u.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: day(observedTo - 399), values: rain })).status).toBe(200);
		const feedId = (await u.call('POST', `/projects/${pid}/feeds`, { source: 'chirps_gefs', config: { cells: [{ ...FIXTURE_CELL(), weight: 1 }] } })).body.feed.id as string;
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
		// Just scheduled, so a tick doesn't fetch the fixture issue itself: the test ingests the issues it wants.
		await asOwner(`UPDATE data_feed SET last_scheduled_at = now() WHERE id = $1`, [feedId]);
		// As the feed_ingest handler does: read the feed, then ingest, in one transaction as the feed's acting user.
		const ingest = (raw: unknown) =>
			withUser(u.id, async (db) => {
				const feed = (await feedForJob(db, pid, feedId))!;
				return ingestResult(db, feed, raw, fetchWindow('chirps_gefs', feed.config, feed.lastDataDate, utcToday()));
			});
		return { u, pid, ingest };
	}
	const forecastJobs = async (pid: string) =>
		(await asOwner(`SELECT id, status, run_after, payload, acting_user_id FROM job WHERE project_id = $1 AND dedupe_key = 'forecast' ORDER BY created_at`, [pid])) as {
			id: string;
			status: string;
			run_after: Date;
			payload: Record<string, unknown>;
			acting_user_id: string;
		}[];
	const makeForecastDue = (pid: string) => asOwner(`UPDATE job SET run_after = now() - interval '1 second' WHERE project_id = $1 AND dedupe_key = 'forecast' AND status = 'queued'`, [pid]);
	const forecastRuns = async (pid: string) => (await runs(pid)).filter((r) => r.trigger === 'forecast');
	const cleanUp = async (pid: string) => {
		await asOwner('DELETE FROM data_feed WHERE project_id = $1', [pid]);
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
	};

	it('queues nothing while automatic runs are off; on, one forecast run per project that runs as a forecast run', async () => {
		const off = await gefsProject('ForecastOff');
		await off.ingest(issue(0, 4));
		expect(await forecastJobs(off.pid)).toHaveLength(0);
		await cleanUp(off.pid);

		// Positive control: automatic runs on.
		const { u, pid, ingest } = await gefsProject('ForecastOn', { enabled: true, debounceMinutes: 30 });
		const before = Date.now();
		await ingest(issue(-1, 4));
		const [job] = await forecastJobs(pid);
		expect(job).toMatchObject({ status: 'queued', payload: { trigger: 'forecast', cause: 'feed' }, acting_user_id: u.id });
		// The re-run's debounce.
		expect(job!.run_after.getTime()).toBeGreaterThanOrEqual(before + 29 * MIN);
		// A newer issue before it runs joins it: still one pending forecast run. The auto re-run is its own job.
		expect((await ingest(issue(0, 6))).merged).toBe(16);
		expect(await forecastJobs(pid)).toHaveLength(1);
		expect(await rerunJobs(pid)).toHaveLength(2);

		await makeForecastDue(pid);
		await runTick();
		expect((await forecastJobs(pid))[0]!.status).toBe('done');
		// Observed rain to yesterday, so the forecast starts today.
		expect(await forecastRuns(pid)).toEqual([expect.objectContaining({ label: `Forecast · from ${day(0)}`, trigger: 'forecast' })]);
		const [run] = await asOwner(`SELECT summary->'forecast'->>'from' AS "from" FROM model_run WHERE project_id = $1 AND trigger = 'forecast'`, [pid]);
		expect(run.from).toBe(day(0));
		await cleanUp(pid);
	});

	it('keeps one forecast run: the next issue’s run replaces the last, and never pushes out a manual run', async () => {
		const { u, pid, ingest } = await gefsProject('ForecastPile', { enabled: true, debounceMinutes: 0 });
		expect((await u.call('POST', `/projects/${pid}/runs`, { label: 'Manual' })).status).toBe(201);
		for (const n of [-2, -1, 0]) {
			expect(await ingest(issue(n, n + 3)), `issue ${n}`).toMatchObject({ merged: 16 });
			await makeForecastDue(pid);
			await runTick();
		}
		expect((await forecastJobs(pid)).map((j) => j.status)).toEqual(['done', 'done', 'done']);
		const kept = await forecastRuns(pid);
		expect(kept).toHaveLength(1);
		const [newest] = await asOwner(`SELECT id FROM model_run WHERE project_id = $1 AND trigger = 'forecast' ORDER BY created_at DESC LIMIT 1`, [pid]);
		expect(kept[0]!.id).toBe(newest.id);
		expect((await runs(pid)).filter((r) => r.trigger === 'manual').map((r) => r.label)).toEqual(['Manual']);
		await cleanUp(pid);
	});

	it('does nothing when automatic runs were turned off since, or when no forecast day is left after the observed rain', async () => {
		const later = await gefsProject('ForecastLater', { enabled: true });
		await later.ingest(issue(0, 4));
		await later.u.call('PATCH', `/projects/${later.pid}`, { settings: { autoRun: { enabled: false } } });
		await makeForecastDue(later.pid);
		await runTick();
		expect((await forecastJobs(later.pid))[0]!.status).toBe('done');
		expect(await forecastRuns(later.pid)).toHaveLength(0);
		await cleanUp(later.pid);

		// Observed rain reaches past the whole issue: nothing to forecast, and the job is done, not dead.
		const overtaken = await gefsProject('ForecastOvertaken', { enabled: true }, 20);
		await overtaken.ingest(issue(0, 4));
		await makeForecastDue(overtaken.pid);
		await runTick();
		expect((await forecastJobs(overtaken.pid))[0]!.status).toBe('done');
		expect(await forecastRuns(overtaken.pid)).toHaveLength(0);
		await cleanUp(overtaken.pid);
	});

	it('new recorded rain re-makes a forecast run that ran those days as dry; observed flow does not', async () => {
		// Rain recorded to 5 days ago: the forecast run's history runs 4 blank days as dry before today's issue.
		const { u, pid, ingest } = await gefsProject('ForecastFollowsRain', { enabled: true, debounceMinutes: 0 }, -5);
		await ingest(issue(0, 4));
		await runTick();
		await runTick();
		const lastObserved = async () =>
			(
				(await asOwner(
					`SELECT summary->'forecast'->>'lastObserved' AS last FROM model_run WHERE project_id = $1 AND trigger = 'forecast' ORDER BY created_at DESC LIMIT 1`,
					[pid]
				)) as { last: string }[]
			)[0]?.last;
		expect(await lastObserved()).toBe(day(-5));
		const made = (await forecastJobs(pid)).length;

		// Observed flow only scores a run: the auto re-run runs, the forecast run stays.
		expect((await u.call('PUT', `/projects/${pid}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: day(-30), values: new Array(30).fill(0.2) })).status).toBe(200);
		await runTick();
		await runTick();
		expect(await forecastJobs(pid)).toHaveLength(made);
		expect(await lastObserved()).toBe(day(-5));

		// Positive control: the logger's missing 4 days arrive (a person's merge here; a key's or a feed's is the same auto re-run).
		expect((await merge(u, pid, day(-4), [0, 3, 0, 1])).status).toBe(200);
		await runTick();
		await runTick();
		expect(await forecastJobs(pid)).toHaveLength(made + 1);
		expect(await lastObserved()).toBe(day(-1));
		expect(await forecastRuns(pid)).toHaveLength(1);
		await cleanUp(pid);
	});

	it('only a forecast feed queues one: observed data, a person’s forecast upload and an API key’s push do not', async () => {
		const u = await signUp('ForecastOnlyFeed');
		const pid = await runnable(u, { enabled: true });
		const change = { seriesId: crypto.randomUUID(), kind: 'rain_forecast_mm', name: '', daysChanged: 3 };
		for (const c of [
			{ ...change, kind: 'rain_chirps_mm', via: 'feed' as const },
			{ ...change, via: 'user' as const },
			{ ...change, via: 'api_key' as const },
			{ ...change, via: 'feed' as const, daysChanged: 0 }
		]) {
			await withUser(u.id, (db) => onSeriesDaysChanged(db, pid, c));
			expect(await forecastJobs(pid), JSON.stringify(c)).toHaveLength(0);
		}
		// Positive control.
		await withUser(u.id, (db) => onSeriesDaysChanged(db, pid, { ...change, via: 'feed' }));
		expect(await forecastJobs(pid)).toHaveLength(1);
		await asOwner(`DELETE FROM job WHERE project_id = $1`, [pid]);
	});
});
