// The server's re-run of an issued evidence pack in parts (302_pack_reproduce_parts,
// evidence/packReproduceParts.ts; docs/evidence-pack.md § Reproduction):
// against Postgres and MinIO, the `pack_reproduce` job checks a stored
// bundle without re-running it and fans out one `pack_reproduce_part` job per
// part, and the last part back records the pack's outcome. A pack whose
// combined row reads an assessment with six dams fans out 24 firm-yield
// searches beside its runs and reproduces; a stored yield tampered with is
// not reproduced, naming reproduce:dams. A part that stops never leaves the
// re-run hanging: one whose job died where no hook saw it is failed by the
// tick's sweep, one that died in its handler by its onDead, each naming the
// part, with nothing recorded as an outcome and a re-run allowed again. The
// 302 functions refuse anyone but the jobs (positive controls: the runs
// above). The bundles are the engine's synthetic fixtures (invented values).
import { randomUUID } from 'node:crypto';
import { assessmentPackFixture } from '@water-management/engine/testing';
import { buildPackBundle, type BundleCheck, type PackBundleInput } from '@water-management/engine';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { packBundleKey, putPackBundle } from '../reports/storage.js';
import { bundleHash } from './bundle.js';
import { packReproductionState, queuePackReproduce, requestPackReproduce } from './packReproduce.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let projectId: string;
let runId: string;

const tick = (maxJobs = 200) => runTick({ feeds: false, reports: false, alerts: false, projectIds: [projectId], maxJobs });
/** Tick until no job of the project is due (the parts are queued by the first). */
async function drain() {
	for (let i = 0; i < 10; i++) {
		await tick();
		const [{ n }] = await asOwner(`SELECT count(*)::int AS n FROM job WHERE project_id = $1 AND status IN ('queued', 'failed') AND run_after <= now()`, [projectId]);
		if (n === 0) return;
	}
	throw new Error('jobs still due after 10 ticks');
}

