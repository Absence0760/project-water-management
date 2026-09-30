// The render session, swept over the live route inventory (docs/security.md
// § Render tokens). reports.db.test.ts checks the token's basics and a
// hand-picked list of refusals; this file makes the scope hold for every
// route the app has, including ones added later:
//
//   * a render session reaches exactly READS below (the report page's own
//     reads, reports/scope.ts), for its one project and run, and every other
//     route, method, project and run is refused;
//   * it dies after 10 minutes, and with the account's other sessions
//     (logout everywhere);
//   * the token is single use even when presented many times at once;
//   * a signed session whose scope claim is malformed opens nothing: it
//     never falls back to a full session.
//
// Needs Postgres (pnpm dev:db:up).
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { anon, app, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { issueRenderToken } from './tokens.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';
const SCOPE_REFUSAL = 'this session can only read one report';

afterEach(() => vi.useRealTimers());

/**
 * Every route a render session may reach, and why: the reads the printable
 * report route makes (frontend/src/routes/projects/[id]/report/+page.svelte).
 * Adding one widens what a render token opens: it needs the same scrutiny as
 * a new public route, and a matching change to reports/scope.ts.
 */
const READS: Record<string, { why: string; query?: string }> = {
	'GET /auth/me': { why: 'the layout’s session check' },
	'GET /projects/:id': { why: 'the project: name, settings, time zone' },
	'GET /projects/:id/series': { why: 'the input series’ coverage table' },
	'GET /projects/:id/runs/:runId': { why: 'the run: summary, model, settings' },
	'GET /projects/:id/runs/:runId/series': { why: 'the hydrograph and EWR charts', query: '?key=natural_flow' },
	'GET /projects/:id/runs/:runId/day': { why: 'the self-checks panel’s day trace', query: '?date=2020-01-05' },
	'GET /projects/:id/runs/:runId/signoffs': { why: 'the sign-off section' },
	'GET /projects/:id/runs/:runId/publication': { why: 'the cover’s published-by line and notice, and the changes since the previous publication' }
};

const routes = [
	...new Set(app.routes.filter((r) => r.method !== 'ALL' && r.method !== 'OPTIONS').map((r) => `${r.method} ${r.path}`))
];

/** A project with one run (the reports.db.test.ts fixture). */
async function withRun(u: User, name: string) {
	const projectId = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await u.call('POST', `/projects/${projectId}/runs`, {});
	expect(run.status).toBe(201);
	return { projectId, runId: run.body.run.id as string };
}

/** Exchange a render token for the render session's cookie (or the refusal). */
async function exchange(token: string) {
	const res = await anon('POST', '/auth/render-session', { token });
	return { status: res.status, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? null, setCookie: res.headers.get('set-cookie') };
}

/** A request carrying only `cookie`, with a JSON body on writes (as the browser would send). */
async function as(cookie: string | null, method: string, path: string) {
	const write = method !== 'GET' && method !== 'HEAD';
	const r = await app.request(path, {
		method,
		headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(write ? { 'content-type': 'application/json' } : {}) },
		body: write ? '{}' : undefined
	});
	const text = await r.text();
	let error: unknown = null;
	try {
		error = (JSON.parse(text) as { error?: unknown }).error ?? null;
	} catch {
		// CSV, xlsx, PDF: not JSON, so no error text.
	}
	return { status: r.status, error };
}

/** The route's path with the given project and run filled in, and fresh UUIDs for every other id. */
function fill(route: string, projectId: string, runId: string) {
	const pattern = route.slice(route.indexOf(' ') + 1);
	return pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => (name === 'id' || name === 'projectId' ? projectId : name === 'runId' ? runId : crypto.randomUUID()));
}

async function renderSession(u: User, projectId: string, runId: string) {
	const token = await withUser(u.id, (db) => issueRenderToken(db, projectId, runId));
	const s = await exchange(token);
	expect(s.status).toBe(200);
	return s;
}

