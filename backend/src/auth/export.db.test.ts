// The data-subject export, GET /auth/me/export (054_subject_export.sql,
// auth/export.ts; docs/security.md § Personal information (POPIA)). A farmer
// gets their own account, link, farm figures, registered volumes, notes,
// invites and audit events, and nothing of the other farmer's: every "not in
// it" check has the other farmer's own export as its positive control.
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { FARMER_NOTICE_VERSION, LEGAL_VERSION } from '@water-management/engine/legal';
import { APP_USER_EXCLUDED, APP_USER_EXPORTED, EXPORT_COOLDOWN_SECONDS, USER_FK_COVERAGE } from './export.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ORIGIN = 'http://localhost:7777';
let owner: User;
let farmer: User;
let other: User;
let projectId: string;
let secondProjectId: string;
const outlet = node('Outlet', null);
const farmA = node('Farm Alpha', outlet.id);
const farmB = node('Farm Bravo', outlet.id);
const TOKEN_HEX = 'cd'.repeat(32);
const NONCE_HEX = 'ab'.repeat(32);
const UNSUB_HEX = 'ef'.repeat(32);

/** The export as a browser downloads it; the cooldown is cleared first so each test can call it. */
async function download(u: { cookie: string; id: string }) {
	await asOwner('UPDATE app_user SET data_exported_at = NULL WHERE id = $1', [u.id]);
	const res = await app.request('/auth/me/export', { headers: { cookie: u.cookie, origin: ORIGIN } });
	const text = await res.text();
	return { res, text, doc: (res.status === 200 ? JSON.parse(text) : null) as Doc };
}

beforeAll(async () => {
	[owner, farmer, other] = (await Promise.all(['XOwner', 'XFarmer', 'XOther'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Export catchment' })).body.project.id;
	const model = { nodes: [outlet, farmA, farmB], crops: [], cropAreas: [], transfers: [], landCover: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 12 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-10-01', values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: other.email, nodeIds: [farmB.id] })).status).toBe(201);
	const runId = (await owner.call('POST', `/projects/${projectId}/runs`, { label: 'r' })).body.run.id;
	expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId })).status).toBe(201);
	for (const [nodeId, holder, reg] of [[farmA.id, 'Holder Alpha', 'REG-ALPHA'], [farmB.id, 'Holder Bravo', 'REG-BRAVO']] as const) {
		const res = await owner.call('POST', `/projects/${projectId}/allocations`, {
			nodeId, holder, registrationNo: reg, authorisation: 'registration', waterSource: 'surface', volumeM3PerYear: 12_000
		});
		expect(res.status).toBe(201);
	}
	expect((await farmer.call('POST', `/projects/${projectId}/notes`, { body: 'alpha note by the farmer', nodeId: farmA.id, visibility: 'farm' })).status).toBe(201);
	// The farmer pressed "I understand" on the farm view's notice (093); the other farmer never did.
	expect((await farmer.call('POST', '/auth/me/farm-notice', { version: FARMER_NOTICE_VERSION })).status).toBe(200);
	expect((await other.call('POST', `/projects/${projectId}/notes`, { body: 'bravo note by the other', nodeId: farmB.id, visibility: 'farm' })).status).toBe(201);
	// A lapsed invite to the farmer's address, to a project they never joined (only an owner reads it under RLS).
	secondProjectId = (await owner.call('POST', '/projects', { name: 'Invited catchment' })).body.project.id;
	await asOwner(
		`INSERT INTO invite (email, project_id, project_role, invited_by, token_hash, expires_at, created_at)
		 VALUES ($1, $2, 'viewer', $3, decode($4, 'hex'), now() - interval '1 day', now() - interval '8 days')`,
		[farmer.email, secondProjectId, owner.id, TOKEN_HEX]
	);
	// An alert choice, with the unsubscribe secrets the export must leave out.
	await asOwner(
		`INSERT INTO alert_subscription (user_id, project_id, kind, mode, unsubscribe_nonce, unsubscribe_hash)
		 VALUES ($1, $2, 'all', 'immediate', decode($3, 'hex'), decode($4, 'hex'))`,
		[farmer.id, projectId, NONCE_HEX, UNSUB_HEX]
	);
}, 60_000);

