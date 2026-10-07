// Pure helpers behind the network editor's reordering and re-parenting.
// Row order is display-only (node.sortOrder, persisted); the model's
// calculation order always comes from the drains-into topology.
import type { NetworkNode } from '@water-management/engine';

export { moveTo, renumber } from '$lib/model/order';

/** Ids of every node upstream of `id` (draining into it directly or indirectly). */
export function upstreamOf(nodes: readonly Pick<NetworkNode, 'id' | 'downstreamNodeId'>[], id: string): Set<string> {
	const children = new Map<string, string[]>();
	for (const n of nodes) {
		if (n.downstreamNodeId === null) continue;
		if (!children.has(n.downstreamNodeId)) children.set(n.downstreamNodeId, []);
		children.get(n.downstreamNodeId)!.push(n.id);
	}
	const out = new Set<string>();
	const stack = [...(children.get(id) ?? [])];
	while (stack.length) {
		const c = stack.pop()!;
		if (out.has(c) || c === id) continue;
		out.add(c);
		stack.push(...(children.get(c) ?? []));
	}
	return out;
}

/**
 * Flow-path order: each tributary listed from its headwater down to where it
 * joins, tributaries in their current order, the outlet last — i.e. a
 * post-order walk from the outlet, stable by the current row order. Nodes not
 * connected to an outlet (a loop) keep their order at the end.
 */
export function flowPathOrder(nodes: NetworkNode[]): NetworkNode[] {
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	const ids = new Set(nodes.map((n) => n.id));
	const children = new Map<string, NetworkNode[]>();
	const roots: NetworkNode[] = [];
	for (const n of nodes) {
		const d = n.downstreamNodeId;
		if (d === null || !ids.has(d)) roots.push(n);
		else if (d !== n.id) {
			if (!children.has(d)) children.set(d, []);
			children.get(d)!.push(n);
		}
	}
	const out: NetworkNode[] = [];
	const seen = new Set<string>();
	const walk = (n: NetworkNode) => {
		if (seen.has(n.id)) return;
		seen.add(n.id);
		const kids = [...(children.get(n.id) ?? [])].sort((a, b) => index.get(a.id)! - index.get(b.id)!);
		for (const c of kids) walk(c);
		out.push(n);
	};
	for (const r of roots) walk(r);
	for (const n of nodes) if (!seen.has(n.id)) out.push(n);
	return out;
}

export type DropCheck = { ok: true } | { ok: false; reason: string };

/** Can `dragId` be re-pointed to drain into `targetId`? */
export function canDrainInto(nodes: NetworkNode[], dragId: string, targetId: string): DropCheck {
	const drag = nodes.find((n) => n.id === dragId);
	if (!drag || !nodes.some((n) => n.id === targetId)) return { ok: false, reason: 'unknown hydrological unit' };
	if (dragId === targetId) return { ok: false, reason: 'a hydrological unit cannot drain into itself' };
	if (drag.downstreamNodeId === null) {
		return { ok: false, reason: 'the outflow gauge stays at the outlet; use "Make outflow gauge" on another hydrological unit to change it' };
	}
	if (upstreamOf(nodes, dragId).has(targetId)) {
		return { ok: false, reason: 'that hydrological unit is upstream of this one, so it would make a loop' };
	}
	return { ok: true };
}

/** Every node `dragId` may be dropped onto (its current downstream node included). */
export function validDropTargets(nodes: NetworkNode[], dragId: string): Set<string> {
	return new Set(nodes.filter((n) => canDrainInto(nodes, dragId, n.id).ok).map((n) => n.id));
}

/**
 * Make `id` the outflow gauge: it drains nowhere, and the previous outlet
 * (and any other node draining nowhere) drains into it, so nothing is left
 * disconnected and no loop can form.
 */
export function makeOutlet(nodes: NetworkNode[], id: string): void {
	const target = nodes.find((n) => n.id === id);
	if (!target) return;
	for (const n of nodes) if (n.downstreamNodeId === null && n.id !== id) n.downstreamNodeId = id;
	target.downstreamNodeId = null;
}
