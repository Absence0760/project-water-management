import type { NetworkNode } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { newNode } from '$lib/model/editor.svelte';
import {
	arcHits,
	arcPath,
	BAND_CUT,
	bandCrossings,
	distinctShortNames,
	estimatedWidths,
	labelBox,
	measuredWidths,
	paperBands,
	polylineHits,
	routeAround,
	routePath,
	schematicLayout,
	symbolBox,
	transferArc,
	transferPathData,
	WRAP_GUTTER,
	wrappedSchematicLayout,
	type Arc,
	type Point,
	type SchematicLayout
} from './schematic';

let seq = 0;
function node(name: string, down: string | null, areaKm2 = 1): NetworkNode {
	return { ...newNode(++seq, down), id: name, name, areaKm2 };
}

describe('schematicLayout', () => {
	it('puts the outlet on the bottom row, centred under its branches', () => {
		const nodes = [node('Out', null, 0), node('A', 'Out'), node('B', 'Out'), node('A1', 'A'), node('A2', 'A')];
		const l = schematicLayout(nodes);
		const at = (id: string) => l.nodes.find((n) => n.node.id === id)!;
		expect(l.rows).toBe(3);
		expect(l.cols).toBe(3); // leaves: A1, A2, B
		expect(at('Out').row).toBe(2);
		expect(at('A1')).toMatchObject({ col: 0, row: 0, depth: 2 });
		expect(at('A2')).toMatchObject({ col: 1, row: 0 });
		expect(at('A')).toMatchObject({ col: 0.5, row: 1 });
		expect(at('B')).toMatchObject({ col: 2, row: 1 });
		expect(at('Out').col).toBe(1.25); // midway between A (0.5) and B (2)
		expect(l.edges).toContainEqual({ from: 'A1', to: 'A' });
		expect(l.edges).toContainEqual({ from: 'B', to: 'Out' });
		expect(l.edges).toHaveLength(4);
	});

	it('draws a single chain as a vertical stem', () => {
		const l = schematicLayout([node('Out', null), node('Mid', 'Out'), node('Top', 'Mid')]);
		expect(l.nodes.map((n) => n.col)).toEqual([0, 0, 0]);
		expect(l.nodes.map((n) => n.row)).toEqual([2, 1, 0]);
	});

	it('accumulates upstream catchment area', () => {
		const l = schematicLayout([node('Out', null, 0), node('A', 'Out', 3), node('A1', 'A', 2), node('B', 'Out', 5)]);
		expect(l.nodes.find((n) => n.node.id === 'Out')!.cumulativeAreaKm2).toBe(10);
		expect(l.nodes.find((n) => n.node.id === 'A')!.cumulativeAreaKm2).toBe(5);
	});

	it('orders branches by sortOrder', () => {
		const late = { ...node('Late', 'Out'), sortOrder: 99 };
		const early = { ...node('Early', 'Out'), sortOrder: 1 };
		const l = schematicLayout([node('Out', null), late, early]);
		expect(l.nodes.find((n) => n.node.id === 'Early')!.col).toBe(0);
		expect(l.nodes.find((n) => n.node.id === 'Late')!.col).toBe(1);
	});

	it('reports nodes caught in a loop instead of placing them', () => {
		const l = schematicLayout([node('Out', null), node('X', 'Y'), node('Y', 'X')]);
		expect(l.nodes.map((n) => n.node.id)).toEqual(['Out']);
		expect(l.orphans.map((n) => n.id)).toEqual(['X', 'Y']);
	});

	it('lays several outlets side by side and handles an empty network', () => {
		const l = schematicLayout([node('O1', null), node('O2', null)]);
		expect(l.nodes.map((n) => n.col)).toEqual([0, 1]);
		expect(schematicLayout([])).toEqual({ nodes: [], edges: [], cols: 1, rows: 0, orphans: [] });
	});
});

