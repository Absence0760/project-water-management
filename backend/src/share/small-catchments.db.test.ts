// Small catchments (issue #523 G8, 232_small_catchments.sql; docs/security.md
// § The k rule on series). Two rules on what a share link and an applicant
// (the contributor role) read of a catchment's series:
//
//  - a published DWS gauge record (an outlet flow record a DWS feed wrote
//    whole) shows at any holder count; a record that isn't, a private logger,
//    the outflow and the EWR shortfall keep the k rule;
//  - the dominance rule beside k: the use's series and volumes are withheld
//    when one holder takes more than 80 % of the run's supply, or two more
//    than 90 % (engine totalShown, the registered volumes' provisional limits),
//    the farms and the other water users alike (235); k counts farm holders.
//
// Every "cannot" has its positive control (CLAUDE.md rule 5).
import { DOMINANCE_TOP1, DOMINANCE_TOP2, FARMER_K, totalShown } from '@water-management/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anon, asOwner, monthly, node, retirePendingJobs, signUp, disableFeedsAfterFile } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

// The feeds this file makes are switched off when it ends (db-setup.ts).
disableFeedsAfterFile();

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let applicant: User;
let farmer: User;
let projectId: string;
let token: string;

const outlet = node('Weir', null);
const farms = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'].map((n) => node(`Farm ${n}`, outlet.id, { damCapacityM3: 50_000 }));
const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
const DAYS = 400;
const START = '2021-10-01';
const STATION = 'X0H000';
const P = () => `/projects/${projectId}`;

/**
 * Save the model with these crop areas (m², one per farm), and these other water users: in a chain above the outlet,
 * the farms draining into the last, so each user has the river to take from.
 */
async function areas(m2: number[], users: ReturnType<typeof node>[] = []) {
	const chain = users.map((u, i) => ({ ...u, downstreamNodeId: i === 0 ? outlet.id : users[i - 1]!.id }));
	const into = chain.at(-1)?.id ?? outlet.id;
	const model = {
		nodes: [outlet, ...farms.map((f) => ({ ...f, downstreamNodeId: into })), ...chain],
		crops: [crop],
		cropAreas: farms.map((f, i) => ({ nodeId: f.id, cropId: crop.id, areaM2: m2[i]! })),
		transfers: []
	};
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
}

/** Run the live model and publish it; the run's id. */
async function publish(): Promise<string> {
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	expect((await owner.call('POST', `${P()}/publication`, { runId: run.body.run.id })).status).toBe(201);
	return run.body.run.id as string;
}

/** The catchment keys of a run the applicant reads (RLS: run_series_select_contributor). */
const applicantKeys = async (runId: string) =>
	(
		await withUser(applicant.id, (db) => db.query<{ key: string }>('SELECT key FROM run_series WHERE run_id = $1 AND node_id IS NULL ORDER BY key', [runId]))
	).rows.map((r) => r.key);
