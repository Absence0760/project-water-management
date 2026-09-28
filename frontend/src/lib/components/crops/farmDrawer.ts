// The per-farm planted-areas drawer (issue #17, option A step 4): one farm's
// crops and areas, opened over any workspace tab with `farm=<nodeId>` in the
// URL. The drawer edits the shared ModelEditor, like the Crops tab.
import type { ProjectModel } from '@water-management/engine';
import { overlayHref, withoutParam } from '$lib/workspace/overlays';

export interface FarmPlanting {
	/** Every crop in the model, in its order, with this farm's area (m², 0 when unplanted). */
	rows: { cropId: string; name: string; areaM2: number }[];
	/** Sum of the rows, m². */
	totalM2: number;
	/** Crops with an area above 0. */
	planted: number;
}

export function farmPlanting(model: ProjectModel, nodeId: string): FarmPlanting {
	const area = new Map(model.cropAreas.filter((a) => a.nodeId === nodeId).map((a) => [a.cropId, a.areaM2 || 0]));
	const rows = model.crops.map((c) => ({ cropId: c.id, name: c.name, areaM2: area.get(c.id) ?? 0 }));
	return {
		rows,
		totalM2: rows.reduce((s, r) => s + r.areaM2, 0),
		planted: rows.filter((r) => r.areaM2 > 0).length
	};
}

/** The link that opens the drawer for a farm over `tab` (lib/workspace/overlays.ts). */
export const farmDrawerHref = (tab: string | null, nodeId: string) => overlayHref(tab, 'farm', nodeId);

/** The URL with the drawer closed: `farm` dropped, everything else kept. */
export const withoutFarm = (url: URL) => withoutParam(url, 'farm');
