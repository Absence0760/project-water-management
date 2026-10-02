// The applicant's printable copy of an issued pack (165_applicant_copy;
// licensing build item 12; docs/evidence-pack.md § Applicants, docs/security.md
// § Render tokens). An application's party asks for it; a job prints their
// own pack page as them (the browser and storage stubbed here; the real
// print is the applicant-pack e2e) and records its own SHA-256 once; the
// party downloads it. Every "cannot" has its positive control:
//
//   - who asks and downloads: the application's owner (control), never
//     another applicant, a viewer who isn't a party, a farmer;
//   - the render token: the party's, for this pack's applicant page only
//     (the session reads that page, never the editor's pack route, the run
//     or the scenario), and never for a pack of another application;
//   - the record: only from the party's own running job, once.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { rendered } = vi.hoisted(() => ({ rendered: [] as { projectId: string; packId: string; scenarioId?: string; token: string }[] }));
vi.mock('../reports/render.js', async (orig) => ({
	...(await orig<typeof import('../reports/render.js')>()),
	renderReportPdf: async (t: { projectId: string; packId: string; scenarioId?: string; token: string }) => {
		rendered.push(t);
		return { pdf: Buffer.from(`%PDF-1.7 the applicant's copy of ${t.packId}`), pages: 3, ms: 10 };
	}
}));
const { puts } = vi.hoisted(() => ({ puts: [] as { key: string; sha256: string }[] }));
vi.mock('../reports/storage.js', async (orig) => ({
	...(await orig<typeof import('../reports/storage.js')>()),
	putPackPdf: async (key: string, _body: Uint8Array, sha256: string) => void puts.push({ key, sha256 })
}));

const { anon, app: api, asOwner, node, signUp, retirePendingJobs } = await import('../__tests__/helpers.js');
const { withUser } = await import('../db/tx.js');
const { runTick } = await import('../jobs/runner.js');
const { enqueueJob } = await import('../jobs/queue.js');
const { acceptPackRenderResult } = await import('../reports/schedule.js');
const tick = () => runTick({ projectIds: [projectId], feeds: false, reports: false, alerts: false });

type User = Awaited<ReturnType<typeof signUp>>;
type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

let owner: User;
let viewer: User;
let applicant: User;
let other: User;
let farmer: User;
let projectId: string;
let app: string;
let otherApp: string;
let pack: string;
let otherPack: string;