const shareStatus = async (key: string) => (await anon('POST', '/share/series', { token, key })).status;
/** Every farm held by one user (the farmer): one holder, below k. Or only Alpha: six holders. */
const linkAll = (on: boolean) => owner.call('PUT', `${P()}/farmers/${farmer.id}`, { nodeIds: on ? farms.map((f) => f.id) : [farms[0]!.id] });
/** The applicant's results of an application with no ops on the current published baseline. */
async function applicantResults() {
	const base = (await owner.call('GET', `${P()}/publication`)).body.current.runId as string;
	const made = await applicant.call('POST', `${P()}/scenarios`, { name: `Plan ${crypto.randomUUID().slice(0, 8)}`, baseRunId: base, ops: [] });
	expect(made.status, JSON.stringify(made.body)).toBe(201);
	const sid = made.body.scenario.id as string;
	expect((await applicant.call('POST', `${P()}/scenarios/${sid}/runs`, {})).status).toBe(201);
	const res = await applicant.call('GET', `${P()}/scenarios/${sid}/results`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.results;
}
/** Each farm's mean supply in a run (its summary): the parts the dominance rule weighs. */
async function supplied(runId: string): Promise<number[]> {
	const rows = (await asOwner('SELECT summary FROM model_run WHERE id = $1', [runId])) as { summary: { farms: { avgSuppliedM3Day: number }[] } }[];
	return rows[0]!.summary.farms.map((f) => f.avgSuppliedM3Day);
}
const useShown = async (runId: string) => ((await asOwner('SELECT app_run_use_shown($1) AS ok', [runId])) as { ok: boolean }[])[0]!.ok;
/** An other water user (a mine, a town) taking this much a day from the river. */
const waterUser = (name: string, m3Day: number) => node(name, outlet.id, { kind: 'user', userDemandM3Day: monthly(m3Day) });
/**
 * app_run_use_shown worked out here (235): k over the farm holders, and the engine's totalShown over each holder's
 * supply, the farms and the other water users alike (summary.farms + summary.users; a node's holder its lowest linked
 * user, else the node). Also the parts, for the test to assert on.
 */
async function expectedUseShown(runId: string): Promise<{ shown: boolean; farms: number[]; users: number[] }> {
	type Take = { nodeId: string; avgSuppliedM3Day: number };
	const [{ summary }] = (await asOwner('SELECT summary FROM model_run WHERE id = $1', [runId])) as [{ summary: { farms: Take[]; users?: Take[] } }];
	const links = (await asOwner(
		`SELECT n.id::text AS node, n.kind, (SELECT min(fl.user_id::text) FROM farm_link fl WHERE fl.node_id = n.id) AS holder FROM node n WHERE n.project_id = $1`,
		[projectId]
	)) as { node: string; kind: string; holder: string | null }[];
	const keyOf = new Map(links.map((l) => [l.node, l.holder ?? `node:${l.node}`]));
	const parts = new Map<string, number>();
	for (const t of [...summary.farms, ...(summary.users ?? [])]) {
		const key = keyOf.get(t.nodeId) ?? `node:${t.nodeId}`;
		parts.set(key, (parts.get(key) ?? 0) + Math.max(t.avgSuppliedM3Day, 0));
	}
	const farmHolders = new Set(links.filter((l) => l.kind === 'farm').map((l) => keyOf.get(l.node))).size;
	return {
		shown: farmHolders >= FARMER_K && totalShown(parts.values()),
		farms: summary.farms.map((f) => f.avgSuppliedM3Day),
		users: (summary.users ?? []).map((u) => u.avgSuppliedM3Day)
	};
}

beforeAll(async () => {
	[owner, applicant, farmer] = (await Promise.all(['SCowner', 'SCapplicant', 'SCfarmer'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Small catchment' })).body.project.id;
	await areas([100_000, 120_000, 140_000, 160_000, 180_000, 200_000]);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(500) } })).status).toBe(200);
	// Dry enough that the crops need watering: supply above 0, so the dominance rule has parts to weigh.
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 9 === 0 ? 15 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain })).status).toBe(200);
	const flow = Array.from({ length: DAYS }, (_, i) => 0.2 + (i % 7) * 0.01);
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: START, values: flow })).status).toBe(200);
	expect((await owner.call('POST', `${P()}/members`, { email: applicant.email, role: 'contributor' })).status).toBe(201);
	expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: [farms[0]!.id] })).status).toBe(201);
	await publish();
	const link = await owner.call('POST', `${P()}/share-links`, { label: 'Forum', expiresInDays: 30 });
	expect(link.status).toBe(201);
	token = new URL(link.body.link.url).hash.replace(/^#t=/, '');
}, 120_000);

afterAll(() => retirePendingJobs(projectId));

