// Farmer invites, single and bulk (roadmap WP-2.2, issue #27;
// 034_farmer_invites.sql, farms/routes.ts). An address without a verified
// account is invited with the farms the invite will link; accepting it
// (app_accept_invites) creates the membership and the links. Every "cannot
// see" check has a positive control.
import { LEGAL_VERSION } from '@water-management/engine/legal';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, asOwner, lastMailTo, mailCount, node, signUp, tokenIn } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';
import { INVITE_RETENTION_DAYS, purgeInvites } from '../invites/invites.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let stranger: User;
let projectId: string;
const outlet = node('Outlet', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Rustenvrede', outlet.id);
const farmC = node('Hoek', outlet.id);
const MODEL = { nodes: [outlet, farmA, farmB, farmC], crops: [], cropAreas: [], transfers: [], landCover: [] };

const newEmail = (tag: string) => `${tag}-${crypto.randomUUID()}@example.com`;

beforeAll(async () => {
	[owner, viewer, stranger] = (await Promise.all(['Iowner', 'Iviewer', 'Istranger'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Invite <Kloof>' })).body.project.id;
	expect((await owner.call('PUT', `/projects/${projectId}/model`, MODEL)).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
});

const rowsAs = async <T = Record<string, unknown>>(uid: string, sql: string, params: unknown[] = []) =>
	withUser(uid, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);

/** Register through the API, optionally via an invite link; returns the new user's id and a caller. */
async function register(email: string, inviteToken?: string) {
	const res = await anon('POST', '/auth/register', { email, password: 'correct horse', displayName: 'New Farmer', acceptTerms: LEGAL_VERSION, ...(inviteToken ? { inviteToken } : {}) });
	expect(res.status).toBe(201);
	return res.body.user.id as string;
}

const farmNodesOf = async (uid: string) =>
	(await rowsAs<{ id: string }>(uid, `SELECT id FROM node WHERE project_id = $1 AND kind = 'farm' ORDER BY id`, [projectId])).map((r) => r.id);

describe('POST /farmers for an address with no verified account', () => {
	it('invites it with the farms, lists the invite for owners only, and mails the farmer variant', async () => {
		const email = newEmail('invitee');
		const res = await owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farmA.id, farmB.id] });
		expect(res.status).toBe(201);
		expect(res.body).toEqual({
			invited: true,
			invite: expect.objectContaining({ status: 'invited', email, nodeIds: [farmA.id, farmB.id].sort(), invitedBy: 'Iowner', locale: 'en' })
		});
		const mail = lastMailTo(email)!;
		expect(mail.subject).toBe('Iowner has given you access to Farm A and Rustenvrede in Invite <Kloof>');
		expect(mail.html).toContain('Invite &lt;Kloof&gt;');
		expect(mail.text).toMatch(/\/register\?invite=[A-Za-z0-9_-]{43}/);

		const listed = (await owner.call('GET', `/projects/${projectId}/farmers`)).body.farmers;
		expect(listed).toContainEqual(expect.objectContaining({ status: 'invited', inviteId: res.body.invite.inviteId, email }));
		// A viewer reads the farmer list but never the pending invites (RLS on invite and invite_node).
		const seen = await viewer.call('GET', `/projects/${projectId}/farmers`);
		expect(seen.status).toBe(200);
		expect(seen.body.farmers.filter((f: { status: string }) => f.status !== 'active')).toEqual([]);
	});

	it('takes a language, and refuses one it does not know', async () => {
		const email = newEmail('af');
		const res = await owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farmC.id], locale: 'af' });
		expect(res.body.invite.locale).toBe('af');
		// The invite email goes out in the invite's language (WP-2.5; auth/locale.db.test.ts covers the switch).
		const mail = lastMailTo(email)!;
		expect(mail.subject).toBe('Iowner het jou toegang gegee tot Hoek in Invite <Kloof>');
		expect(mail.html).toContain('<html lang="af">');
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farmC.id], locale: 'fr' })).status).toBe(400);
	});

	it('re-inviting replaces the invite’s farms', async () => {
		const email = newEmail('again');
		await owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farmA.id] });
		const again = await owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farmC.id] });
		expect(again.body.invite.nodeIds).toEqual([farmC.id]);
	});

	it('re-inviting the address as a viewer through /members drops the farms', async () => {
		const email = newEmail('switch');
		const inv = await owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farmA.id] });
		await owner.call('POST', `/projects/${projectId}/members`, { email, role: 'viewer' });
		expect(await rowsAs(owner.id, 'SELECT 1 FROM invite_node WHERE invite_id = $1', [inv.body.invite.inviteId])).toEqual([]);
		const listed = (await owner.call('GET', `/projects/${projectId}/farmers`)).body.farmers;
		expect(listed.some((f: { email: string }) => f.email === email)).toBe(false);
	});

	it('is owner-only, and still refuses a node that is not a farm', async () => {
		expect((await viewer.call('POST', `/projects/${projectId}/farmers`, { email: newEmail('x'), nodeIds: [farmA.id] })).status).toBe(403);
		expect((await stranger.call('POST', `/projects/${projectId}/farmers`, { email: newEmail('x'), nodeIds: [farmA.id] })).status).toBe(404);
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: newEmail('x'), nodeIds: [outlet.id] })).status).toBe(400);
	});
});

