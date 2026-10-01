// Human impacts on the model document (roadmap WP-1.33 …): they are stored,
// read back, validated and reach a run. Needs Postgres (pnpm dev:db:up).
import { describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** The run series keys of a node that GET …/runs/:runId/series serves. */
async function seriesKeys(u: User, projectId: string, runId: string, nodeId: string | null, keys: string[]) {
	const found: string[] = [];
	for (const key of keys) {
		const q = new URLSearchParams({ key, ...(nodeId ? { nodeId } : {}) });
		if ((await u.call('GET', `/projects/${projectId}/runs/${runId}/series?${q}`)).status === 200) found.push(key);
	}
	return found;
}

async function project(u: User, name: string) {
	const projectId = (await u.call('POST', '/projects', { name })).body.project.id as string;
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 6 === 0 ? 20 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	return projectId;
}

describe('other water users (WP-1.33)', () => {
	it('stores a user node, reads it back, runs it, and refuses crops, transfers and a bad demand on it', async () => {
		const u = await signUp('Town');
		const projectId = await project(u, 'With a town');
		const outlet = node('Outlet', null);
		const town = node('Town', outlet.id, { kind: 'user', areaKm2: 0, damCapacityM3: 0, userDemandM3Day: monthly(250), userReturnPct: 0.4, userPriority: 'junior' });
		const farm = node('Upper', town.id);
		const model = { nodes: [outlet, town, farm], crops: [], cropAreas: [], transfers: [] };
		expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		const got = (await u.call('GET', `/projects/${projectId}/model`)).body.nodes as Record<string, unknown>[];
		expect(got.find((n) => n.id === town.id)).toMatchObject({ kind: 'user', userDemandM3Day: monthly(250), userReturnPct: 0.4, userPriority: 'junior' });
		// A farm keeps the inert defaults.
		expect(got.find((n) => n.id === farm.id)).toMatchObject({ kind: 'farm', userDemandM3Day: null, userReturnPct: 0, userPriority: 'senior' });

		const run = await u.call('POST', `/projects/${projectId}/runs`, { label: 'with town' });
		expect(run.status).toBe(201);
		const summary = (await u.call('GET', `/projects/${projectId}/runs/${run.body.run.id}`)).body.run.summary;
		expect(summary.users).toHaveLength(1);
		expect(summary.users[0]).toMatchObject({ nodeId: town.id, priority: 'junior', avgDemandM3Day: 250 });
		expect(summary.verification.passed).toBe(true);
		const want = ['demand', 'supplied', 'return_flow', 'outflow', 'ewr_charge'];
		expect(await seriesKeys(u, projectId, run.body.run.id, town.id, want)).toEqual(want);

		const bad = async (m: object, pattern: RegExp) => {
			const res = await u.call('PUT', `/projects/${projectId}/model`, m);
			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body)).toMatch(pattern);
		};
		const crop = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(1) };
		await bad({ ...model, crops: [crop], cropAreas: [{ nodeId: town.id, cropId: crop.id, areaM2: 1000 }] }, /other water user/);
		const tr = { id: crypto.randomUUID(), fromNodeId: farm.id, toNodeId: town.id, months: [1], maxRateM3s: 1, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 };
		await bad({ ...model, transfers: [tr] }, /other water user/);
		await bad({ ...model, nodes: [outlet, { ...town, userDemandM3Day: [1, 2, 3] }, farm] }, /userDemandM3Day/);
		await bad({ ...model, nodes: [outlet, { ...town, userDemandM3Day: monthly(-1) }, farm] }, /userDemandM3Day/);
		await bad({ ...model, nodes: [outlet, { ...town, userPriority: 'first' }, farm] }, /userPriority/);
		// The database refuses a malformed demand even past the API.
		await expect(asOwner('UPDATE node SET user_demand_m3_day = $2 WHERE id = $1', [town.id, [1, 2]])).rejects.toThrow(/check/i);
	});

	it('reads a model saved before the user fields (older document) as having none', async () => {
		const u = await signUp('Older');
		const projectId = await project(u, 'Older doc');
		const outlet = node('Outlet', null);
		const farm = node('Upper', outlet.id);
		// No user fields at all: the API fills the inert defaults.
		expect((await u.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		const got = (await u.call('GET', `/projects/${projectId}/model`)).body.nodes as Record<string, unknown>[];
		expect(got.every((n) => n.userDemandM3Day === null && n.userReturnPct === 0 && n.userPriority === 'senior')).toBe(true);
	});
});