describe('the dominance rule (232, provisional, #92)', () => {
	it('is the engine’s totalShown in SQL: the same limits and k, the same answer on every sum', async () => {
		// The SQL writes 5, 0.8 and 0.9 as literals: they move with the engine's constants.
		expect([FARMER_K, DOMINANCE_TOP1, DOMINANCE_TOP2]).toEqual([5, 0.8, 0.9]);
		const cases: number[][] = [
			[],
			[0, 0, 0],
			[1, 1, 1, 1],
			[1, 1, 1, 1, 1],
			[80, 5, 5, 5, 5],
			[80.5, 5, 5, 5, 4.5],
			[50, 40, 4, 3, 3],
			[50, 41, 3, 3, 3],
			[79, 11, 4, 3, 3],
			[30, 25, 20, 15, 10, 0, -3],
			[1, 1, 1, 1, 1, 0]
		];
		// And some random ones, a few of them dominated.
		let seed = 7;
		const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		for (let c = 0; c < 40; c++) cases.push(Array.from({ length: 3 + Math.floor(rnd() * 6) }, (_, i) => (i === 0 ? rnd() * 50 : rnd() * 5)));
		const rows = (await asOwner('SELECT app_use_parts_shown(t::float8[]) AS ok FROM unnest($1::text[]) WITH ORDINALITY x(t, i) ORDER BY i', [
			cases.map((c) => `{${c.join(',')}}`)
		])) as { ok: boolean }[];
		expect(rows.map((r) => r.ok)).toEqual(cases.map((c) => totalShown(c)));
		// Both answers occur (positive control on the comparison).
		expect(new Set(rows.map((r) => r.ok))).toEqual(new Set([true, false]));
	});

	it('is the server’s own: water_app can call neither helper', async () => {
		await expect(withUser(owner.id, (db) => db.query("SELECT app_use_parts_shown('{1,1,1,1,1}')"))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query('SELECT app_run_use_shown(gen_random_uuid())'))).rejects.toMatchObject({ code: '42501' });
	});

	it('withholds the use from an applicant and a share link when one farm takes most of the water (control: the same catchment, balanced)', async () => {
		// Balanced: six holders, none above a fifth of the supply. The use shows.
		await areas([100_000, 120_000, 140_000, 160_000, 180_000, 200_000]);
		const even = await publish();
		expect((await supplied(even)).filter((v) => v > 0)).toHaveLength(6);
		expect(await useShown(even)).toBe(true);
		expect(await applicantKeys(even)).toEqual(expect.arrayContaining(['ewr', 'ewr_shortfall', 'natural_flow', 'observed_flow', 'simulated_outflow']));
		expect([await shareStatus('simulated_outflow'), await shareStatus('ewr_shortfall'), await shareStatus('observed_flow')]).toEqual([200, 200, 200]);
		const evenResults = await applicantResults();
		expect(evenResults.catchment.withheld).toBeNull();
		expect(evenResults.catchment.series.outflow).not.toBeNull();

		// One farm takes most of it: still six holders (k holds), but the use is that farm's.
		await areas([4_000_000, 500, 500, 500, 500, 500]);
		const dominated = await publish();
		const parts = await supplied(dominated);
		expect(Math.max(...parts)).toBeGreaterThan(DOMINANCE_TOP1 * parts.reduce((a, b) => a + b, 0));
		expect(await useShown(dominated)).toBe(false);
		const keys = await applicantKeys(dominated);
		for (const k of ['simulated_outflow', 'ewr_shortfall', 'observed_flow']) expect(keys, k).not.toContain(k);
		// The river as ever (positive control).
		expect(keys).toEqual(expect.arrayContaining(['ewr', 'natural_flow']));
		expect([await shareStatus('simulated_outflow'), await shareStatus('ewr_shortfall'), await shareStatus('observed_flow')]).toEqual([404, 404, 404]);
		expect([await shareStatus('natural_flow'), await shareStatus('ewr')]).toEqual([200, 200]);
		// The applicant's results say so too (app_application_run_results' farm_holders_ok), the river still shown.
		const r = await applicantResults();
		expect(r.catchment.withheld).toBe('few_farm_holders');
		expect(r.catchment.figures.base.meanSimulatedOutflowM3Day).toBeNull();
		expect(r.catchment.figures.base.meanNaturalFlowM3Day).toBeGreaterThan(0);
		expect(r.catchment.series.outflow).toBeNull();
		await areas([100_000, 120_000, 140_000, 160_000, 180_000, 200_000]);
	});
});

