// "Delete my account" (issue #112; DELETE /auth/me, auth/deleteAccount.ts,
// 143_delete_my_account.sql; docs/api.md § Auth, docs/security.md § Personal
// information (POPIA), "Deletion"). What the deletion does to the data is
// checked end to end in account-deletion.db.test.ts (the operator's path) and
// swept across the schema, through this route, in
// personal-data.security.db.test.ts. This file checks the route itself: the
// password again, the refusal that names what the person alone holds, the
// audit events, the confirmation email, and that it runs as the person
// (app_delete_my_account deletes only the caller's own row, and nobody's
// without a signed-in user).
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { anon, app, asOwner, lastMailTo, node, signUp } from '../__tests__/helpers.js';
import { withoutUser, withUser } from '../db/tx.js';

// The race the route guards against: someone else gives up ownership between
// the up-front check and the delete. `blind.once` makes the up-front check see
// nothing held (`blind.times` calls), so only the deferred checks (SET CONSTRAINTS) catch it.
const blind = vi.hoisted(() => ({ times: 0 }));
vi.mock('./deleteAccount.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('./deleteAccount.js')>();
	return {
		...real,
		soleHoldings: (...args: Parameters<typeof real.soleHoldings>) => {
			if (blind.times <= 0) return real.soleHoldings(...args);
			blind.times--;
			return Promise.resolve({ projects: [], teams: [] });
		}
	};
});

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';
const tag = crypto.randomUUID().slice(0, 8);

/** DELETE /auth/me as `u`, with the response's headers (the cookies it clears). */
async function deleteMe(u: User, password: string | null = 'correct horse') {
	const r = await app.request('/auth/me', {
		method: 'DELETE',
		headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' },
		body: JSON.stringify(password === null ? {} : { password })
	});
	const text = await r.text();
	return { status: r.status, body: text ? JSON.parse(text) : null, setCookie: r.headers.get('set-cookie') ?? '' };
}

const exists = async (u: User) => (await asOwner('SELECT 1 FROM app_user WHERE id = $1', [u.id])).length === 1;

describe('DELETE /auth/me: the checks before anything is deleted', () => {
	it('needs a session', async () => {
		expect((await anon('DELETE', '/auth/me', { password: 'correct horse' })).status).toBe(401);
	});

	it('asks for the password again: a missing one is a 400, a wrong one a 403, and the account stays', async () => {
		const u = await signUp('Dwrongpw');
		expect((await deleteMe(u, null)).status).toBe(400);
		const wrong = await deleteMe(u, 'not my password');
		expect(wrong.status).toBe(403);
		expect(wrong.body.code).toBe('wrong_current_password');
		expect(await exists(u)).toBe(true);
		// Positive control: the session still works.
		expect((await u.call('GET', '/auth/me')).status).toBe(200);
	});

	it('counts a wrong password against the sign-in lockout, as changing the password does', async () => {
		const u = await signUp('Dlocked');
		for (let i = 0; i < 5; i++) expect((await deleteMe(u, 'guess')).status).toBe(403);
		const locked = await deleteMe(u, 'correct horse');
		expect(locked.status).toBe(429);
		expect(locked.body.code).toBe('signin_locked');
		expect(await exists(u)).toBe(true);
	});

	describe('the only owner of a project and the only admin of a team', () => {
		let alone: User;
		let partner: User;
		let projectId: string;
		let teamId: string;
		let sharedId: string;

		beforeAll(async () => {
			[alone, partner] = (await Promise.all(['Dalone', 'Dpartner'].map((n) => signUp(n)))) as [User, User];
			projectId = (await alone.call('POST', '/projects', { name: `Only mine ${tag}` })).body.project.id;
			teamId = (await alone.call('POST', '/teams', { name: `My team ${tag}` })).body.team.id;
			// A project they own with someone else is not in the way.
			sharedId = (await alone.call('POST', '/projects', { name: `Shared ${tag}` })).body.project.id;
			expect((await alone.call('POST', `/projects/${sharedId}/members`, { email: partner.email, role: 'owner' })).status).toBe(201);
		});

		it('is refused with 409 account_sole_holder, naming exactly those, and nothing changes', async () => {
			const res = await deleteMe(alone);
			expect(res.status).toBe(409);
			expect(res.body.code).toBe('account_sole_holder');
			expect(res.body.details).toEqual({ projects: [{ id: projectId, name: `Only mine ${tag}` }], teams: [{ id: teamId, name: `My team ${tag}` }] });
			expect(res.setCookie).toBe('');
			expect(await exists(alone)).toBe(true);
			// No audit event was left behind by the refused attempt.
			expect(await asOwner(`SELECT 1 FROM audit_event WHERE kind = 'member.removed' AND subject->>'userId' = $1`, [alone.id])).toEqual([]);
			expect(lastMailTo(alone.email)?.kind).not.toBe('account_deleted');
		});

		it('goes through once someone else owns the project and administers the team (positive control)', async () => {
			expect((await alone.call('POST', `/projects/${projectId}/members`, { email: partner.email, role: 'owner' })).status).toBe(201);
			expect((await deleteMe(alone)).body.details).toEqual({ projects: [], teams: [{ id: teamId, name: `My team ${tag}` }] });
			expect((await alone.call('POST', `/teams/${teamId}/members`, { email: partner.email, role: 'admin' })).status).toBe(201);
			expect((await deleteMe(alone)).status).toBe(204);
			expect(await exists(alone)).toBe(false);
			// The evidence stays, the maker cleared (138): the project they made, now the partner's to run.
			expect(await asOwner('SELECT created_by FROM project WHERE id = $1', [projectId])).toEqual([{ created_by: null }]);
			expect((await partner.call('GET', `/projects/${projectId}`)).status).toBe(200);
		});
	});
});

