// The model store (model/store.ts): every field survives a save and a load
// exactly, in the documented order, and a save is set-based, a fixed number
// of statements whatever the model's size (issue #41: a save of 25+ round
// trips queued for seconds on a busy API). Needs Postgres (pnpm dev:db:up).
import type { ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser, type Db } from '../db/tx.js';
import { loadModel, loadSettingsAndModel, saveModel } from './store.js';

type User = Awaited<ReturnType<typeof signUp>>;

async function newProject(u: User, name: string): Promise<string> {
	return (await u.call('POST', '/projects', { name })).body.project.id as string;
}

/** A chain of `n` farms above an outlet, every farm with a crop area, each consecutive pair with a transfer. */
function chain(n: number): ProjectModel {
	const outlet = node('Outlet', null, { sortOrder: 0 });
	const farms = Array.from({ length: n }, (_, i) => node(`Farm ${i + 1}`, outlet.id, { sortOrder: i + 1 }));
	const crop = { id: crypto.randomUUID(), name: 'Maize', sortOrder: 0, cropFactor: monthly(0.8) };
	return {
		nodes: [outlet, ...farms],
		crops: [crop],
		cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 10_000 })),
		transfers: farms.slice(1).map((f, i) => ({
			id: crypto.randomUUID(),
			fromNodeId: farms[i]!.id,
			toNodeId: f.id,
			months: [1, 2],
			maxRateM3s: 0.1,
			dailyCapM3: null,
			minStoragePct: 0,
			enabled: true,
			priority: i
		})),
		landCover: farms.map((f) => ({ id: crypto.randomUUID(), nodeId: f.id, coverClass: 'pine', areaKm2: 0.5, densityPct: 0.5, factors: null })),
		boreholes: farms.map((f) => ({ id: crypto.randomUUID(), nodeId: f.id, name: 'BH', capacityM3Day: 10, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 })),
		demandObjects: farms.map((f) => ({ id: crypto.randomUUID(), nodeId: f.id, name: 'Town', category: 'municipal', sizing: 'monthly', monthlyM3Day: new Array(12).fill(5), count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0.5, priority: 'first', destination: 'internal', enabled: true, note: '' }))
	} as unknown as ProjectModel;
}

/** The statements `fn` sends on its connection. */
async function countStatements(userId: string, fn: (db: Db) => Promise<void>): Promise<number> {
	return withUser(userId, async (db) => {
		let n = 0;
		const query = db.query.bind(db) as (...a: unknown[]) => unknown;
		(db as unknown as { query: (...a: unknown[]) => unknown }).query = (...a) => {
			n++;
			return query(...a);
		};
		try {
			await fn(db);
		} finally {
			(db as unknown as { query: unknown }).query = query;
		}
		return n;
	});
}

