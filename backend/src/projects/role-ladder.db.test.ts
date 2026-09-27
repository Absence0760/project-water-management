// The role ladder inside one project (docs/security.md § Authorization),
// swept from the live route list rather than written route by route.
//
// Every /projects/:id route (and /me/alerts/:projectId) is called with a body
// and query that pass its validation, so a route that parses before it checks
// the role can't answer 400 and hide a missing check. requireRole is wrapped
// (behaviour unchanged) to record which role each request asked for and
// whether it passed; that gives each route's minimum role from the code
// itself, and the test pins it:
//
//   - a write needs editor or above, unless it is in LOWER_ROLE_WRITES with
//     the reason and the status a viewer gets;
//   - the owner-only routes are exactly OWNER_ONLY, and the reads above viewer
//     exactly EDITOR_READS, each with its reason;
//   - viewer, contributor and farmer get 403 from every route above them, and
//     none of the owner's data changes; an editor gets 403 from every
//     owner-only route.
//
// Positive controls (CLAUDE.md rule 5): the editor passes the role check of
// every route that needs editor or less, and the owner of every owner-only
// route. A new route is swept the day it lands; one whose body fails
// validation fails the "reaches its role check" test until it gets a SAMPLE
// (__tests__/routeSamples.ts, shared with http/mass-assignment.security.db.test.ts).
// farms.db.test.ts and scenarios/applications.db.test.ts keep the farmer's and
// the contributor's allowed routes; isolation.db.test.ts covers non-members.
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Check = { min: string; ok: boolean };
const checks: Check[] = [];
vi.mock('./access.js', async (orig) => {
	const real = await orig<typeof import('./access.js')>();
	return {
		...real,
		requireRole: async (...args: Parameters<typeof real.requireRole>) => {
			try {
				const role = await real.requireRole(...args);
				checks.push({ min: args[2], ok: true });
				return role;
			} catch (err) {
				checks.push({ min: args[2], ok: false });
				throw err;
			}
		}
	};
});
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { buildLadder, SAMPLE, type LadderCtx, type User } from '../__tests__/routeSamples.js';
import { rank, type Role } from './access.js';

const ORIGIN = 'http://localhost:7777';
const ZERO = '00000000-0000-4000-8000-000000000000';

/**
 * Writes a role below editor may call, why, and what the sweep's viewer gets
 * (the viewer acts on the owner's rows: the owner's note, team scenario and
 * yield job, and the owner as the member to remove).
 */
const LOWER_ROLE_WRITES = new Map<string, { why: string; viewer: number }>([
	['POST /projects/:id/copy', { why: 'copies what a viewer can read into a new project of their own; the original is untouched', viewer: 201 }],
	['DELETE /projects/:id/members/:userId', { why: 'anyone may leave (a farmer included); only an owner removes someone else (inline check)', viewer: 403 }],
	['POST /projects/:id/reports', { why: 'a viewer renders a PDF of a run they can read, emailed to themselves only; other recipients need an editor', viewer: 202 }],
	['POST /projects/:id/yield/:jobId/cancel', { why: 'cancels only a yield job the caller queued, or any as an editor (app_cancel_job); a viewer queues none', viewer: 404 }],
	['PUT /me/alerts/:projectId', { why: "the caller's own alert preferences, limited to the kinds their role gets", viewer: 200 }],
	['POST /projects/:id/notes', { why: 'notes (WP-2.7): min farmer, RLS and the route scope what each role writes', viewer: 201 }],
	['PATCH /projects/:id/notes/:noteId', { why: "only the author edits a note's body (note_guard)", viewer: 403 }],
	['DELETE /projects/:id/notes/:noteId', { why: 'the author, or an editor, deletes a note', viewer: 403 }],
	// Scenarios (WP-3.3): min contributor so an applicant can work on their
	// application; a team scenario needs an editor, checked in the route
	// (assertCanChange, the viewer checks in POST and …/runs).
	['POST /projects/:id/scenarios', { why: 'a contributor makes an application; a viewer makes nothing', viewer: 403 }],
	['PATCH /projects/:id/scenarios/:sid', { why: 'an application by its applicant, a team scenario by an editor', viewer: 403 }],
	['DELETE /projects/:id/scenarios/:sid', { why: 'an application by its applicant, a team scenario by an editor', viewer: 403 }],
	['POST /projects/:id/scenarios/:sid/runs', { why: "an application by its readers (not a viewer), a team scenario by an editor", viewer: 403 }],
	['POST /projects/:id/scenarios/:sid/rebase', { why: 'an application by its applicant, a team scenario by an editor', viewer: 403 }],
	['POST /projects/:id/scenarios/:sid/submit', { why: 'an application by its applicant, a team scenario by an editor', viewer: 403 }],
	['POST /projects/:id/scenarios/:sid/withdraw', { why: 'an application by its applicant, a team scenario by an editor', viewer: 403 }],
	['POST /projects/:id/scenarios/:sid/reopen', { why: 'an application by its applicant, a team scenario by an editor', viewer: 403 }],
	['POST /projects/:id/scenarios/:sid/members', { why: 'an applicant shares their own application; a team scenario has nothing to share', viewer: 409 }],
	['DELETE /projects/:id/scenarios/:sid/members/:userId', { why: 'an applicant unshares their own application; only they remove someone else', viewer: 403 }]
]);

