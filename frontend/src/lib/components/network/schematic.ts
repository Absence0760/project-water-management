// Layout of the network schematic: the drains-into tree drawn with the
// outflow gauge at the bottom and headwaters at the top, in grid units
// (col, row) that the SVG scales to pixels.
import type { NetworkNode } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';
import { fmtVolume, hasDam } from './fields';

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

/** How wide (px) a node's two lines are drawn: the 12.5 px semibold name and the 11 px figure under it. */
export interface TextWidths {
	label(text: string): number;
	meta(text: string): number;
}

/**
 * Widths from average glyph widths, sized for the fonts the drawing was first
 * laid out in. A wider system font draws wider than this (DejaVu Sans, the
 * usual one on Linux, by ~15 %), so the drawing measures its text where it can
 * (measuredWidths) and uses this only as the floor, and where nothing measures.
 */
export const estimatedWidths: TextWidths = {
	label: (text) => text.length * LABEL_CHAR_W,
	meta: (text) => text.length * META_CHAR_W
};

/**
 * The text as drawn, never narrower than the estimate: `measure(text, font)`
 * is the rendered width in the drawing's own font (a canvas's measureText).
 * The estimate stays the floor, so the spacing the drawing was designed with
 * holds where the font is narrower, and only a wider font widens it.
 */
export function measuredWidths(measure: (text: string, font: 'label' | 'meta') => number): TextWidths {
	return {
		label: (text) => Math.max(estimatedWidths.label(text), Math.ceil(measure(text, 'label'))),
		meta: (text) => Math.max(estimatedWidths.meta(text), Math.ceil(measure(text, 'meta')))
	};
}

/** The two text lines drawn right of a node at `p` (label at y−2, meta at y+12). */
export function labelBox(p: Point, label: string, meta: string, widths: TextWidths = estimatedWidths): Box {
	const w = Math.max(widths.label(label), widths.meta(meta));
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

// --- routed transfers (when no arc is clear) --------------------------------
// On a big network, or on paper where the columns are packed, every arc
// between two far-apart dams crosses somebody's name: the Sandspruit example
// drew one through "Vaalbank", and a 22-node catchment's report through six
// names. A label with a line through it is the least readable thing on the
// drawing, so when the arc search finds nothing clear the transfer is routed
// instead: a shortest path on a grid of ROUTE_CELL px around every label and
// symbol, along the open lanes between rows and beside the nodes, with its
// corners rounded. Rivers may be crossed but not followed (a dashed line on a
// river reads as neither).

/** A straight piece of a river, in pixels. */
export interface Segment {
	a: Point;
	b: Point;
}

export const ROUTE_CELL = 4;
/** Extra cost of a grid step on a river line (crossing one costs a few steps; running along it, many). */
const RIVER_COST = 6;
/** Extra cost of a turn, so the route keeps to few, long straights. */
const TURN_COST = 10;

/** Is point p within `r` of segment s? */
function nearSegment(p: Point, s: Segment, r: number): boolean {
	const dx = s.b.x - s.a.x;
	const dy = s.b.y - s.a.y;
	const len2 = dx * dx + dy * dy || 1;
	const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / len2));
	return Math.hypot(p.x - (s.a.x + t * dx), p.y - (s.a.y + t * dy)) <= r;
}

/**
 * The shortest grid path from `a` to `b` that keeps `clearance` px off every
 * box in `obstacles` and inside `bounds`, as a polyline of its corners (the
 * first point `a`, the last `b`). `soft` lines may be crossed at a cost.
 * Null when `b` can't be reached. The two end points may sit inside an
 * obstacle (their own symbols are not in the list, but a symbol's box may
 * touch a neighbour's label); the path leaves and enters them by the
 * nearest free cell.
 */
