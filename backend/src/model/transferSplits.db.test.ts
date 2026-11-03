// A transfer split between destinations and a curve by month (engine 1.114.0,
// migration 311, docs/model.md §2.6 and §2.6a): every field survives a save
// and a load, an older client's toNodeId alone still saves as one destination,
// the save refuses a split or a formula it can't run with a sentence, and the
// database holds the same rules below the API (its CHECKs, the same-project
// trigger, a node's delete taking its rules, a farmer seeing a rule with a
// destination on their farm). Needs Postgres (pnpm dev:db:up).
import { describe, expect, it } from 'vitest';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadModel } from './store.js';

type User = Awaited<ReturnType<typeof signUp>>;

async function setUp(name: string) {
	const u = await signUp(name);
	const projectId = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const src = node('River farm', outlet.id, { sortOrder: 1, areaKm2: 3 });
	const a = node('Canal farmers', outlet.id, { sortOrder: 2 });
	const b = node('Town', outlet.id, { sortOrder: 3, damCapacityM3: 20_000 });
	const c = node('Third farm', outlet.id, { sortOrder: 4 });
	const nodes = [outlet, src, a, b, c];
	const put = (transfers: Record<string, unknown>[], ns = nodes) => u.call('PUT', `/projects/${projectId}/model`, { nodes: ns, crops: [], cropAreas: [], transfers });
	return { u, projectId, nodes, src, a, b, c, put };
}

const base = (from: string, to: string | null) => ({
	id: crypto.randomUUID(),
	fromNodeId: from,
	toNodeId: to,
	months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
	maxRateM3s: 0.236,
	dailyCapM3: null,
	minStoragePct: 0,
	enabled: true,
	priority: 0
});

const curve = (a: number) => ({ coefficient: a, exponent: -0.9, maxPct: 0.97 });