describe('GET /auth/me/export', () => {
	it('refuses without a session', async () => {
		const res = await anon('GET', '/auth/me/export');
		expect(res.status).toBe(401);
		expect(JSON.stringify(res.body)).not.toMatch(/relation|column|syntax/i);
	});

	it('downloads a JSON file, not cached', async () => {
		const { res, doc } = await download(farmer);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/^application\/json/);
		expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="my-data_\d{4}-\d{2}-\d{2}\.json"$/);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(doc).toMatchObject({ format: 'water-management.subject-export', version: 1 });
	});

	it('gives the farmer their account, membership and farm link, with the farm’s figures and registered volume', async () => {
		const { doc } = await download(farmer);
		expect(doc.account).toMatchObject({ id: farmer.id, email: farmer.email, displayName: 'XFarmer' });
		expect(doc.account.dataExportedAt).toEqual(expect.any(String));
		// Whether SES suppressed the address (057): nothing here, so all null.
		expect(doc.account).toMatchObject({ mailSuppressedAt: null, mailSuppressedReason: null, mailResumedAt: null });
		// The terms the account accepted at sign-up, and when (087).
		expect(doc.account).toMatchObject({ termsVersion: LEGAL_VERSION, termsAcceptedAt: expect.any(String) });
		// The farm view notice they acknowledged, and when (093); the other farmer's export has none (positive control's twin).
		expect(doc.account).toMatchObject({ farmNoticeVersion: FARMER_NOTICE_VERSION, farmNoticeAcceptedAt: expect.any(String) });
		expect((await download(other)).doc.account).toMatchObject({ farmNoticeVersion: null, farmNoticeAcceptedAt: null });
		expect(doc.projectMemberships).toEqual([expect.objectContaining({ projectId, projectName: 'Export catchment', role: 'farmer' })]);
		expect(doc.farms).toHaveLength(1);
		const farm = doc.farms[0];
		expect(farm).toMatchObject({ projectId, nodeId: farmA.id, farmName: 'Farm Alpha', linkedBy: 'XOwner' });
		expect(farm.allocations).toEqual([expect.objectContaining({ holderName: 'Holder Alpha', registrationNo: 'REG-ALPHA', volumeM3Year: 12_000, waterUse: '21a' })]);
		expect(farm.publication?.figures?.name).toBe('Farm Alpha');
		expect(farm.publication.restriction.level).toEqual(expect.any(String));
	});

	it('gives the notes they wrote, the lapsed invite to their address and their alert choices', async () => {
		const { doc } = await download(farmer);
		expect(doc.notes.map((n: Doc) => n.body)).toEqual(['alpha note by the farmer']);
		expect(doc.invites).toEqual([expect.objectContaining({ projectId: secondProjectId, projectName: 'Invited catchment', projectRole: 'viewer', invitedBy: 'XOwner' })]);
		expect(doc.alertSubscriptions).toEqual([expect.objectContaining({ projectId, kind: 'all', mode: 'immediate' })]);
	});

	it('gives the audit events about or by them, and only those', async () => {
		const { doc } = await download(farmer);
		const kinds = (doc.auditEvents as Doc[]).map((e) => e.kind);
		expect(kinds).toEqual(expect.arrayContaining(['member.added', 'farmer.linked']));
		// Made by accepting the invite, so theirs (issue #136).
		expect((doc.auditEvents as Doc[]).filter((e) => e.kind === 'farmer.linked').every((e) => e.byYou)).toBe(true);
		for (const e of doc.auditEvents as Doc[]) {
			expect(e.byYou || e.subject?.userId === farmer.id || e.subject?.authorId === farmer.id).toBe(true);
		}
		expect(doc.auditEventsTruncated).toBe(false);
	});

	it('holds nothing of the other farmer’s, who gets their own (positive control)', async () => {
		const { text: mine } = await download(farmer);
		for (const theirs of [other.id, other.email, 'XOther', 'Farm Bravo', farmB.id, 'Holder Bravo', 'REG-BRAVO', 'bravo note by the other']) {
			expect(mine).not.toContain(theirs);
		}
		const { doc } = await download(other);
		expect(doc.farms.map((f: Doc) => f.farmName)).toEqual(['Farm Bravo']);
		expect(doc.farms[0].allocations.map((a: Doc) => a.holderName)).toEqual(['Holder Bravo']);
		expect(doc.notes.map((n: Doc) => n.body)).toEqual(['bravo note by the other']);
		expect(doc.invites).toEqual([]);
		expect(JSON.stringify(doc)).not.toContain('Holder Alpha');
	});

	it('never holds a secret: no password hash, token hash or unsubscribe material', async () => {
		const { text } = await download(farmer);
		expect(text).not.toMatch(/\$2[aby]\$/);
		expect(text).not.toMatch(/password|tokenHash|token_hash|unsubscribe|nonce/i);
		for (const hex of [TOKEN_HEX, NONCE_HEX, UNSUB_HEX]) expect(text).not.toContain(hex);
	});

	it('leaves out invites to an address the account hasn’t verified', async () => {
		const unverified = await signUp('XUnverified', { verified: false });
		await asOwner(
			`INSERT INTO invite (email, project_id, project_role, invited_by, token_hash, expires_at)
			 VALUES ($1, $2, 'viewer', $3, decode($4, 'hex'), now() - interval '1 day')`,
			[unverified.email, secondProjectId, owner.id, 'aa'.repeat(32)]
		);
		const { doc } = await download(unverified);
		expect(doc.invites).toEqual([]);
		expect(await asOwner('SELECT count(*)::int AS n FROM invite WHERE email = $1', [unverified.email])).toEqual([{ n: 1 }]);
	});

	it('gives the owner their memberships and the events they made', async () => {
		const { doc } = await download(owner);
		expect(doc.projectMemberships.map((m: Doc) => m.projectName).sort()).toEqual(['Export catchment', 'Invited catchment']);
		// The owner invited the farmers; the farm links are the farmers' own, made by accepting (issue #136).
		expect((doc.auditEvents as Doc[]).some((e) => e.byYou && e.kind === 'invite.sent')).toBe(true);
		expect((doc.auditEvents as Doc[]).some((e) => e.byYou && e.kind === 'farmer.linked')).toBe(false);
		expect(doc.farms).toEqual([]);
		expect(doc.invites).toEqual([]);
	});

	it('allows one export a minute per account (429 with Retry-After)', async () => {
		expect((await download(farmer)).res.status).toBe(200);
		const again = await app.request('/auth/me/export', { headers: { cookie: farmer.cookie, origin: ORIGIN } });
		expect(again.status).toBe(429);
		const wait = Number(again.headers.get('retry-after'));
		expect(wait).toBeGreaterThan(0);
		expect(wait).toBeLessThanOrEqual(EXPORT_COOLDOWN_SECONDS);
		// The account page words it from the code, with the wait (docs/api.md § Errors).
		const body = (await again.json()) as { code?: string; params?: { seconds?: number } };
		expect(body.code).toBe('export_throttled');
		expect(body.params?.seconds).toBe(wait);
		// Another account isn't held up (positive control).
		await asOwner('UPDATE app_user SET data_exported_at = NULL WHERE id = $1', [other.id]);
		const theirs = await app.request('/auth/me/export', { headers: { cookie: other.cookie, origin: ORIGIN } });
		expect(theirs.status).toBe(200);
	});
});

