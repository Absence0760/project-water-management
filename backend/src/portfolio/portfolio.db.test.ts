// The team portfolio (WP-2.14, docs/api.md § Portfolio): one query, RLS-bound
// rows, and figures that say where they come from. Every "cannot see" check
// has a positive control.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { utcToday } from '../feeds/fetch.js';
import { loadPortfolio, type PortfolioProject } from './portfolio.js';

type User = Awaited<ReturnType<typeof signUp>>;

let admin: User; // team admin, owns the team's projects
let teamViewer: User;
let farmer: User; // a farmer on the published team project, not in the team
let stranger: User; // in another team only
let teamId: string;
let otherTeamId: string;
let published: string; // run, then published
let runOnly: string; // run, never published, no EWR set
let empty: string; // no run at all
let personal: string; // the admin's own project, outside the team
let strangersProject: string;

const RAIN_START = '2021-10-01';
const DAYS = 820; // to 2023-12-29

async function makeProject(u: User, name: string, team: string | null, { ewr = true } = {}) {
	const id = (await u.call('POST', '/projects', { name, teamId: team })).body.project.id as string;
	const outlet = node('Weir', null);
	const farms = [node('Upper farm', outlet.id), node('Lower farm', outlet.id, { damCapacityM3: 50_000 }), node('Dry farm', outlet.id, { damCapacityM3: 0, damInitialPct: 0 })];
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = {
		nodes: [outlet, ...farms],
		crops: [crop],
		cropAreas: farms.map((f, i) => ({ nodeId: f.id, cropId: crop.id, areaM2: 200_000 + 100_000 * i })),
		transfers: []
	};
	expect((await u.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	const settings = { apanMm: monthly(220), ewrPragmaticM3PerDay: monthly(ewr ? 6000 : 0) };
	expect((await u.call('PATCH', `/projects/${id}`, { settings })).status).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 11 === 0 ? 22 : i % 5 === 0 ? 2 : 0));
	expect((await u.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: RAIN_START, values: rain })).status).toBe(200);
	return id;
}
async function run(u: User, pid: string) {
	const res = await u.call('POST', `/projects/${pid}/runs`, { label: 'r' });
	expect(res.status).toBe(201);
	return res.body.run.id as string;
}
const portfolio = async (u: User, team = teamId) => u.call('GET', `/teams/${team}/portfolio`);
const byId = (rows: PortfolioProject[], id: string) => rows.find((r) => r.id === id);

beforeAll(async () => {
	[admin, teamViewer, farmer, stranger] = (await Promise.all(['PfAdmin', 'PfViewer', 'PfFarmer', 'PfStranger'].map((n) => signUp(n)))) as [User, User, User, User];
	teamId = (await admin.call('POST', '/teams', { name: 'Portfolio WUA' })).body.team.id;
	expect((await admin.call('POST', `/teams/${teamId}/members`, { email: teamViewer.email, role: 'viewer' })).status).toBe(201);
	otherTeamId = (await stranger.call('POST', '/teams', { name: 'Elsewhere' })).body.team.id;

	published = await makeProject(admin, 'Alpha published', teamId);
	runOnly = await makeProject(admin, 'Bravo run only', teamId, { ewr: false });
	empty = (await admin.call('POST', '/projects', { name: 'Charlie empty', teamId })).body.project.id;
	personal = (await admin.call('POST', '/projects', { name: 'Personal, not the team' })).body.project.id;
	strangersProject = (await stranger.call('POST', '/projects', { name: 'Stranger team project', teamId: otherTeamId })).body.project.id;
	await run(admin, runOnly);
}, 120_000);

