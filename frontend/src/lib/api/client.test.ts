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
});
