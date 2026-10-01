// A deleted note's text is erased 90 days after it was deleted, with its
// earlier texts, by the job tick (158_note_purge.sql, jobs/runner.ts
// DELETED_NOTE_RETENTION_DAYS; docs/data-model.md § Notes). A note on a
// licence record (a scenario or evidence pack past draft) is kept, hidden;
// a note that was never deleted is never touched (positive control); and the
// note.deleted audit event outlives the purge.
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { DELETED_NOTE_RETENTION_DAYS, runTick } from '../jobs/runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let projectId: string;
let runId: string;
const outlet = node('Outlet', null);
const farm = node('Farm Purge', outlet.id);
const ids: Record<string, string> = {};

/** Test state past the guards, as the schema owner with triggers off (notices.db.test.ts's `arrange`). */
async function arrange(fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<void>): Promise<void> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
		await client.query('COMMIT');
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		await client.end();
	}
}

const purge = (days = DELETED_NOTE_RETENTION_DAYS) => withoutUser(async (db) => (await db.query<{ n: number }>('SELECT app_purge_deleted_notes(make_interval(days => $1)) AS n', [days])).rows[0]!.n);
const exists = async (noteId: string) => (await asOwner('SELECT 1 FROM note WHERE id = $1', [noteId])).length === 1;
const revisions = async (noteId: string) => (await asOwner('SELECT count(*)::int AS n FROM note_revision WHERE note_id = $1', [noteId]))[0]!.n as number;

