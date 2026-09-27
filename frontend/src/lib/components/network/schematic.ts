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
	/**
	 * The paper layout only (wrappedSchematicLayout): the column of the gutter
	 * this edge runs down, for a branch wrapped onto a higher row than the
	 * others draining into the same node.
	 */
	via?: number;
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

/** What drains into each node (in drawing order), and the nodes that drain into nothing drawn. */
function drainage(nodes: NetworkNode[]) {
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
	return { children, roots };
}

export function schematicLayout(nodes: NetworkNode[]): SchematicLayout {
	const { children, roots } = drainage(nodes);

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

// --- the paper layout ------------------------------------------------------
// The report prints the schematic on A4. The layout above lays every
// headwater side by side, so a catchment of 30 units drawn to the page's
// width printed its names at about 1.5 pt. On paper the drawing is at most
// `maxCols` columns wide instead: where the branches draining into one node
// don't fit side by side they wrap onto several rows, stacked upwards, the
// shortest branches on the row nearest the node. A wrapped row's rivers run
// down a gutter left of the rows below it and join the node's own confluence
// line, so no river crosses a symbol or a name.

/** Columns a wrapped group keeps on its left for the gutter its higher rows drain down. */
export const WRAP_GUTTER = 0.4;

interface Branch {
	node: NetworkNode;
	depth: number;
	area: number;
	/** Width in columns and height in rows of the branch's box. */
	w: number;
	h: number;
	shelves: Branch[][];
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const shelfW = (s: Branch[]) => sum(s.map((b) => b.w));
const shelfH = (s: Branch[]) => Math.max(...s.map((b) => b.h));

/**
 * Branches in rows of at most `cap` columns. Kept in order on one row when
 * they fit in `maxCols`; otherwise the shortest go on the first row, so the
 * rivers wrapped above have the fewest rows to run past (separate outlets,
 * with no river between them, keep their order: `byHeight` false).
 */
function shelve(items: Branch[], maxCols: number, cap: number, byHeight = true): Branch[][] {
	if (items.length === 0) return [];
	if (shelfW(items) <= maxCols) return [items];
	const ordered = byHeight ? items.map((b, i) => ({ b, i })).sort((x, y) => x.b.h - y.b.h || x.i - y.i).map((x) => x.b) : items;
	const shelves: Branch[][] = [];
	let cur: Branch[] = [];
	for (const b of ordered) {
		if (cur.length && shelfW(cur) + b.w > cap) {
			shelves.push(cur);
			cur = [];
		}
		cur.push(b);
	}
	shelves.push(cur);
	return shelves;
}

/**
 * The schematic for paper: as schematicLayout, but never wider than
 * `maxCols` columns (a branch that is itself wider than that aside, which
 * only a single node with a wider branch could make, and wrapping makes none).
 * Edges from a wrapped row carry `via`, the column of the gutter they run
 * down. Rows and columns are in the same grid units as schematicLayout's.
 */
export function wrappedSchematicLayout(nodes: NetworkNode[], maxCols: number): SchematicLayout {
	const { children, roots } = drainage(nodes);
	const cap = Math.max(1, maxCols - WRAP_GUTTER);
	const seen = new Set<string>();

	const measure = (n: NetworkNode, depth: number): Branch => {
		seen.add(n.id);
		const kids = (children.get(n.id) ?? []).filter((c) => !seen.has(c.id)).map((c) => measure(c, depth + 1));
		const shelves = shelve(kids, maxCols, cap);
		const gutter = shelves.length > 1 ? WRAP_GUTTER : 0;
		// Every row but the top one sits right of the gutter; the top row's rivers
		// reach the gutter along the line below them, so it may start at the left edge.
		const w = Math.max(1, ...shelves.map((s, i) => (i < shelves.length - 1 ? gutter : 0) + shelfW(s)));
		return { node: n, depth, area: (n.areaKm2 || 0) + sum(kids.map((k) => k.area)), w, h: 1 + sum(shelves.map(shelfH)), shelves };
	};
	const top = roots.map((r) => measure(r, 0));
	const rootShelves = shelve(top, maxCols, maxCols, false);

	const placed: { b: Branch; col: number; up: number }[] = [];
	const edges: SchematicEdge[] = [];
	// `up`: rows above the drawing's bottom row. Returns the branch's own column.
	const place = (b: Branch, left: number, up: number): number => {
		const gutter = b.shelves.length > 1 ? WRAP_GUTTER : 0;
		let y = up + 1;
		let first = left;
		let last = left;
		b.shelves.forEach((s, i) => {
			let x = left + (i < b.shelves.length - 1 ? gutter : 0);
			s.forEach((k, j) => {
				const c = place(k, x, y);
				edges.push(i === 0 ? { from: k.node.id, to: b.node.id } : { from: k.node.id, to: b.node.id, via: left + gutter / 2 });
				if (i === 0 && j === 0) first = c;
				if (i === 0) last = c;
				x += k.w;
			});
			y += shelfH(s);
		});
		const col = b.shelves.length ? (first + last) / 2 : left;
		placed.push({ b, col, up });
		return col;
	};
	let up = 0;
	for (const s of rootShelves) {
		let x = 0;
		for (const b of s) {
			place(b, x, up);
			x += b.w;
		}
		up += shelfH(s);
	}

	const rows = up;
	const at = new Map(placed.map((p) => [p.b.node.id, p]));
	const out: SchematicNode[] = [];
	for (const n of nodes) {
		const p = at.get(n.id);
		if (p) out.push({ node: n, col: p.col, row: rows - 1 - p.up, depth: p.b.depth, cumulativeAreaKm2: p.b.area });
	}
	return {
		nodes: out,
		edges,
		cols: Math.max(1, ...rootShelves.map(shelfW)),
		rows,
		orphans: nodes.filter((n) => !seen.has(n.id))
	};
}

// --- paper: page-high bands --------------------------------------------------
// The paper layout bounds the width, not the height: a main stem of a dozen
// gauges, or many wrapped rows, is taller than an A4 page, and Chromium carried
// the one drawing over the page break wherever it fell, through a row of names
// if that's where it was. So a drawing taller than its page is split into
// bands, each at most a page high and cut just below a row's names, drawn as
// SVGs of their own that print whole (`break-inside: avoid`). A river that
// crosses a cut runs off the bottom of one band and on from the top of the next.

/**
 * How far below a row's centre a band ends: under its names (which end
 * ~16 px down), above the next row's confluence line (half a row, 37 px).
 */
export const BAND_CUT = 26;

/** The drawing's vertical metrics in pixels, as NetworkSchematic places rows (row r's centre at `padY + r * rowH`). */
export interface BandGeometry {
	rows: number;
	rowH: number;
	padY: number;
	/** The whole drawing's height. */
	height: number;
}

/** Rows `first`–`last` (inclusive), drawn from `y0` to `y1` of the whole drawing. */
export interface Band {
	first: number;
	last: number;
	y0: number;
	y1: number;
}

/**
 * The drawing in bands of at most `rest` pixels high (the first at most
 * `first`, since it shares its page with the section's heading), each cut
 * `BAND_CUT` below its last row. One band, the whole drawing, when it fits
 * `first`. A band always takes at least one row, so a budget smaller than a
 * row still ends (with bands taller than the budget).
 */
export function paperBands(g: BandGeometry, budget: { first: number; rest: number }): Band[] {
	if (g.rows <= 0) return [];
	if (g.height <= budget.first) return [{ first: 0, last: g.rows - 1, y0: 0, y1: g.height }];
	const cutBelow = (r: number) => g.padY + r * g.rowH + BAND_CUT;
	const bands: Band[] = [];
	let first = 0;
	let y0 = 0;
	for (;;) {
		const room = bands.length === 0 ? budget.first : budget.rest;
		if (first === g.rows - 1 || g.height - y0 <= room) {
			bands.push({ first, last: g.rows - 1, y0, y1: g.height });
			return bands;
		}
		// The last row always goes in the last band, which also holds the drawing's foot.
		let last = first;
		while (last + 1 < g.rows - 1 && cutBelow(last + 1) - y0 <= room) last++;
		bands.push({ first, last, y0, y1: cutBelow(last) });
		y0 = cutBelow(last);
		first = last + 1;
	}
}

/**
 * The columns where rivers cross the cut under row `row` (sorted, each once):
 * a river leaving that row goes straight down from its node; one wrapped from
 * higher up is in its gutter (`via`) by then.
 */
export function bandCrossings(l: SchematicLayout, row: number): number[] {
	const at = new Map(l.nodes.map((n) => [n.node.id, n]));
	const cols = new Set<number>();
	for (const e of l.edges) {
		const a = at.get(e.from);
		const b = at.get(e.to);
		if (!a || !b || a.row > row || b.row <= row) continue;
		cols.add(a.row === row || e.via === undefined ? a.col : e.via);
	}
	return [...cols].sort((x, y) => x - y);
}