describe('boreholes (WP-1.34)', () => {
	it('stores a farm’s boreholes, runs them, and refuses them on a gauge or with a drought rule and no dam', async () => {
		const u = await signUp('Borehole');
		const projectId = await project(u, 'With boreholes');
		const outlet = node('Outlet', null);
		const farm = node('Upper', outlet.id, { boreholeCapacityM3Day: 400, boreholeRule: 'primary', streamDepletionFrac: 0.6, streamDepletionLagDays: 15 });
		const crop = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(1) };
		const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 }], transfers: [] };
		expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		const got = (await u.call('GET', `/projects/${projectId}/model`)).body.nodes as Record<string, unknown>[];
		expect(got.find((n) => n.id === farm.id)).toMatchObject({ boreholeCapacityM3Day: 400, boreholeRule: 'primary', boreholeTriggerPct: 0.3, streamDepletionFrac: 0.6, streamDepletionLagDays: 15 });
		expect(got.find((n) => n.id === outlet.id)).toMatchObject({ boreholeCapacityM3Day: null, streamDepletionFrac: 0 });

		const run = await u.call('POST', `/projects/${projectId}/runs`, { label: 'pumping' });
		expect(run.status).toBe(201);
		const summary = (await u.call('GET', `/projects/${projectId}/runs/${run.body.run.id}`)).body.run.summary;
		expect(summary.verification.passed).toBe(true);
		expect(summary.farms[0].avgGroundwaterM3Day).toBeGreaterThan(0);
		const want = ['groundwater_used', 'baseflow_depletion', 'depletion_store', 'depletion_deficit'];
		expect(await seriesKeys(u, projectId, run.body.run.id, farm.id, want)).toEqual(want);

		const bad = async (m: object, pattern: RegExp) => {
			const res = await u.call('PUT', `/projects/${projectId}/model`, m);
			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body)).toMatch(pattern);
		};
		await bad({ ...model, nodes: [{ ...outlet, boreholeCapacityM3Day: 10 }, farm] }, /gauge .{0,2}Outlet.{0,2} can't have boreholes/);
		await bad({ ...model, nodes: [outlet, { ...farm, damCapacityM3: 0, boreholeRule: 'drought' }] }, /drought borehole rule needs a farm dam/);
		await bad({ ...model, nodes: [outlet, { ...farm, streamDepletionFrac: 2 }] }, /streamDepletionFrac/);
		await bad({ ...model, nodes: [outlet, { ...farm, boreholeRule: 'sometimes' }] }, /boreholeRule/);
		await expect(asOwner('UPDATE node SET stream_depletion_lag_days = -1 WHERE id = $1', [farm.id])).rejects.toThrow(/check/i);
	});
});