describe('transfers split between destinations, and a curve by month (migration 311)', () => {
	it('round-trips a 40/60 split with a formula in summer and a maximum in winter', async () => {
		const { u, projectId, src, a, b, put } = await setUp('SplitRoundTrip');
		const monthly = [curve(2000), curve(2000), curve(1500), curve(1500), curve(1500), curve(2000), null, null, null, null, null, null];
		const rule = {
			...base(src.id, a.id),
			source: 'river',
			sizing: 'diversionCurve',
			diversionFlowUnit: 'm3/s',
			monthlyDiversion: monthly,
			destinations: [
				{ nodeId: a.id, pct: 0.4 },
				{ nodeId: b.id, pct: 0.6 }
			]
		};
		expect((await put([rule])).status).toBe(200);
		const got = (await withUser(u.id, (db) => loadModel(db, projectId))).transfers[0]!;
		expect(got).toMatchObject({ toNodeId: a.id, sizing: 'diversionCurve', diversionCoefficient: null, diversionFlowUnit: 'm3/s', monthlyDiversion: monthly, destinations: rule.destinations });
		// A month's largest share left out loads as none (= 100 %); a one-row split saves as that destination alone.
		const one = { ...rule, monthlyDiversion: [{ coefficient: 10, exponent: 0 }, ...new Array(11).fill(null)], destinations: [{ nodeId: a.id, pct: 1 }] };
		expect((await put([one])).status).toBe(200);
		expect((await withUser(u.id, (db) => loadModel(db, projectId))).transfers[0]).toMatchObject({ toNodeId: a.id, destinations: null, monthlyDiversion: [{ coefficient: 10, exponent: 0, maxPct: null }, ...new Array(11).fill(null)] });
	});

	it('takes an older client’s toNodeId alone as one destination, and a split without toNodeId as its first', async () => {
		const { u, projectId, src, a, b, c, put } = await setUp('SplitBackCompat');
		const old = base(src.id, b.id);
		expect((await put([old])).status).toBe(200);
		expect((await withUser(u.id, (db) => loadModel(db, projectId))).transfers[0]).toMatchObject({ toNodeId: b.id, destinations: null });
		const { toNodeId: _, ...noTo } = { ...base(src.id, null), source: 'dam', destinations: [{ nodeId: c.id, pct: 0.25 }, { nodeId: a.id, pct: 0.5 }, { nodeId: null, pct: 0.25 }] };
		expect((await put([noTo])).status).toBe(200);
		expect((await withUser(u.id, (db) => loadModel(db, projectId))).transfers[0]).toMatchObject({ toNodeId: c.id, destinations: noTo.destinations });
		const neither = await put([{ ...noTo, destinations: null }]);
		expect(neither.status).toBe(400);
		expect(JSON.stringify(neither.body)).toMatch(/needs a destination/);
	});

	it('refuses, with a sentence, shares that don’t add up, more than five, one twice, and a formula from the dam', async () => {
		const { src, a, b, c, put, nodes } = await setUp('SplitRefusals');
		const refused = async (t: Record<string, unknown>, why: RegExp, ns = nodes) => {
			const res = await put([t], ns);
			expect(res.status, JSON.stringify(res.body)).toBe(400);
			expect(JSON.stringify(res.body)).toMatch(why);
		};
		const river = { ...base(src.id, a.id), source: 'river', sizing: 'capacity' };
		await refused({ ...river, destinations: [{ nodeId: a.id, pct: 0.4 }, { nodeId: b.id, pct: 0.5 }] }, /must add up to 100 % \(they add up to 90 %\)/);
		const more = [1, 2, 3, 4, 5, 6].map((i) => node(`Extra ${i}`, nodes[0]!.id, { sortOrder: 10 + i }));
		await refused({ ...river, destinations: [a, ...more.slice(0, 5)].map((n) => ({ nodeId: n.id, pct: 1 / 6 })) }, /at most 5 destinations \(it has 6\)/, [...nodes, ...more]);
		await refused({ ...river, destinations: [{ nodeId: a.id, pct: 0.5 }, { nodeId: a.id, pct: 0.5 }] }, /one destination twice/);
		await refused({ ...river, toNodeId: c.id, destinations: [{ nodeId: a.id, pct: 0.5 }, { nodeId: b.id, pct: 0.5 }] }, /first split destination/);
		await refused(
			{ ...base(src.id, a.id), source: 'dam', sizing: 'diversionCurve', diversionFlowUnit: 'm3/s', monthlyDiversion: [curve(2000), ...new Array(11).fill(null)] },
			/a formula takes a share of the river’s flow, so it needs the river as its source/
		);
	});

	it('holds the same rules below the API, and checks each destination is the project’s', async () => {
		const { u, projectId, src, a, b, put } = await setUp('SplitConstraints');
		const other = await setUp('SplitOtherProject');
		const rule = { ...base(src.id, a.id), source: 'river', sizing: 'capacity', destinations: [{ nodeId: a.id, pct: 0.5 }, { nodeId: b.id, pct: 0.5 }] };
		expect((await put([rule])).status).toBe(200);
		const bad = async (set: string, constraint: string) =>
			expect(asOwner(`UPDATE transfer SET ${set} WHERE id = $1`, [rule.id]), set).rejects.toMatchObject({ code: '23514', constraint });
		await bad('split_pct = ARRAY[0.5, 0.4]::float8[]', 'transfer_split');
		await bad('split_pct = NULL', 'transfer_split');
		await bad(`split_node_ids = ARRAY['${b.id}', '${a.id}']::uuid[]`, 'transfer_split_first');
		await bad(`split_node_ids = ARRAY['${a.id}', NULL]::uuid[]`, 'transfer_split_external_from_dam');
		await bad(`split_node_ids = ARRAY['${a.id}', '${a.id}']::uuid[]`, 'transfer_split');
		await bad(`monthly_diversion_coefficient = array_fill(NULL::float8, ARRAY[12]), monthly_diversion_exponent = array_fill(NULL::float8, ARRAY[12]), monthly_diversion_max_pct = array_fill(NULL::float8, ARRAY[12])`, 'transfer_monthly_diversion');
		await bad(`monthly_diversion_coefficient = array_fill(1::float8, ARRAY[12]), monthly_diversion_exponent = array_fill(0::float8, ARRAY[12]), monthly_diversion_max_pct = array_fill(NULL::float8, ARRAY[12])`, 'transfer_monthly_diversion_sizing');
		// Another project's node as a destination: the same-project trigger, as for to_node_id.
		await expect(asOwner(`UPDATE transfer SET split_node_ids = ARRAY['${a.id}', '${other.b.id}']::uuid[] WHERE id = $1`, [rule.id])).rejects.toMatchObject({ code: '23503' });
		// Positive control: a valid rewrite goes through.
		await asOwner(`UPDATE transfer SET split_pct = ARRAY[0.3, 0.7]::float8[] WHERE id = $1`, [rule.id]);
		expect((await withUser(u.id, (db) => loadModel(db, projectId))).transfers[0]!.destinations).toEqual([{ nodeId: a.id, pct: 0.3 }, { nodeId: b.id, pct: 0.7 }]);
		// Deleting a node a share goes to deletes the rule, as to_node_id's cascade does for the first.
		await asOwner('DELETE FROM node WHERE id = $1', [b.id]);
		expect((await asOwner('SELECT count(*)::int AS n FROM transfer WHERE id = $1', [rule.id]))[0].n).toBe(0);
	});

	it('shows a farmer a rule with any destination on their farm, and not a stranger’s', async () => {
		const { u, projectId, src, a, b, c, put } = await setUp('SplitFarmer');
		const farmerB: User = await signUp('SplitFarmerB');
		const farmerC: User = await signUp('SplitFarmerC');
		const rule = { ...base(src.id, a.id), source: 'river', sizing: 'capacity', destinations: [{ nodeId: a.id, pct: 0.5 }, { nodeId: b.id, pct: 0.5 }] };
		expect((await put([rule])).status).toBe(200);
		expect((await u.call('POST', `/projects/${projectId}/farmers`, { email: farmerB.email, nodeIds: [b.id] })).status).toBe(201);
		expect((await u.call('POST', `/projects/${projectId}/farmers`, { email: farmerC.email, nodeIds: [c.id] })).status).toBe(201);
		const seen = async (f: User) => withUser(f.id, async (db) => (await db.query('SELECT id FROM transfer WHERE project_id = $1', [projectId])).rows.map((r) => r.id));
		expect(await seen(farmerB)).toEqual([rule.id]);
		expect(await seen(farmerC)).toEqual([]);
	});
});
