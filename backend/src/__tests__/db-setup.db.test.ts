// The per-file pending-job guard (db-setup.ts, pendingJobs.ts): it fails a file
// that leaves a job pending, names what was left, and retires the leftovers;
// the same for a pending notice email; it passes a file that leaves none (positive control); and it runs after the
// file's own afterAll, so a file's cleanup there counts.
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from './helpers.js';
import { assertNothingPending, GUARD_RAN } from './pendingJobs.js';
import { withUser } from '../db/tx.js';

async function withOwnerClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.end();
	}
}
const guard = () => withOwnerClient(assertNothingPending);

/** A project with an insert that queues a re-run in it as its owner; `status` then moves it (as the worker would). */
async function queued(projectName: string) {
	const u = await signUp('GuardProbe');
	const pid = (await u.call('POST', '/projects', { name: projectName })).body.project.id as string;
	const insert = async (status: 'queued' | 'failed') => {
		const id = await withUser(u.id, async (db) => (await db.query<{ id: string }>(`INSERT INTO job (project_id, kind) VALUES ($1, 'rerun') RETURNING id`, [pid])).rows[0]!.id);
		if (status === 'failed') await asOwner(`UPDATE job SET status = 'failed', attempts = 1 WHERE id = $1`, [id]);
		return id;
	};
	return { pid, uid: u.id, insert };
}
const statusOf = async (id: string) => (await asOwner('SELECT status FROM job WHERE id = $1', [id]))[0]?.status;

describe('the pending-job guard', () => {
	it('passes when nothing is pending, even with finished jobs in the table (positive control)', async () => {
		const { insert } = await queued('Guard finished');
		const id = await insert('queued');
		await asOwner(`UPDATE job SET status = 'done', finished_at = now() WHERE id = $1`, [id]);
		await expect(guard()).resolves.toBeUndefined();
		expect(await statusOf(id)).toBe('done');
	});

	it('fails on a queued or retrying job, naming its kind, status and project, and retires it', async () => {
		const { insert } = await queued('Guard leak');
		const a = await insert('queued');
		const b = await insert('failed');
		const err = await guard().then(
			() => null,
			(e: Error) => e
		);
		expect(err?.message).toContain('left pending jobs in the shared queue');
		expect(err?.message).toContain('1 × rerun (failed) in project "Guard leak"');
		expect(err?.message).toContain('1 × rerun (queued) in project "Guard leak"');
		// Retired, not deleted: the next file starts with nothing to claim.
		expect([await statusOf(a), await statusOf(b)]).toEqual(['done', 'done']);
		await expect(guard()).resolves.toBeUndefined();
	});

	it('fails on a pending notice email, naming its queue, status and project, and settles it', async () => {
		const { pid, uid } = await queued('Guard notice');
		await asOwner(`INSERT INTO erratum_notice (erratum_id, project_id, user_id, run_count) VALUES ('ER-999', $1, $2, 1)`, [pid, uid]);
		const err = await guard().then(
			() => null,
			(e: Error) => e
		);
		expect(err?.message).toContain('left pending notices');
		expect(err?.message).toContain('1 × erratum_notice (pending) in project "Guard notice"');
		expect(err?.message).not.toContain('pending jobs');
		// Settled as skipped, not sent: the next file's tick mails nothing.
		expect((await asOwner('SELECT status, reason FROM erratum_notice WHERE project_id = $1', [pid]))[0]).toEqual({ status: 'skipped', reason: 'test cleanup' });
		await expect(guard()).resolves.toBeUndefined();
	});
});

// Runs before the setup file's guard (sequence.hooks 'stack'): had the guard
// run first, GUARD_RAN would already be set, and a job this hook cleans up would
// have failed the file.
afterAll(() => {
	expect((globalThis as Record<symbol, unknown>)[GUARD_RAN]).toBeUndefined();
});
