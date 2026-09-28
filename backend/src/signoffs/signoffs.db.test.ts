// Sign-offs on a run (036_signoff.sql, WP-3.13): who may sign, what binds a
// signature to the statement shown, and that a sign-off can't be changed,
// removed or forged, at the route and at RLS.
import { DISCLAIMER, signoffStatement, signoffStatementText } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeStoredLegacyRun, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { sha256 } from './routes.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let projectId: string;
let runId: string;
let legacyRunId: string;

const ALL = ['identity', 'competence', 'conflict', 'inputs', 'calibration', 'ewr', 'works', 'assurance', 'plausibility', 'limitations'];
/** The confirmations of the first statement version, signoff-1. */
const SIGNOFF_1 = ['calibration', 'ewr', 'works', 'assurance', 'limitations'];
const path = (rid = runId, pid = projectId) => `/projects/${pid}/runs/${rid}/signoffs`;
const body = (hash: string, over: Record<string, unknown> = {}) => ({
	fullName: 'Dr A. Hydrologist',
	registrationBody: 'SACNASP',
	registrationNo: '400999/20',
	scope: 'Hydrology section of a synthetic WULA technical report',
	confirmed: ALL,
	statementSha256: hash,
	...over
});

beforeAll(async () => {
	[owner, editor, viewer, stranger] = await Promise.all([signUp('SignOwner'), signUp('SignEditor'), signUp('SignViewer'), signUp('SignStranger')]);
	projectId = (await owner.call('POST', '/projects', { name: 'Sign-off' })).body.project.id;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'baseline' });
	expect(run.status).toBe(201);
	runId = run.body.run.id;
	// A run saved on the legacy model before engine 1.0.0 removed it (the API can't make one now).
	const legacy = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'legacy' });
	expect(legacy.status).toBe(201);
	legacyRunId = legacy.body.run.id;
	await makeStoredLegacyRun(legacyRunId);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const) {
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	}
});

describe('GET /projects/:id/runs/:runId/signoffs', () => {
	it('shows a viewer the statement, its hash and that they cannot sign', async () => {
		const res = await viewer.call('GET', path());
		expect(res.status).toBe(200);
		expect(res.body.statement.runId).toBe(runId);
		expect(res.body.statement.confirmations.map((c: { id: string }) => c.id)).toEqual(ALL);
		expect(res.body.statement.limitations.length).toBeGreaterThan(0);
		// The hash is the engine statement's, recomputed independently here.
		const expected = sha256(signoffStatementText(signoffStatement({ id: runId, engineVersion: res.body.statement.engineVersion, scenario: false })));
		expect(res.body.statementSha256).toBe(expected);
		expect(res.body.disclaimer).toEqual({ version: DISCLAIMER.version, status: DISCLAIMER.status });
		expect(res.body.cannotSign).toBe('requires editor role');
		expect((await editor.call('GET', path())).body.cannotSign).toBeNull();
		expect((await editor.call('GET', path(legacyRunId))).body.cannotSign).toMatch(/legacy/);
	});

	it('hides the project from a stranger and a malformed run id (404)', async () => {
		expect((await stranger.call('GET', path())).status).toBe(404);
		expect((await owner.call('GET', path('not-a-uuid'))).status).toBe(404);
		expect((await owner.call('GET', path(crypto.randomUUID()))).status).toBe(404);
	});
});

