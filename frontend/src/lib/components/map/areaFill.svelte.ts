// The Map's Area fill slider (docs/ui.md § Map): how strongly the polygons'
// fills are drawn, 0–100 %, so the basemap, relief, rivers and the MAP and
// CHIRPS grids read through the units and their results colours. A viewer's
// convenience, kept in this browser (localStorage, read and written
// defensively: a private window or blocked storage just starts at 100 %),
// never in the project or the URL.

/** The browser key the percentage is kept under. */
export const AREA_FILL_KEY = 'wm.map.areaFill';
/** The slider's step, %. */
export const AREA_FILL_STEP = 5;

/** A stored or typed value as a whole percentage 0–100 on the slider's step; anything else is 100. */
export function areaFillPercent(v: unknown): number {
	const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : typeof v === 'number' ? v : NaN;
	if (!Number.isFinite(n)) return 100;
	return Math.min(100, Math.max(0, Math.round(n / AREA_FILL_STEP) * AREA_FILL_STEP));
}

function stored(): number {
	try {
		return typeof localStorage === 'undefined' ? 100 : areaFillPercent(localStorage.getItem(AREA_FILL_KEY));
	} catch {
		return 100;
	}
}

export class AreaFill {
	percent = $state(100);

	constructor() {
		this.percent = stored();
	}

	/** The fills' opacity scale for the map, 0–1. */
	get scale(): number {
		return this.percent / 100;
	}

	set(v: unknown) {
		this.percent = areaFillPercent(v);
		try {
			if (this.percent === 100) localStorage.removeItem(AREA_FILL_KEY);
			else localStorage.setItem(AREA_FILL_KEY, String(this.percent));
		} catch {
			// Blocked storage: the slider still works for this visit.
		}
	}
}
