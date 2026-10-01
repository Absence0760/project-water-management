// Seasonal outlooks end to end (issue #53 R5, 063_seasonal_outlook.sql): the
// project settings (settings.outlook), the POST /outlooks checks, the
// `outlook` job run as its acting user (the memory transport: the test runs
// the tick itself), each member stored once and the engine's summary as the
// result, a level whose ops don't apply, RLS (with a positive control),
// write-once members and outcomes, the per-user limit, the project's cap,
// and the job failing closed when its user lost the editor role.
//
// Synthetic catchment: a farm dam draining to an outlet gauge, 13 water
// years (2000/01 … 2012/13) of invented winter rain, each year scaled
// differently. Enough years (≥ OUTLOOK_MIN_YEARS) for percentiles.
import { randomUUID } from 'node:crypto';
import { OUTLOOK_MIN_YEARS } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { OUTLOOK_LEVELS_MAX, OUTLOOKS_KEPT } from './schema.js';

type User = Awaited<ReturnType<typeof signUp>>;

const START = '2000-10-01';
const DAY = 86_400_000;
/** Rain multiplier per water year 2000/01 … 2012/13 (invented). */
const YEAR_SCALE = [1.0, 0.4, 1.3, 0.7, 1.1, 0.3, 0.9, 1.5, 0.5, 1.2, 0.6, 1.0, 0.8];
/** mm on a rain day, by calendar month (a winter-rainfall shape, invented). */
const MONTH_MM = [2, 2, 4, 8, 14, 18, 18, 16, 10, 6, 4, 2];

function rainRecord() {
	const days = (Date.parse('2013-10-01T00:00:00Z') - Date.parse(`${START}T00:00:00Z`)) / DAY;
	return Array.from({ length: days }, (_, t) => {
		const d = new Date(Date.parse(`${START}T00:00:00Z`) + t * DAY);
		const wy = d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
		return t % 3 === 0 ? Math.round(MONTH_MM[d.getUTCMonth()]! * YEAR_SCALE[wy - 2000]! * 10) / 10 : 0;
	});
}

/** 13 water years, one saved run (to 30 September 2013). Invented values. */
async function catchment(owner: User, name = 'Outlook') {
	const projectId = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Farm', outlet.id, { pctRunoffToDam: 1, damCapacityM3: 80_000, damInitialPct: 0.5, damMinPct: 0 });
	const crop = { id: randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 150_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110], ewrPragmaticM3PerDay: monthly(800) } })).status).toBe(200);
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rainRecord() })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'base' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	return { projectId, outlet, farm, runId: run.body.run.id as string };
}

async function member(owner: User, projectId: string, u: User, role: 'viewer' | 'editor' | 'owner') {
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
}

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const job = async (id: string) => (await asOwner('SELECT status, last_error, progress FROM job WHERE id = $1', [id]))[0] as { status: string; last_error: string | null; progress: number | null };
const scale = (factor: number, extra: Record<string, unknown> = {}) => [{ op: 'demand.scale', factor, ...extra }];
const demandLevels = [
	{ label: '100 %', ops: scale(1) },
	{ label: '85 %', ops: scale(0.85) },
	{ label: '70 %', ops: scale(0.7) }
];
const outlookOf = (runId: string, extra: Record<string, unknown> = {}, levels: unknown[] = demandLevels) => ({ name: 'Summer outlook', baseRunId: runId, levels, ...extra });

describe('settings.outlook', () => {
	it('an editor sets the season and share, a viewer reads them but cannot change them; no model input', async () => {
		const owner = await signUp('OutlookSetOwner');
		const viewer = await signUp('OutlookSetViewer');
		const c = await catchment(owner);
		await member(owner, c.projectId, viewer, 'viewer');
		const before = (await owner.call('GET', `/projects/${c.projectId}`)).body.project;
		// The defaults (O3, O6, confirmed by the client), from the start.
		expect(before.settings.outlook).toEqual({ season: null, planningShare: null, review: null });

		const outlook = { season: { startMonth: 11, startDay: 1, endMonth: 3, endDay: 31 }, planningShare: 0.7, review: { month: 2, day: 1 } };
		// The Settings form sends every setting: the whole document with only outlook changed leaves updatedAt alone.
		const set = await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { ...before.settings, outlook } });
		expect(set.status).toBe(200);
		expect(set.body.project.settings.outlook).toEqual(outlook);
		expect(set.body.project.updatedAt).toBe(before.updatedAt);
		// Positive control: the viewer reads it.
		expect((await viewer.call('GET', `/projects/${c.projectId}`)).body.project.settings.outlook).toEqual(outlook);
		expect((await viewer.call('PATCH', `/projects/${c.projectId}`, { settings: { outlook: { planningShare: 0.9 } } })).status).toBe(403);

		const bad = await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { outlook: { season: { startMonth: 2, startDay: 29, endMonth: 4, endDay: 30 } } } });
		expect(bad.status).toBe(400);
		expect(JSON.stringify(bad.body)).toContain('29 February');
		expect((await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { outlook: { planningShare: 0 } } })).status).toBe(400);

		// A run doesn't record it.
		const run = await owner.call('POST', `/projects/${c.projectId}/runs`, { label: 'r' });
		expect((await owner.call('GET', `/projects/${c.projectId}/runs/${run.body.run.id}`)).body.run.settings).not.toHaveProperty('outlook');
	});
});

