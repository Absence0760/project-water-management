import { describe, expect, it } from 'vitest';
import type { ProjectModel } from '@water-management/engine';
import { changedAreas } from './changedAreas';

const base = (): ProjectModel => ({
	nodes: [{ id: 'a', name: 'A' } as never],
	crops: [{ id: 'c', name: 'Citrus', cropFactor: new Array(12).fill(1) }],
	cropAreas: [],
	transfers: [],
	landCover: []
});

describe('changedAreas', () => {
	it('is empty for the same model, an absent list counting as an empty one', () => {
		const { landCover: _l, ...noCover } = base();
		expect(changedAreas(base(), base())).toEqual([]);
		expect(changedAreas(base(), noCover as ProjectModel)).toEqual([]);
	});

	it('names each area whose lists changed, in tab order', () => {
		const d = base();
		d.transfers = [{ id: 't' } as never];
		d.cropAreas = [{ nodeId: 'a', cropId: 'c', areaM2: 10 }];
		expect(changedAreas(base(), d)).toEqual(['crops', 'transfers']);
	});

	it('counts what hangs on a node (boreholes, demand objects, land cover) as the network', () => {
		for (const k of ['boreholes', 'demandObjects', 'landCover'] as const) {
			const d = { ...base(), [k]: [{ id: 'x', nodeId: 'a' }] } as ProjectModel;
			expect(changedAreas(base(), d), k).toEqual(['network']);
		}
		const renamed = base();
		renamed.nodes[0]!.name = 'B';
		expect(changedAreas(base(), renamed)).toEqual(['network']);
	});
});
