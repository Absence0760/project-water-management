// Farmer privacy, swept from the inventories (docs/security.md § Farm scope,
// § Publications and the farm view; CLAUDE.md rules 1 and 5). The per-table
// tests (farms.db.test.ts, publish/publication.db.test.ts, notes/,
// allocations/, alerts/) pin each policy by hand; these sweeps make sure a
// table or route added later can't show one farmer their neighbour's farm:
//
//   1. Every table with a project_id column, read through RLS as each farmer.
//      A visible row must be one the farmer may see: a row that names a node
//      (a foreign key to node, or a *node_id column) names one of their own
//      farms; a row with a user_id is their own; anything else is only
//      visible where FARMER_MAY_READ below says so, with its reason. The
//      allowed rows are computed as the schema owner and compared by hash.
//   2. Every GET route a farmer can call (from app.routes) is called with the
//      farmer's own farm; no 2xx answer may carry the neighbour's farm id or
//      name, their crop, note, allocation holder, or the neighbour farmer's
//      name or email. Every :nodeId route answers the neighbour's farm 404.
//   3. Every farmer-reachable write, aimed at the neighbour's farm, is refused
//      and changes none of the neighbour's rows.
//
// Positive controls: each farmer sees their own rows in the same tables (so
// the rows are farmer-readable at all, and hiding them is RLS's doing), a
// viewer's responses do carry the neighbour's name, and the sweeps prove they
// reached the tables and routes they claim to.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';
const MARKER = `nbr${crypto.randomUUID().slice(0, 8)}`;

/**
 * Rows a farmer may read beyond their own farms' rows and their own user_id
 * rows, per table, as a SQL condition on the row (`$1` project, `$2` the
 * farmer's user id, `$3` their farm node ids). Every other table must show a
 * farmer nothing that isn't tied to their farm. An entry needs the same
 * scrutiny as a new farmer policy.
 */
const FARMER_MAY_READ: Record<string, { reason: string; where: string }> = {
	node: { reason: 'the gauges: the farm view names the outlet (node_select_farmer)', where: `kind = 'gauge'` },
	crop: {
		reason: 'crops planted on their own farms (crop_select_farmer)',
		where: 'id IN (SELECT crop_id FROM crop_area WHERE node_id = ANY($3::uuid[]))'
	},
	project_member: { reason: 'their own membership row (user_id rule)', where: 'false' },
	allocation_holder: {
		reason: 'the holder name on an allocation matched to their own farm (allocation_holder_select)',
		where: 'allocation_id IN (SELECT id FROM allocation WHERE node_id = ANY($3::uuid[]))'
	},
	run_publication: { reason: 'every member reads the current and past publications; counts only, no farm (run_publication_select)', where: 'true' },
	alert_rule: { reason: 'the catchment-wide restriction notice rule (alert_rule_select)', where: `node_id IS NULL AND kind = 'restriction_published'` },
	alert_event: { reason: 'the restriction notice events (alert_event_select)', where: `node_id IS NULL AND kind = 'restriction_published'` },
	alert_subscription: { reason: 'their own catchment-wide choices (alert_subscription_own; user_id rule)', where: 'node_id IS NULL' },
	map_feature: {
		reason: 'the catchment boundary, rivers and gauges, for orientation on their farm map (map_feature_select_farmer, 152; issue #326 A3)',
		where: `kind IN ('catchment_boundary', 'river', 'gauge')`
	},
	alert_delivery: {
		reason: 'their own deliveries, of events they may read',
		where: `event_id IN (SELECT id FROM alert_event WHERE node_id = ANY($3::uuid[]) OR (node_id IS NULL AND kind = 'restriction_published'))`
	}
};

let owner: User;
let viewer: User;
let farmer: User; // Home farm
let cofarmer: User; // also on Home farm (a family member): same farm, a different person
let neighbour: User; // Neighbour farm
let invitee: User; // unverified, invited to the neighbour farm
let projectId: string;
const outlet = node('Weir', null);
const home = node('Home farm', outlet.id);
const theirs = node(`Neighbour ${MARKER}`, home.id);
const unlinked = node(`Unlinked ${MARKER}`, outlet.id);
const lucerne = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const secretCrop = { id: crypto.randomUUID(), name: `Crop ${MARKER}`, cropFactor: monthly(0.7) };
const NEIGHBOUR_NOTE = `Note ${MARKER}`;
const NEIGHBOUR_HOLDER = `Holder ${MARKER}`;
const NEIGHBOUR_NAME = `Nbrfarmer${MARKER}`;

