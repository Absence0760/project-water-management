import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './client';

function mockFetch(status: number, body?: unknown, raw?: string) {
	return vi.fn(async () =>
		new Response(status === 204 ? null : (raw ?? (body === undefined ? '' : JSON.stringify(body))), {
			status,
			headers: { 'Content-Type': 'application/json' }
		})
	);
}

describe('createApi', () => {
	it('sends credentials and JSON body to the base URL', async () => {
		const f = mockFetch(200, { user: { id: '1', email: 'a@b.c', displayName: 'A' } });
		const api = createApi('http://x/', f);
		const user = await api.auth.login('a@b.c', 'pw');
		expect(user.displayName).toBe('A');
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://x/auth/login');
		expect(init.method).toBe('POST');
		expect(init.credentials).toBe('include');
		expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.c', password: 'pw' });
	});

	it('returns the new run with the ids of runs the server trimmed (none from an older server)', async () => {
		const run = { id: 'r21', label: 'x' };
		const trimmed = createApi('', mockFetch(201, { run, removedRunIds: ['r1'] }));
		await expect(trimmed.runs.create('p1')).resolves.toEqual({ run, removedRunIds: ['r1'] });
		const older = createApi('', mockFetch(201, { run }));
		await expect(older.runs.create('p1')).resolves.toEqual({ run, removedRunIds: [] });
	});

	it('returns undefined for 204', async () => {
		const api = createApi('', mockFetch(204));
		await expect(api.projects.remove('p1')).resolves.toBeUndefined();
	});

	it('throws ApiError with the server message and status', async () => {
		const api = createApi('', mockFetch(409, { error: 'Name already taken' }));
		const err = await api.projects.create('x').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.status).toBe(409);
		expect(err.message).toBe('Name already taken');
	});

	it('appends zod issue details to 400 messages', async () => {
		const details = [{ path: ['nodes', 0, 'name'], message: 'Required' }];
		const api = createApi('', mockFetch(400, { error: 'Invalid model', details }));
		const err = await api.model.save('p', { nodes: [], crops: [], cropAreas: [], transfers: [] }).catch((e) => e);
		expect(err.status).toBe(400);
		expect(err.message).toBe('Invalid model (nodes.0.name: Required)');
		expect(err.details).toEqual(details);
	});

	it('falls back to a status message when the body is not JSON', async () => {
		const api = createApi('', mockFetch(502, undefined, '<html>bad gateway</html>'));
		const err = await api.projects.list().catch((e) => e);
		expect(err.status).toBe(502);
		expect(err.message).toBe('The server had a problem');
	});

	it('maps a network failure to status 0', async () => {
		const f = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});
		const err = await createApi('', f).auth.me().catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.status).toBe(0);
	});

	it('builds run-series query strings, omitting nodeId for catchment', async () => {
		const f = mockFetch(200, { startDate: '2020-01-01', values: [] });
		const api = createApi('', f);
		await api.runs.series('p', 'r', 'natural_flow', null);
		await api.runs.series('p', 'r', 'dam storage', 'n/1');
		expect((f.mock.calls[0] as unknown as [string])[0]).toBe('/projects/p/runs/r/series?key=natural_flow');
		expect((f.mock.calls[1] as unknown as [string])[0]).toBe('/projects/p/runs/r/series?key=dam+storage&nodeId=n%2F1');
	});

	it('sends teamId only when creating a team project', async () => {
		const f = mockFetch(201, { project: { id: 'p' } });
		const api = createApi('', f);
		await api.projects.create('A');
		await api.projects.create('B', 'desc', 't1');
		await api.projects.create('C', undefined, null);
		const bodies = f.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
		expect(bodies[0]).toEqual({ name: 'A' });
		expect(bodies[1]).toEqual({ name: 'B', description: 'desc', teamId: 't1' });
		expect(bodies[2]).toEqual({ name: 'C' });
	});

	it('moves a project between teams via PATCH teamId (null = personal)', async () => {
		const f = mockFetch(200, { project: { id: 'p' } });
		await createApi('', f).projects.update('p', { teamId: null });
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/projects/p');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(init.body as string)).toEqual({ teamId: null });
	});

	it('posts series batches to the merge endpoint', async () => {
		const f = mockFetch(200, { id: 's' });
		const body = { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2026-09-01', values: [1, null] };
		await createApi('', f).series.merge('p', body);
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/projects/p/series/merge');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual(body);
	});
});