describe('GET /teams/:id/portfolio', () => {
	it('lists the team’s catchments only: never a personal project or another team’s', async () => {
		const res = await portfolio(teamViewer);
		expect(res.status).toBe(200);
		const ids = (res.body.projects as PortfolioProject[]).map((p) => p.id);
		// Positive control: every team project, for a team viewer who is in none of them directly.
		expect(ids).toEqual(expect.arrayContaining([published, runOnly, empty]));
		expect(ids).toHaveLength(3);
		expect(ids).not.toContain(personal);
		expect(ids).not.toContain(strangersProject);
		expect(res.body.thresholds).toEqual({ amber: 0.05, red: 0.2 });
		expect(res.body.today).toBe(utcToday());
	});

	it('answers 404 to a non-member and to another team’s id, and RLS alone holds the rows back', async () => {
		expect((await portfolio(stranger)).status).toBe(404);
		expect((await portfolio(admin, otherTeamId)).status).toBe(404);
		expect((await portfolio(admin, 'not-a-uuid')).status).toBe(404);
		// Past the membership check, the query itself shows nothing of a team the user isn't in…
		expect(await withUser(admin.id, (db) => loadPortfolio(db, otherTeamId, utcToday()))).toEqual([]);
		// …positive control: its member sees the project through the same query.
		expect((await withUser(stranger.id, (db) => loadPortfolio(db, otherTeamId, utcToday()))).map((p) => p.id)).toEqual([strangersProject]);
	});

	it('a farmer on a team project gets 404, and the query never gives them a catchment roll-up', async () => {
		const runId = await run(admin, published);
		expect((await admin.call('POST', `/projects/${published}/publication`, { runId })).status).toBe(201);
		const farmNode = (await asOwner(`SELECT id FROM node WHERE project_id = $1 AND name = 'Upper farm'`, [published]))[0].id;
		expect((await admin.call('POST', `/projects/${published}/farmers`, { email: farmer.email, nodeIds: [farmNode] })).status).toBe(201);
		expect((await portfolio(farmer)).status).toBe(404);
		expect(await withUser(farmer.id, (db) => loadPortfolio(db, teamId, utcToday()))).toEqual([]);
		// Positive control: the same project reaches a team viewer.
		expect((await withUser(teamViewer.id, (db) => loadPortfolio(db, teamId, utcToday()))).map((p) => p.id)).toContain(published);
		// The staff-only farm counts stay out of the farmer's publication response (and are in a viewer's).
		const asFarmer = await farmer.call('GET', `/projects/${published}/publication`);
		expect(asFarmer.status).toBe(200);
		expect(asFarmer.body.current.catchmentView).not.toHaveProperty('recent');
		const asAdmin = await admin.call('GET', `/projects/${published}/publication`);
		expect(asAdmin.body.current.catchmentView.recent).toMatchObject({ to: '2023-12-29', from7: '2023-12-23', from30: '2023-11-30' });
	});

	it('reads every project in one query, however many there are', async () => {
		let queries = 0;
		const rows = await withUser(admin.id, (db) => {
			const counting = { query: (...args: unknown[]) => (queries++, (db.query as (...a: unknown[]) => unknown)(...args)) } as unknown as Db;
			return loadPortfolio(counting, teamId, utcToday());
		});
		expect(rows).toHaveLength(3);
		expect(queries).toBe(1);
	});
});

