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

/** "1 crop area", "2 crop areas": a count with its noun. */
const count = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;

/**
 * The confirmation before removing a node, or null when nothing else goes with
 * it. The dialog's title asks the question ("Remove “Farm A”?"), so this is
 * only what goes with the node: the parts it has (a zero isn't listed), the
 * nodes draining into it, which move to where it drained, and its farmers.
 * `farmers` is null when the farmer list couldn't be loaded: a farm then
 * always asks, so an owner is never left unwarned. `upstream` counts the nodes
 * that drain into it, `into` names where they will drain (null: the removed
 * node is the outlet, so they become outlets).
 */
export function removeMessage(o: {
	isFarm: boolean;
	areas: number;
	transfers: number;
	cover: number;
	boreholes?: number;
	demandObjects?: number;
	farmers: number | null;
	upstream?: number;
	into?: string | null;
}): string | null {
	const unknownFarmers = o.isFarm && o.farmers === null;
	const farmers = o.farmers ?? 0;
	const upstream = o.upstream ?? 0;
	const parts = [
		o.areas && count(o.areas, 'crop area'),
		o.transfers && count(o.transfers, 'transfer'),
		o.cover && count(o.cover, 'land-cover patch', 'land-cover patches'),
		o.boreholes && count(o.boreholes, 'borehole'),
		o.demandObjects && count(o.demandObjects, 'demand object')
	].filter((p): p is string => !!p);
	if (!parts.length && !upstream && !farmers && !unknownFarmers) return null;
	const sentences: string[] = [];
	if (parts.length) sentences.push(`Its ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]} ${parts.length === 1 && /^1 /.test(parts[0]!) ? 'goes' : 'go'} with it.`);
	if (upstream) {
		const nodes = upstream === 1 ? 'The hydrological unit that drains into it' : `The ${upstream} hydrological units that drain into it`;
		sentences.push(o.into ? `${nodes} will drain into “${o.into}”.` : `${nodes} will have nowhere to drain: make one of them the outflow gauge.`);
	}
	if (farmers) sentences.push(`${n(farmers, 'farmer linked to it loses', 'farmers linked to it lose')} access when you save.`);
	else if (unknownFarmers) sentences.push('Any farmers linked to it lose access when you save.');
	sentences.push('Until you save, Discard brings it back.');
	return sentences.join(' ');
}
