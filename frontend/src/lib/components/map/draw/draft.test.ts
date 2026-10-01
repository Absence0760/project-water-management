// The draft (draft.svelte.ts): drawing, finishing, undo, editing corners, pasting, placing a point.
import { describe, expect, it } from 'vitest';
import type { MapFeature } from '$lib/api/types';
import { Draft } from './draft.svelte';
import { DRAW_CHOICES } from './shape';

const parcel = DRAW_CHOICES.find((c) => c.id === 'farm_parcel')!;

describe('Draft', () => {
	it('draws a polygon corner by corner, undoes the last, finishes and saves as a closed ring', () => {
		const d = new Draft();
		d.draw(parcel);
		expect(d.active).toBe(true);
		d.add([21, -34]);
		d.add([22, -34]);
		expect(d.canFinish).toBe(false);
		d.add([9, 9]);
		d.undo();
		expect(d.coords).toEqual([
			[21, -34],
			[22, -34]
		]);
		d.add([22, -33]);
		expect(d.said).toMatch(/^Corner 3 at /);
		expect(d.finish()).toBe(true);
		expect(d.phase).toBe('review');
		expect(d.geometry).toEqual({ type: 'Polygon', coordinates: [[[21, -34], [22, -34], [22, -33], [21, -34]]] });
		// Undo after finishing reopens the drawing.
		d.undo();
		expect(d.phase).toBe('drawing');
	});
	it('adjusts a closed shape: a drag is one undo step, a middle adds a corner, a corner goes but never below three', () => {
		const d = new Draft();
		d.draw(parcel);
		for (const p of [[21, -34], [22, -34], [22, -33]] as const) d.add([...p]);
		d.finish();
		d.beginChange();
		d.moveCorner(2, [22.1, -33]);
		d.moveCorner(2, [22.2, -33]);
		d.undo();
		expect(d.coords[2]).toEqual([22, -33]);
		d.insertCorner(2, [21.5, -33]);
		expect(d.coords).toHaveLength(4);
		expect(d.removeCorner(0)).toBe(true);
		expect(d.removeCorner(0)).toBe(false);
		expect(d.said).toMatch(/keeps at least 3 corners/);
	});
	it('places a point, moves it with the next click, and cancels to nothing', () => {
		const d = new Draft();
		d.place('dam');
		d.add([21, -33]);
		d.add([21.5, -33.5]);
		expect(d.geometry).toEqual({ type: 'Point', coordinates: [21.5, -33.5] });
		expect(d.kind).toBe('dam');
		d.cancel();
		expect(d.active).toBe(false);
		expect(d.coords).toEqual([]);
	});
	it('takes a pasted shape of its own shape only; several parts are kept whole', () => {
		const d = new Draft();
		d.draw(DRAW_CHOICES.find((c) => c.id === 'river'));
		expect(d.replace({ type: 'Point', coordinates: [21, -33] })).toBe(false);
		const multi = { type: 'MultiLineString' as const, coordinates: [[[21, -33], [22, -33]], [[21, -34], [22, -34]]] as [number, number][][] };
		expect(d.replace(multi)).toBe(true);
		expect(d.geometry).toEqual(multi);
		d.undo();
		expect(d.geometry).toBeNull();
	});
	it('edits an existing feature’s corners, and refuses one with several parts', () => {
		const base = { id: 'f', kind: 'farm_parcel', name: 'P', nodeId: null, nodeName: null, properties: {}, areaM2: 1, center: [0, 0], sourceId: null, createdBy: null, createdAt: '', updatedAt: '' } as const;
		const ring: [number, number][] = [[21, -34], [22, -34], [22, -33], [21, -34]];
		const d = new Draft();
		expect(d.edit({ ...base, geometry: { type: 'Polygon', coordinates: [ring] } } as MapFeature)).toBe(true);
		expect(d.mode).toBe('edit');
		expect(d.coords).toHaveLength(3);
		expect(new Draft().edit({ ...base, geometry: { type: 'MultiPolygon', coordinates: [[ring], [ring]] } } as MapFeature)).toBe(false);
	});
});
