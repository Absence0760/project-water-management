import { describe, expect, it } from 'vitest';
import { signUp } from '../__tests__/helpers.js';

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