const tick = () => runTick({ feeds: false, reports: false, alerts: false });

beforeAll(async () => {
	[owner, viewer, farmer, cofarmer, neighbour] = (await Promise.all(['Pvowner', 'Pvviewer', 'Pvfarmer', 'Pvcofarmer', NEIGHBOUR_NAME].map((n) => signUp(n)))) as [
		User,
		User,
		User,
		User,
		User
	];
	invitee = await signUp('Pvinvitee', { verified: false });
	projectId = (await owner.call('POST', '/projects', { name: 'Farmer privacy' })).body.project.id;
	const bh = (nodeId: string, name: string) => ({ id: crypto.randomUUID(), nodeId, name, capacityM3Day: 50, annualCapM3: 15_000, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0.2 });
	const town = (nodeId: string, name: string) => ({ id: crypto.randomUUID(), nodeId, name, category: 'municipal', sizing: 'monthly', monthlyM3Day: monthly(120), returnPct: 0.4, priority: 'first' });
	const patch = (nodeId: string) => ({ id: crypto.randomUUID(), nodeId, coverClass: 'pine', areaKm2: 1, densityPct: 0.5, factors: null });
	const model = {
		nodes: [outlet, home, theirs, unlinked],
		crops: [lucerne, secretCrop],
		cropAreas: [
			{ nodeId: home.id, cropId: lucerne.id, areaM2: 200_000 },
			{ nodeId: theirs.id, cropId: secretCrop.id, areaM2: 300_000 },
			{ nodeId: unlinked.id, cropId: lucerne.id, areaM2: 250_000 }
		],
		// One transfer between the two neighbours' farms only: neither end is Home's.
		transfers: [{ id: crypto.randomUUID(), fromNodeId: theirs.id, toNodeId: unlinked.id, months: [1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 }],
		landCover: [patch(home.id), patch(theirs.id)],
		boreholes: [bh(home.id, 'BH home'), bh(theirs.id, `BH ${MARKER}`)],
		// Demand objects (088): a farmer reads only their own units'.
		demandObjects: [town(home.id, 'Home town'), town(theirs.id, `Town ${MARKER}`)]
	};
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	// The map (issue #326 A3): each farm's parcel, the neighbour's named with the marker, and the orientation features.
	const box = (x: number) => ({ type: 'Polygon', coordinates: [[[x, -33.7], [x + 0.02, -33.7], [x + 0.02, -33.68], [x, -33.68], [x, -33.7]]] });
	for (const f of [
		{ kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: [[[21.2, -33.8], [21.5, -33.8], [21.5, -33.5], [21.2, -33.5], [21.2, -33.8]]] } },
		{ kind: 'farm_parcel', name: 'Home parcel', nodeId: home.id, geometry: box(21.3) },
		{ kind: 'farm_parcel', name: `Parcel ${MARKER}`, nodeId: theirs.id, geometry: box(21.35) },
		{ kind: 'dam', name: `Dam ${MARKER}`, nodeId: theirs.id, lon: 21.36, lat: -33.69 },
		{ kind: 'farm_parcel', name: `Unlinked parcel ${MARKER}`, nodeId: unlinked.id, geometry: box(21.4) },
		{ kind: 'river', name: 'River', geometry: { type: 'LineString', coordinates: [[21.25, -33.6], [21.45, -33.65]] } }
	]) {
		const r = await owner.call('POST', `/projects/${projectId}/map/features`, f);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
	}
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(3000) } })).status).toBe(200);
	const rain = Array.from({ length: 500 }, (_, i) => (i % 23 === 0 ? 12 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [home.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: cofarmer.email, nodeIds: [home.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: neighbour.email, nodeIds: [theirs.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: invitee.email, nodeIds: [theirs.id] })).body.invited).toBe(true);

	// Allocations and notes on every farm, some by the farmers themselves.
	for (const [n, holder] of [
		[home, 'Home holder'],
		[theirs, NEIGHBOUR_HOLDER],
		[unlinked, `Unlinked holder ${MARKER}`]
	] as const) {
		const a = await owner.call('POST', `/projects/${projectId}/allocations`, { nodeId: n.id, holder, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 9000, validFrom: '2020-01-01' });
		expect(a.status, JSON.stringify(a.body)).toBe(201);
	}
	expect((await owner.call('POST', `/projects/${projectId}/notes`, { body: 'Home farm note', nodeId: home.id, visibility: 'farm' })).status).toBe(201);
	expect((await neighbour.call('POST', `/projects/${projectId}/notes`, { body: NEIGHBOUR_NOTE, nodeId: theirs.id })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/notes`, { body: `Unlinked ${NEIGHBOUR_NOTE}`, nodeId: unlinked.id, visibility: 'farm' })).status).toBe(201);

	// Alerts on every farm, then a run, a publication with a restriction and a tick: dam events, a notice event, deliveries.
	const damRules = [home, theirs, unlinked].map((f) => ({ kind: 'dam_below', nodeId: f.id, threshold: 0.99, enabled: true }));
	expect((await owner.call('PUT', `/projects/${projectId}/alert-rules`, { rules: [...damRules, { kind: 'restriction_published', threshold: 0, enabled: true }] })).status).toBe(200);
	for (const u of [farmer, neighbour]) {
		const f = u === farmer ? home : theirs;
		expect((await u.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'dam_below', nodeId: f.id, mode: 'immediate' }, { kind: 'restriction_published', mode: 'immediate' }] })).status).toBe(200);
	}
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'privacy' });
	expect(run.status).toBe(201);
	const pub = await owner.call('POST', `/projects/${projectId}/publication`, {
		runId: run.body.run.id,
		note: `Staff note ${MARKER}`,
		restriction: { level: 'restricted', pct: 20, notice: { en: 'Irrigate at night only.' } }
	});
	expect(pub.status).toBe(201);
	await tick();
}, 90_000);

afterAll(async () => {
	// Leave no job for another file's tick (jobs and feeds tests count them).
	await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
});

/** The project's tables and, for each, the columns that name a node (a foreign key to node, or a uuid *node_id column). */
async function inventory() {
	const tables = (
		await asOwner(
			`SELECT c.table_name FROM information_schema.columns c
			 JOIN information_schema.tables t USING (table_schema, table_name)
			 WHERE c.table_schema = 'public' AND c.column_name = 'project_id' AND t.table_type = 'BASE TABLE'
			 ORDER BY 1`
		)
	).map((r) => r.table_name as string);
	const refs = new Map<string, Set<string>>();
	const add = (t: string, c: string) => refs.set(t, (refs.get(t) ?? new Set()).add(c));
	for (const r of await asOwner(
		`SELECT con.conrelid::regclass::text AS t, a.attname AS c
		 FROM pg_constraint con JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)
		 WHERE con.contype = 'f' AND con.confrelid = 'public.node'::regclass`
	))
		add(r.t, r.c);
	for (const r of await asOwner(
		`SELECT table_name AS t, column_name AS c FROM information_schema.columns
		 WHERE table_schema = 'public' AND data_type = 'uuid' AND column_name LIKE '%node\\_id'`
	))
		add(r.t, r.c);
	// A node row names itself; its downstream link is a neighbour's, not its own.
	refs.set('node', new Set(['id']));
	const userCol = new Set(
		(await asOwner(`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'user_id'`)).map((r) => r.t as string)
	);
	return { tables, refs, userCol };
}

/** md5 of each row of `table` in the project, as `run` sees it (a withUser client or the owner). */
const rowHashes = (table: string, extra = 'true') => `SELECT md5(to_jsonb(x)::text) AS h FROM "${table}" x WHERE project_id = $1 AND (${extra})`;

async function visibleTo(u: User, tables: string[]) {
	const out = new Map<string, Set<string>>();
	await withUser(u.id, async (db) => {
		for (const t of tables) out.set(t, new Set((await db.query(rowHashes(t), [projectId])).rows.map((r) => r.h as string)));
	});
	return out;
}

/** The rows `u` may see in `table`: their farms' rows, their own user rows, and the FARMER_MAY_READ extra; computed as the schema owner. */
async function allowedFor(u: User, farmIds: string[], table: string, inv: Awaited<ReturnType<typeof inventory>>) {
	const conds: string[] = [];
	const cols = [...(inv.refs.get(table) ?? [])];
	if (cols.length) conds.push(cols.map((c) => `"${c}" = ANY($3::uuid[])`).join(' OR '));
	if (FARMER_MAY_READ[table]) conds.push(FARMER_MAY_READ[table]!.where);
	let where = conds.length ? conds.map((c) => `(${c})`).join(' OR ') : 'false';
	if (inv.userCol.has(table)) where = `(${where} OR user_id = $2) AND user_id = $2`;
	// $2 and $3 are referenced by some conditions only; name both so Postgres types them.
	where = `(${where}) AND $2::uuid IS NOT NULL AND cardinality($3::uuid[]) >= 0`;
	return new Set((await asOwner(rowHashes(table, where), [projectId, u.id, farmIds])).map((r) => r.h as string));
}

describe('table sweep: a farmer reads only their own farms’ rows', () => {
	let inv: Awaited<ReturnType<typeof inventory>>;
	beforeAll(async () => {
		inv = await inventory();
	});

	it('finds the project tables and the farm-scoped ones, and the neighbour has rows in them (the sweep is not vacuous)', async () => {
		expect(inv.tables.length).toBeGreaterThan(30);
		for (const t of Object.keys(FARMER_MAY_READ)) expect(inv.tables, `FARMER_MAY_READ names ${t}: renamed? update the list`).toContain(t);
		const core = ['node', 'crop_area', 'transfer', 'land_cover', 'borehole', 'demand_object', 'farm_link', 'invite_node', 'publication_farm', 'run_series', 'note', 'allocation', 'alert_rule', 'alert_event', 'alert_subscription', 'map_feature'];
		for (const t of core) {
			const cols = [...(inv.refs.get(t) ?? [])];
			expect(cols.length, `${t} names a node`).toBeGreaterThan(0);
			const [row] = await asOwner(`SELECT count(*)::int AS n FROM "${t}" WHERE project_id = $1 AND (${cols.map((c) => `"${c}" = $2`).join(' OR ')})`, [projectId, theirs.id]);
			expect(row!.n, `the neighbour's farm has rows in ${t}`).toBeGreaterThan(0);
		}
	});

	it('positive control: each farmer reads their own farm’s rows in the farm-scoped tables', async () => {
		for (const [u, farm] of [
			[farmer, home],
			[neighbour, theirs]
		] as const) {
			const tables = ['node', 'crop_area', 'land_cover', 'borehole', 'demand_object', 'farm_link', 'publication_farm', 'run_series', 'note', 'allocation', 'alert_rule', 'alert_event', 'alert_subscription', 'map_feature'];
			await withUser(u.id, async (db) => {
				for (const t of tables) {
					const cols = [...inv.refs.get(t)!];
					const { rows } = await db.query(`SELECT count(*)::int AS n FROM "${t}" WHERE project_id = $1 AND (${cols.map((c) => `"${c}" = $2`).join(' OR ')})`, [projectId, farm.id]);
					expect(rows[0].n, `${farm.name} in ${t}`).toBeGreaterThan(0);
				}
				// And their own deliveries of those alerts.
				expect((await db.query('SELECT count(*)::int AS n FROM alert_delivery WHERE project_id = $1', [projectId])).rows[0].n).toBeGreaterThan(0);
			});
		}
	});

	it.each([
		['the farmer', () => farmer, () => [home.id]],
		['the co-farmer on the same farm', () => cofarmer, () => [home.id]],
		['the neighbour', () => neighbour, () => [theirs.id]]
	])('shows %s no row of another farm or another person, in any table', async (_who, u, farmIds) => {
		const seen = await visibleTo(u(), inv.tables);
		const leaks: string[] = [];
		for (const t of inv.tables) {
			const allowed = await allowedFor(u(), farmIds(), t, inv);
			const extra = [...seen.get(t)!].filter((h) => !allowed.has(h));
			if (extra.length) leaks.push(`${t}: ${extra.length} row(s) not theirs`);
		}
		expect(leaks).toEqual([]);
	});
});