describe('the figures, and where they come from', () => {
	it('a project with no run is unknown everywhere, and says why', async () => {
		const rows = (await portfolio(admin)).body.projects as PortfolioProject[];
		expect(byId(rows, empty)).toEqual({
			id: empty,
			name: 'Charlie empty',
			role: 'owner',
			dataUntil: null,
			lastRunAt: null,
			publishedAt: null,
			source: null,
			figuresUntil: null,
			figuresAgeDays: null,
			stale: false,
			behindData: false,
			newerRun: false,
			ewr: { status: 'unknown', daysNotMet30: null, days30: null, fraction30: null, reason: 'no-figures' },
			farmsShort7: null,
			farmsShort30: null,
			farmCount: 0,
			lowestDamPct: null,
			damsKnown: false,
			feeds: { total: 0, ok: 0, failing: 0 },
			alertsFiring: null,
			restriction: null
		});
	});

	it('a run with no EWR set is unknown, not a false green; farm figures wait for a publication', async () => {
		const row = byId((await portfolio(admin)).body.projects, runOnly)!;
		expect(row.source).toBe('run');
		expect(row.figuresUntil).toBe('2023-12-29');
		expect(row.stale).toBe(true);
		expect(row.figuresAgeDays).toBeGreaterThan(7);
		expect(row.ewr).toEqual({ status: 'unknown', daysNotMet30: null, days30: null, fraction30: null, reason: 'no-ewr' });
		expect(row).toMatchObject({ farmsShort7: null, farmsShort30: null, farmCount: 3, lowestDamPct: null, damsKnown: false, publishedAt: null, restriction: null });
	});

	it('the latest run’s EWR (counted in SQL) matches the publication of the same run (counted by the engine)', async () => {
		const pid = await makeProject(admin, 'Delta consistency', teamId);
		const runId = await run(admin, pid);
		const before = byId((await portfolio(admin)).body.projects, pid)!;
		expect(before.source).toBe('run');
		expect(before.ewr.status).not.toBe('unknown');
		expect(before.ewr.days30).toBe(30);

		expect((await admin.call('POST', `/projects/${pid}/publication`, { runId, restriction: { level: 'restricted', pct: 20 } })).status).toBe(201);
		const after = byId((await portfolio(admin)).body.projects, pid)!;
		expect(after.source).toBe('published');
		expect(after.ewr).toEqual(before.ewr);
		expect(after.figuresUntil).toBe(before.figuresUntil);
		expect(after.restriction).toEqual({ level: 'restricted', pct: 20 });
		expect(after.newerRun).toBe(false);
		// Farm figures from the publication: counts within the farm count, the lowest of the two dams.
		expect(after.farmCount).toBe(3);
		expect(after.farmsShort7).toBeGreaterThanOrEqual(0);
		expect(after.farmsShort30!).toBeGreaterThanOrEqual(after.farmsShort7!);
		expect(after.farmsShort30!).toBeLessThanOrEqual(3);
		expect(after.damsKnown).toBe(true);
		const dams = (await asOwner(
			`SELECT view->>'name' AS name, (view->'dam'->>'pct')::float8 AS pct FROM publication_farm f JOIN run_publication p ON p.id = f.publication_id
			 WHERE p.project_id = $1 AND p.superseded_at IS NULL AND jsonb_typeof(view->'dam') = 'object' ORDER BY 2`,
			[pid]
		)) as { name: string; pct: number }[];
		expect(dams).toHaveLength(2); // the dry farm has no dam
		expect(after.lowestDamPct).toEqual({ nodeName: dams[0]!.name, pct: dams[0]!.pct });

		// A newer run leaves the published figures in place, and says there's a newer one.
		await run(admin, pid);
		const later = byId((await portfolio(admin)).body.projects, pid)!;
		expect(later).toMatchObject({ source: 'published', newerRun: true, ewr: before.ewr });
		expect(Date.parse(later.lastRunAt!)).toBeGreaterThan(Date.parse(later.publishedAt!));
	});

	it('new rain after the figures shows as behind; feeds count healthy and failing ones', async () => {
		const pid = await makeProject(admin, 'Echo feeds', teamId);
		await run(admin, pid);
		// Ten more days of rain after the run: the figures are behind the data.
		const series = (await admin.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[];
		const rain = series.find((s) => s.kind === 'rain_catchment_mm')!;
		const current = (await admin.call('GET', `/projects/${pid}/series/${rain.id}`)).body as { values: number[] };
		expect(
			(await admin.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: RAIN_START, values: [...current.values, ...new Array(10).fill(1)] })).status
		).toBe(200);
		const today = utcToday();
		for (const [failures, dataDate] of [
			[0, today],
			[3, null]
		] as const) {
			await asOwner(
				`INSERT INTO data_feed (project_id, source, config, target_kind, target_name, acting_user_id, created_by, last_attempt_at, last_success_at, last_data_date, consecutive_failures)
				 VALUES ($1, 'dws', '{"station":"X0H000"}', 'flow_observed_m3s', $5, $2, $2, now(), CASE WHEN $3::int = 0 THEN now() END, $4::date, $3)`,
				[pid, admin.id, failures, dataDate, `gauge ${failures}`]
			);
		}
		const row = byId((await portfolio(admin)).body.projects, pid)!;
		expect(row.dataUntil).toBe('2024-01-08');
		expect(row.figuresUntil).toBe('2023-12-29');
		expect(row.behindData).toBe(true);
		expect(row.feeds).toEqual({ total: 2, ok: 1, failing: 1 });
	});
});
