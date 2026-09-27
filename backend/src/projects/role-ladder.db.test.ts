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
//   - the routes below viewer (the farmer's and the contributor's) are
//     exactly BELOW_VIEWER, each with the lowest role it admits and its
//     reason;
//   - viewer, contributor and farmer get 403 from every route above them, and
//     none of the owner's data changes; a farmer gets 403 from every
//     contributor route; an editor gets 403 from every owner-only route;
//   - a farmer or contributor asking an allowed route for an id that isn't
//     there gets 404, never data.
//
// Positive controls (CLAUDE.md rule 5): the farmer passes the role check of
// every farmer route, the contributor of every farmer and contributor route,
// the editor of every route that needs editor or less, and the owner of every
// owner-only route. A new route is swept the day it lands; one whose body
// fails validation fails the "reaches its role check" test until it gets a
// SAMPLE. What RLS lets a farmer read through the allowed routes is
// farms/farmer-privacy.security.db.test.ts, a contributor
// scenarios/applications.db.test.ts; isolation.db.test.ts covers non-members.
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
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { rank, type Role } from './access.js';

type User = Awaited<ReturnType<typeof signUp>>;
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

/**
 * The routes a farmer or contributor may call (both rank below viewer, so
 * every other route refuses them: fail closed), the lowest role each admits,
 * and why. RLS and the route's own rules decide what they reach there: the
 * farm view publish/publication.db.test.ts, notes notes/notes.db.test.ts,
 * alert events alerts/alerts.db.test.ts, applications
 * scenarios/applications.db.test.ts and contributor-tables.db.test.ts.
 */
const BELOW_VIEWER = new Map<string, { min: 'farmer' | 'contributor'; why: string }>([
	// Farmer and above (WP-2.1, WP-2.3, WP-2.6).
	['GET /projects/:id/publication', { min: 'farmer', why: 'the published baseline; a farmer gets the counts-only catchment view, never the note' }],
	['GET /projects/:id/farm', { min: 'farmer', why: 'the farm index: a farmer lists only their linked farms (RLS on node)' }],
	['GET /projects/:id/farm/:nodeId', { min: 'farmer', why: 'the farm view of a linked farm; any other node 404s alike' }],
	['GET /projects/:id/farm/:nodeId/export.csv', { min: 'farmer', why: "the farm view's CSV, the same figures and the same 404s" }],
	['GET /projects/:id/farm/:nodeId/access', { min: 'farmer', why: 'who can see this farm, so a farmer knows who reads their figures' }],
	// Notes (WP-2.7): RLS limits a farmer or contributor to farm notes on their own farms.
	['GET /projects/:id/notes', { min: 'farmer', why: 'notes RLS lets the caller read (a farmer: farm notes on their farms)' }],
	['GET /projects/:id/notes/counts', { min: 'farmer', why: 'per-target counts of the same RLS-limited notes' }],
	['POST /projects/:id/notes', { min: 'farmer', why: 'a farmer writes a farm note on their own farm only (note_insert, the route)' }],
	['PATCH /projects/:id/notes/:noteId', { min: 'farmer', why: "only the author edits a note's body (note_guard)" }],
	['DELETE /projects/:id/notes/:noteId', { min: 'farmer', why: 'the author, or an editor, deletes a note' }],
	// Alerts (WP-2.13): RLS limits a farmer to their farms' events and the notices; a contributor gets none.
	['GET /projects/:id/alert-events', { min: 'farmer', why: "alert events RLS lets the caller read: their farms' and the notices" }],
	['PUT /me/alerts/:projectId', { min: 'farmer', why: "the caller's own alert preferences, limited to the kinds their role gets" }],
	['DELETE /projects/:id/members/:userId', { min: 'farmer', why: 'anyone may leave; only an owner removes someone else (inline check)' }],
	// Contributor and above (WP-3.3): an applicant works on their application.
	['GET /projects/:id/scenarios', { min: 'contributor', why: 'a contributor lists their own applications and those shared with them (RLS)' }],
	['POST /projects/:id/scenarios', { min: 'contributor', why: 'a contributor makes an application on the published run' }],
	['GET /projects/:id/scenarios/:sid', { min: 'contributor', why: 'an application its applicant or a sharer reads; any other 404s' }],
	['GET /projects/:id/scenarios/:sid/base', { min: 'contributor', why: "the published base run's inputs, through app_published_run_input" }],
	['PATCH /projects/:id/scenarios/:sid', { min: 'contributor', why: 'an application by its applicant, a team scenario by an editor' }],
	['DELETE /projects/:id/scenarios/:sid', { min: 'contributor', why: 'an application by its applicant, a team scenario by an editor' }],
	['POST /projects/:id/scenarios/:sid/runs', { min: 'contributor', why: 'an application by its readers, a team scenario by an editor' }],
	['POST /projects/:id/scenarios/:sid/rebase', { min: 'contributor', why: 'an application by its applicant, a team scenario by an editor' }],
	['POST /projects/:id/scenarios/:sid/submit', { min: 'contributor', why: 'an application by its applicant, a team scenario by an editor' }],
	['POST /projects/:id/scenarios/:sid/withdraw', { min: 'contributor', why: 'an application by its applicant, a team scenario by an editor' }],
	['POST /projects/:id/scenarios/:sid/reopen', { min: 'contributor', why: 'an application by its applicant, a team scenario by an editor' }],
	['GET /projects/:id/scenarios/:sid/share-candidates', { min: 'contributor', why: 'who an applicant may share their own application with' }],
	['POST /projects/:id/scenarios/:sid/members', { min: 'contributor', why: 'an applicant shares their own application' }],
	['DELETE /projects/:id/scenarios/:sid/members/:userId', { min: 'contributor', why: 'an applicant unshares their own application' }]
]);

