// Where <DownloadMenu> puts its list while open. The list is position: fixed,
// placed against the viewport from the trigger's box, so a scrolling ancestor
// (a .table-wrap with overflow-x: auto, which makes overflow-y auto too) can't
// clip it or grow a scrollbar around it. Pure, so it's unit-tested.

export interface Box {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

export interface MenuPlacement {
	/** Exactly one of top / bottom is set: below the trigger, or above it. */
	top?: number;
	bottom?: number;
	/** Exactly one of left / right is set, from the align prop. */
	left?: number;
	right?: number;
	/** The list scrolls past this height (px). */
	maxHeight: number;
}

const GAP = 4;
const EDGE = 8;
/** Open below unless there's less room than this and more above. */
const MIN_BELOW = 200;

export function menuPlacement(trigger: Box, viewport: { width: number; height: number }, align: 'start' | 'end'): MenuPlacement {
	const below = viewport.height - trigger.bottom - GAP - EDGE;
	const above = trigger.top - GAP - EDGE;
	const down = below >= MIN_BELOW || below >= above;
	const vertical = down ? { top: trigger.bottom + GAP } : { bottom: viewport.height - trigger.top + GAP };
	const horizontal = align === 'start' ? { left: Math.max(EDGE, trigger.left) } : { right: Math.max(EDGE, viewport.width - trigger.right) };
	return { ...vertical, ...horizontal, maxHeight: Math.max(0, Math.floor(down ? below : above)) };
}

/** Inline style for the placement. */
export function placementStyle(p: MenuPlacement): string {
	const px = (k: string, v: number | undefined) => (v === undefined ? '' : `${k}: ${v}px; `);
	return `${px('top', p.top)}${px('bottom', p.bottom)}${px('left', p.left)}${px('right', p.right)}max-height: ${p.maxHeight}px;`;
}