/** Routes only an owner may call, and why. */
const OWNER_ONLY = new Map<string, string>([
	['DELETE /projects/:id', 'deleting the project (and everyone’s access to it) is the owner’s call'],
	['POST /projects/:id/members', 'who joins, and with what role'],
	['PATCH /projects/:id/members/:userId', 'changing a role could otherwise promote oneself'],
	['GET /projects/:id/invites', 'pending invites name addresses that have no account yet'],
	['DELETE /projects/:id/invites/:inviteId', 'revoking an invite is part of who joins'],
	['POST /projects/:id/farmers', 'a farmer’s link decides which farm figures they see'],
	['POST /projects/:id/farmers/bulk', 'a farmer’s link decides which farm figures they see'],
	['PUT /projects/:id/farmers/:userId', 'a farmer’s link decides which farm figures they see'],
	['POST /projects/:id/feeds', 'a feed writes into the project’s series on a schedule, unattended'],
	['PATCH /projects/:id/feeds/:feedId', 'a feed writes into the project’s series on a schedule, unattended'],
	['DELETE /projects/:id/feeds/:feedId', 'a feed writes into the project’s series on a schedule, unattended'],
	['GET /projects/:id/share-links', 'a share link gives anyone holding it the catchment page'],
	['POST /projects/:id/share-links', 'a share link gives anyone holding it the catchment page'],
	['DELETE /projects/:id/share-links/:linkId', 'a share link gives anyone holding it the catchment page'],
	['GET /projects/:id/api-keys', 'an API key writes series without a person signed in'],
	['POST /projects/:id/api-keys', 'an API key writes series without a person signed in'],
	['DELETE /projects/:id/api-keys/:keyId', 'an API key writes series without a person signed in']
]);

/** Reads that need editor, and why. */
const EDITOR_READS = new Map<string, string>([
	['GET /projects/:id/applications', 'the assessors’ queue of submitted applications (WP-3.3)'],
	['GET /projects/:id/alert-rules', 'the alert thresholds editors set; viewers get the alerts, not the rules']
]);

type Ctx = LadderCtx;
const ctx = {} as Ctx;

const routes = [
	...new Set(
		app.routes
			.filter((r) => r.method !== 'ALL' && r.method !== 'OPTIONS' && (r.path === '/projects/:id' || r.path.startsWith('/projects/:id/') || r.path === '/me/alerts/:projectId'))
			.map((r) => `${r.method} ${r.path}`)
	)
];
const isWrite = (route: string) => !route.startsWith('GET ');

