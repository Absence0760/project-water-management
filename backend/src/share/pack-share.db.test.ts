// Share links to one evidence pack, and comments on it (roadmap WP-3.15, the
// pack half; issue #71; 128_pack_share_notes.sql; docs/security.md § Share
// links → Pack links, docs/evidence-pack.md § Sharing and comments). An
// editor links an issued pack; anyone holding the link reads what verify
// already says plus a redacted projection of the pack's own frozen report;
// once the pack is withdrawn or superseded the link says so, not the figures.
// Every "cannot" has its positive control (CLAUDE.md rule 5):
//
//   - who makes, lists and revokes a pack link (an editor, an issued pack);
//   - a link opens its own pack only, and no other kind of link opens a pack;
//   - revoked, expired: no answer, with a live token as control;
//   - the answer is redacted: no farm, user, holder, member, other
//     application or applicant statement; volume rows only past the k rule
//     and without a changed baseline assumption;
//   - withdrawn and superseded: the standing, its reason or successor, and
//     the comments, never the figures;
//   - the note matrix on a pack (team, public participation), reads and
//     writes, per role, and every edit kept.
//
// The packs are planted past their guards (replica role), as
// db/cross-project-refs.security.db.test.ts plants them: issuing a real one
// needs an issuable report (nomination, ensembles), which evidence/packs.db.test.ts
// covers; this file is about the link and the notes.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User; // editor
let ngo: User; // viewer
let applicant: User; // contributor
let farmer: User;
let projectId: string;
let smallProjectId: string;
let runId: string;
/** Baseline evidence, issued; 5 farm holders. */
let packId: string;
/** An application pack, issued, whose report changed a baseline assumption. */
let assumptionPackId: string;
/** A draft. */
let draftId: string;
/** Baseline evidence in a catchment of 2 farms, issued. */
let smallPackId: string;

const outlet = node('Rooikloof', null);
const gauge = node('Sandspruit weir', outlet.id, { kind: 'gauge' });
const FARMS = ['Kalkoenkrans', 'Bergvliet', 'Doornhoek', 'Waterval', 'Klipfontein'];
const farms = FARMS.map((n) => node(n, outlet.id));
const HOLDER = 'Secret Holder Pty';
const OWNER_NAME = 'Jane Applicant';
const STATEMENT = 'Our private reasons for the dam';
const OTHER_APP = 'The neighbour’s proposal';
/** Strings the frozen report holds that a link must never show. */
const LEAKS = [...FARMS, HOLDER, OWNER_NAME, STATEMENT, OTHER_APP, 'Rooikloof', 'modeller-only note'];

const P = (pid = projectId) => `/projects/${pid}`;
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('t')!;
const openPack = (token: string) => anon('POST', '/share/pack', { token });
const link = (u: User, target: string, label = 'Forum', pid = projectId) =>
	u.call('POST', `${P(pid)}/share-links`, { label, expiresInDays: 30, targetKind: 'pack', targetId: target });
const rowsAs = async (u: User, sql: string, params: unknown[] = []) => withUser(u.id, async (db) => (await db.query(sql, params)).rows);