describe('invite_node RLS', () => {
	it('shows an invite’s farms to owners only, and lets nobody else write them', async () => {
		const inv = await owner.call('POST', `/projects/${projectId}/farmers`, { email: newEmail('rls'), nodeIds: [farmB.id] });
		const inviteId = inv.body.invite.inviteId;
		const count = async (uid: string) => (await rowsAs(uid, 'SELECT node_id FROM invite_node WHERE invite_id = $1', [inviteId])).length;
		// Positive control: the owner sees it.
		expect(await count(owner.id)).toBe(1);
		expect(await count(viewer.id)).toBe(0);
		expect(await count(stranger.id)).toBe(0);
		await expect(
			withUser(viewer.id, (db) => db.query('INSERT INTO invite_node (invite_id, project_id, node_id) VALUES ($1, $2, $3)', [inviteId, projectId, farmC.id]))
		).rejects.toThrow(/row-level security/);
		// An owner can't point an invite at a node that isn't a farm.
		await expect(
			withUser(owner.id, (db) => db.query('INSERT INTO invite_node (invite_id, project_id, node_id) VALUES ($1, $2, $3)', [inviteId, projectId, outlet.id]))
		).rejects.toThrow(/is not a farm/);
	});
});

// Retention (WP-2.16; 048_account_deletion.sql): a lapsed invite holds the
// address of someone who never signed up, and the farms it would have linked.
describe('purging lapsed invites', () => {
	it(`deletes an invite ${INVITE_RETENTION_DAYS} days past its expiry with its farms, and keeps a newer expired one and a live one`, async () => {
		const [old, recent, live] = [newEmail('old'), newEmail('recent'), newEmail('live')];
		for (const email of [old, recent, live]) {
			expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farmC.id] })).status).toBe(201);
		}
		await asOwner(`UPDATE invite SET expires_at = now() - make_interval(days => $2) - interval '1 hour' WHERE email = $1`, [old, INVITE_RETENTION_DAYS]);
		await asOwner(`UPDATE invite SET expires_at = now() - make_interval(days => $2) + interval '1 hour' WHERE email = $1`, [recent, INVITE_RETENTION_DAYS]);
		const oldId = (await asOwner('SELECT id FROM invite WHERE email = $1', [old]))[0].id;
		expect(await asOwner('SELECT 1 FROM invite_node WHERE invite_id = $1', [oldId])).toHaveLength(1);

		expect(await withoutUser((db) => purgeInvites(db))).toBeGreaterThanOrEqual(1);
		expect(await asOwner('SELECT 1 FROM invite WHERE email = $1', [old])).toHaveLength(0);
		expect(await asOwner('SELECT 1 FROM invite_node WHERE invite_id = $1', [oldId])).toHaveLength(0);
		// Positive controls: an invite expired less long ago is still listed (as expired), a live one too.
		const listed = (await owner.call('GET', `/projects/${projectId}/farmers`)).body.farmers as { email?: string }[];
		expect(listed.map((f) => f.email)).toEqual(expect.arrayContaining([recent, live]));
		expect(listed.map((f) => f.email)).not.toContain(old);
	});

	it('refuses a purge of invites expired less than a day', async () => {
		await expect(withoutUser((db) => purgeInvites(db, 0))).rejects.toMatchObject({ code: '22023' });
	});
});