describe('POST /projects/:id/runs/:runId/signoffs', () => {
	let hash: string;
	beforeAll(async () => {
		hash = (await editor.call('GET', path())).body.statementSha256;
	});

	it('refuses a viewer (403) and a stranger (404)', async () => {
		expect((await viewer.call('POST', path(), body(hash))).status).toBe(403);
		expect((await stranger.call('POST', path(), body(hash))).status).toBe(404);
	});

	it('refuses a statement hash that is not the current one (409), an unticked statement (400) and a legacy run (409)', async () => {
		const stale = await editor.call('POST', path(), body('0'.repeat(64)));
		expect(stale.status).toBe(409);
		expect(stale.body.error).toMatch(/statement has changed/);
		const partial = await editor.call('POST', path(), body(hash, { confirmed: ALL.slice(0, 9) }));
		expect(partial.status).toBe(400);
		expect(partial.body.error).toMatch(/missing: limitations$/);
		// The five confirmations of signoff-1 are not enough for the current statement.
		const old = await editor.call('POST', path(), body(hash, { confirmed: SIGNOFF_1 }));
		expect(old.status).toBe(400);
		expect(old.body.error).toMatch(/missing: identity, competence, conflict, inputs, plausibility$/);
		const legacyHash = (await editor.call('GET', path(legacyRunId))).body.statementSha256;
		expect((await editor.call('POST', path(legacyRunId), body(legacyHash))).status).toBe(409);
		expect((await editor.call('POST', path(), body(hash, { fullName: '   ' }))).status).toBe(400);
		expect((await viewer.call('GET', path())).body.signoffs).toEqual([]);
	});

	it('records an editor’s sign-off, audit-logs it, shows it to viewers and keeps the run', async () => {
		const res = await editor.call('POST', path(), body(hash));
		expect(res.status).toBe(201);
		expect(res.body.signoff).toMatchObject({
			runId,
			fullName: 'Dr A. Hydrologist',
			registrationBody: 'SACNASP',
			registrationNo: '400999/20',
			statementVersion: 'signoff-2',
			statementSha256: hash,
			mine: true
		});
		// Positive control: a viewer reads it.
		const seen = (await viewer.call('GET', path())).body.signoffs;
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ id: res.body.signoff.id, mine: false });

		const { rows } = await withUser(viewer.id, (db) => db.query(`SELECT actor_user_id, kind, subject FROM audit_event WHERE project_id = $1 AND kind = 'signoff.created'`, [projectId]));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ actor_user_id: editor.id, subject: { signoffId: res.body.signoff.id, runId, statementSha256: hash } });

		// The run is cited, so kept: the DELETE route refuses and says by what.
		const del = await owner.call('DELETE', `/projects/${projectId}/runs/${runId}`);
		expect(del.status).toBe(409);
		expect(del.body.error).toMatch(/sign-off by Dr A\. Hydrologist/);
		const run = (await viewer.call('GET', `/projects/${projectId}/runs/${runId}`)).body.run;
		expect(run.citedBy).toEqual([expect.objectContaining({ kind: 'signoff', name: 'Dr A. Hydrologist' })]);
	});

	it('lets the owner add a second sign-off (a correction is a new row, not an edit)', async () => {
		expect((await owner.call('POST', path(), body(hash, { fullName: 'Ms B. Reviewer' }))).status).toBe(201);
		expect((await owner.call('GET', path())).body.signoffs.map((s: { fullName: string }) => s.fullName)).toEqual(['Dr A. Hydrologist', 'Ms B. Reviewer']);
	});

	it('keeps a sign-off made under signoff-1 as it was recorded, beside new ones under the current statement', async () => {
		const oldHash = 'b'.repeat(64);
		// A sign-off stored before the statement moved to signoff-2 (the route can only make current ones).
		await withUser(editor.id, (db) =>
			db.query(
				`INSERT INTO signoff (project_id, run_id, user_id, full_name, registration_body, registration_no, scope, statement_version, statement_sha256, disclaimer_version, signed_at)
				 VALUES ($1, $2, $3, 'Dr C. Earlier', 'SACNASP', '400111/10', 'scope', 'signoff-1', $4, 'disclaimer-1', now() - interval '1 day')`,
				[projectId, runId, editor.id, oldHash]
			)
		);
		const res = await viewer.call('GET', path());
		expect(res.body.statement.version).toBe('signoff-2');
		expect(res.body.statementSha256).toBe(hash);
		expect(res.body.signoffs.map((s: { fullName: string; statementVersion: string; statementSha256: string }) => [s.fullName, s.statementVersion, s.statementSha256])).toEqual([
			['Dr C. Earlier', 'signoff-1', oldHash],
			['Dr A. Hydrologist', 'signoff-2', hash],
			['Ms B. Reviewer', 'signoff-2', hash]
		]);
	});
});

