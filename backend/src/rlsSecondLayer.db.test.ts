// RLS on its own (issue #56). Every project write is guarded twice: the
// route's role check (requireRole / requireTeamRole) and RLS underneath it.
// Here the role check is switched off, so a viewer reaches each write, and
// RLS alone must refuse it *loudly*: a 404 (what a non-member gets), never a
// 2xx for a write that changed nothing. isolation.db.test.ts proves the two
// layers together; this proves the second one answers honestly by itself.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let bypassRoleCheck = false;
vi.mock('./projects/access.js', async (orig) => {
	const real = await orig<typeof import('./projects/access.js')>();
	return {
		...real,
		requireRole: async (...args: Parameters<typeof real.requireRole>) =>
			bypassRoleCheck && real.UUID.test(args[1]) ? 'owner' : real.requireRole(...args)
	};
});
vi.mock('./teams/access.js', async (orig) => {
	const real = await orig<typeof import('./teams/access.js')>();
	return {
		...real,
		requireTeamRole: async (...args: Parameters<typeof real.requireTeamRole>) =>
			bypassRoleCheck ? 'admin' : real.requireTeamRole(...args)
	};
});
import { signUp } from './__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let viewer: User;
let projectId: string;
let seriesId: string;
let teamId: string;

beforeAll(async () => {
	owner = await signUp('Owner');
	viewer = await signUp('Viewer');
	projectId = (await owner.call('POST', '/projects', { name: 'Kept' })).body.project.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	const series = await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: [1, 2, 3] });
	expect(series.status).toBe(200);
	seriesId = series.body.id;
	teamId = (await owner.call('POST', '/teams', { name: 'Kept team' })).body.team.id;
	expect((await owner.call('POST', `/teams/${teamId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
});

afterEach(() => {
	bypassRoleCheck = false;
});

describe('with the route role check bypassed, RLS alone refuses a viewer, loudly', () => {
	it('positive control: the viewer sees what they are about to try to change', async () => {
		expect((await viewer.call('GET', `/projects/${projectId}`)).body.project.name).toBe('Kept');
		expect((await viewer.call('GET', `/projects/${projectId}/series`)).body.series.map((s: { id: string }) => s.id)).toContain(seriesId);
		expect((await viewer.call('GET', `/teams/${teamId}`)).body.team.name).toBe('Kept team');
	});

	it('the role check is what normally answers (the bypass is what changes)', async () => {
		expect((await viewer.call('DELETE', `/projects/${projectId}`)).status).toBe(403);
	});

	it('DELETE /projects/:id answers 404 and the project stays', async () => {
		bypassRoleCheck = true;
		expect((await viewer.call('DELETE', `/projects/${projectId}`)).status).toBe(404);
		bypassRoleCheck = false;
		expect((await owner.call('GET', `/projects/${projectId}`)).status).toBe(200);
	});

	it('PATCH /projects/:id answers 404 and the name stays', async () => {
		bypassRoleCheck = true;
		expect((await viewer.call('PATCH', `/projects/${projectId}`, { name: 'Renamed' })).status).toBe(404);
		bypassRoleCheck = false;
		expect((await owner.call('GET', `/projects/${projectId}`)).body.project.name).toBe('Kept');
	});

	it('DELETE /projects/:id/series/:seriesId answers 404 and the series stays', async () => {
		bypassRoleCheck = true;
		expect((await viewer.call('DELETE', `/projects/${projectId}/series/${seriesId}`)).status).toBe(404);
		bypassRoleCheck = false;
		expect((await owner.call('GET', `/projects/${projectId}/series`)).body.series.map((s: { id: string }) => s.id)).toContain(seriesId);
	});

	it('PATCH and DELETE /teams/:id answer 404 and the team stays', async () => {
		bypassRoleCheck = true;
		expect((await viewer.call('PATCH', `/teams/${teamId}`, { name: 'Renamed team' })).status).toBe(404);
		expect((await viewer.call('DELETE', `/teams/${teamId}`)).status).toBe(404);
		bypassRoleCheck = false;
		expect((await owner.call('GET', `/teams/${teamId}`)).body.team.name).toBe('Kept team');
	});
});