/** A report as the engine freezes it, with a secret wherever a link must not look. */
function report(mode: 'baseline' | 'application', assumptionsChanged = false) {
	const row = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		label: `Row ${id}`,
		basis: `Reserve rule table (${HOLDER} study)`,
		subject: null,
		unit: 'days',
		higherIsWorse: true,
		baseline: 10,
		application: mode === 'application' ? 12 : null,
		change: { run: 2, band: { n: 30, p5: 1, p50: 2, p95: 3, min: 0, max: 4 }, bandNote: null, worse: { k: 25, n: 30 } },
		notAssessed: null,
		note: null,
		...extra
	});
	return {
		version: 'evidence-5',
		mode,
		builtBy: '1.50.0',
		identity: {
			title: mode === 'application' ? 'Raise the weir dam' : 'Shared packs',
			project: { id: projectId, name: 'Shared packs' },
			baseline: { runId, label: 'Baseline', engineVersion: '1.50.0', runoffModel: 'gr4j', startDate: '2000-10-01', endDate: '2020-09-30', createdAt: 'x', createdBy: OWNER_NAME, nomination: { nominatedAt: 'x', nominatedBy: OWNER_NAME, reason: 'modeller-only note' }, published: 'this', publishedAt: null },
			application: mode === 'application' ? { runId, label: 'App', engineVersion: '1.50.0', createdAt: 'x', createdBy: OWNER_NAME, scenarioId: runId, scenarioName: 'Raise the weir dam', scenarioStatus: 'submitted', ownerName: OWNER_NAME, opsSha256: 'x', proposals: 1, assumptions: assumptionsChanged ? 1 : 0 } : null
		},
		assumptionsChanged,
		flags: [{ id: 'f', level: 'red', text: `Kalkoenkrans is short`, effect: null }],
		questions: ['Why is Bergvliet short?'],
		rows: [
			row('reserve', { subject: 'Rooikloof', unit: '% of months', note: '10 of 12 months' }),
			row('reserve', { subject: 'Sandspruit weir', unit: '% of months', note: '11 of 12 months' }),
			row('ewrDays'),
			row('shortfall', { unit: 'Mm³' }),
			row('noFlowDays', { note: 'Longest spell 3 days' }),
			row('ewrBelowWorks', { subject: 'Sandspruit weir, below Kalkoenkrans' }),
			row('outflowMar', { unit: 'Mm³/a', note: '80 % of the natural MAR' }),
			row('registeredUse', { subject: HOLDER }),
			row('userSupply', { subject: 'Doornhoek' }),
			row('otherApplications', { note: `1 application: “${OTHER_APP}”` })
		],
		byMonth: [{ month: 10, run: 1, band: { n: 30, p5: 0, p50: 1, p95: 2, min: 0, max: 3 }, nodeId: farms[0]!.id }],
		river: [
			{ key: 'outlet', name: 'Rooikloof', isOutlet: true, source: 'Study', category: 'C', monthsA: 12, rateA: 0.9, rateB: 0.8, longestA: 1, longestB: 2, lost: 1, gained: 0, months: [{ year: 2001, month: 1, deliveredA: 0.5 }], worst: { year: 2001, month: 1, delivered: 0.5 } },
			{ key: gauge.id, name: 'Sandspruit weir', isOutlet: false, source: 'Study', category: 'B', monthsA: 12, rateA: 1, rateB: 1, longestA: 0, longestB: 0, lost: 0, gained: 0, months: [] }
		],
		users: FARMS.map((name) => ({ name, nodeId: randomUUID() })),
		allocations: { rows: [{ holder: HOLDER }] },
		// evidence-11: the combined run names the other applications and their conflicts; none of it leaves (allowlist).
		cumulative: {
			applications: [{ scenarioName: OTHER_APP }],
			combined: { applications: [{ scenarioName: OTHER_APP }], conflicts: [`"${OTHER_APP}" op 1 (node.set) and "x" op 1 (node.set) both change node "Rooikloof": damCapacityM3`] }
		},
		appendix: { baselineInputs: { model: { nodes: FARMS.map((name) => ({ name })) } }, changes: [], series: [], warnings: { baseline: ['Kalkoenkrans has no crops'], application: null } },
		verification: { methodology: { version: 'm1', sha256: 'a'.repeat(64) }, limitations: [], errata: [{ id: 'E1', summary: 'An erratum' }], disclaimerVersion: 'v3' },
		applicantStatement: mode === 'application' ? { scenarioName: 'Raise the weir dam', description: STATEMENT, ownerName: OWNER_NAME, notes: STATEMENT, notesUpdatedAt: null, notesUpdatedBy: OWNER_NAME } : null,
		summaries: { baseline: { farms: FARMS.map((name) => ({ name })) }, application: null }
	};
}

