// The drawing mode's keys (attachDrawing.ts): Enter adds at the crosshair
// (the map's middle) for the keyboard, and at the mouse pointer while the
// mouse is over the map, until an arrow key or the mouse leaving brings the
// crosshair back. A fake map stands in for MapLibre: its events by name, a
// centre and an unproject.
import { describe, expect, it } from 'vitest';
import { attachDrawing, type DrawMap } from './attachDrawing';
import { Draft } from './draft.svelte';
import { DRAW_CHOICES } from './shape';

const parcel = DRAW_CHOICES.find((c) => c.id === 'farm_parcel')!;

function setup() {
	const handlers = new Map<string, ((e: unknown) => void)[]>();
	const canvas = { style: { cursor: '' } } as unknown as HTMLCanvasElement;
	const map: DrawMap = {
		on: (type, listener) => void handlers.set(type as string, [...(handlers.get(type as string) ?? []), listener as (e: unknown) => void]),
		off: (type, listener) => void handlers.set(type as string, (handlers.get(type as string) ?? []).filter((h) => h !== listener)),
		getCanvas: () => canvas,
		getCenter: () => ({ lng: 21, lat: -34 }),
		// A screen point 100 px across is 0.01° of longitude, down is south.
		unproject: ([x, y]) => ({ lng: 20 + x / 10000, lat: -33 - y / 10000 }),
		queryRenderedFeatures: () => [],
		doubleClickZoom: { enable() {}, disable() {} },
		dragPan: { enable() {}, disable() {} },
		getLayer: () => undefined
	};
	let onKey: ((e: KeyboardEvent) => void) | null = null;
	const keysOn = {
		addEventListener: (_: string, l: (e: KeyboardEvent) => void) => (onKey = l),
		removeEventListener: () => (onKey = null)
	} as unknown as HTMLElement;
	const fire = (type: string, e: unknown = {}) => handlers.get(type)?.forEach((h) => h(e));
	const press = (key: string) => onKey?.({ key, target: canvas, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent);
	const draft = new Draft();
	draft.draw(parcel);
	const aims: boolean[] = [];
	const detach = attachDrawing(map, draft, keysOn, (p) => aims.push(p));
	const move = (x: number, y: number) => fire('mousemove', { point: { x, y }, lngLat: map.unproject([x, y]) });
	return { draft, press, move, fire, aims, detach };
}

describe('attachDrawing: where Enter adds', () => {
	it('with no mouse over the map, at the crosshair (the map’s middle)', () => {
		const { draft, press, aims } = setup();
		press('Enter');
		expect(draft.coords).toEqual([[21, -34]]);
		expect(aims).toEqual([]);
	});

	it('with the mouse over the map, at the pointer, and the map hears it so it hides the crosshair', () => {
		const { draft, press, move, aims } = setup();
		move(200, 300);
		press('Enter');
		expect(draft.coords).toEqual([[20.02, -33.03]]);
		move(500, 100);
		press('Enter');
		expect(draft.coords[1]).toEqual([20.05, -33.01]);
		expect(aims).toEqual([true]);
	});

	it('an arrow key, or the mouse leaving the map, brings the crosshair back', () => {
		const { draft, press, move, fire, aims } = setup();
		move(200, 300);
		press('ArrowRight');
		press('Enter');
		expect(draft.coords).toEqual([[21, -34]]);
		move(200, 300);
		fire('mouseout');
		press('Enter');
		expect(draft.coords[1]).toEqual([21, -34]);
		expect(aims).toEqual([true, false, true, false]);
	});

	it('detaching forgets the pointer', () => {
		const { move, detach, aims } = setup();
		move(10, 10);
		detach();
		expect(aims).toEqual([true, false]);
	});
});
