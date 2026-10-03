// The draft (draft.svelte.ts): drawing, finishing, undo, editing corners, pasting, placing a point.
import { describe, expect, it } from 'vitest';
import type { MapFeature } from '$lib/api/types';
import { cutText, Draft } from './draft.svelte';
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

	describe('escape', () => {
		const asks = (answer: boolean) => {
			const calls: { title: string }[] = [];
			return { calls, ask: (o: { title: string }) => (calls.push(o), Promise.resolve(answer)) };
		};
		it('cancels at once with fewer than two corners, and a placed point', async () => {
			const d = new Draft();
			d.draw(parcel);
			d.add([21, -34]);
			const a = asks(false);
			expect(await d.escape(a.ask)).toBe(true);
			expect(d.active).toBe(false);
			d.place('gauge');
			d.add([21, -33]);
			expect(await d.escape(a.ask)).toBe(true);
			expect(a.calls).toHaveLength(0);
		});
		it('asks once two corners are drawn: Keep drawing keeps every corner, Discard drops them', async () => {
			const d = new Draft();
			d.draw(parcel);
			d.add([21, -34]);
			d.add([22, -34]);
			expect(d.unsaved).toBe(true);
			const keep = asks(false);
			expect(await d.escape(keep.ask)).toBe(false);
			expect(keep.calls.map((c) => c.title)).toEqual(['Discard this drawing?']);
			expect(d.active).toBe(true);
			expect(d.coords).toHaveLength(2);
			const discard = asks(true);
			expect(await d.escape(discard.ask)).toBe(true);
			expect(d.active).toBe(false);
		});
		it('asks for a finished drawing, and only once while the question is up', async () => {
			const d = new Draft();
			d.draw(parcel);
			for (const p of [[21, -34], [22, -34], [22, -33]] as [number, number][]) d.add(p);
			d.finish();
			let answer!: (ok: boolean) => void;
			let calls = 0;
			const ask = () => (calls++, new Promise<boolean>((r) => (answer = r)));
			const first = d.escape(ask);
			expect(await d.escape(ask)).toBe(false);
			expect(calls).toBe(1);
			answer(true);
			expect(await first).toBe(true);
			expect(d.active).toBe(false);
		});
		it('an edit asks only once something changed', async () => {
			const ring: [number, number][] = [[21, -34], [22, -34], [22, -33], [21, -34]];
			const f = { id: 'f', kind: 'farm_parcel', name: 'P', nodeId: null, nodeName: null, properties: {}, areaM2: 1, center: [0, 0], sourceId: null, createdBy: null, createdAt: '', updatedAt: '', geometry: { type: 'Polygon', coordinates: [ring] } } as unknown as MapFeature;
			const d = new Draft();
			d.edit(f);
			expect(d.unsaved).toBe(false);
			d.insertCorner(0, [21.5, -34]);
			const a = asks(false);
			expect(await d.escape(a.ask)).toBe(false);
			expect(a.calls.map((c) => c.title)).toEqual(['Discard your changes?']);
			d.undo();
			expect(await d.escape(a.ask)).toBe(true);
			expect(a.calls).toHaveLength(1);
		});
	});
});

const feature = (id: string, kind: MapFeature['kind'], geometry: MapFeature['geometry']): MapFeature => ({
	id,
	kind,
	name: 'Shape',
	nodeId: null,
	nodeName: null,
	damPosition: null,
	geometry,
	properties: {},
	areaM2: 1,
	center: [0, 0],
	nonContributingM2: null,
	sourceId: null,
	createdBy: null,
	createdAt: '',
	updatedAt: ''
});
const squareGeometry = { type: 'Polygon' as const, coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] as [number, number][][] };

describe('Draft: assisted drawing (#326 C2)', () => {
	it('splits a polygon: a line drawn across it previews two parts; a line that misses says why', () => {
		const d = new Draft();
		expect(d.split(feature('g', 'gauge', { type: 'Point', coordinates: [0, 0] }))).toBe(false);
		expect(d.split(feature('p', 'farm_parcel', squareGeometry))).toBe(true);
		expect(d.mode).toBe('split');
		expect(d.shape).toBe('line');
		expect(d.splitResult).toBeNull();
		d.add([1, -1]);
		d.add([1, 3]);
		d.finish();
		const r = d.splitResult;
		expect(r && 'parts' in r ? r.parts.map((p) => p.length) : r).toEqual([4, 4]);
		// The live region says which part is where, and how big.
		expect(d.said).toMatch(/^Cut in two: part 1, the (western|eastern), about .+ km², and part 2, the (western|eastern), about .+ km²\.$/);
		d.undo();
		d.coords = [];
		d.add([0.5, 0.5]);
		d.add([1.5, 0.5]);
		d.finish();
		expect(d.splitResult).toEqual({ problem: expect.stringContaining('right across the shape') });
		// A split's cut never follows an outline, whatever Follow edges says.
		expect(d.following).toBe(false);
	});

	it('holds a traced outline as a drawing of a dam, ready to save; knows when it was adjusted', () => {
		const d = new Draft();
		const trace = { minOccurrence: 25, dataset: 'Synthetic', methodVersion: 'trace-dam-1' } as never;
		expect(d.trace(squareGeometry, trace)).toBe(true);
		expect(d.mode).toBe('draw');
		expect(d.kind).toBe('dam');
		expect(d.phase).toBe('review');
		expect(d.traced).toBe(trace);
		expect(d.tracedEdited).toBe(false);
		expect(d.geometry).toEqual(squareGeometry);
		d.beginChange();
		d.moveCorner(1, [3, 0]);
		expect(d.tracedEdited).toBe(true);
		d.undo();
		expect(d.tracedEdited).toBe(false);
		d.cancel();
		expect(d.traced).toBeNull();
		// Drawn as something else, it is no longer the trace.
		d.trace(squareGeometry, trace);
		d.choose('other-area');
		expect(d.traced).toBe(trace);
		d.choose('farm_parcel');
		expect(d.traced).toBeNull();
		expect(d.said).toBe('No longer a traced dam outline: it saves as a drawing.');
	});

	it('closing a polygon whose first and last corners are on one outline follows it', () => {
		const d = new Draft();
		d.draw(parcel);
		const line = { featureId: 'b', part: 0, label: 'the catchment boundary', coords: squareGeometry.coordinates[0]!.slice(0, 4), closed: true };
		// On the west edge, inside, then on the south edge: closing goes round the south-west corner.
		d.add([0, 1], { at: [0, 1], line, pos: 3.5, what: 'edge' });
		d.add([1, 1]);
		d.add([1, 0], { at: [1, 0], line, pos: 0.5, what: 'edge' });
		d.finish();
		expect(d.coords).toEqual([
			[0, 1],
			[1, 1],
			[1, 0],
			[0, 0]
		]);
	});
});

describe('cutText', () => {
	it('names each part by where it lies against the other', () => {
		const west: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
		const east: [number, number][] = [[1, 0], [2, 0], [2, 1], [1, 1]];
		expect(cutText([west, east])).toMatch(/^part 1, the western, about .+, and part 2, the eastern, about .+$/);
		const north: [number, number][] = [[0, 1], [1, 1], [1, 2], [0, 2]];
		expect(cutText([north, west])).toMatch(/^part 1, the northern, .+part 2, the southern/);
	});
});