describe('DELETE /auth/me: a farmer and an owner who share a catchment and a team', () => {
	let owner: User;
	let farmer: User;
	let leaver: User; // a co-owner and team admin alongside `owner`
	let projectId: string;
	let teamId: string;
	let teamProjectId: string;
	const outlet = node('Outlet', null);
	const farmA = node(`Farm ${tag}`, outlet.id);
	let res: Awaited<ReturnType<typeof deleteMe>>;
	let farmerRes: Awaited<ReturnType<typeof deleteMe>>;

	type Ev = { kind: string; actor: string | null; subject: Record<string, unknown> };
	const events = async (pid: string): Promise<Ev[]> => {
		const r = await owner.call('GET', `/projects/${pid}/history?limit=100`);
		expect(r.status).toBe(200);
		return (r.body.items as (Ev & { type: string })[]).filter((i) => i.type === 'event');
	};

	beforeAll(async () => {
		[owner, farmer, leaver] = (await Promise.all(['Downer2', `Dfarmer${tag}`, `Dleaver${tag}`].map((n) => signUp(n)))) as [User, User, User];
		projectId = (await owner.call('POST', '/projects', { name: `Catchment ${tag}` })).body.project.id;
		expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farmA], crops: [], cropAreas: [], transfers: [], landCover: [] })).status).toBe(200);
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: leaver.email, role: 'owner' })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
		teamId = (await owner.call('POST', '/teams', { name: `Team ${tag}` })).body.team.id;
		expect((await owner.call('POST', `/teams/${teamId}/members`, { email: leaver.email, role: 'admin' })).status).toBe(201);
		teamProjectId = (await owner.call('POST', '/projects', { name: `Team catchment ${tag}`, teamId })).body.project.id;
		// A map import by the leaver (146): its file record and feature are the project's and stay, without their name.
		const imported = await leaver.call('POST', `/projects/${projectId}/map/import`, {
			fileName: `leaver-${tag}.geojson`,
			kind: 'other',
			text: JSON.stringify({ type: 'Feature', properties: { name: `Leaver pin ${tag}` }, geometry: { type: 'Point', coordinates: [21.3, -33.6] } })
		});
		expect(imported.status).toBe(201);
		res = await deleteMe(leaver);
		farmerRes = await deleteMe(farmer);
	}, 60_000);

	it('keeps the map features and the import they made, with who made them cleared (as the operator’s deletion does)', async () => {
		const kept = await asOwner(
			`SELECT s.imported_by, f.created_by FROM geo_source s JOIN map_feature f ON f.source_id = s.id WHERE s.project_id = $1 AND s.file_name = $2`,
			[projectId, `leaver-${tag}.geojson`]
		);
		expect(kept).toEqual([{ imported_by: null, created_by: null }]);
	});

	it('answers 204 and clears this browser’s session and trusted-device cookies', () => {
		expect(res.status).toBe(204);
		expect(res.setCookie).toMatch(/wm_session=;/);
		expect(res.setCookie).toMatch(/wm_device=;/);
	});

	it('deletes the account, so the session it had no longer signs anyone in', async () => {
		expect(await exists(leaver)).toBe(false);
		expect((await leaver.call('GET', '/auth/me')).status).toBe(401);
		expect(await asOwner('SELECT 1 FROM project_member WHERE user_id = $1 UNION ALL SELECT 1 FROM team_member WHERE user_id = $1', [leaver.id])).toEqual([]);
		// Positive control: the owner who stays keeps both.
		expect(await asOwner('SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, owner.id])).toEqual([{ role: 'owner' }]);
	});

	it('records in each project and team that they deleted their account, as "Deleted user"', async () => {
		const own = (await events(projectId)).filter((e) => e.kind === 'member.removed' && e.subject.accountDeleted === true);
		expect(own).toHaveLength(2);
		const left = own.find((e) => e.subject.role === 'owner')!;
		expect(left).toMatchObject({ actor: 'Deleted user', subject: { userId: leaver.id, displayName: 'Deleted user', role: 'owner', self: true } });
		const viaTeam = (await events(teamProjectId)).filter((e) => e.kind === 'team_member.removed');
		expect(viaTeam).toEqual([expect.objectContaining({ actor: 'Deleted user', subject: expect.objectContaining({ teamId, userId: leaver.id, displayName: 'Deleted user', teamRole: 'admin', self: true, accountDeleted: true }) })]);
		// Their names are nowhere in either project's history.
		expect(JSON.stringify([await events(projectId), await events(teamProjectId)])).not.toMatch(new RegExp(`Dleaver${tag}|Dfarmer${tag}`));
	});

	it('records a farmer’s farm links going with the account, so the WUA knows whom it lost', async () => {
		expect(farmerRes.status).toBe(204);
		const unlinked = (await events(projectId)).filter((e) => e.kind === 'farmer.unlinked');
		expect(unlinked).toEqual([expect.objectContaining({ actor: 'Deleted user', subject: expect.objectContaining({ nodeId: farmA.id, displayName: 'Deleted user', cause: 'member_removed' }) })]);
		const gone = (await events(projectId)).find((e) => e.kind === 'member.removed' && e.subject.role === 'farmer');
		expect(gone?.subject).toMatchObject({ accountDeleted: true, self: true });
	});

	it('emails the address the account had what was done (POPIA s24(4)), naming what they left', () => {
		const mail = lastMailTo(leaver.email);
		expect(mail).toMatchObject({ kind: 'account_deleted', to: leaver.email });
		expect(mail!.text).toContain(`You are no longer a member of Catchment ${tag} and Team ${tag}.`);
		expect(mail!.text).toContain('Kept with your name:');
		expect(lastMailTo(farmer.email)!.text).toContain(`You are no longer a member of Catchment ${tag}.`);
	});
});

