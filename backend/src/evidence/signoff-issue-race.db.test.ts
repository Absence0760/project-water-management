// A pack's sign-off against an issue in flight (288_signoff_pack_lock;
// docs/evidence-pack.md § Signing). The applicant's appointed specialist
// signs without locking the pack row (they read none, 167_signers), so the
// database's signoff_pack_draft is what keeps a sign-off from landing on a
// pack being issued: it reads the row FOR SHARE, waits for the issue, and
// refuses once the pack is issued. Positive control: with no issue in
// flight, a draft's sign-off goes in at once.
//
// Two connections as the schema owner (RLS isn't the subject; the trigger
// is): one holds the issue's update open, the other signs.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const SIGN = `INSERT INTO signoff (project_id, pack_id, user_id, full_name, registration_body, registration_category, registration_field, registration_no, scope,
	statement_version, statement_sha256, disclaimer_version, kind)
	VALUES ($1, $2, $3, $4, 'sacnasp', 'pr_sci_nat', 'water_resources', '400123/10', 'x', 'pack-signoff-1', repeat('a', 64), 'v3', 'specialist')`;

let owner: User;
let projectId: string;
let run: string;
const clients: pg.Client[] = [];

async function connect(): Promise<pg.Client> {
	const c = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await c.connect();
	clients.push(c);
	return c;
}

/** A draft pack planted past its guards, with one specialist sign-off when `signed` (issue needs one). */
async function plantDraft(signed: boolean): Promise<string> {
	const c = await connect();
	const id = randomUUID();
	await c.query('BEGIN');
	await c.query('SET LOCAL session_replication_role = replica');
	await c.query(
		`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, status, manifest, manifest_sha256, report_version, engine_version, created_by)
		 VALUES ($1, $2, $3, 1, 'draft', '{}', $4, 'evidence-8', '1.50.0', $5)`,
		[id, projectId, run, sha(id), owner.id]
	);
	if (signed) await c.query(SIGN, [projectId, id, owner.id, 'Dr First']);
	await c.query('COMMIT');
	return id;
}

const signoffs = async (c: pg.Client, pack: string) => (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM signoff WHERE pack_id = $1', [pack])).rows[0]!.n;

beforeAll(async () => {
	owner = await signUp('Raceowner');
	projectId = (await owner.call('POST', '/projects', { name: 'Sign-off race' })).body.project.id;
	const c = await connect();
	await c.query('BEGIN');
	await c.query('SET LOCAL session_replication_role = replica');
	run = (
		await c.query<{ id: string }>(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, '1.50.0', '2000-10-01', '2020-09-30', '{}') RETURNING id::text`,
			[projectId, owner.id]
		)
	).rows[0]!.id;
	await c.query('COMMIT');
});

afterAll(async () => {
	await Promise.all(clients.map((c) => c.end()));
});

describe('a sign-off and an issue of the same pack at once', () => {
	it('control: with no issue in flight, a draft is signed at once', async () => {
		const pack = await plantDraft(false);
		const c = await connect();
		await c.query(SIGN, [projectId, pack, owner.id, 'Dr Control']);
		expect(await signoffs(c, pack)).toBe(1);
	});

	it('a sign-off sent while the pack is being issued waits for the issue, then is refused', async () => {
		const pack = await plantDraft(true);
		const issuer = await connect();
		const signer = await connect();
		// The issue's transaction: the pack is issued, not committed yet.
		await issuer.query('BEGIN');
		await issuer.query(`SELECT set_config('app.current_user_id', $1, true)`, [owner.id]);
		await issuer.query(`UPDATE evidence_pack SET status = 'issued' WHERE id = $1`, [pack]);
		const signerPid = (await signer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
		await signer.query('BEGIN');
		await signer.query(`SET LOCAL lock_timeout = '10s'`);
		let settled = false;
		const signing = signer.query(SIGN, [projectId, pack, owner.id, 'Dr Late']).then(
			() => 'inserted',
			(e: Error) => e.message
		);
		void signing.then(() => (settled = true));
		// It waits on the issue's row lock (pg_locks shows the signer blocked), rather than going in on the draft it read.
		await expect
			.poll(async () => (await issuer.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = $2', [signerPid, 'Lock'])).rows[0]!.n)
			.toBe(1);
		expect(settled).toBe(false);
		await issuer.query('COMMIT');
		expect(await signing).toBe(`evidence pack ${pack} is not a draft, so it can't be signed`);
		await signer.query('ROLLBACK');
		expect(await signoffs(issuer, pack)).toBe(1);
	});
});
