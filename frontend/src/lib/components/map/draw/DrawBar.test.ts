// The draw bar's how-to line (DrawBar.svelte) while the map is loading, drawn
// or can't be drawn: only a map that failed says so; one still loading gets
// the usual how-to (it used to say "The map can’t be drawn here" until the
// map drew), and nothing above its buttons waits for the map to draw (issue
// #719). Server-rendered; the drawing itself is e2e's.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { MapFeature } from '#lib/api/types.js';
import { delineationLines } from '../mapList';
import { Draft } from './draft.svelte';
import DrawBar from './DrawBar.svelte';
import { DRAW_CHOICES } from './shape';

// HelpTip links to the glossary under the app's base path.
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

const parcel = DRAW_CHOICES.find((c) => c.id === 'farm_parcel')!;

const how = (mapStatus: 'loading' | 'ready' | 'failed') => {
	const draft = new Draft();
	draft.draw(parcel);
	const html = render(DrawBar, { props: { draft, mapStatus, onsave: () => {}, onpaste: () => {}, oncoords: () => {}, onlocated: () => {} } }).body;
	return html.match(/data-testid="map-draw-how"[^>]*>([^<]*)</)?.[1]?.trim() ?? '';
};

describe('DrawBar: the how-to line', () => {
	it('says the map can’t be drawn only once it has failed', () => {
		expect(how('failed')).toBe('The map can’t be drawn here: paste the shape as GeoJSON or WKT.');
	});

	it('gives the usual how-to while the map is still loading, the same as once it draws', () => {
		expect(how('loading')).not.toMatch(/can’t be drawn/);
		expect(how('loading')).toBe(how('ready'));
	});
});

describe('DrawBar: nothing above the buttons waits for the map (issue #719)', () => {
	// A feature on the map, so Snap to features is offered.
	const parcel: MapFeature = {
		id: 'f1',
		kind: 'farm_parcel',
		name: 'Parcel',
		nodeId: null,
		nodeName: null,
		damPosition: null,
		geometry: { type: 'Polygon', coordinates: [[[20, -33], [20.1, -33], [20.1, -33.1], [20, -33]]] },
		properties: {},
		areaM2: null,
		center: [20.05, -33.05],
		sourceId: null,
		nonContributingM2: null,
		createdBy: null,
		createdAt: '',
		updatedAt: ''
	};
	const delineating = (mapStatus: 'loading' | 'ready' | 'failed') => {
		const draft = new Draft();
		draft.place('gauge');
		draft.snapFeatures = [parcel];
		const html = render(DrawBar, {
			props: { draft, mapStatus, delineating: true, lines: delineationLines({ channels: '#c8102e' }), onsave: () => {}, onpaste: () => {}, oncoords: () => {}, onlocated: () => {} }
		}).body;
		// Each render numbers its ids afresh; the markup is what matters.
		return html.replace(/\b(id|for|aria-labelledby|aria-controls|aria-describedby|name)="[^"]*"/g, '$1=""');
	};
	/** Everything the bar draws before its first button (Enter coordinates): a row added there as the map drew moved the button under a press. */
	const aboveButtons = (html: string) => html.slice(0, html.indexOf('data-testid="map-enter-coordinates"'));

	it('draws the same above Enter coordinates while the map loads as once it has drawn', () => {
		const loading = delineating('loading');
		expect(aboveButtons(loading)).toContain('data-testid="map-delineation-lines"');
		expect(aboveButtons(loading)).toContain('data-testid="map-snap"');
		expect(aboveButtons(loading)).toBe(aboveButtons(delineating('ready')));
	});

	it('leaves out the lines and snapping once the map can’t be drawn', () => {
		const failed = delineating('failed');
		expect(failed).not.toContain('data-testid="map-delineation-lines"');
		expect(failed).not.toContain('data-testid="map-snap"');
		expect(failed).toContain('data-testid="map-enter-coordinates"');
	});
});
