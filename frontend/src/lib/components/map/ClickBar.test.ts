// The Sub-catchments panel (ClickBar.svelte): typed coordinates are folded
// while the map draws or is still loading, and open only once it can't be
// drawn. A map still loading used to open them, and they stayed open after it
// drew, so a click on Enter coordinates shut the form (e2e
// map-start-data.spec.ts timed out filling a hidden Latitude, CI runs
// 40803033108 and 41068074039). Nothing above its buttons waits for the map
// to draw either (issue #719). Server-rendered; the clicks are e2e's.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import ClickBar from './ClickBar.svelte';
import { ClickDivider } from './clickPieces.svelte';
import { delineationLines } from './mapList';

// HelpTip links to the glossary under the app's base path.
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

const bar = (mapStatus: 'loading' | 'ready' | 'failed', within: { name: string; outlet: 'delineation' | 'lowest' } | null = null, lines: ReturnType<typeof delineationLines> | null = null) =>
	render(ClickBar, {
		props: {
			divider: new ClickDivider(
				() => Promise.reject(new Error('not called')),
				() => Promise.reject(new Error('not called'))
			),
			mapStatus,
			ondone: () => {},
			onsave: () => {},
			onlit: () => {},
			onone: () => {},
			within,
			lines
		}
	}).body;

const coords = (html: string) => html.match(/<details class="coords[^"]*"[^>]*>/)?.[0] ?? '';
const how = (html: string) => html.match(/data-testid="map-click-how"[^>]*>([^<]*)</)?.[1]?.trim() ?? '';

describe('ClickBar: Enter coordinates', () => {
	it('is folded while the map is still loading, and says to click, not that the map can’t be drawn', () => {
		const html = bar('loading');
		expect(coords(html)).not.toBe('');
		expect(coords(html)).not.toMatch(/\bopen\b/);
		expect(how(html)).toMatch(/^Click a terrain channel for each outlet/);
	});

	it('is folded once the map draws', () => {
		const html = bar('ready');
		expect(coords(html)).not.toMatch(/\bopen\b/);
		expect(how(html)).toMatch(/^Click a terrain channel for each outlet/);
	});

	it('is open when the map can’t be drawn: it is the only way in', () => {
		const html = bar('failed');
		expect(coords(html)).toMatch(/\bopen\b/);
		expect(how(html)).toBe('The map can’t be drawn here: enter each outlet’s coordinates.');
	});
});

describe('ClickBar: within the catchment boundary', () => {
	const within = (html: string) => html.match(/data-testid="map-click-within"[^>]*>([^<]*)</)?.[1]?.trim() ?? null;

	it('names the catchment and its outlet before the first click', () => {
		expect(within(bar('ready', { name: 'Valley', outlet: 'delineation' }))).toMatch(/^Within “Valley”: its delineated outlet is the lowest point/);
		expect(within(bar('ready', { name: 'Drawn', outlet: 'lowest' }))).toMatch(/^Within “Drawn”: drawn by hand, it has no delineated outlet, so your lowest click is the outlet/);
	});

	it('says nothing of it with no boundary on the map', () => {
		expect(within(bar('ready'))).toBeNull();
	});
});

describe('ClickBar: nothing above the buttons waits for the map (issue #719)', () => {
	const lines = delineationLines({ channels: '#c8102e' });
	// Each render numbers its ids afresh; the markup is what matters.
	const markup = (html: string) => html.replace(/\b(id|for|aria-labelledby|aria-controls|aria-describedby|name)="[^"]*"/g, '$1=""');

	it('draws the lines’ key while the map loads, so the panel is the same once it has drawn', () => {
		const loading = markup(bar('loading', null, lines));
		expect(loading).toContain('data-testid="map-delineation-lines"');
		expect(loading).toBe(markup(bar('ready', null, lines)));
	});

	it('leaves the key out once the map can’t be drawn', () => {
		expect(bar('failed', null, lines)).not.toContain('data-testid="map-delineation-lines"');
	});
});
