// Overlays opened over any workspace tab from a URL parameter, so they can
// be linked and Back closes them (issue #17): the farm drawer (`farm=<nodeId>`,
// crops/farmDrawer.ts) and the grid modal (`grid=<id>`): an existing grid,
// unchanged, full screen.

/** The grids the grid modal can show, with their titles. */
export const GRIDS = {
	nodes: 'Hydrological unit table',
	'crop-factors': 'Crop factors',
	'planted-areas': 'Planted areas',
	systems: 'Irrigation systems',
	transfers: 'Transfers',
	demands: 'Demands'
} as const;

export type GridId = keyof typeof GRIDS;

/**
 * The Tables menu: every grid, in GRIDS' order, with its title. The Network's
 * and Crops & demand's menus both list it, so the two name the same grids in
 * the same order (issue #463).
 */
export const TABLES_MENU = Object.entries(GRIDS) as [GridId, string][];

export function isGridId(v: string | null): v is GridId {
	return v !== null && Object.hasOwn(GRIDS, v);
}

/**
 * The workspace tab a grid is also shown on, where the modal isn't opened
 * (the grid is already on the page); null: only ever in the modal (the node
 * table, since the Network became a map, and the crop grids, since Crops &
 * demand became cards and bars, issue #17, and the irrigation systems, which
 * sat below that page's window-fit layout, and the Demands table, which
 * gathers every unit's demands).
 */
export const GRID_TAB: Record<GridId, string | null> = {
	nodes: null,
	'crop-factors': null,
	'planted-areas': null,
	systems: null,
	transfers: 'transfers',
	demands: null
};

/** The id of the Crops & demand page's in-place demand table (its Show table), for a link that opens it. */
export const DEMAND_TABLE_ID = 'crop-demand-table';

/**
 * Where a link to a grid that left the modal goes now, or null. `grid=demand`
 * (the Irrigation demand preview) repeated the chart and table the Crops &
 * demand page shows in place, so it was removed (issue #174); an old link
 * (a bookmark, over any tab) opens that page with the table shown.
 */
export function movedGridHref(url: URL): string | null {
	const grid = url.searchParams.get('grid');
	if (grid === 'demand') return `${url.pathname}?tab=crops#${DEMAND_TABLE_ID}`;
	// A tab's own grid over another tab opens on its tab, every other parameter kept.
	if (isTabGridId(grid) && url.searchParams.get('tab') !== TAB_GRIDS[grid].tab) {
		const q = new URLSearchParams(url.search);
		q.set('tab', TAB_GRIDS[grid].tab);
		return `${url.pathname}?${q}${url.hash}`;
	}
	return null;
}

/**
 * Grids a tab draws in a modal of its own rather than through the page's
 * GridModal, because they aren't the model's (the map's features are saved
 * one by one, not through the model's save bar, #326 E3). Same `grid=<id>`
 * parameter, same open-and-Back behaviour; the page leaves the parameter to
 * the tab, and a link over another tab goes to the tab (movedGridHref).
 */
export const TAB_GRIDS = {
	'map-features': { tab: 'map', title: 'Every map feature' }
} as const;

export type TabGridId = keyof typeof TAB_GRIDS;

export function isTabGridId(v: string | null): v is TabGridId {
	return v !== null && Object.hasOwn(TAB_GRIDS, v);
}

/** `?tab=<tab>&<name>=<value>`, or no `tab` over the Summary (the default tab). */
export function overlayHref(tab: string | null, name: string, value: string): string {
	const q = new URLSearchParams();
	if (tab && tab !== 'overview') q.set('tab', tab);
	q.set(name, value);
	return `?${q}`;
}

/** The link that opens a grid in the modal over `tab`. */
export const gridHref = (tab: string | null, grid: GridId) => overlayHref(tab, 'grid', grid);

/**
 * The current page with one overlay opened: `name=value` added, every other
 * parameter kept (the tab's own state, e.g. the Network's `view`), so closing
 * it comes back to exactly where it was opened.
 */
export function withParam(url: URL, name: string, value: string): string {
	const q = new URLSearchParams(url.search);
	q.set(name, value);
	return `?${q}`;
}

/** The URL with one overlay closed: `name` dropped, everything else kept. */
export function withoutParam(url: URL, name: string): string {
	const q = new URLSearchParams(url.search);
	q.delete(name);
	const s = q.toString();
	return `${url.pathname}${s ? `?${s}` : ''}${url.hash}`;
}
