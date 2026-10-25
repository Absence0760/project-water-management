// GET /model lists crop areas in one order whatever order they were saved or
// stored in: unit id, then crop id (model/store.ts MODEL_JSON), the order the
// engine sums them in (run.ts). Without it Postgres returned them in heap
// order, so a restored revision could read back reordered against its
// snapshot (history.db.test.ts failed on PR #580's CI).
// Needs Postgres (pnpm dev:db:up).
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

describe('crop areas read back in a stable order', () => {
	it('whatever order a PUT sends them in, GET /model lists them by unit id, then crop id', async () => {
		const owner = await signUp('CropOrderOwner');
		const id = (await owner.call('POST', '/projects', { name: 'Crop order' })).body.project.id as string;
		const out = node('Outlet', null, { sortOrder: 0, kind: 'gauge' });
		const farms = ['Farm A', 'Farm B', 'Farm C'].map((name, i) => node(name, out.id, { sortOrder: i + 1 }));
		const crops = ['Citrus', 'Vines'].map((name, i) => ({ id: crypto.randomUUID(), name, sortOrder: i, cropFactor: monthly(0.6) }));
		const areas = farms.flatMap((f, i) => crops.map((c, j) => ({ nodeId: f.id, cropId: c.id, areaM2: 10_000 * (i + 1) + j })));
		const sorted = [...areas].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : a.cropId < b.cropId ? -1 : a.cropId > b.cropId ? 1 : 0));

		for (const order of [sorted, [...sorted].reverse()]) {
			const put = await owner.call('PUT', `/projects/${id}/model`, { nodes: [out, ...farms], crops, cropAreas: order, transfers: [] });
			expect(put.status).toBe(200);
			const got = (await owner.call('GET', `/projects/${id}/model`)).body.cropAreas as { nodeId: string; cropId: string; areaM2: number }[];
			expect(got.map((a) => [a.nodeId, a.cropId, a.areaM2])).toEqual(sorted.map((a) => [a.nodeId, a.cropId, a.areaM2]));
		}
	});
});
