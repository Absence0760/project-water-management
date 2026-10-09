// The drawing mode's keys (attachDrawing.ts): Enter adds at the crosshair
// (the map's middle) for the keyboard, and at the mouse pointer while the
// mouse is over the map, until an arrow key, the mouse leaving, the map
// taking the focus or a touch brings the crosshair back. A fake map stands in for MapLibre: its events by name, a
// centre, an unproject and a project. Corners and edge middles are hit from
// the draft itself, so the fake renders nothing.
import { describe, expect, it, vi } from 'vitest';
import { attachDrawing, type DrawMap } from './attachDrawing';
import { Draft } from './draft.svelte';
import { DRAW_CHOICES } from './shape';
import type { MapFeature } from '$lib/api/types';

const parcel = DRAW_CHOICES.find((c) => c.id === 'farm_parcel')!;

function setup() {
	const handlers = new Map<string, ((e: unknown) => void)[]>();
	const canvasListeners = new Map<string, () => void>();
	const canvas = {
		style: { cursor: '' },
		addEventListener: (type: string, l: () => void) => canvasListeners.set(type, l),
		removeEventListener: (type: string) => canvasListeners.delete(type)
	} as unknown as HTMLCanvasElement;
	const map: DrawMap = {
		on: (type, listener) => void handlers.set(type as string, [...(handlers.get(type as string) ?? []), listener as (e: unknown) => void]),
		off: (type, listener) => void handlers.set(type as string, (handlers.get(type as string) ?? []).filter((h) => h !== listener)),
		getCanvas: () => canvas,
		getCenter: () => ({ lng: 21, lat: -34 }),
		// A screen point 100 px across is 0.01° of longitude, down is south.
		unproject: ([x, y]) => ({ lng: 20 + x / 10000, lat: -33 - y / 10000 }),
		project: ([lng, lat]) => ({ x: (lng - 20) * 10000, y: (-33 - lat) * 10000 }),
		doubleClickZoom: { enable() {}, disable() {} },
		dragPan: { enable() {}, disable() {} }
	};
	let onKey: ((e: KeyboardEvent) => void) | null = null;
	const keysOn = {
		addEventListener: (_: string, l: (e: KeyboardEvent) => void) => (onKey = l),
		removeEventListener: () => (onKey = null)
	} as unknown as HTMLElement;
	const fire = (type: string, e: unknown = {}) => handlers.get(type)?.forEach((h) => h(e));
	const press = (key: string, altKey = false) => onKey?.({ key, altKey, target: canvas, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent);
	const draft = new Draft();
	draft.draw(parcel);
	const aims: boolean[] = [];
	const detach = attachDrawing(map, draft, keysOn, (p) => aims.push(p));
	const move = (x: number, y: number) => fire('mousemove', { point: { x, y }, lngLat: map.unproject([x, y]) });
	const focus = () => canvasListeners.get('focus')?.();
	const click = (x: number, y: number, altKey = false) => fire('click', { point: { x, y }, lngLat: map.unproject([x, y]), originalEvent: { altKey }, preventDefault() {} });
	return { draft, press, move, fire, focus, aims, detach, click, canvas };
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

	it('the map taking the focus (a Tab with the mouse resting over it) goes back to the crosshair', () => {
		const { draft, press, move, focus, aims } = setup();
		move(200, 300);
		focus();
		press('Enter');
		expect(draft.coords).toEqual([[21, -34]]);
		expect(aims).toEqual([true, false]);
	});

	it('a touch, and the mouse events made up after a tap, never aim at the pointer', () => {
		vi.useFakeTimers();
		try {
			const { draft, press, move, fire, aims } = setup();
			fire('touchstart');
			move(200, 300);
			press('Enter');
			expect(draft.coords).toEqual([[21, -34]]);
			// A real mouse, a while later (a laptop with a touch screen): the pointer again (positive control).
			vi.advanceTimersByTime(1500);
			move(200, 300);
			press('Enter');
			expect(draft.coords[1]).toEqual([20.02, -33.03]);
			expect(aims).toEqual([true]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('detaching forgets the pointer', () => {
		const { move, detach, aims } = setup();
		move(10, 10);
		detach();
		expect(aims).toEqual([true, false]);
	});
});

describe('attachDrawing: snapping (#326 C2)', () => {
	// A parcel whose corners are at screen (100, 100) … (300, 300): 21.01–21.03° E, 33.01–33.03° S.
	const neighbour: MapFeature = {
		id: 'n',
		kind: 'farm_parcel',
		name: 'Neighbour',
		nodeId: null,
		nodeName: null,
		damPosition: null,
		geometry: { type: 'Polygon', coordinates: [[[20.01, -33.01], [20.03, -33.01], [20.03, -33.03], [20.01, -33.03], [20.01, -33.01]]] },
		properties: {},
		areaM2: null,
		center: [20.02, -33.02],
		nonContributingM2: null,
		sourceId: null,
		createdBy: null,
		createdAt: '',
		updatedAt: ''
	};

	it('a click near another feature’s corner lands on it, and the live region says so; Alt places it exactly', () => {
		const { draft, click } = setup();
		draft.snapFeatures = [neighbour];
		click(105, 96);
		expect(draft.coords).toEqual([[20.01, -33.01]]);
		expect(draft.said).toBe('Corner 1 at 33.0100° S, 20.0100° E, on “Neighbour”’s corner.');
		click(205, 96, true);
		expect(draft.coords[1]).toEqual([20.0205, -33.0096]);
	});

	it('a click near an edge lands on the edge; with snapping off, where it is', () => {
		const { draft, click } = setup();
		draft.snapFeatures = [neighbour];
		click(200, 95);
		expect(draft.coords).toEqual([[20.02, -33.01]]);
		draft.snapOn = false;
		click(200, 205);
		expect(draft.coords[1]).toEqual([20.02, -33.0205]);
	});

	it('Enter snaps at the crosshair and the pointer; Alt+Enter doesn’t', () => {
		const { draft, press, move } = setup();
		draft.snapFeatures = [neighbour];
		move(296, 303);
		press('Enter');
		expect(draft.coords).toEqual([[20.03, -33.03]]);
		press('Enter', true);
		expect(draft.coords[1]).toEqual([20.0296, -33.0303]);
	});

	it('follows the shared outline between two snapped corners, and the hint shows while moving', () => {
		const { draft, click, move } = setup();
		draft.snapFeatures = [neighbour];
		// The middle of the north edge, then the middle of the east edge: the corner between comes along.
		click(200, 103);
		click(297, 200);
		expect(draft.coords).toEqual([
			[20.02, -33.01],
			[20.03, -33.01],
			[20.03, -33.02]
		]);
		expect(draft.said).toMatch(/\(1 corner followed along it\)\.$/);
		move(102, 300);
		expect(draft.snapHint?.at).toEqual([20.01, -33.03]);
		move(600, 600);
		expect(draft.snapHint).toBeNull();
		draft.follow = false;
		click(101, 199);
		expect(draft.coords).toHaveLength(4);
	});
});

describe('attachDrawing: what a click hits (the draft’s own corners, not the rendered layers)', () => {
	// The fake map renders nothing (no queryRenderedFeatures, no layers), like a layer MapLibre hasn't redrawn yet after setData.
	const triangle = (click: (x: number, y: number) => void) => {
		click(100, 100);
		click(300, 100);
		click(200, 300);
	};

	it('a click on the first corner right after the third closes the polygon instead of adding a fourth', () => {
		const { draft, click } = setup();
		triangle(click);
		expect(draft.phase).toBe('drawing');
		click(105, 96);
		expect(draft.phase).toBe('review');
		expect(draft.coords).toHaveLength(3);
	});

	it('a click near another corner while drawing adds nothing; one beyond its reach adds a corner (positive control)', () => {
		const { draft, click } = setup();
		triangle(click);
		// Reach: the 12 px box around the click touching the drawn corner (11 px across its middle with the stroke), 23 px in all.
		click(300, 122);
		expect(draft.coords).toHaveLength(3);
		expect(draft.phase).toBe('drawing');
		click(300, 125);
		expect(draft.coords).toHaveLength(4);
	});

	it('while drawing, an edge’s middle is not a target: a click there adds a corner', () => {
		const { draft, click } = setup();
		triangle(click);
		// The middle of the edge from (100, 100) to (300, 100).
		click(200, 100);
		expect(draft.coords).toHaveLength(4);
		expect(draft.coords[3]).toEqual([20.02, -33.01]);
	});

	it('once closed, a click near an edge’s middle inserts a corner there, after the right corner', () => {
		const { draft, click } = setup();
		triangle(click);
		click(100, 100);
		// The north edge's middle (200, 100), between corners 0 and 1.
		click(203, 98);
		expect(draft.coords).toHaveLength(4);
		expect(draft.coords[1]).toEqual([20.0203, -33.0098]);
		expect(draft.coords[2]).toEqual([20.03, -33.01]);
	});

	it('a click on a corner picks it, and a corner wins over a nearer edge middle', () => {
		const { draft, click } = setup();
		click(100, 100);
		click(160, 100);
		click(130, 300);
		click(100, 100);
		expect(draft.phase).toBe('review');
		// The middle of edge 0–1 is at (130, 100), corner 1 at (160, 100): at (142, 100) the middle is nearer, the corner still within reach.
		click(142, 100);
		expect(draft.corner).toBe(1);
		expect(draft.coords).toHaveLength(3);
		// On the middle itself, 30 px from either corner, it adds a corner (positive control).
		click(130, 100);
		expect(draft.coords).toHaveLength(4);
		expect(draft.coords[1]).toEqual([20.013, -33.01]);
	});

	it('the cursor once closed: move over a corner, copy over a middle, none elsewhere', () => {
		const { click, move, canvas } = setup();
		triangle(click);
		click(100, 100);
		move(300, 100);
		expect(canvas.style.cursor).toBe('move');
		move(200, 100);
		expect(canvas.style.cursor).toBe('copy');
		move(200, 200);
		expect(canvas.style.cursor).toBe('');
	});

	it('a line has a middle on each segment and none back to its first point', () => {
		const { draft, click } = setup();
		draft.draw(DRAW_CHOICES.find((c) => c.id === 'river')!);
		triangle(click);
		// A second click on the last point finishes the line.
		click(200, 300);
		expect(draft.phase).toBe('review');
		// The middle of the last segment, (250, 200): a corner after corner 1.
		click(250, 200);
		expect(draft.coords).toHaveLength(4);
		expect(draft.coords[2]).toEqual([20.025, -33.02]);
		// Where a polygon's closing edge would have its middle, (150, 200): nothing to hit, so nothing is added.
		click(150, 200);
		expect(draft.coords).toHaveLength(4);
		expect(draft.corner).toBeNull();
	});

	it('a press on a corner once closed drags it, read from the draft too', () => {
		const { draft, click, fire, move } = setup();
		triangle(click);
		click(100, 100);
		fire('mousedown', { point: { x: 302, y: 98 }, lngLat: { lng: 0, lat: 0 }, preventDefault() {} });
		expect(draft.corner).toBe(1);
		move(400, 150);
		expect(draft.coords[1]).toEqual([20.04, -33.015]);
		fire('mouseup');
	});

	it('a whole pasted shape has no corners or middles to hit', () => {
		const { draft, click } = setup();
		triangle(click);
		click(100, 100);
		draft.whole = {
			type: 'MultiPolygon',
			coordinates: [
				[[[20.01, -33.01], [20.03, -33.01], [20.02, -33.03], [20.01, -33.01]]],
				[[[20.05, -33.05], [20.06, -33.05], [20.06, -33.06], [20.05, -33.05]]]
			]
		};
		draft.corner = 0;
		click(100, 100);
		expect(draft.corner).toBeNull();
		click(200, 100);
		expect(draft.coords).toHaveLength(3);
	});
});
