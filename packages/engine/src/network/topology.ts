// Network topology: turns the downstreamNodeId links into an upstream-first
// calculation order, like the b023 [Network] sheet ("upstream nodes
// referenced must be in the list above the current node").
import type { NetworkNode } from '../project';
import { cmpStr } from '../order';

export interface Topology {
	/** Node indices (into the input array), every node after all of its upstream nodes. */
	order: Int32Array;
	/** upstream[i] = indices of the nodes draining directly into node i. */
	upstream: Int32Array[];
	/** Index of the single outflow node (downstreamNodeId null), whose outflow is the simulated catchment outflow; -1 for an empty network. */
	outflow: number;
	warnings: string[];
}

/**
 * Build the calculation order. Throws on structural errors the model cannot
 * run with (unknown downstream reference, a cycle, no outflow node or more
 * than one); returns
 * warnings for problems it can work around.
 */
export function buildTopology(nodes: readonly NetworkNode[]): Topology {
	const warnings: string[] = [];
	const n = nodes.length;
	const indexById = new Map<string, number>();
	nodes.forEach((node, i) => {
		if (indexById.has(node.id)) throw new Error(`duplicate node id ${node.id}`);
		indexById.set(node.id, i);
	});

	const downstream = new Int32Array(n).fill(-1);
	const upstreamLists: number[][] = nodes.map(() => []);
	const roots: number[] = [];
	nodes.forEach((node, i) => {
		if (node.downstreamNodeId === null) {
			roots.push(i);
			return;
		}
		const d = indexById.get(node.downstreamNodeId);
		if (d === undefined) {
			throw new Error(`node "${node.name}" drains into unknown node ${node.downstreamNodeId}`);
		}
		if (d === i) throw new Error(`node "${node.name}" drains into itself`);
		downstream[i] = d;
		upstreamLists[d]!.push(i);
	});

	if (n > 0 && roots.length === 0) throw new Error('network has no outflow node (every node drains somewhere: a cycle)');

	// Keep a stable, user-meaningful order among siblings: sortOrder, then input order.
	const bySort = (a: number, b: number) => nodes[a]!.sortOrder - nodes[b]!.sortOrder || a - b;
	for (const list of upstreamLists) list.sort(bySort);

	// Post-order DFS from each root: upstream nodes first.
	const order: number[] = [];
	const state = new Uint8Array(n); // 0 new, 1 visiting, 2 done
	const visit = (root: number) => {
		const stack: [number, number][] = [[root, 0]];
		state[root] = 1;
		while (stack.length) {
			const top = stack[stack.length - 1]!;
			const ups = upstreamLists[top[0]]!;
			if (top[1] < ups.length) {
				const u = ups[top[1]++]!;
				if (state[u] === 0) {
					state[u] = 1;
					stack.push([u, 0]);
				}
			} else {
				state[top[0]] = 2;
				order.push(top[0]);
				stack.pop();
			}
		}
	};
	for (const r of [...roots].sort(bySort)) visit(r);
	if (order.length !== n) {
		const stuck = nodes.filter((_, i) => state[i] !== 2).map((x) => x.name);
		throw new Error(`network has a cycle through: ${stuck.join(', ')}`);
	}

	// The simulated catchment outflow is one node's outflow: with several roots
	// the others' water would silently leave the balance, and which root counts
	// would depend on array order. The backend rejects this on save; the engine
	// does too, so a direct caller can't get a quietly wrong result.
	if (roots.length > 1) {
		throw new Error(
			`network has ${roots.length} outflow nodes (${roots.map((r) => nodes[r]!.name).join(', ')}); ` +
				'exactly one node may drain into nothing — point the others downstream'
		);
	}
	const outflow = roots[0] ?? -1;

	return {
		order: Int32Array.from(order),
		upstream: upstreamLists.map((l) => Int32Array.from(l)),
		outflow,
		warnings
	};
}

/**
 * A calculation order that doesn't depend on how the nodes are listed or on
 * their sortOrder: the nodes furthest from the outflow first, and nodes at
 * the same distance by id. Every node still comes after all of its upstream
 * nodes (they are further out). The daily balance can run in `order`, since
 * each node reads only its upstream results; the EWR attribution sums the
 * farms' impacts in the order it is given (./attribution.ts), so runModel
 * gives it this one and Σ impacts is the same to the last bit whatever the
 * display order (docs/model.md §6, order invariance).
 */
export function canonicalOrder(nodes: readonly NetworkNode[], topo: Pick<Topology, 'order' | 'upstream'>): Int32Array {
	const depth = new Int32Array(nodes.length);
	// Reverse calculation order visits every node before its upstream nodes.
	for (let k = topo.order.length - 1; k >= 0; k--) {
		const i = topo.order[k]!;
		for (const u of topo.upstream[i]!) depth[u] = depth[i]! + 1;
	}
	return Int32Array.from(topo.order).sort((a, b) => depth[b]! - depth[a]! || cmpStr(nodes[a]!.id, nodes[b]!.id));
}

/**
 * Is node `n` an EWR site (engine ≥ 1.5.0)? The outlet always; a gauge unless
 * its `ewrSite` flag is false; a farm or other user never.
 */
export function isEwrSite(n: Pick<NetworkNode, 'kind' | 'downstreamNodeId' | 'ewrSite'>): boolean {
	return n.downstreamNodeId === null || (n.kind === 'gauge' && n.ewrSite !== false);
}

/**
 * The EWR sites in the engine's order (./attribution.ts, docs/model.md §2.7b):
 * the outlet first, then every gauge that is an EWR site, by node id. One
 * function for runModel, the stored-run recompute (views/farmProjection.ts)
 * and the checks, so they can't disagree on which sites a run had.
 */
export function ewrSiteNodes(nodes: readonly NetworkNode[], outflow: number): number[] {
	const gauges = nodes
		.flatMap((n, i) => (i !== outflow && n.kind === 'gauge' && n.ewrSite !== false ? [i] : []))
		.sort((a, b) => cmpStr(nodes[a]!.id, nodes[b]!.id));
	return [...(outflow >= 0 ? [outflow] : []), ...gauges];
}