export function routeAround(a: Point, b: Point, obstacles: readonly Box[], bounds: Box, soft: readonly Segment[] = [], clearance = 3): Point[] | null {
	const C = ROUTE_CELL;
	const cols = Math.max(1, Math.floor((bounds.x1 - bounds.x0) / C));
	const rows = Math.max(1, Math.floor((bounds.y1 - bounds.y0) / C));
	const at = (i: number) => ({ x: bounds.x0 + ((i % cols) + 0.5) * C, y: bounds.y0 + (Math.floor(i / cols) + 0.5) * C });
	const cellOf = (p: Point) => {
		const c = Math.min(cols - 1, Math.max(0, Math.floor((p.x - bounds.x0) / C)));
		const r = Math.min(rows - 1, Math.max(0, Math.floor((p.y - bounds.y0) / C)));
		return r * cols + c;
	};
	const blocked = new Uint8Array(cols * rows);
	for (const o of obstacles) {
		const c0 = Math.max(0, Math.floor((o.x0 - clearance - bounds.x0) / C));
		const c1 = Math.min(cols - 1, Math.floor((o.x1 + clearance - bounds.x0) / C));
		const r0 = Math.max(0, Math.floor((o.y0 - clearance - bounds.y0) / C));
		const r1 = Math.min(rows - 1, Math.floor((o.y1 + clearance - bounds.y0) / C));
		for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) blocked[r * cols + c] = 1;
	}
	const extra = new Uint8Array(cols * rows);
	for (const s of soft) {
		const c0 = Math.max(0, Math.floor((Math.min(s.a.x, s.b.x) - C - bounds.x0) / C));
		const c1 = Math.min(cols - 1, Math.floor((Math.max(s.a.x, s.b.x) + C - bounds.x0) / C));
		const r0 = Math.max(0, Math.floor((Math.min(s.a.y, s.b.y) - C - bounds.y0) / C));
		const r1 = Math.min(rows - 1, Math.floor((Math.max(s.a.y, s.b.y) + C - bounds.y0) / C));
		for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (nearSegment(at(r * cols + c), s, C)) extra[r * cols + c] = RIVER_COST;
	}
	const start = cellOf(a);
	const goal = cellOf(b);
	// The ends' own cells (and a short way out of them) are always open.
	const free = (i: number) => !blocked[i] || i === start || i === goal || Math.hypot(at(i).x - a.x, at(i).y - a.y) < 14 || Math.hypot(at(i).x - b.x, at(i).y - b.y) < 14;

	// A* over (cell, heading) so a turn can cost extra. Headings: 0 right, 1 down, 2 left, 3 up.
	const DX = [1, 0, -1, 0];
	const DY = [0, 1, 0, -1];
	const n = cols * rows * 4;
	const g = new Float64Array(n).fill(Infinity);
	const from = new Int32Array(n).fill(-1);
	const gx = goal % cols;
	const gy = Math.floor(goal / cols);
	const h = (i: number) => Math.abs((i % cols) - gx) + Math.abs(Math.floor(i / cols) - gy);
	// A binary heap of [f, state].
	const heap: number[][] = [];
	const push = (f: number, s: number) => {
		heap.push([f, s]);
		let k = heap.length - 1;
		while (k > 0) {
			const p = (k - 1) >> 1;
			if (heap[p]![0]! <= heap[k]![0]!) break;
			[heap[p], heap[k]] = [heap[k]!, heap[p]!];
			k = p;
		}
	};
	const pop = () => {
		const top = heap[0]!;
		const last = heap.pop()!;
		if (heap.length) {
			heap[0] = last;
			let k = 0;
			for (;;) {
				const l = 2 * k + 1;
				const r = l + 1;
				let m = k;
				if (l < heap.length && heap[l]![0]! < heap[m]![0]!) m = l;
				if (r < heap.length && heap[r]![0]! < heap[m]![0]!) m = r;
				if (m === k) break;
				[heap[m], heap[k]] = [heap[k]!, heap[m]!];
				k = m;
			}
		}
		return top;
	};
	for (let d = 0; d < 4; d++) {
		g[start * 4 + d] = 0;
		push(h(start), start * 4 + d);
	}
	let end = -1;
	while (heap.length) {
		const [f, s] = pop() as [number, number];
		const cell = s >> 2;
		const dir = s & 3;
		if (f - h(cell) > g[s]!) continue;
		if (cell === goal) {
			end = s;
			break;
		}
		const cx = cell % cols;
		const cy = Math.floor(cell / cols);
		for (let d = 0; d < 4; d++) {
			if (d === (dir + 2) % 4) continue;
			const nx = cx + DX[d]!;
			const ny = cy + DY[d]!;
			if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
			const nc = ny * cols + nx;
			if (!free(nc)) continue;
			const ns = nc * 4 + d;
			const cost = g[s]! + 1 + extra[nc]! + (d === dir || cell === start ? 0 : TURN_COST);
			if (cost < g[ns]!) {
				g[ns] = cost;
				from[ns] = s;
				push(cost + h(nc), ns);
			}
		}
	}
	if (end < 0) return null;
	const cells: number[] = [];
	for (let s = end; s >= 0; s = from[s]!) cells.push(s >> 2);
	cells.reverse();
	// Keep the corners only.
	const pts: Point[] = [a];
	for (let i = 1; i < cells.length - 1; i++) {
		const p = cells[i - 1]!;
		const c = cells[i]!;
		const q = cells[i + 1]!;
		if (c - p !== q - c) pts.push(at(c));
	}
	pts.push(b);
	// The ends are the node centres, not cell centres: square the first and last legs to them.
	return squareEnds(pts);
}

