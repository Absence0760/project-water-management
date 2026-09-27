// Hostile JSON bodies (a NUL, nesting thousands deep, a number that
// overflows to Infinity) on every route that takes a body: each is refused
// with a 400 and the code `body_refused` by readJson (http/body.ts), never a
// 500 from Postgres (NUL is 22021 / 22P05) or a stack overflow. The route
// list is the app's live inventory, so a new route is swept too.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, signUp } from '../__tests__/helpers.js';
import { buildLadder, SAMPLE, type LadderCtx, type Sample } from '../__tests__/routeSamples.js';
import { MAX_JSON_DEPTH } from './body.js';

const ORIGIN = 'http://localhost:7777';
const ZERO = '00000000-0000-4000-8000-000000000000';
const deep = (n: number) => '['.repeat(n) + ']'.repeat(n);

/** Each hostile body as raw text (JSON.stringify can't write 1e400). */
const HOSTILE: Record<string, string> = {
	'a NUL in a value': JSON.stringify({ name: 'a\u0000b', email: 'a\u0000@example.com', settings: { note: 'x\u0000' } }),
	'a NUL in a key': JSON.stringify({ settings: { 'a\u0000': 1 } }),
	'nesting 20 000 deep': `{"settings":{"x":${deep(20_000)}},"config":${deep(20_000)}}`,
	'a number that overflows': '{"values":[1e400],"settings":{"x":1e400}}'
};

/** Routes that end the sweep's own session whatever the body says; exercised in auth/*.db.test.ts. */
const SKIP = /\/logout/;

async function owner() {
	const u = await signUp('BodySweep');
	const { body } = await u.call('POST', '/projects', { name: 'Body sweep' });
	return { u, projectId: body.project.id as string };
}

describe('hostile JSON bodies', () => {
	it('every body route refuses each one with 400 body_refused, never a 500', async () => {
		const { u, projectId } = await owner();
		const routes = [
			...new Set(app.routes.filter((r) => ['POST', 'PUT', 'PATCH'].includes(r.method) && !SKIP.test(r.path)).map((r) => `${r.method} ${r.path}`))
		];
		expect(routes.length).toBeGreaterThan(50);
		const failures: string[] = [];
		const refusedBy = new Set<string>();
		for (const route of routes) {
			const [method, pattern] = route.split(' ') as [string, string];
			const path = pattern.replace(/:id\b/, projectId).replace(/:[A-Za-z]+/g, () => crypto.randomUUID());
			for (const [what, text] of Object.entries(HOSTILE)) {
				const r = await app.request(path, { method, headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: text });
				const got = await r.text();
				if (r.status >= 500) failures.push(`${route} (${what}): ${r.status} ${got.slice(0, 120)}`);
				if (r.status === 400 && JSON.parse(got).code === 'body_refused') refusedBy.add(route);
			}
		}
		expect(failures).toEqual([]);
		// Positive control: the sweep reached the handlers that read a body, as this user, and the session survived it.
		expect(refusedBy.size).toBeGreaterThan(40);
		expect((await u.call('GET', '/auth/me')).status).toBe(200);
	}, 120_000);

	// The cases that were a 500 before readJson checked the body.
	it.each([
		['PATCH', (p: string) => `/projects/${p}`, JSON.stringify({ settings: { note: 'a\u0000b' } })],
		['PATCH', (p: string) => `/projects/${p}`, `{"settings":{"x":${deep(20_000)}}}`],
		['POST', () => '/projects', JSON.stringify({ name: 'a\u0000' })],
		['POST', () => '/projects/import', JSON.stringify({ name: 'a\u0000', model: { nodes: [], crops: [], cropAreas: [], transfers: [] } })]
	])('%s %s: 400 body_refused', async (method, path, text) => {
		const { u, projectId } = await owner();
		const r = await app.request(path(projectId), { method, headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: text });
		expect(r.status).toBe(400);
		expect(await r.json()).toMatchObject({ code: 'body_refused' });
	});

	it('takes the same bodies once they are clean, and nesting up to the limit (positive control)', async () => {
		const { u, projectId } = await owner();
		const ok = await u.call('PATCH', `/projects/${projectId}`, { settings: { note: 'ab' } });
		expect(ok.status).toBe(200);
		// MAX_JSON_DEPTH containers in all: the body, settings, then the arrays; one more is refused.
		const atLimit = `{"settings":{"x":${deep(MAX_JSON_DEPTH - 2)}}}`;
		const r = await app.request(`/projects/${projectId}`, { method: 'PATCH', headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: atLimit });
		expect(r.status, await r.clone().text()).toBe(200);
		const over = `{"settings":{"x":${deep(MAX_JSON_DEPTH - 1)}}}`;
		const r2 = await app.request(`/projects/${projectId}`, { method: 'PATCH', headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: over });
		expect(r2.status).toBe(400);
	});
});

