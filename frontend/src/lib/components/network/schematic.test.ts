import type { NetworkNode } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { newNode } from '$lib/model/editor.svelte';
import { schematicLayout } from './schematic';

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
