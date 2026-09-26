// Farmers linked to farm nodes (WP-2.1), for the Network tab: how many per
// farm, and the confirmation shown before deleting a node. Deleting a farm, or
// changing it to a gauge or water user, unlinks its farmers when the model is
// saved (020_farm_scope.sql), so the owner is told before it happens.
import type { Farmer } from '$lib/api/types';

/** Linked farmers per node id. */
export function countByNode(farmers: readonly Pick<Farmer, 'nodeIds'>[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const f of farmers) for (const id of f.nodeIds) out[id] = (out[id] ?? 0) + 1;
	return out;
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The note on a farm's detail panel; null when no farmer is linked. */
export function linkedNote(count: number): string | null {
	if (!count) return null;
	return `${n(count, 'farmer is', 'farmers are')} linked to this farm (Overview → Farmers). Deleting it, or making it a gauge or water user, unlinks them when you save.`;
}

/**
 * The confirmation before removing a node, or null when nothing else goes with
 * it. `farmers` is null when the farmer list couldn't be loaded: a farm then
 * always asks, so an owner is never left unwarned.
 */
export function removeMessage(o: { name: string; isFarm: boolean; areas: number; transfers: number; cover: number; farmers: number | null }): string | null {
	const unknownFarmers = o.isFarm && o.farmers === null;
	const farmers = o.farmers ?? 0;
	if (!o.areas && !o.transfers && !o.cover && !farmers && !unknownFarmers) return null;
	const parts = [`${o.areas} crop area(s)`, `${o.transfers} transfer(s)`];
	if (o.cover) parts.push(`${o.cover} land-cover patch(es)`);
	let text = `Remove "${o.name}"? Its ${parts.slice(0, -1).join(', ')} and ${parts.at(-1)} are removed too; nodes draining into it are re-routed downstream.`;
	if (farmers) text += ` ${n(farmers, 'farmer linked to it loses', 'farmers linked to it lose')} access when you save.`;
	else if (unknownFarmers) text += ' Any farmers linked to it lose access when you save.';
	return text;
}