const outlet = node('Rooikloof', null);
const kalk = node('Kalkoenkrans', outlet.id);
const P = () => `/projects/${projectId}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const copyOf = (u: User, sid: string, k: string, method: 'GET' | 'POST' = 'POST') => u.call(method, `${P()}/scenarios/${sid}/packs/${k}/pdf`, method === 'POST' ? {} : undefined);

async function arrange<T>(fn: (q: Q) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		const result = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
		await client.query('COMMIT');
		return result;
	} finally {
		await client.end();
	}
}

async function plant(q: Q, ownerId: string, title: string): Promise<{ sid: string; packId: string }> {
	const [run] = await q(`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs) VALUES ($1, $2, '1.50.0', '2000-10-01', '2020-09-30', '{}') RETURNING id::text`, [
		projectId,
		owner.id
	]);
	const [s] = await q(
		`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin, status, submitted_at, owned_node_ids)
		 VALUES ($1, $2, $3, repeat('a', 64), $4, 'applicant', 'submitted', now(), $5) RETURNING id::text`,
		[projectId, title, run!.id, ownerId, [kalk.id]]
	);
	const [appRun] = await q(
		`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, scenario_id) VALUES ($1, $2, '1.50.0', '2000-10-01', '2020-09-30', '{}', $3) RETURNING id::text`,
		[projectId, owner.id, s!.id]
	);
	const id = randomUUID();
	const report = { version: 'evidence-8', mode: 'application', identity: { title }, assumptionsChanged: false, rows: [], river: [], users: [], verification: { errata: [] } };
	const manifest = { pack: { id, version: 1 }, project: { id: projectId, name: 'Copies' }, engine: { version: '1.50.0' }, report };
	await q(
		`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, scenario_id, scenario_run_id, status, manifest, manifest_sha256, report_version, engine_version, created_by, issued_at, issued_by)
		 VALUES ($1, $2, $3, 1, $4, $8, 'issued', $5, $6, 'evidence-8', '1.50.0', $7, now(), $7)`,
		[id, projectId, run!.id, s!.id, JSON.stringify(manifest), sha(id), owner.id, appRun!.id]
	);
	return { sid: s!.id as string, packId: id };
}

beforeAll(async () => {
	[owner, viewer, applicant, other, farmer] = (await Promise.all(['Cpowner', 'Cpviewer', 'Cpapplicant', 'Cpother', 'Cpfarmer'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Copies' })).body.project.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet, kalk], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	for (const [u, role] of [
		[viewer, 'viewer'],
		[applicant, 'contributor'],
		[other, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [kalk.id] })).status).toBe(200);
	expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: [kalk.id] })).status).toBe(201);
	await arrange(async (q) => {
		({ sid: app, packId: pack } = await plant(q, applicant.id, 'Raise the Kalkoenkrans dam'));
		({ sid: otherApp, packId: otherPack } = await plant(q, other.id, 'Another application'));
	});
});

afterAll(() => retirePendingJobs(projectId));

describe("the applicant's printable copy", () => {
	it('is asked for by nobody but a party of the application (control: its applicant)', async () => {
		expect((await copyOf(other, app, pack)).status).toBe(404);
		expect((await copyOf(applicant, otherApp, otherPack)).status).toBe(404);
		// A pack of another application under this one's path.
		expect((await copyOf(applicant, app, otherPack)).status).toBe(404);
		expect((await copyOf(viewer, app, pack)).status).toBe(404);
		expect((await copyOf(farmer, app, pack)).status).toBe(403);
		expect((await copyOf(applicant, app, pack, 'GET')).status).toBe(409);
		expect(rendered).toEqual([]);
	});

	it("prints the party's own pack page as them, stores it beside the pack's PDF and records its own hash once", async () => {
		const res = await copyOf(applicant, app, pack);
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		expect(res.body.copy).toMatchObject({ status: 'rendering' });
		// Queued as the applicant, one pending per pack and party: asking again while it waits queues nothing more.
		expect((await copyOf(applicant, app, pack)).status).toBe(202);
		expect(await asOwner(`SELECT acting_user_id, dedupe_key FROM job WHERE project_id = $1 AND kind = 'applicant_pack_render'`, [projectId])).toEqual([
			{ acting_user_id: applicant.id, dedupe_key: `applicant_copy:${pack}:${applicant.id}` }
		]);
		await tick();
		// One render, of the applicant's page, under the applicant/ key.
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toMatchObject({ projectId, packId: pack, scenarioId: app });
		const bytes = Buffer.from(`%PDF-1.7 the applicant's copy of ${pack}`);
		const digest = createHash('sha256').update(bytes).digest('hex');
		expect(puts).toEqual([{ key: `packs/${projectId}/${pack}/applicant/${digest}.pdf`, sha256: digest }]);
		const [row] = await asOwner('SELECT pdf_key, pdf_sha256, pdf_pages FROM evidence_pack_applicant_copy WHERE pack_id = $1', [pack]);
		expect(row).toEqual({ pdf_key: `packs/${projectId}/${pack}/applicant/${digest}.pdf`, pdf_sha256: digest, pdf_pages: 3 });
		// The pack's own PDF is untouched: the copy is not the pack.
		expect((await asOwner('SELECT pdf_key FROM evidence_pack WHERE id = $1', [pack]))[0]!.pdf_key).toBeNull();
		// Asking again changes nothing: the first copy stands.
		const again = await copyOf(applicant, app, pack);
		expect(again.status).toBe(200);
		expect(again.body.copy).toMatchObject({ status: 'ready', sha256: digest, pages: 3 });
		expect(rendered).toHaveLength(1);
		// The download: a short-lived signed GET named as the applicant's copy.
		const dl = await anon('GET', `${P()}/scenarios/${app}/packs/${pack}/pdf`, undefined, applicant.cookie);
		expect(dl.status).toBe(302);
		expect(decodeURIComponent(dl.headers.get('location') ?? '')).toContain('-applicant-copy.pdf');
		// Others still read nothing of it (control: the applicant's pack view carries it).
		expect((await applicant.call('GET', `${P()}/scenarios/${app}/packs/${pack}`)).body.copy).toMatchObject({ status: 'ready', sha256: digest });
		expect(await withUser(other.id, async (db) => (await db.query('SELECT * FROM evidence_pack_applicant_copy')).rows)).toEqual([]);
		expect((await copyOf(other, app, pack, 'GET')).status).toBe(404);
	});

	it("gives the render session the party's pack page and nothing else", async () => {
		const token = rendered[0]!.token;
		// The job's token was consumed by nobody (the browser is stubbed): it opens a session now.
		const session = await anon('POST', '/auth/render-session', { token });
		expect(session.status, JSON.stringify(session.body)).toBe(200);
		const cookie = session.headers.get('set-cookie')!.split(';')[0]!;
		const get = (path: string) => anon('GET', path, undefined, cookie);
		expect((await get(`${P()}/scenarios/${app}/packs/${pack}`)).status).toBe(200);
		// Every signed-in route the app has, with this pack's ids: only the one read answers (docs/security.md § Render tokens).
		// (Not the public ones: POST /auth/logout would end the session the sweep is using.)
		const signedIn = /^\/(projects|teams|me|compare|auth\/me|auth\/mfa)(\/|$)/;
		const routes = [
			...new Set(api.routes.filter((r) => r.method !== 'ALL' && r.method !== 'OPTIONS' && signedIn.test(r.path)).map((r) => `${r.method} ${r.path}`))
		];
		const opened: string[] = [];
		for (const route of routes) {
			const [method, pattern] = route.split(' ') as [string, string];
			const path = pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => (name === 'id' ? projectId : name === 'sid' ? app : name === 'packId' ? pack : randomUUID()));
			const res = await anon(method, path, method === 'GET' || method === 'DELETE' ? undefined : {}, cookie);
			if (res.status !== 403 && res.status !== 404 && res.status !== 400) opened.push(`${route} → ${res.status}`);
		}
		expect(opened.sort()).toEqual(['GET /auth/me → 200', 'GET /projects/:id/scenarios/:sid/packs/:packId → 200']);
		for (const path of [
			`${P()}/packs/${pack}`,
			`${P()}/scenarios/${app}`,
			`${P()}/scenarios/${app}/packs/${pack}/pdf`,
			`${P()}/scenarios/${app}/packs`,
			`${P()}/scenarios/${otherApp}/packs/${otherPack}`,
			`${P()}`,
			`/projects`
		])
			expect((await get(path)).status, path).toBe(403);
	});

	it('issues an applicant token only to a party, for an issued pack of theirs (control: the applicant)', async () => {
		const insert = `INSERT INTO render_token (token_hash, user_id, project_id, pack_id, purpose, expires_at) VALUES ($1, app_current_user_id(), $2, $3, 'applicant_pack', now())`;
		const hash = () => createHash('sha256').update(randomUUID()).digest();
		await expect(withUser(other.id, (db) => db.query(insert, [hash(), projectId, pack]))).rejects.toThrow(/not permitted/);
		await expect(withUser(viewer.id, (db) => db.query(insert, [hash(), projectId, pack]))).rejects.toThrow(/not permitted/);
		await withUser(applicant.id, (db) => db.query(insert, [hash(), projectId, pack]));
		// A viewer's pack token stays a pack token (the editor's page), never an applicant's: the purpose follows the issuer's ask only for a party.
		const [t] = await asOwner(`SELECT purpose FROM render_token WHERE user_id = $1 AND pack_id = $2 ORDER BY created_at DESC LIMIT 1`, [applicant.id, pack]);
		expect(t!.purpose).toBe('applicant_pack');
	});

	it("records a copy only from the party's own running job (control: the job above recorded one)", async () => {
		await expect(withUser(applicant.id, (db) => db.query(`SELECT app_record_applicant_pack_pdf($1, $2, 1)`, [otherPack, 'a'.repeat(64)]))).rejects.toThrow(/render job/);
		await expect(withUser(owner.id, (db) => db.query(`SELECT app_record_applicant_pack_pdf($1, $2, 1)`, [otherPack, 'a'.repeat(64)]))).rejects.toThrow(/render job/);
		await expect(withUser(applicant.id, (db) => db.query(`INSERT INTO evidence_pack_applicant_copy (pack_id, project_id, pdf_key, pdf_sha256, pdf_pages) VALUES ($1, $2, 'x', $3, 1)`, [otherPack, projectId, 'a'.repeat(64)]))).rejects.toThrow(/permission denied/);
	});

	it("routes the renderer's answer about a copy to the party who asked, as their own job (production; control: a copy recorded takes none)", async () => {
		await withUser(other.id, (db) => enqueueJob(db, { projectId, kind: 'applicant_pack_render', payload: { packId: otherPack }, maxAttempts: 1 }));
		const answer = (packId: string) =>
			acceptPackRenderResult({ v: 1, type: 'rendered_pack', packId, copy: 'applicant', result: { ok: false, error: 'the render took longer than 90 s', retry: false } });
		expect(await answer(otherPack)).toBe('queued');
		const jobs = await asOwner(`SELECT acting_user_id, payload ? 'result' AS answered FROM job WHERE project_id = $1 AND kind = 'applicant_pack_render' AND payload->>'packId' = $2 ORDER BY created_at`, [
			projectId,
			otherPack
		]);
		expect(jobs).toEqual([
			{ acting_user_id: other.id, answered: false },
			{ acting_user_id: other.id, answered: true }
		]);
		// The copy of `pack` is recorded: an answer about it finds no request to follow.
		expect(await answer(pack)).toBe('unknown_pack');
		// Nor is it the pack's own PDF's answer: that one goes to pack_render, which nobody asked for here.
		expect(await acceptPackRenderResult({ v: 1, type: 'rendered_pack', packId: otherPack, result: { ok: false, error: 'x', retry: false } })).toBe('unknown_pack');
	});
});