describe('individual boreholes (WP-3.9)', () => {
	async function withBoreholes(u: User, name: string) {
		const projectId = await project(u, name);
		const outlet = node('Outlet', null);
		const farm = node('Upper', outlet.id, { damCapacityM3: 20_000, damInitialPct: 0.5, streamDepletionLagDays: 10 });
		const crop = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(1) };
		const bh = (over: object = {}) => ({ id: crypto.randomUUID(), nodeId: farm.id, name: 'BH1', capacityM3Day: 300, annualCapM3: 20_000, mode: 'primary', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0.4, ...over });
		const boreholes = [bh(), bh({ name: 'BH2', mode: 'emergency', target: 'dam', annualCapM3: null, emergencyBelowPct: 0.4, depletionFactor: 0 })];
		const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 }], transfers: [], boreholes };
		expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		return { projectId, model, farm, outlet, boreholes, bh };
	}

	it('stores boreholes in the model document, runs them with annual use in the summary, copies them, and refuses bad ones', async () => {
		const u = await signUp('Boreholes');
		const { projectId, model, farm, outlet, boreholes, bh } = await withBoreholes(u, 'With boreholes');
		const got = (await u.call('GET', `/projects/${projectId}/model`)).body.boreholes as Record<string, unknown>[];
		expect([...got].sort((a, b) => String(a.name).localeCompare(String(b.name)))).toEqual(boreholes);

		const run = await u.call('POST', `/projects/${projectId}/runs`, { label: 'pumping' });
		expect(run.status).toBe(201);
		const summary = (await u.call('GET', `/projects/${projectId}/runs/${run.body.run.id}`)).body.run.summary;
		expect(summary.verification.passed).toBe(true);
		const years = summary.groundwaterAnnualUse as { nodeId: string; abstractionM3: number; gaLimitM3: number; annualCapM3: number | null; boreholes: { id: string; abstractionM3: number; annualCapM3: number | null }[] }[];
		expect(years.length).toBeGreaterThan(0);
		expect(years.every((y) => y.nodeId === farm.id && y.gaLimitM3 === 40_000 && y.annualCapM3 === null)).toBe(true);
		// The primary borehole pumps and stays within its annual cap.
		const primary = years.map((y) => y.boreholes.find((b) => b.id === boreholes[0]!.id)!);
		expect(primary.some((b) => b.abstractionM3 > 0)).toBe(true);
		expect(primary.every((b) => b.abstractionM3 <= 20_000 + 1e-6)).toBe(true);
		const want = ['groundwater_used', 'groundwater_to_dam', 'baseflow_depletion'];
		expect(await seriesKeys(u, projectId, run.body.run.id, farm.id, want)).toEqual(want);

		const copy = await u.call('POST', `/projects/${projectId}/copy`, { name: 'Copied boreholes' });
		expect(copy.status).toBe(201);
		const copied = (await u.call('GET', `/projects/${copy.body.project.id}/model`)).body;
		expect(copied.boreholes).toHaveLength(2);
		expect(copied.boreholes.every((b: { id: string; nodeId: string }) => !boreholes.some((x) => x.id === b.id) && b.nodeId === copied.nodes.find((n: { name: string }) => n.name === 'Upper').id)).toBe(true);

		const bad = async (m: object, pattern: RegExp) => {
			const res = await u.call('PUT', `/projects/${projectId}/model`, m);
			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body)).toMatch(pattern);
		};
		await bad({ ...model, boreholes: [bh({ nodeId: outlet.id })] }, /a gauge can't have boreholes/);
		await bad({ ...model, boreholes: [bh({ nodeId: crypto.randomUUID() })] }, /unknown node/);
		await bad({ ...model, nodes: [outlet, { ...farm, damCapacityM3: 0 }], boreholes: [bh({ target: 'dam' })] }, /pumps into a dam, and there is none/);
		await bad({ ...model, boreholes: [bh({ mode: 'sometimes' })] }, /mode/);
		await bad({ ...model, boreholes: [bh({ depletionFactor: 1.5 })] }, /depletionFactor/);
		await bad({ ...model, boreholes: [bh({ annualCapM3: -1 })] }, /annualCapM3/);
		// The database refuses a bad mode even past the API.
		await expect(asOwner('UPDATE borehole SET mode = $2 WHERE node_id = $1', [farm.id, 'always'])).rejects.toThrow(/check/i);
		// A model saved without boreholes (an older document) has none.
		expect((await u.call('PUT', `/projects/${projectId}/model`, { nodes: model.nodes, crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		expect((await u.call('GET', `/projects/${projectId}/model`)).body.boreholes).toBeUndefined();
	});

	it('RLS: a member sees a project’s boreholes, a non-member sees none and can’t attach one to another project’s farm', async () => {
		const owner = await signUp('BoreOwner');
		const { projectId, farm } = await withBoreholes(owner, 'Private boreholes');
		const count = (userId: string) => withUser(userId, async (db) => (await db.query('SELECT id FROM borehole WHERE project_id = $1', [projectId])).rowCount);
		// Positive control: the owner sees both.
		expect(await count(owner.id)).toBe(2);
		const stranger = await signUp('BoreStranger');
		expect(await count(stranger.id)).toBe(0);
		const theirs = await project(stranger, 'Theirs');
		await expect(
			withUser(stranger.id, (db) => db.query('INSERT INTO borehole (project_id, node_id, name, capacity_m3_day) VALUES ($1, $2, $3, 1)', [theirs, farm.id, 'Sneaky']))
		).rejects.toThrow(/different project|row-level security|violates/);
		expect(await count(owner.id)).toBe(2);
		// Boreholes go with their farm.
		await asOwner('DELETE FROM node WHERE id = $1', [farm.id]);
		expect(await count(owner.id)).toBe(0);
	});
});

describe('land cover (WP-1.35)', () => {
	async function withCover(u: User, name: string) {
		const projectId = await project(u, name);
		const outlet = node('Outlet', null);
		const farm = node('Upper', outlet.id, { areaKm2: 10 });
		const patch = { id: crypto.randomUUID(), nodeId: farm.id, coverClass: 'invasive', areaKm2: 3, densityPct: 0.6, factors: null };
		const model = { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [], landCover: [patch] };
		expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		return { projectId, model, farm, outlet, patch };
	}

	it('stores patches in the model document, runs them as their own series, and copies them with the project', async () => {
		const u = await signUp('Cover');
		const { projectId, model, farm, outlet, patch } = await withCover(u, 'With invasives');
		expect((await u.call('GET', `/projects/${projectId}/model`)).body.landCover).toEqual([patch]);
		// Overridden reductions round-trip too.
		const over = { ...patch, factors: { mar: 0.3, lowFlow: 0.45 } };
		expect((await u.call('PUT', `/projects/${projectId}/model`, { ...model, landCover: [over] })).status).toBe(200);
		expect((await u.call('GET', `/projects/${projectId}/model`)).body.landCover).toEqual([over]);

		const run = await u.call('POST', `/projects/${projectId}/runs`, { label: 'invaded' });
		expect(run.status).toBe(201);
		const summary = (await u.call('GET', `/projects/${projectId}/runs/${run.body.run.id}`)).body.run.summary;
		expect(summary.verification.passed).toBe(true);
		expect(summary.landCover.byClass[0]).toMatchObject({ coverClass: 'invasive' });
		expect(summary.landCover.byClass[0].condensedKm2).toBeCloseTo(1.8, 12);
		expect(await seriesKeys(u, projectId, run.body.run.id, farm.id, ['landcover_reduction'])).toEqual(['landcover_reduction']);
		expect(await seriesKeys(u, projectId, run.body.run.id, null, ['landcover_reduction'])).toEqual(['landcover_reduction']);

		const copy = await u.call('POST', `/projects/${projectId}/copy`, { name: 'Cleared' });
		expect(copy.status).toBe(201);
		const copied = (await u.call('GET', `/projects/${copy.body.project.id}/model`)).body;
		expect(copied.landCover).toHaveLength(1);
		expect(copied.landCover[0].id).not.toBe(patch.id);
		expect(copied.landCover[0].nodeId).toBe(copied.nodes.find((n: { name: string }) => n.name === 'Upper').id);

		const bad = async (m: object, pattern: RegExp) => {
			const res = await u.call('PUT', `/projects/${projectId}/model`, m);
			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body)).toMatch(pattern);
		};
		await bad({ ...model, landCover: [{ ...patch, nodeId: outlet.id }] }, /land cover lies on a farm/);
		await bad({ ...model, landCover: [{ ...patch, nodeId: crypto.randomUUID() }] }, /unknown node/);
		await bad({ ...model, landCover: [{ ...patch, coverClass: 'bamboo' }] }, /coverClass/);
		await bad({ ...model, landCover: [{ ...patch, densityPct: 1.5 }] }, /densityPct/);
		await bad({ ...model, landCover: [{ ...patch, factors: { mar: 2, lowFlow: 0 } }] }, /factors/);
		// A model saved without landCover (an older document) has none.
		expect((await u.call('PUT', `/projects/${projectId}/model`, { nodes: model.nodes, crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		expect((await u.call('GET', `/projects/${projectId}/model`)).body.landCover).toEqual([]);
	});

	it('RLS: a member sees a project’s land cover, a non-member sees none and can’t attach a patch to another project’s farm', async () => {
		const owner = await signUp('CoverOwner');
		const { projectId, farm, patch } = await withCover(owner, 'Private cover');
		const count = (userId: string) => withUser(userId, async (db) => (await db.query('SELECT id FROM land_cover WHERE project_id = $1', [projectId])).rowCount);
		// Positive control: the owner sees the patch.
		expect(await count(owner.id)).toBe(1);
		const stranger = await signUp('CoverStranger');
		expect(await count(stranger.id)).toBe(0);
		// Through the API too: the project is hidden entirely.
		expect((await stranger.call('GET', `/projects/${projectId}/model`)).status).toBe(404);
		// The stranger's own project can't take a patch on the owner's farm (same-project trigger / RLS).
		const theirs = await project(stranger, 'Theirs');
		const outlet = node('Outlet', null);
		const res = await stranger.call('PUT', `/projects/${theirs}/model`, { nodes: [outlet], crops: [], cropAreas: [], transfers: [], landCover: [{ ...patch, id: crypto.randomUUID(), nodeId: farm.id }] });
		expect(res.status).toBe(400);
		await expect(
			withUser(stranger.id, (db) => db.query('INSERT INTO land_cover (project_id, node_id, cover_class, area_km2, density_pct) VALUES ($1, $2, $3, 1, 1)', [theirs, farm.id, 'pine']))
		).rejects.toThrow(/different project|row-level security|violates/);
		expect(await count(owner.id)).toBe(1);
		// A patch whose farm is removed goes with it.
		await asOwner('DELETE FROM node WHERE id = $1', [farm.id]);
		expect(await count(owner.id)).toBe(0);
	});
});

describe('dam storage (WP-3.5)', () => {
	it('stores a dam’s survey curve, release rule and seepage share, runs them, and refuses a curve that falls', async () => {
		const u = await signUp('Survey');
		const projectId = await project(u, 'With a surveyed dam');
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { lakeEvapFactorMonthly: monthly(0.8) } })).status).toBe(200);
		const curve = [
			{ levelM: 210, areaM2: 0, volumeM3: 0 },
			{ levelM: 212, areaM2: 9000, volumeM3: 8000 },
			{ levelM: 214, areaM2: 15_000, volumeM3: 30_000 }
		];
		const outlet = node('Outlet', null);
		const farm = node('Upper', outlet.id, {
			damCapacityM3: 30_000,
			damInitialPct: 0.8,
			damSeepagePerDay: 0.002,
			damCurve: curve,
			damReleaseRule: 'fixed',
			damReleaseM3Day: monthly(25),
			damOutletCapacityM3Day: 300,
			damSeepageReturnPct: 0.4
		});
		const crop = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(1) };
		const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 20_000 }], transfers: [] };
		expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		const got = (await u.call('GET', `/projects/${projectId}/model`)).body.nodes as Record<string, unknown>[];
		expect(got.find((n) => n.id === farm.id)).toMatchObject({ damCurve: curve, damReleaseRule: 'fixed', damReleaseM3Day: monthly(25), damOutletCapacityM3Day: 300, damSeepageReturnPct: 0.4 });
		expect(got.find((n) => n.id === outlet.id)).toMatchObject({ damCurve: null, damReleaseRule: 'none', damReleaseM3Day: null, damOutletCapacityM3Day: null, damSeepageReturnPct: 1 });

		const run = await u.call('POST', `/projects/${projectId}/runs`, { label: 'surveyed' });
		expect(run.status).toBe(201);
		const summary = (await u.call('GET', `/projects/${projectId}/runs/${run.body.run.id}`)).body.run.summary;
		expect(summary.verification.passed).toBe(true);
		expect(summary.waterBalance.total.damSeepageLostM3).toBeGreaterThan(0);
		expect(summary.waterBalance.total.damReleaseM3).toBeGreaterThan(0);
		expect(await seriesKeys(u, projectId, run.body.run.id, farm.id, ['dam_release', 'dam_seepage_lost'])).toEqual(['dam_release', 'dam_seepage_lost']);

		const bad = async (m: object, pattern: RegExp) => {
			const res = await u.call('PUT', `/projects/${projectId}/model`, m);
			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body)).toMatch(pattern);
		};
		await bad({ ...model, nodes: [outlet, { ...farm, damCurve: [curve[0], { ...curve[1], areaM2: 20_000 }, curve[2]] }] }, /dam survey curve: the survey area falls/);
		await bad({ ...model, nodes: [{ ...outlet, damCurve: curve }, farm] }, /only a farm has a dam/);
		await bad({ ...model, nodes: [outlet, { ...farm, damReleaseRule: 'spill' }] }, /damReleaseRule/);
		await bad({ ...model, nodes: [outlet, { ...farm, damSeepageReturnPct: 2 }] }, /damSeepageReturnPct/);
		await expect(asOwner(`UPDATE node SET dam_release_rule = 'spill' WHERE id = $1`, [farm.id])).rejects.toThrow(/check/i);
		await expect(asOwner(`UPDATE node SET dam_curve = '{"a": 1}'::jsonb WHERE id = $1`, [farm.id])).rejects.toThrow(/check/i);
	});

	it('stores a farm’s supply rule and river pump, runs them, and refuses invalid combinations (WP-3.8)', async () => {
		const u = await signUp('Pump');
		const projectId = await project(u, 'River pumps');
		const outlet = node('Outlet', null);
		const upper = node('Upper', outlet.id, { supplyRule: 'riverFirst', pumpCapacityM3Day: 900 });
		const lower = node('Lower', outlet.id, { damCapacityM3: 0, supplyRule: 'runOfRiver', pumpCapacityM3Day: 400 });
		const crop = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(1) };
		const model = {
			nodes: [outlet, upper, lower],
			crops: [crop],
			cropAreas: [upper, lower].map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 20_000 })),
			transfers: []
		};
		expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		const got = (await u.call('GET', `/projects/${projectId}/model`)).body.nodes as Record<string, unknown>[];
		expect(got.find((n) => n.id === upper.id)).toMatchObject({ supplyRule: 'riverFirst', pumpCapacityM3Day: 900, supplyTriggerPct: 0.4, supplyStopPct: 0.6 });
		expect(got.find((n) => n.id === lower.id)).toMatchObject({ supplyRule: 'runOfRiver', pumpCapacityM3Day: 400 });
		expect(got.find((n) => n.id === outlet.id)).toMatchObject({ supplyRule: 'damFirst', pumpCapacityM3Day: null });

		const run = await u.call('POST', `/projects/${projectId}/runs`, { label: 'pumps' });
		expect(run.status).toBe(201);
		const summary = (await u.call('GET', `/projects/${projectId}/runs/${run.body.run.id}`)).body.run.summary;
		expect(summary.verification.passed).toBe(true);
		const farms = summary.farms as { nodeId: string; avgRiverAbstractionM3Day?: number }[];
		for (const f of [upper, lower]) expect(farms.find((x) => x.nodeId === f.id)!.avgRiverAbstractionM3Day).toBeGreaterThan(0);
		expect(await seriesKeys(u, projectId, run.body.run.id, lower.id, ['river_abstraction'])).toEqual(['river_abstraction']);

		const bad = async (m: object, pattern: RegExp) => {
			const res = await u.call('PUT', `/projects/${projectId}/model`, m);
			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body)).toMatch(pattern);
		};
		await bad({ ...model, nodes: [outlet, upper, { ...lower, damCapacityM3: 5000 }] }, /run of river has no dam/);
		await bad({ ...model, nodes: [outlet, { ...upper, supplyRule: 'trigger', supplyTriggerPct: 0.5, supplyStopPct: 0.3 }, lower] }, /stop level must be at least its trigger level/);
		await bad({ ...model, nodes: [{ ...outlet, supplyRule: 'riverFirst' }, upper, lower] }, /only a farm has a supply rule/);
		await bad({ ...model, nodes: [outlet, { ...upper, supplyRule: 'pumpFirst' }, lower] }, /supplyRule/);
		await expect(asOwner(`UPDATE node SET supply_rule = 'pumpFirst' WHERE id = $1`, [upper.id])).rejects.toThrow(/check/i);
		await expect(asOwner(`UPDATE node SET pump_capacity_m3_day = -1 WHERE id = $1`, [upper.id])).rejects.toThrow(/check/i);
	});

	it('stores a farm’s hands-off flow and River to dam by month, runs them, and refuses invalid ones (issue #204)', async () => {
		const u = await signUp('HandsOff');
		const projectId = await project(u, 'Hands-off flow');
		const outlet = node('Outlet', null);
		// Winter-only filling (water-year order Oct–Sep: May–Sep off) and a hands-off flow that keeps the EWR too.
		const winter = [0, 0, 0, 0, 0, 0, 0, 800, 800, 800, 800, 800];
		const farm = node('Upper', outlet.id, { divertCapacityM3Day: 500, supplyRule: 'riverFirst', pumpCapacityM3Day: 900, handsOffM3Day: monthly(150), handsOffEwr: true, divertMonthlyM3Day: winter });
		const crop = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(1) };
		const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 20_000 }], transfers: [] };
		expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		const got = (await u.call('GET', `/projects/${projectId}/model`)).body.nodes as Record<string, unknown>[];
		expect(got.find((n) => n.id === farm.id)).toMatchObject({ handsOffM3Day: monthly(150), handsOffEwr: true, divertMonthlyM3Day: winter, divertCapacityM3Day: 500 });
		// Positive control for the defaults: a node saved without the fields reads back with them off.
		expect(got.find((n) => n.id === outlet.id)).toMatchObject({ handsOffM3Day: null, handsOffEwr: false, divertMonthlyM3Day: null });

		// The run passes its self-checks, the new operating-rules check among them.
		const run = await u.call('POST', `/projects/${projectId}/runs`, { label: 'hands-off' });
		expect(run.status).toBe(201);
		const summary = (await u.call('GET', `/projects/${projectId}/runs/${run.body.run.id}`)).body.run.summary;
		expect(summary.verification.passed).toBe(true);
		expect(summary.verification.checks.map((c: { id: string }) => c.id)).toContain('operatingRules');

		const bad = async (m: object, pattern: RegExp) => {
			const res = await u.call('PUT', `/projects/${projectId}/model`, m);
			expect(res.status).toBe(400);
			expect(JSON.stringify(res.body)).toMatch(pattern);
		};
		await bad({ ...model, nodes: [{ ...outlet, handsOffM3Day: monthly(10) }, farm] }, /only a farm has a hands-off flow/);
		await bad({ ...model, nodes: [{ ...outlet, handsOffEwr: true }, farm] }, /only a farm has a hands-off flow/);
		await bad({ ...model, nodes: [outlet, { ...farm, handsOffM3Day: [1, 2, 3] }] }, /handsOffM3Day/);
		await bad({ ...model, nodes: [outlet, { ...farm, divertMonthlyM3Day: [...winter.slice(1), -1] }] }, /divertMonthlyM3Day/);
		await expect(asOwner(`UPDATE node SET hands_off_m3_day = '{1,2,3}' WHERE id = $1`, [farm.id])).rejects.toThrow(/check/i);
		await expect(asOwner(`UPDATE node SET divert_monthly_m3_day = array_fill(-1::float8, ARRAY[12]) WHERE id = $1`, [farm.id])).rejects.toThrow(/check/i);
		await expect(asOwner(`UPDATE node SET hands_off_ewr = NULL WHERE id = $1`, [farm.id])).rejects.toThrow(/null/i);
		for (const col of ['hands_off_m3_day', 'divert_monthly_m3_day']) {
			await expect(asOwner(`UPDATE node SET ${col} = array_fill(1::float8, ARRAY[13]) WHERE id = $1`, [farm.id]), `${col}: 13 values`).rejects.toThrow(/check/i);
			// A NULL element: 0 <= ALL alone lets it through (NULL, not false), so the check names it (migration 114).
			await expect(asOwner(`UPDATE node SET ${col} = '{1,1,1,1,1,NULL,1,1,1,1,1,1}' WHERE id = $1`, [farm.id]), `${col}: a NULL month`).rejects.toThrow(/check/i);
		}
		// Positive control: 12 values ≥ 0 go in.
		await asOwner(`UPDATE node SET hands_off_m3_day = array_fill(0::float8, ARRAY[12]) WHERE id = $1`, [farm.id]);
	});
});

