import type { NetworkNode } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { newNode } from '$lib/model/editor.svelte';
import { validateModel } from '$lib/model/validate';
import { canDrainInto, flowPathOrder, makeOutlet, moveTo, upstreamOf, validDropTargets } from './reorder';

let seq = 0;
const node = (id: string, down: string | null): NetworkNode => ({ ...newNode(seq++, down), id, name: id });

// Out ← A ← (A1, A2); Out ← B
const net = () => [node('Out', null), node('A', 'Out'), node('B', 'Out'), node('A1', 'A'), node('A2', 'A')];
const ids = (ns: { id: string }[]) => ns.map((n) => n.id);

describe('moveTo', () => {
	it('moves a row and renumbers sortOrder 0..n-1', () => {
		const out = moveTo(net(), 4, 1);
		expect(ids(out)).toEqual(['Out', 'A2', 'A', 'B', 'A1']);
		expect(out.map((n) => n.sortOrder)).toEqual([0, 1, 2, 3, 4]);
	});

	it('clamps the target and ignores a bad source', () => {
		expect(ids(moveTo(net(), 0, -5))).toEqual(['Out', 'A', 'B', 'A1', 'A2']);
		expect(ids(moveTo(net(), 0, 99))).toEqual(['A', 'B', 'A1', 'A2', 'Out']);
		expect(ids(moveTo(net(), 9, 0))).toEqual(['Out', 'A', 'B', 'A1', 'A2']);
	});
});

describe('flowPathOrder', () => {
	it('lists each tributary headwater → confluence, outlet last', () => {
		expect(ids(flowPathOrder(net()))).toEqual(['A1', 'A2', 'A', 'B', 'Out']);
	});

	it('is stable by the current order among siblings', () => {
		const n = net();
		const swapped = [n[0]!, n[2]!, n[1]!, n[4]!, n[3]!]; // B before A, A2 before A1
		expect(ids(flowPathOrder(swapped))).toEqual(['B', 'A2', 'A1', 'A', 'Out']);
	});

	it('keeps nodes caught in a loop at the end', () => {
		const n = [node('Out', null), node('X', 'Y'), node('Y', 'X'), node('C', 'Out')];
		expect(ids(flowPathOrder(n))).toEqual(['C', 'Out', 'X', 'Y']);
	});
});

describe('drop targets', () => {
	it('knows what is upstream', () => {
		expect([...upstreamOf(net(), 'A')].sort()).toEqual(['A1', 'A2']);
		expect(upstreamOf(net(), 'B').size).toBe(0);
	});

	it('forbids loops and self, allows anything else', () => {
		const n = net();
		expect([...validDropTargets(n, 'A')].sort()).toEqual(['B', 'Out']);
		expect([...validDropTargets(n, 'A1')].sort()).toEqual(['A', 'A2', 'B', 'Out']);
		expect(canDrainInto(n, 'A', 'A1')).toEqual({ ok: false, reason: expect.stringContaining('loop') });
		expect(canDrainInto(n, 'A', 'A').ok).toBe(false);
	});

	it('never moves the outflow gauge by dragging', () => {
		expect(validDropTargets(net(), 'Out').size).toBe(0);
		expect(canDrainInto(net(), 'Out', 'B')).toEqual({ ok: false, reason: expect.stringContaining('Make outflow gauge') });
	});

	it('every allowed drop leaves a valid network', () => {
		for (const drag of ['A', 'B', 'A1', 'A2']) {
			for (const target of validDropTargets(net(), drag)) {
				const n = net();
				n.find((x) => x.id === drag)!.downstreamNodeId = target;
				expect(validateModel({ nodes: n, crops: [], cropAreas: [], transfers: [] })).toEqual([]);
			}
		}
	});
});

describe('makeOutlet', () => {
	it('re-roots the network without loops or a second outlet', () => {
		const n = [...net(), node('NewOut', null)];
		n[5]!.downstreamNodeId = null;
		// NewOut is a second outlet: make it the outlet; Out now drains into it.
		makeOutlet(n, 'NewOut');
		expect(n.find((x) => x.id === 'Out')!.downstreamNodeId).toBe('NewOut');
		expect(validateModel({ nodes: n, crops: [], cropAreas: [], transfers: [] })).toEqual([]);
	});

	it('works for a node that was upstream of the old outlet', () => {
		const n = net();
		makeOutlet(n, 'A1');
		expect(n.find((x) => x.id === 'A1')!.downstreamNodeId).toBeNull();
		expect(n.find((x) => x.id === 'Out')!.downstreamNodeId).toBe('A1');
		expect(validateModel({ nodes: n, crops: [], cropAreas: [], transfers: [] })).toEqual([]);
	});
});