describe('DELETE /auth/me: when the up-front check misses an only owner (a co-owner left a moment before)', () => {
	it('is still refused inside the request, naming the project, with nothing deleted or recorded', async () => {
		const alone = await signUp('Draced');
		const pid = (await alone.call('POST', '/projects', { name: `Raced ${tag}` })).body.project.id;
		blind.times = 1;
		const res = await deleteMe(alone);
		expect(blind.times).toBe(0);
		expect(res.status).toBe(409);
		expect(res.body).toMatchObject({ code: 'account_sole_holder', details: { projects: [{ id: pid, name: `Raced ${tag}` }], teams: [] } });
		expect(await exists(alone)).toBe(true);
		expect(await asOwner(`SELECT 1 FROM audit_event WHERE kind = 'member.removed' AND subject->>'userId' = $1`, [alone.id])).toEqual([]);
	});
});

describe('DELETE /auth/me: refusals that never leak the database’s words', () => {
	it('answers a check the route can’t name with the generic 409, not the trigger’s text', async () => {
		const alone = await signUp('Dblind');
		await alone.call('POST', '/projects', { name: `Blind ${tag}` });
		blind.times = 2;
		const res = await deleteMe(alone);
		expect(blind.times).toBe(0);
		expect(res.status).toBe(409);
		expect(res.body).toEqual({ error: 'violates a data rule' });
		expect(await exists(alone)).toBe(true);
	});
});

