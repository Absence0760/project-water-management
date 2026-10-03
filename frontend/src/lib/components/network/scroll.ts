// Scrolling picked things into view on the Network: `formOffScreen` (from the
// removed One node layout), and `inViewDelta` / `keepInView`, which keep a
// picked node inside the drawing's box and its row inside the All nodes list.

/**
 * True when the one-node form (which starts at the picker) is mostly out of
 * view: the picker sits in the bottom 40 % of the viewport or below it, or has
 * scrolled up out of it.
 */
export function formOffScreen(picker: { top: number; bottom: number }, viewportHeight: number): boolean {
	return picker.top > viewportHeight * 0.6 || picker.bottom < 0;
}

interface Box {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/**
 * How far to scroll a box (the schematic's scroller, the All nodes list) so
 * that an item inside it is in view, with `margin` px to spare: 0 on an axis
 * where it already is. From the two bounding boxes, not scrollIntoView, which
 * would scroll the page or the sheet as well (playbook § 4). An item bigger
 * than the box lines up with its start.
 */
export function inViewDelta(box: Box, item: Box, margin = 8): { dx: number; dy: number } {
	const axis = (lo: number, hi: number, itemLo: number, itemHi: number) => {
		if (itemLo < lo + margin) return itemLo - lo - margin;
		if (itemHi > hi - margin) return Math.min(itemHi - hi + margin, itemLo - lo - margin);
		return 0;
	};
	return { dx: axis(box.left, box.right, item.left, item.right), dy: axis(box.top, box.bottom, item.top, item.bottom) };
}

/** Scrolls `box` by inViewDelta so `item` is in view; nothing when either is missing. */
export function keepInView(box: HTMLElement | null | undefined, item: Element | null | undefined, margin = 8): void {
	if (!box || !item) return;
	const { dx, dy } = inViewDelta(box.getBoundingClientRect(), item.getBoundingClientRect(), margin);
	if (dx) box.scrollLeft += dx;
	if (dy) box.scrollTop += dy;
}
