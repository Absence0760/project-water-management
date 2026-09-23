// The single display order for nodes and crops (their persisted sortOrder),
// used by every list, table and picker so nothing sorts on its own. Display
// only: the model always runs in drains-into (topological) order.
import type { CropDef, NetworkNode, ProjectModel } from '@water-management/engine';

type Sortable = { id: string; sortOrder?: number };

/** Stable sort by sortOrder (missing = array position). */
export function bySortOrder<T extends Sortable>(items: readonly T[]): T[] {
	return items
		.map((item, i) => ({ item, key: item.sortOrder ?? i, i }))
		.sort((a, b) => a.key - b.key || a.i - b.i)
		.map((x) => x.item);
}

export const orderedNodes = (model: Pick<ProjectModel, 'nodes'>): NetworkNode[] => bySortOrder(model.nodes);
export const orderedCrops = (model: Pick<ProjectModel, 'crops'>): CropDef[] => bySortOrder(model.crops);

/** Renumber sortOrder 0..n-1 to match the array order (mutates, returns the array). */
export function renumber<T extends { sortOrder?: number }>(items: T[]): T[] {
	items.forEach((x, i) => (x.sortOrder = i));
	return items;
}

/** Move the item at `from` to index `to` (clamped); returns a new, renumbered array. */
export function moveTo<T extends { sortOrder?: number }>(items: readonly T[], from: number, to: number): T[] {
	const out = [...items];
	if (from < 0 || from >= out.length) return out;
	const target = Math.max(0, Math.min(out.length - 1, to));
	const [item] = out.splice(from, 1);
	out.splice(target, 0, item!);
	return renumber(out);
}

/**
 * Reorder a subset of `all` (e.g. only the farms, in the crop-area matrix):
 * the subset member at subset index `from` moves to subset index `to`, and the
 * subset is written back into the same slots it occupied, so items outside
 * the subset (gauges) keep their positions. Returns a new, renumbered array.
 */
export function reorderSubset<T extends Sortable>(all: readonly T[], subsetIds: readonly string[], from: number, to: number): T[] {
	const want = new Set(subsetIds);
	const slots: number[] = [];
	all.forEach((x, i) => want.has(x.id) && slots.push(i));
	const members = slots.map((i) => all[i]!);
	const moved = moveTo(members, from, to);
	const out = [...all];
	slots.forEach((slot, k) => (out[slot] = moved[k]!));
	return renumber(out);
}