/** A signed-in request keeping the raw text (CSV routes aren't JSON). */
async function raw(u: User, method: string, path: string, body?: unknown) {
	const r = await app.request(path, {
		method,
		headers: { cookie: u.cookie, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	return { status: r.status, text: await r.text() };
}

const routes = [...new Set(app.routes.filter((r) => r.method !== 'ALL' && r.method !== 'OPTIONS').map((r) => `${r.method} ${r.path}`))];

/** The routes a farmer's own requests can reach: the project's, and the account's (no other path parameter). */
function farmerRoutes(nodeId: string, userId: string) {
	const out: { route: string; method: string; path: string }[] = [];
	for (const route of routes) {
		const [method, pattern] = route.split(' ') as [string, string];
		let path = pattern.replace(/^\/projects\/:id/, `/projects/${projectId}`).replace(/^\/me\/alerts\/:projectId/, `/me/alerts/${projectId}`);
		if (!path.startsWith(`/projects/${projectId}`) && !path.startsWith('/me/') && !path.startsWith('/auth/me') && path !== '/projects') continue;
		path = path.replace(/:nodeId/g, nodeId).replace(/:(userId|uid)/g, userId).replace(/:[A-Za-z]+/g, () => crypto.randomUUID());
		out.push({ route, method, path });
	}
	return out;
}

/** What identifies the neighbour and their farm (and the unlinked farm). */
const NEIGHBOUR_TRACES = () => [theirs.id, theirs.name, unlinked.id, unlinked.name, secretCrop.name, NEIGHBOUR_NOTE, NEIGHBOUR_HOLDER, NEIGHBOUR_NAME, neighbour.email, neighbour.id, invitee.email, MARKER];

describe('route sweep: no answer to a farmer carries a neighbour', () => {
	it('reaches the farm routes, and a viewer’s farm index does name the neighbour (positive control)', async () => {
		const got = farmerRoutes(home.id, farmer.id).map((r) => r.route);
		for (const must of ['GET /projects/:id/farm', 'GET /projects/:id/farm/:nodeId', 'GET /projects/:id/farm/:nodeId/export.csv', 'GET /projects/:id/farm/:nodeId/map', 'GET /projects/:id/notes', 'GET /projects/:id/alert-events', 'GET /me/alerts', 'GET /projects']) {
			expect(got).toContain(must);
		}
		const v = await raw(viewer, 'GET', `/projects/${projectId}/farm`);
		expect(v.status).toBe(200);
		expect(v.text).toContain(theirs.name);
		expect((await raw(viewer, 'GET', `/projects/${projectId}/alert-events`)).text).toContain(theirs.name);
	});

	it('answers every farmer GET with their own farm and nothing of the neighbour’s', async () => {
		const answered: string[] = [];
		const leaks: string[] = [];
		for (const t of farmerRoutes(home.id, farmer.id).filter((t) => t.method === 'GET')) {
			// As is, and filtered to the neighbour's farm (the notes and alert lists take ?nodeId=).
			for (const path of [t.path, `${t.path}${t.path.includes('?') ? '&' : '?'}nodeId=${theirs.id}`]) {
				const r = await raw(farmer, 'GET', path);
				if (r.status >= 300) continue;
				if (path === t.path) answered.push(t.route);
				for (const trace of NEIGHBOUR_TRACES()) if (r.text.includes(trace)) leaks.push(`${path} carries ${trace === MARKER ? 'the marker' : trace}`);
			}
		}
		expect(leaks).toEqual([]);
		// Positive control: the farmer really was answered, with their own farm.
		expect(answered).toEqual(expect.arrayContaining(['GET /projects/:id/farm', 'GET /projects/:id/farm/:nodeId', 'GET /projects/:id/farm/:nodeId/map', 'GET /projects/:id/notes', 'GET /projects/:id/alert-events', 'GET /me/alerts']));
		expect((await raw(farmer, 'GET', `/projects/${projectId}/farm/${home.id}`)).text).toContain(home.name);
		expect((await raw(farmer, 'GET', `/projects/${projectId}/alert-events`)).text).toContain(home.name);
		expect((await raw(farmer, 'GET', `/projects/${projectId}/farm/${home.id}/map`)).text).toContain('Home parcel');
	});

	it('answers every :nodeId route 404 for the neighbour’s farm (positive control: the neighbour is answered)', async () => {
		const nodeRoutes = farmerRoutes(theirs.id, farmer.id).filter((t) => t.method === 'GET' && t.route.includes(':nodeId'));
		expect(nodeRoutes.length).toBeGreaterThan(2);
		const answered: string[] = [];
		for (const t of nodeRoutes) {
			const r = await raw(farmer, 'GET', t.path);
			if (r.status !== 404 && r.status !== 403) answered.push(`${t.route} → ${r.status}`);
			if (r.text.includes(theirs.name)) answered.push(`${t.route} names the farm in its error`);
		}
		expect(answered).toEqual([]);
		expect((await raw(neighbour, 'GET', `/projects/${projectId}/farm/${theirs.id}`)).status).toBe(200);
	});

	it('refuses every farmer write aimed at the neighbour’s farm or the neighbour, and changes none of their rows', async () => {
		const snapshot = async () => {
			const inv = await inventory();
			const counts: Record<string, number | string> = {};
			for (const [t, cols] of inv.refs) {
				if (!inv.tables.includes(t)) continue;
				const [row] = await asOwner(`SELECT count(*)::int AS n, coalesce(string_agg(md5(to_jsonb(x)::text), ',' ORDER BY md5(to_jsonb(x)::text)), '') AS h FROM "${t}" x WHERE project_id = $1 AND (${[...cols].map((c) => `"${c}" = $2`).join(' OR ')})`, [projectId, theirs.id]);
				counts[t] = row!.n;
				counts[`${t}#`] = row!.h;
			}
			counts.neighbourMember = (await asOwner('SELECT count(*)::int AS n FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, neighbour.id]))[0]!.n;
			return counts;
		};
		const before = await snapshot();
		// One body per shape a farmer's write takes (the routes' schemas are
		// strict, so a merged body would only test validation); each is valid,
		// as the positive control below shows by landing it on their own farm.
		const bodies = (nodeId: string) => [
			{ body: MARKER, nodeId, visibility: 'farm' },
			{ items: [{ kind: 'dam_below', nodeId, mode: 'daily_digest' }] },
			{ rules: [{ kind: 'dam_below', nodeId, threshold: 0.5, enabled: false }] },
			{ nodeIds: [nodeId] },
			{ email: farmer.email, nodeIds: [nodeId] },
			{}
		];
		// The project's writes (the account's own, /auth/me and /me/alerts/resume,
		// touch only the caller); :userId is always the neighbour, whom a farmer
		// may not remove.
		const writes = (nodeId: string) =>
			farmerRoutes(nodeId, neighbour.id).filter((t) => t.method !== 'GET' && (t.path.startsWith(`/projects/${projectId}`) || t.path.startsWith(`/me/alerts/${projectId}`)));
		const sweep = async (nodeId: string) => {
			const accepted = new Set<string>();
			for (const t of writes(nodeId)) {
				for (const b of t.method === 'DELETE' ? [undefined] : bodies(nodeId)) {
					if ((await raw(farmer, t.method, t.path, b)).status < 400) accepted.add(t.route);
				}
			}
			return [...accepted].sort();
		};
		expect(writes(theirs.id).map((t) => t.route)).toEqual(expect.arrayContaining(['POST /projects/:id/notes', 'PUT /me/alerts/:projectId', 'DELETE /projects/:id/members/:userId']));
		expect(await sweep(theirs.id)).toEqual([]);
		expect(await snapshot()).toEqual(before);
		// Positive control: the same writes aimed at their own farm are taken.
		expect(await sweep(home.id)).toEqual(['POST /projects/:id/notes', 'PUT /me/alerts/:projectId']);
	});
});
