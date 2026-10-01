// app_user under row-level security (068_app_user_rls.sql; docs/security.md
// § Accounts under RLS). Until 068 every water_app transaction could read
// and update every account. Now:
//
//   1. no user in the transaction (pre-sign-in, the job tick) and an API key
//      see no account and change none;
//   2. a signed-in person sees their own row and the people they work with
//      (a co-member, a team-mate, a removed member whose run is still
//      listed), not a stranger, and updates only their own row;
//   3. nobody inserts or deletes an account directly: sign-up is
//      app_register, deletion is the operator's;
//   4. the narrow SECURITY DEFINER lookups answer one account, and the
//      by-address one only to a signed-in caller;
//   5. a farmer (073) sees only the accounts their pages name: whoever
//      published or last changed a publication, the author of a farm note on
//      their farm, whoever linked them; never another farmer or a member who
//      did none of those (a viewer still sees them all); an applicant (076)
//      likewise, plus the owner, the other members and the assessor of the
//      applications they read; never another applicant;
//   6. every inner join to app_user in the backend's SQL (JOIN … ON, an
//      UPDATE's or a comma join's FROM app_user) is on a list, so a new one
//      (which would drop rows whose maker RLS hides) needs a decision.
//
// Every "cannot" has a positive control beside it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actForAuthority, app, anon, asOwner, DECISION, monthly, node, signUp } from '../__tests__/helpers.js';
import { type Db, withApiKey, withoutUser, withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';

let owner: User; // owns the project
let viewer: User; // a member of it
let leaver: User; // an editor who made a run, then was removed
let mate: User; // in a team with the owner, no project in common
let stranger: User; // shares nothing with anyone here
let farmer: User; // linked to the farm, by the owner
let neighbour: User; // a farmer on the other farm
let publisher: User; // an editor who published the run
let updater: User; // an editor who changed the publication
let quiet: User; // a viewer who wrote only a staff note on the farm, and a farm note on the other farm
let projectId: string;
let teamId: string;
let farmId: string;
let keyId: string;

/** Run one statement in a savepoint and roll it back: rows it touched, or the refusal's code. */
async function attempt(db: Db, sql: string, params: unknown[] = []): Promise<number | string> {
	await db.query('SAVEPOINT attempt');
	try {
		return (await db.query(sql, params)).rowCount ?? 0;
	} catch (e) {
		return (e as { code?: string }).code ?? 'error';
	} finally {
		await db.query('ROLLBACK TO SAVEPOINT attempt');
	}
}

const visibleIds = (db: Db) => db.query<{ id: string }>('SELECT id FROM app_user').then((r) => new Set(r.rows.map((x) => x.id)));

beforeAll(async () => {
	owner = await signUp('Rlsowner');
	viewer = await signUp('Rlsviewer');
	leaver = await signUp('Rlsleaver');
	mate = await signUp('Rlsmate');
	stranger = await signUp('Rlsstranger');
	farmer = await signUp('Rlsfarmer');
	neighbour = await signUp('Rlsneighbour');
	publisher = await signUp('Rlspublisher');
	updater = await signUp('Rlsupdater');
	quiet = await signUp('Rlsquiet');
	projectId = (await owner.call('POST', '/projects', { name: 'app_user RLS catchment' })).body.project.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: leaver.email, role: 'editor' })).status).toBe(201);
	// A model the leaver can run.
	const outlet = node('Outlet', null);
	const farm = node('Farm', outlet.id);
	const farm2 = node('Other farm', outlet.id);
	farmId = farm.id;
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	expect(
		(await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm, farm2], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] })).status
	).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const days = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: days })).status).toBe(200);
	const run = await leaver.call('POST', `/projects/${projectId}/runs`, { label: 'Leaver run' });
	expect(run.status).toBe(201);
	expect((await owner.call('DELETE', `/projects/${projectId}/members/${leaver.id}`)).status).toBeLessThan(300);
	// Two farmers, the staff their pages name, and staff they don't.
	for (const [u, role] of [
		[publisher, 'editor'],
		[updater, 'editor'],
		[quiet, 'viewer']
	] as const) {
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	}
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: neighbour.email, nodeIds: [farm2.id] })).status).toBe(201);
	expect((await viewer.call('POST', `/projects/${projectId}/notes`, { body: 'For the farmer', nodeId: farm.id, visibility: 'farm' })).status).toBe(201);
	expect((await quiet.call('POST', `/projects/${projectId}/notes`, { body: 'Staff only', nodeId: farm.id, visibility: 'team' })).status).toBe(201);
	expect((await quiet.call('POST', `/projects/${projectId}/notes`, { body: 'For the neighbour', nodeId: farm2.id, visibility: 'farm' })).status).toBe(201);
	expect((await neighbour.call('POST', `/projects/${projectId}/notes`, { body: 'Mine', nodeId: farm2.id })).status).toBe(201);
	const pub = await publisher.call('POST', `/projects/${projectId}/publication`, { runId: run.body.run.id });
	expect(pub.status, JSON.stringify(pub.body)).toBe(201);
	expect((await updater.call('PATCH', `/projects/${projectId}/publication/${pub.body.publication.id}`, { nextExpectedOn: '2031-01-01' })).status).toBe(200);
	// A team the owner and the mate share, with no project.
	teamId = (await owner.call('POST', '/teams', { name: 'RLS team' })).body.team.id;
	expect((await owner.call('POST', `/teams/${teamId}/members`, { email: mate.email, role: 'member' })).status).toBe(201);
	// The stranger has a project of their own, alone.
	expect((await stranger.call('POST', '/projects', { name: 'Stranger catchment' })).status).toBe(201);
	const key = await owner.call('POST', `/projects/${projectId}/api-keys`, { name: 'RLS key' });
	expect(key.status).toBe(201);
	keyId = key.body.key.id;
}, 60_000);