describe('wrappedSchematicLayout (the printed report)', () => {
	const at = (l: SchematicLayout, id: string) => l.nodes.find((n) => n.node.id === id)!;
	/** Columns the drawn nodes span. */
	const span = (l: SchematicLayout) => Math.max(...l.nodes.map((n) => n.col)) + 1;
	const fan = (n: number, into = 'Out') => Array.from({ length: n }, (_, i) => node(`U${i + 1}`, into));

	/**
	 * Nothing overlaps, and every wrapped river's gutter (`via`) is clear: no
	 * node on the rows it runs down sits on it or has its label (~0.9 column)
	 * running across it.
	 */
	function expectClean(l: SchematicLayout) {
		const byRow = new Map<number, number[]>();
		for (const n of l.nodes) byRow.set(n.row, [...(byRow.get(n.row) ?? []), n.col]);
		for (const cols of byRow.values()) {
			cols.sort((a, b) => a - b);
			for (let i = 1; i < cols.length; i++) expect(cols[i]! - cols[i - 1]!).toBeGreaterThanOrEqual(1 - 1e-9);
		}
		for (const e of l.edges) {
			if (e.via === undefined) continue;
			const from = at(l, e.from);
			const to = at(l, e.to);
			expect(e.via).toBeLessThan(to.col);
			for (const n of l.nodes) {
				if (n.row <= from.row || n.row >= to.row) continue;
				expect(n.col < e.via - 0.9 || n.col > e.via + 0.15, `${n.node.id} on the gutter at ${e.via}`).toBe(true);
			}
		}
	}

	it('is the usual layout when the network fits the width', () => {
		const nodes = [node('Out', null, 0), node('A', 'Out'), node('B', 'Out'), node('A1', 'A'), node('A2', 'A')];
		expect(wrappedSchematicLayout(nodes, 5)).toEqual(schematicLayout(nodes));
	});

	it('wraps 30 units draining into one gauge onto rows of 4, within 5 columns', () => {
		const l = wrappedSchematicLayout([node('Out', null, 0), ...fan(30)], 5);
		expect(l.nodes).toHaveLength(31);
		expect(span(l)).toBeLessThanOrEqual(5);
		expect(l.cols).toBeLessThanOrEqual(5);
		expect(l.rows).toBe(1 + 8); // 30 / 4, rounded up, plus the gauge's own row
		expect(at(l, 'Out').row).toBe(8);
		// The first row joins as usual; the higher rows run down the gutter.
		expect(at(l, 'U1')).toMatchObject({ row: 7, col: WRAP_GUTTER });
		expect(l.edges.find((e) => e.from === 'U1')).toEqual({ from: 'U1', to: 'Out' });
		expect(l.edges.find((e) => e.from === 'U30')).toEqual({ from: 'U30', to: 'Out', via: WRAP_GUTTER / 2 });
		expect(at(l, 'U1').cumulativeAreaKm2).toBe(1);
		expect(at(l, 'Out').cumulativeAreaKm2).toBe(30);
		expectClean(l);
	});

	it('keeps a long main stem with side units narrow however long it is', () => {
		// 12 gauges in a chain, each with two units beside it: 25 headwaters side by side unwrapped.
		const nodes = [node('G0', null, 0)];
		for (let i = 1; i < 12; i++) nodes.push(node(`G${i}`, `G${i - 1}`));
		for (let i = 0; i < 12; i++) nodes.push(node(`F${i}a`, `G${i}`), node(`F${i}b`, `G${i}`));
		expect(schematicLayout(nodes).cols).toBeGreaterThan(20);
		const l = wrappedSchematicLayout(nodes, 5);
		expect(span(l)).toBeLessThanOrEqual(5);
		expect(l.nodes).toHaveLength(nodes.length);
		expectClean(l);
	});

	it('wraps at every level of a branching network, and stacks several outlets', () => {
		const nodes = [node('Out', null, 0), node('Other', null, 0)];
		for (let t = 0; t < 4; t++) {
			nodes.push(node(`T${t}`, 'Out'));
			for (let i = 0; i < 7; i++) nodes.push(node(`T${t}u${i}`, `T${t}`));
		}
		nodes.push(...fan(6, 'Other'));
		const l = wrappedSchematicLayout(nodes, 5);
		expect(span(l)).toBeLessThanOrEqual(5);
		expect(l.nodes).toHaveLength(nodes.length);
		expect(l.edges).toHaveLength(nodes.length - 2);
		expect(at(l, 'Out').row).toBe(l.rows - 1);
		expect(at(l, 'Other').row).toBeLessThan(at(l, 'Out').row);
		expectClean(l);
	});

	it('reports nodes caught in a loop, as the usual layout does', () => {
		const l = wrappedSchematicLayout([node('Out', null), node('X', 'Y'), node('Y', 'X')], 5);
		expect(l.orphans.map((n) => n.id)).toEqual(['X', 'Y']);
	});
});

