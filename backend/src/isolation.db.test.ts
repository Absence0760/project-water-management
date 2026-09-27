// Cross-project data isolation, swept from the inventories rather than
// written route by route (docs/security.md § Authorization; CLAUDE.md rules 1
// and 5). Two sweeps, each self-maintaining:
//
//   1. Every API route that names a project or team is called by a signed-in
//      outsider, and by a signed-in member of another project, with the
//      victim's ids. Nothing may succeed, nothing may leak, and no write may
//      change the victim's data. A new route is covered the day it lands.
//   2. Every table with a project_id column is read, updated and deleted
//      through RLS as the outsider and as another project's API key. Every
//      one must show nothing and change nothing. A new table is covered the
//      day its migration lands.
//
// Positive controls: the victim's owner sees the same data (rule 5), and the
// sweeps prove they reached the routes and tables they claim to.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from './__tests__/helpers.js';
import { withApiKey, withUser } from './db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';
const MARKER = `isolation-marker-${crypto.randomUUID()}`;

// Routes an outsider may legitimately get a 2xx from, with the reason. Empty
// today; an entry here needs the same scrutiny as an addition to routes.test.ts
// PUBLIC.
const OUTSIDER_MAY_SUCCEED = new Map<string, string>();

interface Victim {
	owner: User;
	projectId: string;
	runId: string;
	farmNodeId: string;
	apiKeyId: string;
	teamId: string;
	projectName: string;
}

/** A project with a model, a series, a run, an API key, a farmer, a note-worthy name, and a team. */
async function victimProject(): Promise<Victim> {
	const owner = await signUp('Victim');
	const projectName = `Victim ${MARKER}`;
	const projectId = (await owner.call('POST', '/projects', { name: projectName })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node(`Farm ${MARKER}`, outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: `Run ${MARKER}` });
	expect(run.status).toBe(201);
	const key = await owner.call('POST', `/projects/${projectId}/api-keys`, { name: `Key ${MARKER}` });
	expect(key.status).toBe(201);
	const farmer = await signUp('Victimfarmer');
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	const team = await owner.call('POST', '/teams', { name: `Team ${MARKER}` });
	expect(team.status).toBe(201);
	return {
		owner,
		projectId,
		runId: run.body.run.id,
		farmNodeId: farm.id,
		apiKeyId: key.body.key.id,
		teamId: team.body.team.id,
		projectName
	};
}