/** Moves the corners next to each end onto that end's row or column, so the first and last legs stay straight. */
function squareEnds(pts: Point[]): Point[] {
	if (pts.length < 3) return pts;
	const out = pts.map((p) => ({ ...p }));
	const fix = (end: Point, next: Point, after: Point) => {
		// The leg end→next is horizontal if next→after is vertical, and vice versa.
		if (Math.abs(after.x - next.x) < 0.5) next.y = end.y;
		else next.x = end.x;
	};
	fix(out[0]!, out[1]!, out[2]!);
	const k = out.length - 1;
	fix(out[k]!, out[k - 1]!, out[k - 2]!);
	return out;
}

/**
 * SVG path data for a routed transfer: its polyline with the corners rounded
 * (radius at most `radius`, less on a short leg), stopped `stopShort` px
 * before the last point so the arrowhead shows.
 */
export function routePath(pts: readonly Point[], radius = 8, stopShort = STOP_SHORT): string {
	if (pts.length < 2) return '';
	const p = pts.map((q) => ({ ...q }));
	const last = p[p.length - 1]!;
	const prev = p[p.length - 2]!;
	const d = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
	const cut = Math.min(stopShort, d - 1);
	p[p.length - 1] = { x: last.x - ((last.x - prev.x) / d) * cut, y: last.y - ((last.y - prev.y) / d) * cut };
	let out = `M${p[0]!.x},${p[0]!.y}`;
	for (let i = 1; i < p.length - 1; i++) {
		const a = p[i - 1]!;
		const c = p[i]!;
		const b = p[i + 1]!;
		const la = Math.hypot(c.x - a.x, c.y - a.y) || 1;
		const lb = Math.hypot(b.x - c.x, b.y - c.y) || 1;
		const r = Math.min(radius, la / 2, lb / 2);
		const p1 = { x: c.x - ((c.x - a.x) / la) * r, y: c.y - ((c.y - a.y) / la) * r };
		const p2 = { x: c.x + ((b.x - c.x) / lb) * r, y: c.y + ((b.y - c.y) / lb) * r };
		out += ` L${p1.x},${p1.y} Q${c.x},${c.y} ${p2.x},${p2.y}`;
	}
	const z = p[p.length - 1]!;
	return `${out} L${z.x},${z.y}`;
}

/** How many points, sampled every ~2 px along a polyline, fall inside a box (grown by the clearance) or outside `bounds`. */
export function polylineHits(pts: readonly Point[], boxes: readonly Box[], bounds?: Box): number {
	let hits = 0;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1]!;
		const b = pts[i]!;
		const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
		for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
			const p = { x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps };
			if (bounds && (p.x < bounds.x0 || p.x > bounds.x1 || p.y < bounds.y0 || p.y > bounds.y1)) hits++;
			else if (boxes.some((q) => p.x > q.x0 && p.x < q.x1 && p.y > q.y0 && p.y < q.y1)) hits++;
		}
	}
	return hits;
}