describe('POST /projects/:id/outlooks', () => {
	it('an editor runs 100 / 85 / 70 % from the run’s newest state; the job stores every member and the engine’s summary', async () => {
		const owner = await signUp('OutlookOwner');
		const c = await catchment(owner);
		const res = await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId));
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		const { outlook, jobId } = res.body;
		// The default season (1 October – 30 April, O3) from the day after the run's last.
		expect(outlook).toMatchObject({
			name: 'Summer outlook',
			baseRunId: c.runId,
			baseRun: { id: c.runId, label: 'base' },
			decisionDate: '2013-10-01',
			seasonEnd: '2014-04-30',
			planningShare: null,
			analogueYears: null,
			status: 'pending',
			engineVersion: null,
			createdBy: 'OutlookOwner',
			job: { id: jobId, status: 'queued' }
		});
		expect(outlook.levels).toEqual([
			{ id: '0', label: '100 %', ops: scale(1) },
			{ id: '1', label: '85 %', ops: scale(0.85) },
			{ id: '2', label: '70 %', ops: scale(0.7) }
		]);
		expect(outlook).not.toHaveProperty('result');
		expect((await owner.call('GET', `/projects/${c.projectId}/jobs`)).body.jobs[0]).toMatchObject({ id: jobId, kind: 'outlook', status: 'queued' });

		await tick();
		expect(await job(jobId)).toMatchObject({ status: 'done', progress: 100 });
		const got = await owner.call('GET', `/projects/${c.projectId}/outlooks/${outlook.id}`);
		expect(got.status).toBe(200);
		const o = got.body.outlook;
		expect(o).toMatchObject({ status: 'complete', job: { status: 'done', progress: 100 } });
		expect(o.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
		const r = o.result;
		// Every water year whose season lies in the record: 2000/01 … 2012/13 (2013/14, the season itself, lies wholly after it: not a candidate).
		expect(r).toMatchObject({ decisionDate: '2013-10-01', seasonEnd: '2014-04-30', days: 212, metric: 'daysBelowEwr', nYears: 13, enoughYears: true, failures: [] });
		expect(13).toBeGreaterThanOrEqual(OUTLOOK_MIN_YEARS);
		expect(r.analogues.map((a: { waterYear: number }) => a.waterYear)).toEqual([2000, 2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010, 2011, 2012]);
		expect(r.excluded).toEqual([]);
		expect(r.capacityM3).toBe(80_000);
		expect(r.levels.map((l: { label: string; nYears: number; problems: string[] }) => [l.label, l.nYears, l.problems])).toEqual([
			['100 %', 13, []],
			['85 %', 13, []],
			['70 %', 13, []]
		]);
		for (const l of r.levels) {
			for (const k of ['seasonEndStorageM3', 'demandMet', 'ewr']) {
				const s = l[k] as { p10: number; p50: number; p90: number };
				expect(s.p10, `${l.label} ${k}`).toBeLessThanOrEqual(s.p50);
				expect(s.p50).toBeLessThanOrEqual(s.p90);
			}
			expect(l.years).toHaveLength(13);
		}
		// A lower level asks for less water, in every year (the engine's invariant, through the whole pipeline).
		for (let i = 0; i < 13; i++) {
			expect(r.levels[1].years[i].demandM3).toBeCloseTo(0.85 * r.levels[0].years[i].demandM3, 6);
			expect(r.levels[2].years[i].demandM3).toBeCloseTo(0.7 * r.levels[0].years[i].demandM3, 6);
		}
		expect(r.planning).toMatchObject({ share: 0.8, shareIsDefault: true, nYears: 13 });
		expect(r.planning.ranked.map((x: { label: string }) => x.label)).toEqual(['100 %', '85 %', '70 %']);

		// Each member is stored once, as the result's year says (the result adds the metric).
		const rows = (await asOwner(
			`SELECT level_position AS pos, water_year AS wy, status, member FROM seasonal_outlook_member WHERE outlook_id = $1 ORDER BY level_position, water_year`,
			[outlook.id]
		)) as { pos: number; wy: number; status: string; member: Record<string, unknown> }[];
		expect(rows).toHaveLength(39);
		for (const m of rows) {
			expect(m.status).toBe('done');
			const year = r.levels[m.pos].years.find((y: { waterYear: number }) => y.waterYear === m.wy);
			expect(year).toMatchObject(m.member);
		}

		// The list leaves the result out; ?baseRunId filters.
		const list = await owner.call('GET', `/projects/${c.projectId}/outlooks`);
		expect(list.body.outlooks.map((x: { id: string }) => x.id)).toEqual([outlook.id]);
		expect(list.body.outlooks[0]).not.toHaveProperty('result');
		expect((await owner.call('GET', `/projects/${c.projectId}/outlooks?baseRunId=${randomUUID()}`)).body.outlooks).toEqual([]);
		expect((await owner.call('GET', `/projects/${c.projectId}/outlooks?baseRunId=${c.runId}`)).body.outlooks).toHaveLength(1);
		expect((await owner.call('GET', `/projects/${c.projectId}/outlooks?baseRunId=x`)).status).toBe(400);
	});

	it('a hindcast of the run’s own season at 100 % reproduces the base run’s season-end storage', async () => {
		const owner = await signUp('OutlookHindcast');
		const c = await catchment(owner);
		const body = outlookOf(c.runId, { decisionDate: '2012-10-01', seasonEnd: '2013-04-30', analogueYears: [2012] }, [{ label: 'As is', ops: [] }]);
		const res = await owner.call('POST', `/projects/${c.projectId}/outlooks`, body);
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		await tick();
		const r = (await owner.call('GET', `/projects/${c.projectId}/outlooks/${res.body.outlook.id}`)).body.outlook.result;
		// One year: no percentiles, no planning figure, and a warning saying so.
		expect(r).toMatchObject({ nYears: 1, enoughYears: false, planning: { reason: 'notEnoughYears', levelId: null } });
		expect(r.levels[0].ewr).toBeNull();
		expect(r.warnings.join(' ')).toMatch(/at least 10 are needed/);
		const [stored] = (await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = 'dam_storage'`, [c.runId, c.farm.id])) as [{ values: number[] }];
		const t = (Date.parse('2013-04-30T00:00:00Z') - Date.parse(`${START}T00:00:00Z`)) / DAY;
		expect(stored.values[t]).toBeGreaterThan(0);
		expect(r.levels[0].years[0].seasonEndStorageM3).toBeCloseTo(stored.values[t]!, 3);
		// The state it started from: the base run's storage at the end of 30 September 2012.
		expect(r.startStorageM3).toBeCloseTo(stored.values[t - 211]!, 6);
	});

	it('takes the season and share from the project’s settings, and the body’s share over them', async () => {
		const owner = await signUp('OutlookSettings');
		const c = await catchment(owner);
		const outlook = { season: { startMonth: 11, startDay: 15, endMonth: 2, endDay: 28 }, planningShare: 0.6 };
		expect((await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { outlook } })).status).toBe(200);
		const one = (await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { analogueYears: [2010, 2011] }))).body.outlook;
		// The latest 15 November whose day before the run holds: 2012 (the run ends 30 September 2013).
		expect(one).toMatchObject({ decisionDate: '2012-11-15', seasonEnd: '2013-02-28', planningShare: 0.6 });
		const two = (await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { analogueYears: [2010, 2011], planningShare: 0.9 }))).body.outlook;
		expect(two.planningShare).toBe(0.9);
		await tick();
		const r = (await owner.call('GET', `/projects/${c.projectId}/outlooks/${one.id}`)).body.outlook.result;
		expect(r.planning).toMatchObject({ share: 0.6, shareIsDefault: false });
		expect(r.analogues.map((a: { waterYear: number; from: string }) => [a.waterYear, a.from])).toEqual([
			[2010, '2010-11-15'],
			[2011, '2011-11-15']
		]);
	});

	it('a level whose ops don’t apply is reported, not run; the other levels still run and the outlook completes', async () => {
		const owner = await signUp('OutlookProblems');
		const c = await catchment(owner);
		const missing = randomUUID();
		const levels = [
			{ label: 'Half', ops: scale(0.5) },
			{ label: 'Gone farm', ops: scale(0.5, { nodeIds: [missing] }) },
			{ label: 'Taper', ops: [...scale(1, { months: [10, 11, 12] }), ...scale(0.6, { months: [1, 2, 3, 4] })] }
		];
		const { outlook, jobId } = (await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { analogueYears: [2009, 2010, 2011] }, levels))).body;
		await tick();
		expect((await job(jobId)).status).toBe('done');
		const r = (await owner.call('GET', `/projects/${c.projectId}/outlooks/${outlook.id}`)).body.outlook.result;
		expect(r.levels[0]).toMatchObject({ label: 'Half', problems: [], nYears: 3 });
		expect(r.levels[1]).toMatchObject({ label: 'Gone farm', nYears: 0, years: [] });
		expect(r.levels[1].problems[0]).toMatch(/^op 1 \(demand\.scale\)/);
		expect(r.levels[1].problems[0]).toContain(missing);
		expect(r.levels[2]).toMatchObject({ label: 'Taper', problems: [], nYears: 3 });
		expect(r.warnings.join(' ')).toContain('Gone farm: not run');
		expect(await asOwner('SELECT id FROM seasonal_outlook_member WHERE outlook_id = $1 AND level_position = 1', [outlook.id])).toEqual([]);
		// The monthly plan scales October–December by 1 and January–April by 0.6: less water than 100 %, more than 60 % throughout.
		const half = r.levels[0].years[0].demandM3;
		expect(r.levels[2].years[0].demandM3).toBeGreaterThan(half * 1.2);
		expect(r.levels[2].years[0].demandM3).toBeLessThan(half * 2);
	});

	it('refuses a base run that isn’t this project’s, ops that aren’t demand.scale, too many levels, and a season the run can’t start', async () => {
		const owner = await signUp('OutlookBad');
		const a = await catchment(owner, 'A');
		const b = await catchment(owner, 'B');
		const post = (body: unknown) => owner.call('POST', `/projects/${a.projectId}/outlooks`, body);
		expect((await post(outlookOf(b.runId))).status).toBe(404);
		expect((await post(outlookOf(randomUUID()))).status).toBe(404);
		const other = await post(outlookOf(a.runId, {}, [{ label: 'Dam', ops: [{ op: 'node.set', nodeId: a.farm.id, field: 'damCapacityM3', value: 1 }] }]));
		expect(other.status).toBe(400);
		expect(JSON.stringify(other.body)).toContain('only demand.scale ops make a demand level');
		const many = Array.from({ length: OUTLOOK_LEVELS_MAX + 1 }, (_, i) => ({ label: `L${i}`, ops: scale(i / 10) }));
		expect((await post(outlookOf(a.runId, {}, many))).status).toBe(400);
		// After the day after the run's last: the state on the day before isn't known.
		const late = await post(outlookOf(a.runId, { decisionDate: '2013-10-02', seasonEnd: '2014-04-30' }));
		expect(late.status).toBe(422);
		expect(late.body.error).toMatch(/^the decision date must fall after the base run's first day \(2000-10-01\)/);
		expect((await post(outlookOf(a.runId, { decisionDate: '2000-10-01', seasonEnd: '2001-04-30' }))).status).toBe(422);
		// No database text in any of them.
		for (const r of [late, other]) expect(JSON.stringify(r.body)).not.toMatch(/violat|constraint|relation|syntax/i);
		expect((await owner.call('GET', `/projects/${a.projectId}/outlooks`)).body.outlooks).toEqual([]);
		expect((await owner.call('GET', `/projects/${a.projectId}/outlooks/not-a-uuid`)).status).toBe(404);
		expect((await owner.call('GET', `/projects/${a.projectId}/outlooks/${randomUUID()}`)).status).toBe(404);
	});

	it('at most 2 queued or running outlooks per user (429 for a third)', async () => {
		const owner = await signUp('OutlookLimit');
		const c = await catchment(owner);
		const post = () => owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { analogueYears: [2012] }, [{ label: 'one', ops: [] }]));
		expect((await post()).status).toBe(202);
		expect((await post()).status).toBe(202);
		const third = await post();
		expect(third.status).toBe(429);
		expect(third.body.error).toBe('you already have 2 outlooks queued or running; wait for one to finish');
		await tick();
		expect((await post()).status).toBe(202);
		await tick();
	});

	it(`keeps the project’s newest ${OUTLOOKS_KEPT} outlooks, and one goes with its base run`, async () => {
		const owner = await signUp('OutlookKept');
		const c = await catchment(owner);
		const ids: string[] = [];
		for (let i = 0; i <= OUTLOOKS_KEPT; i++) {
			const res = await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { name: `Outlook ${i}`, analogueYears: [2012] }, [{ label: 'one', ops: [] }]));
			expect(res.status).toBe(202);
			ids.push(res.body.outlook.id);
			await tick();
		}
		const listed = (await owner.call('GET', `/projects/${c.projectId}/outlooks`)).body.outlooks.map((s: { id: string }) => s.id);
		expect(listed).toEqual(ids.slice(1).reverse());
		expect(await asOwner('SELECT id FROM seasonal_outlook_member WHERE outlook_id = $1', [ids[0]])).toEqual([]);
		expect((await owner.call('DELETE', `/projects/${c.projectId}/runs/${c.runId}`)).status).toBe(204);
		expect((await owner.call('GET', `/projects/${c.projectId}/outlooks`)).body.outlooks).toEqual([]);
		expect(await asOwner('SELECT id FROM seasonal_outlook_member WHERE project_id = $1', [c.projectId])).toEqual([]);
	});

	it('the job fails closed when its user is no longer an editor: the outlook stays pending, its job says why', async () => {
		const owner = await signUp('OutlookDemoteOwner');
		const ed = await signUp('OutlookDemoted');
		const c = await catchment(owner);
		await member(owner, c.projectId, ed, 'editor');
		const res = await ed.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { analogueYears: [2012] }));
		expect(res.status).toBe(202);
		expect((await owner.call('PATCH', `/projects/${c.projectId}/members/${ed.id}`, { role: 'viewer' })).status).toBe(200);
		await tick();
		const reason = 'the user who queued this job no longer has the editor role on the project';
		expect(await job(res.body.jobId)).toMatchObject({ status: 'dead', last_error: reason });
		const o = (await owner.call('GET', `/projects/${c.projectId}/outlooks/${res.body.outlook.id}`)).body.outlook;
		expect(o).toMatchObject({ status: 'pending', result: null, job: { status: 'dead', error: reason } });
	});
});

describe('seasonal_outlook RLS', () => {
	it('a viewer reads outlooks but may not start one; an outsider sees nothing', async () => {
		const owner = await signUp('OutlookRlsOwner');
		const viewer = await signUp('OutlookRlsViewer');
		const outsider = await signUp('OutlookRlsOutsider');
		const c = await catchment(owner);
		await member(owner, c.projectId, viewer, 'viewer');
		const { outlook } = (await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { analogueYears: [2011, 2012] }))).body;
		await tick();

		// Positive control: the viewer sees the owner's outlook, its result and its members.
		const seen = await viewer.call('GET', `/projects/${c.projectId}/outlooks/${outlook.id}`);
		expect(seen.status).toBe(200);
		expect(seen.body.outlook.result.levels).toHaveLength(3);
		expect((await viewer.call('GET', `/projects/${c.projectId}/outlooks`)).body.outlooks).toHaveLength(1);
		const rowsAs = (u: User, table: string) => withUser(u.id, async (db) => (await db.query(`SELECT id FROM ${table} WHERE project_id = $1`, [c.projectId])).rows);
		expect(await rowsAs(viewer, 'seasonal_outlook')).toHaveLength(1);
		expect(await rowsAs(viewer, 'seasonal_outlook_member')).toHaveLength(6);

		expect((await viewer.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId))).status).toBe(403);
		await expect(
			withUser(viewer.id, (db) =>
				db.query(`INSERT INTO seasonal_outlook (project_id, base_run_id, name, decision_date, season_end, levels) VALUES ($1, $2, 'x', '2012-10-01', '2013-04-30', '[{}]')`, [
					c.projectId,
					c.runId
				])
			)
		).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(viewer.id, (db) => db.query('DELETE FROM seasonal_outlook WHERE id = $1 RETURNING id', [outlook.id]))).resolves.toMatchObject({ rows: [] });

		expect((await outsider.call('GET', `/projects/${c.projectId}/outlooks`)).status).toBe(404);
		expect((await outsider.call('GET', `/projects/${c.projectId}/outlooks/${outlook.id}`)).status).toBe(404);
		expect(await rowsAs(outsider, 'seasonal_outlook')).toEqual([]);
		expect(await rowsAs(outsider, 'seasonal_outlook_member')).toEqual([]);
	});

	it('names a base run and job of its own project only, and an ordinary run', async () => {
		const owner = await signUp('OutlookCross');
		const a = await catchment(owner, 'A');
		const b = await catchment(owner, 'B');
		const insert = (projectId: string, runId: string) =>
			withUser(owner.id, (db) =>
				db.query(`INSERT INTO seasonal_outlook (project_id, base_run_id, name, decision_date, season_end, levels) VALUES ($1, $2, 'x', '2012-10-01', '2013-04-30', '[{}]')`, [
					projectId,
					runId
				])
			);
		await expect(insert(a.projectId, b.runId)).rejects.toMatchObject({ code: '23503' });
		await asOwner(`UPDATE model_run SET "trigger" = 'forecast' WHERE id = $1`, [b.runId]);
		await expect(insert(b.projectId, b.runId)).rejects.toMatchObject({ code: '23514' });
		// A member of another project's outlook.
		const { outlook } = (await owner.call('POST', `/projects/${a.projectId}/outlooks`, outlookOf(a.runId, { analogueYears: [2012] }))).body;
		await expect(
			withUser(owner.id, (db) =>
				db.query(`INSERT INTO seasonal_outlook_member (outlook_id, project_id, level_position, water_year, status, problems) VALUES ($1, $2, 0, 2012, 'failed', '["x"]')`, [
					outlook.id,
					b.projectId
				])
			)
		).rejects.toMatchObject({ code: '23503' });
		await tick();
	});

	it('members are written once, by whoever asked, and never updated; the outcome is stored once', async () => {
		const owner = await signUp('OutlookOnceOwner');
		const ed = await signUp('OutlookOnceEditor');
		const c = await catchment(owner);
		await member(owner, c.projectId, ed, 'editor');
		const { outlook } = (await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { analogueYears: [2012] }))).body;
		const forge = (u: User) =>
			withUser(u.id, (db) =>
				db.query(`INSERT INTO seasonal_outlook_member (outlook_id, project_id, level_position, water_year, status, problems) VALUES ($1, $2, 0, 2012, 'failed', '["forged"]')`, [
					outlook.id,
					c.projectId
				])
			);
		// Another editor can't write a member of an outlook they didn't ask for.
		await expect(forge(ed)).rejects.toMatchObject({ code: '42501' });
		// Nor may anyone change the season or levels (not in the column grant), nor complete it without a result.
		await expect(withUser(owner.id, (db) => db.query(`UPDATE seasonal_outlook SET levels = '[]' WHERE id = $1`, [outlook.id]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query(`UPDATE seasonal_outlook SET status = 'complete', engine_version = 'x' WHERE id = $1`, [outlook.id]))).rejects.toMatchObject({
			code: '23514'
		});
		// Nor complete someone else's.
		await expect(
			withUser(ed.id, (db) => db.query(`UPDATE seasonal_outlook SET status = 'complete', engine_version = 'x', result = '{}' WHERE id = $1`, [outlook.id]))
		).rejects.toMatchObject({ code: '42501' });
		await tick();
		const [m] = (await asOwner('SELECT id, status FROM seasonal_outlook_member WHERE outlook_id = $1 AND level_position = 0', [outlook.id])) as [{ id: string; status: string }];
		expect(m.status).toBe('done');
		// No UPDATE on a member at all, even by whoever asked.
		await expect(withUser(owner.id, (db) => db.query(`UPDATE seasonal_outlook_member SET status = 'failed', problems = '["x"]' WHERE id = $1`, [m.id]))).rejects.toMatchObject({
			code: '42501'
		});
		// A complete outlook takes no new members, and its outcome doesn't change (the update policy sees only pending rows).
		await expect(forge(owner)).rejects.toMatchObject({ code: '23514' });
		const upd = await withUser(owner.id, (db) => db.query(`UPDATE seasonal_outlook SET result = '{}' WHERE id = $1 RETURNING id`, [outlook.id]));
		expect(upd.rows).toEqual([]);
	});

	it('the 30-day job clean-up clears an outlook’s job and keeps the outlook, complete or pending (148_job_purge_clears_links)', async () => {
		const owner = await signUp('OutlookPurge');
		const c = await catchment(owner);
		const one = [{ label: 'one', ops: [] }];
		const done = (await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { name: 'Done', analogueYears: [2012] }, one))).body;
		await tick();
		const stuck = (await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { name: 'Stuck', analogueYears: [2012] }, one))).body;
		// The second outlook's job died before it ran: the outlook stays pending.
		await asOwner(`UPDATE job SET status = 'dead', finished_at = now() WHERE id = $1`, [stuck.jobId]);
		const cols = 'id, status, completed_at, engine_version, result';
		const before = await asOwner(`SELECT ${cols} FROM seasonal_outlook WHERE project_id = $1 ORDER BY name`, [c.projectId]);
		expect(before.map((r) => r.status)).toEqual(['complete', 'pending']);

		await asOwner(`UPDATE job SET finished_at = now() - interval '31 days' WHERE id = ANY($1)`, [[done.jobId, stuck.jobId]]);
		expect((await tick()).purged).toBeGreaterThanOrEqual(2);
		expect(await asOwner('SELECT id FROM job WHERE project_id = $1', [c.projectId])).toEqual([]);
		const after = await asOwner(`SELECT ${cols}, job_id FROM seasonal_outlook WHERE project_id = $1 ORDER BY name`, [c.projectId]);
		expect(after).toEqual(before.map((r) => ({ ...r, job_id: null })));
		const got = await owner.call('GET', `/projects/${c.projectId}/outlooks/${done.outlook.id}`);
		expect(got.status).toBe(200);
		expect(got.body.outlook).toMatchObject({ status: 'complete', job: null });

		// Positive control: the guard still refuses a real change, alone or beside a cleared link, even by the schema owner.
		await expect(asOwner(`UPDATE seasonal_outlook SET result = '{}' WHERE id = $1`, [done.outlook.id])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`UPDATE seasonal_outlook SET created_by = NULL, name = 'Changed' WHERE id = $1`, [done.outlook.id])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`UPDATE seasonal_outlook SET job_id = $2 WHERE id = $1`, [done.outlook.id, done.jobId])).rejects.toMatchObject({ code: '23514' });
	});
});

describe('the drought restriction rule (engine 1.54.0, WP-3.8)', () => {
	it('the job runs the outlook and its triggers without the rule: the same result and table as with none', async () => {
		const owner = await signUp('DroughtOutlook');
		const c = await catchment(owner, 'Outlook with restrictions');
		const done = async (runId: string) => {
			const res = await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(runId));
			expect(res.status, JSON.stringify(res.body)).toBe(202);
			await tick();
			expect(await job(res.body.jobId)).toMatchObject({ status: 'done' });
			return (await owner.call('GET', `/projects/${c.projectId}/outlooks/${res.body.outlook.id}`)).body.outlook;
		};
		const plain = await done(c.runId);
		// A rule that restricts this catchment (reviewed monthly, crops halved below 90 %), and a base run under it.
		const rule = { reviewDates: Array.from({ length: 12 }, (_, m) => `${String(m + 1).padStart(2, '0')}-01`), levels: [{ belowPct: 0.9, cuts: { crops: 0.5 } }] };
		expect((await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { droughtRestriction: rule } })).status).toBe(200);
		const ruled = await owner.call('POST', `/projects/${c.projectId}/runs`, { label: 'restricted' });
		expect(ruled.status).toBe(201);
		const summary = (await owner.call('GET', `/projects/${c.projectId}/runs/${ruled.body.run.id}`)).body.run.summary;
		expect(summary.droughtRestriction.daysByLevel[1]).toBeGreaterThan(0);
		const withRule = await done(ruled.body.run.id);
		// Had the job kept the rule, every level would be cut twice and the history would differ.
		expect(withRule.result).toEqual(plain.result);
		expect(withRule.triggers.table).toEqual(plain.triggers.table);
	});
});

describe('review triggers (issue #53 R6)', () => {
	it('an outlook carries its season’s review date and a trigger table drawn on the latest one the record holds', async () => {
		const owner = await signUp('TriggerOwner');
		const c = await catchment(owner);
		const res = await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId));
		expect(res.status, JSON.stringify(res.body)).toBe(202);
		// The engine's defaultReviewDate for 1 October – 30 April: 1 January (O3).
		expect(res.body.outlook.reviewDate).toBe('2014-01-01');
		await tick();
		expect(await job(res.body.jobId)).toMatchObject({ status: 'done', progress: 100 });
		const o = (await owner.call('GET', `/projects/${c.projectId}/outlooks/${res.body.outlook.id}`)).body.outlook;
		const t = o.triggers;
		expect(t).toMatchObject({ reviewDate: '2014-01-01', problem: null, failures: [] });
		// The run ends on 30 September 2013: its latest 1 January with a day before is 2013's, to 30 April 2013.
		expect(t.table).toMatchObject({ reviewDate: '2013-01-01', seasonEnd: '2013-04-30', bandSource: 'historicalTerciles', representative: 'lowerEdge', capacityM3: 80_000 });
		// Thirteen water years hold 1 January (2001 … 2013); the table's own season (2012/13) is left out of its analogues.
		expect(t.table.history).toHaveLength(13);
		expect(t.table.nYears).toBe(12);
		expect(t.excluded).toContainEqual({ waterYear: 2012, reason: 'theSeason' });
		// Three bands, fullest first, covering 0 … capacity; each row's pick is one of the levels, or none.
		const rows = t.table.rows as { band: { fromM3: number; toM3: number }; level: { id: string } | null; perLevel: { levelId: string }[]; outlook?: unknown }[];
		expect(rows).toHaveLength(3);
		expect(rows[0]!.band.toM3).toBe(80_000);
		expect(rows[2]!.band.fromM3).toBe(0);
		for (let i = 1; i < rows.length; i++) expect(rows[i]!.band.toM3).toBe(rows[i - 1]!.band.fromM3);
		for (const r of rows) {
			expect(r).not.toHaveProperty('outlook');
			expect(r.perLevel.map((l) => l.levelId).sort()).toEqual(['0', '1', '2']);
			if (r.level) expect(['0', '1', '2']).toContain(r.level.id);
		}
		// The list stays light: no table there.
		const list = (await owner.call('GET', `/projects/${c.projectId}/outlooks`)).body.outlooks[0];
		expect(list).toMatchObject({ reviewDate: '2014-01-01' });
		expect(list).not.toHaveProperty('triggers');
	});

	it('takes the project’s review date, or the request’s; null asks for no table', async () => {
		const owner = await signUp('TriggerDates');
		const c = await catchment(owner);
		expect((await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { outlook: { review: { month: 2, day: 1 } } } })).status).toBe(200);
		const fromSetting = await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId));
		expect(fromSetting.body.outlook.reviewDate).toBe('2014-02-01');
		const given = await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { reviewDate: '2013-12-15' }));
		expect(given.body.outlook.reviewDate).toBe('2013-12-15');
		// Two pending per person: let those finish.
		await tick();
		const none = await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { reviewDate: null }));
		expect(none.status).toBe(202);
		expect(none.body.outlook.reviewDate).toBeNull();
		await tick();
		const got = (await owner.call('GET', `/projects/${c.projectId}/outlooks/${none.body.outlook.id}`)).body.outlook;
		expect(got).toMatchObject({ status: 'complete', triggers: null });
		// Positive control: the one from the setting has its table.
		const withTable = (await owner.call('GET', `/projects/${c.projectId}/outlooks/${fromSetting.body.outlook.id}`)).body.outlook;
		expect(withTable.triggers.table.reviewDate).toBe('2013-02-01');
	});

	it('refuses a review date outside the season, and one for a catchment with no farm dam', async () => {
		const owner = await signUp('TriggerBad');
		const c = await catchment(owner);
		for (const reviewDate of ['2013-10-01', '2014-05-01', '2013-09-01']) {
			const r = await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { reviewDate }));
			expect(r.status, reviewDate).toBe(422);
			expect(r.body.error).toMatch(/review date must fall after the decision date/);
		}
		// With the season in the body, the schema says so.
		const inBody = await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { decisionDate: '2012-10-01', seasonEnd: '2013-04-30', reviewDate: '2013-06-01' }));
		expect(inBody.status).toBe(400);
		// A season in the request that the setting's day doesn't fall in: the engine's default for that season (its middle day, 31 March), not a refusal.
		expect((await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { outlook: { review: { month: 1, day: 1 } } } })).status).toBe(200);
		const spring = await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId, { decisionDate: '2013-03-01', seasonEnd: '2013-04-30' }));
		expect(spring.status, JSON.stringify(spring.body)).toBe(202);
		expect(spring.body.outlook.reviewDate).toBe('2013-03-31');
		await tick();
		// The project's setting outside the default season: said so, not a dead job.
		expect((await owner.call('PATCH', `/projects/${c.projectId}`, { settings: { outlook: { review: { month: 7, day: 1 } } } })).status).toBe(200);
		const setting = await owner.call('POST', `/projects/${c.projectId}/outlooks`, outlookOf(c.runId));
		expect(setting.status).toBe(422);
		expect(setting.body.error).toMatch(/review date setting doesn't fit this season/);

		const dry = await signUp('TriggerNoDam');
		const d = await catchment(dry, 'No dam');
		const model = (await dry.call('GET', `/projects/${d.projectId}/model`)).body;
		const nodes = model.nodes.map((n: { kind: string }) => (n.kind === 'farm' ? { ...n, damCapacityM3: 0, damInitialPct: 0 } : n));
		expect((await dry.call('PUT', `/projects/${d.projectId}/model`, { ...model, nodes })).status).toBe(200);
		const run = (await dry.call('POST', `/projects/${d.projectId}/runs`, { label: 'no dam' })).body.run.id;
		expect((await dry.call('POST', `/projects/${d.projectId}/outlooks`, outlookOf(run, { reviewDate: '2014-01-01' }))).status).toBe(422);
		// Without asking for one: no table, the outlook still runs.
		const plain = await dry.call('POST', `/projects/${d.projectId}/outlooks`, outlookOf(run));
		expect(plain.status).toBe(202);
		expect(plain.body.outlook.reviewDate).toBeNull();
		// Run it, so no later file's tick claims it (src/__tests__/db-setup.ts).
		expect((await tick()).done).toBe(1);
	});
});
