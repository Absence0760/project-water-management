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
		boreholes: farms.map((f) => ({ id: crypto.randomUUID(), nodeId: f.id, name: 'BH', capacityM3Day: 10, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 }))
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
			streamDepletionLagDays: 12.5
		});
		const town = node('Town', outlet.id, { sortOrder: 1, kind: 'user', areaKm2: 0, damCapacityM3: 0, userDemandM3Day: monthly(1 / 3), userReturnPct: 0.4, userPriority: 'junior' });
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
			nodes: [outlet, town, farm],
			crops: [beans, maize],
			cropAreas: [
				{ nodeId: farm.id, cropId: beans.id, areaM2: 1234.5 },
				{ nodeId: farm.id, cropId: maize.id, areaM2: 0.25 }
			],
			transfers: [transfer(3, 1000), transfer(0, null)],
			landCover: [
				{ id: crypto.randomUUID(), nodeId: farm.id, coverClass: 'pine', areaKm2: 1.5, densityPct: 0.6, factors: null },
				{ id: crypto.randomUUID(), nodeId: farm.id, coverClass: 'other', areaKm2: 0.2, densityPct: 1, factors: { mar: 0.33, lowFlow: 0.5 } }
			],
			// Individual boreholes (WP-3.9), out of name order on purpose.
			boreholes: [
				{ id: crypto.randomUUID(), nodeId: town.id, name: 'BH2', capacityM3Day: 12.5, annualCapM3: null, mode: 'primary', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0.25 },
				{ id: crypto.randomUUID(), nodeId: town.id, name: 'BH1', capacityM3Day: 40, annualCapM3: 9000, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 }
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
			...n
		});
		// Farm and Town share sortOrder 1, so by name: Town before Upper.
		expect(got.nodes).toEqual([full(town), full(farm), full(outlet)]);
		expect(got.crops).toEqual([maize, beans]);
		expect([...got.cropAreas].sort((a, b) => a.areaM2 - b.areaM2)).toEqual([model.cropAreas[1], model.cropAreas[0]]);
		expect(got.transfers).toEqual([model.transfers[1], model.transfers[0]]);
		// By node, then cover class: 'other' before 'pine'.
		expect(got.landCover).toEqual([model.landCover[1], model.landCover[0]]);
		expect(got.boreholes).toEqual([model.boreholes[1], model.boreholes[0]]);
		// The API serves the same document.
		expect((await u.call('GET', `/projects/${projectId}/model`)).body).toEqual(JSON.parse(JSON.stringify(got)));
	});

	it('loads an empty model as empty lists, and settings with the model in one call', async () => {
		const u = await signUp('Empty');
		const projectId = await newProject(u, 'Empty');
		expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
		const got = await withUser(u.id, (db) => loadSettingsAndModel(db, projectId));
		expect(got.model).toEqual({ nodes: [], crops: [], cropAreas: [], transfers: [], landCover: [] });
		// No boreholes key at all when there are none, so older documents read back unchanged.
		expect('boreholes' in got.model).toBe(false);
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
			const next = { ...m, nodes: m.nodes.slice(0, -1), transfers: m.transfers.slice(0, -1), cropAreas: m.cropAreas.slice(0, -1), landCover: m.landCover!.slice(0, -1), boreholes: m.boreholes!.slice(0, -1) };
			counts.push(await countStatements(u.id, (db) => saveModel(db, projectId, next)));
		}
		expect(counts[0]).toBeLessThanOrEqual(9);
		expect(new Set(counts)).toEqual(new Set([counts[0]]));
		const got = await withUser(u.id, (db) => loadModel(db, big));
		expect(got.nodes).toHaveLength(60);
		expect(got.transfers).toHaveLength(58);
		expect(got.cropAreas).toHaveLength(59);
		expect(got.landCover).toHaveLength(59);
		expect(got.boreholes).toHaveLength(59);
		expect(got.nodes.filter((n) => n.downstreamNodeId === bigModel.nodes[0]!.id)).toHaveLength(59);
	});

	it('refuses, as a whole, a save whose land-cover or transfer id is another project’s', async () => {
		const u = await signUp('Hijack');
		const a = await newProject(u, 'A');
		const b = await newProject(u, 'B');
		const m = chain(2);
		expect((await u.call('PUT', `/projects/${a}/model`, m)).status).toBe(200);
		const fresh = chain(2);
		for (const stolen of [
			{ ...fresh, landCover: [{ ...m.landCover![0]!, nodeId: fresh.nodes[1]!.id }] },
			{ ...fresh, transfers: [{ ...m.transfers[0]!, fromNodeId: fresh.nodes[1]!.id, toNodeId: fresh.nodes[2]!.id }] }
		]) {
			const res = await u.call('PUT', `/projects/${b}/model`, stolen);
			expect(res.status).toBe(409);
			expect((await u.call('GET', `/projects/${b}/model`)).body.nodes).toEqual([]);
		}
		// Project A is untouched (the positive control: its rows are still there).
		const got = (await u.call('GET', `/projects/${a}/model`)).body;
		expect(got.landCover).toHaveLength(2);
		expect(got.transfers).toHaveLength(1);
	});
});
