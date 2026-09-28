// Farmers linked to farm nodes (WP-2.1), for the Network tab: how many per
// farm, and the confirmation shown before deleting a node. Deleting a farm, or
// changing it to a gauge or water user, unlinks its farmers when the model is
// saved (020_farm_scope.sql), so the owner is told before it happens.
import type { FarmerEntry } from '$lib/api/types';

/** Linked farmers per node id. A pending invite (WP-2.2) links nobody yet, so it isn't counted. */
export function countByNode(farmers: readonly Pick<FarmerEntry, 'nodeIds' | 'status'>[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const f of farmers) if (f.status === 'active') for (const id of f.nodeIds) out[id] = (out[id] ?? 0) + 1;
	return out;
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The note on a farm's detail panel; null when no farmer is linked. */
export function linkedNote(count: number): string | null {
	if (!count) return null;
	return `${n(count, 'farmer is', 'farmers are')} linked to this hydrological unit (Overview → Farmers). Deleting it, or making it a gauge or water user, unlinks them when you save.`;
}

/**
 * The confirmation before removing a node, or null when nothing else goes with
 * it. `farmers` is null when the farmer list couldn't be loaded: a farm then
 * always asks, so an owner is never left unwarned.
 */
export function removeMessage(o: { name: string; isFarm: boolean; areas: number; transfers: number; cover: number; boreholes?: number; demandObjects?: number; farmers: number | null }): string | null {
	const unknownFarmers = o.isFarm && o.farmers === null;
	const farmers = o.farmers ?? 0;
	const boreholes = o.boreholes ?? 0;
	const objects = o.demandObjects ?? 0;
	if (!o.areas && !o.transfers && !o.cover && !boreholes && !objects && !farmers && !unknownFarmers) return null;
	const parts = [`${o.areas} crop area(s)`, `${o.transfers} transfer(s)`];
	if (o.cover) parts.push(`${o.cover} land-cover patch(es)`);
	if (boreholes) parts.push(`${boreholes} borehole(s)`);
	if (objects) parts.push(`${objects} demand object(s)`);
	let text = `Remove "${o.name}"? Its ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)} are removed too; nodes draining into it are re-routed downstream.`;
	if (farmers) text += ` ${n(farmers, 'farmer linked to it loses', 'farmers linked to it lose')} access when you save.`;
	else if (unknownFarmers) text += ' Any farmers linked to it lose access when you save.';
	return text;
}
