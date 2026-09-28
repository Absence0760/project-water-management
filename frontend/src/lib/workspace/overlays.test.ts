import { describe, expect, it } from 'vitest';
import { GRID_TAB, GRIDS, gridHref, isGridId, overlayHref, withoutParam, withParam } from './overlays';

describe('overlays', () => {
	it('knows its grids and the tab each lives on', () => {
		expect(Object.keys(GRID_TAB).sort()).toEqual(Object.keys(GRIDS).sort());
		expect(isGridId('planted-areas')).toBe(true);
		expect(isGridId('nodes')).toBe(true);
		expect(GRID_TAB.nodes).toBeNull();
		// The crop grids live only in the modal since Crops & demand became cards and bars; Transfers is still its tab's page.
		expect(GRID_TAB['crop-factors']).toBeNull();
		expect(GRID_TAB['planted-areas']).toBeNull();
		expect(GRID_TAB.demand).toBeNull();
		expect(GRID_TAB.transfers).toBe('transfers');
		expect(isGridId('network')).toBe(false);
		expect(isGridId(null)).toBe(false);
		expect(isGridId('toString')).toBe(false);
	});

	it('opens an overlay over a tab, or over the Summary with no tab', () => {
		expect(gridHref('network', 'crop-factors')).toBe('?tab=network&grid=crop-factors');
		expect(gridHref(null, 'transfers')).toBe('?grid=transfers');
		expect(overlayHref('overview', 'farm', 'f 1')).toBe('?farm=f+1');
	});

	it('opens an overlay over the page as it is, keeping its other parameters', () => {
		expect(withParam(new URL('http://x/p?tab=network&view=table'), 'farm', 'f1')).toBe('?tab=network&view=table&farm=f1');
		expect(withParam(new URL('http://x/p?tab=network&grid=transfers'), 'grid', 'demand')).toBe('?tab=network&grid=demand');
	});

	it('closes one overlay and keeps everything else', () => {
		expect(withoutParam(new URL('http://x/p?tab=network&grid=transfers&view=table#h'), 'grid')).toBe('/p?tab=network&view=table#h');
		expect(withoutParam(new URL('http://x/p?grid=transfers'), 'grid')).toBe('/p');
	});
});