describe('app_subject_export (054_subject_export.sql)', () => {
	it('returns nothing without a user', async () => {
		const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
		await client.connect();
		try {
			expect((await client.query('SELECT app_subject_export() AS doc')).rows).toEqual([{ doc: null }]);
		} finally {
			await client.end();
		}
	});
});

describe('export completeness guard', () => {
	let db: pg.Client;
	beforeAll(async () => {
		db = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await db.connect();
		return () => db.end();
	});

	it('lists every foreign key to app_user as exported or deliberately left out (auth/export.ts USER_FK_COVERAGE)', async () => {
		const { rows } = await db.query<{ col: string }>(
			`SELECT c.conrelid::regclass::text || '.' || a.attname AS col
			 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
			 WHERE c.contype = 'f' AND c.confrelid = 'app_user'::regclass ORDER BY 1`
		);
		expect(rows.map((r) => r.col).sort()).toEqual(Object.keys(USER_FK_COVERAGE).sort());
	});

	it('lists every app_user column as exported or deliberately left out', async () => {
		const { rows } = await db.query<{ column_name: string }>(
			`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'app_user' ORDER BY 1`
		);
		expect(rows.map((r) => r.column_name).sort()).toEqual([...APP_USER_EXPORTED, ...Object.keys(APP_USER_EXCLUDED)].sort());
	});
});