/** One request as `u`, with the route's sample, and the role checks it made. */
async function probe(u: User, route: string) {
	const [method, pattern] = route.split(' ') as [string, string];
	const s = SAMPLE[route]?.(ctx) ?? {};
	const ids = { ...ctx.ids, ...s.params };
	let path = pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => ids[name] ?? ZERO);
	if (s.query) path += `?${new URLSearchParams(s.query)}`;
	const body = method === 'GET' || method === 'DELETE' ? undefined : (s.body ?? {});
	checks.length = 0;
	const r = await app.request(path, {
		method,
		headers: { cookie: u.cookie, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	return { status: r.status, text: await r.text(), checks: [...checks] };
}

/** The highest role a request asked for (the one it stopped at, for someone below it). */
const asked = (cs: Check[]): Role => cs.map((c) => c.min as Role).reduce((a, b) => (rank[b] > rank[a] ? b : a));

/** What the owner sees of everything an editor's or owner's write would change. */
async function snapshot() {
	const get = async (path: string) => {
		const r = await ctx.owner.call('GET', `/projects/${ctx.projectId}${path}`);
		expect(r.status, path).toBe(200);
		return r.body;
	};
	return {
		project: (await get('')).project,
		model: await get('/model'),
		members: await get('/members'),
		series: await get('/series'),
		runs: (await get('/runs')).runs.map((r: { id: string; label: string; pinned: boolean }) => [r.id, r.label, r.pinned]),
		evidence: await get('/evidence'),
		scenarios: await get('/scenarios'),
		publication: await get('/publication'),
		farmers: await get('/farmers'),
		invites: await get('/invites'),
		feeds: await get('/feeds'),
		schedules: await get('/report-schedules'),
		allocations: await get('/allocations'),
		shareLinks: await get('/share-links'),
		keys: await get('/api-keys'),
		alertRules: await get('/alert-rules'),
		sweeps: await get('/sweeps'),
		outlooks: await get('/outlooks')
	};
}

const minRole = new Map<string, Role>();
const viewerStatus = new Map<string, number>();
let before: Awaited<ReturnType<typeof snapshot>>;

beforeAll(async () => {
	Object.assign(ctx, await buildLadder('L'));
	before = await snapshot();

	// The inventory: every route as the viewer, recording the role it asks for.
	for (const route of routes) {
		const r = await probe(ctx.viewer, route);
		viewerStatus.set(route, r.status);
		if (r.checks.length) minRole.set(route, asked(r.checks));
	}
}, 120_000);

describe('the role ladder inventory', () => {
	it('sweeps every project route (not vacuous)', () => {
		expect(routes.length).toBeGreaterThan(100);
		expect(routes.filter(isWrite).length).toBeGreaterThan(60);
	});

	it('reaches the role check of every route (a route whose validation refuses an empty request needs a SAMPLE)', () => {
		expect(routes.filter((r) => !minRole.has(r)).map((r) => `${r} → ${viewerStatus.get(r)}`)).toEqual([]);
	});

	it('lists no route that no longer exists', () => {
		for (const r of [...LOWER_ROLE_WRITES.keys(), ...OWNER_ONLY.keys(), ...EDITOR_READS.keys(), ...Object.keys(SAMPLE)]) expect(routes, r).toContain(r);
	});

	it('needs editor for every write but the listed lower-role ones', () => {
		const lower = routes.filter((r) => isWrite(r) && minRole.has(r) && rank[minRole.get(r)!] < rank.editor);
		expect(lower.sort()).toEqual([...LOWER_ROLE_WRITES.keys()].sort());
	});

	it('needs owner for exactly the listed owner-only routes', () => {
		expect(routes.filter((r) => minRole.get(r) === 'owner').sort()).toEqual([...OWNER_ONLY.keys()].sort());
	});

	it('needs editor for exactly the listed editor reads', () => {
		expect(routes.filter((r) => !isWrite(r) && minRole.get(r) === 'editor').sort()).toEqual([...EDITOR_READS.keys()].sort());
	});

	it('gives every allowlist entry a reason', () => {
		for (const [r, e] of LOWER_ROLE_WRITES) expect(e.why.length, r).toBeGreaterThan(20);
		for (const [r, why] of [...OWNER_ONLY, ...EDITOR_READS]) expect(why.length, r).toBeGreaterThan(20);
	});
});

describe('lower roles are refused what is above them', () => {
	it('answers the viewer 403 on every route that needs editor or owner', () => {
		const above = routes.filter((r) => rank[minRole.get(r)!] > rank.viewer);
		expect(above.length).toBeGreaterThan(50);
		expect(above.filter((r) => viewerStatus.get(r) !== 403).map((r) => `${r} → ${viewerStatus.get(r)}`)).toEqual([]);
	});

	it('answers the viewer what each lower-role write says (the route’s own rules refuse the rest)', () => {
		const got = [...LOWER_ROLE_WRITES].map(([r]) => [r, viewerStatus.get(r)]);
		expect(got).toEqual([...LOWER_ROLE_WRITES].map(([r, e]) => [r, e.viewer]));
	});

	it.each(['contributor', 'farmer'] as const)('answers a %s 403 on every route that needs viewer or above', async (who) => {
		const refused: string[] = [];
		for (const route of routes.filter((r) => rank[minRole.get(r)!] >= rank.viewer)) {
			const r = await probe(ctx[who], route);
			if (r.status !== 403 || !r.checks.some((c) => !c.ok)) refused.push(`${route} → ${r.status}`);
		}
		expect(refused).toEqual([]);
	});

	it('left everything an editor or owner write changes as it was', async () => {
		expect(await snapshot()).toEqual(before);
	});

	it('refuses a viewer emailing a report to another member (to themselves is allowed, above)', async () => {
		const r = await ctx.viewer.call('POST', `/projects/${ctx.projectId}/reports`, { email: [ctx.owner.id] });
		expect(r.status).toBe(403);
	});

	it('left the owner’s yield job alone when the viewer tried to cancel it', async () => {
		const [job] = await asOwner('SELECT status, cancel_requested_at FROM job WHERE id = $1', [ctx.ids.jobId]);
		expect(job!.cancel_requested_at).toBeNull();
		expect(job!.status).not.toBe('dead');
	});

	it('lets a viewer leave the project (the self case of DELETE …/members/:userId)', async () => {
		const leaver = await signUp('Lleaver');
		expect((await ctx.owner.call('POST', `/projects/${ctx.projectId}/members`, { email: leaver.email, role: 'viewer' })).status).toBe(201);
		expect((await leaver.call('DELETE', `/projects/${ctx.projectId}/members/${leaver.id}`)).status).toBe(204);
		expect((await leaver.call('GET', `/projects/${ctx.projectId}`)).status).toBe(404);
	});
});

describe('an editor is refused the owner-only routes', () => {
	it('answers the editor 403 on every owner-only route, at the owner check', async () => {
		const wrong: string[] = [];
		for (const route of OWNER_ONLY.keys()) {
			const r = await probe(ctx.editor, route);
			const failed = r.checks.find((c) => !c.ok);
			if (r.status !== 403 || failed?.min !== 'owner') wrong.push(`${route} → ${r.status}`);
		}
		expect(wrong).toEqual([]);
	});

	it('refuses an editor removing another member, and leaves them a member', async () => {
		const r = await ctx.editor.call('DELETE', `/projects/${ctx.projectId}/members/${ctx.viewer.id}`);
		expect(r).toEqual({ status: 403, body: { error: 'requires owner role' } });
		expect((await ctx.viewer.call('GET', `/projects/${ctx.projectId}`)).status).toBe(200);
	});

	it('left the owner-only state as it was', async () => {
		const now = await snapshot();
		for (const k of ['members', 'invites', 'farmers', 'feeds', 'shareLinks', 'keys'] as const) expect(now[k], k).toEqual(before[k]);
		expect(now.project).toEqual(before.project);
	});

	it('positive control: the editor passes the role check of every route that needs editor or less', async () => {
		const refused: string[] = [];
		for (const route of routes.filter((r) => minRole.has(r) && rank[minRole.get(r)!] <= rank.editor)) {
			const r = await probe(ctx.editor, route);
			if (!r.checks.length || r.checks.some((c) => !c.ok)) refused.push(`${route} → ${r.status}`);
		}
		expect(refused).toEqual([]);
	});
});

describe('positive control: the owner', () => {
	// Last, since it runs the owner-only writes for real (DELETE /projects/:id last of all).
	it('passes the role check of every owner-only route', async () => {
		const refused: string[] = [];
		const order = [...OWNER_ONLY.keys()].sort((x, y) => Number(x === 'DELETE /projects/:id') - Number(y === 'DELETE /projects/:id'));
		for (const route of order) {
			const r = await probe(ctx.owner, route);
			if (!r.checks.length || r.checks.some((c) => !c.ok) || r.status === 403) refused.push(`${route} → ${r.status}`);
		}
		expect(refused).toEqual([]);
	});
});