afterAll(async () => {
	// Leave no job (the publication's alert evaluation) for another file's tick.
	await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
});

describe('without a signed-in person', () => {
	it('shows no account and changes none, with no user (positive control: the owner role sees them all)', async () => {
		const [{ n }] = await asOwner('SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1::uuid[])', [[owner.id, viewer.id, stranger.id]]);
		expect(n).toBe(3);
		await withoutUser(async (db) => {
			expect((await visibleIds(db)).size).toBe(0);
			expect(await attempt(db, "UPDATE app_user SET display_name = 'x'")).toBe(0);
		});
	});

	it('shows no account and changes none, as an API key (positive control: the key context is live, on its project)', async () => {
		await withApiKey(keyId, async (db) => {
			expect((await visibleIds(db)).size).toBe(0);
			expect(await attempt(db, "UPDATE app_user SET display_name = 'x'")).toBe(0);
			const { rows } = await db.query("SELECT app_current_api_key_id() AS k, app_api_key_project('series:write') AS p");
			expect(rows[0]).toEqual({ k: keyId, p: projectId });
		});
	});
});

describe('signed in', () => {
	it('sees their own row and the people they work with, never a stranger', async () => {
		const seen = await withUser(owner.id, visibleIds);
		expect([owner.id, viewer.id, leaver.id, mate.id].filter((id) => !seen.has(id))).toEqual([]);
		expect(seen.has(stranger.id)).toBe(false);
		// And the other way: the stranger sees only themself.
		expect([...(await withUser(stranger.id, visibleIds))]).toEqual([stranger.id]);
		// A viewer sees the project's people, not the owner's team-mate.
		const viewerSees = await withUser(viewer.id, visibleIds);
		expect(viewerSees.has(owner.id)).toBe(true);
		expect(viewerSees.has(mate.id)).toBe(false);
	});

	it('keeps a removed member’s run in the list, with their name (the inner join to its maker)', async () => {
		const runs = (await owner.call('GET', `/projects/${projectId}/runs`)).body.runs as { label: string; createdBy: string }[];
		expect(runs.map((r) => [r.label, r.createdBy])).toEqual([['Leaver run', 'Rlsleaver']]);
	});

	it('changes a current member’s role through UPDATE … FROM app_user, and a former member’s answers 404 as before', async () => {
		// Positive control: the owner sees the viewer, so the joined row is there and names them.
		const ok = await owner.call('PATCH', `/projects/${projectId}/members/${viewer.id}`, { party: 'WUA' });
		expect(ok.status).toBe(200);
		expect(ok.body.member).toMatchObject({ userId: viewer.id, email: viewer.email, displayName: 'Rlsviewer', party: 'WUA' });
		// The removed member has no membership row to change, visible to the owner or not.
		expect((await withUser(owner.id, visibleIds)).has(leaver.id)).toBe(true);
		expect((await owner.call('PATCH', `/projects/${projectId}/members/${leaver.id}`, { party: 'x' })).status).toBe(404);
		// The team's: the mate is a team-mate, so the join finds them.
		const team = await owner.call('PATCH', `/teams/${teamId}/members/${mate.id}`, { role: 'viewer' });
		expect(team.status).toBe(200);
		expect(team.body.member).toMatchObject({ userId: mate.id, email: mate.email, displayName: 'Rlsmate', role: 'viewer' });
		// Someone no longer in the team: no row, 404.
		expect((await owner.call('PATCH', `/teams/${teamId}/members/${stranger.id}`, { role: 'viewer' })).status).toBe(404);
	});

	it('updates only their own row', async () => {
		await withUser(owner.id, async (db) => {
			expect(await attempt(db, 'UPDATE app_user SET display_name = display_name WHERE id = $1', [owner.id])).toBe(1);
			// A co-member they can see is still not theirs to change.
			expect(await attempt(db, 'UPDATE app_user SET display_name = display_name WHERE id = $1', [viewer.id])).toBe(0);
			expect(await attempt(db, "UPDATE app_user SET password_hash = 'x' WHERE id <> $1", [owner.id])).toBe(0);
		});
	});

	it('can neither insert nor delete an account directly (positive control: app_register can sign up)', async () => {
		await withUser(owner.id, async (db) => {
			expect(await attempt(db, "INSERT INTO app_user (email, display_name, password_hash) VALUES ('direct@example.com', 'D', 'x')")).toBe('42501');
			expect(await attempt(db, 'DELETE FROM app_user WHERE id = $1', [owner.id])).toBe('42501');
		});
		await withoutUser(async (db) => {
			expect(await attempt(db, "INSERT INTO app_user (email, display_name, password_hash) VALUES ('direct@example.com', 'D', 'x')")).toBe('42501');
			const { rows } = await db.query<{ id: string | null }>("SELECT app_register($1, 'Registered', 'x', NULL) AS id", [`reg-${crypto.randomUUID()}@example.com`]);
			expect(rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
			// A taken address: no second account, no error to tell apart.
			const { rows: again } = await db.query<{ id: string | null }>("SELECT app_register($1, 'Again', 'x', NULL) AS id", [owner.email]);
			expect(again[0]!.id).toBeNull();
		});
	});
});

describe('a farmer', () => {
	it('sees only themself and the people their pages name (positive control: a viewer sees every co-member)', async () => {
		const seen = await withUser(farmer.id, visibleIds);
		// Themself; the owner (who linked them), the viewer (a farm note on their farm), the publisher and the updater.
		expect([...seen].sort()).toEqual([farmer.id, owner.id, viewer.id, publisher.id, updater.id].sort());
		// Not the other farmer, not staff whose only trace is a staff note or a note on another farm, not the removed member.
		expect([neighbour.id, quiet.id, leaver.id, mate.id, stranger.id].filter((id) => seen.has(id))).toEqual([]);
		// The neighbour likewise: their linker, the author of the note on their farm, the publication's people.
		expect([...(await withUser(neighbour.id, visibleIds))].sort()).toEqual([neighbour.id, owner.id, quiet.id, publisher.id, updater.id].sort());
		const viewerSees = await withUser(viewer.id, visibleIds);
		expect([owner.id, farmer.id, neighbour.id, publisher.id, updater.id, quiet.id, leaver.id].filter((id) => !viewerSees.has(id))).toEqual([]);
	});

	it('still sees every name their pages show', async () => {
		const notes = await farmer.call('GET', `/projects/${projectId}/notes?nodeId=${farmId}`);
		expect(notes.status).toBe(200);
		expect((notes.body.notes as { body: string; author: string }[]).map((n) => [n.body, n.author])).toEqual([['For the farmer', 'Rlsviewer']]);
		const pubs = await farmer.call('GET', `/projects/${projectId}/publication`);
		expect(pubs.status).toBe(200);
		expect(pubs.body.current).toMatchObject({ publishedBy: 'Rlspublisher', updatedBy: 'Rlsupdater' });
		const view = await farmer.call('GET', `/projects/${projectId}/farm/${farmId}`);
		expect(view.status).toBe(200);
		expect(view.body.publication.publishedBy).toBe('Rlspublisher');
		const exp = await app.request('/auth/me/export', { headers: { cookie: farmer.cookie, origin: ORIGIN } });
		expect(exp.status).toBe(200);
		const doc = (await exp.json()) as { farms: { nodeId: string; linkedBy: string | null }[] };
		expect(doc.farms.map((f) => [f.nodeId, f.linkedBy])).toEqual([[farmId, 'Rlsowner']]);
	});

	it('sees co-members as before once they are more than a farmer in the project', async () => {
		await asOwner(`UPDATE project_member SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`, [projectId, farmer.id]);
		try {
			const seen = await withUser(farmer.id, visibleIds);
			expect([neighbour.id, quiet.id, leaver.id].filter((id) => !seen.has(id))).toEqual([]);
		} finally {
			await asOwner(`UPDATE project_member SET role = 'farmer' WHERE project_id = $1 AND user_id = $2`, [projectId, farmer.id]);
		}
		expect((await withUser(farmer.id, visibleIds)).has(neighbour.id)).toBe(false);
	});
});

describe('an applicant', () => {
	let applicant: User; // a contributor linked to the farmer's farm; their application is decided
	let consultant: User; // a contributor in the applicant's party, whose application is shared with them
	let partner: User; // a contributor in that party, also on the consultant's application
	let rival: User; // a contributor in another party, with an application of their own
	let assessor: User; // the editor who decided the applicant's application
	let own: string;
	let shared: string;

	const apply = async (u: User, name: string, baseRunId: string) => {
		const res = await u.call('POST', `/projects/${projectId}/scenarios`, { name, baseRunId });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return res.body.scenario.id as string;
	};

	beforeAll(async () => {
		[applicant, consultant, partner, rival, assessor] = await Promise.all(['Rlsapplicant', 'Rlsconsultant', 'Rlspartner', 'Rlsrival', 'Rlsassessor'].map((n) => signUp(n))) as [User, User, User, User, User];
		for (const [u, role] of [
			[applicant, 'contributor'],
			[consultant, 'contributor'],
			[partner, 'contributor'],
			[rival, 'contributor'],
			[assessor, 'editor']
		] as const) {
			expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
		}
		for (const [u, party] of [
			[applicant, 'Rls Trust'],
			[consultant, 'Rls Trust'],
			[partner, 'Rls Trust'],
			[rival, 'Rival Estates']
		] as const) {
			expect((await owner.call('PATCH', `/projects/${projectId}/members/${u.id}`, { party })).status).toBe(200);
		}
		expect((await owner.call('PUT', `/projects/${projectId}/farmers/${applicant.id}`, { nodeIds: [farmId] })).status).toBe(200);
		await actForAuthority(owner, projectId, assessor.id);
		const [{ run_id: base }] = await asOwner('SELECT run_id FROM run_publication WHERE project_id = $1 AND superseded_at IS NULL', [projectId]);
		own = await apply(applicant, 'Raise the dam', base);
		expect((await applicant.call('POST', `/projects/${projectId}/scenarios/${own}/submit`)).status).toBe(200);
		expect((await assessor.call('POST', `/projects/${projectId}/scenarios/${own}/decide`, { ...DECISION, outcome: 'licence_issued' })).status).toBe(200);
		shared = await apply(consultant, 'Consultant draft', base);
		for (const u of [applicant, partner]) {
			expect((await consultant.call('POST', `/projects/${projectId}/scenarios/${shared}/members`, { userId: u.id })).status).toBe(201);
		}
		await apply(rival, 'Rival draft', base);
	}, 60_000);

	it('sees only themself and the people their pages name, never another applicant (positive control: a viewer sees every co-member)', async () => {
		const seen = await withUser(applicant.id, visibleIds);
		// Their farm page's (the owner linked them, the viewer's farm note, the
		// publication's people); their applications' (the consultant who owns
		// the one shared with them, the partner it is also shared with, the
		// assessor who decided theirs).
		expect([...seen].sort()).toEqual([applicant.id, owner.id, viewer.id, publisher.id, updater.id, consultant.id, partner.id, assessor.id].sort());
		// Not the other applicant, not the farmers, not staff their pages don't name, not the removed member.
		expect([rival.id, farmer.id, neighbour.id, quiet.id, leaver.id, mate.id, stranger.id].filter((id) => seen.has(id))).toEqual([]);
		// The partner, with no farm link: the consultant's application's owner and its other member, and the publication's people.
		expect([...(await withUser(partner.id, visibleIds))].sort()).toEqual([partner.id, consultant.id, applicant.id, publisher.id, updater.id].sort());
		// The rival reads only their own application: nobody but the publication's people.
		expect([...(await withUser(rival.id, visibleIds))].sort()).toEqual([rival.id, publisher.id, updater.id].sort());
		const viewerSees = await withUser(viewer.id, visibleIds);
		expect([applicant.id, consultant.id, partner.id, rival.id, assessor.id, farmer.id].filter((id) => !viewerSees.has(id))).toEqual([]);
	});

	it('still sees every name their application pages show', async () => {
		const list = await applicant.call('GET', `/projects/${projectId}/scenarios`);
		expect(list.status).toBe(200);
		const rows = (list.body.scenarios as { id: string; owner: string; decidedBy: string | null; members: { displayName: string }[] }[]).map((s) => [
			s.id,
			s.owner,
			s.decidedBy,
			s.members.map((m) => m.displayName)
		]);
		// Both applications, the shared one kept by its owner's name (an inner join).
		expect(rows.sort()).toEqual(
			[
				[own, 'Rlsapplicant', 'Rlsassessor', []],
				[shared, 'Rlsconsultant', null, ['Rlsapplicant', 'Rlspartner']]
			].sort()
		);
		const one = await partner.call('GET', `/projects/${projectId}/scenarios/${shared}`);
		expect(one.status).toBe(200);
		expect(one.body.scenario).toMatchObject({ owner: 'Rlsconsultant', members: [{ displayName: 'Rlsapplicant' }, { displayName: 'Rlspartner' }] });
		// …and every name their farm page shows, as a farmer's.
		const notes = await applicant.call('GET', `/projects/${projectId}/notes?nodeId=${farmId}`);
		expect((notes.body.notes as { author: string }[]).map((n) => n.author)).toEqual(['Rlsviewer']);
		expect((await applicant.call('GET', `/projects/${projectId}/publication`)).body.current).toMatchObject({ publishedBy: 'Rlspublisher', updatedBy: 'Rlsupdater' });
	});

	it('sees co-members as before once more than an applicant, and no application’s people once only a farmer', async () => {
		await asOwner(`UPDATE project_member SET role = 'viewer' WHERE project_id = $1 AND user_id = $2`, [projectId, applicant.id]);
		try {
			const seen = await withUser(applicant.id, visibleIds);
			expect([rival.id, farmer.id, quiet.id, leaver.id].filter((id) => !seen.has(id))).toEqual([]);
		} finally {
			await asOwner(`UPDATE project_member SET role = 'contributor' WHERE project_id = $1 AND user_id = $2`, [projectId, applicant.id]);
		}
		// A farmer now: their farm page's people only, though their application and its share are still stored.
		await asOwner(`UPDATE project_member SET role = 'farmer' WHERE project_id = $1 AND user_id = $2`, [projectId, applicant.id]);
		try {
			expect([...(await withUser(applicant.id, visibleIds))].sort()).toEqual([applicant.id, owner.id, viewer.id, publisher.id, updater.id].sort());
		} finally {
			await asOwner(`UPDATE project_member SET role = 'contributor' WHERE project_id = $1 AND user_id = $2`, [projectId, applicant.id]);
		}
		expect((await withUser(applicant.id, visibleIds)).has(rival.id)).toBe(false);
		expect((await withUser(applicant.id, visibleIds)).has(assessor.id)).toBe(true);
	});
});

describe('the SECURITY DEFINER lookups', () => {
	it('answer one account by address or id, whoever asks', async () => {
		await withoutUser(async (db) => {
			const { rows } = await db.query('SELECT id, email FROM app_auth_account($1)', [stranger.email]);
			expect(rows).toEqual([{ id: stranger.id, email: stranger.email }]);
			expect((await db.query('SELECT 1 FROM app_auth_account($1)', ['nobody@example.com'])).rows).toEqual([]);
			expect((await db.query('SELECT 1 FROM app_session_revoked_at($1)', [stranger.id])).rows).toHaveLength(1);
		});
	});

	it('find accounts by address only for a signed-in caller', async () => {
		const sql = 'SELECT id FROM app_user_by_email($1::citext[])';
		expect(await withoutUser(async (db) => (await db.query(sql, [[stranger.email]])).rows)).toEqual([]);
		expect(await withApiKey(keyId, async (db) => (await db.query(sql, [[stranger.email]])).rows)).toEqual([]);
		// Positive control: the owner adding someone they don't know yet finds them.
		expect(await withUser(owner.id, async (db) => (await db.query(sql, [[stranger.email]])).rows)).toEqual([{ id: stranger.id }]);
	});

	it('still let every auth flow through (sign-in, forgot, the session check, adding a stranger)', async () => {
		const login = await anon('POST', '/auth/login', { email: stranger.email, password: 'correct horse' });
		expect(login.status).toBe(200);
		expect(login.body.user.id).toBe(stranger.id);
		expect((await anon('POST', '/auth/forgot-password', { email: stranger.email })).status).toBe(202);
		const me = await app.request('/auth/me', { headers: { cookie: stranger.cookie, origin: ORIGIN } });
		expect(me.status).toBe(200);
		const added = await owner.call('POST', `/projects/${projectId}/members`, { email: stranger.email, role: 'viewer' });
		expect(added.status).toBe(201);
		expect((await withUser(owner.id, visibleIds)).has(stranger.id)).toBe(true);
	});
});

// The backend's SQL that inner-joins app_user, each with why its account is
// always visible to whoever runs it (app_user_visible, 068 and 073). An inner
// join to an account RLS hides drops the whole row, so a new one needs a
// decision here: a LEFT JOIN, or a case app_user_visible covers. Three
// spellings: `JOIN app_user x ON …`, and `FROM app_user x` (an UPDATE's
// FROM, or a comma join, `FROM t, app_user x`) keyed by its `x.id = …`
// condition. A farmer runs only the ones whose account is themself. The
// makers of evidence (runs, ensembles, scenarios, imports) are left joins
// since 138: their account may be deleted, and the row stays with no name.
const INNER_JOINS = new Map<string, string>([
	['projects/routes.ts JOIN app_user u ON u.id = m.user_id', 'current project members'],
	['farms/routes.ts JOIN app_user u ON u.id = m.user_id', 'current project members'],
	['farms/routes.ts JOIN app_user u ON u.id = i.invited_by', 'invite.invited_by is in app_user_visible'],
	['history/record.ts JOIN app_user u ON u.id = fl.user_id', 'a linked farmer is a current member'],
	['history/record.ts JOIN app_user u ON u.id = m.user_id', 'current project members'],
	['teams/routes.ts JOIN app_user u ON u.id = m.user_id', 'current team members'],
	['auth/deleteAccount.ts JOIN app_user u ON u.id = m.user_id', 'the caller’s own memberships (m.user_id is the person deleting their account)'],
	['scenarios/execute.ts JOIN app_user mu ON mu.id = m.user_id', 'scenario_member.user_id is in app_user_visible'],
	['reports/routes.ts JOIN app_user ru ON ru.id = r.user_id', 'a schedule recipient is a current member'],
	['reports/store.ts JOIN app_user u ON u.id = m.user_id', 'current project members'],
	['reports/store.ts JOIN app_user u ON u.id = $3', 'the requester, whose job transaction this is'],
	['jobs/queue.ts JOIN app_user u ON u.id = j.acting_user_id', 'job.acting_user_id is in app_user_visible'],
	['yield/store.ts JOIN app_user u ON u.id = j.acting_user_id', 'job.acting_user_id is in app_user_visible (JOB_META, as jobs/queue.ts)'],
	['invites/invites.ts JOIN app_user u ON u.id = i.invited_by', 'invite.invited_by is in app_user_visible'],
	// UPDATE … FROM app_user: the member being changed, by an owner / a team admin.
	// A removed member has no membership row to update, so 404 either way.
	['projects/routes.ts FROM app_user u WHERE u.id = m.user_id', 'a current project member (the owner changing their role)'],
	['teams/routes.ts FROM app_user u WHERE u.id = m.user_id', 'a current team member (a team-mate of the admin)'],
	['alerts/send.ts FROM app_user u WHERE u.id = app_current_user_id()', 'the caller’s own row'],
	['evidence/notices.ts FROM app_user u WHERE u.id = app_current_user_id()', 'the caller’s own row (the pack notice’s recipient, 133)'],
	['errata/notices.ts FROM app_user u WHERE u.id = app_current_user_id()', 'the caller’s own row (the erratum notice’s recipient, 153)']
]);

describe('inner joins to app_user', () => {
	it('are each on the list, and the list has nothing stale', () => {
		const src = fileURLToPath(new URL('..', import.meta.url));
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const f of readdirSync(dir)) {
				const p = join(dir, f);
				if (statSync(p).isDirectory()) walk(p);
				else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) files.push(p);
			}
		};
		walk(src);
		const found = new Set<string>();
		// A table alias, not the clause after an unaliased `FROM app_user`.
		const KEYWORDS = new Set(['WHERE', 'FOR', 'SET', 'ORDER', 'GROUP', 'LIMIT', 'JOIN', 'LEFT', 'INNER', 'CROSS', 'ON', 'RETURNING', 'UNION', 'AS']);
		for (const f of files) {
			const text = readFileSync(f, 'utf8');
			const at = relative(src, f);
			for (const m of text.matchAll(/(?<!LEFT\s+)\bJOIN\s+app_user\s+(\w+)\s+ON\s+([\w.$]+\s*=\s*[\w.$]+)/g)) {
				found.add(`${at} JOIN app_user ${m[1]} ON ${m[2]!.replace(/\s+/g, ' ')}`);
			}
			// FROM app_user x / , app_user x (and an unaliased one followed by a comma: a comma join).
			for (const m of text.matchAll(/(?:\bFROM|,)\s*app_user\b(?!_)(?:\s+(?:AS\s+)?(\w+))?(\s*,)?/g)) {
				const alias = m[1] && !KEYWORDS.has(m[1].toUpperCase()) ? m[1] : null;
				const isComma = m[0].trimStart().startsWith(',') || m[2] !== undefined;
				if (!alias && !isComma) continue; // `FROM app_user WHERE id = …`: one table, no join
				const q = alias ?? 'app_user';
				// The statement: up to the end of its template literal.
				const rest = text.slice(m.index! + m[0].length);
				const stmt = rest.slice(0, rest.indexOf('`') >= 0 ? rest.indexOf('`') : undefined);
				const cond = new RegExp(`\\b${q}\\.id\\s*=\\s*([\\w.$]+(?:\\(\\))?)`).exec(stmt);
				found.add(`${at} ${isComma ? ', ' : 'FROM '}app_user ${q} WHERE ${cond ? `${q}.id = ${cond[1]}` : '?'}`);
			}
		}
		// Not vacuous: the scan finds the members list's join and an UPDATE's FROM, and skips a left join (the run list's, 138).
		expect(found.has('projects/routes.ts JOIN app_user u ON u.id = m.user_id')).toBe(true);
		expect([...found].some((j) => j.startsWith('runs/routes.ts JOIN app_user u ON u.id = r.created_by'))).toBe(false);
		expect(found.has('projects/routes.ts FROM app_user u WHERE u.id = m.user_id')).toBe(true);
		expect([...found].filter((j) => !INNER_JOINS.has(j))).toEqual([]);
		expect([...INNER_JOINS.keys()].filter((j) => !found.has(j))).toEqual([]);
	});
});