describe('signoff under RLS', () => {
	const insert = (as: User, userId: string) =>
		withUser(as.id, (db) =>
			db.query(
				`INSERT INTO signoff (project_id, run_id, user_id, full_name, registration_body, registration_no, scope, statement_version, statement_sha256, disclaimer_version)
				 VALUES ($1, $2, $3, 'X', 'SACNASP', '1', 'scope', 'signoff-1', $4, 'd')`,
				[projectId, runId, userId, 'a'.repeat(64)]
			)
		);

	it('lets an editor insert as themselves (control), never as another user, and never a viewer', async () => {
		await expect(insert(editor, editor.id)).resolves.toBeDefined();
		await expect(insert(editor, owner.id)).rejects.toThrow(/row-level security/);
		await expect(insert(viewer, viewer.id)).rejects.toThrow(/row-level security/);
	});

	it('can’t be updated or deleted, even by the signer or the owner', async () => {
		for (const u of [editor, owner]) {
			await expect(withUser(u.id, (db) => db.query(`UPDATE signoff SET full_name = 'Forged' WHERE project_id = $1`, [projectId]))).rejects.toThrow(/permission denied/);
			await expect(withUser(u.id, (db) => db.query(`DELETE FROM signoff WHERE project_id = $1`, [projectId]))).rejects.toThrow(/permission denied/);
		}
		const { rows } = await withUser(owner.id, (db) => db.query<{ n: number }>(`SELECT count(*)::int AS n FROM signoff WHERE project_id = $1 AND full_name = 'Forged'`, [projectId]));
		expect(rows[0]!.n).toBe(0);
	});

	it('hides every sign-off from a stranger', async () => {
		const { rows } = await withUser(stranger.id, (db) => db.query(`SELECT id FROM signoff WHERE project_id = $1`, [projectId]));
		expect(rows).toEqual([]);
	});
});

describe('forecast runs (WP-2.12)', () => {
	it('refuses to sign off a forecast run (409, and GET says why); an ordinary run of the same data is signed', async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Sign-off forecast' })).body.project.id as string;
		const outlet = node('Outlet', null);
		const farm = node('Upper', outlet.id);
		const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
		const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
		expect((await owner.call('PUT', `/projects/${pid}/model`, model)).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
		const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 10 : 0));
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
		const forecast = Array.from({ length: 14 }, (_, i) => (i % 4 === 0 ? 8 : 0));
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2020-03-01', values: forecast })).status).toBe(200);

		const f = await owner.call('POST', `/projects/${pid}/runs`, { label: 'forecast', forecast: true });
		expect(f.status).toBe(201);
		const shown = await owner.call('GET', path(f.body.run.id, pid));
		expect(shown.body.cannotSign).toMatch(/^a forecast run cannot be signed off/);
		const refused = await owner.call('POST', path(f.body.run.id, pid), body(shown.body.statementSha256));
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/^a forecast run cannot be signed off/);
		expect((await owner.call('GET', path(f.body.run.id, pid))).body.signoffs).toEqual([]);

		// Positive control: the ordinary run of the same data is signed.
		const o = await owner.call('POST', `/projects/${pid}/runs`, { label: 'ordinary' });
		expect(o.status).toBe(201);
		const ordinary = await owner.call('GET', path(o.body.run.id, pid));
		expect(ordinary.body.cannotSign).toBeNull();
		expect((await owner.call('POST', path(o.body.run.id, pid), body(ordinary.body.statementSha256))).status).toBe(201);
	});
});