/**
 * A transfer's path data: the smallest clear arc (transferArc), else a route
 * around every label and symbol (routeAround), else the least-crossing arc.
 */
export function transferPathData(a: Point, b: Point, obstacles: readonly Box[], bounds: Box, rivers: readonly Segment[] = []): { d: string; routed: boolean } {
	const arc = transferArc(a, b, obstacles, bounds);
	if (arcHits(arc, obstacles, bounds) === 0) return { d: arcPath(arc), routed: false };
	const route = routeAround(a, b, obstacles, bounds, rivers);
	return route ? { d: routePath(route), routed: true } : { d: arcPath(arc), routed: false };
}

// --- labels ------------------------------------------------------------------

/**
 * Each name cut to at most `max` characters, so that no two different names
 * read the same. A long name loses its end ("Kliprivier Estat…"), unless that
 * makes it read like another's ("North Sandvlakte 2" and "North Sandvlakte 7"
 * both "North Sandvlakte…"): then those keep their endings instead and lose
 * the middle ("North Sandv… 2", "North Sandv… 7"), as few characters of the
 * ending as tell them apart.
 */
export function distinctShortNames(names: readonly string[], max = 17): string[] {
	const end = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
	const out = names.map(end);
	const groups = new Map<string, number[]>();
	out.forEach((s, i) => groups.set(s, [...(groups.get(s) ?? []), i]));
	// Keep `ending` of a name: its head cut to fit, then "…", then the ending.
	const keep = (s: string, ending: string) => (s.length <= max ? s : `${s.slice(0, max - 1 - ending.length).trimEnd()}…${ending}`);
	const longest = max - 5; // leave at least four characters of the head
	for (const [, idx] of groups) {
		const full = new Set(idx.map((i) => names[i]!));
		if (full.size < 2) continue; // the same name twice stays the same
		// Whole words first ("… 12", "… Block B1"), the fewest that tell them apart; else characters.
		const byWords = (k: number) => (s: string) => ` ${s.split(' ').slice(-k).join(' ')}`;
		const byChars = (k: number) => (s: string) => s.slice(-k);
		const tries = [...[1, 2, 3].map(byWords), ...Array.from({ length: longest }, (_, k) => byChars(k + 1))];
		for (const pick of tries) {
			const endings = idx.map((i) => pick(names[i]!));
			if (endings.some((e) => e.length > longest)) continue;
			const cut = idx.map((i, k) => keep(names[i]!, endings[k]!));
			if (new Set(cut).size === full.size) {
				idx.forEach((i, k) => (out[i] = cut[k]!));
				break;
			}
		}
	}
	return out;
}

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

/**
 * A node's second label line. Plain: "outflow · " at the outlet, its area
 * with everything upstream, and its dam's capacity. Coloured (`colour`, the
 * drawing's colour by supply or dam level): the figure it is coloured by
 * ("82% supplied", "64% full", the run's), and when the dam was edited since
 * that run (issue #444: with the colour's figure alone an edit was
 * invisible) its capacity now ("now 0.20 Mm³", "no dam now"), or "changed"
 * for an edit that left the capacity alone. The area and the capacity of an
 * unchanged dam stay in the tooltip when coloured: with them as well, the line
 * ran into the next column's label.
 */
export function metaLine(ln: Pick<SchematicNode, 'node' | 'cumulativeAreaKm2'>, colour?: { text: string }, changed: { capacity: boolean } | null = null): string {
	const n = ln.node;
	const dam = hasDam(n) ? fmtVolume(n.damCapacityM3) : '';
	if (colour) return [colour.text, changed ? (changed.capacity ? (dam ? `now ${dam}` : 'no dam now') : 'changed') : ''].filter(Boolean).join(' · ');
	return `${n.downstreamNodeId === null ? 'outflow · ' : ''}${fmtNum(ln.cumulativeAreaKm2, 1)} km²${dam ? ` · ${dam}` : ''}`;
}
