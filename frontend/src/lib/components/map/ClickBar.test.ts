// The Sub-catchments panel (ClickBar.svelte): typed coordinates are folded
// while the map draws or is still loading, and open only once it can't be
// drawn. A map still loading used to open them, and they stayed open after it
// drew, so a click on Enter coordinates shut the form (e2e
// map-start-data.spec.ts timed out filling a hidden Latitude, CI runs
// 40803033108 and 41068074039). Server-rendered; the clicks are e2e's.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import ClickBar from './ClickBar.svelte';
import { ClickDivider } from './clickPieces.svelte';

// HelpTip links to the glossary under the app's base path.
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

const bar = (mapStatus: 'loading' | 'ready' | 'failed') =>
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
			onone: () => {}
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