beforeAll(async () => {
	owner = await signUp('NpOwner');
	projectId = (await owner.call('POST', '/projects', { name: 'Note purge' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: 40 }, (_, i) => (i % 6 === 0 ? 18 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	runId = (await owner.call('POST', `/projects/${projectId}/runs`, { label: 'purge' })).body.run.id;

	// A note deleted through the API, so its note.deleted event is real; aged below.
	const viaApi = await owner.call('POST', `/projects/${projectId}/notes`, { body: 'Logger moved in March', nodeId: farm.id });
	expect(viaApi.status).toBe(201);
	ids.viaApi = viaApi.body.note.id;
	expect((await owner.call('DELETE', `/projects/${projectId}/notes/${ids.viaApi}`)).status).toBe(204);

	await arrange(async (q) => {
		const one = async (sql: string, params: unknown[]) => (await q(sql, params))[0]!.id as string;
		const scenario = (name: string, status: string) =>
			one(
				`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin, status, submitted_at)
				 VALUES ($1, $2, $3, repeat('a', 64), $4, 'applicant', $5, CASE WHEN $5 = 'draft' THEN NULL ELSE now() END) RETURNING id`,
				[projectId, name, runId, owner.id, status]
			);
		const pack = (status: string, version: number) =>
			one(
				`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, status, issued_at, manifest, manifest_sha256, report_version, engine_version, created_by)
				 VALUES ($7, $1, $2, $3, $4, CASE WHEN $4 = 'draft' THEN NULL ELSE now() END, '{}', $5, 'x', 'x', $6) RETURNING id`,
				[projectId, runId, version, status, crypto.randomUUID().replace(/-/g, '').padEnd(64, '0'), owner.id, crypto.randomUUID()]
			);
		const draftScenario = await scenario('Draft application', 'draft');
		const submitted = await scenario('Submitted application', 'submitted');
		const decided = await scenario('Decided application', 'decided');
		const draftPack = await pack('draft', 1);
		const issued = await pack('issued', 1);
		// deleted_at as days ago (null: never deleted); a scenario or pack note carries one earlier text.
		const note = async (body: string, daysAgo: number | null, target: { scenarioId?: string; packId?: string } = {}) => {
			const id = await one(
				`INSERT INTO note (project_id, author_id, body, visibility, scenario_id, pack_id, deleted_at, deleted_by)
				 VALUES ($1, $2::uuid, $3, 'team', $4, $5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(days => $6::int) END,
				   CASE WHEN $6::int IS NULL THEN NULL ELSE $2::uuid END) RETURNING id`,
				[projectId, owner.id, body, target.scenarioId ?? null, target.packId ?? null, daysAgo]
			);
			if (target.scenarioId || target.packId) {
				await q(`INSERT INTO note_revision (note_id, project_id, body, written_at, edited_by) VALUES ($1, $2, 'earlier text', now() - interval '200 days', $3)`, [id, projectId, owner.id]);
			}
			return id;
		};
		ids.old = await note('Deleted 91 days ago', 91);
		ids.recent = await note('Deleted 89 days ago', 89);
		ids.live = await note('Never deleted, written long ago', null);
		ids.oldDraftScenario = await note('On a draft application, deleted 91 days ago', 91, { scenarioId: draftScenario });
		ids.oldDraftPack = await note('On a draft pack, deleted 91 days ago', 91, { packId: draftPack });
		ids.submitted = await note('On a submitted application, deleted 1000 days ago', 1000, { scenarioId: submitted });
		ids.decided = await note('On a decided application, deleted 1000 days ago', 1000, { scenarioId: decided });
		ids.issued = await note('On an issued pack, deleted 1000 days ago', 1000, { packId: issued });
		await q(`UPDATE note SET created_at = now() - interval '2000 days' WHERE id = $1`, [ids.live]);
		await q(`UPDATE note SET deleted_at = now() - interval '91 days' WHERE id = $1`, [ids.viaApi]);
	});
}, 60_000);

describe('app_purge_deleted_notes (158)', () => {
	it('refuses any caller but the worker, and an age under 30 days', async () => {
		await expect(withUser(owner.id, (db) => db.query("SELECT app_purge_deleted_notes(interval '90 days')"))).rejects.toMatchObject({ code: '42501' });
		await expect(purge(29)).rejects.toMatchObject({ code: '22023' });
		// water_app still can't delete a note itself (the definer function is the only path).
		await expect(withUser(owner.id, (db) => db.query('DELETE FROM note WHERE id = $1', [ids.live]))).rejects.toMatchObject({ code: '42501' });
	});

	it('erases a note deleted more than 90 days ago with its earlier texts, and keeps the rest', async () => {
		expect(await revisions(ids.oldDraftScenario!)).toBe(1);
		expect(await revisions(ids.submitted!)).toBe(1);
		// The tick runs the purge (and reports how many it erased); its other work is off.
		const tick = await runTick({ feeds: false, reports: false, alerts: false, maxJobs: 0 });
		expect(tick.notesPurged).toBeGreaterThanOrEqual(4);

		for (const gone of ['old', 'viaApi', 'oldDraftScenario', 'oldDraftPack']) expect(await exists(ids[gone] as string), gone).toBe(false);
		expect(await revisions(ids.oldDraftScenario!)).toBe(0);
		expect(await revisions(ids.oldDraftPack!)).toBe(0);

		// Kept: deleted 89 days ago, and the positive control, a note never deleted.
		expect(await exists(ids.recent!)).toBe(true);
		expect(await exists(ids.live!)).toBe(true);
		// Kept at 1 000 days: a licence record's notes (a scenario or pack past draft), with their earlier texts.
		for (const kept of ['submitted', 'decided', 'issued']) expect(await exists(ids[kept] as string), kept).toBe(true);
		expect(await revisions(ids.submitted!)).toBe(1);
		expect(await revisions(ids.issued!)).toBe(1);
		// Nothing left to purge on a second pass.
		expect(await purge()).toBe(0);
	});

	it('keeps the note.deleted event, which never held the text', async () => {
		const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'note.deleted' AND subject->>'noteId' = $2`, [projectId, ids.viaApi]);
		expect(events).toHaveLength(1);
		expect(JSON.stringify(events[0]!.subject)).not.toContain('Logger moved in March');
	});

	it('erases the 89-day-old note once it passes 90 days', async () => {
		await arrange(async (q) => void (await q(`UPDATE note SET deleted_at = now() - interval '90 days 1 hour' WHERE id = $1`, [ids.recent])));
		expect(await purge()).toBe(1);
		expect(await exists(ids.recent!)).toBe(false);
	});
});
