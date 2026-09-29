import { describe, expect, it } from 'vitest';
import { DEMAND_TABLE_ID, GRID_TAB, GRIDS, gridHref, isGridId, movedGridHref, overlayHref, withoutParam, withParam } from './overlays';

describe('overlays', () => {
	it('knows its grids and the tab each lives on', () => {
		expect(Object.keys(GRID_TAB).sort()).toEqual(Object.keys(GRIDS).sort());
		expect(isGridId('planted-areas')).toBe(true);
		expect(isGridId('nodes')).toBe(true);
		expect(GRID_TAB.nodes).toBeNull();
		// The crop grids live only in the modal since Crops & demand became cards and bars; Transfers is still its tab's page.
		expect(GRID_TAB['crop-factors']).toBeNull();
		expect(GRID_TAB['planted-areas']).toBeNull();
		expect(GRID_TAB.transfers).toBe('transfers');
		// The Irrigation demand preview left the modal (issue #174): the Crops & demand page shows it in place.
		expect(isGridId('demand')).toBe(false);
		expect(isGridId('network')).toBe(false);
		expect(isGridId(null)).toBe(false);
		expect(isGridId('toString')).toBe(false);
	});

	it('sends an old grid=demand link to the Crops & demand page with its table shown', () => {
		expect(movedGridHref(new URL('http://x/projects/p1?tab=network&grid=demand'))).toBe(`/projects/p1?tab=crops#${DEMAND_TABLE_ID}`);
		expect(movedGridHref(new URL('http://x/projects/p1?tab=crops&grid=demand&crop=c1'))).toBe('/projects/p1?tab=crops#crop-demand-table');
		expect(movedGridHref(new URL('http://x/projects/p1?grid=demand'))).toBe('/projects/p1?tab=crops#crop-demand-table');
		expect(movedGridHref(new URL('http://x/projects/p1?tab=crops&grid=planted-areas'))).toBeNull();
		expect(movedGridHref(new URL('http://x/projects/p1?tab=crops'))).toBeNull();
	});

	it('opens an overlay over a tab, or over the Summary with no tab', () => {
		expect(gridHref('network', 'crop-factors')).toBe('?tab=network&grid=crop-factors');
		expect(gridHref(null, 'transfers')).toBe('?grid=transfers');
		expect(overlayHref('overview', 'farm', 'f 1')).toBe('?farm=f+1');
	});

	it('opens an overlay over the page as it is, keeping its other parameters', () => {
		expect(withParam(new URL('http://x/p?tab=network&view=table'), 'farm', 'f1')).toBe('?tab=network&view=table&farm=f1');
		expect(withParam(new URL('http://x/p?tab=network&grid=transfers'), 'grid', 'nodes')).toBe('?tab=network&grid=nodes');
	});

	it('closes one overlay and keeps everything else', () => {
		expect(withoutParam(new URL('http://x/p?tab=network&grid=transfers&view=table#h'), 'grid')).toBe('/p?tab=network&view=table#h');
		expect(withoutParam(new URL('http://x/p?grid=transfers'), 'grid')).toBe('/p');
	});
});