describe('a render session, over every route', () => {
	it('reaches exactly the report page’s reads for its project and run (positive control), and is refused everything else', async () => {
		const owner = await signUp('RsSweepOwner');
		const { projectId, runId } = await withRun(owner, 'Swept');
		const otherRun = (await owner.call('POST', `/projects/${projectId}/runs`, {})).body.run.id as string;
		// The owner's own other project: fully theirs, so only the scope keeps the session out.
		const { projectId: otherProject, runId: otherProjectRun } = await withRun(owner, 'Swept other');
		const { cookie } = await renderSession(owner, projectId, runId);

		// The allowlist names real routes, so it can't go stale.
		for (const r of Object.keys(READS)) expect(routes, r).toContain(r);

		// Positive control: every allowlisted read answers 200 for the scoped project and run...
		for (const [route, { query }] of Object.entries(READS)) {
			const res = await as(cookie!, 'GET', fill(route, projectId, runId) + (query ?? ''));
			expect(res.status, route).toBe(200);
			// ...and is refused for another run of the project, or another project, the requester can fully see.
			if (route.includes(':runId')) {
				expect((await as(cookie!, 'GET', fill(route, projectId, otherRun) + (query ?? ''))).status, `${route} (another run)`).toBe(403);
			}
			if (route.includes(':id')) {
				expect((await as(cookie!, 'GET', fill(route, otherProject, otherProjectRun) + (query ?? ''))).status, `${route} (another project)`).toBe(403);
			}
		}

		// Every other route: the render session is refused by its scope. A
		// route anonymous callers may use (the public list, routes.test.ts)
		// takes its own credential, so the session cookie adds nothing there.
		const refused: string[] = [];
		const publicRoutes: string[] = [];
		for (const route of routes) {
			if (READS[route]) continue;
			const method = route.slice(0, route.indexOf(' '));
			const path = fill(route, projectId, runId);
			const signedOut = await as(null, method, path);
			if (signedOut.status !== 401) {
				publicRoutes.push(route);
				continue;
			}
			const res = await as(cookie!, method, path);
			// 401 on a route with a credential of its own (the ingest API key): the session cookie counts for nothing there.
			if (res.status === 401) {
				expect(route, `${route} answered 401 to a render session`).toMatch(/^[A-Z]+ \/ingest\//);
			} else {
				expect({ route, status: res.status, error: res.error }).toEqual({ route, status: 403, error: SCOPE_REFUSAL });
			}
			refused.push(route);
		}
		// The sweep reached the API, not a handful of routes.
		expect(refused.length).toBeGreaterThan(100);
		expect(refused).toEqual(expect.arrayContaining(['DELETE /projects/:id', 'GET /projects/:id/runs', 'GET /projects/:id/runs/:runId/export/daily.csv', 'GET /projects/:id/runs/:runId/allocations', 'POST /auth/logout-everywhere', 'GET /auth/me/export']));
		// What was skipped as public is only the sign-in and token flows.
		for (const r of publicRoutes) expect(r).toMatch(/^(GET \/health|POST \/auth\/|POST \/share\/|POST \/alerts\/unsubscribe)/);

		// The project the session could have harmed is untouched (the refused DELETE and PATCH did nothing).
		const after = await owner.call('GET', `/projects/${projectId}`);
		expect(after.status).toBe(200);
		expect(after.body.project.name).toBe('Swept');
	});
});

describe('a render session’s life', () => {
	it('lasts 10 minutes: accepted at 9, refused at 11', async () => {
		const owner = await signUp('RsTtl');
		const { projectId, runId } = await withRun(owner, 'Ttl');
		const { cookie, setCookie } = await renderSession(owner, projectId, runId);
		expect(setCookie).toMatch(/Max-Age=600\b/);
		expect(setCookie).toMatch(/HttpOnly/);
		const issued = Date.now();
		vi.useFakeTimers({ toFake: ['Date'], now: issued + 9 * 60_000 });
		expect((await as(cookie!, 'GET', `/projects/${projectId}/runs/${runId}`)).status).toBe(200);
		vi.setSystemTime(issued + 11 * 60_000);
		expect((await as(cookie!, 'GET', `/projects/${projectId}/runs/${runId}`)).status).toBe(401);
		expect((await as(cookie!, 'GET', '/auth/me')).status).toBe(401);
	});

	it('ends with the account’s other sessions (logout everywhere); the render session can’t do that itself', async () => {
		const owner = await signUp('RsRevoke');
		const { projectId, runId } = await withRun(owner, 'Revoke');
		const { cookie } = await renderSession(owner, projectId, runId);
		expect((await as(cookie!, 'GET', '/auth/me')).status).toBe(200);
		expect((await as(cookie!, 'POST', '/auth/logout-everywhere')).status).toBe(403);
		expect((await as(cookie!, 'GET', '/auth/me')).status).toBe(200);
		// The requester's own full session signs everything out, the render session with it.
		expect((await owner.call('POST', '/auth/logout-everywhere', {})).status).toBe(204);
		expect((await as(cookie!, 'GET', '/auth/me')).status).toBe(401);
		expect((await as(cookie!, 'GET', `/projects/${projectId}/runs/${runId}`)).status).toBe(401);
	});
});

describe('the render token', () => {
	it('is single use when presented many times at once: exactly one exchange wins', async () => {
		const owner = await signUp('RsRace');
		const { projectId, runId } = await withRun(owner, 'Race');
		const token = await withUser(owner.id, (db) => issueRenderToken(db, projectId, runId));
		const results = await Promise.all(Array.from({ length: 8 }, () => exchange(token)));
		const statuses = results.map((r) => r.status).sort();
		expect(statuses).toEqual([200, 400, 400, 400, 400, 400, 400, 400]);
		expect(results.filter((r) => r.cookie).length).toBe(1);
	});
});

describe('a session’s scope claim', () => {
	const secret = () => new TextEncoder().encode(process.env.AUTH_JWT_SECRET!);
	const sign = (sub: string, claims: Record<string, unknown>) =>
		new SignJWT({ iat_ms: Date.now(), ...claims })
			.setProtectedHeader({ alg: 'HS256' })
			.setSubject(sub)
			.setIssuer('water-management')
			.setIssuedAt()
			.setExpirationTime('600s')
			.setJti(crypto.randomUUID())
			.sign(secret());

	it('opens nothing when malformed, never a full session; a well-formed one reads its report (positive control)', async () => {
		const owner = await signUp('RsClaim');
		const { projectId, runId } = await withRun(owner, 'Claim');
		const good = `wm_session=${await sign(owner.id, { scope: { p: projectId, r: runId } })}`;
		expect((await as(good, 'GET', '/auth/me')).status).toBe(200);
		expect((await as(good, 'GET', `/projects/${projectId}/runs/${runId}`)).status).toBe(200);
		expect((await as(good, 'GET', '/projects')).status).toBe(403);
		for (const scope of [null, 'everything', {}, { p: projectId }, { r: runId }, { p: projectId, r: 'all' }, { p: '*', r: runId }, { p: [projectId], r: runId }, [projectId, runId]]) {
			const cookie = `wm_session=${await sign(owner.id, { scope })}`;
			for (const path of ['/auth/me', '/projects', `/projects/${projectId}`, `/projects/${projectId}/runs`]) {
				expect((await as(cookie, 'GET', path)).status, `${JSON.stringify(scope)} ${path}`).toBe(401);
			}
		}
	});
});
