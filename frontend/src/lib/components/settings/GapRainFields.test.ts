// Settings → Rain gaps → Gap-filling product (GapRainFields.svelte, issue
// #604 R4-E), rendered with Svelte's server renderer: the three choices in
// plain words, the IMERG Late switch, and the state line only once a product
// is chosen; the browser flow is pinned by e2e/tests/gap-rain.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import GapRainFields from './GapRainFields.svelte';
import { GAP_RAIN_OPTIONS, rainGapsAtDefaults, rainGapsLine, withGapRain } from './rain';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/') } }));
vi.mock('$app/env/public', () => ({ PUBLIC_API_URL: 'http://localhost:3001' }));

const text = (body: string) => body.replace(/<!--[\s\S]*?-->/g, '');

describe('GapRainFields', () => {
	it('offers the three products, CHIRPS chosen by default, the IMERG switch off and no state line', () => {
		const html = text(render(GapRainFields, { props: { value: null } }).body);
		for (const o of GAP_RAIN_OPTIONS) expect(html).toContain(`>${o.label}</option>`);
		expect(html).toContain('Fill the last few days from IMERG Late');
		expect(html).toContain(GAP_RAIN_OPTIONS[0]!.help);
		expect(html).not.toContain('data-testid="gap-rain-note"');
	});

	it('with a product chosen: says why to pick it, and where its rain comes from and shows', () => {
		const html = text(render(GapRainFields, { props: { value: { product: 'era5l', imergLate: true } } }).body);
		expect(html).toContain('daily r 0.57 against 0.25 for CHIRPS');
		expect(html).toContain('data-testid="gap-rain-note"');
		expect(html).toContain('href="?tab=series#data-gap-rain"');
		// Under a catchment station the run ignores it, and the line says so instead.
		expect(text(render(GapRainFields, { props: { value: { product: 'era5l', imergLate: false }, station: true } }).body)).toContain('A run ignores this and says so');
	});

	it('names each control: the select by its label, both described by their hints', () => {
		const html = text(render(GapRainFields, { props: { value: null } }).body);
		const select = html.match(/<select id="([^"]+)"[^>]*aria-describedby="([^"]+)"/)!;
		expect(html).toMatch(new RegExp(`<label for="${select[1]}"[^>]*>Fill blank catchment-rain days from</label>`));
		expect(html).toContain(`id="${select[2]}"`);
	});
});

describe('withGapRain and the Rain gaps fold', () => {
	it('stores null at the defaults, so a project that never chose runs as before', () => {
		expect(withGapRain('chirps', false)).toBeNull();
		expect(withGapRain('chirps', true)).toEqual({ product: 'chirps', imergLate: true });
		expect(withGapRain('era5l', false)).toEqual({ product: 'era5l', imergLate: false });
	});

	it('opens the fold and names the product only when one is chosen', () => {
		expect(rainGapsAtDefaults({ gapRain: null })).toBe(true);
		expect(rainGapsAtDefaults({ gapRain: { product: 'chirps', imergLate: false } })).toBe(true);
		expect(rainGapsAtDefaults({ gapRain: { product: 'chirpsThenEra5l', imergLate: false } })).toBe(false);
		expect(rainGapsLine({ gapRain: { product: 'era5l', imergLate: true } })).toMatch(/^gaps from ERA5-Land, and IMERG Late for the recent days, bias-corrected per month/);
		expect(rainGapsLine({ gapRain: null })).toMatch(/^bias-corrected per month/);
	});
});