/** A signed-in user's request, keeping the raw text (CSV, xlsx and PDF routes aren't JSON). */
async function raw(u: User, method: string, path: string, body?: unknown) {
	const r = await app.request(path, {
		method,
		headers: { cookie: u.cookie, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	return { status: r.status, text: await r.text() };
}

const routes = [
	...new Set(app.routes.filter((r) => r.method !== 'ALL' && r.method !== 'OPTIONS').map((r) => `${r.method} ${r.path}`))
];

/** The routes that take a project or team from the caller, with the victim's ids filled in. */
function targetedRoutes(v: Victim) {
	const ids: Record<string, string> = {
		projectId: v.projectId,
		runId: v.runId,
		nodeId: v.farmNodeId,
		keyId: v.apiKeyId,
		userId: v.owner.id,
		uid: v.owner.id
	};
	const out: { route: string; method: string; path: string }[] = [];
	for (const route of routes) {
		const [method, pattern] = route.split(' ') as [string, string];
		let path: string;
		if (pattern.startsWith('/projects/:id') || pattern.startsWith('/me/alerts/:projectId')) {
			path = pattern.replace(/^\/projects\/:id/, `/projects/${v.projectId}`);
		} else if (pattern.startsWith('/teams/:id')) {
			path = pattern.replace(/^\/teams\/:id/, `/teams/${v.teamId}`);
		} else if (pattern === '/compare/runs') {
			path = `/compare/runs?a=${v.runId}&b=${v.runId}`;
		} else continue;
		// Any other id: the victim's where it has one, else an id that exists nowhere.
		path = path.replace(/:([A-Za-z]+)/g, (_, name: string) => ids[name] ?? crypto.randomUUID());
		out.push({ route, method, path });
	}
	return out;
}

let victim: Victim;
let outsider: User; // signed in, member of nothing
let neighbour: User; // owns a project of their own
let neighbourProjectId: string;
let neighbourKeyId: string;

beforeAll(async () => {
	victim = await victimProject();
	outsider = await signUp('Outsider');
	neighbour = await signUp('Neighbour');
	neighbourProjectId = (await neighbour.call('POST', '/projects', { name: 'Neighbour' })).body.project.id;
	neighbourKeyId = (await neighbour.call('POST', `/projects/${neighbourProjectId}/api-keys`, { name: 'Neighbour key' })).body.key.id;
});

describe('route sweep: another user reaches none of a project through the API', () => {
	it('positive control: the owner reads the project, its run and its series', async () => {
		const project = await raw(victim.owner, 'GET', `/projects/${victim.projectId}`);
		expect(project.status).toBe(200);
		expect(project.text).toContain(MARKER);
		expect((await raw(victim.owner, 'GET', `/projects/${victim.projectId}/runs/${victim.runId}`)).status).toBe(200);
		expect((await raw(victim.owner, 'GET', `/projects/${victim.projectId}/series`)).status).toBe(200);
		expect((await raw(victim.owner, 'GET', `/teams/${victim.teamId}`)).text).toContain(MARKER);
	});

	it('reaches every project and team route (the sweep is not vacuous)', () => {
		const targeted = targetedRoutes(victim);
		expect(targeted.length).toBeGreaterThan(100);
		for (const must of ['GET /projects/:id', 'DELETE /projects/:id', 'GET /projects/:id/runs/:runId', 'POST /projects/:id/members', 'GET /teams/:id/portfolio', 'GET /compare/runs']) {
			expect(targeted.map((t) => t.route)).toContain(must);
		}
	});

	it('does not list the project or team for another user', async () => {
		for (const u of [outsider, neighbour]) {
			expect((await raw(u, 'GET', '/projects')).text).not.toContain(MARKER);
			expect((await raw(u, 'GET', '/teams')).text).not.toContain(MARKER);
		}
	});

	it('answers every read with an error and no victim data, for an outsider and for a neighbour', async () => {
		const leaks: string[] = [];
		for (const u of [outsider, neighbour]) {
			for (const t of targetedRoutes(victim).filter((t) => t.method === 'GET')) {
				if (OUTSIDER_MAY_SUCCEED.has(t.route)) continue;
				const r = await raw(u, t.method, t.path);
				if (r.status < 400) leaks.push(`${t.route} → ${r.status}`);
				else if (r.text.includes(MARKER) || r.text.includes(victim.owner.email)) leaks.push(`${t.route} → ${r.status} with victim data in the error`);
			}
		}
		expect(leaks).toEqual([]);
	});

	it('refuses every write, and the victim’s data is unchanged afterwards', async () => {
		const before = await snapshot();
		const accepted: string[] = [];
		for (const u of [outsider, neighbour]) {
			for (const t of targetedRoutes(victim).filter((t) => t.method !== 'GET')) {
				if (OUTSIDER_MAY_SUCCEED.has(t.route)) continue;
				// An empty body: a route must refuse on membership, not only on validation,
				// so each write is also tried with the owner's own ids in it.
				for (const body of [{}, { name: MARKER, email: u.email, role: 'owner', userId: u.id, nodeIds: [victim.farmNodeId] }]) {
					const r = await raw(u, t.method, t.path, t.method === 'DELETE' ? undefined : body);
					if (r.status < 400) accepted.push(`${t.route} → ${r.status}`);
				}
			}
		}
		expect(accepted).toEqual([]);
		expect(await snapshot()).toEqual(before);
	});
});

/** What the victim's owner sees, as the owner: name, members, runs, series, keys, team. */
async function snapshot() {
	const o = victim.owner;
	const get = async (path: string) => {
		const r = await raw(o, 'GET', path);
		expect(r.status).toBe(200);
		return JSON.parse(r.text);
	};
	const project = await get(`/projects/${victim.projectId}`);
	return {
		name: project.project.name,
		role: project.project.role,
		members: await get(`/projects/${victim.projectId}/members`),
		runs: (await get(`/projects/${victim.projectId}/runs`)).runs.map((r: { id: string; label: string }) => [r.id, r.label]),
		series: await get(`/projects/${victim.projectId}/series`),
		keys: await get(`/projects/${victim.projectId}/api-keys`),
		team: await get(`/teams/${victim.teamId}`)
	};
}

describe('table sweep: RLS shows and changes nothing of another project', () => {
	let tables: string[] = [];

	beforeAll(async () => {
		tables = (
			await asOwner(
				`SELECT c.table_name FROM information_schema.columns c
				 JOIN information_schema.tables t USING (table_schema, table_name)
				 WHERE c.table_schema = 'public' AND c.column_name = 'project_id' AND t.table_type = 'BASE TABLE'
				 ORDER BY 1`
			)
		).map((r) => r.table_name as string);
	});

	// Rows of the victim's project in each table, counted as the schema owner (arrangement only).
	const ownerCounts = async () => {
		const counts = new Map<string, number>();
		for (const t of ['project', ...tables]) {
			const col = t === 'project' ? 'id' : 'project_id';
			const [row] = await asOwner(`SELECT count(*)::int AS n FROM "${t}" WHERE ${col} = $1`, [victim.projectId]);
			counts.set(t, row!.n as number);
		}
		return counts;
	};

	it('finds the project tables, and the victim has rows in the core ones (the sweep is not vacuous)', async () => {
		expect(tables.length).toBeGreaterThan(30);
		const counts = await ownerCounts();
		for (const core of ['project', 'project_member', 'node', 'time_series', 'model_run', 'run_series', 'api_key', 'farm_link']) {
			if (!counts.has(core)) throw new Error(`core table ${core} is not in the sweep: renamed? update this list`);
			expect(counts.get(core), core).toBeGreaterThan(0);
		}
	});

	it('positive control: the owner sees, through RLS, every table the victim has rows in', async () => {
		const counts = await ownerCounts();
		const hidden: string[] = [];
		await withUser(victim.owner.id, async (db) => {
			for (const [t, n] of counts) {
				if (n === 0) continue;
				const col = t === 'project' ? 'id' : 'project_id';
				const { rows } = await db.query(`SELECT count(*)::int AS n FROM "${t}" WHERE ${col} = $1`, [victim.projectId]);
				if (rows[0].n === 0) hidden.push(t);
			}
		});
		expect(hidden).toEqual([]);
	});

	it('shows another user and another project’s API key no row of the victim’s project, in any table', async () => {
		const visible: string[] = [];
		const read = async (who: string, db: Parameters<Parameters<typeof withUser>[1]>[0]) => {
			for (const t of ['project', ...tables]) {
				const col = t === 'project' ? 'id' : 'project_id';
				const { rows } = await db.query(`SELECT count(*)::int AS n FROM "${t}" WHERE ${col} = $1`, [victim.projectId]);
				if (rows[0].n > 0) visible.push(`${who}: ${t} (${rows[0].n})`);
			}
		};
		await withUser(outsider.id, (db) => read('outsider', db));
		await withUser(neighbour.id, (db) => read('neighbour', db));
		await withApiKey(neighbourKeyId, (db) => read('neighbour key', db));
		expect(visible).toEqual([]);
	});

	it('lets another user update or delete no row of the victim’s project, in any table', async () => {
		const before = await ownerCounts();
		const changed: string[] = [];
		for (const u of [outsider, neighbour]) {
			for (const t of ['project', ...tables]) {
				const col = t === 'project' ? 'id' : 'project_id';
				for (const stmt of [`UPDATE "${t}" SET ${col} = ${col} WHERE ${col} = $1`, `DELETE FROM "${t}" WHERE ${col} = $1`]) {
					// Each attempt in its own transaction, rolled back: a refusal
					// (no grant, 42501) is as good as zero rows.
					await withUser(u.id, async (db) => {
						await db.query('SAVEPOINT attempt');
						try {
							const r = await db.query(stmt, [victim.projectId]);
							if ((r.rowCount ?? 0) > 0) changed.push(`${stmt} as ${u === outsider ? 'outsider' : 'neighbour'}: ${r.rowCount} rows`);
						} catch (e) {
							if ((e as { code?: string }).code !== '42501') throw e;
						} finally {
							await db.query('ROLLBACK TO SAVEPOINT attempt');
						}
					});
				}
			}
		}
		expect(changed).toEqual([]);
		expect(await ownerCounts()).toEqual(before);
	});
});