describe('model store', () => {
	it('reads back every field exactly as saved, in sort order, with awkward numbers intact', async () => {
		const u = await signUp('Store');
		const projectId = await newProject(u, 'Every field');
		const outlet = node('Outlet', null, { sortOrder: 5, flowShareManual: 0.1, areaKm2: 0.1 + 0.2 });
		const curve = [
			{ levelM: 210.25, areaM2: 0, volumeM3: 0 },
			{ levelM: 212, areaM2: 9000, volumeM3: 8000 },
			{ levelM: 214, areaM2: 15_000, volumeM3: 30_000 }
		];
		const farm = node('Upper', outlet.id, {
			sortOrder: 1,
			areaKm2: 1e-7,
			areaHiKm2: 123_456.789,
			damCapacityM3: 30_000,
			damAreaFullM2: 15_000,
			damSeepagePerDay: 0.002,
			damCurve: curve,
			damReleaseRule: 'fixed',
			damReleaseM3Day: monthly(25.5),
			damOutletCapacityM3Day: 300,
			damSeepageReturnPct: 0.4,
			boreholeCapacityM3Day: 50,
			boreholeRule: 'drought',
			boreholeTriggerPct: 0.25,
			streamDepletionFrac: 0.3,
			streamDepletionLagDays: 12.5,
			// Supply rule and river pump (WP-3.8).
			supplyRule: 'trigger',
			pumpCapacityM3Day: 1234.5,
			supplyTriggerPct: 0.35,
			supplyStopPct: 0.65,
			// Development over the run (engine 1.28.0, 110_node_development): a leap day survives as a date.
			damSurveyDate: '2012-02-29',
			damSedimentPctPerYear: 0.0125,
			damInServiceFrom: '1999-10-01',
			abstractionFrom: '2001-01-01'
		});
		// A gauge taken off the EWR sites (engine 1.5.0, 086_ewr_site).
		const weir = node('Weir', outlet.id, { sortOrder: 4, kind: 'gauge', areaKm2: 0, damCapacityM3: 0, ewrSite: false });
		// The town carries the GN 538 property area and Table 2 rate (engine 1.12.0, 089_ga538_property).
		const town = node('Town', outlet.id, { sortOrder: 1, kind: 'user', areaKm2: 0, damCapacityM3: 0, userDemandM3Day: monthly(1 / 3), userReturnPct: 0.4, userPriority: 'junior', gaPropertyAreaHa: 62.5, gaRateM3HaYear: 45, abstractionFrom: '2005-07-15' });
		// A canal head, the river off-take's destination (engine 1.14.0, 091).
		const canal = node('Canal', outlet.id, { sortOrder: 6, areaKm2: 0, damCapacityM3: 0 });
		const beans = { id: crypto.randomUUID(), name: 'Beans', sortOrder: 2, cropFactor: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2] };
		const maize = { id: crypto.randomUUID(), name: 'Maize', sortOrder: 1, cropFactor: monthly(0.8) };
		const transfer = (priority: number, dailyCapM3: number | null) => ({
			id: crypto.randomUUID(),
			fromNodeId: farm.id,
			toNodeId: outlet.id,
			months: [11, 12, 1],
			maxRateM3s: 0.015,
			dailyCapM3,
			minStoragePct: 0.2,
			enabled: priority === 0,
			priority
		});
		const model = {
			// Out of order on purpose: the store orders by sortOrder, then name.
			nodes: [outlet, weir, town, farm, canal],
			crops: [beans, maize],
			cropAreas: [
				{ nodeId: farm.id, cropId: beans.id, areaM2: 1234.5 },
				{ nodeId: farm.id, cropId: maize.id, areaM2: 0.25 }
			],
			// The second with its own rate per month (engine 1.14.0, 090): months and max rate follow the list.
			transfers: [
				{ ...transfer(3, 1000), monthlyRateM3s: null, source: 'dam', handsOffM3Day: null, handsOffEwr: false, lossPct: 0, sizing: 'demand', topUpDam: false },
				// A river off-take (engine 1.14.0, 091) with every field of its own set.
				{
					...transfer(0, null),
					toNodeId: canal.id,
					months: [1, 10, 11, 12],
					maxRateM3s: 0.02,
					monthlyRateM3s: [0.25e-2, 0.01, 0.02, 0.015, 0, 0, 0, 0, 0, 0, 0, 0],
					source: 'river',
					handsOffM3Day: 250.5,
					handsOffEwr: true,
					lossPct: 0.15,
					sizing: 'capacity',
					topUpDam: true
				}
			],
			landCover: [
				{ id: crypto.randomUUID(), nodeId: farm.id, coverClass: 'pine', areaKm2: 1.5, densityPct: 0.6, factors: null },
				{ id: crypto.randomUUID(), nodeId: farm.id, coverClass: 'other', areaKm2: 0.2, densityPct: 1, factors: { mar: 0.33, lowFlow: 0.5 } }
			],
			// Individual boreholes (WP-3.9), out of name order on purpose.
			boreholes: [
				{ id: crypto.randomUUID(), nodeId: town.id, name: 'BH2', capacityM3Day: 12.5, annualCapM3: null, mode: 'primary', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0.25 },
				{ id: crypto.randomUUID(), nodeId: town.id, name: 'BH1', capacityM3Day: 40, annualCapM3: 9000, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 }
			],
			// Demand objects (engine 1.7.0, 088) on the farm (a unit), out of name order on purpose: one monthly, one per unit.
			demandObjects: [
				{ id: crypto.randomUUID(), nodeId: farm.id, name: 'Village', category: 'domestic', sizing: 'perUnit', monthlyM3Day: null, count: 1200, litresPerUnitDay: 90, lossPct: 0.2, monthlyFactor: [1, 1, 2.5, 2.5, 1, 1, 1, 1, 1, 1, 1, 0.5], returnPct: 0.35, priority: 'first', destination: 'internal', enabled: true,
					// A schedule (engine 1.17.0, 105), in its order: weekends at half, Easter at a peak.
					schedule: [
						{ label: 'Weekends', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: [6, 7], factor: 0.5 },
						{ label: 'Easter', span: 'easter', from: null, to: null, easterFrom: -2, easterTo: 1, weekdays: null, factor: 1.8 },
						{ label: 'Works shutdown', span: 'range', from: '2021-07-01', to: '2021-07-14', weekdays: null, easterFrom: null, easterTo: null, factor: 0 }
					],
					note: 'Red Book norm' },
				{ id: crypto.randomUUID(), nodeId: farm.id, name: 'Bulk export', category: 'external', sizing: 'monthly', monthlyM3Day: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12.25], count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0, priority: 'last', destination: 'external', enabled: false, schedule: null, note: '' }
			]
		};
		const put = await u.call('PUT', `/projects/${projectId}/model`, model);
		expect(put.status).toBe(200);

		const got = await withUser(u.id, (db) => loadModel(db, projectId));
		const full = (n: Record<string, unknown>) => ({
			userDemandM3Day: null,
			userReturnPct: 0,
			userPriority: 'senior',
			boreholeCapacityM3Day: null,
			boreholeRule: 'supplemental',
			boreholeTriggerPct: 0.3,
			streamDepletionFrac: 0,
			streamDepletionLagDays: 0,
			damCurve: null,
			damReleaseRule: 'none',
			damReleaseM3Day: null,
			damOutletCapacityM3Day: null,
			damSeepageReturnPct: 1,
			supplyRule: 'damFirst',
			pumpCapacityM3Day: null,
			supplyTriggerPct: 0.4,
			supplyStopPct: 0.6,
			ewrSite: true,
			gaPropertyAreaHa: null,
			gaRateM3HaYear: null,
			damSurveyDate: null,
			damSedimentPctPerYear: null,
			damInServiceFrom: null,
			abstractionFrom: null,
			...n
		});
		// Farm and Town share sortOrder 1, so by name: Town before Upper.
		expect(got.nodes).toEqual([full(town), full(farm), full(weir), full(outlet), full(canal)]);
		expect(got.crops).toEqual([maize, beans]);
		expect([...got.cropAreas].sort((a, b) => a.areaM2 - b.areaM2)).toEqual([model.cropAreas[1], model.cropAreas[0]]);
		expect(got.transfers).toEqual([model.transfers[1], model.transfers[0]]);
		// By node, then cover class: 'other' before 'pine'.
		expect(got.landCover).toEqual([model.landCover[1], model.landCover[0]]);
		expect(got.boreholes).toEqual([model.boreholes[1], model.boreholes[0]]);
		expect(got.demandObjects).toEqual([model.demandObjects[1], model.demandObjects[0]]);
		// The API serves the same document.
		expect((await u.call('GET', `/projects/${projectId}/model`)).body).toEqual(JSON.parse(JSON.stringify(got)));
	});

	it('round-trips a crop’s own irrigation efficiency and the monthly effective-rain fraction (engine 0.43.0, issue #54)', async () => {
		const u = await signUp('CropDemand');
		const projectId = await newProject(u, 'Crop demand options');
		const outlet = node('Outlet', null);
		const farm = node('Farm', outlet.id, { sortOrder: 1 });
		const drip = { id: crypto.randomUUID(), name: 'Citrus', sortOrder: 0, cropFactor: monthly(0.5), irrigationEfficiency: 0.9 };
		const plain = { id: crypto.randomUUID(), name: 'Pasture', sortOrder: 1, cropFactor: monthly(0.55) };
		const areas = [
			{ nodeId: farm.id, cropId: drip.id, areaM2: 10_000 },
			{ nodeId: farm.id, cropId: plain.id, areaM2: 20_000 }
		];
		const put = (crops: Record<string, unknown>[]) => u.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops, cropAreas: areas, transfers: [] });
		expect((await put([drip, plain])).status).toBe(200);
		let got = await withUser(u.id, (db) => loadModel(db, projectId));
		// A crop without one reads back without the key, so an older document is unchanged.
		expect(got.crops).toEqual([drip, plain]);
		expect('irrigationEfficiency' in got.crops[1]!).toBe(false);
		expect((await u.call('GET', `/projects/${projectId}/model`)).body.crops).toEqual([drip, plain]);

		// null clears it; out of (0, 1] is refused, the stored value untouched.
		expect((await put([{ ...drip, irrigationEfficiency: null }, plain])).status).toBe(200);
		got = await withUser(u.id, (db) => loadModel(db, projectId));
		expect(got.crops[0]).toEqual({ id: drip.id, name: drip.name, sortOrder: 0, cropFactor: drip.cropFactor });
		for (const bad of [0, 1.2, -0.5, '0.9']) expect((await put([{ ...drip, irrigationEfficiency: bad }, plain])).status, String(bad)).toBe(400);

		// The monthly effective-rain fraction: PATCH, read back, cleared with null; out of 0–1 refused.
		const f = [0.5, 0.55, 0.6, 0.65, 0.65, 0.6, 0.5, 0.4, 0.3, 0.3, 0.4, 0.45];
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { effectiveRainFractionMonthly: f } })).status).toBe(200);
		const s = await withUser(u.id, (db) => loadSettingsAndModel(db, projectId));
		expect((s.settings as { effectiveRainFractionMonthly: number[] }).effectiveRainFractionMonthly).toEqual(f);
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { effectiveRainFractionMonthly: [...f.slice(0, 11), 1.1] } })).status).toBe(400);
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { effectiveRainFractionMonthly: null } })).status).toBe(200);
		const cleared = await withUser(u.id, (db) => loadSettingsAndModel(db, projectId));
		expect((cleared.settings as { effectiveRainFractionMonthly: unknown }).effectiveRainFractionMonthly).toBeNull();
	});

	it('stores a demand object’s schedule (engine 1.17.0, 105): an empty one as none, a bad window refused', async () => {
		const u = await signUp('Schedule');
		const projectId = await newProject(u, 'Demand schedule');
		const outlet = node('Outlet', null);
		const farm = node('Farm', outlet.id, { sortOrder: 1 });
		const town = { id: crypto.randomUUID(), nodeId: farm.id, name: 'Town', category: 'municipal', sizing: 'monthly', monthlyM3Day: monthly(5), count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0.5, priority: 'first', destination: 'internal', enabled: true, note: '' };
		const put = (schedule: unknown) => u.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [], demandObjects: [{ ...town, schedule }] });
		const stored = async () => (await withUser(u.id, (db) => loadModel(db, projectId))).demandObjects![0]!.schedule;
		expect((await put([])).status).toBe(200);
		expect(await stored()).toBeNull();
		const weekends = [{ label: 'Weekends', span: 'always', from: null, to: null, easterFrom: null, easterTo: null, weekdays: [6, 7], factor: 0 }];
		expect((await put(weekends)).status).toBe(200);
		expect(await stored()).toEqual(weekends);
		// A date that doesn't exist, and 25 windows: refused, the stored schedule untouched.
		expect((await put([{ span: 'range', from: '2021-02-30', to: '2021-03-01', factor: 0 }])).status).toBe(400);
		expect((await put(Array.from({ length: 25 }, () => weekends[0])))).toMatchObject({ status: 400 });
		expect(await stored()).toEqual(weekends);
		// The column's own guard, past the API: not an empty list, not an object.
		for (const bad of ['[]', '{}']) await expect(withUser(u.id, (db) => db.query('UPDATE demand_object SET schedule = $2::jsonb WHERE id = $1', [town.id, bad]))).rejects.toThrow(/demand_object_schedule_shape/);
	});

	it('stores the development fields (engine 1.28.0, 110): null clears them, a field that breaks a rule is refused', async () => {
		const u = await signUp('Development');
		const projectId = await newProject(u, 'Development over time');
		const outlet = node('Outlet', null);
		const farm = node('Farm', outlet.id, { sortOrder: 1 });
		const town = node('Town', outlet.id, { sortOrder: 2, kind: 'user', areaKm2: 0, damCapacityM3: 0 });
		const put = (f: Record<string, unknown>, t: Record<string, unknown> = {}, o: Record<string, unknown> = {}) =>
			u.call('PUT', `/projects/${projectId}/model`, { nodes: [{ ...outlet, ...o }, { ...farm, ...f }, { ...town, ...t }], crops: [], cropAreas: [], transfers: [] });
		const stored = async () => {
			const got = (await withUser(u.id, (db) => loadModel(db, projectId))).nodes;
			const pick = (id: string) => {
				const n = got.find((x) => x.id === id)!;
				return { damSurveyDate: n.damSurveyDate, damSedimentPctPerYear: n.damSedimentPctPerYear, damInServiceFrom: n.damInServiceFrom, abstractionFrom: n.abstractionFrom };
			};
			return { farm: pick(farm.id), town: pick(town.id) };
		};
		const dev = { damSurveyDate: '2015-06-30', damSedimentPctPerYear: 0.01, damInServiceFrom: '2003-10-01', abstractionFrom: '2004-01-01' };
		expect((await put(dev, { abstractionFrom: '2010-10-01' })).status).toBe(200);
		expect(await stored()).toEqual({ farm: dev, town: { damSurveyDate: null, damSedimentPctPerYear: null, damInServiceFrom: null, abstractionFrom: '2010-10-01' } });

		// Each refused with the API's 400, the stored fields untouched.
		const refused: [Record<string, unknown>, Record<string, unknown>?, Record<string, unknown>?][] = [
			[{ ...dev, damSurveyDate: '2015-02-30' }],
			[{ ...dev, damInServiceFrom: '1 Oct 2003' }],
			[{ ...dev, damSedimentPctPerYear: 0.25 }],
			[{ ...dev, damSedimentPctPerYear: -0.01 }],
			[{ ...dev, damSurveyDate: null }],
			[dev, { damInServiceFrom: '2010-10-01' }],
			[dev, { damSurveyDate: '2010-10-01' }],
			[dev, {}, { abstractionFrom: '2010-10-01' }]
		];
		for (const [f, t, o] of refused) expect((await put(f, t, o)).status, JSON.stringify([f, t, o])).toBe(400);
		expect((await stored()).farm).toEqual(dev);

		// null (or absent) clears each.
		expect((await put({ damSurveyDate: null, damSedimentPctPerYear: null, damInServiceFrom: null, abstractionFrom: null })).status).toBe(200);
		expect(await stored()).toEqual({
			farm: { damSurveyDate: null, damSedimentPctPerYear: null, damInServiceFrom: null, abstractionFrom: null },
			town: { damSurveyDate: null, damSedimentPctPerYear: null, damInServiceFrom: null, abstractionFrom: null }
		});

		// The columns' own guards, past the API: the rate's range, and a positive rate needs its survey date.
		const raw = (sql: string) => withUser(u.id, (db) => db.query(sql, [farm.id]));
		await expect(raw('UPDATE node SET dam_sediment_pct_per_year = 0.3, dam_survey_date = DATE \'2015-06-30\' WHERE id = $1')).rejects.toThrow(/dam_sediment_pct_per_year_check/);
		await expect(raw('UPDATE node SET dam_sediment_pct_per_year = 0.01, dam_survey_date = NULL WHERE id = $1')).rejects.toThrow(/node_sediment_needs_survey/);
	});

	it('loads an empty model as empty lists, and settings with the model in one call', async () => {
		const u = await signUp('Empty');
		const projectId = await newProject(u, 'Empty');
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
		const got = await withUser(u.id, (db) => loadSettingsAndModel(db, projectId));
		expect(got.model).toEqual({ nodes: [], crops: [], cropAreas: [], transfers: [], landCover: [] });
		// No boreholes key at all when there are none, so older documents read back unchanged.
		expect('boreholes' in got.model).toBe(false);
		expect('demandObjects' in got.model).toBe(false);
		expect((got.settings as { apanMm: number[] }).apanMm).toEqual(monthly(150));
		// Another user's project: nothing visible, no settings.
		const stranger = await signUp('Stranger');
		const hidden = await withUser(stranger.id, (db) => loadSettingsAndModel(db, projectId));
		expect(hidden).toEqual({ settings: undefined, model: { nodes: [], crops: [], cropAreas: [], transfers: [], landCover: [] } });
	});

	it('saves in a fixed number of statements, whatever the size of the model', async () => {
		const u = await signUp('Sized');
		const small = await newProject(u, 'Small');
		const big = await newProject(u, 'Big');
		const smallModel = chain(3); // still a transfer after the second save drops one
		const bigModel = chain(60);
		// First saves insert; second saves update the same rows and delete one of each.
		const counts: number[] = [];
		for (const [projectId, m] of [
			[small, smallModel],
			[big, bigModel]
		] as const) {
			counts.push(await countStatements(u.id, (db) => saveModel(db, projectId, m)));
			const next = { ...m, nodes: m.nodes.slice(0, -1), transfers: m.transfers.slice(0, -1), cropAreas: m.cropAreas.slice(0, -1), landCover: m.landCover!.slice(0, -1), boreholes: m.boreholes!.slice(0, -1), demandObjects: m.demandObjects!.slice(0, -1) };
			counts.push(await countStatements(u.id, (db) => saveModel(db, projectId, next)));
		}
		expect(counts[0]).toBeLessThanOrEqual(10);
		expect(new Set(counts)).toEqual(new Set([counts[0]]));
		const got = await withUser(u.id, (db) => loadModel(db, big));
		expect(got.nodes).toHaveLength(60);
		expect(got.transfers).toHaveLength(58);
		expect(got.cropAreas).toHaveLength(59);
		expect(got.landCover).toHaveLength(59);
		expect(got.boreholes).toHaveLength(59);
		expect(got.demandObjects).toHaveLength(59);
		expect(got.nodes.filter((n) => n.downstreamNodeId === bigModel.nodes[0]!.id)).toHaveLength(59);
	});

	it('refuses, as a whole, a save whose land-cover, transfer or borehole id is another project’s', async () => {
		const u = await signUp('Hijack');
		const a = await newProject(u, 'A');
		const b = await newProject(u, 'B');
		const m = chain(2);
		expect((await u.call('PUT', `/projects/${a}/model`, m)).status).toBe(200);
		const fresh = chain(2);
		for (const stolen of [
			{ ...fresh, landCover: [{ ...m.landCover![0]!, nodeId: fresh.nodes[1]!.id }] },
			{ ...fresh, transfers: [{ ...m.transfers[0]!, fromNodeId: fresh.nodes[1]!.id, toNodeId: fresh.nodes[2]!.id }] },
			{ ...fresh, boreholes: [{ ...m.boreholes![0]!, nodeId: fresh.nodes[1]!.id }] }
		]) {
			const res = await u.call('PUT', `/projects/${b}/model`, stolen);
			expect(res.status).toBe(409);
			expect((await u.call('GET', `/projects/${b}/model`)).body.nodes).toEqual([]);
		}
		// Project A is untouched (the positive control: its rows are still there).
		const got = (await u.call('GET', `/projects/${a}/model`)).body;
		expect(got.landCover).toHaveLength(2);
		expect(got.transfers).toHaveLength(1);
		expect(got.boreholes).toHaveLength(m.boreholes!.length);
	});
});
