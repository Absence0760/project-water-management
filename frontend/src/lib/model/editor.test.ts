import { describe, expect, it } from 'vitest';
import { ModelEditor } from './editor.svelte';

describe('ModelEditor', () => {
	it('tracks dirty state against the loaded snapshot and reverts', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [], cropAreas: [], transfers: [] });
		expect(ed.dirty).toBe(false);
		ed.addNode();
		expect(ed.dirty).toBe(true);
		expect(ed.model.nodes[0]!.downstreamNodeId).toBeNull();
		ed.revert();
		expect(ed.dirty).toBe(false);
		expect(ed.model.nodes).toHaveLength(0);
	});

	it('re-routes children and drops references when a node is removed', () => {
		const ed = new ModelEditor();
		const g = ed.addNode();
		const a = ed.addNode();
		const b = ed.addNode();
		b.downstreamNodeId = a.id;
		const crop = ed.addCrop();
		ed.setCropArea(a.id, crop.id, 500);
		const t = ed.addTransfer();
		t.toNodeId = a.id;
		ed.removeNode(a.id);
		expect(ed.model.nodes.find((n) => n.id === b.id)!.downstreamNodeId).toBe(g.id);
		expect(ed.model.cropAreas).toEqual([]);
		expect(ed.model.transfers).toEqual([]);
		expect(ed.issues).toEqual([]);
	});

	it('keeps crop areas sparse', () => {
		const ed = new ModelEditor();
		const g = ed.addNode();
		const c = ed.addCrop();
		ed.setCropArea(g.id, c.id, 100);
		ed.setCropArea(g.id, c.id, 250);
		expect(ed.cropArea(g.id, c.id)).toBe(250);
		expect(ed.model.cropAreas).toHaveLength(1);
		ed.setCropArea(g.id, c.id, 0);
		expect(ed.model.cropAreas).toHaveLength(0);
	});
});