/** An issued pack of the project's run whose stored bundle is `input`'s, planted past evidence_pack_guard (as trust.security.db.test.ts plants one). */
async function issuedPackOf(input: PackBundleInput): Promise<string> {
	const packId = randomUUID();
	// Its own manifest (the pack's id in it), so no two planted packs share a manifest hash, in this run or the next.
	const built = await buildPackBundle({ ...input, manifest: { ...input.manifest, pack: { ...input.manifest.pack, id: packId } } }, bundleHash);
	const key = packBundleKey(projectId, packId, built.sha256);
	await putPackBundle(key, built.bytes, built.sha256);
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		await client.query(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, status, manifest, manifest_sha256, report_version, engine_version, created_by, issued_at, issued_by, bundle_key, bundle_sha256)
			 VALUES ($1, $2, $3, 1, 'issued', '{}', $4, 'evidence-26', 'x', $5, now(), $5, $6, $7)`,
			[packId, projectId, runId, built.index.pack.manifestSha256, owner.id, key, built.sha256]
		);
		await client.query('COMMIT');
	} finally {
		await client.end();
	}
	return packId;
}

const queue = (packId: string) => withUser(editor.id, (db) => queuePackReproduce(db, projectId, packId));
const gathering = async (packId: string) =>
	(await asOwner('SELECT id, status, problems, engine_version FROM pack_reproduce_gathering WHERE pack_id = $1 ORDER BY created_at DESC LIMIT 1', [packId]))[0] as
		| { id: string; status: string; problems: string[] | null; engine_version: string }
		| undefined;
const parts = (gatheringId: string) =>
	asOwner(`SELECT p.part->>'kind' AS kind, p.status, p.job_id, j.status AS job FROM pack_reproduce_part p LEFT JOIN job j ON j.id = p.job_id WHERE p.gathering_id = $1 ORDER BY p.position`, [
		gatheringId
	]) as Promise<{ kind: string; status: string; job_id: string; job: string }[]>;
const outcome = async (packId: string) =>
	(await asOwner('SELECT outcome, checks FROM pack_reproduction WHERE pack_id = $1', [packId]))[0] as { outcome: string; checks: BundleCheck[] } | undefined;
const state = (u: User, packId: string) => withUser(u.id, (db) => packReproductionState(db, projectId, packId, true));

beforeAll(async () => {
	[owner, editor, viewer] = (await Promise.all(['Rpowner', 'Rpeditor', 'Rpviewer'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Re-run in parts' })).body.project.id;
	const outlet = node('Outlet', null);
	const farm = node('Plaas', outlet.id);
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: Array(60).fill(1) })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	runId = run.body.run.id;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
}, 60_000);

describe('the server’s re-run in parts (302)', () => {
	it('six dams: the runs, the assessment, its background and 24 firm-yield searches each a job; the last one back records it reproduced', async () => {
		const packId = await issuedPackOf(assessmentPackFixture(bundleHash, { dams: 6, background: true }));
		await queue(packId);
		await tick(1);
		// The pack_reproduce job alone: checked, fanned out, nothing recorded yet, and the page says it is still checking.
		const g = (await gathering(packId))!;
		expect(g.status).toBe('gathering');
		const planned = await parts(g.id);
		expect(planned.filter((p) => p.kind === 'dam')).toHaveLength(24);
		expect(planned.filter((p) => p.kind !== 'dam').map((p) => p.kind)).toEqual(['run:baseline', 'run:application', 'combined', 'background']);
		expect(await outcome(packId)).toBeUndefined();
		expect((await state(viewer, packId)).status).toBe('checking');
		expect(await withUser(editor.id, (db) => requestPackReproduce(db, projectId, packId, true))).toMatchObject({ created: false });

		await drain();
		const o = (await outcome(packId))!;
		expect(o.outcome, JSON.stringify(o.checks.filter((c) => !c.ok))).toBe('reproduced');
		expect(o.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['stored', 'assessment', 'inputs:background', 'reproduce:baseline', 'reproduce:combined', 'reproduce:dams', 'reproduce:background']));
		expect(o.checks.find((c) => c.id === 'reproduce:dams')!.detail).toMatch(/24 searches, each its own job/);
		expect((await gathering(packId))!.status).toBe('recorded');
		expect((await parts(g.id)).every((p) => p.status === 'done')).toBe(true);
		expect(await state(viewer, packId)).toMatchObject({ status: 'reproduced', canRerun: false });
	}, 120_000);

	it('a stored firm yield tampered with: not reproduced, naming reproduce:dams alone', async () => {
		const input = assessmentPackFixture(bundleHash, { dams: 2 });
		const row = input.assessment!.report.rows.find((r) => r.metric === 'dam_firm_yield')!;
		// A value the manifest doesn't print (one application alone's yield): only the re-run sees it.
		row.singles[0] = (row.singles[0] ?? 0) + 5000;
		const packId = await issuedPackOf(input);
		await queue(packId);
		await drain();
		const o = (await outcome(packId))!;
		expect(o.outcome).toBe('not_reproduced');
		expect(o.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['reproduce:dams']);
	}, 120_000);

	it('a part whose job died where no hook saw it (its lease ran out): the tick’s sweep fails the re-run, naming it; no outcome, and a re-run is allowed', async () => {
		const packId = await issuedPackOf(assessmentPackFixture(bundleHash));
		await queue(packId);
		await tick(1);
		const g = (await gathering(packId))!;
		// Every part's job killed as the claim kills one whose lease ran out with no attempts left: no handler, no onDead.
		await asOwner(`UPDATE job SET status = 'dead', last_error = 'its lease ran out', finished_at = now() WHERE id IN (SELECT job_id FROM pack_reproduce_part WHERE gathering_id = $1)`, [g.id]);
		// Read before the sweep: already failed on the page, never "checking".
		expect(await state(viewer, packId)).toMatchObject({ status: 'failed', error: expect.stringContaining("the baseline run didn't finish (its lease ran out)") });
		const r = await tick();
		expect(r.packReproductionsFailed).toBeGreaterThanOrEqual(1);
		const after = (await gathering(packId))!;
		expect(after.status).toBe('failed');
		expect(after.problems![0]).toBe("the baseline run didn't finish (its lease ran out)");
		expect(await outcome(packId)).toBeUndefined();
		expect(await state(editor, packId)).toMatchObject({ status: 'failed', canRerun: true });
		// Re-run: a new gathering, and this time it reproduces.
		expect(await withUser(editor.id, (db) => requestPackReproduce(db, projectId, packId, true))).toMatchObject({ created: true });
		await drain();
		expect((await outcome(packId))!.outcome).toBe('reproduced');
	}, 120_000);

	it('a part that died in its handler (the engine changed under it): its onDead fails the re-run at once, naming it', async () => {
		const packId = await issuedPackOf(assessmentPackFixture(bundleHash, { background: true }));
		await queue(packId);
		await tick(1);
		const g = (await gathering(packId))!;
		await asOwner(`UPDATE pack_reproduce_gathering SET engine_version = '0.0.1' WHERE id = $1`, [g.id]);
		const r = await tick(1);
		expect(r.dead).toBe(1);
		// The dead part's onDead, not the sweep.
		expect(r.packReproductionsFailed).toBe(0);
		const after = (await gathering(packId))!;
		expect(after.status).toBe('failed');
		expect(after.problems![0]).toMatch(/^the baseline run didn't finish \(the server’s engine changed from 0\.0\.1 to .* while the pack was re-run; re-run it again\)$/);
		// Its siblings, run later, do nothing: the re-run is over.
		await drain();
		expect(await outcome(packId)).toBeUndefined();
	}, 120_000);
});

describe('the 302 functions take their writes from the jobs only', () => {
	it('refuses a part’s result, an outcome and a fan-out from a caller with no running job of it; a viewer can’t fail one; the sweep is the worker’s', async () => {
		const [g] = await asOwner('SELECT id FROM pack_reproduce_gathering WHERE project_id = $1 LIMIT 1', [projectId]);
		const [p] = await asOwner('SELECT id FROM pack_reproduce_part WHERE gathering_id = $1 LIMIT 1', [g.id]);
		const [pack] = await asOwner('SELECT pack_id, bundle_sha256 FROM pack_reproduce_gathering WHERE id = $1', [g.id]);
		const as = (u: User, sql: string, params: unknown[]) => withUser(u.id, (db) => db.query(sql, params));
		await expect(as(editor, 'SELECT app_pack_reproduce_part_done($1, $2)', [p.id, '{"checks":[]}'])).rejects.toMatchObject({ code: '42501' });
		await expect(as(editor, 'SELECT app_finish_pack_reproduce($1, $2, $3)', [g.id, 'reproduced', '[]'])).rejects.toMatchObject({ code: '42501' });
		await expect(
			as(editor, 'SELECT app_pack_reproduce_fan_out($1, $2, $3, $4, $5, $6, $7, $8)', [pack.pack_id, randomUUID(), randomUUID(), 'x', [], pack.bundle_sha256, '[]', '[]'])
		).rejects.toMatchObject({ code: '42501' });
		await expect(as(viewer, 'SELECT app_fail_pack_reproduce($1)', [g.id])).rejects.toMatchObject({ code: '42501' });
		// An editor's call on a re-run with no stopped part changes nothing (the sweep's positive control is above).
		expect((await as(editor, 'SELECT app_fail_pack_reproduce($1) AS f', [g.id])).rows[0].f).toBe(false);
		await expect(as(editor, 'SELECT app_fail_stopped_pack_reproductions()', [])).rejects.toMatchObject({ code: '42501' });
		await expect(as(editor, `INSERT INTO pack_reproduce_gathering (id, project_id, pack_id, engine_version, bundle_sha256, checks) VALUES ($1, $2, $3, 'x', $4, '[]')`, [
			randomUUID(),
			projectId,
			pack.pack_id,
			pack.bundle_sha256
		])).rejects.toMatchObject({ code: '42501' });
		// The worker may sweep (nothing left to fail).
		expect((await withoutUser((db) => db.query('SELECT app_fail_stopped_pack_reproductions() AS n'))).rows[0].n).toBe(0);
		// A viewer reads where the re-run is (RLS: whoever reads the pack).
		expect((await as(viewer, 'SELECT count(*)::int AS n FROM pack_reproduce_part WHERE gathering_id = $1', [g.id])).rows[0].n).toBeGreaterThan(0);
	});
});
