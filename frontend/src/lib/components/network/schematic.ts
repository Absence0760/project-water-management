// Layout of the network schematic: the drains-into tree drawn with the
// outflow gauge at the bottom and headwaters at the top, in grid units
// (col, row) that the SVG scales to pixels.
import type { NetworkNode } from '@water-management/engine';

export interface SchematicNode {
	node: NetworkNode;
	/** Column, 0-based; fractional when centred over several branches. */
	col: number;
	/** Row, 0 = top. The outlet sits on the last row. */
	row: number;
	/** Hops from the outlet (0 = outlet). */
	depth: number;
	/** Catchment area of this node plus everything upstream, km². */
	cumulativeAreaKm2: number;
}

export interface SchematicEdge {
	/** Upstream node → the node it drains into. */
	from: string;
	to: string;
}

export interface SchematicLayout {
	nodes: SchematicNode[];
	edges: SchematicEdge[];
	cols: number;
	rows: number;
	/** Nodes unreachable from an outlet (caught in a drainage loop). */
	orphans: NetworkNode[];
}

const order = (a: NetworkNode, b: NetworkNode) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

export function schematicLayout(nodes: NetworkNode[]): SchematicLayout {
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
	for (const list of children.values()) list.sort(order);
	roots.sort(order);

	const placed = new Map<string, { col: number; depth: number; area: number }>();
	const edges: SchematicEdge[] = [];
	let nextLeafCol = 0;
	let maxDepth = 0;

	// Post-order: leaves take the next free column, a parent is centred over
	// its first and last branch. Returns the node's cumulative area.
	const place = (n: NetworkNode, depth: number, onPath: Set<string>): number => {
		onPath.add(n.id);
		maxDepth = Math.max(maxDepth, depth);
		const kids = (children.get(n.id) ?? []).filter((c) => !onPath.has(c.id) && !placed.has(c.id));
		let area = n.areaKm2 || 0;
		const cols: number[] = [];
		for (const c of kids) {
			area += place(c, depth + 1, onPath);
			cols.push(placed.get(c.id)!.col);
			edges.push({ from: c.id, to: n.id });
		}
		const col = cols.length ? (cols[0]! + cols[cols.length - 1]!) / 2 : nextLeafCol++;
		placed.set(n.id, { col, depth, area });
		onPath.delete(n.id);
		return area;
	};
	for (const r of roots) place(r, 0, new Set());

	const out: SchematicNode[] = [];
	for (const n of nodes) {
		const p = placed.get(n.id);
		if (p) out.push({ node: n, col: p.col, row: maxDepth - p.depth, depth: p.depth, cumulativeAreaKm2: p.area });
	}
	return {
		nodes: out,
		edges,
		cols: Math.max(nextLeafCol, 1),
		rows: out.length ? maxDepth + 1 : 0,
		orphans: nodes.filter((n) => !placed.has(n.id))
	};
}
