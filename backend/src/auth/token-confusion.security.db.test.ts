// Token confusion across credential kinds (docs/security.md § Credentials
// never stand in for each other). The app hands out many credentials, and
// most share one shape (32 random bytes, 43 base64url characters, stored as
// SHA-256, auth/tokens.ts): an email verify and reset token, an invite token,
// a share link's token, a render token and an alert unsubscribe token; beside
// them an API key (`wm_<prefix>_<secret>`), a session cookie and a render
// session cookie (both JWTs). Each is only ever looked up where it was
// stored, for the purpose it was issued. This file proves it as a matrix:
//
//   * every credential, presented in every other kind's slot (the cookie, the
//     Authorization header, the one-click query string, each public route's
//     body), is refused, and the refusal consumes nothing: afterwards each
//     credential still works in its own slot (the positive controls, last);
//   * over the live route inventory, no auth-gated route takes any credential
//     from the Authorization header or the query string, and none takes
//     anything but a session JWT from the cookie (the ingest routes: nothing
//     but an API key from the header);
//   * the backend reads credentials in exactly the places listed below (a
//     source sweep), so a new slot is a deliberate change to this file;
//   * an unsubscribe token is bound to its person, project, kind and farm: it
//     turns off its own subscription and nothing else, the row it names can't
//     be re-keyed to another rule, and it dies with the farm link it relied on.
//
// Needs Postgres (pnpm dev:db:up).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, app, asOwner, lastMailTo, monthly, node, signUp, tokenIn } from '../__tests__/helpers.js';
import { newSubscriptionSecret, unsubscribeToken } from '../alerts/tokens.js';
import { withUser } from '../db/tx.js';
import { issueRenderToken } from '../reports/tokens.js';
import { base32Decode, hotp, totpStep } from './totp.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';
const TEST_ALERTS_SECRET = process.env.ALERTS_TOKEN_SECRET!;

/** Every credential kind the app issues, plus two 43-character fragments that look like our tokens. */
const KINDS = [
	'verify',
	'reset',
	'invite',
	'share',
	'renderToken',
	'unsubscribe',
	'apiKey',
	'session',
	'renderSession',
	// Not credentials, but they pass the token format check (43 base64url
	// characters): the API key's secret without its prefix, and the session
	// JWT's signature. Neither is stored anywhere, so neither opens anything.
	'apiKeySecret',
	'sessionSignature'
] as const;
type Kind = (typeof KINDS)[number];

interface Res {
	status: number;
	setCookie: string | null;
	body: unknown;
}

