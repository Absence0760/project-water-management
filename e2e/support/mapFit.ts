// Whether the Network map's drawing is laid out for the window as it is now
// (issue #138). A viewport change reaches the drawing a frame or more later:
// the map box's size through a ResizeObserver (`bind:clientWidth`), the
// 900 px breakpoint through a media query's change event, and the Map
// layout's height through the page's own ResizeObserver (`--map-top`,
// NetworkTab.svelte). Measured before then, the labels belong to the old
// width's drawing and can move between two reads. The schematic's scroller
// says what it was laid out for (`data-fit`); this compares that with the box
// read at the same moment. Pure, so node:test covers it (mapFit.test.ts).

/** One reading, taken in the page in a single evaluation. */
export interface MapFitReading {
	/** The scroller's `data-fit`: "<width>x<height>", plus " wide" from 900 px. */
	fit: string | null;
	/** The scroller's clientWidth and clientHeight now. */
	width: number;
	height: number;
	/** `(min-width: 900px)` now. */
	wide: boolean;
	/** The Map layout's `--map-top` as set (null when there is no Map layout, e.g. the report). */
	mapTop: string | null;
	/** Where the Map layout's top is now (its page offset), or null. */
	top: number | null;
}

/** True once the drawing on screen was laid out for the box, breakpoint and map height of this reading. */
export function mapFitSettled(r: MapFitReading): boolean {
	if (r.fit !== `${r.width}x${r.height}${r.wide ? ' wide' : ''}`) return false;
	if (r.top === null) return true;
	return r.mapTop !== null && parseFloat(r.mapTop) === r.top;
}
