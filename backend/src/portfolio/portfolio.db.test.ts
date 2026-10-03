// The team portfolio (WP-2.14, docs/api.md § Portfolio): one query, RLS-bound
// rows, and figures that say where they come from. Every "cannot see" check
// has a positive control.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import type { Db } from '../db/tx.js';
import { withUser } from '../db/tx.js';
import { utcToday } from '../feeds/fetch.js';
import { loadMyOutcomes, loadPortfolio, type PortfolioProject } from './portfolio.js';
import { localDate } from '../projects/timeZone.js';
import { ageDays, ewrStatus } from './status.js';

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
const outcomes = async (u: User) => u.call('GET', '/projects/outcomes');

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
		expect(res.body.thresholds).toEqual({ green: 5, amber: 20, source: 'default' });
		expect(res.body.team).toEqual({ id: teamId, name: 'Portfolio WUA', role: 'viewer' });
		// No team-wide "today": each row carries its own project's (058).
		expect(res.body).not.toHaveProperty('today');
		for (const p of res.body.projects as PortfolioProject[]) expect(p).toMatchObject({ timeZone: 'Africa/Johannesburg', today: localDate(new Date(), 'Africa/Johannesburg') });
	});

	it('counts each row to its own project’s day: two zones 25 hours apart give two different todays', async () => {
		await asOwner(`UPDATE project SET time_zone = 'Pacific/Kiritimati' WHERE id = $1`, [runOnly]);
		await asOwner(`UPDATE project SET time_zone = 'Pacific/Pago_Pago' WHERE id = $1`, [empty]);
		try {
			const before = new Date();
			const rows = (await portfolio(teamViewer)).body.projects as PortfolioProject[];
			const ahead = byId(rows, runOnly)!;
			const behind = byId(rows, empty)!;
			expect(ahead.timeZone).toBe('Pacific/Kiritimati');
			expect(behind.timeZone).toBe('Pacific/Pago_Pago');
			// UTC+14 and UTC−11 are never on the same calendar day.
			expect(ahead.today).not.toBe(behind.today);
			expect([localDate(before, 'Pacific/Kiritimati'), localDate(new Date(), 'Pacific/Kiritimati')]).toContain(ahead.today);
			expect([localDate(before, 'Pacific/Pago_Pago'), localDate(new Date(), 'Pacific/Pago_Pago')]).toContain(behind.today);
			// The age follows the row's own day.
			expect(ahead.figuresAgeDays).toBe(ageDays(ahead.figuresUntil!, ahead.today));
		} finally {
			await asOwner(`UPDATE project SET time_zone = DEFAULT WHERE id = ANY($1::uuid[])`, [[runOnly, empty]]);
		}
	});

	it('answers 404 to a non-member and to another team’s id, and RLS alone holds the rows back', async () => {
		expect((await portfolio(stranger)).status).toBe(404);
		expect((await portfolio(admin, otherTeamId)).status).toBe(404);
		expect((await portfolio(admin, 'not-a-uuid')).status).toBe(404);
		// Past the membership check, the query itself shows nothing of a team the user isn't in…
		expect(await withUser(admin.id, (db) => loadPortfolio(db, otherTeamId, new Date()))).toEqual([]);
		// …positive control: its member sees the project through the same query.
		expect((await withUser(stranger.id, (db) => loadPortfolio(db, otherTeamId, new Date()))).map((p) => p.id)).toEqual([strangersProject]);
	});

	it('a farmer on a team project gets 404, and the query never gives them a catchment roll-up', async () => {
		const runId = await run(admin, published);
		expect((await admin.call('POST', `/projects/${published}/publication`, { runId })).status).toBe(201);
		const farmNode = (await asOwner(`SELECT id FROM node WHERE project_id = $1 AND name = 'Upper farm'`, [published]))[0].id;
		expect((await admin.call('POST', `/projects/${published}/farmers`, { email: farmer.email, nodeIds: [farmNode] })).status).toBe(201);
		expect((await portfolio(farmer)).status).toBe(404);
		expect(await withUser(farmer.id, (db) => loadPortfolio(db, teamId, new Date()))).toEqual([]);
		// Positive control: the same project reaches a team viewer.
		expect((await withUser(teamViewer.id, (db) => loadPortfolio(db, teamId, new Date()))).map((p) => p.id)).toContain(published);
		// The staff-only farm counts stay out of the farmer's publication response (and are in a viewer's).
		const asFarmer = await farmer.call('GET', `/projects/${published}/publication`);
		expect(asFarmer.status).toBe(200);
		expect(asFarmer.body.current.catchmentView).not.toHaveProperty('recent');
		const asAdmin = await admin.call('GET', `/projects/${published}/publication`);
		expect(asAdmin.body.current.catchmentView.recent).toMatchObject({ to: '2023-12-29', from7: '2023-12-23', from30: '2023-11-30' });
	});

	it('an applicant (contributor, WP-3.3) on a team project never gets the roll-up', async () => {
		const [applicant] = (await Promise.all(['PfApplicant'].map((n) => signUp(n)))) as [User];
		expect((await admin.call('POST', `/projects/${published}/members`, { email: applicant.email, role: 'contributor' })).status).toBe(201);
		expect((await portfolio(applicant)).status).toBe(404);
		expect(await withUser(applicant.id, (db) => loadPortfolio(db, teamId, new Date()))).toEqual([]);
		// Positive control: the same project reaches a team viewer.
		expect((await withUser(teamViewer.id, (db) => loadPortfolio(db, teamId, new Date()))).map((p) => p.id)).toContain(published);
	});

	it('reads every project in one query, however many there are', async () => {
		let queries = 0;
		const rows = await withUser(admin.id, (db) => {
			const counting = { query: (...args: unknown[]) => (queries++, (db.query as (...a: unknown[]) => unknown)(...args)) } as unknown as Db;
			return loadPortfolio(counting, teamId, new Date());
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
			timeZone: 'Africa/Johannesburg',
			today: localDate(new Date(), 'Africa/Johannesburg'),
			dataUntil: null,
			lastRunAt: null,
			publishedAt: null,
			source: null,
			sourceRunId: null,
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
			alertsFiring: 0,
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
		expect(before.sourceRunId).toBe(runId);
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

		// A forecast run is guidance beside the runs (daily with a GEFS feed): never "a newer run", nor the figures.
		const lastRunAt = after.lastRunAt;
		expect((await admin.call('PUT', `/projects/${pid}/series`, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2023-12-30', values: new Array(16).fill(2) })).status).toBe(200);
		expect((await admin.call('POST', `/projects/${pid}/runs`, { label: 'f', forecast: true })).status).toBe(201);
		expect(byId((await portfolio(admin)).body.projects, pid)).toMatchObject({ source: 'published', sourceRunId: runId, newerRun: false, lastRunAt });

		// Nor is a scenario's run, also once the scenario is deleted (188, issue #381: its scenario_id is then null).
		const sc = await admin.call('POST', `/projects/${pid}/scenarios`, { name: 'What-if', baseRunId: runId, ops: [{ op: 'demand.scale', factor: 2 }] });
		expect(sc.status).toBe(201);
		expect((await admin.call('POST', `/projects/${pid}/scenarios/${sc.body.scenario.id}/runs`, {})).status).toBe(201);
		expect((await admin.call('DELETE', `/projects/${pid}/scenarios/${sc.body.scenario.id}`)).status).toBe(204);
		expect(byId((await portfolio(admin)).body.projects, pid)).toMatchObject({ source: 'published', sourceRunId: runId, newerRun: false, lastRunAt });

		// A newer run leaves the published figures in place, and says there's a newer one (positive control).
		await run(admin, pid);
		const later = byId((await portfolio(admin)).body.projects, pid)!;
		expect(later).toMatchObject({ source: 'published', sourceRunId: runId, newerRun: true, ewr: before.ewr });
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
		// Blank days after them ("no reading" from a dead sensor) are no data: "Rain to" stays on the last value.
		expect((await admin.call('POST', `/projects/${pid}/series/merge`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2024-01-09', values: [null, null] })).status).toBe(200);
		const row = byId((await portfolio(admin)).body.projects, pid)!;
		expect(row.dataUntil).toBe('2024-01-08');
		expect(row.figuresUntil).toBe('2023-12-29');
		expect(row.behindData).toBe(true);
		expect(row.feeds).toEqual({ total: 2, ok: 1, failing: 1 });
	});
});

describe('firing alerts (WP-2.13)', () => {
	it('counts the firing alerts per project, not the cleared ones (positive control: another project stays at 0)', async () => {
		const farm = (await asOwner(`SELECT id FROM node WHERE project_id = $1 AND kind = 'farm' ORDER BY name LIMIT 1`, [published]))[0].id;
		// Arranged as the schema owner: the count is what's under test (alerts/alerts.db.test.ts drives real events).
		const [dam] = await asOwner(`INSERT INTO alert_rule (project_id, kind, node_id, threshold) VALUES ($1, 'dam_below', $2, 0.3) RETURNING id`, [published, farm]);
		const [job] = await asOwner(`INSERT INTO alert_rule (project_id, kind, threshold) VALUES ($1, 'job_dead', 1) RETURNING id`, [published]);
		await asOwner(`INSERT INTO alert_event (rule_id, project_id, state, value) VALUES ($1, $2, 'firing', 0.1), ($3, $2, 'firing', 2), ($3, $2, 'cleared', 1)`, [dam.id, published, job.id]);
		try {
			const rows = (await portfolio(admin)).body.projects as PortfolioProject[];
			expect(byId(rows, published)!.alertsFiring).toBe(2);
			expect(byId(rows, runOnly)!.alertsFiring).toBe(0);
			// A team viewer sees the same count (RLS: viewers read every event).
			expect(byId((await portfolio(teamViewer)).body.projects, published)!.alertsFiring).toBe(2);
		} finally {
			await asOwner('DELETE FROM alert_rule WHERE project_id = $1', [published]);
		}
	});
});

describe('the team’s thresholds (D11, 055_team_settings)', () => {
	const setThresholds = (u: User, team: string, t: { green: number; amber: number } | null) =>
		u.call('PATCH', `/teams/${team}`, { settings: { portfolio: { thresholds: t } } });

	it('judge every known status; unset, the defaults apply; the response says which', async () => {
		// A run whose outlet missed its EWR on exactly 3 of the last 30 days (10 %):
		// the shortfall series rewritten as the schema owner, since the count is
		// what's under test here, not the engine.
		const pid = await makeProject(admin, 'Foxtrot thresholds', teamId);
		const runId = await run(admin, pid);
		const until = byId((await portfolio(admin)).body.projects, pid)!.figuresUntil!;
		const [{ start }] = await asOwner(`SELECT to_char(start_date, 'YYYY-MM-DD') AS start FROM model_run WHERE id = $1`, [runId]);
		const last = (Date.parse(until) - Date.parse(start)) / 86_400_000 + 1; // 1-based index of the figures' last day
		const { length } = await asOwner(
			`UPDATE run_series SET "values" = (SELECT array_agg(CASE WHEN g BETWEEN $2::int - 2 AND $2::int THEN -1 ELSE 0 END ORDER BY g) FROM generate_series(1, cardinality("values")) g)
			 WHERE run_id = $1 AND node_id IS NULL AND key = 'ewr_shortfall' RETURNING 1`,
			[runId, last]
		);
		expect(length).toBe(1);

		const before = await portfolio(teamViewer);
		expect(before.body.thresholds).toEqual({ green: 5, amber: 20, source: 'default' });
		const rows = before.body.projects as PortfolioProject[];
		expect(byId(rows, pid)!.ewr).toEqual({ status: 'amber', daysNotMet30: 3, days30: 30, fraction30: 0.1 });
		for (const p of rows.filter((r) => r.ewr.status !== 'unknown')) expect(p.ewr.status).toBe(ewrStatus(p.ewr.daysNotMet30!, p.ewr.days30!));

		try {
			for (const [t, expected] of [
				[{ green: 0, amber: 100 }, 'amber'], // nothing is green
				[{ green: 10.5, amber: 20 }, 'green'],
				[{ green: 10, amber: 20 }, 'amber'], // exactly 10 % is not below 10 %
				[{ green: 1, amber: 2 }, 'red']
			] as const) {
				expect((await setThresholds(admin, teamId, t)).status).toBe(200);
				const res = await portfolio(teamViewer);
				expect(res.body.thresholds).toEqual({ ...t, source: 'team' });
				expect(byId(res.body.projects, pid)!.ewr).toEqual({ status: expected, daysNotMet30: 3, days30: 30, fraction30: 0.1 });
				// Every other row is judged by the same numbers; an unknown stays unknown.
				for (const p of rows) {
					const now = byId(res.body.projects, p.id)!;
					expect(now.ewr).toEqual(p.ewr.status === 'unknown' ? p.ewr : { ...p.ewr, status: ewrStatus(p.ewr.daysNotMet30!, p.ewr.days30!, t) });
				}
			}
		} finally {
			expect((await setThresholds(admin, teamId, null)).status).toBe(200);
		}
		const after = await portfolio(teamViewer);
		expect(after.body.thresholds).toEqual({ green: 5, amber: 20, source: 'default' });
		for (const p of rows) expect(byId(after.body.projects, p.id)!.ewr).toEqual(p.ewr);
	});

	it('another team’s thresholds never reach this team’s rows', async () => {
		expect((await setThresholds(stranger, otherTeamId, { green: 0, amber: 1 })).status).toBe(200);
		try {
			expect((await portfolio(teamViewer)).body.thresholds).toEqual({ green: 5, amber: 20, source: 'default' });
			// Positive control: the other team's own portfolio uses them.
			expect((await portfolio(stranger, otherTeamId)).body.thresholds).toEqual({ green: 0, amber: 1, source: 'team' });
		} finally {
			await setThresholds(stranger, otherTeamId, null);
		}
	});
});

// The project list's outcome columns (issue #17, docs/api.md § Projects): the
// same figures for every project the user can see, personal ones included.
describe('GET /projects/outcomes', () => {
	const ids = (rows: PortfolioProject[]) => rows.map((r) => r.id);

	it('lists every project you can see, personal and team alike, and nobody else’s', async () => {
		const res = await outcomes(admin);
		expect(res.status).toBe(200);
		const mine = ids(res.body.projects);
		expect(mine).toEqual(expect.arrayContaining([published, runOnly, empty, personal]));
		expect(mine).not.toContain(strangersProject);
		// Positive control: the stranger sees their own team's project through the same route.
		expect(ids((await outcomes(stranger)).body.projects)).toContain(strangersProject);
		expect(ids((await outcomes(stranger)).body.projects)).not.toContain(personal);
		// A team viewer sees the team's projects, not the admin's personal one.
		const viewer = ids((await outcomes(teamViewer)).body.projects);
		expect(viewer).toEqual(expect.arrayContaining([published, runOnly, empty]));
		expect(viewer).not.toContain(personal);
	});

	it('gives a team project the same figures as the team portfolio', async () => {
		const [list, team] = await Promise.all([outcomes(teamViewer), portfolio(teamViewer)]);
		for (const row of team.body.projects as PortfolioProject[]) expect(byId(list.body.projects, row.id)).toEqual(row);
	});

	it('judges a team project by its team’s thresholds and a personal one by the defaults', async () => {
		const pid = await makeProject(admin, 'Golf personal thresholds', null);
		await run(admin, pid);
		const before = byId((await outcomes(admin)).body.projects, pid)!;
		expect(before.ewr.status).not.toBe('unknown');
		expect(before.ewr.status).toBe(ewrStatus(before.ewr.daysNotMet30!, before.ewr.days30!));
		// Team thresholds under which nothing is green: team rows follow, the personal one doesn't.
		expect((await admin.call('PATCH', `/teams/${teamId}`, { settings: { portfolio: { thresholds: { green: 0, amber: 100 } } } })).status).toBe(200);
		try {
			const rows = (await outcomes(admin)).body.projects as PortfolioProject[];
			expect(byId(rows, pid)!.ewr).toEqual(before.ewr);
			const teamRows = (await portfolio(admin)).body.projects as PortfolioProject[];
			for (const t of teamRows) expect(byId(rows, t.id)!.ewr).toEqual(t.ewr);
			expect(teamRows.some((t) => t.ewr.status === 'amber')).toBe(true);
		} finally {
			await admin.call('PATCH', `/teams/${teamId}`, { settings: { portfolio: { thresholds: null } } });
		}
	});

	it('a project shared directly from a team you aren’t in is judged by the defaults (you can’t read that team)', async () => {
		const [outsider] = (await Promise.all(['PfOutsider'].map((n) => signUp(n)))) as [User];
		const pid = await makeProject(admin, 'Hotel shared out', teamId);
		const runId = await run(admin, pid);
		// The outlet met its EWR every day (arranged as the schema owner: the judging is under test, not the engine).
		await asOwner(`UPDATE run_series SET "values" = array_fill(0::float8, ARRAY[cardinality("values")]) WHERE run_id = $1 AND node_id IS NULL AND key = 'ewr_shortfall'`, [runId]);
		expect((await admin.call('POST', `/projects/${pid}/members`, { email: outsider.email, role: 'viewer' })).status).toBe(201);
		// Team thresholds under which nothing is green.
		expect((await admin.call('PATCH', `/teams/${teamId}`, { settings: { portfolio: { thresholds: { green: 0, amber: 100 } } } })).status).toBe(200);
		try {
			const rows = (await outcomes(outsider)).body.projects as PortfolioProject[];
			expect(ids(rows)).toEqual([pid]);
			expect(rows[0]).toMatchObject({ role: 'viewer', ewr: { status: 'green', daysNotMet30: 0, days30: 30 } });
			// Positive control: a team member sees the team's judgement of the same figures.
			expect(byId((await outcomes(admin)).body.projects, pid)!.ewr).toMatchObject({ status: 'amber', daysNotMet30: 0, days30: 30 });
		} finally {
			await admin.call('PATCH', `/teams/${teamId}`, { settings: { portfolio: { thresholds: null } } });
		}
	});

	it('leaves out a project where you are a farmer or an applicant, and keeps it for a viewer', async () => {
		// The farmer and applicant were added to `published` above.
		expect(ids((await outcomes(farmer)).body.projects)).not.toContain(published);
		expect(await withUser(farmer.id, (db) => loadMyOutcomes(db, new Date()))).toEqual([]);
		// Positive control: the same project reaches the team viewer.
		expect(ids((await outcomes(teamViewer)).body.projects)).toContain(published);
	});

	it('reads every project in one query', async () => {
		let queries = 0;
		const rows = await withUser(admin.id, (db) => {
			const counting = { query: (...args: unknown[]) => (queries++, (db.query as (...a: unknown[]) => unknown)(...args)) } as unknown as Db;
			return loadMyOutcomes(counting, new Date());
		});
		expect(rows.length).toBeGreaterThanOrEqual(4);
		expect(queries).toBe(1);
	});
});
