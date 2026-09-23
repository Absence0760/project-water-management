// Network topology: turns the downstreamNodeId links into an upstream-first
// calculation order, like the b023 [Network] sheet ("upstream nodes
// referenced must be in the list above the current node").
import type { NetworkNode } from '../project';

export interface Topology {
	/** Node indices (into the input array), every node after all of its upstream nodes. */
	order: Int32Array;
	/** upstream[i] = indices of the nodes draining directly into node i. */
	upstream: Int32Array[];
	/** Index of the outflow node (downstreamNodeId null) whose outflow is the simulated catchment outflow. */
	outflow: number;
	warnings: string[];
}

/**
 * Build the calculation order. Throws on structural errors the model cannot
 * run with (unknown downstream reference, a cycle, no outflow node); returns
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

	// Pick the outflow node: prefer a gauge when there are several roots.
	let outflow = roots[0] ?? -1;
	if (roots.length > 1) {
		const gauge = roots.find((r) => nodes[r]!.kind === 'gauge');
		if (gauge !== undefined) outflow = gauge;
		warnings.push(
			`network has ${roots.length} outflow nodes (${roots.map((r) => nodes[r]!.name).join(', ')}); ` +
				`"${nodes[outflow]!.name}" is used as the catchment outflow and the others' water is not counted`
		);
	}

	return {
		order: Int32Array.from(order),
		upstream: upstreamLists.map((l) => Int32Array.from(l)),
		outflow,
		warnings
	};
}
