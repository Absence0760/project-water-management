// The draw bar's how-to line (DrawBar.svelte) while the map is loading, drawn
// or can't be drawn: only a map that failed says so; one still loading gets
// the usual how-to (it used to say "The map can’t be drawn here" until the
// map drew). Server-rendered; the drawing itself is e2e's.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
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
