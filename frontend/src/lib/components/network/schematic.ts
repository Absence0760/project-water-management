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

// --- transfer arcs (pixel space) -------------------------------------------
// Transfers are drawn as arcs that leave the source and reach the target at
// right angles to the line between them. A fixed bend could run through a
// node's label (labels sit to the right of each symbol), so the bend is
// searched: the smallest one, on either side, whose curve clears every label
// and every other node's symbol and stays inside the drawing.

export interface Point {
	x: number;
	y: number;
}
export interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}
/** A cubic Bézier from the source towards the target. */
export interface Arc {
	from: Point;
	c1: Point;
	c2: Point;
	/** End point, stopped short of the target symbol so the arrowhead shows. */
	to: Point;
}

/** Average glyph widths (px) of the 12.5 px label and 11 px meta lines, rounded up. */
const LABEL_CHAR_W = 7;
const META_CHAR_W = 6.1;

/** The two text lines drawn right of a node at `p` (label at y−2, meta at y+12). */
export function labelBox(p: Point, label: string, meta: string): Box {
	const w = Math.max(label.length * LABEL_CHAR_W, meta.length * META_CHAR_W);
	return { x0: p.x + 15, y0: p.y - 13, x1: p.x + 17 + w, y1: p.y + 16 };
}

/** A node's symbol (the largest is the 24 × 20 outflow triangle). */
export function symbolBox(p: Point): Box {
	return { x0: p.x - 13, y0: p.y - 12, x1: p.x + 13, y1: p.y + 12 };
}

const STOP_SHORT = 14;
const CLEARANCE = 3;
const SAMPLES = 64;

function pointAt(a: Arc, t: number): Point {
	const u = 1 - t;
	const [k0, k1, k2, k3] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
	return {
		x: k0 * a.from.x + k1 * a.c1.x + k2 * a.c2.x + k3 * a.to.x,
		y: k0 * a.from.y + k1 * a.c1.y + k2 * a.c2.y + k3 * a.to.y
	};
}

/** How many sampled points of the arc fall inside a box (grown by a small clearance) or outside `bounds`. */
export function arcHits(arc: Arc, boxes: readonly Box[], bounds?: Box): number {
	let hits = 0;
	for (let i = 1; i <= SAMPLES; i++) {
		const p = pointAt(arc, i / SAMPLES);
		if (bounds && (p.x < bounds.x0 || p.x > bounds.x1 || p.y < bounds.y0 || p.y > bounds.y1)) hits++;
		else if (boxes.some((b) => p.x > b.x0 - CLEARANCE && p.x < b.x1 + CLEARANCE && p.y > b.y0 - CLEARANCE && p.y < b.y1 + CLEARANCE)) hits++;
	}
	return hits;
}

function bent(a: Point, b: Point, n: Point, h: number): Arc {
	const c1 = { x: a.x + n.x * h, y: a.y + n.y * h };
	const c2 = { x: b.x + n.x * h, y: b.y + n.y * h };
	// The curve reaches b heading from c2, so stop short along that line.
	const d = Math.hypot(b.x - c2.x, b.y - c2.y) || 1;
	return { from: a, c1, c2, to: { x: b.x - ((b.x - c2.x) / d) * STOP_SHORT, y: b.y - ((b.y - c2.y) / d) * STOP_SHORT } };
}

/**
 * The arc for a transfer from `a` to `b`: bent sideways (so it doesn't sit on
 * the river lines) by the smallest amount that keeps it off `obstacles` and
 * inside `bounds`. The side away from the labels (left, then up) is tried
 * first. If nothing is clear, the arc with the fewest collisions wins.
 */
export function transferArc(a: Point, b: Point, obstacles: readonly Box[], bounds?: Box): Arc {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = Math.hypot(dx, dy) || 1;
	let n = { x: -dy / len, y: dx / len };
	// Labels extend to the right of each node: bend left first (then up).
	if (n.x > 1e-9 || (Math.abs(n.x) <= 1e-9 && n.y > 0)) n = { x: -n.x, y: -n.y };
	const base = Math.min(40, 16 + len * 0.12);
	let best: { arc: Arc; hits: number } | null = null;
	for (let step = 0; step <= 16; step++) {
		for (const side of [1, -1]) {
			const arc = bent(a, b, n, (base + step * 8) * side);
			const hits = arcHits(arc, obstacles, bounds);
			if (hits === 0) return arc;
			if (!best || hits < best.hits) best = { arc, hits };
		}
	}
	return best!.arc;
}

/** SVG path data for an arc. */
export const arcPath = (a: Arc) =>
	`M${a.from.x},${a.from.y} C${a.c1.x},${a.c1.y} ${a.c2.x},${a.c2.y} ${a.to.x},${a.to.y}`;

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
