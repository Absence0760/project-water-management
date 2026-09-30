// Evidence packs (WP-3.14, issue #71; docs/evidence-pack.md, docs/api.md §
// Evidence packs, 112_evidence_pack.sql), end to end on a synthetic
// catchment: a nominated baseline with a declared uncertainty rule and a cited
// ensemble, a team application with a paired band. Drafting from a report
// that may be issued (and the refusal), the pack sign-off, issue and its
// preconditions, supersede, withdraw, the public verify lookup (only the
// listed fields; nothing for a draft), the guards as water_app and as the
// schema owner (immutable once issued, forward-only status, sign-off target
// rules), who reads a pack, the runs a pack keeps, an account deletion, and a
// project with an issued pack being kept. The issued pack's PDF too
// (116_pack_render): the render issuing queues, its render session, the
// renderer's answers (retry, failure, the PDF recorded once), and who
// downloads it. Each "can't" has its positive control.
//
// REPORT_RENDERER is `sqs` for the PDF tests, with the queue send captured:
// a render is the render_pack message it would send, with no Chromium.
import {
	declaredRuleRequest,
	packManifestText,
	runEnsemble,
	runPairedEnsemble,
	type DeclaredUncertaintyRule,
	type ModelInput,
	type PackManifest
} from '@water-management/engine';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { sent } = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[] }));
vi.mock('../jobs/transport.js', async (orig) => ({
	...(await orig<typeof import('../jobs/transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: Record<string, unknown>) => void sent.push(message)
}));

import { anon, app, asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { enqueueJob } from '../jobs/queue.js';
import { runTick } from '../jobs/runner.js';
import { PackRenderRequestMessage, type PackRenderResult } from '../jobs/transport.js';
import { acceptPackRenderResult } from '../reports/schedule.js';
import { trimRuns } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let contributor: User;
let farmer: User;
let projectId: string;
let farmId: string;
let seedRun: string;
let baseRun: string;
let appRun: string;

const DAYS = 3 * 365;
const RULE: DeclaredUncertaintyRule = { members: 30, bounds: 'typical', panOffset: 0.1, thresholds: { objective: 'kgePrime', minSkill: -10, wr2012MaxLevel: 'unusable', maxLowFlowBiasPct: null } };
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const at = () => `/projects/${projectId}`;
const runPath = (runId: string) => `${at()}/runs/${runId}`;
const packPath = (packId: string) => `${at()}/packs/${packId}`;

async function newRun(label: string) {
	const res = await owner.call('POST', `${at()}/runs`, { label });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.run.id as string;
}
const inputOf = async (runId: string): Promise<ModelInput> => (await owner.call('GET', `${runPath(runId)}/model-input`)).body.input;

async function ensemble(runId: string, body: unknown, pairedOn?: Parameters<typeof runPairedEnsemble>[1]) {
	const started = await owner.call('POST', `${runPath(runId)}/uncertainty`, body);
	expect(started.status, JSON.stringify(started.body)).toBe(201);
	const row = started.body.ensemble;
	const input = await inputOf(runId);
	const result = pairedOn ? { members: runPairedEnsemble(input, pairedOn).members } : (({ members, coverage }) => ({ members, coverage }))(runEnsemble(input, row.options));
	const done = await owner.call('POST', `${runPath(runId)}/uncertainty/${row.id}/result`, result);
	expect(done.status, JSON.stringify(done.body)).toBe(200);
	return row.id as string;
}

/** Draft a pack as `u`. */
async function draft(u: User, runId: string, supersedesId?: string) {
	const res = await u.call('POST', `${at()}/packs`, { runId, ...(supersedesId ? { supersedesId } : {}) });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.pack as { id: string; version: number; status: string; manifestSha256: string; shortCode: string };
}

/** Sign a pack as `u`, with every confirmation and the statement shown. */
async function sign(u: User, packId: string, name = 'Dr A. Hydrologist') {
	const shown = await u.call('GET', `${packPath(packId)}/signoffs`);
	expect(shown.status).toBe(200);
	const res = await u.call('POST', `${packPath(packId)}/signoffs`, {
		fullName: name,
		registrationBody: 'sacnasp',
		registrationCategory: 'pr_sci_nat',
		registrationField: 'water_resources',
		registrationNo: '400999/20',
		scope: 'the hydrology of the evidence pack',
		confirmed: shown.body.statement.confirmations.map((k: { id: string }) => k.id),
		statementSha256: shown.body.statementSha256
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.signoff;
}

const issue = (u: User, packId: string) => u.call('POST', `${packPath(packId)}/issue`);

// Whatever this file queued and left (issuing v2 queues its PDF's render, a retry waits two minutes): no later file's tick may claim it.
afterAll(() => retirePendingJobs(projectId));

beforeAll(async () => {
	[owner, editor, viewer, stranger, contributor, farmer] = (await Promise.all(
		['PkOwner', 'PkEditor', 'PkViewer', 'PkStranger', 'PkContributor', 'PkFarmer'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Pack catchment' })).body.project.id as string;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer'],
		[contributor, 'contributor']
	] as const)
		expect((await owner.call('POST', `${at()}/members`, { email: u.email, role })).status).toBe(201);
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id, { areaKm2: 30, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0 });
	farmId = farm.id;
	expect((await owner.call('PUT', `${at()}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `${at()}/farmers`, { email: farmer.email, nodeIds: [farmId] })).status).toBe(201);
	expect(
		(await owner.call('PATCH', at(), { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(5000), runoffModel: 'gr4j', evidenceUncertaintyRule: RULE } })).status
	).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 4 === 0 ? (Math.floor(i / 30) % 12 < 6 ? 18 : 6) : 0));
	expect((await owner.call('PUT', `${at()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2018-10-01', values: rain })).status).toBe(200);
	seedRun = await newRun('seed');
	const flow = (await owner.call('GET', `${runPath(seedRun)}/series?key=simulated_outflow`)).body.values as number[];
	expect(
		(await owner.call('PUT', `${at()}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2018-10-01', values: flow.map((q, i) => (q / 86_400) * (1 + 0.1 * Math.sin(i / 17))) }))
			.status
	).toBe(200);
	baseRun = await newRun('Baseline');
	expect((await owner.call('POST', `${at()}/evidence`, { runId: baseRun, reason: 'Calibrated baseline' })).status).toBe(201);
	const cited = await ensemble(baseRun, { request: declaredRuleRequest(RULE) });
	const dam = { op: 'node.set', nodeId: farmId, field: 'damCapacityM3', value: 500_000 };
	const created = await owner.call('POST', `${at()}/scenarios`, { name: 'Upper dam', description: 'A dam on Upper.', baseRunId: baseRun, ops: [dam], ownedNodeIds: [farmId] });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	const ran = await owner.call('POST', `${at()}/scenarios/${created.body.scenario.id}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	appRun = ran.body.run.id;
	const base = (await owner.call('GET', `${runPath(baseRun)}/uncertainty/${cited}`)).body.ensemble;
	await ensemble(appRun, { baselineId: cited }, { options: base.options, header: base.result.header, members: base.result.members });
}, 600_000);

describe('drafting a pack', () => {
	it('drafts a baseline pack from an issuable report, and its hash survives storage (positive control)', async () => {
		const p = await draft(editor, baseRun);
		expect(p).toMatchObject({ version: 1, status: 'draft', supersedesId: null, baselineRunId: baseRun, scenarioRunId: null, mode: 'baseline' });
		expect(p.shortCode).toBe(`${p.manifestSha256.slice(0, 4)}-${p.manifestSha256.slice(4, 8)}-${p.manifestSha256.slice(8, 12)}`);
		const read = await viewer.call('GET', packPath(p.id));
		expect(read.status).toBe(200);
		const manifest = read.body.manifest as PackManifest;
		expect(sha256(packManifestText(manifest))).toBe(p.manifestSha256);
		expect(manifest.pack).toEqual({ id: p.id, version: 1, supersedes: null });
		expect(manifest.report.identity.baseline.runId).toBe(baseRun);
		expect(read.body.manifestMatches).toBe(true);
		// The issue checklist is an editor's (only editors issue); a viewer gets null.
		expect(read.body.issue).toBeNull();
		expect((await editor.call('GET', packPath(p.id))).body.issue).toEqual({ issuable: true, signed: false, runsVerified: true });
	});

	it('drafts an application pack on the scenario run, naming its scenario', async () => {
		const p = await draft(editor, appRun);
		const read = (await editor.call('GET', packPath(p.id))).body;
		expect(read.pack).toMatchObject({ mode: 'application', baselineRunId: baseRun, scenarioRunId: appRun, title: 'Upper dam' });
		expect(read.pack.scenarioId).toBeTruthy();
	});

	it('refuses a report that can’t be issued (a run that isn’t the nominated one), naming the checks', async () => {
		const res = await editor.call('POST', `${at()}/packs`, { runId: seedRun });
		expect(res.status).toBe(409);
		expect(res.body.details.checks.map((k: { id: string }) => k.id)).toContain('nominated');
	});

	it('lets viewers read and not draft; contributors and farmers get 403, a stranger 404', async () => {
		expect((await viewer.call('GET', `${at()}/packs`)).status).toBe(200);
		expect((await viewer.call('POST', `${at()}/packs`, { runId: baseRun })).status).toBe(403);
		for (const u of [contributor, farmer]) {
			expect((await u.call('GET', `${at()}/packs`)).status).toBe(403);
			expect((await u.call('POST', `${at()}/packs`, { runId: baseRun })).status).toBe(403);
		}
		expect((await stranger.call('GET', `${at()}/packs`)).status).toBe(404);
	});

	it('shows RLS no pack to a contributor or a farmer as water_app, and every pack to a viewer (positive control)', async () => {
		const count = async (u: User) =>
			(await withUser(u.id, (db) => db.query<{ n: number }>('SELECT count(*)::int AS n FROM evidence_pack WHERE project_id = $1', [projectId]))).rows[0]!.n;
		expect(await count(viewer)).toBeGreaterThan(0);
		expect(await count(contributor)).toBe(0);
		expect(await count(farmer)).toBe(0);
		expect(await count(stranger)).toBe(0);
	});
});

describe('issuing, superseding and withdrawing', () => {
	let v1: Awaited<ReturnType<typeof draft>>;
	let v2: Awaited<ReturnType<typeof draft>>;

	beforeAll(async () => {
		v1 = await draft(owner, baseRun);
	});

	it('refuses to issue without a sign-off of the current statement', async () => {
		const res = await issue(owner, v1.id);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/no sign-off/);
		// The trigger too, whoever writes (as water_app, past the route).
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evidence_pack SET status = 'issued' WHERE id = $1`, [v1.id]))).rejects.toMatchObject({ code: '23514' });
	});

	it('refuses a pack statement signed as a run statement, and a sign-off naming both targets', async () => {
		const row = (await asOwner('SELECT project_id FROM evidence_pack WHERE id = $1', [v1.id]))[0]!;
		const insert = (runId: string | null, packId: string | null, version: string) =>
			withUser(owner.id, (db) =>
				db.query(
					`INSERT INTO signoff (project_id, run_id, pack_id, user_id, full_name, registration_body, registration_category, registration_field, registration_no, scope,
						statement_version, statement_sha256, disclaimer_version)
					 VALUES ($1, $2, $3, app_current_user_id(), 'X', 'sacnasp', 'pr_sci_nat', 'water_resources', '1', 's', $4, $5, 'd')`,
					[row.project_id, runId, packId, version, 'a'.repeat(64)]
				)
			);
		await expect(insert(baseRun, v1.id, 'pack-signoff-1')).rejects.toMatchObject({ code: '23514' });
		await expect(insert(null, v1.id, 'signoff-4')).rejects.toMatchObject({ code: '23514' });
		await expect(insert(baseRun, null, 'pack-signoff-1')).rejects.toMatchObject({ code: '23514' });
		await expect(insert(null, null, 'signoff-4')).rejects.toMatchObject({ code: '23514' });
	});

	it('shows the pack statement, binding the manifest hash; a viewer reads it and can’t sign', async () => {
		const res = await viewer.call('GET', `${packPath(v1.id)}/signoffs`);
		expect(res.status).toBe(200);
		expect(res.body.statement).toMatchObject({ version: 'pack-signoff-1', packId: v1.id, manifestSha256: v1.manifestSha256 });
		expect(res.body.cannotSign).toBe('requires editor role');
		expect((await editor.call('GET', `${packPath(v1.id)}/signoffs`)).body.cannotSign).toBeNull();
	});

	it('issues a signed draft, stamping who and when', async () => {
		const s = await sign(editor, v1.id);
		expect(s).toMatchObject({ packId: v1.id, runId: null, statementVersion: 'pack-signoff-1' });
		const res = await issue(owner, v1.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.pack).toMatchObject({ status: 'issued', issuedBy: 'PkOwner', signoffs: 1 });
		expect(res.body.pack.issuedAt).toBeTruthy();
		expect((await issue(owner, v1.id)).status).toBe(409);
	});

	it('refuses a sign-off of an issued pack, through the route and the trigger', async () => {
		const res = await editor.call('GET', `${packPath(v1.id)}/signoffs`);
		expect(res.body.cannotSign).toMatch(/only a draft pack is signed/);
		const post = await editor.call('POST', `${packPath(v1.id)}/signoffs`, {
			fullName: 'Late',
			registrationBody: 'sacnasp',
			registrationCategory: 'pr_sci_nat',
			registrationField: 'water_resources',
			registrationNo: '1',
			scope: 's',
			confirmed: res.body.statement.confirmations.map((k: { id: string }) => k.id),
			statementSha256: res.body.statementSha256
		});
		expect(post.status).toBe(409);
		await expect(
			withUser(editor.id, (db) =>
				db.query(
					`INSERT INTO signoff (project_id, pack_id, user_id, full_name, registration_body, registration_category, registration_field, registration_no, scope,
						statement_version, statement_sha256, disclaimer_version)
					 VALUES ($1, $2, app_current_user_id(), 'X', 'sacnasp', 'pr_sci_nat', 'water_resources', '1', 's', 'pack-signoff-1', $3, 'd')`,
					[projectId, v1.id, 'a'.repeat(64)]
				)
			)
		).rejects.toMatchObject({ code: '23514' });
	});

	it('keeps an issued pack: no delete (route, RLS), no change to its manifest (grant, trigger), no way back to draft', async () => {
		expect((await owner.call('DELETE', packPath(v1.id))).status).toBe(409);
		const del = await withUser(owner.id, (db) => db.query('DELETE FROM evidence_pack WHERE id = $1', [v1.id]));
		expect(del.rowCount).toBe(0);
		// water_app may not even name the manifest in an UPDATE (column grants).
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evidence_pack SET manifest = '{}'::jsonb WHERE id = $1`, [v1.id]))).rejects.toMatchObject({ code: '42501' });
		// The guard holds for the schema owner too.
		await expect(asOwner(`UPDATE evidence_pack SET manifest = manifest || '{"x":1}'::jsonb WHERE id = $1`, [v1.id])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`UPDATE evidence_pack SET baseline_run_id = $2 WHERE id = $1`, [v1.id, seedRun])).rejects.toMatchObject({ code: '23514' });
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evidence_pack SET status = 'draft' WHERE id = $1`, [v1.id]))).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`UPDATE evidence_pack SET issued_by = NULL WHERE id = $1`, [v1.id])).rejects.toMatchObject({ code: '23514' });
		const read = await owner.call('GET', packPath(v1.id));
		expect(read.body.pack.status).toBe('issued');
		expect(read.body.manifestMatches).toBe(true);
	});

	it('deletes an unsigned draft (positive control), and keeps a signed one', async () => {
		const d = await draft(editor, baseRun);
		expect((await editor.call('DELETE', packPath(d.id))).status).toBe(204);
		expect((await editor.call('GET', packPath(d.id))).status).toBe(404);
		const signed = await draft(editor, baseRun);
		await sign(editor, signed.id);
		const res = await editor.call('DELETE', packPath(signed.id));
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/signed draft is kept/);
		// It is withdrawn instead: a draft may be.
		const w = await editor.call('POST', `${packPath(signed.id)}/withdraw`, { reason: 'drafted in error' });
		expect(w.status).toBe(200);
		expect(w.body.pack).toMatchObject({ status: 'withdrawn', issuedAt: null, statusReason: 'drafted in error' });
		// Never issued, so never public.
		expect((await anon('GET', `/verify/${signed.shortCode}`)).status).toBe(404);
	});

	it('verifies an issued pack by its short code or full hash, with only the printed fields; a draft or an unknown code is 404', async () => {
		const res = await anon('GET', `/verify/${v1.shortCode.toUpperCase()}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(Object.keys(res.body.pack).sort()).toEqual(
			[
				'catchment',
				'engineVersion',
				'errata',
				'issuedAt',
				'manifestSha256',
				'methodology',
				'pdfSha256',
				'reportVersion',
				'shortCode',
				'signers',
				'status',
				'successorSha256',
				'version',
				'withdrawnReason'
			].sort()
		);
		expect(res.body.pack).toMatchObject({ status: 'issued', version: 1, catchment: 'Pack catchment', manifestSha256: v1.manifestSha256, successorSha256: null, withdrawnReason: null });
		expect(res.body.pack.signers).toEqual([
			expect.objectContaining({ fullName: 'Dr A. Hydrologist', registrationBody: 'sacnasp', registrationCategory: 'pr_sci_nat', registrationField: 'water_resources', registrationNo: '400999/20' })
		]);
		expect(Object.keys(res.body.pack.signers[0]).sort()).toEqual(['fullName', 'registrationBody', 'registrationCategory', 'registrationField', 'registrationNo', 'signedAt']);
		const text = JSON.stringify(res.body);
		for (const secret of [projectId, baseRun, v1.id, owner.email, editor.email, 'PkOwner', 'PkEditor']) expect(text).not.toContain(secret);
		expect((await anon('GET', `/verify/${v1.manifestSha256}`)).body.pack.version).toBe(1);
		const d = await draft(editor, baseRun);
		expect((await anon('GET', `/verify/${d.shortCode}`)).status).toBe(404);
		expect((await anon('GET', `/verify/${d.manifestSha256}`)).status).toBe(404);
		expect((await anon('GET', '/verify/0000-0000-0000')).status).toBe(404);
		expect((await anon('GET', '/verify/not-a-code')).status).toBe(404);
		expect((await editor.call('DELETE', packPath(d.id))).status).toBe(204);
	});

	// The PDF of the issued v1 (116_pack_render; docs/evidence-pack.md § The PDF), as production makes it.
	describe('its PDF', () => {
		const PDF_SHA = sha256('the printed pack');
		const pdfJobs = () =>
			asOwner(
				`SELECT status, dedupe_key AS "dedupeKey", acting_user_id AS "actingUserId", payload ? 'result' AS "isResult", last_error AS error,
					round(extract(epoch FROM run_after - created_at) / 60)::int AS "delayMin"
				 FROM job WHERE project_id = $1 AND kind = 'pack_render' AND payload->>'packId' = $2 ORDER BY created_at, id`,
				[projectId, v1.id]
			);
		const tick = () => runTick({ feeds: false, reports: false, alerts: false });
		const answer = (result: PackRenderResult) => acceptPackRenderResult({ v: 1, type: 'rendered_pack', packId: v1.id, result });
		const pdfState = async () => (await viewer.call('GET', packPath(v1.id))).body.pdf;
		/** A request carrying only a cookie (the render session's), as the headless browser sends it. */
		const asCookie = async (cookie: string, path: string) => (await app.request(path, { headers: { origin: 'http://localhost:7777', cookie } })).status;

		beforeAll(() => {
			vi.stubEnv('REPORT_RENDERER', 'sqs');
			vi.stubEnv('RENDER_REQUESTS_QUEUE_URL', 'memory://render-requests');
		});
		afterAll(() => {
			vi.unstubAllEnvs();
			sent.length = 0;
		});

		it('issuing queued one render, as the issuer, one per pack; the pack says it is rendering', async () => {
			expect(await pdfJobs()).toEqual([{ status: 'queued', dedupeKey: `pack_render:${v1.id}`, actingUserId: owner.id, isResult: false, error: null, delayMin: 0 }]);
			expect(await pdfState()).toEqual({ status: 'rendering', error: null });
			// No PDF yet: nothing to download, and nothing recorded.
			expect((await viewer.call('GET', `${packPath(v1.id)}/pdf`)).status).toBe(409);
			expect((await anon('GET', `/verify/${v1.shortCode}`)).body.pack.pdfSha256).toBeNull();
		});

		it('the render sends a render_pack request whose token opens a session reading this pack and nothing else', async () => {
			await tick();
			expect((await pdfJobs())[0]!.status).toBe('done');
			const requests = sent.filter((m) => m.type === 'render_pack');
			expect(requests).toHaveLength(1);
			const request = PackRenderRequestMessage.parse(requests[0]);
			expect(request).toMatchObject({ packId: v1.id, projectId });
			// Handed to the renderer: still rendering until its answer comes back.
			expect(await pdfState()).toEqual({ status: 'rendering', error: null });

			const exchanged = await anon('POST', '/auth/render-session', { token: request.token });
			expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
			const cookie = exchanged.headers.get('set-cookie')!.split(';')[0]!;
			expect(await asCookie(cookie, packPath(v1.id))).toBe(200);
			expect(await asCookie(cookie, `${packPath(v1.id)}/signoffs`)).toBe(200);
			for (const path of [at(), `${at()}/packs`, `${packPath(v1.id)}/pdf`, runPath(baseRun), `${at()}/series`, '/projects']) expect(await asCookie(cookie, path), path).toBe(403);
			// Single use.
			expect((await anon('POST', '/auth/render-session', { token: request.token })).body.code).toBe('render_token_refused');
		});

		it('a retryable failure asks again after two minutes', async () => {
			expect(await answer({ ok: false, error: 'the page took too long', retry: true })).toBe('queued');
			await tick();
			const jobs = await pdfJobs();
			expect(jobs.map((j) => [j.dedupeKey, j.status, j.isResult])).toEqual([
				[`pack_render:${v1.id}`, 'done', false],
				[`pack_result:${v1.id}`, 'done', true],
				[`pack_retry:${v1.id}:1`, 'queued', false]
			]);
			expect(jobs[2]!.delayMin).toBe(2);
			expect(await pdfState()).toEqual({ status: 'rendering', error: null });
		});

		it('a final failure fails the PDF with the renderer’s reason, and an editor may ask again (positive control: 202)', async () => {
			expect(await answer({ ok: false, error: 'the render session was refused', retry: false })).toBe('queued');
			await tick();
			expect((await pdfJobs()).at(-1)).toMatchObject({ isResult: true, status: 'dead', error: 'the renderer failed: the render session was refused' });
			expect(await pdfState()).toEqual({ status: 'failed', error: 'the renderer failed: the render session was refused' });
			// A viewer can't ask; an editor can.
			expect((await viewer.call('POST', `${packPath(v1.id)}/pdf`)).status).toBe(403);
			const again = await editor.call('POST', `${packPath(v1.id)}/pdf`);
			expect(again.status, JSON.stringify(again.body)).toBe(202);
			expect(await pdfState()).toEqual({ status: 'rendering', error: null });
			await tick();
			expect(sent.filter((m) => m.type === 'render_pack' && m.packId === v1.id)).toHaveLength(2);
		});

		it('the PDF only its render job records: not a member’s call, and not a job’s after the first', async () => {
			await expect(withUser(owner.id, (db) => db.query('SELECT app_record_pack_pdf($1, $2, 3)', [v1.id, PDF_SHA]))).rejects.toMatchObject({ code: '42501' });
			const [pack] = await asOwner('SELECT pdf_key, pdf_sha256 FROM evidence_pack WHERE id = $1', [v1.id]);
			expect(pack).toEqual({ pdf_key: null, pdf_sha256: null });
		});

		it('records the renderer’s PDF once: its key, hash and pages, on the pack and on verify', async () => {
			expect(await answer({ ok: true, pages: 7, bytes: 123_456, ms: 2_000, sha256: PDF_SHA })).toBe('queued');
			await tick();
			expect((await pdfJobs()).at(-1)).toMatchObject({ isResult: true, status: 'done' });
			const [pack] = await asOwner('SELECT pdf_key, pdf_sha256, pdf_pages FROM evidence_pack WHERE id = $1', [v1.id]);
			expect(pack).toEqual({ pdf_key: `packs/${projectId}/${v1.id}/${PDF_SHA}.pdf`, pdf_sha256: PDF_SHA, pdf_pages: 7 });
			expect(await pdfState()).toEqual({ status: 'ready', error: null });
			expect((await viewer.call('GET', packPath(v1.id))).body.pack).toMatchObject({ pdfSha256: PDF_SHA, pdfPages: 7 });
			expect((await anon('GET', `/verify/${v1.shortCode}`)).body.pack.pdfSha256).toBe(PDF_SHA);

			// A second answer (a redelivery, a late render) is about a pack with its PDF: dropped.
			expect(await answer({ ok: true, pages: 8, bytes: 1, ms: 1, sha256: sha256('another print') })).toBe('unknown_pack');
			// Even from a running render job of the pack, the first PDF stands (false, nothing changes).
			const { job } = await withUser(owner.id, (db) => enqueueJob(db, { projectId, kind: 'pack_render', payload: { packId: v1.id }, maxAttempts: 1 }));
			const jobId = job.id;
			await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '1 minute', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`, [jobId]);
			const second = await withUser(owner.id, (db) => db.query<{ r: boolean }>('SELECT app_record_pack_pdf($1, $2, 8) AS r', [v1.id, sha256('another print')]));
			expect(second.rows[0]!.r).toBe(false);
			await asOwner(`UPDATE job SET status = 'done', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE id = $1`, [jobId]);
			expect((await asOwner('SELECT pdf_sha256 FROM evidence_pack WHERE id = $1', [v1.id]))[0]!.pdf_sha256).toBe(PDF_SHA);
			// Nor may anyone ask for another print.
			const again = await editor.call('POST', `${packPath(v1.id)}/pdf`);
			expect(again.status).toBe(409);
			expect(again.body.error).toMatch(/recorded already/);
		});

		it('a viewer downloads it through a short-lived signed URL of the packs bucket; a contributor is refused, a stranger 404', async () => {
			const res = await app.request(`${packPath(v1.id)}/pdf`, { headers: { origin: 'http://localhost:7777', cookie: viewer.cookie } });
			expect(res.status).toBe(302);
			expect(res.headers.get('referrer-policy')).toBe('no-referrer');
			expect(res.headers.get('cache-control')).toBe('no-store');
			const location = res.headers.get('location')!;
			expect(location).toContain(`/water-packs/packs/${projectId}/${v1.id}/${PDF_SHA}.pdf?`);
			expect(location).toContain('X-Amz-Expires=60&');
			expect(location).toMatch(/filename%3D%22pack-catchment-evidence-pack-v1-[0-9a-f-]+\.pdf%22/);
			expect((await contributor.call('GET', `${packPath(v1.id)}/pdf`)).status).toBe(403);
			expect((await farmer.call('GET', `${packPath(v1.id)}/pdf`)).status).toBe(403);
			expect((await stranger.call('GET', `${packPath(v1.id)}/pdf`)).status).toBe(404);
		});

		it('a draft has no PDF: no download, no render asked, no render token (409s, the trigger)', async () => {
			const d = await draft(editor, baseRun);
			expect((await viewer.call('GET', `${packPath(d.id)}/pdf`)).status).toBe(409);
			const ask = await editor.call('POST', `${packPath(d.id)}/pdf`);
			expect(ask.status).toBe(409);
			expect(ask.body.error).toMatch(/never issued/);
			expect((await editor.call('GET', packPath(d.id))).body.pdf).toEqual({ status: 'none', error: null });
			await expect(
				withUser(editor.id, (db) =>
					db.query(`INSERT INTO render_token (token_hash, user_id, project_id, pack_id, expires_at) VALUES ($1, app_current_user_id(), $2, $3, now())`, [
						Buffer.alloc(32, 7),
						projectId,
						d.id
					])
				)
			).rejects.toMatchObject({ code: '23514' });
			expect((await editor.call('DELETE', packPath(d.id))).status).toBe(204);
		});
	});

	it('issues a new version, which supersedes the old one in the same step', async () => {
		v2 = await draft(editor, baseRun, v1.id);
		expect(v2).toMatchObject({ version: 2, supersedesId: v1.id });
		const manifest = (await editor.call('GET', packPath(v2.id))).body.manifest as PackManifest;
		expect(manifest.pack.supersedes).toEqual({ id: v1.id, manifestSha256: v1.manifestSha256 });
		// A version can't supersede a draft.
		expect((await editor.call('POST', `${at()}/packs`, { runId: baseRun, supersedesId: v2.id })).status).toBe(409);
		// Nor can a baseline pack be the next version of an application's.
		await sign(editor, v2.id);
		const res = await issue(editor, v2.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const old = (await owner.call('GET', packPath(v1.id))).body.pack;
		expect(old).toMatchObject({ status: 'superseded', supersededById: v2.id });
		const verified = await anon('GET', `/verify/${v1.shortCode}`);
		expect(verified.body.pack).toMatchObject({ status: 'superseded', successorSha256: v2.manifestSha256 });
	});

	it('withdraws an issued pack once, with its reason, and says so to verify', async () => {
		const res = await editor.call('POST', `${packPath(v2.id)}/withdraw`, { reason: 'the licence application lapsed' });
		expect(res.status).toBe(200);
		expect(res.body.pack).toMatchObject({ status: 'withdrawn', statusReason: 'the licence application lapsed' });
		expect((await editor.call('POST', `${packPath(v2.id)}/withdraw`, { reason: 'again' })).status).toBe(409);
		await expect(asOwner(`UPDATE evidence_pack SET status_reason = 'changed' WHERE id = $1`, [v2.id])).rejects.toMatchObject({ code: '23514' });
		expect((await anon('GET', `/verify/${v2.shortCode}`)).body.pack).toMatchObject({ status: 'withdrawn', withdrawnReason: 'the licence application lapsed' });
		// A viewer can't withdraw (editor only).
		expect((await viewer.call('POST', `${packPath(v1.id)}/withdraw`, { reason: 'x' })).status).toBe(403);
	});

	it('records each step in the change history', async () => {
		const kinds = (await asOwner(`SELECT kind FROM audit_event WHERE project_id = $1 AND kind LIKE 'pack.%' ORDER BY id`, [projectId])).map((r) => r.kind);
		for (const k of ['pack.drafted', 'pack.issued', 'pack.superseded', 'pack.withdrawn', 'pack.deleted']) expect(kinds).toContain(k);
		const signed = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'signoff.created' AND subject ? 'packId' LIMIT 1`, [projectId]);
		expect(signed[0]!.subject.packId).toBeTruthy();
	});

	it('lists a pack sign-off in the signer’s data export, by pack', async () => {
		const res = await editor.call('GET', '/auth/me/export');
		expect(res.status).toBe(200);
		const s = res.body.signoffs.find((x: { packId: string | null }) => x.packId === v1.id);
		expect(s).toMatchObject({ runId: null, packId: v1.id, fullName: 'Dr A. Hydrologist' });
	});
});

describe('the runs a pack cites', () => {
	it('keeps them through the storage cap, and the run DELETE names the pack', async () => {
		const cited = await asOwner('SELECT model_run_cited($1) AS b, model_run_cited($2) AS a, model_run_cited($3) AS s', [baseRun, appRun, seedRun]);
		expect(cited[0]).toMatchObject({ b: true, a: true });
		const removed = await withUser(owner.id, (db) => trimRuns(db, projectId, 0));
		expect(removed).not.toContain(baseRun);
		expect(removed).not.toContain(appRun);
		const res = await owner.call('DELETE', runPath(appRun));
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/evidence pack version/);
	});

	it('keeps the application’s scenario while a pack cites it', async () => {
		const sid = (await asOwner('SELECT scenario_id FROM evidence_pack WHERE scenario_run_id = $1 LIMIT 1', [appRun]))[0]!.scenario_id;
		const res = await owner.call('DELETE', `${at()}/scenarios/${sid}`);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/evidence pack/);
	});
});

describe('an account deletion', () => {
	it('clears who drafted and issued a pack, and nothing else', async () => {
		const issuer = await signUp('PkIssuer');
		expect((await owner.call('POST', `${at()}/members`, { email: issuer.email, role: 'editor' })).status).toBe(201);
		const p = await draft(issuer, baseRun);
		await sign(owner, p.id);
		expect((await issue(issuer, p.id)).status).toBe(200);
		const before = (await asOwner('SELECT * FROM evidence_pack WHERE id = $1', [p.id]))[0]!;
		expect(before).toMatchObject({ created_by: issuer.id, issued_by: issuer.id, status: 'issued' });
		await asOwner('DELETE FROM app_user WHERE id = $1', [issuer.id]);
		const after = (await asOwner('SELECT * FROM evidence_pack WHERE id = $1', [p.id]))[0]!;
		expect(after).toEqual({ ...before, created_by: null, issued_by: null });
	});

	it('refuses a manifest that names another pack, and a new version of another subject (the guard)', async () => {
		const issued = (await asOwner(`SELECT id, version FROM evidence_pack WHERE project_id = $1 AND status = 'issued' AND scenario_id IS NULL LIMIT 1`, [projectId]))[0]!;
		const sid = (await asOwner('SELECT scenario_id FROM model_run WHERE id = $1', [appRun]))[0]!.scenario_id as string;
		const plant = (o: { manifestId?: string; version: number; supersedes: string | null; scenario: boolean }) => {
			const id = crypto.randomUUID();
			const manifest = { pack: { id: o.manifestId ?? id, version: o.version }, project: { id: projectId }, engine: { version: 'x' }, report: { version: 'evidence-1' } };
			return withUser(owner.id, (db) =>
				db.query(
					`INSERT INTO evidence_pack (id, project_id, baseline_run_id, scenario_id, scenario_run_id, version, supersedes_pack_id, manifest, manifest_sha256, report_version, engine_version, created_by)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, md5(random()::text) || md5(random()::text), 'evidence-1', 'x', app_current_user_id())`,
					[id, projectId, baseRun, o.scenario ? sid : null, o.scenario ? appRun : null, o.version, o.supersedes, JSON.stringify(manifest)]
				)
			);
		};
		await expect(plant({ manifestId: crypto.randomUUID(), version: 1, supersedes: null, scenario: false })).rejects.toMatchObject({ code: '23514' });
		await expect(plant({ version: issued.version + 1, supersedes: issued.id, scenario: true })).rejects.toMatchObject({ code: '23514' });
		// Positive control: a well-formed baseline draft goes in (deleted again below).
		const ok = await plant({ version: issued.version + 1, supersedes: issued.id, scenario: false });
		expect(ok.rowCount).toBe(1);
		await asOwner(`DELETE FROM evidence_pack WHERE supersedes_pack_id = $1 AND status = 'draft' AND engine_version = 'x'`, [issued.id]);
		// Nor may an editor record a PDF hash (verify prints it): no grant.
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evidence_pack SET pdf_key = 'k', pdf_sha256 = $2 WHERE id = $1`, [issued.id, 'a'.repeat(64)]))).rejects.toMatchObject({ code: '42501' });
	});

	it('allows one issued pack per application or baseline: a second is refused, a new version is the way (positive control)', async () => {
		const second = await draft(owner, baseRun);
		await sign(owner, second.id);
		const res = await issue(owner, second.id);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/is issued; draft a new version/);
		// The database holds it too, whoever writes (checked at commit).
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evidence_pack SET status = 'issued' WHERE id = $1`, [second.id]))).rejects.toMatchObject({ code: '23P01' });
		expect((await owner.call('POST', `${packPath(second.id)}/withdraw`, { reason: 'a second pack in error' })).status).toBe(200);
	});
});

describe('deleting a project with packs', () => {
	/** A small project of its own, with a run and no nomination, so only the pack decides whether it goes. */
	async function smallProject(name: string) {
		const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
		const o = node('Weir', null);
		const f = node('Farm', o.id, { areaKm2: 5 });
		expect((await owner.call('PUT', `/projects/${id}/model`, { nodes: [o, f], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
		expect((await owner.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [1, 0, 3, 0, 2] })).status).toBe(200);
		const run = await owner.call('POST', `/projects/${id}/runs`, { label: 'r' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const packId = crypto.randomUUID();
		const hash = sha256(packId);
		await asOwner(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, manifest, manifest_sha256, report_version, engine_version, created_by)
			 VALUES ($1::uuid, $2::uuid, $3, 1, jsonb_build_object('pack', jsonb_build_object('id', $1::text, 'version', 1), 'project', jsonb_build_object('id', $2::text), 'engine', jsonb_build_object('version', '0.0.0'), 'report', jsonb_build_object('version', 'evidence-1')), $4, 'evidence-1', '0.0.0', $5)`,
			[packId, id, run.body.run.id, hash, owner.id]
		);
		return { id, packId, runId: run.body.run.id as string };
	}

	it('refuses another project’s run or pack by the same owner (404), never the database’s words', async () => {
		const other = await smallProject('Other');
		const byRun = await owner.call('POST', `${at()}/packs`, { runId: other.runId });
		expect(byRun.status).toBe(404);
		const issued = (await asOwner(`SELECT id FROM evidence_pack WHERE project_id = $1 AND status = 'issued' LIMIT 1`, [projectId]))[0]!.id as string;
		await asOwner(`UPDATE evidence_pack SET status = 'withdrawn', status_reason = 'x' WHERE id = $1`, [other.packId]);
		const byPack = await owner.call('POST', `${at()}/packs`, { runId: baseRun, supersedesId: other.packId });
		expect(byPack.status).toBe(404);
		expect(JSON.stringify(byPack.body)).not.toMatch(/belongs to a different project|violates|foreign key/i);
		// Positive control: the project's own issued pack is found, and a new version drafted.
		const own = await owner.call('POST', `${at()}/packs`, { runId: baseRun, supersedesId: issued });
		expect(own.status, JSON.stringify(own.body)).toBe(201);
	});

	it('deletes a project whose only pack is a draft (positive control)', async () => {
		const { id } = await smallProject('Draft only');
		expect((await owner.call('DELETE', `/projects/${id}`)).status).toBe(204);
	});

	it('refuses a project with a pack past draft: the route (409) and the trigger', async () => {
		const { id, packId } = await smallProject('Kept');
		await asOwner(`UPDATE evidence_pack SET status = 'withdrawn', status_reason = 'test' WHERE id = $1`, [packId]);
		const res = await owner.call('DELETE', `/projects/${id}`);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/evidence pack past draft/);
		await expect(asOwner('DELETE FROM project WHERE id = $1', [id])).rejects.toMatchObject({ code: '23001' });
	});

	it('refuses the pack catchment itself, with its issued packs', async () => {
		const res = await owner.call('DELETE', at());
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/evidence pack/);
	});
});
