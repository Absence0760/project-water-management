// View helpers for FarmersPanel (WP-2.1): which farms a farmer is linked to,
// by name, and the checkbox list's selection. Kept free of Svelte so they can
// be unit-tested.
import type { Farmer } from '$lib/api/types';

export interface FarmOption {
	id: string;
	name: string;
}

/**
 * The names of a farmer's farms, in the order the farms are listed. A link to
 * a node the model no longer has as a farm (deleted, not saved yet) shows as
 * "a removed farm" rather than disappearing, so the count still adds up.
 */
export function farmNames(farmer: Pick<Farmer, 'nodeIds'>, farms: readonly FarmOption[]): string[] {
	const linked = new Set(farmer.nodeIds);
	const names = farms.filter((f) => linked.has(f.id)).map((f) => f.name);
	const missing = farmer.nodeIds.filter((id) => !farms.some((f) => f.id === id)).length;
	return missing ? [...names, missing === 1 ? 'a removed farm' : `${missing} removed farms`] : names;
}

/** Add or remove `id`, keeping the farms' order. */
export function toggleFarm(selected: readonly string[], id: string, farms: readonly FarmOption[]): string[] {
	const next = new Set(selected);
	if (next.has(id)) next.delete(id);
	else next.add(id);
	return farms.filter((f) => next.has(f.id)).map((f) => f.id);
}