async function send(path: string, init: RequestInit): Promise<Res> {
	const r = await app.request(path, init);
	const text = await r.text();
	let body: unknown = text;
	try {
		body = text ? JSON.parse(text) : null;
	} catch {
		// a non-JSON body stays text
	}
	return { status: r.status, setCookie: r.headers.get('set-cookie'), body };
}
const post = (path: string, body: unknown) =>
	send(path, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** A cookie header carrying `cred` as the session cookie. */
const asCookie = (cred: string) => `wm_session=${cred}`;
/** The JWT inside a `wm_session=…; Path=/…` Set-Cookie (or cookie) string. */
const jwtOf = (cookie: string) => cookie.split(';')[0]!.replace(/^wm_session=/, '');

let owner: User;
let projectId: string;
let runId: string;
const creds = {} as Record<Kind, string>;
let resetEmail: string;

/**
 * Each slot a credential can be presented in, what counts as accepted there,
 * and the kinds whose own slot it is. `run` presents one credential.
 */
const SLOTS: { name: string; own: Kind[]; run: (cred: string) => Promise<Res>; accepted: (r: Res) => boolean }[] = [
	{
		name: 'cookie: GET /projects/:id/runs/:runId',
		own: ['session', 'renderSession'],
		run: (cred) => send(`/projects/${projectId}/runs/${runId}`, { headers: { cookie: asCookie(cred), origin: ORIGIN } }),
		accepted: (r) => r.status === 200
	},
	{
		name: 'Authorization: Bearer on GET /ingest/v1/whoami',
		own: ['apiKey'],
		run: (cred) => send('/ingest/v1/whoami', { headers: { authorization: `Bearer ${cred}` } }),
		accepted: (r) => r.status === 200
	},
	{
		name: 'body: POST /auth/verify-email',
		own: ['verify'],
		run: (cred) => post('/auth/verify-email', { token: cred }),
		accepted: (r) => r.status === 200
	},
	{
		name: 'body: POST /auth/reset-password',
		own: ['reset'],
		run: (cred) => post('/auth/reset-password', { token: cred, password: 'a brand new password' }),
		accepted: (r) => r.status === 204
	},
	{
		name: 'body: POST /auth/invite-info',
		own: ['invite'],
		run: (cred) => post('/auth/invite-info', { token: cred }),
		accepted: (r) => r.status === 200
	},
	{
		name: 'body: POST /auth/render-session',
		own: ['renderToken'],
		run: (cred) => post('/auth/render-session', { token: cred }),
		accepted: (r) => r.status === 200 && !!r.setCookie?.startsWith('wm_session=')
	},
	{
		name: 'body: POST /share/view',
		own: ['share'],
		run: (cred) => post('/share/view', { token: cred }),
		accepted: (r) => r.status === 200
	},
	{
		name: 'body: POST /share/series',
		own: ['share'],
		run: (cred) => post('/share/series', { token: cred, key: 'natural_flow' }),
		accepted: (r) => r.status === 200
	},
	{
		name: 'body: POST /alerts/unsubscribe (the landing page)',
		own: ['unsubscribe'],
		run: (cred) => post('/alerts/unsubscribe', { token: cred }),
		accepted: (r) => r.status === 200
	},
	{
		name: 'query: POST /alerts/unsubscribe?token= (RFC 8058 one-click)',
		own: ['unsubscribe'],
		run: (cred) =>
			send(`/alerts/unsubscribe?token=${encodeURIComponent(cred)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: 'List-Unsubscribe=One-Click'
			}),
		accepted: (r) => r.status === 204
	}
];

beforeAll(async () => {
	owner = await signUp('TCowner');
	projectId = (await owner.call('POST', '/projects', { name: 'Confusion catchment' })).body.project.id;
	const outlet = node('Outlet', null);
	// Five farms: a share link reads catchment series only with at least five holders (025_share_links.sql).
	const farms = ['Kite', 'Hawk', 'Owl', 'Swift', 'Wren'].map((n) => node(`Farm ${n}`, outlet.id));
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const cropAreas = farms.map((f, i) => ({ nodeId: f.id, cropId: crop.id, areaM2: 100_000 + 20_000 * i }));
	expect((await owner.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, ...farms], crops: [crop], cropAreas, transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	const rain = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'r' });
	expect(run.status).toBe(201);
	runId = run.body.run.id;
	expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId })).status).toBe(201);

	// verify: a fresh, unconfirmed account's emailed link.
	const unverified = await signUp('TCunverified', { verified: false });
	creds.verify = tokenIn(lastMailTo(unverified.email));
	// reset: another account's reset link (its diagonal revokes that account's sessions, not the owner's).
	const resetter = await signUp('TCresetter');
	resetEmail = resetter.email;
	expect((await post('/auth/forgot-password', { email: resetEmail })).status).toBe(202);
	creds.reset = tokenIn(lastMailTo(resetEmail));
	// invite: an address with no account, invited to the project.
	const invitee = `tc-invitee-${crypto.randomUUID()}@example.com`;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: invitee, role: 'viewer' })).status).toBe(201);
	creds.invite = tokenIn(lastMailTo(invitee));
	// share: a link's token (the URL fragment).
	const link = await owner.call('POST', `/projects/${projectId}/share-links`, { label: 'Forum', expiresInDays: 30 });
	expect(link.status).toBe(201);
	creds.share = new URL(link.body.link.url).hash.replace(/^#t=/, '');
	// renderToken, and a second one exchanged for the renderSession.
	creds.renderToken = await withUser(owner.id, (db) => issueRenderToken(db, projectId, runId));
	const exchanged = await post('/auth/render-session', { token: await withUser(owner.id, (db) => issueRenderToken(db, projectId, runId)) });
	expect(exchanged.status).toBe(200);
	creds.renderSession = jwtOf(exchanged.setCookie!);
	// unsubscribe: the owner's data_stale subscription, in the worker's format.
	const { nonce, hash } = newSubscriptionSecret(TEST_ALERTS_SECRET);
	await asOwner(
		`INSERT INTO alert_subscription (user_id, project_id, kind, mode, unsubscribe_nonce, unsubscribe_hash) VALUES ($1, $2, 'data_stale', 'immediate', $3, $4)`,
		[owner.id, projectId, nonce, hash]
	);
	creds.unsubscribe = unsubscribeToken(nonce, TEST_ALERTS_SECRET);
	// apiKey, and its bare secret.
	const key = await owner.call('POST', `/projects/${projectId}/api-keys`, { name: 'Logger' });
	expect(key.status).toBe(201);
	creds.apiKey = key.body.secret;
	creds.apiKeySecret = creds.apiKey.split('_').slice(2).join('_');
	// session, and its bare signature.
	creds.session = jwtOf(owner.cookie);
	creds.sessionSignature = creds.session.split('.')[2]!;

	for (const k of KINDS) expect(creds[k], k).toBeTruthy();
	expect(creds.apiKeySecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(creds.sessionSignature).toMatch(/^[A-Za-z0-9_-]{43}$/);
}, 90_000);

describe('every credential in every other kind’s slot', () => {
	it('covers each kind: every issued credential has an own slot, and every slot an owner', () => {
		const owned = new Set(SLOTS.flatMap((s) => s.own));
		expect(KINDS.filter((k) => !owned.has(k))).toEqual(['apiKeySecret', 'sessionSignature']);
	});

	it('is refused everywhere but its own slot, and the refusals consume nothing (positive control: each then works in its own slot)', async () => {
		const wrong: string[] = [];
		for (const slot of SLOTS) {
			for (const kind of KINDS) {
				if (slot.own.includes(kind)) continue;
				const r = await slot.run(creds[kind]);
				// A refusal is a 4xx that sets no session.
				if (slot.accepted(r) || r.status < 400 || r.status >= 500 || r.setCookie?.startsWith('wm_session=ey')) wrong.push(`${kind} in ${slot.name}: ${r.status}`);
			}
		}
		expect(wrong).toEqual([]);

		// The unsubscribe is still on, the reset user's password unchanged, the
		// verify user unconfirmed: nothing above took effect.
		expect((await asOwner(`SELECT mode FROM alert_subscription WHERE user_id = $1 AND project_id = $2 AND kind = 'data_stale'`, [owner.id, projectId]))[0].mode).toBe('immediate');
		expect((await post('/auth/login', { email: resetEmail, password: 'correct horse' })).status).toBe(200);

		// Positive controls, last: each credential works in each of its own
		// slots, so none was burnt by being presented elsewhere. (A single-use
		// token's first own slot consumes it; the one-click slot gets the
		// same, idempotent unsubscribe token.)
		const missed: string[] = [];
		for (const slot of SLOTS) {
			for (const kind of slot.own) {
				const r = await slot.run(creds[kind]);
				if (!slot.accepted(r)) missed.push(`${kind} in ${slot.name}: ${r.status} ${JSON.stringify(r.body)}`);
			}
		}
		expect(missed).toEqual([]);
		expect((await asOwner(`SELECT mode FROM alert_subscription WHERE user_id = $1 AND project_id = $2 AND kind = 'data_stale'`, [owner.id, projectId]))[0].mode).toBe('off');
		expect((await post('/auth/login', { email: resetEmail, password: 'a brand new password' })).status).toBe(200);
	}, 60_000);

	it('a purpose is fixed in the database too: an email token of one purpose is never consumed as the other', async () => {
		const u = await signUp('TCpurpose', { verified: false });
		const verify = tokenIn(lastMailTo(u.email));
		expect((await post('/auth/forgot-password', { email: u.email })).status).toBe(202);
		const reset = tokenIn(lastMailTo(u.email));
		const { hashToken } = await import('./tokens.js');
		const consume = async (token: string, purpose: string) =>
			(await asOwner('SELECT app_consume_email_token($1, $2::email_token_purpose) AS u', [hashToken(token), purpose]))[0].u as string | null;
		expect(await consume(verify, 'reset')).toBeNull();
		expect(await consume(reset, 'verify')).toBeNull();
		// Positive control: each is consumed as its own purpose, once.
		expect(await consume(verify, 'verify')).toBe(u.id);
		expect(await consume(reset, 'reset')).toBe(u.id);
		expect(await consume(reset, 'reset')).toBeNull();
	});
});

describe('no route takes a credential from anywhere else, over the live route inventory', () => {
	const routes = [
		...new Set(app.routes.filter((r) => r.method !== 'ALL' && r.method !== 'OPTIONS').map((r) => `${r.method} ${r.path}`))
	];
	const url = (path: string) => path.replace(':id', projectId).replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
	const req = (method: string, path: string, headers: Record<string, string>) =>
		app.request(path, {
			method,
			headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
			body: method === 'GET' || method === 'HEAD' ? undefined : '{}'
		});

	it('no path parameter carries a credential', () => {
		const params = routes.flatMap((r) => [...r.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!));
		expect(params.length).toBeGreaterThan(20);
		expect([...new Set(params)].filter((p) => /token|key|secret|session|cookie|auth/i.test(p) && p !== 'keyId')).toEqual([]);
	});

	it('every gated route answers 401 to each credential in the header, the query string and (but for a session) the cookie; positive control: the session and the API key open theirs', async () => {
		// Gated: the routes that refuse an anonymous request (the public token routes are the matrix above).
		const gated: string[] = [];
		for (const r of routes) {
			const [method, path] = r.split(' ') as [string, string];
			if ((await req(method, url(path), {})).status === 401) gated.push(r);
		}
		expect(gated.length).toBeGreaterThan(100);
		expect(gated).toEqual(expect.arrayContaining(['GET /projects/:id', 'GET /ingest/v1/whoami', 'POST /ingest/v1/series/merge']));

		// The account's own writes last (logout everywhere, deleting the account): should
		// one wrongly open, it would end the session and hide every later finding.
		const accountWrite = (r: string) => (/^(POST|PATCH|PUT|DELETE) \/auth\//.test(r) ? 1 : 0);
		gated.sort((x, y) => accountWrite(x) - accountWrite(y));
		const opened: string[] = [];
		for (const r of gated) {
			const [method, path] = r.split(' ') as [string, string];
			const ingest = path.startsWith('/ingest/');
			for (const kind of KINDS) {
				const cred = creds[kind];
				const q = `${url(path)}?token=${encodeURIComponent(cred)}&access_token=${encodeURIComponent(cred)}&key=${encodeURIComponent(cred)}`;
				const tries: [string, string, Record<string, string>][] = [
					['query', q, {}],
					['x-api-key', url(path), { 'x-api-key': cred }]
				];
				if (!(ingest && kind === 'apiKey')) tries.push(['bearer', url(path), { authorization: `Bearer ${cred}` }]);
				if (ingest || (kind !== 'session' && kind !== 'renderSession')) tries.push(['cookie', url(path), { cookie: asCookie(cred) }]);
				for (const [slot, u, headers] of tries) {
					const res = await req(method, u, headers);
					if (res.status !== 401) opened.push(`${r} ${kind} in ${slot}: ${res.status}`);
				}
			}
		}
		expect(opened).toEqual([]);

		// Positive controls: the same sweep's harness does let the right credential in.
		expect((await req('GET', url('/projects/:id'), { cookie: asCookie(creds.session) })).status).toBe(200);
		expect((await req('GET', '/ingest/v1/whoami', { authorization: `Bearer ${creds.apiKey}` })).status).toBe(200);
	}, 120_000);
});

describe('where the backend reads a credential (source sweep)', () => {
	/**
	 * Every place a request's credential is read, and what it is. A new one
	 * (a second cookie, a header, a query token) is a new slot: add it here,
	 * and to the matrix above, on purpose.
	 */
	const READS: Record<string, string[]> = {
		// The session, and two-step sign-in's challenge (issue #282): what a
		// right password buys when the account has an authenticator, good only
		// with a code at POST /auth/mfa/verify (test below).
		'auth/session.ts': ['getCookie(c, MFA_CHALLENGE_COOKIE)', 'getCookie(c, SESSION_COOKIE)'],
		'ingest/auth.ts': ["c.req.header('authorization')"],
		'alerts/routes.ts': ["c.req.query('token')"],
		// Not a user's credential: CloudFront's shared secret on the origin (app.ts).
		'app.ts': ["c.req.header('x-cloudfront-shared-secret')"],
		// Not an access credential: the sign-in lockout's trusted-device mark
		// (070). It only picks which throttle record counts a sign-in attempt;
		// the password is still checked, and it opens nothing (test below).
		'auth/device.ts': ['getCookie(c, DEVICE_COOKIE)'],
		// Not a credential: the viewer's address the CloudFront Function sets,
		// read only after the shared-secret check (edgeVerified), to key the
		// sign-up throttle (079, http/clientAddress.ts). It grants nothing.
		'http/clientAddress.ts': ['c.req.header(VIEWER_ADDRESS_HEADER)']
	};
	const SRC = join(import.meta.dirname, '..');
	const files = (dir: string): string[] =>
		readdirSync(dir).flatMap((f) => {
			const p = join(dir, f);
			if (statSync(p).isDirectory()) return f === '__tests__' ? [] : files(p);
			return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
		});
	// Any cookie read, any header read but content negotiation, any single named query parameter.
	const READ = /getCookie\([^)]*\)|c\.req\.header\((?!'content-type')[^)]*\)|c\.req\.query\('[^']*'\)|c\.req\.queries\([^)]*\)|c\.req\.raw\.headers/g;

	it('finds exactly the listed reads (positive control: it finds the session cookie read)', () => {
		const found: Record<string, string[]> = {};
		for (const f of files(SRC)) {
			const hits = readFileSync(f, 'utf8').match(READ);
			if (hits) found[relative(SRC, f)] = hits;
		}
		expect(found['auth/session.ts']).toContain('getCookie(c, SESSION_COOKIE)');
		expect(found).toEqual(READS);
	});

	it('the trusted-device cookie opens nothing, in its own slot or the session’s (positive control: the session it came with does)', async () => {
		const u = await signUp('TCdevice');
		const r = await post('/auth/login', { email: u.email, password: 'correct horse' });
		expect(r.status).toBe(200);
		const pairs = (r.setCookie ?? '').split(/,(?=\s*wm_)/).map((c) => c.trim().split(';')[0]!);
		const device = pairs.find((p) => p.startsWith('wm_device='));
		const session = pairs.find((p) => p.startsWith('wm_session='));
		expect(device, r.setCookie ?? '').toBeTruthy();
		expect((await anon('GET', '/auth/me', undefined, session)).status).toBe(200);
		const value = device!.slice('wm_device='.length);
		for (const cookie of [device!, asCookie(value), `${device}; ${asCookie(value)}`]) {
			expect((await anon('GET', '/auth/me', undefined, cookie)).status, cookie).toBe(401);
			expect((await anon('GET', '/projects', undefined, cookie)).status, cookie).toBe(401);
		}
		const bearer = await send('/ingest/v1/whoami', { headers: { authorization: `Bearer ${value}` } });
		expect(bearer.status).toBe(401);
	});

	it('the two-step sign-in challenge opens nothing but the code step (positive control: there, with a code, it does)', async () => {
		const u = await signUp('TCchallenge');
		const { secret } = (await u.call('POST', '/auth/mfa/totp/enrol', { password: 'correct horse' })).body;
		const key = base32Decode(secret)!;
		// Confirmed with the current step's code; the sign-in below uses the next step's (within the window, never a replay).
		expect((await u.call('POST', '/auth/mfa/totp/confirm', { code: hotp(key, totpStep(Date.now())) })).status).toBe(200);
		const r = await post('/auth/login', { email: u.email, password: 'correct horse' });
		expect(r.body).toEqual({ mfaRequired: true });
		const challenge = (r.setCookie ?? '').split(/,(?=\s*wm_)/).map((c) => c.trim().split(';')[0]!).find((p) => p.startsWith('wm_mfa='))!;
		expect(challenge, r.setCookie ?? '').toBeTruthy();
		const value = challenge.slice('wm_mfa='.length);
		for (const cookie of [challenge, asCookie(value)]) {
			expect((await anon('GET', '/auth/me', undefined, cookie)).status, cookie).toBe(401);
			expect((await anon('GET', '/projects', undefined, cookie)).status, cookie).toBe(401);
		}
		expect((await send('/ingest/v1/whoami', { headers: { authorization: `Bearer ${value}` } })).status).toBe(401);
		expect((await anon('POST', '/auth/mfa/verify', { code: hotp(key, totpStep(Date.now()) + 1) }, challenge)).status).toBe(200);
	});
});

describe('an unsubscribe token is bound to its person, project, kind and farm', () => {
	let a: User;
	let b: User;
	let farmer: User;
	let p1: string;
	let p2: string;
	const one = node('Farm One', null);
	const two = node('Farm Two', null);
	const three = node('Farm Three', null);
	const subs: { label: string; user: () => string; project: () => string; kind: string; node: string | null; token?: string; id?: string }[] = [
		{ label: 'A P1 data_stale', user: () => a.id, project: () => p1, kind: 'data_stale', node: null },
		{ label: 'A P1 job_dead', user: () => a.id, project: () => p1, kind: 'job_dead', node: null },
		{ label: 'A P1 all (digest)', user: () => a.id, project: () => p1, kind: 'all', node: null },
		{ label: 'A P2 data_stale', user: () => a.id, project: () => p2, kind: 'data_stale', node: null },
		{ label: 'B P1 data_stale', user: () => b.id, project: () => p1, kind: 'data_stale', node: null },
		{ label: 'farmer P1 dam_below Farm One', user: () => farmer.id, project: () => p1, kind: 'dam_below', node: one.id },
		{ label: 'farmer P1 dam_below Farm Two', user: () => farmer.id, project: () => p1, kind: 'dam_below', node: two.id }
	];
	const modes = async () => {
		const rows = await asOwner('SELECT id, mode FROM alert_subscription WHERE id = ANY($1)', [subs.map((s) => s.id)]);
		return Object.fromEntries(subs.map((s) => [s.label, rows.find((r) => r.id === s.id)!.mode as string]));
	};

	beforeAll(async () => {
		[a, b, farmer] = (await Promise.all(['TCa', 'TCb', 'TCfarmer'].map((n) => signUp(n)))) as [User, User, User];
		p1 = (await a.call('POST', '/projects', { name: 'Bound one' })).body.project.id;
		p2 = (await a.call('POST', '/projects', { name: 'Bound two' })).body.project.id;
		const outlet = node('Outlet', null);
		const farms = [one, two, three].map((f) => ({ ...f, downstreamNodeId: outlet.id, kind: 'farm' }));
		const crop = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(0.9) };
		const model = { nodes: [outlet, ...farms], crops: [crop], cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 100_000 })), transfers: [] };
		expect((await a.call('PUT', `/projects/${p1}/model`, model)).status).toBe(200);
		expect((await a.call('POST', `/projects/${p1}/members`, { email: b.email, role: 'viewer' })).status).toBe(201);
		expect((await a.call('POST', `/projects/${p1}/farmers`, { email: farmer.email, nodeIds: [one.id, two.id] })).status).toBe(201);
		for (const s of subs) {
			const { nonce, hash } = newSubscriptionSecret(TEST_ALERTS_SECRET);
			const [row] = await asOwner(
				`INSERT INTO alert_subscription (user_id, project_id, kind, node_id, mode, unsubscribe_nonce, unsubscribe_hash)
				 VALUES ($1, $2, $3, $4, 'immediate', $5, $6) RETURNING id`,
				[s.user(), s.project(), s.kind, s.node, nonce, hash]
			);
			s.id = row.id;
			s.token = unsubscribeToken(nonce, TEST_ALERTS_SECRET);
		}
	}, 60_000);

	it('dies with the farm link it relied on (positive control: the farm still linked unsubscribes)', async () => {
		const two$ = subs.find((s) => s.node === two.id)!;
		const one$ = subs.find((s) => s.node === one.id)!;
		expect((await a.call('PUT', `/projects/${p1}/farmers/${farmer.id}`, { nodeIds: [one.id] })).status).toBe(200);
		expect((await post('/alerts/unsubscribe', { token: two$.token })).status).toBe(404);
		expect((await modes())[two$.label]).toBe('immediate');
		expect((await post('/alerts/unsubscribe', { token: one$.token })).status).toBe(200);
		expect((await modes())[one$.label]).toBe('off');
	});

	it('turns off its own subscription and no other, however often it is replayed', async () => {
		const expected = await modes();
		for (const s of subs.filter((x) => x.kind !== 'dam_below')) {
			const res = await post('/alerts/unsubscribe', { token: s.token });
			expect(res.status, s.label).toBe(200);
			expected[s.label] = 'off';
			// Replayed, and replayed through the one-click slot: still only its own row.
			expect((await post('/alerts/unsubscribe', { token: s.token })).status).toBe(200);
			expect(
				(await send(`/alerts/unsubscribe?token=${s.token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' })).status
			).toBe(204);
			expect(await modes(), `after ${s.label}`).toEqual(expected);
		}
		// Every non-farm row is off now, and the unlinked farm's is still on.
		expect(Object.values(expected).filter((m) => m === 'immediate')).toHaveLength(1);
	});

	it('names a row that can never be re-keyed to another person, project, kind or farm (positive control: its mode can change)', async () => {
		const rowOf = (label: string) => subs.find((s) => s.label === label)!;
		const asUser = (u: string, sql: string, params: unknown[]) => withUser(u, (db) => db.query(sql, params));
		const jobDead = rowOf('A P1 job_dead');
		const farm = rowOf('farmer P1 dam_below Farm One');
		await expect(asUser(a.id, `UPDATE alert_subscription SET kind = 'feed_failing' WHERE id = $1`, [jobDead.id])).rejects.toMatchObject({ code: '23514' });
		await expect(asUser(a.id, 'UPDATE alert_subscription SET project_id = $2 WHERE id = $1', [jobDead.id, p2])).rejects.toMatchObject({ code: '23514' });
		await expect(asUser(farmer.id, 'UPDATE alert_subscription SET node_id = $2 WHERE id = $1', [farm.id, three.id])).rejects.toMatchObject({ code: '23514' });
		// Even the schema owner can't move one (the trigger, not only RLS).
		await expect(asOwner('UPDATE alert_subscription SET user_id = $2 WHERE id = $1', [jobDead.id, b.id])).rejects.toMatchObject({ code: '23514' });
		const moved = await asOwner('SELECT user_id, project_id, kind FROM alert_subscription WHERE id = $1', [jobDead.id]);
		expect(moved[0]).toEqual({ user_id: a.id, project_id: p1, kind: 'job_dead' });
		// Positive control: the person's own choice still changes.
		const done = await asUser(a.id, `UPDATE alert_subscription SET mode = 'daily_digest' WHERE id = $1`, [jobDead.id]);
		expect(done.rowCount).toBe(1);
	});
});
