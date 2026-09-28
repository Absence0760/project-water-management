import { describe, expect, it } from 'vitest';
import type { ProjectModel } from '@water-management/engine';
import { farmDrawerHref, farmPlanting, withoutFarm } from './farmDrawer';

const model = {
	nodes: [],
	crops: [
		{ id: 'c1', name: 'Citrus', cropFactor: [] },
		{ id: 'c2', name: 'Vines', cropFactor: [] },
		{ id: 'c3', name: 'Pasture', cropFactor: [] }
	],
	cropAreas: [
		{ nodeId: 'f1', cropId: 'c2', areaM2: 30_000 },
		{ nodeId: 'f1', cropId: 'c1', areaM2: 10_000 },
		{ nodeId: 'f2', cropId: 'c1', areaM2: 99_000 },
		{ nodeId: 'f1', cropId: 'c3', areaM2: 0 }
	],
	transfers: []
} as unknown as ProjectModel;

describe('farmPlanting', () => {
	it("lists every crop in the model's order with this farm's area, and totals it", () => {
		expect(farmPlanting(model, 'f1')).toEqual({
			rows: [
				{ cropId: 'c1', name: 'Citrus', areaM2: 10_000 },
				{ cropId: 'c2', name: 'Vines', areaM2: 30_000 },
				{ cropId: 'c3', name: 'Pasture', areaM2: 0 }
			],
			totalM2: 40_000,
			planted: 2
		});
	});

	it('gives a farm with nothing planted zero rows of area', () => {
		const p = farmPlanting(model, 'nope');
		expect(p.rows.map((r) => r.areaM2)).toEqual([0, 0, 0]);
		expect(p.totalM2).toBe(0);
		expect(p.planted).toBe(0);
	});
});

describe('farmDrawerHref', () => {
	it('opens over the named tab, or over the Summary with no tab', () => {
		expect(farmDrawerHref('network', 'f 1')).toBe('?tab=network&farm=f+1');
		expect(farmDrawerHref(null, 'f1')).toBe('?farm=f1');
		expect(farmDrawerHref('overview', 'f1')).toBe('?farm=f1');
	});
});

describe('withoutFarm', () => {
	it('drops only the farm parameter', () => {
		expect(withoutFarm(new URL('http://x/projects/p?tab=network&farm=f1'))).toBe('/projects/p?tab=network');
		expect(withoutFarm(new URL('http://x/projects/p?farm=f1'))).toBe('/projects/p');
		expect(withoutFarm(new URL('http://x/projects/p?tab=runs&run=r&farm=f1#res'))).toBe('/projects/p?tab=runs&run=r#res');
	});
});