describe('paperBands and bandCrossings (a printed schematic taller than a page)', () => {
	// NetworkSchematic's metrics: 74 px rows, 22 px padding, 30 px for the last row's names.
	const ROW_H = 74;
	const PAD_Y = 22;
	const geometry = (rows: number) => ({ rows, rowH: ROW_H, padY: PAD_Y, height: PAD_Y * 2 + (rows - 1) * ROW_H + 30 });
	const rowY = (r: number) => PAD_Y + r * ROW_H;

	/** A main stem of `n` gauges, each with a unit beside it. */
	function stem(n: number): NetworkNode[] {
		const nodes = [node('G0', null, 0)];
		for (let i = 1; i < n; i++) nodes.push(node(`G${i}`, `G${i - 1}`));
		for (let i = 0; i < n; i++) nodes.push(node(`F${i}`, `G${i}`));
		return nodes;
	}

	it('is one band, the whole drawing, when it fits the first page', () => {
		const g = geometry(9);
		expect(paperBands(g, { first: g.height, rest: g.height })).toEqual([{ first: 0, last: 8, y0: 0, y1: g.height }]);
		expect(paperBands(geometry(0), { first: 100, rest: 100 })).toEqual([]);
	});

	it('cuts a deep drawing at row boundaries, every band within its page and every row in exactly one band', () => {
		const g = geometry(26);
		const budget = { first: 900, rest: 1000 };
		const bands = paperBands(g, budget);
		expect(bands.length).toBeGreaterThan(1);
		// Contiguous from the top to the foot, rows in order, none twice or missing.
		expect(bands[0]).toMatchObject({ first: 0, y0: 0 });
		expect(bands.at(-1)).toMatchObject({ last: 25, y1: g.height });
		for (let i = 1; i < bands.length; i++) {
			expect(bands[i]!.first).toBe(bands[i - 1]!.last + 1);
			expect(bands[i]!.y0).toBe(bands[i - 1]!.y1);
		}
		bands.forEach((b, i) => {
			expect(b.y1 - b.y0).toBeLessThanOrEqual(i === 0 ? budget.first : budget.rest);
			expect(b.last).toBeGreaterThanOrEqual(b.first);
		});
		// Each cut sits under its last row's names (which end 16 px below the
		// row) and above the next row's confluence line (half a row above it).
		for (const b of bands.slice(0, -1)) {
			expect(b.y1).toBe(rowY(b.last) + BAND_CUT);
			expect(b.y1).toBeGreaterThan(rowY(b.last) + 16);
			expect(b.y1).toBeLessThan(rowY(b.last + 1) - ROW_H / 2);
		}
		// Greedy: a band ends only where the next row wouldn't fit.
		expect(rowY(bands[0]!.last + 1) + BAND_CUT).toBeGreaterThan(budget.first);
	});

	it("keeps the last row with the drawing's foot, and ends even when a row is taller than the budget", () => {
		const g = geometry(12);
		const bands = paperBands(g, { first: 40, rest: 40 });
		expect(bands.map((b) => [b.first, b.last])).toEqual(Array.from({ length: 12 }, (_, i) => [i, i]));
		expect(bands.at(-1)!.y1).toBe(g.height);
		// A budget that fits every row but not the foot never leaves an empty last band.
		const room = rowY(11) + BAND_CUT;
		const tight = paperBands(g, { first: room, rest: room });
		expect(tight.map((b) => [b.first, b.last])).toEqual([
			[0, 10],
			[11, 11]
		]);
	});

	it('finds the main stem crossing a cut, straight down from the row above', () => {
		const l = schematicLayout(stem(25));
		const at = (id: string) => l.nodes.find((n) => n.node.id === id)!;
		const r = at('G5').row;
		expect(at('G4').row).toBe(r + 1);
		// F4 joins G4 from G5's row too: both rivers cross the cut under that row.
		expect(bandCrossings(l, r)).toEqual([at('G5').col, at('F4').col].sort((a, b) => a - b));
		expect(bandCrossings(l, at('G0').row)).toEqual([]);
	});

	it('puts a river wrapped from a higher row in its gutter where it crosses a cut', () => {
		const l = wrappedSchematicLayout([node('Out', null, 0), ...Array.from({ length: 30 }, (_, i) => node(`U${i + 1}`, 'Out'))], 5);
		const at = (id: string) => l.nodes.find((n) => n.node.id === id)!;
		const top = at('U30').row;
		// Under the top row: its own rivers leave from their nodes.
		const first = bandCrossings(l, top);
		for (const n of l.nodes.filter((x) => x.row === top)) expect(first).toContain(n.col);
		// Lower down, the rivers of every row above run down the one gutter, beside that row's own.
		const r = at('U1').row - 1;
		const lower = bandCrossings(l, r);
		expect(lower).toContain(WRAP_GUTTER / 2);
		for (const n of l.nodes.filter((x) => x.row === r)) expect(lower).toContain(n.col);
		expect(lower).toHaveLength(1 + l.nodes.filter((x) => x.row === r).length);
		expect([...lower].sort((a, b) => a - b)).toEqual(lower);
	});
});