/** Plant past the guards, as the replica role does (triggers off; CHECKs and the one-issued exclusion stay). */
async function arrange<T>(fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		const result = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
		await client.query('COMMIT');
		return result;
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		await client.end();
	}
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** An evidence pack row: `status` issued (or draft), with its report and a sign-off. */
async function plantPack(
	q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
	o: { project: string; run: string; status: 'issued' | 'draft'; rep: unknown; scenario?: string | null; scenarioRun?: string | null; version?: number; supersedes?: string | null }
): Promise<string> {
	const id = randomUUID();
	const version = o.version ?? 1;
	const manifest = { pack: { id, version }, project: { id: o.project, name: 'Shared packs' }, engine: { version: '1.50.0' }, report: o.rep };
	await q(
		`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, supersedes_pack_id, scenario_id, scenario_run_id, status, manifest, manifest_sha256,
			report_version, engine_version, created_by, issued_at, issued_by, bundle_key, bundle_sha256)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'evidence-5', '1.50.0', $11,
			CASE WHEN $8 = 'draft' THEN NULL ELSE now() END, CASE WHEN $8 = 'draft' THEN NULL ELSE $11::uuid END,
			CASE WHEN $8 = 'draft' THEN NULL ELSE 'packs/x.zip' END, CASE WHEN $8 = 'draft' THEN NULL ELSE $12 END)`,
		[id, o.project, o.run, version, o.supersedes ?? null, o.scenario ?? null, o.scenarioRun ?? null, o.status, JSON.stringify(manifest), sha(id), assessor.id, sha(`bundle ${id}`)]
	);
	await q(
		`INSERT INTO signoff (project_id, pack_id, user_id, full_name, registration_body, registration_category, registration_field, registration_no, scope, statement_version, statement_sha256, disclaimer_version)
		 VALUES ($1, $2, $3, 'Dr A Signer', 'sacnasp', 'pr_sci_nat', 'water_resources', '400123/10', 'x', 'pack-signoff-1', repeat('a', 64), 'v3')`,
		[o.project, id, assessor.id]
	);
	return id;
}

async function plantRun(q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>, project: string, scenario: string | null = null): Promise<string> {
	const rows = await q(
		`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, scenario_id) VALUES ($1, $2, '1.50.0', '2000-10-01', '2020-09-30', '{}', $3) RETURNING id::text`,
		[project, owner.id, scenario]
	);
	return rows[0]!.id as string;
}

beforeAll(async () => {
	[owner, assessor, ngo, applicant, farmer] = (await Promise.all(['Pkowner', 'Pkassessor', 'Pkngo', 'Pkapplicant', 'Pkfarmer'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Shared packs' })).body.project.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet, gauge, ...farms], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	for (const [u, role] of [
		[assessor, 'editor'],
		[ngo, 'viewer'],
		[applicant, 'contributor']
	] as const) {
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
	}
	expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: [farms[0]!.id] })).status).toBe(201);

	smallProjectId = (await owner.call('POST', '/projects', { name: 'Small packs' })).body.project.id;
	const small = node('Outlet', null);
	expect((await owner.call('PUT', `${P(smallProjectId)}/model`, { nodes: [small, node('One', small.id), node('Two', small.id)], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `${P(smallProjectId)}/members`, { email: assessor.email, role: 'editor' })).status).toBe(201);

	await arrange(async (q) => {
		runId = await plantRun(q, projectId);
		packId = await plantPack(q, { project: projectId, run: runId, status: 'issued', rep: report('baseline') });
		draftId = await plantPack(q, { project: projectId, run: runId, status: 'draft', rep: report('baseline'), version: 2, supersedes: packId });
		const [sc] = await q(
			`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin, status, submitted_at) VALUES ($1, 'Raise the weir dam', $2, repeat('a', 64), $3, 'applicant', 'submitted', now()) RETURNING id::text`,
			[projectId, runId, applicant.id]
		);
		const scenarioRun = await plantRun(q, projectId, sc!.id as string);
		assumptionPackId = await plantPack(q, { project: projectId, run: runId, status: 'issued', rep: report('application', true), scenario: sc!.id as string, scenarioRun });
		const smallRun = await plantRun(q, smallProjectId);
		smallPackId = await plantPack(q, { project: smallProjectId, run: smallRun, status: 'issued', rep: report('baseline') });
	});
}, 120_000);

