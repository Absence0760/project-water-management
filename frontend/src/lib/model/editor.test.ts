import { describe, expect, it } from 'vitest';
import { ModelEditor } from './editor.svelte';

describe('ModelEditor', () => {
	it('is not dirty before anything is loaded', () => {
		// A project page that 404s never calls load(); leaving it must not
		// trigger the "unsaved changes" prompt.
		expect(new ModelEditor().dirty).toBe(false);
	});

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

	it('loads nodes and crops in their saved display order', () => {
		const ed = new ModelEditor();
		const node = (id: string, sortOrder: number) => ({ ...ed.addNode(), id, name: id, sortOrder });
		const nodes = [node('b', 2), node('a', 0), node('c', 1)];
		ed.load({
			nodes,
			crops: [
				{ id: 'y', name: 'y', cropFactor: [], sortOrder: 1 },
				{ id: 'x', name: 'x', cropFactor: [], sortOrder: 0 }
			],
			cropAreas: [],
			transfers: []
		});
		expect(ed.model.nodes.map((n) => n.id)).toEqual(['a', 'c', 'b']);
		expect(ed.model.crops.map((c) => c.id)).toEqual(['x', 'y']);
		expect(ed.dirty).toBe(false);
	});

	it('gives a new crop the next display position', () => {
		const ed = new ModelEditor();
		ed.load({ nodes: [], crops: [{ id: 'x', name: 'x', cropFactor: [], sortOrder: 4 }], cropAreas: [], transfers: [] });
		expect(ed.addCrop().sortOrder).toBe(5);
	});
});