describe('teams client', () => {
	const call = (f: ReturnType<typeof mockFetch>, i = 0) => {
		const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
		return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
	};

	it('lists and creates teams, unwrapping the envelope', async () => {
		const team = { id: 't', name: 'Hydro', role: 'admin', createdAt: '', memberCount: 1, projectCount: 0 };
		const list = mockFetch(200, { teams: [team] });
		expect(await createApi('', list).teams.list()).toEqual([team]);
		expect(call(list)).toEqual({ url: '/teams', method: 'GET', body: undefined });

		const create = mockFetch(201, { team });
		expect(await createApi('', create).teams.create('Hydro')).toEqual(team);
		expect(call(create)).toEqual({ url: '/teams', method: 'POST', body: { name: 'Hydro' } });
	});

	it('returns team detail with members', async () => {
		const f = mockFetch(200, { team: { id: 't' }, members: [{ userId: 'u', role: 'admin' }] });
		const r = await createApi('', f).teams.get('t');
		expect(r.members).toHaveLength(1);
		expect(call(f).url).toBe('/teams/t');
	});

	it('builds member management requests with encoded ids', async () => {
		const f = mockFetch(200, { member: { userId: 'u/1', role: 'member' }, team: { id: 't' } });
		const api = createApi('', f);
		await api.teams.rename('t', 'New');
		await api.teams.addMember('t', 'a@b.c', 'member');
		await api.teams.setRole('t', 'u/1', 'admin');
		expect(call(f, 0)).toEqual({ url: '/teams/t', method: 'PATCH', body: { name: 'New' } });
		expect(call(f, 1)).toEqual({ url: '/teams/t/members', method: 'POST', body: { email: 'a@b.c', role: 'member' } });
		expect(call(f, 2)).toEqual({ url: '/teams/t/members/u%2F1', method: 'PATCH', body: { role: 'admin' } });
	});

	it('members.add / teams.addMember return the member or the pending invite, never undefined', async () => {
		const member = { userId: 'u', email: 'a@b.c', displayName: 'A', role: 'viewer' };
		const m = await createApi('', mockFetch(201, { member })).members.add('p', 'a@b.c', 'viewer');
		expect(m).toEqual({ member });

		const invite = { id: 'i', email: 'new@b.c', role: 'member', invitedBy: 'Ann', createdAt: '', expiresAt: '', expired: false };
		const r = await createApi('', mockFetch(201, { invited: true, invite })).teams.addMember('t', 'new@b.c', 'member');
		expect(r.invited).toBe(true);
		expect(r.invite).toEqual(invite);
		expect(r.member).toBeUndefined();
	});

	it('register sends inviteToken only when there is one', async () => {
		const f = mockFetch(201, { user: { id: 'u' } });
		const api = createApi('', f);
		await api.auth.register('a@b.c', 'longenough', 'A');
		await api.auth.register('a@b.c', 'longenough', 'A', 'tok');
		expect(call(f, 0).body).toEqual({ email: 'a@b.c', password: 'longenough', displayName: 'A' });
		expect(call(f, 1).body).toEqual({ email: 'a@b.c', password: 'longenough', displayName: 'A', inviteToken: 'tok' });
	});

	it('deletes teams and members (204)', async () => {
		const f = mockFetch(204);
		const api = createApi('', f);
		await expect(api.teams.removeMember('t', 'u')).resolves.toBeUndefined();
		await expect(api.teams.remove('t')).resolves.toBeUndefined();
		expect(call(f, 0)).toMatchObject({ url: '/teams/t/members/u', method: 'DELETE' });
		expect(call(f, 1)).toMatchObject({ url: '/teams/t', method: 'DELETE' });
	});

	it('surfaces the last-admin 409 message', async () => {
		const f = mockFetch(409, { error: 'a team must keep at least one admin' });
		const err = await createApi('', f).teams.removeMember('t', 'u').catch((e) => e);
		expect(err.status).toBe(409);
		expect(err.message).toBe('a team must keep at least one admin');
	});

	it('encodes both run refs for the compare endpoint', async () => {
		const f = mockFetch(200, { changes: [] });
		await createApi('http://x', f).compare.runs('p1:r1', 'p2:r2');
		expect((f.mock.calls[0] as unknown as [string])[0]).toBe('http://x/compare/runs?a=p1%3Ar1&b=p2%3Ar2');
	});
});
