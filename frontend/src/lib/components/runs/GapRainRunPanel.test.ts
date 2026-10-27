// A run's "Rain gaps filled from other products" (GapRainRunPanel.svelte,
// issue #604 R4-E): each product's days and rain, the days each filled with
// IMERG's version, the breaks, and the credits word for word.
import { rainCredits, type GapRainInfo } from '@water-management/engine';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import GapRainRunPanel from './GapRainRunPanel.svelte';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));

const text = (body: string) => body.replace(/<!--[\s\S]*?-->/g, '');

const info = (segments = 2): GapRainInfo =>
	({
		product: 'chirpsThenEra5l',
		imergLate: true,
		chirpsDays: 40,
		tailFrom: '2026-10-20',
		products: [
			{ key: 'rain_era5l_mm', product: 'era5l', version: null, label: 'ERA5-Land', present: true, correction: { pooled: { factor: 1.12 } }, doubleMass: { breaks: [{ afterWaterYear: 2010, slopeBefore: 1.1, slopeAfter: 0.9 }] }, days: 12, rawMm: 30, mm: 33.6 },
			{ key: 'rain_imerg_late_mm~V07', product: 'imerg_late', version: 'V07', label: 'IMERG Late V07', present: true, correction: null, doubleMass: null, days: 3, rawMm: 5, mm: 5 }
		],
		segments: Array.from({ length: segments }, (_, i) => ({ from: `2026-0${(i % 9) + 1}-05`, to: `2026-0${(i % 9) + 1}-06`, product: i % 2 ? 'imerg_late' : 'era5l', version: i % 2 ? 'V07' : null }))
	}) as unknown as GapRainInfo;

describe('GapRainRunPanel', () => {
	it('lists each product with its days, rain, factor and breaks, and which product filled which days', () => {
		const html = text(render(GapRainRunPanel, { props: { info: info() } }).body);
		expect(html).toContain('Rain gaps filled from other products');
		expect(html).toContain('CHIRPS, then ERA5-Land where CHIRPS has none, and IMERG Late for the recent days');
		expect(html).toContain('after 2010/11 (1.10 → 0.90)');
		expect(html).toContain('not checked');
		expect(html).toMatch(/IMERG Late V07<\/li>/);
		expect(html).toContain('ERA5-Land</li>');
		expect(html).not.toContain('data-testid="run-gap-rain-credits"');
	});

	it('shows the first eight runs of days with a button for the rest, and the credits when given', () => {
		const credits = rainCredits({ era5l: true, imergVersions: ['V07'] }, '2026-10-27');
		const html = text(render(GapRainRunPanel, { props: { info: info(11), credits } }).body);
		expect(html.match(/<li>/g)!.length).toBe(8 + 3);
		expect(html).toContain('Show all 11 runs of days');
		expect(html).toContain(credits[0]!.lines[0]);
		expect(html).toContain(credits[1]!.lines[0]);
	});
});