describe('making a pack link', () => {
	it('refuses a draft (409); an unknown or another project’s pack is not found', async () => {
		expect((await link(assessor, draftId)).status).toBe(409);
		expect((await link(assessor, randomUUID())).status).toBe(404);
		expect((await link(assessor, smallPackId)).status).toBe(404);
	});

	it('lets an editor and the owner link an issued pack; not a viewer, an applicant or a farmer', async () => {
		const made = await link(assessor, packId, 'Catchment forum');
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		expect(made.body.link).toMatchObject({ targetKind: 'pack', targetId: packId, mine: true, label: 'Catchment forum', target: { name: 'Shared packs', status: 'issued', version: 1 } });
		expect(made.body.link.url).toMatch(/\/share#t=[A-Za-z0-9_-]{43}&k=pack$/);
		expect((await link(owner, packId, 'Owner copy')).status).toBe(201);
		for (const u of [ngo, applicant, farmer]) expect((await link(u, packId)).status).toBe(403);
		// The same in the database, past the route (share_link_insert): a viewer is refused, an editor on a draft too.
		const insert = `INSERT INTO share_link (project_id, label, token_hash, expires_at, target_kind, target_id) VALUES ($1, 'x', $2, now() + interval '1 day', 'pack', $3)`;
		await expect(rowsAs(ngo, insert, [projectId, Buffer.alloc(32, 21), packId])).rejects.toThrow(/row-level security/);
		await expect(rowsAs(assessor, insert, [projectId, Buffer.alloc(32, 22), draftId])).rejects.toThrow(/row-level security/);
		// Control: the editor's own insert on the issued pack passes the policy.
		expect(await rowsAs(assessor, `${insert} RETURNING 1 AS ok`, [projectId, Buffer.alloc(32, 23), packId])).toEqual([{ ok: 1 }]);
	});

	it("refuses another project's pack as a target, in the database too", async () => {
		await expect(
			asOwner(`INSERT INTO share_link (project_id, label, token_hash, expires_at, target_kind, target_id) VALUES ($1, 'x', $2, now() + interval '1 day', 'pack', $3)`, [
				smallProjectId,
				Buffer.alloc(32, 24),
				packId
			])
		).rejects.toThrow(/different project/);
	});

	it("lists a pack's links to its editors; the owner's inventory names the pack", async () => {
		const byAssessor = await assessor.call('GET', `${P()}/share-links?packId=${packId}`);
		expect(byAssessor.status).toBe(200);
		expect(byAssessor.body.links.map((l: { label: string }) => l.label).sort()).toEqual(['Catchment forum', 'Owner copy', 'x']);
		expect((await ngo.call('GET', `${P()}/share-links?packId=${packId}`)).status).toBe(403);
		expect((await applicant.call('GET', `${P()}/share-links?packId=${packId}`)).status).toBe(403);
		expect((await assessor.call('GET', `${P()}/share-links?packId=${randomUUID()}`)).status).toBe(404);
		// RLS: a viewer reads no pack link row; the assessor (control) does.
		expect(await rowsAs(ngo, `SELECT 1 FROM share_link WHERE target_kind = 'pack'`)).toEqual([]);
		expect((await rowsAs(assessor, `SELECT 1 FROM share_link WHERE target_kind = 'pack'`)).length).toBe(3);
		const all = await owner.call('GET', `${P()}/share-links?scope=all`);
		const forum = all.body.links.find((l: { label: string }) => l.label === 'Catchment forum');
		expect(forum).toMatchObject({ targetKind: 'pack', target: { name: 'Shared packs', status: 'issued', version: 1 } });
		// The baseline list stays baseline links.
		expect((await owner.call('GET', `${P()}/share-links`)).body.links).toEqual([]);
	});
});

describe('opening a pack link', () => {
	let token: string;
	let assumptionToken: string;
	let smallToken: string;
	let catchmentToken: string;

	beforeAll(async () => {
		token = tokenOf((await link(assessor, packId, 'Open me')).body.link.url);
		assumptionToken = tokenOf((await link(assessor, assumptionPackId, 'Assumption')).body.link.url);
		smallToken = tokenOf((await link(assessor, smallPackId, 'Small', smallProjectId)).body.link.url);
		// A baseline link (the owner's), which needs nothing published to be made.
		catchmentToken = tokenOf((await owner.call('POST', `${P()}/share-links`, { label: 'Baseline', expiresInDays: 7 })).body.link.url);
	});

	it('opens its own issued pack, signed out: verify’s fields, the redacted figures, no secret', async () => {
		const res = await openPack(token);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		const v = res.body;
		expect(v.pack).toMatchObject({ id: packId, title: 'Shared packs', mode: 'baseline', version: 1 });
		expect(v.project).toEqual({ id: projectId });
		// Exactly what GET /verify/:code answers for this pack.
		const verify = await anon('GET', `/verify/${v.pack.shortCode}`);
		expect(verify.status).toBe(200);
		expect(v.verify).toEqual(verify.body.pack);
		expect(v.verify.signers[0]).toMatchObject({ fullName: 'Dr A Signer' });
		// The river's rows, the gauge named, the outlet not; volume rows at 5 farm holders.
		expect(v.figures.rows.map((r: { id: string; subject: string | null }) => [r.id, r.subject])).toEqual([
			['reserve', null],
			['reserve', 'Sandspruit weir'],
			['ewrDays', null],
			['shortfall', null],
			['noFlowDays', null],
			['outflowMar', null]
		]);
		expect(v.figures.volumes).toBe(true);
		expect(v.figures.rows[0].change.band).toEqual({ n: 30, p5: 1, p50: 2, p95: 3 });
		expect(v.figures.river.map((s: { name: string | null }) => s.name)).toEqual([null, 'Sandspruit weir']);
		expect(v.figures.byMonth).toEqual([{ month: 10, run: 1, band: { n: 30, p5: 0, p50: 1, p95: 2 } }]);
		const text = JSON.stringify(v);
		for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
		for (const id of [...farms.map((f) => f.id), gauge.id, assessor.id, owner.id]) expect(text).not.toContain(id);
		expect(text).not.toMatch(/@example\.com/);
	});

	it('withholds the volume rows in a catchment of fewer than 5 farm holders, and when a baseline assumption changed', async () => {
		const small = await openPack(smallToken);
		expect(small.status).toBe(200);
		expect(small.body.figures.volumes).toBe(false);
		expect(small.body.figures.rows.map((r: { id: string }) => r.id)).toEqual(['reserve', 'reserve', 'ewrDays', 'noFlowDays']);
		const changed = await openPack(assumptionToken);
		expect(changed.status).toBe(200);
		expect(changed.body.figures.volumes).toBe(false);
		expect(changed.body.figures.identity.application).toEqual({ engineVersion: '1.50.0', proposals: 1, assumptions: 1 });
		const text = JSON.stringify(changed.body);
		for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
	});

	it('opens only its own kind: a pack link reads no catchment or scenario, and a baseline link no pack', async () => {
		expect((await openPack(catchmentToken)).status).toBe(404);
		expect((await anon('POST', '/share/scenario', { token })).status).toBe(404);
		expect((await anon('POST', '/share/series', { token, key: 'ewr' })).status).toBe(404);
		// The same token as control, on its own read.
		expect((await openPack(token)).status).toBe(200);
		expect((await openPack(assumptionToken)).body.pack.id).toBe(assumptionPackId);
	});

	it('is dead once revoked or expired, beside a live one', async () => {
		const revoked = await link(assessor, packId, 'To revoke');
		const expired = await link(assessor, packId, 'To expire');
		const r = tokenOf(revoked.body.link.url);
		const e = tokenOf(expired.body.link.url);
		expect((await openPack(r)).status).toBe(200);
		expect((await openPack(e)).status).toBe(200);
		expect((await assessor.call('DELETE', `${P()}/share-links/${revoked.body.link.id}`)).status).toBe(204);
		await asOwner(`UPDATE share_link SET expires_at = now() - interval '1 minute', created_at = now() - interval '1 day' WHERE id = $1`, [expired.body.link.id]);
		for (const t of [r, e, 'not-a-token', 'A'.repeat(43)]) {
			const res = await openPack(t);
			expect(res.status).toBe(404);
			expect(res.body).toEqual({ error: 'not found' });
		}
		expect((await openPack(token)).status).toBe(200);
	});
});

describe('comments on a pack', () => {
	let token: string;
	let linkId: string;
	const post = (u: User, visibility?: string, id = packId) =>
		u.call('POST', `${P()}/notes`, { body: `From ${u === ngo ? 'the NGO' : u === applicant ? 'the applicant' : u === assessor ? 'the assessor' : 'someone'}`, packId: id, ...(visibility ? { visibility } : {}) });

	beforeAll(async () => {
		// Only the links this block makes: close the earlier ones.
		await asOwner(`UPDATE share_link SET revoked_at = now() WHERE project_id = $1 AND target_kind = 'pack' AND revoked_at IS NULL`, [projectId]);
		const made = await link(assessor, packId, 'Comment period');
		token = tokenOf(made.body.link.url);
		linkId = made.body.link.id;
	});

	it('takes the team’s notes from whoever reads the pack, and public comments from any member while a link is live', async () => {
		// Team: the assessor and the viewer read the pack; the applicant doesn't.
		expect((await post(assessor, 'team')).status).toBe(201);
		const team = await post(ngo, 'team');
		expect(team.status).toBe(201);
		expect(team.body.note).toMatchObject({ packId, target: 'pack', visibility: 'team' });
		expect((await post(applicant, 'team')).status).toBe(403);
		// Public participation: every member contributor and up.
		for (const u of [ngo, applicant, assessor]) expect((await post(u, 'public_participation')).status).toBe(201);
		// A farmer comments on no pack; the scenario audiences don't exist on one.
		expect((await post(farmer, 'public_participation')).status).toBe(403);
		expect((await post(assessor, 'assessors')).status).toBe(400);
		expect((await post(assessor, 'farm')).status).toBe(400);
		// A member of no project: not found. Another project's pack: not found.
		const stranger = await signUp('Pkstranger');
		expect((await post(stranger, 'public_participation')).status).toBe(404);
		expect((await post(assessor, 'public_participation', smallPackId)).status).toBe(404);
	});

	it('shows the public comments on the link, never the team’s', async () => {
		const res = await openPack(token);
		expect(res.body.comments.map((c: { body: string }) => c.body).sort()).toEqual(['From the NGO', 'From the applicant', 'From the assessor']);
		expect(JSON.stringify(res.body.comments)).not.toMatch(/authorId|@example/);
	});

	it('lets the applicant read the public comments while open, and never the team’s notes', async () => {
		const list = await applicant.call('GET', `${P()}/notes?packId=${packId}`);
		expect(list.status).toBe(200);
		expect(list.body.notes.every((n: { visibility: string }) => n.visibility === 'public_participation')).toBe(true);
		expect(list.body.notes.length).toBe(3);
		// The viewer (control) reads the team's too.
		const all = await ngo.call('GET', `${P()}/notes?packId=${packId}`);
		expect(all.body.notes.map((n: { visibility: string }) => n.visibility).sort()).toEqual(['public_participation', 'public_participation', 'public_participation', 'team', 'team']);
		// Counts carry the pack.
		expect((await ngo.call('GET', `${P()}/notes/counts`)).body.packs[packId]).toBe(5);
		// A farmer reads none of them.
		expect((await farmer.call('GET', `${P()}/notes?packId=${packId}`)).body.notes).toEqual([]);
	});

	it('keeps every edit of a pack note', async () => {
		const mine = (await applicant.call('GET', `${P()}/notes?packId=${packId}`)).body.notes.find((n: { mine: boolean }) => n.mine);
		expect((await applicant.call('PATCH', `${P()}/notes/${mine.id}`, { body: 'Edited objection' })).status).toBe(200);
		const rev = await applicant.call('GET', `${P()}/notes/${mine.id}/revisions`);
		expect(rev.body.revisions.map((r: { body: string }) => r.body)).toEqual(['From the applicant']);
	});

	it('closes comment when no link is live: the applicant reads only their own, and posts nothing', async () => {
		expect((await assessor.call('DELETE', `${P()}/share-links/${linkId}`)).status).toBe(204);
		// The applicant reads no pack row (this one is the baseline's, not theirs): with no live link it is not one they can comment on, so not found to them.
		expect((await post(applicant, 'public_participation')).status).toBe(404);
		// A reader of the pack is told why.
		const closed = await post(ngo, 'public_participation');
		expect(closed.status).toBe(403);
		expect(closed.body.code).toBe('note_comment_closed');
		// The pack is still issued, so its comment period is simply closed: others' comments hide from the applicant.
		const list = await applicant.call('GET', `${P()}/notes?packId=${packId}`);
		expect(list.body.notes.map((n: { mine: boolean }) => n.mine)).toEqual([true]);
		// The editor (control) reads them all.
		expect((await assessor.call('GET', `${P()}/notes?packId=${packId}&limit=50`)).body.notes.length).toBe(5);
	});

	it('refuses a pack note of a scenario audience, or public participation with no target, in the database', async () => {
		await expect(asOwner(`INSERT INTO note (project_id, author_id, body, pack_id, visibility) VALUES ($1, $2, 'x', $3, 'assessors')`, [projectId, assessor.id, packId])).rejects.toThrow(
			/note_pack_audience|note_participation_on_scenario/
		);
		await expect(asOwner(`INSERT INTO note (project_id, author_id, body, visibility) VALUES ($1, $2, 'x', 'public_participation')`, [projectId, assessor.id])).rejects.toThrow(
			/note_participation_on_scenario/
		);
		await expect(asOwner(`INSERT INTO note (project_id, author_id, body, pack_id, visibility) VALUES ($1, $2, 'x', $3, 'team')`, [smallProjectId, assessor.id, packId])).rejects.toThrow(
			/different project/
		);
		// Control: the same row in its own project.
		expect(await asOwner(`INSERT INTO note (project_id, author_id, body, pack_id, visibility) VALUES ($1, $2, 'x', $3, 'team') RETURNING 1 AS ok`, [projectId, assessor.id, packId])).toEqual([{ ok: 1 }]);
	});

	it('carries the pack in the author’s data export', async () => {
		await asOwner('UPDATE app_user SET data_exported_at = NULL WHERE id = $1', [ngo.id]);
		const res = await ngo.call('GET', '/auth/me/export');
		expect(res.status).toBe(200);
		expect(res.body.notes.some((n: { packId: string | null }) => n.packId === packId)).toBe(true);
	});
});

describe('a pack withdrawn or superseded after it was shared', () => {
	it('shows the withdrawal and its reason, and the comments, not the figures', async () => {
		const made = await link(assessor, assumptionPackId, 'Before withdrawal');
		const t = tokenOf(made.body.link.url);
		expect((await ngo.call('POST', `${P()}/notes`, { body: 'Please explain the assumption', packId: assumptionPackId, visibility: 'public_participation' })).status).toBe(201);
		expect((await openPack(t)).body.figures).not.toBeNull();
		const w = await assessor.call('POST', `${P()}/packs/${assumptionPackId}/withdraw`, { reason: 'The baseline assumption was a mistake' });
		expect(w.status, JSON.stringify(w.body)).toBe(200);
		const res = await openPack(t);
		expect(res.status).toBe(200);
		expect(res.body.figures).toBeNull();
		expect(res.body.verify).toMatchObject({ status: 'withdrawn', withdrawnReason: 'The baseline assumption was a mistake' });
		expect(res.body.comments.map((c: { body: string }) => c.body)).toEqual(['Please explain the assumption']);
		// No new link to it, and no new comment on it; the record stays readable to a member who could comment.
		expect((await link(assessor, assumptionPackId)).status).toBe(409);
		const late = await applicant.call('POST', `${P()}/notes`, { body: 'Late', packId: assumptionPackId, visibility: 'public_participation' });
		expect(late.status).toBe(403);
		expect(late.body.code).toBe('note_comment_closed');
		const read = await applicant.call('GET', `${P()}/notes?packId=${assumptionPackId}`);
		expect(read.body.notes.map((n: { body: string }) => n.body)).toEqual(['Please explain the assumption']);
		// The owner's inventory says what it opens now.
		const all = await owner.call('GET', `${P()}/share-links?scope=all`);
		expect(all.body.links.find((l: { id: string }) => l.id === made.body.link.id).target).toMatchObject({ status: 'withdrawn' });
	});

	it('shows a superseded pack as superseded, with its successor’s hash', async () => {
		const made = await link(assessor, smallPackId, 'Before v2', smallProjectId);
		const t = tokenOf(made.body.link.url);
		const successor = await arrange(async (q) => {
			const [r] = await q(`SELECT baseline_run_id::text AS run FROM evidence_pack WHERE id = $1`, [smallPackId]);
			const id = await plantPack(q, { project: smallProjectId, run: r!.run as string, status: 'issued', rep: report('baseline'), version: 2, supersedes: smallPackId });
			await q(`UPDATE evidence_pack SET status = 'superseded', superseded_by_pack_id = $1 WHERE id = $2`, [id, smallPackId]);
			return id;
		});
		const res = await openPack(t);
		expect(res.status).toBe(200);
		expect(res.body.figures).toBeNull();
		expect(res.body.verify).toMatchObject({ status: 'superseded', successorSha256: sha(successor), withdrawnReason: null });
	});
});