describe('labelBox', () => {
	const p = { x: 100, y: 50 };

	it('reserves the wider of the two lines, right of the symbol', () => {
		expect(labelBox(p, 'Hilltop farm', '12.0 km²')).toEqual({ x0: 115, y0: 37, x1: 117 + 12 * 7, y1: 66 });
		expect(labelBox(p, 'Dam', '12.0 km² · 0.15 Mm³').x1).toBeCloseTo(117 + 19 * 6.1, 6);
	});

	it('reserves the text as drawn when a wider font draws it wider than the estimate', () => {
		// DejaVu Sans: "Melkhout Gauge" is ~112 px at 12.5 px semibold, where the estimate says 98.
		const wide = measuredWidths((text, font) => text.length * (font === 'label' ? 8 : 7));
		expect(labelBox(p, 'Melkhout Gauge', '148.0 km²', wide).x1).toBe(117 + 14 * 8);
		expect(labelBox(p, 'Gauge', '148.0 km² · 1.25 Mm³', wide).x1).toBe(117 + 20 * 7);
	});

	it('never reserves less than the estimate, so a narrower font keeps the usual spacing', () => {
		const narrow = measuredWidths(() => 10);
		expect(labelBox(p, 'Melkhout Gauge', '148.0 km²', narrow)).toEqual(labelBox(p, 'Melkhout Gauge', '148.0 km²'));
		expect(narrow.label('Melkhout Gauge')).toBe(estimatedWidths.label('Melkhout Gauge'));
	});

	it('rounds a measured width up to the whole pixel', () => {
		expect(measuredWidths(() => 200.2).label('ab')).toBe(201);
	});
});