describe('accepting a farmer invite', () => {
	it('signing up through the link creates the membership and exactly the invited links', async () => {
		const email = newEmail('signup');
		await owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farmA.id, farmC.id] });
		const uid = await register(email, tokenIn(lastMailTo(email)));
		const role = await asOwner('SELECT role::text AS role FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, uid]);
		expect(role).toEqual([{ role: 'farmer' }]);
		expect(await farmNodesOf(uid)).toEqual([farmA.id, farmC.id].sort());
		// The invite is gone, and the farmer shows as active.
		const listed = (await owner.call('GET', `/projects/${projectId}/farmers`)).body.farmers;
		expect(listed.filter((f: { email: string }) => f.email === email)).toEqual([
			{ status: 'active', userId: uid, email, displayName: 'New Farmer', role: 'farmer', nodeIds: [farmA.id, farmC.id].sort() }
		]);
		// History: they joined, and each link says it came from the invite.
		const events = await rowsAs<{ kind: string; subject: Record<string, unknown> }>(
			owner.id,
			`SELECT kind, subject FROM audit_event WHERE project_id = $1 AND actor_user_id = $2 ORDER BY kind`,
			[projectId, uid]
		);
		expect(events.map((e) => e.kind).sort()).toEqual(['farmer.linked', 'farmer.linked', 'member.added']);
		expect(events.filter((e) => e.kind === 'farmer.linked').every((e) => e.subject.cause === 'invite')).toBe(true);
	});

	it('an unverified account gets nothing until it verifies, then both (positive control)', async () => {
		const later = await signUp('Unverifiedfarmer', { verified: false });
		// The sign-up verification email went out moments ago; let its cooldown pass.
		await asOwner(`UPDATE email_token SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [later.id]);
		const res = await owner.call('POST', `/projects/${projectId}/farmers`, { email: later.email, nodeIds: [farmB.id] });
		expect(res.status).toBe(201);
		expect(res.body.invited).toBe(true);
		const mail = lastMailTo(later.email)!;
		expect(mail.text).toContain('Confirm email and accept');
		// Accepting before the address is verified does nothing.
		expect(await asOwner('SELECT app_accept_invites($1) AS n', [later.id])).toEqual([{ n: 0 }]);
		expect(await asOwner('SELECT 1 FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, later.id])).toEqual([]);
		expect(await farmNodesOf(later.id)).toEqual([]);
		// Verifying (the emailed link) accepts it: membership and link.
		expect((await anon('POST', '/auth/verify-email', { token: tokenIn(mail) })).status).toBe(200);
		expect(await farmNodesOf(later.id)).toEqual([farmB.id]);
	});

	it('an invite for a farm that is then deleted, or stops being a farm, loses that farm only', async () => {
		const gone = node('Gone farm', outlet.id);
		const turned = node('Turned farm', outlet.id);
		expect((await owner.call('PUT', `/projects/${projectId}/model`, { ...MODEL, nodes: [...MODEL.nodes, gone, turned] })).status).toBe(200);
		const email = newEmail('shrink');
		const inv = await owner.call('POST', `/projects/${projectId}/farmers`, { email, nodeIds: [farmA.id, gone.id, turned.id] });
		expect(inv.body.invite.nodeIds).toHaveLength(3);
		// Saved without `gone`, and with `turned` as a water user.
		const saved = { ...MODEL, nodes: [...MODEL.nodes, { ...turned, kind: 'user', userDemandM3Day: new Array(12).fill(1) }] };
		expect((await owner.call('PUT', `/projects/${projectId}/model`, saved)).status).toBe(200);
		const listed = (await owner.call('GET', `/projects/${projectId}/farmers`)).body.farmers;
		expect(listed.find((f: { email: string }) => f.email === email).nodeIds).toEqual([farmA.id]);
		const uid = await register(email, tokenIn(lastMailTo(email)));
		expect(await farmNodesOf(uid)).toEqual([farmA.id]);
		// Put the model back for the other tests.
		expect((await owner.call('PUT', `/projects/${projectId}/model`, MODEL)).status).toBe(200);
	});

	it('someone who is already on the project with another role keeps it and gets no link', async () => {
		const [row] = await asOwner(
			`INSERT INTO invite (email, project_id, project_role, invited_by, token_hash, expires_at)
			 VALUES ($1, $2, 'farmer', $3, decode(md5(random()::text) || md5(random()::text), 'hex'), now() + interval '1 day') RETURNING id`,
			[viewer.email, projectId, owner.id]
		);
		await asOwner('INSERT INTO invite_node (invite_id, project_id, node_id) VALUES ($1, $2, $3)', [row.id, projectId, farmA.id]);
		await asOwner('SELECT app_accept_invites($1)', [viewer.id]);
		expect(await asOwner('SELECT role::text AS role FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, viewer.id])).toEqual([{ role: 'viewer' }]);
		expect(await asOwner('SELECT 1 FROM farm_link WHERE user_id = $1', [viewer.id])).toEqual([]);
		expect(await asOwner('SELECT 1 FROM invite WHERE id = $1', [row.id])).toEqual([]);
	});
});

describe('POST /farmers/bulk', () => {
	const bulk = (u: User, rows: unknown[], dryRun?: boolean) => u.call('POST', `/projects/${projectId}/farmers/bulk`, { rows, ...(dryRun === undefined ? {} : { dryRun }) });

	it('gives every row of a mixed CSV its own outcome, and mails each address once', async () => {
		const verified = await signUp('Bulkverified');
		const unverified = await signUp('Bulkunverified', { verified: false });
		await asOwner(`UPDATE email_token SET created_at = now() - interval '2 minutes' WHERE user_id = $1`, [unverified.id]);
		const fresh = newEmail('bulk-fresh');
		const twice = newEmail('bulk-twice');
		const rows = [
			{ email: verified.email, farm: 'farm a' }, // 0 added, farm name case-insensitive
			{ email: fresh.toUpperCase(), farm: 'Rustenvrede', locale: 'Afrikaans' }, // 1 invited
			{ email: twice, farm: 'Farm A', locale: 'en' }, // 2 invited
			{ email: twice, farm: 'Hoek' }, // 3 invited, same email
			{ email: unverified.email, farm: 'Hoek' }, // 4 invited (confirm link)
			{ email: newEmail('nofarm'), farm: 'Farm Z' }, // 5 unknown farm
			{ email: 'not-an-email', farm: 'Farm A' }, // 6 bad address
			{ email: viewer.email, farm: 'Farm A' }, // 7 already a viewer
			{ email: newEmail('lang'), farm: 'Farm A', locale: 'fr' }, // 8 unknown language
			{ email: newEmail('near'), farm: 'Farm' } // 9 no guessing at a near name
		];
		const res = await bulk(owner, rows);
		expect(res.status).toBe(200);
		expect(res.body.dryRun).toBe(false);
		const status = res.body.results.map((r: { status: string }) => r.status);
		expect(status).toEqual(['added', 'invited', 'invited', 'invited', 'invited', 'error', 'error', 'error', 'error', 'error']);
		const errors = res.body.results.map((r: { error?: string }) => r.error ?? null);
		expect(errors.slice(5)).toEqual([
			'no farm named “Farm Z” in this catchment',
			'not a valid email address',
			'already a member of this project (viewer)',
			'unknown language “fr” (use en, af, or the language’s name)',
			'no farm named “Farm” in this catchment'
		]);
		expect(res.body.results[1]).toMatchObject({ row: 1, email: fresh, farm: 'Rustenvrede' });

		expect(await farmNodesOf(verified.id)).toEqual([farmA.id]);
		expect(mailCount(twice)).toBe(1);
		expect(lastMailTo(twice)!.subject).toBe('Iowner has given you access to Farm A and Hoek in Invite <Kloof>');
		expect(mailCount(fresh)).toBe(1);
		expect(lastMailTo(unverified.email)!.text).toContain('Confirm email and accept');
		const listed = (await owner.call('GET', `/projects/${projectId}/farmers`)).body.farmers;
		expect(listed.find((f: { email: string }) => f.email === twice).nodeIds).toEqual([farmA.id, farmC.id].sort());
		expect(listed.find((f: { email: string }) => f.email === fresh).locale).toBe('af');

		// Again, with another farm: an existing farmer gains it and keeps the first.
		const again = await bulk(owner, [{ email: verified.email, farm: 'Hoek' }]);
		expect(again.body.results[0].status).toBe('added');
		expect(await farmNodesOf(verified.id)).toEqual([farmA.id, farmC.id].sort());
	});

	it('a dry run gives the same outcomes and writes and mails nothing', async () => {
		const email = newEmail('preview');
		const verified = await signUp('Bulkpreview');
		const res = await bulk(owner, [{ email, farm: 'Hoek' }, { email: verified.email, farm: 'Hoek' }, { email, farm: 'Nope' }], true);
		expect(res.status).toBe(200);
		expect(res.body.dryRun).toBe(true);
		expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['invited', 'added', 'error']);
		expect(mailCount(email)).toBe(0);
		expect(await asOwner('SELECT 1 FROM invite WHERE email = $1', [email])).toEqual([]);
		expect(await asOwner('SELECT 1 FROM project_member WHERE user_id = $1', [verified.id])).toEqual([]);
		expect(await asOwner(`SELECT 1 FROM audit_event WHERE project_id = $1 AND subject->>'userId' = $2`, [projectId, verified.id])).toEqual([]);
	});

	it('takes 60 rows in one request, in under 5 s', async () => {
		const rows = Array.from({ length: 60 }, (_, i) => ({ email: newEmail(`sixty${i}`), farm: ['Farm A', 'Rustenvrede', 'Hoek'][i % 3]! }));
		const t0 = performance.now();
		const res = await bulk(owner, rows);
		expect(performance.now() - t0).toBeLessThan(5000);
		expect(res.body.results).toHaveLength(60);
		expect(res.body.results.every((r: { status: string }) => r.status === 'invited')).toBe(true);
	});

	it('caps one address at 50 farms per request, like adding one farmer', async () => {
		const out = node('Outlet', null);
		const farms = Array.from({ length: 51 }, (_, i) => node(`Plot ${i + 1}`, out.id));
		const pid = (await owner.call('POST', '/projects', { name: 'Many plots' })).body.project.id;
		const model = { nodes: [out, ...farms], crops: [], cropAreas: [], transfers: [], landCover: [] };
		expect((await owner.call('PUT', `/projects/${pid}/model`, model)).status).toBe(200);
		const over = newEmail('over');
		const under = newEmail('under');
		const rows = [
			...farms.map((f) => ({ email: over, farm: f.name })),
			...farms.slice(0, 50).map((f) => ({ email: under, farm: f.name }))
		];
		const res = await owner.call('POST', `/projects/${pid}/farmers/bulk`, { rows });
		expect(res.status).toBe(200);
		const byEmail = (e: string) => res.body.results.filter((r: { email: string }) => r.email === e);
		expect(byEmail(over).every((r: { status: string; error?: string }) => r.status === 'error' && r.error === '51 farms for one address: at most 50 at a time')).toBe(true);
		// Positive control: 50 farms for another address in the same request go through.
		expect(byEmail(under).every((r: { status: string }) => r.status === 'invited')).toBe(true);
		expect(await asOwner('SELECT 1 FROM invite WHERE email = $1', [over])).toEqual([]);
		expect(mailCount(under)).toBe(1);
	});

	it('is owner-only, and caps a request at 200 rows', async () => {
		const row = { email: newEmail('cap'), farm: 'Hoek' };
		expect((await bulk(viewer, [row])).status).toBe(403);
		expect((await bulk(stranger, [row])).status).toBe(404);
		expect((await bulk(owner, Array.from({ length: 201 }, () => row))).status).toBe(400);
		expect((await bulk(owner, [])).status).toBe(400);
	});
});