describe('the drought restriction rule (engine 1.54.0, WP-3.8)', () => {
	it('is saved with the settings, reaches a run (its level, cuts and restricted demand, the summary, the self-check), and is refused when malformed', async () => {
		const u = await signUp('Drought');
		const projectId = await project(u, 'With restrictions');
		const outlet = node('Outlet', null, { kind: 'gauge', areaKm2: 0 });
		const farm = node('Upper', outlet.id, { damCapacityM3: 20_000, damInitialPct: 0.5 });
		const crop = { id: crypto.randomUUID(), name: 'Maize', cropFactor: monthly(1) };
		const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 20_000 }], transfers: [] };
		expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
		// Reviewed on the 1st of every month: below 60 % the crops lose 40 %.
		const rule = { reviewDates: Array.from({ length: 12 }, (_, m) => `${String(m + 1).padStart(2, '0')}-01`), levels: [{ label: 'Level 1', belowPct: 0.6, cuts: { crops: 0.4 } }] };
		const bad = await u.call('PATCH', `/projects/${projectId}`, { settings: { droughtRestriction: { ...rule, levels: [{ belowPct: 1.5, cuts: {} }] } } });
		expect(bad.status).toBe(400);
		expect(JSON.stringify(bad.body)).toMatch(/drought restriction rule: levels\[0\]\.belowPct/);
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { droughtRestriction: rule } })).status).toBe(200);
		expect((await u.call('GET', `/projects/${projectId}`)).body.project.settings.droughtRestriction).toEqual(rule);

		const run = await u.call('POST', `/projects/${projectId}/runs`, { label: 'restricted' });
		expect(run.status).toBe(201);
		const summary = (await u.call('GET', `/projects/${projectId}/runs/${run.body.run.id}`)).body.run.summary;
		expect(summary.verification.passed).toBe(true);
		expect(summary.verification.checks.map((c: { id: string }) => c.id)).toContain('droughtRestriction');
		expect(summary.droughtRestriction.rule).toEqual(rule);
		// Half full from the start: level 1 from the first day.
		expect(summary.droughtRestriction.daysByLevel[1]).toBeGreaterThan(0);
		expect(await seriesKeys(u, projectId, run.body.run.id, null, ['restriction_level', 'restriction_cut@crops'])).toEqual(['restriction_level', 'restriction_cut@crops']);
		expect(await seriesKeys(u, projectId, run.body.run.id, farm.id, ['restricted_demand'])).toEqual(['restricted_demand']);

		// Engine 1.54.0: the listed dam, the listed unit and the outlet's EWR trigger, by name in the summary sheet.
		const named = { ...rule, basis: 'dams', damNodeIds: [farm.id], nodeIds: [farm.id], ewrTrigger: { siteNodeId: null, level: 1 } };
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { droughtRestriction: named } })).status).toBe(200);
		const namedRun = await u.call('POST', `/projects/${projectId}/runs`, { label: 'named' });
		expect(namedRun.status).toBe(201);
		const csv = await (await app.request(`/projects/${projectId}/runs/${namedRun.body.run.id}/export/summary.csv`, { headers: { cookie: u.cookie, origin: 'http://localhost:7777' } })).text();
		const ruleLine = csv.split('\r\n').find((l) => l.startsWith('Rule,'))!;
		expect(ruleLine).toContain('the storage of Upper');
		expect(ruleLine).toContain('cutting Upper only');
		expect(ruleLine).not.toContain(farm.id);
		expect(csv).toMatch(/\r\nUpper,[^\r]*\r\n/);

		// Off again: the next run has none of it.
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { droughtRestriction: null } })).status).toBe(200);
		const off = await u.call('POST', `/projects/${projectId}/runs`, { label: 'off' });
		const offSummary = (await u.call('GET', `/projects/${projectId}/runs/${off.body.run.id}`)).body.run.summary;
		expect(offSummary.droughtRestriction).toBeUndefined();
		expect(await seriesKeys(u, projectId, off.body.run.id, null, ['restriction_level'])).toEqual([]);
	});
});