describe('the dominance rule counts the other water users (235)', () => {
	it('withholds the use when a mine takes most of the water beside even farms (control: a small user, shown)', async () => {
		// Control: six even farms and a small user. k holds, nobody dominates: the use shows.
		await areas([100_000, 120_000, 140_000, 160_000, 180_000, 200_000], [waterUser('Small works', 5)]);
		const small = await publish();
		const control = await expectedUseShown(small);
		expect(control.users).toHaveLength(1);
		expect(control.users[0]).toBeGreaterThan(0);
		expect(control.shown).toBe(true);
		expect(await useShown(small)).toBe(true);
		expect(await shareStatus('simulated_outflow')).toBe(200);
		expect(await applicantKeys(small)).toContain('simulated_outflow');

		// The same farms and a mine taking far more than all of them: still six farm holders, but the use is the mine's.
		await areas([100_000, 120_000, 140_000, 160_000, 180_000, 200_000], [waterUser('Mine', 200_000)]);
		const mine = await publish();
		const dominated = await expectedUseShown(mine);
		const total = [...dominated.farms, ...dominated.users].reduce((a, b) => a + b, 0);
		expect(dominated.farms.filter((v) => v > 0)).toHaveLength(6);
		expect(dominated.users[0]!).toBeGreaterThan(DOMINANCE_TOP1 * total);
		expect(dominated.shown).toBe(false);
		expect(await useShown(mine)).toBe(false);
		expect([await shareStatus('simulated_outflow'), await shareStatus('ewr_shortfall'), await shareStatus('observed_flow')]).toEqual([404, 404, 404]);
		expect([await shareStatus('natural_flow'), await shareStatus('ewr')]).toEqual([200, 200]);
		const keys = await applicantKeys(mine);
		expect(keys).not.toContain('simulated_outflow');
		expect(keys).toEqual(expect.arrayContaining(['ewr', 'natural_flow']));
		expect((await applicantResults()).catchment.withheld).toBe('few_farm_holders');
		await areas([100_000, 120_000, 140_000, 160_000, 180_000, 200_000]);
	});

	it('weighs the users when every farm takes nothing, and counts only farm holders toward k', async () => {
		// No crops: the farms take nothing, so the parts are the users'. One user alone is one holder's use.
		await areas([0, 0, 0, 0, 0, 0], [waterUser('Mine', 2_000)]);
		const one = await publish();
		const parts = await expectedUseShown(one);
		expect(parts.farms.every((v) => v === 0)).toBe(true);
		expect(parts.users[0]).toBeGreaterThan(0);
		expect(parts.shown).toBe(false);
		expect(await useShown(one)).toBe(false);
		expect(await shareStatus('simulated_outflow')).toBe(404);

		// Five even users and no farm crops: 5 or more holders take water, six farm holders: shown (positive control).
		const five = ['U1', 'U2', 'U3', 'U4', 'U5'].map((n) => waterUser(n, 50));
		await areas([0, 0, 0, 0, 0, 0], five);
		const even = await publish();
		expect((await expectedUseShown(even)).shown).toBe(true);
		expect(await useShown(even)).toBe(true);
		expect(await shareStatus('simulated_outflow')).toBe(200);

		// Users never make up k: every farm held by the farmer (one farm holder) beside five even users stays withheld.
		expect((await linkAll(true)).status).toBe(200);
		await areas([100_000, 120_000, 140_000, 160_000, 180_000, 200_000], five);
		const fewFarms = await publish();
		expect((await expectedUseShown(fewFarms)).shown).toBe(false);
		expect(await useShown(fewFarms)).toBe(false);
		expect((await linkAll(false)).status).toBe(200);
		await areas([100_000, 120_000, 140_000, 160_000, 180_000, 200_000]);
	});
});

