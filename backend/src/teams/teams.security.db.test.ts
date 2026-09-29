// Teams as an access path (docs/security.md § Authorization): the team role →
// project role mapping, what an unrecognised team role grants (nothing), and
// that losing the team (removed, left, team deleted, project moved out) takes
// every team project with it, rows the user wrote while a member included.
//
// Built from the live inventories: the team_role and project_role enums, the
// route list (app.routes) and every table with a project_id column, so a new
// role value, route or table is covered the day it lands. Every "cannot" has
// its positive control (CLAUDE.md rule 5).
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { TEAM_ROLES } from './access.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';
const MARKER = `team-sec-${crypto.randomUUID()}`;

/**
 * The mapping, pinned. A team_role value added to the enum fails the first test
 * below until it is given a row here, so a new role can't silently grant
 * anything (docs/security.md: "an unrecognised team role grants nothing").
 */
const TEAM_TO_PROJECT: Record<string, string> = { viewer: 'viewer', member: 'editor', admin: 'owner' };

const enumValues = async (type: string) =>
	((await asOwner(`SELECT unnest(enum_range(NULL::${type}))::text AS v`)) as { v: string }[]).map((r) => r.v);

async function raw(u: User, method: string, path: string, body?: unknown) {
	const r = await app.request(path, {
		method,
		headers: { cookie: u.cookie, origin: ORIGIN, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	return { status: r.status, text: await r.text() };
}

/** A runnable team catchment (outlet gauge + one farm, A-pan, rain, observed flow) with one run. */
async function teamProject(admin: User, teamId: string, name = `Team catchment ${MARKER}`) {
	const created = await admin.call('POST', '/projects', { name, teamId });
	expect(created.status).toBe(201);
	const projectId = created.body.project.id as string;
	const outlet = node('Gauge', null);
	const farm = node(`Farm ${MARKER}`, outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 }], transfers: [] };
	expect((await admin.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await admin.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	const series = (kind: string, unit: string, values: number[]) => ({ kind, unit, startDate: '2020-01-01', values });
	expect((await admin.call('PUT', `/projects/${projectId}/series`, series('rain_catchment_mm', 'mm', rain))).status).toBe(200);
	expect((await admin.call('PUT', `/projects/${projectId}/series`, series('flow_observed_m3s', 'm3/s', new Array(60).fill(0.2)))).status).toBe(200);
	const run = await admin.call('POST', `/projects/${projectId}/runs`, { label: `Baseline ${MARKER}` });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	return { projectId, runId: run.body.run.id as string, farmNodeId: farm.id };
}

async function addToTeam(admin: User, teamId: string, u: User, role: string) {
	const r = await admin.call('POST', `/teams/${teamId}/members`, { email: u.email, role });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	expect(r.body.invite.role).toBe(role);
}

/** The effective role and every app_has_role answer, as `u` through RLS. */
async function rolesAs(userId: string, projectId: string, projectRoles: string[]) {
	return withUser(userId, async (db) => {
		const role = (await db.query('SELECT app_project_role($1)::text AS r', [projectId])).rows[0].r as string | null;
		const has: Record<string, boolean> = {};
		for (const min of projectRoles) has[min] = (await db.query('SELECT app_has_role($1, $2::project_role) AS h', [projectId, min])).rows[0].h;
		return { role, has };
	});
}

describe('team role → project role mapping', () => {
	let teamRoles: string[];
	let projectRoles: string[];
	beforeAll(async () => {
		teamRoles = await enumValues('team_role');
		projectRoles = await enumValues('project_role'); // lowest first
	});

	it('pins a mapping for every team_role in the catalogue, and the API knows exactly those roles', () => {
		expect(teamRoles.length).toBeGreaterThan(0);
		// A role added in SQL must be added to the API's list and pinned here, deliberately.
		expect(Object.keys(TEAM_TO_PROJECT).sort()).toEqual([...teamRoles].sort());
		expect([...TEAM_ROLES]).toEqual(teamRoles);
		for (const target of Object.values(TEAM_TO_PROJECT)) expect(projectRoles).toContain(target);
	});

	it('gives each team role exactly its project role on a team project, in SQL and the API; a non-member gets nothing', async () => {
		const admin = await signUp('MapAdmin');
		const teamId = (await admin.call('POST', '/teams', { name: 'Mapping' })).body.team.id as string;
		const { projectId } = await teamProject(admin, teamId);
		const rank = (r: string) => projectRoles.indexOf(r);

		const seen: Record<string, unknown> = {};
		const want: Record<string, unknown> = {};
		for (const teamRole of teamRoles) {
			let u = admin;
			if (teamRole !== 'admin') {
				u = await signUp(`Map${teamRole}`);
				await addToTeam(admin, teamId, u, teamRole);
			}
			const expected = TEAM_TO_PROJECT[teamRole]!;
			seen[teamRole] = { ...(await rolesAs(u.id, projectId, projectRoles)), api: (await u.call('GET', `/projects/${projectId}`)).body.project.role };
			want[teamRole] = {
				role: expected,
				has: Object.fromEntries(projectRoles.map((min) => [min, rank(min) <= rank(expected)])),
				api: expected
			};
		}
		expect(seen).toEqual(want);

		// Negative control: signed in, not in the team: no role, every check false, 404.
		const outsider = await signUp('MapOutsider');
		expect(await rolesAs(outsider.id, projectId, projectRoles)).toEqual({ role: null, has: Object.fromEntries(projectRoles.map((r) => [r, false])) });
		expect((await outsider.call('GET', `/projects/${projectId}`)).status).toBe(404);
	});

	it('combines a team role with a direct role as the higher of the two, for every pair', async () => {
		const admin = await signUp('PairAdmin');
		const teamId = (await admin.call('POST', '/teams', { name: 'Pairs' })).body.team.id as string;
		const { projectId } = await teamProject(admin, teamId);
		const higher = (a: string, b: string) => (projectRoles.indexOf(a) >= projectRoles.indexOf(b) ? a : b);

		const wrong: string[] = [];
		let checked = 0;
		for (const teamRole of teamRoles.filter((r) => r !== 'admin')) {
			const u = await signUp(`Pair${teamRole}`);
			await addToTeam(admin, teamId, u, teamRole);
			for (const direct of projectRoles) {
				// Arrangement only: the direct role written as the schema owner.
				await asOwner(
					`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, $3::project_role)
					 ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
					[projectId, u.id, direct]
				);
				const got = (await rolesAs(u.id, projectId, [])).role;
				const expected = higher(TEAM_TO_PROJECT[teamRole]!, direct);
				checked++;
				if (got !== expected) wrong.push(`team ${teamRole} + direct ${direct}: ${got}, expected ${expected}`);
			}
			await asOwner('DELETE FROM project_member WHERE project_id = $1 AND user_id = $2', [projectId, u.id]);
			// With the direct row gone, the team role alone is back.
			expect((await rolesAs(u.id, projectId, [])).role).toBe(TEAM_TO_PROJECT[teamRole]);
		}
		expect(checked).toBe((teamRoles.length - 1) * projectRoles.length);
		expect(wrong).toEqual([]);
	});

	it('grants nothing for a team role the mapping does not name (SQL), while the named roles still map', async () => {
		const admin = await signUp('UnknownAdmin');
		const teamId = (await admin.call('POST', '/teams', { name: 'Unknown role' })).body.team.id as string;
		const { projectId } = await teamProject(admin, teamId);
		const viewer = await signUp('UnknownViewer');
		const member = await signUp('UnknownMember');
		await addToTeam(admin, teamId, viewer, 'viewer');
		await addToTeam(admin, teamId, member, 'member');

		// Stand in for a team_role added later without a mapping: rename one value,
		// in a transaction that is rolled back (RENAME VALUE is transactional and
		// usable at once, unlike ADD VALUE). The viewer's row then holds a role
		// app_project_role has no branch for.
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			await client.query('BEGIN');
			await client.query(`ALTER TYPE team_role RENAME VALUE 'viewer' TO 'auditor'`);
			const as = async (userId: string) => {
				await client.query(`SELECT set_config('app.current_user_id', $1, true)`, [userId]);
				const { rows } = await client.query(
					`SELECT app_team_role($1)::text AS team, app_project_role($2)::text AS project, app_has_role($2, 'farmer') AS any`,
					[teamId, projectId]
				);
				return rows[0];
			};
			expect(await as(viewer.id)).toEqual({ team: 'auditor', project: null, any: false });
			// Positive control: the same transaction still maps a named role.
			expect(await as(member.id)).toEqual({ team: 'member', project: 'editor', any: true });
		} finally {
			await client.query('ROLLBACK').catch(() => {});
			await client.end();
		}
		expect(await enumValues('team_role')).toEqual(TEAM_ROLES);
	});
});

describe('team membership rows: no one raises their own access', () => {
	it('a member or viewer cannot promote themselves, add anyone, or remove another member, even through RLS; an admin can', async () => {
		const admin = await signUp('RowAdmin');
		const teamId = (await admin.call('POST', '/teams', { name: 'Rows' })).body.team.id as string;
		const member = await signUp('RowMember');
		const viewer = await signUp('RowViewer');
		const stranger = await signUp('RowStranger');
		await addToTeam(admin, teamId, member, 'member');
		await addToTeam(admin, teamId, viewer, 'viewer');

		const attempt = async (userId: string, sql: string, params: unknown[]) =>
			withUser(userId, async (db) => {
				await db.query('SAVEPOINT a');
				try {
					return (await db.query(sql, params)).rowCount ?? 0;
				} catch (e) {
					if ((e as { code?: string }).code !== '42501') throw e;
					return 'refused';
				} finally {
					await db.query('ROLLBACK TO SAVEPOINT a');
				}
			});
		const promote = `UPDATE team_member SET role = 'admin' WHERE team_id = $1 AND user_id = $2`;
		const add = `INSERT INTO team_member (team_id, user_id, role) VALUES ($1, $2, 'admin')`;
		const remove = `DELETE FROM team_member WHERE team_id = $1 AND user_id = $2`;

		for (const u of [member, viewer]) {
			expect(await attempt(u.id, promote, [teamId, u.id])).toBe(0);
			expect(await attempt(u.id, add, [teamId, stranger.id])).toBe('refused');
			expect(await attempt(u.id, remove, [teamId, admin.id])).toBe(0);
		}
		// Not in the team at all: can't add themselves.
		expect(await attempt(stranger.id, add, [teamId, stranger.id])).toBe('refused');
		// The API agrees for the promotion (the rest is in teams.db.test.ts).
		expect((await member.call('PATCH', `/teams/${teamId}/members/${member.id}`, { role: 'admin' })).status).toBe(403);
		expect((await admin.call('GET', `/teams/${teamId}`)).body.members.map((m: { role: string }) => m.role)).toEqual(['admin', 'member', 'viewer']);

		// Positive control: the admin does each of them.
		expect(await attempt(admin.id, promote, [teamId, member.id])).toBe(1);
		expect(await attempt(admin.id, add, [teamId, stranger.id])).toBe(1);
		expect(await attempt(admin.id, remove, [teamId, viewer.id])).toBe(1);
	});
});

describe('losing the team revokes every team project, rows the user wrote included', () => {
	let tables: string[];
	let routes: string[];
	beforeAll(async () => {
		tables = (
			await asOwner(
				`SELECT c.table_name FROM information_schema.columns c
				 JOIN information_schema.tables t USING (table_schema, table_name)
				 WHERE c.table_schema = 'public' AND c.column_name = 'project_id' AND t.table_type = 'BASE TABLE'
				 ORDER BY 1`
			)
		).map((r) => r.table_name as string);
		routes = [...new Set(app.routes.filter((r) => r.method !== 'ALL' && r.method !== 'OPTIONS').map((r) => `${r.method} ${r.path}`))];
	});

	/** Rows of the project `userId` sees through RLS, per table (only tables with any). */
	const visible = async (userId: string, projectId: string) =>
		withUser(userId, async (db) => {
			const out: Record<string, number> = {};
			for (const t of ['project', ...tables]) {
				const col = t === 'project' ? 'id' : 'project_id';
				const { rows } = await db.query(`SELECT count(*)::int AS n FROM "${t}" WHERE ${col} = $1`, [projectId]);
				if (rows[0].n > 0) out[t] = rows[0].n;
			}
			return out;
		});

	/** Every route under /projects/:id (and /me/alerts/:projectId), with the project's ids filled in. */
	const projectRoutes = (ids: { projectId: string; runId: string; farmNodeId: string; userId: string }) =>
		routes.flatMap((route) => {
			const [method, pattern] = route.split(' ') as [string, string];
			if (!pattern.startsWith('/projects/:id') && !pattern.startsWith('/me/alerts/:projectId')) return [];
			const fill: Record<string, string> = { id: ids.projectId, projectId: ids.projectId, runId: ids.runId, nodeId: ids.farmNodeId, userId: ids.userId, uid: ids.userId };
			return [{ route, method, path: pattern.replace(/:([A-Za-z]+)/g, (_, n: string) => fill[n] ?? crypto.randomUUID()) }];
		});

	/** All rows of the project in every table, counted as the schema owner (arrangement only). */
	const ownerCounts = async (projectId: string) => {
		const out: Record<string, number> = {};
		for (const t of ['project', ...tables]) {
			const col = t === 'project' ? 'id' : 'project_id';
			const [row] = await asOwner(`SELECT count(*)::int AS n FROM "${t}" WHERE ${col} = $1`, [projectId]);
			out[t] = row!.n as number;
		}
		return out;
	};

	/**
	 * A team project, and a team admin (owner only through the team) and a team
	 * member (editor) who each wrote rows of their own in it: runs, notes, a
	 * scenario, an API key, a share link, a report schedule.
	 */
	async function setup() {
		const creator = await signUp('Creator');
		const teamId = (await creator.call('POST', '/teams', { name: `Team ${MARKER}` })).body.team.id as string;
		const p = await teamProject(creator, teamId);
		const admin = await signUp('TeamAdmin2');
		const member = await signUp('TeamMember2');
		await addToTeam(creator, teamId, admin, 'admin');
		await addToTeam(creator, teamId, member, 'member');
		for (const u of [admin, member]) {
			const run = await u.call('POST', `/projects/${p.projectId}/runs`, { label: `Run by ${u.email}` });
			expect(run.status, JSON.stringify(run.body)).toBe(201);
			expect((await u.call('POST', `/projects/${p.projectId}/notes`, { body: `Note ${MARKER}` })).status).toBe(201);
			const sc = await u.call('POST', `/projects/${p.projectId}/scenarios`, { name: `Scenario ${u.id}`, baseRunId: p.runId });
			expect(sc.status, JSON.stringify(sc.body)).toBe(201);
		}
		expect((await admin.call('POST', `/projects/${p.projectId}/api-keys`, { name: `Key ${MARKER}` })).status).toBe(201);
		expect((await admin.call('POST', `/projects/${p.projectId}/share-links`, { label: 'Link', expiresInDays: 7 })).status).toBe(201);
		return { creator, teamId, admin, member, ...p };
	}

	/** What each user sees before, what they see after, and what the owner's counts are. */
	async function expectRevoked(s: Awaited<ReturnType<typeof setup>>, revoke: () => Promise<void>, lost: User[]) {
		// Positive control: while in the team, each sees the project and the rows they wrote.
		for (const u of lost) {
			const seen = await visible(u.id, s.projectId);
			for (const t of ['project', 'model_run', 'note', 'scenario', 'time_series']) expect(seen[t], `${t} before`).toBeGreaterThan(0);
			expect((await raw(u, 'GET', `/projects/${s.projectId}`)).status).toBe(200);
			expect((await rlsWrites(u.id, s.projectId)).length, 'writes before').toBeGreaterThan(5);
		}
		await revoke();
		const before = await ownerCounts(s.projectId);
		for (const u of lost) {
			expect({ who: u.email, seen: await visible(u.id, s.projectId) }).toEqual({ who: u.email, seen: {} });
			expect({ who: u.email, changed: await rlsWrites(u.id, s.projectId) }).toEqual({ who: u.email, changed: [] });
			expect((await rolesAs(u.id, s.projectId, [])).role).toBeNull();
			const list = await raw(u, 'GET', '/projects');
			expect(list.status).toBe(200);
			expect(list.text).not.toContain(s.projectId);
		}
		expect(await ownerCounts(s.projectId)).toEqual(before);
	}

	/** Each UPDATE and DELETE of the project's rows, per table, as `userId` through RLS, rolled back: the ones that reached a row. */
	const rlsWrites = async (userId: string, projectId: string) => {
		const changed: string[] = [];
		await withUser(userId, async (db) => {
			for (const t of ['project', ...tables]) {
				const col = t === 'project' ? 'id' : 'project_id';
				for (const stmt of [`UPDATE "${t}" SET ${col} = ${col} WHERE ${col} = $1`, `DELETE FROM "${t}" WHERE ${col} = $1`]) {
					await db.query('SAVEPOINT attempt');
					try {
						const r = await db.query(stmt, [projectId]);
						if ((r.rowCount ?? 0) > 0) changed.push(`${stmt}: ${r.rowCount}`);
					} catch (e) {
						// No grant (42501) is as good as zero rows; any other refusal (a foreign
						// key, a trigger) means the statement reached a row.
						const code = (e as { code?: string }).code;
						if (code !== '42501') changed.push(`${stmt}: reached a row (${code})`);
					} finally {
						await db.query('ROLLBACK TO SAVEPOINT attempt');
					}
				}
			}
		});
		return changed;
	};

	it('removed by an admin: every table empty, every route refused (reads leak nothing, writes change nothing)', async () => {
		const s = await setup();
		const ids = { projectId: s.projectId, runId: s.runId, farmNodeId: s.farmNodeId, userId: s.member.id };
		const gets = projectRoutes(ids).filter((t) => t.method === 'GET');
		expect(gets.length).toBeGreaterThan(50);

		// Positive control for the route sweep: as a member, reads succeed.
		let ok = 0;
		for (const t of gets) if ((await raw(s.member, 'GET', t.path)).status < 400) ok++;
		expect(ok).toBeGreaterThan(20);

		await expectRevoked(s, async () => {
			expect((await s.creator.call('DELETE', `/teams/${s.teamId}/members/${s.member.id}`)).status).toBe(204);
			expect((await s.creator.call('DELETE', `/teams/${s.teamId}/members/${s.admin.id}`)).status).toBe(204);
		}, [s.member, s.admin]);

		const leaks: string[] = [];
		const before = await ownerCounts(s.projectId);
		for (const u of [s.member, s.admin]) {
			const own = { ...ids, userId: u.id };
			for (const t of projectRoutes(own)) {
				for (const body of t.method === 'GET' || t.method === 'DELETE' ? [undefined] : [{}, { name: MARKER, label: MARKER, body: MARKER, role: 'owner', userId: u.id }]) {
					const r = await raw(u, t.method, t.path, body);
					if (r.status < 400) leaks.push(`${u === s.member ? 'member' : 'admin'}: ${t.route} → ${r.status}`);
					else if (r.text.includes(MARKER)) leaks.push(`${t.route} → ${r.status} with project data in the error`);
				}
			}
		}
		expect(leaks).toEqual([]);
		expect(await ownerCounts(s.projectId)).toEqual(before);
		// Nor can they put themselves back.
		expect((await s.member.call('POST', `/teams/${s.teamId}/members`, { email: s.member.email, role: 'admin' })).status).toBe(404);
		// The creator (still in the team, and the direct owner) keeps everything.
		expect((await s.creator.call('GET', `/projects/${s.projectId}`)).body.project.role).toBe('owner');
	});

	it('leaving the team', async () => {
		const s = await setup();
		await expectRevoked(s, async () => {
			for (const u of [s.member, s.admin]) expect((await u.call('DELETE', `/teams/${s.teamId}/members/${u.id}`)).status).toBe(204);
		}, [s.member, s.admin]);
	});

	it('the team deleted: its projects stay with their direct owner only', async () => {
		const s = await setup();
		await expectRevoked(s, async () => {
			expect((await s.creator.call('DELETE', `/teams/${s.teamId}`)).status).toBe(204);
		}, [s.member, s.admin]);
		expect((await s.creator.call('GET', `/projects/${s.projectId}`)).body.project.role).toBe('owner');
	});

	it('the project moved out of the team: the team keeps its membership, not the project', async () => {
		const s = await setup();
		await expectRevoked(s, async () => {
			expect((await s.creator.call('PATCH', `/projects/${s.projectId}`, { teamId: null })).status).toBe(200);
		}, [s.member, s.admin]);
		// Still in the team (the membership wasn't what changed).
		expect((await s.member.call('GET', `/teams/${s.teamId}`)).status).toBe(200);
	});

	it('demoted from admin to member: owner-only actions stop at once, editor ones remain', async () => {
		const s = await setup();
		expect((await s.admin.call('GET', `/projects/${s.projectId}`)).body.project.role).toBe('owner');
		expect((await s.admin.call('GET', `/projects/${s.projectId}/api-keys`)).status).toBe(200);
		expect((await s.creator.call('PATCH', `/teams/${s.teamId}/members/${s.admin.id}`, { role: 'member' })).status).toBe(200);
		expect((await s.admin.call('GET', `/projects/${s.projectId}`)).body.project.role).toBe('editor');
		expect((await s.admin.call('POST', `/projects/${s.projectId}/api-keys`, { name: 'After demotion' })).status).toBe(403);
		expect((await s.admin.call('DELETE', `/projects/${s.projectId}`)).status).toBe(403);
		expect((await s.admin.call('PATCH', `/projects/${s.projectId}`, { teamId: null })).status).toBe(403);
		// Positive control: an editor's write still goes through.
		expect((await s.admin.call('PATCH', `/projects/${s.projectId}`, { name: `Renamed ${MARKER}` })).status).toBe(200);
	});
});
