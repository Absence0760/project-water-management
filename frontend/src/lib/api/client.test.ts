import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, scenarioProblems } from './client';
import { LEGAL_VERSION } from '@water-management/engine/legal';

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

	it('posts to /auth/logout-everywhere and returns undefined (204)', async () => {
		const f = mockFetch(204);
		const api = createApi('http://x', f);
		await expect(api.auth.logoutEverywhere()).resolves.toBeUndefined();
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://x/auth/logout-everywhere');
		expect(init.method).toBe('POST');
	});

	it('PATCHes /auth/me with the display name and returns the user', async () => {
		const user = { id: '1', email: 'a@b.c', displayName: 'New name', emailVerified: true };
		const f = mockFetch(200, { user });
		await expect(createApi('http://x', f).auth.updateMe({ displayName: 'New name' })).resolves.toEqual(user);
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://x/auth/me');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(init.body as string)).toEqual({ displayName: 'New name' });
	});

	it('PATCHes /auth/me with only the preferences sent (locale may be null)', async () => {
		const user = { id: '1', email: 'a@b.c', displayName: 'A', locale: null, volumeUnit: 'ML' };
		const f = mockFetch(200, { user });
		await expect(createApi('http://x', f).auth.updateMe({ locale: null, volumeUnit: 'ML' })).resolves.toEqual(user);
		const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({ locale: null, volumeUnit: 'ML' });
	});

	it('PATCHes /auth/me with the sections hidden from the sidebar', async () => {
		const user = { id: '1', email: 'a@b.c', displayName: 'A', preferences: { hiddenTabs: ['crops'] } };
		const f = mockFetch(200, { user });
		await expect(createApi('http://x', f).auth.updateMe({ preferences: { hiddenTabs: ['crops'] } })).resolves.toEqual(user);
		const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(JSON.parse(init.body as string)).toEqual({ preferences: { hiddenTabs: ['crops'] } });
	});

	it('POSTs /me/alerts/resume to turn alert emails back on after a bounce', async () => {
		const f = mockFetch(200, { mailSuppressed: null });
		await expect(createApi('http://x', f).alerts.resume()).resolves.toEqual({ mailSuppressed: null });
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://x/me/alerts/resume');
		expect(init.method).toBe('POST');
	});

	it('posts both passwords to /auth/change-password and surfaces a wrong current password as ApiError 403', async () => {
		const user = { id: '1', email: 'a@b.c', displayName: 'A', emailVerified: true };
		const f = mockFetch(200, { user });
		await expect(createApi('http://x', f).auth.changePassword('old pw', 'new password')).resolves.toEqual(user);
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('http://x/auth/change-password');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ currentPassword: 'old pw', newPassword: 'new password' });

		const wrong = createApi('', mockFetch(403, { error: 'your current password is wrong' }));
		await expect(wrong.auth.changePassword('x', 'new password')).rejects.toMatchObject({
			status: 403,
			message: 'your current password is wrong'
		});
	});

	it('returns the new run with the ids of runs the server trimmed (none from an older server)', async () => {
		const run = { id: 'r21', label: 'x' };
		const trimmed = createApi('', mockFetch(201, { run, removedRunIds: ['r1'] }));
		await expect(trimmed.runs.create('p1')).resolves.toEqual({ run, removedRunIds: ['r1'] });
		const older = createApi('', mockFetch(201, { run }));
		await expect(older.runs.create('p1')).resolves.toEqual({ run, removedRunIds: [] });
	});

	it('PATCHes a run’s notes and returns the updated run metadata', async () => {
		const run = { id: 'r/1', notes: 'why', notesUpdatedBy: 'Ann' };
		const f = mockFetch(200, { run });
		await expect(createApi('', f).runs.setNotes('p1', 'r/1', 'why')).resolves.toEqual(run);
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/projects/p1/runs/r%2F1');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(init.body as string)).toEqual({ notes: 'why' });
	});

	it('PATCHes only the pin to pin or unpin a run', async () => {
		const run = { id: 'r/1', pinned: true };
		const f = mockFetch(200, { run });
		await expect(createApi('', f).runs.setPinned('p1', 'r/1', true)).resolves.toEqual(run);
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/projects/p1/runs/r%2F1');
		expect(init.method).toBe('PATCH');
		expect(JSON.parse(init.body as string)).toEqual({ pinned: true });
	});

	it('reads the evidence history and POSTs a nomination, answering with the whole history', async () => {
		const nominations = [{ id: 'n1', runId: 'r1', reason: 'why' }];
		const get = mockFetch(200, { nominations });
		await expect(createApi('', get).runs.nominations('p/1')).resolves.toEqual(nominations);
		expect((get.mock.calls[0] as unknown as [string])[0]).toBe('/projects/p%2F1/evidence');
		const post = mockFetch(201, { nomination: nominations[0], nominations });
		await expect(createApi('', post).runs.nominate('p1', 'r1', 'why')).resolves.toEqual(nominations);
		const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/projects/p1/evidence');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ runId: 'r1', reason: 'why' });
	});

	it('GETs a reproduction of a run', async () => {
		const body = { status: 'identical', identical: true, engineVersionThen: '1.0.0', engineVersionNow: '1.0.0', differences: [], truncated: 0 };
		const get = mockFetch(200, body);
		await expect(createApi('', get).runs.reproduce('p1', 'r/1')).resolves.toEqual(body);
		expect((get.mock.calls[0] as unknown as [string])[0]).toBe('/projects/p1/runs/r%2F1/reproduce');
	});

	it('reads the publication, POSTs a publish and PATCHes the notice by publication id', async () => {
		const body = { current: null, history: [] };
		const get = mockFetch(200, body);
		await expect(createApi('', get).publication.get('p/1')).resolves.toEqual(body);
		expect((get.mock.calls[0] as unknown as [string])[0]).toBe('/projects/p%2F1/publication');
		const publication = { id: 'pub1', runId: 'r1' };
		const post = mockFetch(201, { publication, farms: 3 });
		const restriction = { level: 'advisory' as const, pct: null, notice: { en: 'Save water' } };
		await expect(createApi('', post).publication.publish('p1', { runId: 'r1', restriction })).resolves.toEqual({ publication, farms: 3 });
		const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('/projects/p1/publication');
		expect(init.method).toBe('POST');
		expect(JSON.parse(init.body as string)).toEqual({ runId: 'r1', restriction });
		const patch = mockFetch(200, { publication });
		await expect(createApi('', patch).publication.update('p1', 'pub/1', { nextExpectedOn: null })).resolves.toEqual(publication);
		const [purl, pinit] = patch.mock.calls[0] as unknown as [string, RequestInit];
		expect(purl).toBe('/projects/p1/publication/pub%2F1');
		expect(pinit.method).toBe('PATCH');
		expect(JSON.parse(pinit.body as string)).toEqual({ nextExpectedOn: null });
	});

	it('lists notes with only the filters given, counts them, and adds, edits and deletes one', async () => {
		const note = { id: 'n1', body: 'Dam raised in 2019' };
		const list = mockFetch(200, { notes: [note] });
		await expect(createApi('', list).notes.list('p/1', { nodeId: 'a', runId: undefined, settingKey: '' })).resolves.toEqual([note]);
		expect((list.mock.calls[0] as unknown as [string])[0]).toBe('/projects/p%2F1/notes?nodeId=a');
		const all = mockFetch(200, { notes: [] });
		await createApi('', all).notes.list('p1');
		expect((all.mock.calls[0] as unknown as [string])[0]).toBe('/projects/p1/notes');
		const counts = mockFetch(200, { project: 1, nodes: {}, runs: {}, settings: {} });
		await expect(createApi('', counts).notes.counts('p1')).resolves.toMatchObject({ project: 1 });
		expect((counts.mock.calls[0] as unknown as [string])[0]).toBe('/projects/p1/notes/counts');
		const post = mockFetch(201, { note });
		await expect(createApi('', post).notes.create('p1', { body: 'x', nodeId: 'a', visibility: 'farm' })).resolves.toEqual(note);
		const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit];
		expect([url, init.method, JSON.parse(init.body as string)]).toEqual(['/projects/p1/notes', 'POST', { body: 'x', nodeId: 'a', visibility: 'farm' }]);
		const patch = mockFetch(200, { note });
		await expect(createApi('', patch).notes.edit('p1', 'n/1', 'y')).resolves.toEqual(note);
		const [purl, pinit] = patch.mock.calls[0] as unknown as [string, RequestInit];
		expect([purl, pinit.method, JSON.parse(pinit.body as string)]).toEqual(['/projects/p1/notes/n%2F1', 'PATCH', { body: 'y' }]);
		const del = mockFetch(204);
		await expect(createApi('', del).notes.remove('p1', 'n1')).resolves.toBeUndefined();
		expect((del.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('DELETE');
	});

	it('moves a flow record to a gauge, or back to the outlet, with a PATCH of its site only', async () => {
		const meta = { id: 's1', kind: 'flow_observed_m3s', siteNodeId: 'g1' };
		const patch = mockFetch(200, meta);
		await expect(createApi('', patch).series.site('p1', 's/1', 'g1')).resolves.toEqual(meta);
		const [url, init] = patch.mock.calls[0] as unknown as [string, RequestInit];
		expect([url, init.method, JSON.parse(init.body as string)]).toEqual(['/projects/p1/series/s%2F1', 'PATCH', { siteNodeId: 'g1' }]);
		const back = mockFetch(200, { ...meta, siteNodeId: null });
		await createApi('', back).series.site('p1', 's1', null);
		expect(JSON.parse((back.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ siteNodeId: null });
	});

	it('lists, makes and withdraws share links, and reads a share by token in the body, never the URL', async () => {
		const link = { id: 'l1', label: 'Forum', url: 'http://x/share#t=abc' };
		const list = mockFetch(200, { links: [link] });
		await expect(createApi('', list).shareLinks.list('p/1')).resolves.toEqual([link]);
		expect((list.mock.calls[0] as unknown as [string])[0]).toBe('/projects/p%2F1/share-links');
		const post = mockFetch(201, { link });
		await expect(createApi('', post).shareLinks.create('p1', 'Forum', 30)).resolves.toEqual(link);
		const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit];
		expect([url, init.method, JSON.parse(init.body as string)]).toEqual(['/projects/p1/share-links', 'POST', { label: 'Forum', expiresInDays: 30 }]);
		const del = mockFetch(204);
		await expect(createApi('', del).shareLinks.revoke('p1', 'l/1')).resolves.toBeUndefined();
		expect((del.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/projects/p1/share-links/l%2F1');
		const view = mockFetch(200, { project: { name: 'X' } });
		await createApi('', view).share.view('tok');
		const [vurl, vinit] = view.mock.calls[0] as unknown as [string, RequestInit];
		expect([vurl, vinit.method, JSON.parse(vinit.body as string)]).toEqual(['/share/view', 'POST', { token: 'tok' }]);
		const series = mockFetch(404, { error: 'not found' });
		await expect(createApi('', series).share.series('tok', 'ewr')).rejects.toMatchObject({ status: 404 });
		expect(JSON.parse((series.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ token: 'tok', key: 'ewr' });
	});

	it('lists, makes and revokes API keys (the secret comes back once, from the create)', async () => {
		const key = { id: 'k1', name: 'Gateway', prefix: 'k1k1k1k1' };
		const list = mockFetch(200, { keys: [key] });
		await expect(createApi('', list).apiKeys.list('p/1')).resolves.toEqual([key]);
		expect((list.mock.calls[0] as unknown as [string])[0]).toBe('/projects/p%2F1/api-keys');
		const post = mockFetch(201, { key, secret: 'wm_k1k1k1k1_x' });
		await expect(createApi('', post).apiKeys.create('p1', { name: 'Gateway', expiresInDays: null })).resolves.toEqual({ key, secret: 'wm_k1k1k1k1_x' });
		const [url, init] = post.mock.calls[0] as unknown as [string, RequestInit];
		expect([url, init.method, JSON.parse(init.body as string)]).toEqual(['/projects/p1/api-keys', 'POST', { name: 'Gateway', expiresInDays: null }]);
		const del = mockFetch(204);
		await expect(createApi('', del).apiKeys.revoke('p1', 'k/1')).resolves.toBeUndefined();
		expect((del.mock.calls[0] as unknown as [string, RequestInit])[0]).toBe('/projects/p1/api-keys/k%2F1');
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
		expect(err.code).toBeNull();
		expect(err.params).toEqual({});
	});

	it('carries the server’s stable error code and its params (docs/api.md § Errors)', async () => {
		const api = createApi('', mockFetch(429, { error: 'too many sign-in attempts', code: 'signin_locked', params: { seconds: 120 } }));
		const err = await api.auth.login('a@example.com', 'x').catch((e) => e);
		expect(err).toMatchObject({ status: 429, code: 'signin_locked', params: { seconds: 120 }, message: 'too many sign-in attempts' });
		// Junk in either field is dropped, not trusted.
		const junk = await createApi('', mockFetch(400, { error: 'x', code: 7, params: [1] })).auth.me().catch((e) => e);
		expect(junk).toMatchObject({ code: null, params: {} });
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

	it('reaches a run’s uncertainty ensembles under the run, encoding each id', async () => {
		const f = mockFetch(200, { ensembles: [{ id: 'e' }], ensemble: { id: 'e' }, input: { settings: {} }, notes: [] });
		const api = createApi('', f);
		await expect(api.uncertainty.list('p', 'r/1')).resolves.toEqual([{ id: 'e' }]);
		await api.uncertainty.get('p', 'r', 'e/1');
		await expect(api.uncertainty.runInput('p', 'r')).resolves.toEqual({ settings: {} });
		await api.uncertainty.start('p', 'r', { baselineId: 'b' });
		await expect(api.uncertainty.complete('p', 'r', 'e', { members: [] })).resolves.toEqual({ id: 'e' });
		const calls = f.mock.calls as unknown as [string, RequestInit][];
		expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
			'GET /projects/p/runs/r%2F1/uncertainty',
			'GET /projects/p/runs/r/uncertainty/e%2F1',
			'GET /projects/p/runs/r/model-input',
			'POST /projects/p/runs/r/uncertainty',
			'POST /projects/p/runs/r/uncertainty/e/result'
		]);
		expect(JSON.parse(calls[3]![1].body as string)).toEqual({ baselineId: 'b' });
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

	it('reads the team portfolio as it comes (WP-2.14)', async () => {
		const body = { team: { id: 't/1', name: 'WUA', role: 'viewer' }, thresholds: { amber: 0.05, red: 0.2 }, projects: [] };
		const f = mockFetch(200, body);
		expect(await createApi('', f).teams.portfolio('t/1')).toEqual(body);
		expect(call(f)).toEqual({ url: '/teams/t%2F1/portfolio', method: 'GET', body: undefined });
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

	it('sets a team’s portfolio thresholds, or clears them with null (D11)', async () => {
		const team = { id: 't/1', portfolioThresholds: { green: 10, amber: 30, source: 'team' } };
		const f = mockFetch(200, { team });
		const api = createApi('', f);
		expect(await api.teams.setThresholds('t/1', { green: 10, amber: 30 })).toEqual(team);
		await api.teams.setThresholds('t/1', null);
		expect(call(f, 0)).toEqual({ url: '/teams/t%2F1', method: 'PATCH', body: { settings: { portfolio: { thresholds: { green: 10, amber: 30 } } } } });
		expect(call(f, 1)).toEqual({ url: '/teams/t%2F1', method: 'PATCH', body: { settings: { portfolio: { thresholds: null } } } });
	});

	it('farmers.* call the farmer routes and unwrap the farmer', async () => {
		const farmer = { status: 'active', userId: 'u', email: 'f@example.com', displayName: 'F', nodeIds: ['n1'] };
		const add = mockFetch(201, { farmer });
		expect(await createApi('', add).farmers.add('p', 'f@example.com', ['n1'])).toEqual({ farmer });
		expect(add).toHaveBeenCalledWith(
			'/projects/p/farmers',
			expect.objectContaining({ method: 'POST', body: JSON.stringify({ email: 'f@example.com', nodeIds: ['n1'], locale: 'en', role: 'farmer' }) })
		);
		// An applicant with their farms (WP-3.3, 097).
		const applicant = mockFetch(201, { farmer });
		await createApi('', applicant).farmers.add('p', 'a@example.com', ['n1'], 'en', 'contributor');
		expect(applicant).toHaveBeenCalledWith(
			'/projects/p/farmers',
			expect.objectContaining({ body: JSON.stringify({ email: 'a@example.com', nodeIds: ['n1'], locale: 'en', role: 'contributor' }) })
		);
		const results = [{ row: 0, email: 'f@example.com', farm: 'Hoek', status: 'invited' }];
		const bulk = mockFetch(200, { results, dryRun: true });
		expect(await createApi('', bulk).farmers.bulk('p', [{ email: 'f@example.com', farm: 'Hoek', locale: 'af' }], true)).toEqual(results);
		expect(bulk).toHaveBeenCalledWith(
			'/projects/p/farmers/bulk',
			expect.objectContaining({ method: 'POST', body: JSON.stringify({ rows: [{ email: 'f@example.com', farm: 'Hoek', locale: 'af' }], dryRun: true }) })
		);
		const put = mockFetch(200, { farmer });
		expect(await createApi('', put).farmers.setFarms('p', 'u', ['n1'])).toEqual(farmer);
		expect(put).toHaveBeenCalledWith('/projects/p/farmers/u', expect.objectContaining({ method: 'PUT' }));
		expect(await createApi('', mockFetch(200, { farmers: [farmer] })).farmers.list('p')).toEqual([farmer]);
	});

	it('farm.index / farm.view GET the farm routes and return the body as is; exportUrl builds the CSV link', async () => {
		const index = { project: { id: 'p/1', name: 'P' }, farms: [{ nodeId: 'n/1', name: 'F' }], publication: null };
		const i = mockFetch(200, index);
		expect(await createApi('http://x/', i).farm.index('p/1')).toEqual(index);
		expect(i).toHaveBeenCalledWith('http://x/projects/p%2F1/farm', expect.objectContaining({ method: 'GET', credentials: 'include' }));
		const view = { project: { id: 'p', name: 'P' }, stale: false };
		const v = mockFetch(200, view);
		expect(await createApi('', v).farm.view('p', 'n/1')).toEqual(view);
		expect(v).toHaveBeenCalledWith('/projects/p/farm/n%2F1', expect.objectContaining({ method: 'GET' }));
		expect(createApi('http://x/').farm.exportUrl('p/1', 'n 1')).toBe('http://x/projects/p%2F1/farm/n%201/export.csv');
	});

	it('farm.view keeps the status of a refusal, so the page can tell "access removed" (403/404) from a failure', async () => {
		await expect(createApi('', mockFetch(403, { error: 'forbidden' })).farm.view('p', 'n')).rejects.toMatchObject({ status: 403 });
		await expect(createApi('', mockFetch(404)).farm.index('p')).rejects.toMatchObject({ status: 404 });
		const offline = createApi('', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
		await expect(offline.farm.view('p', 'n')).rejects.toMatchObject({ status: 0 });
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

	it('register sends inviteToken only when there is one, and always the terms version it accepts', async () => {
		const f = mockFetch(201, { user: { id: 'u' } });
		const api = createApi('', f);
		await api.auth.register('a@b.c', 'longenough', 'A');
		await api.auth.register('a@b.c', 'longenough', 'A', 'tok');
		const base = { email: 'a@b.c', password: 'longenough', displayName: 'A', acceptTerms: LEGAL_VERSION };
		expect(call(f, 0).body).toEqual(base);
		expect(call(f, 1).body).toEqual({ ...base, inviteToken: 'tok' });
	});

	it('acceptTerms posts the terms version this build shows and returns the user', async () => {
		const f = mockFetch(200, { user: { id: 'u', termsCurrent: true } });
		const user = await createApi('', f).auth.acceptTerms();
		expect(user).toEqual({ id: 'u', termsCurrent: true });
		expect(call(f, 0)).toMatchObject({ url: '/auth/me/accept-terms', method: 'POST', body: { version: LEGAL_VERSION } });
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
		const f = mockFetch(409, { error: 'a team must keep at least one owner' });
		const err = await createApi('', f).teams.removeMember('t', 'u').catch((e) => e);
		expect(err.status).toBe(409);
		expect(err.message).toBe('a team must keep at least one owner');
	});

	it('imports a project file: the document is the body, teamId and run go in the query', async () => {
		const file = { name: 'P', model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series: [], format: 'water-management/project' };
		const project = { id: 'p1', name: 'P' };
		const f = mockFetch(201, { project });
		const api = createApi('http://x', f);
		await expect(api.projects.importProject(file)).resolves.toEqual({ project });
		expect(call(f, 0)).toEqual({ url: 'http://x/projects/import', method: 'POST', body: file });

		const g = mockFetch(201, { project, runId: 'r1' });
		await expect(createApi('', g).projects.importProject(file, { teamId: 't/1', run: true })).resolves.toEqual({ project, runId: 'r1' });
		expect(call(g, 0).url).toBe('/projects/import?teamId=t%2F1&run=1');

		// A failed run still answers 201 with the project, and says why.
		const h = mockFetch(201, { project, runError: 'model run failed: no A-pan' });
		await expect(createApi('', h).projects.importProject(file, { teamId: null, run: true })).resolves.toEqual({
			project,
			runError: 'model run failed: no A-pan'
		});
		expect(call(h, 0).url).toBe('/projects/import?run=1');
	});

	it('sends the import report beside the document, replacing any the file carries', async () => {
		const file = { name: 'P', model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, importReport: { forged: true } };
		const report = {
			source: 'b023-workbook' as const,
			fileName: 'synthetic_b023.xlsx',
			importerVersion: 'b023 browser importer (web build 1)',
			notes: [],
			unmapped: [{ code: 'transfer-inout-formula' as const, message: 'hand-written', text: '=S7*0.9-V7' }],
			notesOmitted: 0,
			unmappedOmitted: 0
		};
		const f = mockFetch(201, { project: { id: 'p1' } });
		await createApi('', f).projects.importProject(file, { report });
		expect(call(f, 0).body).toEqual({ ...file, importReport: report });
	});

	it('reads a project’s import report, null when it has none, and throws on a 404', async () => {
		const stored = { importedAt: '2026-09-25T10:00:00.000Z', importedBy: 'Owner', source: 'project-file', fileName: 'c.json', importerVersion: 'v', notes: [], unmapped: [], notesOmitted: 0, unmappedOmitted: 0 };
		const f = mockFetch(200, { report: stored });
		await expect(createApi('http://x', f).projects.importReport('p/1')).resolves.toEqual(stored);
		expect(call(f, 0)).toMatchObject({ url: 'http://x/projects/p%2F1/import-report', method: 'GET' });
		await expect(createApi('', mockFetch(200, { report: null })).projects.importReport('p')).resolves.toBeNull();
		// An older backend (before #162) said the same with a 404.
		await expect(createApi('', mockFetch(404, { error: 'no import report' })).projects.importReport('p')).resolves.toBeNull();
		const err = await createApi('', mockFetch(404, { error: 'not found' })).projects.importReport('p').catch((e) => e);
		expect(err.status).toBe(404);
	});

	it('surfaces an import’s model problems and the 413 hint', async () => {
		const file = { name: 'P', model: { nodes: [], crops: [], cropAreas: [], transfers: [] } };
		const bad = mockFetch(400, { error: 'invalid project file', details: [{ message: 'duplicate series rain_catchment_mm' }] });
		const err = await createApi('', bad).projects.importProject(file).catch((e) => e);
		expect(err.status).toBe(400);
		expect(err.message).toBe('invalid project file (duplicate series rain_catchment_mm)');
		const big = mockFetch(413, { error: 'project file larger than 5 MB — remove series …' });
		expect((await createApi('', big).projects.importProject(file).catch((e) => e)).message).toBe('project file larger than 5 MB — remove series …');
		// A 413 from in front of the API (no JSON body) still reads as too large.
		const bare = mockFetch(413, undefined, 'Payload Too Large');
		expect((await createApi('', bare).projects.importProject(file).catch((e) => e)).message).toBe('That is too large to send');
	});

	it('encodes both run refs for the compare endpoint', async () => {
		const f = mockFetch(200, { changes: [] });
		await createApi('http://x', f).compare.runs('p1:r1', 'p2:r2');
		expect((f.mock.calls[0] as unknown as [string])[0]).toBe('http://x/compare/runs?a=p1%3Ar1&b=p2%3Ar2');
	});
});

describe('scenarios client', () => {
	const call = (f: ReturnType<typeof mockFetch>, i = 0) => {
		const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
		return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
	};
	const scenario = { id: 's/1', name: 'Dam raise', status: 'draft' };
	const check = { applied: [], problems: [], classified: [] };

	it('lists, reads, creates, updates and removes scenarios', async () => {
		const list = mockFetch(200, { scenarios: [scenario] });
		expect(await createApi('', list).scenarios.list('p/1')).toEqual([scenario]);
		expect(call(list)).toEqual({ url: '/projects/p%2F1/scenarios', method: 'GET', body: undefined });

		const get = mockFetch(200, { scenario, check, checkError: null });
		expect(await createApi('', get).scenarios.get('p', 's/1')).toEqual({ scenario, check, checkError: null });
		expect(call(get).url).toBe('/projects/p/scenarios/s%2F1');

		const body = { name: 'Dam raise', baseRunId: 'r1', ops: [] };
		const create = mockFetch(201, { scenario, check, checkError: null });
		await createApi('', create).scenarios.create('p', body);
		expect(call(create)).toEqual({ url: '/projects/p/scenarios', method: 'POST', body });

		const update = mockFetch(200, { scenario, check, checkError: null });
		await createApi('', update).scenarios.update('p', 's', { status: 'submitted' });
		expect(call(update)).toEqual({ url: '/projects/p/scenarios/s', method: 'PATCH', body: { status: 'submitted' } });

		const remove = mockFetch(204);
		await expect(createApi('', remove).scenarios.remove('p', 's')).resolves.toBeUndefined();
		expect(call(remove)).toEqual({ url: '/projects/p/scenarios/s', method: 'DELETE', body: undefined });
	});

	it('runs a scenario (no trimmed ids from an older server) and rebases it, dry run by choice', async () => {
		const run = { id: 'r2', scenarioId: 's' };
		const f = mockFetch(201, { run, applied: [], classified: ['proposal'] });
		expect(await createApi('', f).scenarios.run('p', 's')).toEqual({ run, applied: [], classified: ['proposal'], removedRunIds: [] });
		expect(call(f)).toEqual({ url: '/projects/p/scenarios/s/runs', method: 'POST', body: {} });

		const rebase = mockFetch(200, { scenario, ...check });
		await createApi('', rebase).scenarios.rebase('p', 's', 'r9', true);
		expect(call(rebase)).toEqual({ url: '/projects/p/scenarios/s/rebase', method: 'POST', body: { baseRunId: 'r9', dryRun: true } });
	});

	it('reads the problems a scenario run was refused over, and nothing from any other error', async () => {
		const problems = ['op 2 (node.set): node n not found'];
		const refused = await createApi('', mockFetch(422, { error: "an op of this scenario doesn't apply to its base run", details: { problems } }))
			.scenarios.run('p', 's')
			.catch((e) => e);
		expect(refused.status).toBe(422);
		expect(scenarioProblems(refused)).toEqual(problems);
		expect(scenarioProblems(new ApiError(409, 'x', { problems }))).toEqual([]);
		expect(scenarioProblems(new Error('x'))).toEqual([]);
	});
});

describe('sweeps client', () => {
	const call = (f: ReturnType<typeof mockFetch>, i = 0) => {
		const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
		return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
	};

	it('creates a sweep, lists a base run’s sweeps, and reads one with or without its series', async () => {
		const body = { name: 'Demand levels', baseRunId: 'r', members: [{ name: '100 %', ops: [{ op: 'demand.scale' as const, factor: 1 }] }] };
		const create = mockFetch(202, { sweep: { id: 's' }, jobId: 'j', job: { id: 'j' } });
		expect((await createApi('', create).sweeps.create('p', body)).sweep.id).toBe('s');
		expect(call(create)).toEqual({ url: '/projects/p/sweeps', method: 'POST', body });

		const list = mockFetch(200, { sweeps: [{ id: 's' }] });
		expect(await createApi('', list).sweeps.list('p', { baseRunId: 'r/1' })).toEqual([{ id: 's' }]);
		expect(call(list).url).toBe('/projects/p/sweeps?baseRunId=r%2F1');
		const all = mockFetch(200, { sweeps: [] });
		await createApi('', all).sweeps.list('p');
		expect(call(all).url).toBe('/projects/p/sweeps');

		const get = mockFetch(200, { sweep: { id: 's' } });
		expect(await createApi('', get).sweeps.get('p', 's/1')).toEqual({ id: 's' });
		expect(call(get).url).toBe('/projects/p/sweeps/s%2F1');
		const withSeries = mockFetch(200, { sweep: { id: 's' } });
		await createApi('', withSeries).sweeps.get('p', 's', { series: true });
		expect(call(withSeries).url).toBe('/projects/p/sweeps/s?series=true');
	});
});

describe('outlooks client', () => {
	const call = (f: ReturnType<typeof mockFetch>, i = 0) => {
		const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
		return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
	};

	it('creates an outlook, lists a base run’s outlooks, and reads one', async () => {
		const body = { name: 'Seasonal outlook', baseRunId: 'r', levels: [{ label: '100 %', ops: [{ op: 'demand.scale' as const, factor: 1 }] }] };
		const create = mockFetch(202, { outlook: { id: 'o' }, jobId: 'j', job: { id: 'j' } });
		expect((await createApi('', create).outlooks.create('p', body)).outlook.id).toBe('o');
		expect(call(create)).toEqual({ url: '/projects/p/outlooks', method: 'POST', body });

		const list = mockFetch(200, { outlooks: [{ id: 'o' }] });
		expect(await createApi('', list).outlooks.list('p', { baseRunId: 'r/1' })).toEqual([{ id: 'o' }]);
		expect(call(list).url).toBe('/projects/p/outlooks?baseRunId=r%2F1');
		const all = mockFetch(200, { outlooks: [] });
		await createApi('', all).outlooks.list('p');
		expect(call(all).url).toBe('/projects/p/outlooks');

		const get = mockFetch(200, { outlook: { id: 'o' } });
		expect(await createApi('', get).outlooks.get('p', 'o/1')).toEqual({ id: 'o' });
		expect(call(get)).toEqual({ url: '/projects/p/outlooks/o%2F1', method: 'GET', body: undefined });
	});
});

describe('jobs and yield client', () => {
	const call = (f: ReturnType<typeof mockFetch>, i = 0) => {
		const [url, init] = f.mock.calls[i] as unknown as [string, RequestInit];
		return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
	};

	it('lists jobs with an optional filter', async () => {
		const f = mockFetch(200, { jobs: [{ id: 'j' }] });
		expect(await createApi('', f).jobs.list('p/1')).toEqual([{ id: 'j' }]);
		expect(call(f).url).toBe('/projects/p%2F1/jobs');
		const g = mockFetch(200, { jobs: [] });
		await createApi('', g).jobs.list('p', { status: 'running', limit: 10 });
		expect(call(g).url).toBe('/projects/p/jobs?status=running&limit=10');
	});

	it('queues a yield, lists results and cancels a job', async () => {
		const start = mockFetch(202, { jobId: 'j', job: { id: 'j' }, created: true });
		const body = { nodeId: 'n', runId: 'r', kind: 'curve' as const, params: { assurance: 0.95 } };
		expect((await createApi('', start).yield.start('p', body)).jobId).toBe('j');
		expect(call(start)).toEqual({ url: '/projects/p/yield', method: 'POST', body });

		const list = mockFetch(200, { results: [{ id: 'y' }] });
		expect(await createApi('', list).yield.list('p', { scenarioId: 's', nodeId: 'n' })).toEqual([{ id: 'y' }]);
		expect(call(list).url).toBe('/projects/p/yield?scenarioId=s&nodeId=n');

		const jobs = mockFetch(200, { jobs: [{ id: 'j' }] });
		expect(await createApi('', jobs).yield.jobs('p', { nodeId: 'n', runId: 'r' })).toEqual([{ id: 'j' }]);
		expect(call(jobs).url).toBe('/projects/p/yield/jobs?nodeId=n&runId=r');

		const cancel = mockFetch(200, { status: 'dead', cancelled: true });
		expect(await createApi('', cancel).yield.cancel('p', 'j/1')).toEqual({ status: 'dead', cancelled: true });
		expect(call(cancel)).toEqual({ url: '/projects/p/yield/j%2F1/cancel', method: 'POST', body: undefined });
	});
});