describe('a published DWS gauge record (232)', () => {
	let feedId: string;
	/** Mark the outlet's gauge record as a DWS feed's, every day of it (as the feed's ingest leaves it, 031). */
	const feedWritesAll = () =>
		asOwner(
			`UPDATE time_series SET feed_id = $2, feed_days = datemultirange(daterange(start_date, start_date + cardinality("values")))
			 WHERE project_id = $1 AND kind = 'flow_observed_m3s' AND site_node_id IS NULL`,
			[projectId, feedId]
		);
	const meta = async (runId: string, key: string) =>
		((await asOwner('SELECT meta FROM run_series WHERE run_id = $1 AND node_id IS NULL AND key = $2', [runId, key])) as { meta: Record<string, unknown> }[])[0]?.meta;

	beforeAll(async () => {
		const { rows } = await withUser(owner.id, (db) =>
			db.query<{ id: string }>(`INSERT INTO data_feed (project_id, source, config, target_kind) VALUES ($1, 'dws', $2, 'flow_observed_m3s') RETURNING id`, [
				projectId,
				JSON.stringify({ station: STATION })
			])
		);
		feedId = rows[0]!.id;
		// One holder: below k, so only the river and a published record may show.
		expect((await linkAll(true)).status).toBe(200);
	});
	afterAll(async () => {
		expect((await linkAll(false)).status).toBe(200);
	});

	it('keeps an uploaded gauge record under the k rule (control for the rest)', async () => {
		const run = await publish();
		expect(await meta(run, 'observed_flow')).toEqual({ label: 'Observed flow', unit: 'm³/day' });
		expect(await applicantKeys(run)).toEqual(['ewr', 'natural_flow']);
		expect(await shareStatus('observed_flow')).toBe(404);
	});

	it('shows a record a DWS feed wrote whole at any holder count, and still not the use', async () => {
		await feedWritesAll();
		const run = await publish();
		expect(await meta(run, 'observed_flow')).toEqual({ label: 'Observed flow', unit: 'm³/day', publishedBy: 'DWS', station: STATION });
		expect(await useShown(run)).toBe(false);
		expect(await applicantKeys(run)).toEqual(['ewr', 'natural_flow', 'observed_flow']);
		expect(await shareStatus('observed_flow')).toBe(200);
		expect([await shareStatus('simulated_outflow'), await shareStatus('ewr_shortfall')]).toEqual([404, 404]);
	});

	it('is checked by the database: a mark it cannot trace to a DWS feed is stripped, a genuine one kept (235)', async () => {
		const MARK = JSON.stringify({ publishedBy: 'DWS', station: STATION });
		/** Write `patch` into a stored series' meta as the schema owner (no RLS; run_series_published_mark still fires), and read it back. */
		const forge = async (runId: string, key: string, patch: string) => {
			await asOwner(`UPDATE run_series SET meta = meta || $3::jsonb WHERE run_id = $1 AND node_id IS NULL AND key = $2`, [runId, key, patch]);
			return meta(runId, key);
		};
		// Genuine: storeRun's mark passes the trigger (it stores the inputs first), and rewriting it keeps it.
		await feedWritesAll();
		const genuine = await publish();
		expect((await meta(genuine, 'observed_flow'))?.publishedBy).toBe('DWS');
		expect(await forge(genuine, 'observed_flow', MARK)).toMatchObject({ publishedBy: 'DWS', station: STATION });
		// Not the outlet's observed flow: stripped.
		expect(await forge(genuine, 'simulated_outflow', MARK)).toEqual({ label: 'Simulated outflow', unit: 'm³/day' });
		// Another station than the feed's: stripped.
		expect(await forge(genuine, 'observed_flow', JSON.stringify({ publishedBy: 'DWS', station: 'X0H999' }))).toEqual({ label: 'Observed flow', unit: 'm³/day' });
		// A scenario run on the same DWS-fed input: stripped (never marked, 232).
		const made = await owner.call('POST', `${P()}/scenarios`, { name: `Forge ${crypto.randomUUID().slice(0, 8)}`, baseRunId: genuine, ops: [] });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		const ran = await owner.call('POST', `${P()}/scenarios/${made.body.scenario.id}/runs`, {});
		expect(ran.status, JSON.stringify(ran.body)).toBe(201);
		const scenarioRun = ((await asOwner(`SELECT id FROM model_run WHERE scenario_id = $1`, [made.body.scenario.id])) as { id: string }[])[0]!.id;
		expect((await meta(scenarioRun, 'observed_flow'))?.label).toBe('Observed flow');
		expect((await forge(scenarioRun, 'observed_flow', MARK))?.publishedBy).toBeUndefined();
		// A record with a day a person wrote: its run's forged mark is stripped too.
		await asOwner(
			`UPDATE time_series SET feed_days = feed_days - datemultirange(daterange(start_date + 10, start_date + 11))
			 WHERE project_id = $1 AND kind = 'flow_observed_m3s' AND site_node_id IS NULL`,
			[projectId]
		);
		const edited = await publish();
		expect((await forge(edited, 'observed_flow', MARK))?.publishedBy).toBeUndefined();
		expect(await applicantKeys(edited)).toEqual(['ewr', 'natural_flow']);
		expect(await shareStatus('observed_flow')).toBe(404);
	});

	it('marks no record with a day a person wrote, nor a private logger', async () => {
		// A person's edit releases the day it covers (031): the record is no longer DWS's alone.
		await feedWritesAll();
		await asOwner(
			`UPDATE time_series SET feed_days = feed_days - datemultirange(daterange(start_date + 10, start_date + 11))
			 WHERE project_id = $1 AND kind = 'flow_observed_m3s' AND site_node_id IS NULL`,
			[projectId]
		);
		const edited = await publish();
		expect((await meta(edited, 'observed_flow'))?.publishedBy).toBeUndefined();
		expect(await applicantKeys(edited)).toEqual(['ewr', 'natural_flow']);
		expect(await shareStatus('observed_flow')).toBe(404);

		// A logger beside a DWS record: the record shows, the logger (observed_flow_other) never.
		await feedWritesAll();
		expect((await owner.call('PUT', `${P()}/series`, { kind: 'flow_logger_m3s', unit: 'm3/s', startDate: START, values: new Array(DAYS).fill(0.15) })).status).toBe(200);
		const both = await publish();
		expect((await meta(both, 'observed_flow_other'))?.publishedBy).toBeUndefined();
		expect(await applicantKeys(both)).toEqual(['ewr', 'natural_flow', 'observed_flow']);
		await asOwner(`DELETE FROM time_series WHERE project_id = $1 AND kind = 'flow_logger_m3s'`, [projectId]);
	});

	it("hands the applicant's results the published record whatever the holders (control: none from an unmarked baseline)", async () => {
		// Unmarked: a person's day in the record.
		await asOwner(
			`UPDATE time_series SET feed_days = feed_days - datemultirange(daterange(start_date + 10, start_date + 11))
			 WHERE project_id = $1 AND kind = 'flow_observed_m3s' AND site_node_id IS NULL`,
			[projectId]
		);
		await publish();
		const none = await applicantResults();
		expect(none.gaugeRecords).toEqual([]);
		expect(none.catchment.withheld).toBe('few_farm_holders');

		await feedWritesAll();
		await publish();
		const shown = await applicantResults();
		expect(shown.catchment.withheld).toBe('few_farm_holders');
		expect(shown.catchment.series.outflow).toBeNull();
		expect(shown.gaugeRecords).toHaveLength(1);
		expect(shown.gaugeRecords[0]).toMatchObject({ key: 'observed_flow', label: 'Observed flow', station: STATION, series: { startDate: START } });
		expect(shown.gaugeRecords[0].series.values).toHaveLength(DAYS);
		expect(shown.gaugeRecords[0].series.values[1]).toBeCloseTo(0.21 * 86_400, 3);
	});
});