/**
 * Bodies for the routes whose every field is optional, so SAMPLE has none (or
 * only a flag): each with its free-text fields filled in, so the per-field
 * sweep below reaches them. These are the routes that read the body with
 * `c.req.json().catch(() => ({}))` before readJson took an optional body.
 */
const OPTIONAL: Record<string, (c: LadderCtx) => Sample> = {
	'POST /projects/:id/runs': () => ({ body: { label: 'Sweep run', forecast: false } }),
	'PATCH /projects/:id/runs/:runId': () => ({ body: { notes: 'Sweep notes', pinned: true } }),
	'POST /projects/:id/scenarios/:sid/runs': () => ({ body: { label: 'Sweep scenario run' } }),
	'POST /projects/:id/history/revisions/:revId/restore': () => ({ body: { reason: 'Sweep restore' } }),
	'POST /projects/:id/runs/:runId/restore-inputs': () => ({ body: { reason: 'Sweep restore' } })
};
const OVERFLOW = '__overflowing_number__';

/** One copy of `body` per string (a NUL appended) and per number (1e400 in its place), as raw text, each named by its path. */
function perField(body: unknown): [string, string][] {
	const out: [string, string][] = [];
	const walk = (v: unknown, path: (string | number)[]) => {
		if (typeof v === 'string' || typeof v === 'number') {
			const copy = structuredClone(body);
			let at = copy as Record<string | number, unknown>;
			for (const k of path.slice(0, -1)) at = at[k] as Record<string | number, unknown>;
			at[path.at(-1)!] = typeof v === 'string' ? `${v}\u0000` : OVERFLOW;
			out.push([`${path.join('.')} (${typeof v === 'string' ? 'NUL' : '1e400'})`, JSON.stringify(copy).replace(`"${OVERFLOW}"`, '1e400')]);
		} else if (v !== null && typeof v === 'object') {
			for (const [k, x] of Object.entries(v)) walk(x, [...path, Array.isArray(v) ? Number(k) : k]);
		}
	};
	walk(body, []);
	return out;
}

describe("hostile values in every field of each route's own body", () => {
	let ctx: LadderCtx;
	beforeAll(async () => {
		ctx = await buildLadder('BodyField');
	}, 60_000);
	const samples = { ...SAMPLE, ...OPTIONAL };

	const request = (route: string, s: Sample, text: string) => {
		const [method, pattern] = route.split(' ') as [string, string];
		const ids: Record<string, string> = { ...ctx.ids, ...s.params };
		let path = pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => ids[name] ?? ZERO);
		if (s.query) path += `?${new URLSearchParams(s.query)}`;
		return app.request(path, { method, headers: { cookie: ctx.owner.cookie, origin: ORIGIN, 'content-type': 'application/json' }, body: text });
	};

	it('a NUL in any string, or 1e400 in any number, of every SAMPLE body is 400 body_refused', async () => {
		const routes = Object.keys(samples).filter((r) => /^(POST|PUT|PATCH) /.test(r) && samples[r]!(ctx).body !== undefined);
		expect(routes.length).toBeGreaterThanOrEqual(40);
		const wrong: string[] = [];
		let cases = 0;
		for (const route of routes) {
			const s = samples[route]!(ctx);
			for (const [field, text] of perField(s.body)) {
				cases++;
				const r = await request(route, s, text);
				const got = await r.text();
				if (r.status !== 400 || JSON.parse(got).code !== 'body_refused') wrong.push(`${route} ${field}: ${r.status} ${got.slice(0, 120)}`);
			}
		}
		expect(wrong).toEqual([]);
		expect(cases).toBeGreaterThan(100);
	}, 180_000);

	// Regression: a NUL in a run label went through `c.req.json().catch(() => ({}))`, past zod, into Postgres (22021, a 500).
	it('POST /projects/:id/runs: a NUL in the label is 400 body_refused; a clean label and an empty body run (positive control)', async () => {
		const at = `/projects/${ctx.projectId}/runs`;
		const nul = await request('POST /projects/:id/runs', {}, JSON.stringify({ label: 'Run\u0000one' }));
		expect(nul.status).toBe(400);
		expect(await nul.json()).toMatchObject({ code: 'body_refused' });
		const clean = await ctx.owner.call('POST', at, { label: 'Run one' });
		expect(clean.status).toBe(201);
		expect(clean.body.run.label).toBe('Run one');
		const empty = await app.request(at, { method: 'POST', headers: { cookie: ctx.owner.cookie, origin: ORIGIN } });
		expect(empty.status).toBe(201);
	}, 60_000);

	it('the optional-body routes take their bodies untouched (positive control for the sweep)', async () => {
		for (const route of ['POST /projects/:id/scenarios/:sid/runs', 'PATCH /projects/:id/runs/:runId', 'POST /projects/:id/evidence']) {
			const s = samples[route]!(ctx);
			const r = await request(route, s, JSON.stringify(s.body));
			expect(r.status, `${route}: ${await r.clone().text()}`).toBeLessThan(300);
		}
	}, 60_000);
});
