// One patching priority (PatchChain.svelte, issue #612), rendered with Svelte's server renderer: an ordered list of
// pull-downs with the main station never a choice, a station that can't help greyed out with why, each station's fill
// count over the run's days before the forecast, CHIRPS's line, an empty list's note, and no controls for a viewer.
// The browser flow is pinned by e2e/tests/rain-patch-priority.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PatchChain from './PatchChain.svelte';
import type { PatchUsability } from './flowGeneration';

/** The markup without Svelte's hydration comments, stripped until none are left (CodeQL js/incomplete-multi-character-sanitization). */
const text = (body: string) => {
	let s = body;
	for (let prev = ''; prev !== s; ) {
		prev = s;
		s = s.replace(/<!--[\s\S]*?-->/g, '');
	}
	return s;
};

const stations = [
	{ id: 'm', name: 'Main', station: { mapMm: 600, mapSource: null, lat: null, lon: null } },
	{ id: 'p', name: 'Vlei', station: { mapMm: 500, mapSource: null, lat: null, lon: null } },
	{ id: 'q', name: 'Short', station: { mapMm: 450, mapSource: null, lat: null, lon: null } }
];
const use: Record<string, PatchUsability> = {
	p: { usable: true, reason: null, gapDays: 10, fills: 10, from: '2021-10-01', to: '2022-01-28', windowFrom: '2021-10-01', windowTo: '2022-01-28', forecastDays: 14 },
	q: { usable: false, reason: 'it has no reading on any of the main station’s 10 gap days before the forecast', gapDays: 10, fills: 0, from: '2021-12-01', to: '2021-12-05', windowFrom: '2021-10-01', windowTo: '2022-01-28', forecastDays: 14 }
};
const base = { set: () => {}, mainId: 'm', who: 'the catchment', stations, chirpsText: 'the catchment’s CHIRPS, corrected' };

describe('PatchChain', () => {
	it('lists the sources in order, never offering the main station, with each station’s fill count before the forecast', () => {
		const body = text(render(PatchChain, { props: { ...base, values: ['p', 'chirps'], use } }).body);
		expect(body).toContain('aria-label="Then patch gaps from, for the catchment"');
		expect(body.match(/data-testid="flowgen-patch-entry" data-source="([^"]+)"/g)!.map((x) => x.split('"').at(-2))).toEqual(['p', 'chirps']);
		expect(body).not.toMatch(/<option value="m"/);
		expect(body).toContain(
			'fills 10 of the main station’s 10 gap days (100 %); gaps counted 2021-10-01 to 2022-01-28, the run’s 14 forecast days left out; record 2021-10-01 to 2022-01-28'
		);
		expect(body).toContain('the catchment’s CHIRPS, corrected');
		// A station that can't help is greyed out with why.
		expect(body).toMatch(/<option value="q" disabled[^>]*>Short \(can’t help: it has no reading on any of the main station’s 10 gap days before the forecast\)<\/option>/);
		expect(body).toContain('aria-label="Move patch source 1 for the catchment up"');
		expect(body).toMatch(/aria-label="Move patch source 1 for the catchment up"[^>]*disabled/);
		expect(body).toContain('aria-label="Remove patch source 2 for the catchment"');
		// Short can still be added (it stays in the list and the run warns), so Add a source is on.
		expect(body).not.toMatch(/<button[^>]*disabled[^>]*>Add a source<\/button>/);
		// With every other source listed, nothing is left to add.
		const full = text(render(PatchChain, { props: { ...base, values: ['p', 'q', 'chirps'], use } }).body);
		expect(full).toMatch(/<button[^>]*disabled[^>]*>Add a source<\/button>/);
	});

	it('without counts yet, shows no fill line and no greyed-out station', () => {
		const body = text(render(PatchChain, { props: { ...base, values: ['chirps'], use: null } }).body);
		expect(body).not.toContain('data-testid="flowgen-patch-fill"');
		expect(body).not.toContain('can’t help');
		expect(body).toMatch(/<button[^>]*>Add a source<\/button>/);
		expect(body).not.toMatch(/<button[^>]*disabled[^>]*>Add a source<\/button>/);
	});

	it('says where the gaps go when the list is empty, and names a station the project no longer has', () => {
		expect(text(render(PatchChain, { props: { ...base, values: [], use } }).body)).toContain('data-testid="flowgen-patch-none"');
		expect(text(render(PatchChain, { props: { ...base, values: ['gone'], use } }).body)).toMatch(/<option value="gone"[^>]*>A station the project no longer has<\/option>/);
	});

	it('for a viewer, disables the pull-downs and has no Up, Down, Remove or Add', () => {
		const body = text(render(PatchChain, { props: { ...base, values: ['p', 'chirps'], use, readonly: true } }).body);
		expect(body).toMatch(/<select[^>]*aria-label="Patch source 1 for the catchment"[^>]*disabled|<select[^>]*disabled[^>]*aria-label="Patch source 1 for the catchment"/);
		expect(body).not.toContain('Move patch source');
		expect(body).not.toContain('Remove patch source');
		expect(body).not.toContain('Add a source');
	});
});
