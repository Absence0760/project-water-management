import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

describe('teams', () => {
	it('gives team members access to every team project (admin → owner, member → editor)', async () => {
		const admin = await signUp('TeamAdmin');
		const member = await signUp('TeamMember');
		const outsider = await signUp('Outsider');

		const team = await admin.call('POST', '/teams', { name: 'Catchment Consultants' });
		expect(team.status).toBe(201);
		expect(team.body.team).toMatchObject({ name: 'Catchment Consultants', role: 'admin', memberCount: 1 });
		const teamId = team.body.team.id;
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);

		// Three catchments owned by the team, one personal project.
		const ids: string[] = [];
		for (const name of ['Place A', 'Place B', 'Place C']) {
			const r = await admin.call('POST', '/projects', { name, teamId });
			expect(r.status).toBe(201);
			expect(r.body.project.team).toEqual({ id: teamId, name: 'Catchment Consultants' });
			ids.push(r.body.project.id);
		}
		await admin.call('POST', '/projects', { name: 'Admin private' });

		// Positive control: the member sees exactly the team's three, as editor.
		const list = (await member.call('GET', '/projects')).body.projects;
		expect(list.map((p: { name: string }) => p.name).sort()).toEqual(['Place A', 'Place B', 'Place C']);
		expect(new Set(list.map((p: { role: string }) => p.role))).toEqual(new Set(['editor']));
		expect((await member.call('PATCH', `/projects/${ids[0]}`, { name: 'Place A (edited)' })).status).toBe(200);
		expect((await member.call('DELETE', `/projects/${ids[0]}`)).status).toBe(403);

		// The outsider sees nothing.
		expect((await outsider.call('GET', '/projects')).body.projects).toHaveLength(0);
		expect((await outsider.call('GET', `/projects/${ids[1]}`)).status).toBe(404);
		expect((await outsider.call('GET', `/teams/${teamId}`)).status).toBe(404);

		// A member can create a project in the team; the outsider cannot.
		expect((await member.call('POST', '/projects', { name: 'Place D', teamId })).status).toBe(201);
		expect((await outsider.call('POST', '/projects', { name: 'Sneaky', teamId })).status).toBe(404);
		expect((await admin.call('GET', `/teams/${teamId}`)).body.team.projectCount).toBe(4);

		// Removing the member revokes access to all team projects at once.
		expect((await admin.call('DELETE', `/teams/${teamId}/members/${member.id}`)).status).toBe(204);
		expect((await member.call('GET', `/projects/${ids[1]}`)).status).toBe(404);
	});

	it('moves a personal project into a team (owner only) and keeps one admin', async () => {
		const a = await signUp('Mover');
		const teamId = (await a.call('POST', '/teams', { name: 'T' })).body.team.id;
		const pid = (await a.call('POST', '/projects', { name: 'Solo' })).body.project.id;
		const moved = await a.call('PATCH', `/projects/${pid}`, { teamId });
		expect(moved.status).toBe(200);
		expect(moved.body.project.team.id).toBe(teamId);
		expect((await a.call('DELETE', `/teams/${teamId}/members/${a.id}`)).status).toBe(409);
		expect((await a.call('PATCH', `/teams/${teamId}/members/${a.id}`, { role: 'member' })).status).toBe(409);
	});

	it('deleting a team keeps its projects with their direct owners', async () => {
		const a = await signUp('Deleter');
		const teamId = (await a.call('POST', '/teams', { name: 'Gone' })).body.team.id;
		const pid = (await a.call('POST', '/projects', { name: 'Survivor', teamId })).body.project.id;
		expect((await a.call('DELETE', `/teams/${teamId}`)).status).toBe(204);
		const p = await a.call('GET', `/projects/${pid}`);
		expect(p.status).toBe(200);
		expect(p.body.project.team).toBeNull();
	});

	it('only team admins manage members', async () => {
		const admin = await signUp('Adm');
		const m = await signUp('Mem');
		const other = await signUp('Oth');
		const teamId = (await admin.call('POST', '/teams', { name: 'Roles' })).body.team.id;
		await admin.call('POST', `/teams/${teamId}/members`, { email: m.email, role: 'member' });
		expect((await m.call('POST', `/teams/${teamId}/members`, { email: other.email, role: 'member' })).status).toBe(403);
		expect((await m.call('PATCH', `/teams/${teamId}`, { name: 'x' })).status).toBe(403);
		expect((await m.call('DELETE', `/teams/${teamId}/members/${m.id}`)).status).toBe(204); // leaving is fine
	});
});