describe('transferArc', () => {
	// Pixel positions as NetworkSchematic places them: 150 px columns, 74 px rows.
	const at = (col: number, row: number): Point => ({ x: 36 + col * 150, y: 22 + row * 74 });
	const label = (p: Point, name = 'Hilltop farm', meta = '12.0 km² · 0.15 Mm³') => labelBox(p, name, meta);
	// The previous fixed rule: bow min(60, 22 + 0.18·length) to the chord's left-hand normal.
	function fixedBow(a: Point, b: Point): Arc {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy);
		const bow = Math.min(60, 22 + len * 0.18);
		const c = { x: (a.x + b.x) / 2 - (dy / len) * bow, y: (a.y + b.y) / 2 + (dx / len) * bow };
		// That quadratic as the equivalent cubic.
		const toward = (p: Point, k: number) => ({ x: p.x + (c.x - p.x) * k, y: p.y + (c.y - p.y) * k });
		return { from: a, c1: toward(a, 2 / 3), c2: toward(b, 2 / 3), to: b };
	}
	const bounds = { x0: 0, y0: 0, x1: 700, y1: 400 };

	it('clears the source label between siblings on one row', () => {
		const a = at(0, 1);
		const b = at(1, 1);
		const boxes = [label(a), label(b), label(at(0, 0)), label(at(1, 0)), label(at(0.5, 2))];
		expect(arcHits(fixedBow(a, b), boxes)).toBeGreaterThan(0); // the bug
		const arc = transferArc(a, b, boxes, bounds);
		expect(arcHits(arc, boxes, bounds)).toBe(0);
		expect(arc.from).toEqual(a);
	});

	it('clears the labels and symbols of the nodes in between on a stem', () => {
		const top = at(0, 0);
		const mid = at(0, 1);
		const out = at(0, 2);
		const boxes = [label(top), label(mid), label(out), symbolBox(mid)];
		const arc = transferArc(top, out, boxes, bounds);
		expect(arcHits(arc, boxes, bounds)).toBe(0);
		// Bowed to the left, away from the labels.
		expect(arc.c1.x).toBeLessThan(top.x);
	});

	it('stays inside the drawing', () => {
		const a = at(0, 0);
		const b = at(1, 0);
		const arc = transferArc(a, b, [label(a), label(b)], bounds);
		expect(arcHits(arc, [], bounds)).toBe(0);
	});

	it('stops short of the target symbol so the arrowhead shows', () => {
		const a = at(0, 0);
		const b = at(0, 2);
		const arc = transferArc(a, b, [], bounds);
		expect(Math.hypot(arc.to.x - b.x, arc.to.y - b.y)).toBeCloseTo(14, 6);
		expect(arcPath(arc)).toMatch(/^M36,22 C[-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+ [-\d.]+,[-\d.]+$/);
	});

	it('falls back to the least-crossing arc when nothing is clear', () => {
		const a = at(0, 0);
		const b = at(1, 0);
		const wall = { x0: -1000, y0: -1000, x1: 1000, y1: 1000 };
		expect(() => transferArc(a, b, [wall])).not.toThrow();
	});
});

