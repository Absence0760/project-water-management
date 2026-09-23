import type { NetworkNode } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { newNode } from '$lib/model/editor.svelte';
import { arcHits, arcPath, labelBox, schematicLayout, symbolBox, transferArc, type Arc, type Point } from './schematic';

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