/** Reads that need editor, and why. */
const EDITOR_READS = new Map<string, string>([
	['GET /projects/:id/applications', 'the assessors’ queue of submitted applications (WP-3.3)'],
	['GET /projects/:id/alert-rules', 'the alert thresholds editors set; viewers get the alerts, not the rules']
]);

interface Ctx {
	owner: User;
	editor: User;
	viewer: User;
	contributor: User;
	farmer: User;
	projectId: string;
	farmId: string;
	otherFarmId: string;
	runId: string;
	seriesId: string;
	model: unknown;
	ids: Record<string, string>;
}
const ctx = {} as Ctx;

type Sample = { body?: unknown; query?: Record<string, string>; params?: Record<string, string> };
const levels = (key: 'name' | 'label') => [1, 0.85].map((f) => ({ [key]: `${f * 100} %`, ops: [{ op: 'demand.scale', factor: f }] }));
const csv = 'registration_no,farm,authorisation,water_source,volume_m3_year\nL-1,Farm A,licence,surface,500\n';

/** A request each route's validation accepts, where an empty body or query doesn't. */
const SAMPLE: Record<string, (c: Ctx) => Sample> = {
	'POST /projects/:id/copy': () => ({ body: { name: 'Ladder copy' } }),
	'POST /projects/:id/members': () => ({ body: { email: `ladder-${crypto.randomUUID()}@example.com`, role: 'viewer' } }),
	'PATCH /projects/:id/members/:userId': () => ({ body: { role: 'editor' } }),
	'PUT /projects/:id/model': (c) => ({ body: c.model }),
	'PUT /projects/:id/series': () => ({ body: { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2022-01-01', values: [1, 2] } }),
	'PATCH /projects/:id/series/:seriesId': () => ({ body: { product: 'Ladder gauge', productVersion: '1' } }),
	'POST /projects/:id/series/merge': () => ({ body: { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2022-01-02', values: [5, 6] } }),
	'GET /projects/:id/runs/:runId/series': () => ({ query: { key: 'simulated_outflow' } }),
	'GET /projects/:id/runs/:runId/day': (c) => ({ query: { date: '2021-10-03', nodeId: c.farmId } }),
	'GET /projects/:id/runs/:runId/export/farms.csv': () => ({ query: { key: 'supplied' } }),
	'PATCH /projects/:id/runs/:runId': () => ({ body: { pinned: true } }),
	'POST /projects/:id/runs/:runId/uncertainty': () => ({
		body: { request: { members: 30, thresholds: { minSkill: -10, maxLowFlowBiasPct: null, wr2012MaxLevel: 'unusable' } } }
	}),
	'POST /projects/:id/evidence': (c) => ({ body: { runId: c.runId, reason: 'the calibrated run' } }),
	'POST /projects/:id/scenarios': (c) => ({ body: { name: `Ladder ${crypto.randomUUID()}`, baseRunId: c.runId, ops: [] } }),
	'PATCH /projects/:id/scenarios/:sid': () => ({ body: { description: 'ladder' } }),
	'POST /projects/:id/scenarios/:sid/rebase': (c) => ({ body: { baseRunId: c.runId } }),
	'POST /projects/:id/scenarios/:sid/decide': () => ({ body: { outcome: 'approved' } }),
	'POST /projects/:id/scenarios/:sid/members': (c) => ({ body: { userId: c.contributor.id } }),
	'DELETE /projects/:id/scenarios/:sid/members/:userId': (c) => ({ params: { userId: c.contributor.id } }),
	'POST /projects/:id/runs/:runId/signoffs': () => ({
		body: { fullName: 'Ladder Signer', registrationBody: 'SACNASP', registrationNo: '1', scope: 'ladder', confirmed: [], statementSha256: '0'.repeat(64) }
	}),
	'POST /projects/:id/jobs': () => ({ body: { kind: 'rerun', label: 'Ladder' } }),
	'POST /projects/:id/yield': (c) => ({ body: { nodeId: c.farmId, runId: c.runId, kind: 'firm' } }),
	'GET /projects/:id/yield': (c) => ({ query: { runId: c.runId } }),
	'POST /projects/:id/sweeps': (c) => ({ body: { name: 'Ladder sweep', baseRunId: c.runId, members: levels('name') } }),
	'POST /projects/:id/outlooks': (c) => ({ body: { name: 'Ladder outlook', baseRunId: c.runId, levels: levels('label') } }),
	'POST /projects/:id/feeds': () => ({ body: { source: 'dws', config: { station: 'X0H001' } } }),
	'POST /projects/:id/report-schedules': (c) => ({ body: { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients: [c.owner.id] } }),
	'POST /projects/:id/farmers': (c) => ({ body: { email: `ladder-${crypto.randomUUID()}@example.com`, nodeIds: [c.farmId] } }),
	'POST /projects/:id/farmers/bulk': () => ({ body: { rows: [{ email: `ladder-${crypto.randomUUID()}@example.com`, farm: 'Farm A' }] } }),
	'PUT /projects/:id/farmers/:userId': (c) => ({ body: { nodeIds: [c.otherFarmId] }, params: { userId: c.farmer.id } }),
	'POST /projects/:id/publication': (c) => ({ body: { runId: c.runId } }),
	'PATCH /projects/:id/publication/:pubId': () => ({ body: { restriction: { level: 'advisory', noticeEn: 'Use water sparingly' } } }),
	'POST /projects/:id/share-links': () => ({ body: { label: 'Ladder link', expiresInDays: 7 } }),
	'POST /projects/:id/allocations': (c) => ({ body: { nodeId: c.farmId, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1000 } }),
	'POST /projects/:id/allocations/import': () => ({ body: { kind: 'csv', fileName: 'ladder.csv', text: csv } }),
	'POST /projects/:id/allocations/import/commit': () => ({ body: { kind: 'csv', fileName: 'ladder.csv', text: csv } }),
	'POST /projects/:id/notes': (c) => ({ body: { body: 'Ladder note', nodeId: c.farmId } }),
	'PATCH /projects/:id/notes/:noteId': () => ({ body: { body: 'Edited' } }),
	'POST /projects/:id/api-keys': () => ({ body: { name: 'Ladder key' } }),
	'PUT /projects/:id/alert-rules': (c) => ({ body: { rules: [{ kind: 'dam_below', nodeId: c.farmId, threshold: 0.25, enabled: false }] } }),
	'PUT /me/alerts/:projectId': () => ({ body: { items: [{ kind: 'all', mode: 'immediate' }] } })
};

const routes = [
	...new Set(
		app.routes
			.filter((r) => r.method !== 'ALL' && r.method !== 'OPTIONS' && (r.path === '/projects/:id' || r.path.startsWith('/projects/:id/') || r.path === '/me/alerts/:projectId'))
			.map((r) => `${r.method} ${r.path}`)
	)
];
const isWrite = (route: string) => !route.startsWith('GET ');

/** One request as `u`, with the route's sample, and the role checks it made. */
async function probe(u: User, route: string, override: Record<string, string> = {}) {
	const [method, pattern] = route.split(' ') as [string, string];
	const s = SAMPLE[route]?.(ctx) ?? {};
	const ids = { ...ctx.ids, ...s.params, ...override };
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
	const [owner, editor, viewer, contributor, farmer] = await Promise.all(['Lowner', 'Leditor', 'Lviewer', 'Lcontributor', 'Lfarmer'].map((n) => signUp(n)));
	Object.assign(ctx, { owner, editor, viewer, contributor, farmer });
	const projectId = (await owner!.call('POST', '/projects', { name: 'Ladder' })).body.project.id as string;
	const at = `/projects/${projectId}`;
	const outlet = node('Weir', null);
	const a = node('Farm A', outlet.id);
	const b = node('Farm B', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = {
		nodes: [outlet, a, b],
		crops: [crop],
		cropAreas: [
			{ nodeId: a.id, cropId: crop.id, areaM2: 100_000 },
			{ nodeId: b.id, cropId: crop.id, areaM2: 80_000 }
		],
		transfers: []
	};
	expect((await owner!.call('PUT', `${at}/model`, model)).status).toBe(200);
	expect((await owner!.call('PATCH', at, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	const rain = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	const series = await owner!.call('PUT', `${at}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain });
	expect(series.status).toBe(200);
	for (const [u, role] of [
		[editor!, 'editor'],
		[viewer!, 'viewer'],
		[contributor!, 'contributor']
	] as const) {
		expect((await owner!.call('POST', `${at}/members`, { email: u.email, role })).status).toBe(201);
	}
	expect((await owner!.call('POST', `${at}/farmers`, { email: farmer!.email, nodeIds: [a.id] })).status).toBe(201);
	const run = await owner!.call('POST', `${at}/runs`, { label: 'Ladder run' });
	expect(run.status).toBe(201);
	const runId = run.body.run.id as string;
	// One real row behind every sub-id a route takes, owned by the owner, so a
	// route that looks the row up before checking the role is still reached.
	const made = async (path: string, body: unknown, pick: (b: any) => string) => { // eslint-disable-line @typescript-eslint/no-explicit-any
		const r = await owner!.call('POST', `${at}${path}`, body);
		expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
		return pick(r.body);
	};
	const pubId = await made('/publication', { runId }, (b) => b.publication.id);
	const sid = await made('/scenarios', { name: 'Team scenario', baseRunId: runId, ops: [] }, (b) => b.scenario.id);
	const feedId = await made('/feeds', { source: 'dws', config: { station: 'X0H000' } }, (b) => b.feed.id);
	const scheduleId = await made('/report-schedules', { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients: [owner!.id] }, (b) => b.schedule.id);
	const aid = await made('/allocations', { nodeId: a.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1000 }, (b) => b.allocation.id);
	const linkId = await made('/share-links', { label: 'Ladder link', expiresInDays: 7 }, (b) => b.link.id);
	const keyId = await made('/api-keys', { name: 'Ladder key' }, (b) => b.key.id);
	const inviteId = await made('/members', { email: `ladder-${crypto.randomUUID()}@example.com`, role: 'viewer' }, (b) => b.invite.id);
	const noteId = await made('/notes', { body: 'Owner note', nodeId: a.id }, (b) => b.note.id);
	const jobId = await made('/yield', { nodeId: a.id, runId, kind: 'firm' }, (b) => b.jobId);
	const [rev] = await asOwner('SELECT id FROM model_revision WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [projectId]);
	Object.assign(ctx, {
		projectId,
		farmId: a.id,
		otherFarmId: b.id,
		runId,
		seriesId: series.body.id,
		model,
		ids: {
			id: projectId,
			projectId,
			runId,
			seriesId: series.body.id,
			nodeId: a.id,
			userId: owner!.id,
			sid,
			pubId,
			feedId,
			scheduleId,
			aid,
			linkId,
			keyId,
			inviteId,
			noteId,
			jobId,
			revId: String(rev!.id)
		}
	});
	before = await snapshot();

	// The inventory: every route as the viewer, recording the role it asks for.
	for (const route of routes) {
		const r = await probe(viewer!, route);
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
		for (const r of [...LOWER_ROLE_WRITES.keys(), ...OWNER_ONLY.keys(), ...EDITOR_READS.keys(), ...BELOW_VIEWER.keys(), ...Object.keys(SAMPLE)]) expect(routes, r).toContain(r);
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

	it('admits a farmer or contributor on exactly the listed routes, at the listed role', () => {
		const below = routes.filter((r) => minRole.has(r) && rank[minRole.get(r)!] < rank.viewer).map((r) => [r, minRole.get(r)]);
		expect(below.sort()).toEqual([...BELOW_VIEWER].map(([r, e]) => [r, e.min]).sort());
	});

	it('gives every allowlist entry a reason', () => {
		for (const [r, e] of [...LOWER_ROLE_WRITES, ...BELOW_VIEWER]) expect(e.why.length, r).toBeGreaterThan(20);
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

// After the snapshot tests: the positive controls below run the farmer's and
// the contributor's writes for real (a note, an application, their alert
// preferences), which the viewer's sweep must not see.
describe('the farmer and the contributor, on the routes below viewer', () => {
	const at = (min: Role) => [...BELOW_VIEWER].filter(([, e]) => rank[e.min] <= rank[min]).map(([r]) => r);

	it.each([
		['farmer', 'farmer'],
		['contributor', 'contributor']
	] as const)('positive control: the %s passes the role check of every route admitting %s', async (who, min) => {
		expect(at(min).length).toBeGreaterThan(min === 'farmer' ? 10 : 25);
		const refused: string[] = [];
		for (const route of at(min)) {
			const r = await probe(ctx[who], route);
			if (!r.checks.length || r.checks.some((c) => !c.ok)) refused.push(`${route} → ${r.status}`);
		}
		expect(refused).toEqual([]);
	});

	it('answers a farmer 403 on every contributor route, at the contributor check', async () => {
		const wrong: string[] = [];
		const contributorOnly = [...BELOW_VIEWER].filter(([, e]) => e.min === 'contributor').map(([r]) => r);
		expect(contributorOnly.length).toBeGreaterThan(10);
		for (const route of contributorOnly) {
			const r = await probe(ctx.farmer, route);
			if (r.status !== 403 || r.checks.find((c) => !c.ok)?.min !== 'contributor') wrong.push(`${route} → ${r.status}`);
		}
		expect(wrong).toEqual([]);
	});

	// A row that isn't there (or isn't theirs) answers 404, which says nothing
	// about whether it exists; the positive control above shows the same
	// request with a real id gets past the role check.
	it.each(['farmer', 'contributor'] as const)('answers a %s 404 for an id that isn’t there on every allowed route that takes one', async (who) => {
		const wrong: string[] = [];
		const withId = at(who).filter((r) => /:(sid|nodeId|noteId)/.test(r));
		expect(withId.length).toBeGreaterThanOrEqual(who === 'farmer' ? 5 : 15);
		for (const route of withId) {
			const r = await probe(ctx[who], route, { sid: ZERO, nodeId: ZERO, noteId: ZERO });
			if (r.status !== 404) wrong.push(`${route} → ${r.status} ${r.text.slice(0, 80)}`);
		}
		expect(wrong).toEqual([]);
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