describe('routed transfers (no clear arc)', () => {
	const at = (col: number, row: number): Point => ({ x: 36 + col * 150, y: 22 + row * 74 });
	const label = (p: Point) => labelBox(p, 'Kliprivier Estat…', '12.0 km² · 1.26 Mm³');
	// A packed grid: four columns by six rows, every node labelled; from the top left to the bottom right.
	const grid: Point[] = [];
	for (let r = 0; r < 6; r++) for (let c = 0; c < 4; c++) grid.push(at(c, r));
	const bounds = { x0: 0, y0: 0, x1: 36 + 3 * 150 + 150, y1: 22 + 5 * 74 + 30 };
	const a = grid[0]!;
	const b = grid[grid.length - 1]!;
	// Every label, and every symbol but the transfer's own two (as NetworkSchematic passes them).
	const obstacles = [...grid.map(label), ...grid.filter((p) => p !== a && p !== b).map(symbolBox)];

	it('finds no clear arc across a packed drawing (why routing exists)', () => {
		expect(arcHits(transferArc(a, b, obstacles, bounds), obstacles, bounds)).toBeGreaterThan(0);
	});

	it('routes around every label and symbol, inside the drawing, from end to end', () => {
		const route = routeAround(a, b, obstacles, bounds)!;
		expect(route).not.toBeNull();
		expect(route[0]).toEqual(a);
		expect(route.at(-1)).toEqual(b);
		expect(polylineHits(route, obstacles, bounds)).toBe(0);
		// Straight legs only (the corners are rounded when drawn).
		for (let i = 1; i < route.length; i++) {
			const p = route[i - 1]!;
			const q = route[i]!;
			expect(Math.abs(p.x - q.x) < 0.5 || Math.abs(p.y - q.y) < 0.5).toBe(true);
		}
	});

	it('crosses a river rather than running along it', () => {
		const river = { a: { x: 60, y: 0 }, b: { x: 60, y: 200 } };
		const route = routeAround({ x: 20, y: 20 }, { x: 100, y: 180 }, [], { x0: 0, y0: 0, x1: 200, y1: 200 }, [river])!;
		// How far the route runs within 4 px of the river line.
		let along = 0;
		for (let i = 1; i < route.length; i++) {
			const p = route[i - 1]!;
			const q = route[i]!;
			if (Math.abs(p.x - 60) <= 4 && Math.abs(q.x - 60) <= 4) along += Math.abs(q.y - p.y);
		}
		expect(along).toBe(0);
	});

	it('returns null when the target is walled in', () => {
		const target = { x: 100, y: 100 };
		const walls = [
			{ x0: 60, y0: 60, x1: 140, y1: 70 },
			{ x0: 60, y0: 130, x1: 140, y1: 140 },
			{ x0: 60, y0: 60, x1: 70, y1: 140 },
			{ x0: 130, y0: 60, x1: 140, y1: 140 }
		];
		expect(routeAround({ x: 10, y: 10 }, target, walls, { x0: 0, y0: 0, x1: 200, y1: 200 })).toBeNull();
	});

	it('draws the route with rounded corners and stops short of the target', () => {
		const d = routePath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
		expect(d).toBe('M0,0 L92,0 Q100,0 100,8 L100,86');
	});

	it('keeps the arc when one is clear, and routes only when none is', () => {
		const clear = transferPathData(at(0, 0), at(1, 1), [], bounds);
		expect(clear.routed).toBe(false);
		expect(clear.d).toMatch(/ C/);
		const packed = transferPathData(a, b, obstacles, bounds);
		expect(packed.routed).toBe(true);
		expect(packed.d).not.toMatch(/ C/);
	});
});

describe('distinctShortNames', () => {
	it('leaves short names alone and cuts long ones at the end', () => {
		expect(distinctShortNames(['Vaalbank', 'Kliprivier Estate North'])).toEqual(['Vaalbank', 'Kliprivier Estat…']);
	});

	it('keeps the endings of names that would otherwise read the same', () => {
		const out = distinctShortNames(['North Sandvlakte 2', 'North Sandvlakte 7', 'North Sandvlakte 12', 'Doornbos']);
		expect(new Set(out).size).toBe(4);
		expect(out.slice(0, 3)).toEqual(['North Sandvlak… 2', 'North Sandvlak… 7', 'North Sandvla… 12']);
		for (const s of out) expect(s.length).toBeLessThanOrEqual(17);
	});

	it('keeps the fewest whole words of the ending that tell names apart', () => {
		const out = distinctShortNames(['Upper Orchards Block A1', 'Upper Orchards Block A2', 'Upper Orchards Block B1']);
		expect(new Set(out).size).toBe(3);
		expect(out[0]).toMatch(/… A1$/);
		expect(out[2]).toMatch(/… B1$/);
	});

	it('leaves two identical names identical', () => {
		expect(distinctShortNames(['Same very long unit name', 'Same very long unit name'])).toEqual(['Same very long u…', 'Same very long u…']);
	});
});