describe('moving projects between teams', () => {
	it('lets a team admin (owner only via the team) move a team project to personal and keep it', async () => {
		const creator = await signUp('Creator');
		const admin = await signUp('OtherAdmin');
		const teamId = (await creator.call('POST', '/teams', { name: 'Shared team' })).body.team.id;
		await creator.call('POST', `/teams/${teamId}/members`, { email: admin.email, role: 'admin' });
		const pid = (await creator.call('POST', '/projects', { name: 'Team catchment', teamId })).body.project.id;
		// admin is owner purely through the team
		expect((await admin.call('GET', `/projects/${pid}`)).body.project.role).toBe('owner');
		const moved = await admin.call('PATCH', `/projects/${pid}`, { teamId: null });
		expect(moved.status).toBe(200);
		expect(moved.body.project.team).toBeNull();
		expect(moved.body.project.role).toBe('owner');
	});
});

// 008_team_viewer: a read-only team role. Team viewers read every team
// project but write nothing, and can't add projects to the team.
describe('team viewer', () => {
	type User = Awaited<ReturnType<typeof signUp>>;
	const seriesBody = (kind: string, unit: string, values: number[]) => ({ kind, unit, startDate: '2020-01-01', values });

	/** A runnable team catchment (outlet gauge + one farm, A-pan, rain, observed flow) with one run. */
	async function teamProject(admin: User, teamId: string) {
		const created = await admin.call('POST', '/projects', { name: 'Team catchment', teamId });
		expect(created.status).toBe(201);
		const projectId = created.body.project.id as string;
		const outlet = node('Gauge', null);
		const farm = node('Farm', outlet.id);
		const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
		const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 }], transfers: [] };
		expect((await admin.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		expect((await admin.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
		const rain = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 20 : 0));
		expect((await admin.call('PUT', `/projects/${projectId}/series`, seriesBody('rain_catchment_mm', 'mm', rain))).status).toBe(200);
		const flow = seriesBody('flow_observed_m3s', 'm3/s', new Array(60).fill(0.2));
		expect((await admin.call('PUT', `/projects/${projectId}/series`, flow)).status).toBe(200);
		const run = await admin.call('POST', `/projects/${projectId}/runs`, { label: 'Baseline' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		return { projectId, model, runId: run.body.run.id as string };
	}

	/** A team with its admin plus one user per entry, added directly with that role. */
	async function teamWith(roles: Record<string, 'viewer' | 'member'>) {
		const admin = await signUp('VAdmin');
		const teamId = (await admin.call('POST', '/teams', { name: 'Readers' })).body.team.id as string;
		const users: Record<string, User> = {};
		for (const [name, role] of Object.entries(roles)) {
			const u = await signUp(name);
			const r = await admin.call('POST', `/teams/${teamId}/members`, { email: u.email, role });
			expect(r.status).toBe(201);
			expect(r.body.member.role).toBe(role);
			users[name] = u;
		}
		return { admin, teamId, users };
	}

	it('reads every team project but cannot change settings, model, series or runs; a member can', async () => {
		const { admin, teamId, users } = await teamWith({ Clerk: 'viewer', Modeller: 'member' });
		const viewer = users.Clerk!;
		const member = users.Modeller!;
		const { projectId, model, runId } = await teamProject(admin, teamId);

		// Read: the project, model, series, runs and the team itself.
		const list = (await viewer.call('GET', '/projects')).body.projects;
		expect(list).toEqual([expect.objectContaining({ id: projectId, role: 'viewer', team: { id: teamId, name: 'Readers' } })]);
		expect((await viewer.call('GET', `/projects/${projectId}`)).body.project.role).toBe('viewer');
		expect((await viewer.call('GET', `/projects/${projectId}/model`)).status).toBe(200);
		expect((await viewer.call('GET', `/projects/${projectId}/series`)).status).toBe(200);
		expect((await viewer.call('GET', `/projects/${projectId}/runs`)).status).toBe(200);
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${runId}`)).status).toBe(200);
		const team = await viewer.call('GET', `/teams/${teamId}`);
		expect(team.status).toBe(200);
		expect(team.body.team.role).toBe('viewer');
		// Admins first, then members, then viewers.
		expect(team.body.members.map((m: { role: string }) => m.role)).toEqual(['admin', 'member', 'viewer']);

		// Write: every path is refused.
		expect((await viewer.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(120) } })).status).toBe(403);
		expect((await viewer.call('PATCH', `/projects/${projectId}`, { name: 'Renamed' })).status).toBe(403);
		expect((await viewer.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(403);
		expect((await viewer.call('PUT', `/projects/${projectId}/series`, seriesBody('rain_catchment_mm', 'mm', [1, 2, 3]))).status).toBe(403);
		expect((await viewer.call('POST', `/projects/${projectId}/runs`, { label: 'Sneaky' })).status).toBe(403);
		expect((await viewer.call('PATCH', `/projects/${projectId}/runs/${runId}`, { notes: 'x' })).status).toBe(403);
		expect((await viewer.call('DELETE', `/projects/${projectId}/runs/${runId}`)).status).toBe(403);
		expect((await viewer.call('DELETE', `/projects/${projectId}`)).status).toBe(403);
		// …and none of them changed anything.
		expect((await admin.call('GET', `/projects/${projectId}/runs`)).body.runs).toHaveLength(1);
		expect((await admin.call('GET', `/projects/${projectId}`)).body.project.name).toBe('Team catchment');

		// Positive control: the team member writes the same things.
		expect((await member.call('GET', `/projects/${projectId}`)).body.project.role).toBe('editor');
		expect((await member.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(120) } })).status).toBe(200);
		expect((await member.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		const rain = seriesBody('rain_catchment_mm', 'mm', new Array(60).fill(1));
		expect((await member.call('PUT', `/projects/${projectId}/series`, rain)).status).toBe(200);
		const run = await member.call('POST', `/projects/${projectId}/runs`, { label: 'Member run' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
	});

	it('is enforced by RLS, not only by the API (as water_app)', async () => {
		const { admin, teamId, users } = await teamWith({ Clerk: 'viewer', Modeller: 'member' });
		const { projectId } = await teamProject(admin, teamId);
		const asViewer = await withUser(users.Clerk!.id, async (db) => ({
			seen: (await db.query('SELECT id FROM project WHERE id = $1', [projectId])).rowCount,
			series: (await db.query('SELECT id FROM time_series WHERE project_id = $1', [projectId])).rowCount,
			renamed: (await db.query(`UPDATE project SET name = 'x' WHERE id = $1`, [projectId])).rowCount,
			seriesDeleted: (await db.query('DELETE FROM time_series WHERE project_id = $1', [projectId])).rowCount,
			role: (await db.query('SELECT app_project_role($1) AS r', [projectId])).rows[0].r
		}));
		expect(asViewer).toEqual({ seen: 1, series: 2, renamed: 0, seriesDeleted: 0, role: 'viewer' });
		await expect(
			withUser(users.Clerk!.id, (db) =>
				db.query(
					`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
					 VALUES ($1, 'rain_catchment_mm', 'r', 'mm', '2020-01-01', '{1}')`,
					[projectId]
				)
			)
		).rejects.toThrow(/row-level security/);
		// Positive control: a team member passes the same policies.
		const asMember = await withUser(users.Modeller!.id, async (db) => ({
			renamed: (await db.query(`UPDATE project SET name = 'Renamed' WHERE id = $1`, [projectId])).rowCount,
			role: (await db.query('SELECT app_project_role($1) AS r', [projectId])).rows[0].r
		}));
		expect(asMember).toEqual({ renamed: 1, role: 'editor' });
	});

	it("can't create, move or copy a project into the team (a copy is personal); a member can", async () => {
		const { admin, teamId, users } = await teamWith({ Clerk: 'viewer', Modeller: 'member' });
		const viewer = users.Clerk!;
		expect((await viewer.call('POST', '/projects', { name: 'Mine in team', teamId })).status).toBe(403);
		// RLS agrees, even if the API check were missed.
		await expect(
			withUser(viewer.id, (db) =>
				db.query(`INSERT INTO project (id, name, created_by, team_id) VALUES (gen_random_uuid(), 'x', app_current_user_id(), $1)`, [teamId])
			)
		).rejects.toThrow(/row-level security/);

		const own = (await viewer.call('POST', '/projects', { name: 'Personal' })).body.project.id;
		expect((await viewer.call('PATCH', `/projects/${own}`, { teamId })).status).toBe(403);
		await expect(withUser(viewer.id, (db) => db.query('UPDATE project SET team_id = $2 WHERE id = $1', [own, teamId]))).rejects.toThrow(
			/row-level security/
		);
		expect((await viewer.call('GET', `/projects/${own}`)).body.project.team).toBeNull();

		const { projectId } = await teamProject(admin, teamId);
		const copy = await viewer.call('POST', `/projects/${projectId}/copy`, { name: 'My copy' });
		expect(copy.status).toBe(201);
		expect(copy.body.project).toMatchObject({ team: null, role: 'owner' });

		// Positive control: a team member creates, moves and copies into the team.
		const member = users.Modeller!;
		expect((await member.call('POST', '/projects', { name: 'Member in team', teamId })).status).toBe(201);
		const mine = (await member.call('POST', '/projects', { name: 'Member personal' })).body.project.id;
		expect((await member.call('PATCH', `/projects/${mine}`, { teamId })).body.project.team.id).toBe(teamId);
		expect((await member.call('POST', `/projects/${projectId}/copy`, { name: 'Team copy' })).body.project.team.id).toBe(teamId);
	});

	it('leaves a direct editor who is only a team viewer able to edit (the team is unchanged)', async () => {
		const { admin, teamId, users } = await teamWith({ Clerk: 'viewer' });
		const viewer = users.Clerk!;
		const { projectId } = await teamProject(admin, teamId);
		expect((await admin.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'editor' })).status).toBe(201);
		expect((await viewer.call('GET', `/projects/${projectId}`)).body.project.role).toBe('editor');
		const r = await viewer.call('PATCH', `/projects/${projectId}`, { name: 'Edited by direct editor' });
		expect(r.status).toBe(200);
		expect(r.body.project.name).toBe('Edited by direct editor');

		// The same for a direct editor who isn't in the team at all.
		const outsider = await signUp('DirectOnly');
		expect((await admin.call('POST', `/projects/${projectId}/members`, { email: outsider.email, role: 'editor' })).status).toBe(201);
		const o = await outsider.call('PATCH', `/projects/${projectId}`, { name: 'Edited from outside the team' });
		expect(o.status).toBe(200);
		expect(o.body.project.team).toEqual({ id: teamId, name: null });
	});

	it('admins change roles to and from viewer; other roles are rejected; the last admin stays', async () => {
		const { admin, teamId, users } = await teamWith({ Clerk: 'member' });
		const u = users.Clerk!;
		const { projectId } = await teamProject(admin, teamId);
		const down = await admin.call('PATCH', `/teams/${teamId}/members/${u.id}`, { role: 'viewer' });
		expect(down.status).toBe(200);
		expect(down.body.member.role).toBe('viewer');
		expect((await u.call('GET', `/projects/${projectId}`)).body.project.role).toBe('viewer');
		expect((await u.call('PATCH', `/projects/${projectId}`, { name: 'x' })).status).toBe(403);
		const up = await admin.call('PATCH', `/teams/${teamId}/members/${u.id}`, { role: 'member' });
		expect(up.body.member.role).toBe('member');
		expect((await u.call('GET', `/projects/${projectId}`)).body.project.role).toBe('editor');

		for (const role of ['owner', 'editor', 'VIEWER', '']) {
			expect((await admin.call('PATCH', `/teams/${teamId}/members/${u.id}`, { role })).status).toBe(400);
			expect((await admin.call('POST', `/teams/${teamId}/members`, { email: 'nobody@example.com', role })).status).toBe(400);
		}
		// The sole admin can't demote themselves to viewer either.
		expect((await admin.call('PATCH', `/teams/${teamId}/members/${admin.id}`, { role: 'viewer' })).status).toBe(409);
		// A viewer manages nothing, but may leave.
		expect((await admin.call('PATCH', `/teams/${teamId}/members/${u.id}`, { role: 'viewer' })).status).toBe(200);
		expect((await u.call('POST', `/teams/${teamId}/members`, { email: 'x@example.com', role: 'viewer' })).status).toBe(403);
		expect((await u.call('PATCH', `/teams/${teamId}`, { name: 'x' })).status).toBe(403);
		expect((await u.call('GET', `/teams/${teamId}/invites`)).status).toBe(403);
		expect((await u.call('DELETE', `/teams/${teamId}/members/${u.id}`)).status).toBe(204);
		expect((await u.call('GET', `/projects/${projectId}`)).status).toBe(404);
	});
});

