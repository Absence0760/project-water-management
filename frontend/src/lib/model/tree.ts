// Turn the flat node list into the drainage tree for display: the outlet at
// the root, each node's children = the nodes that drain into it.
import type { NetworkNode } from '@water-management/engine';

export interface TreeRow {
	node: NetworkNode;
	depth: number;
	/** Number of nodes upstream of this one (all descendants). */
	upstreamCount: number;
}

/**
 * Depth-first rows under each root (a node draining nowhere or into a missing
 * node). Nodes caught in a cycle are unreachable from any root; they're
 * returned separately so the UI can show them.
 */
export function drainageTree(nodes: NetworkNode[]): { rows: TreeRow[]; orphans: NetworkNode[] } {
	const ids = new Set(nodes.map((n) => n.id));
	const children = new Map<string, NetworkNode[]>();
	const roots: NetworkNode[] = [];
	const order = (a: NetworkNode, b: NetworkNode) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
	for (const n of nodes) {
		const d = n.downstreamNodeId;
		if (d === null || !ids.has(d) || d === n.id) {
			if (d !== n.id) roots.push(n);
			continue;
		}
		if (!children.has(d)) children.set(d, []);
		children.get(d)!.push(n);
	}
	const rows: TreeRow[] = [];
	const visited = new Set<string>();
	const walk = (n: NetworkNode, depth: number): number => {
		visited.add(n.id);
		const row: TreeRow = { node: n, depth, upstreamCount: 0 };
		rows.push(row);
		let count = 0;
		for (const c of (children.get(n.id) ?? []).sort(order)) {
			if (!visited.has(c.id)) count += 1 + walk(c, depth + 1);
		}
		row.upstreamCount = count;
		return count;
	};
	for (const r of roots.sort(order)) walk(r, 0);
	return { rows, orphans: nodes.filter((n) => !visited.has(n.id)) };
}