describe('DELETE /auth/me: two co-owners deleting their accounts at the same moment', () => {
	it('lets one go and refuses the other, so the project and team keep an owner and an admin', async () => {
		const [a, b] = (await Promise.all(['Dtwin1', 'Dtwin2'].map((n) => signUp(n)))) as [User, User];
		const pid = (await a.call('POST', '/projects', { name: `Twins ${tag}` })).body.project.id;
		expect((await a.call('POST', `/projects/${pid}/members`, { email: b.email, role: 'owner' })).status).toBe(201);
		const tid = (await a.call('POST', '/teams', { name: `Twin team ${tag}` })).body.team.id;
		expect((await a.call('POST', `/teams/${tid}/members`, { email: b.email, role: 'admin' })).status).toBe(201);
		const results = await Promise.all([deleteMe(a), deleteMe(b)]);
		expect(results.map((r) => r.status).sort()).toEqual([204, 409]);
		const refused = results.find((r) => r.status === 409)!;
		expect(refused.body.code).toBe('account_sole_holder');
		expect(await asOwner(`SELECT count(*)::int AS n FROM project_member WHERE project_id = $1 AND role = 'owner'`, [pid])).toEqual([{ n: 1 }]);
		expect(await asOwner(`SELECT count(*)::int AS n FROM team_member WHERE team_id = $1 AND role = 'admin'`, [tid])).toEqual([{ n: 1 }]);
	});
});

describe('app_delete_my_account (143)', () => {
	it('refuses a transaction with no signed-in user', async () => {
		await expect(withoutUser((db) => db.query('SELECT app_delete_my_account()'))).rejects.toMatchObject({ code: '42501' });
	});

	it('deletes only the caller’s own account; water_app still can’t delete another row itself', async () => {
		const [me, other] = (await Promise.all(['Dfnme', 'Dfnother'].map((n) => signUp(n)))) as [User, User];
		await expect(withUser(me.id, (db) => db.query('DELETE FROM app_user WHERE id = $1', [other.id]))).rejects.toMatchObject({ code: '42501' });
		expect(await withUser(me.id, async (db) => (await db.query('SELECT app_delete_my_account() AS gone')).rows)).toEqual([{ gone: true }]);
		expect(await exists(me)).toBe(false);
		expect(await exists(other)).toBe(true);
	});

	it('is held to the same owner check at commit as the operator’s deletion', async () => {
		const alone = await signUp('Dfnalone');
		await alone.call('POST', '/projects', { name: 'Fn only mine' });
		await expect(withUser(alone.id, (db) => db.query('SELECT app_delete_my_account()'))).rejects.toMatchObject({ code: '23514' });
		expect(await exists(alone)).toBe(true);
	});
});
