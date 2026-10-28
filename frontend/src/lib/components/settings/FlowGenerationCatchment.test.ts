// Settings → Model selection for flow generation → The catchment's rainfall station (FlowGenerationCatchment.svelte,
// issue #612 follow-up), rendered with Svelte's server renderer: no station by default (the catchment rain series),
// a station's patching priority (CHIRPS by default), its scaling, its correcting station, a deleted station named,
// the no-stations note, and a viewer's disabled fields. The browser flow is pinned by
// e2e/tests/rain-patch-priority.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import FlowGenerationCatchment from './FlowGenerationCatchment.svelte';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/') } }));

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
	{ id: 's1', name: 'Ridge', station: { mapMm: 600, mapSource: 'ridge record', lat: null, lon: null } },
	{ id: 's2', name: 'Vlei', station: { mapMm: null, mapSource: null, lat: null, lon: null } }
];

describe('FlowGenerationCatchment', () => {
	it('has no station by default: the catchment rain series, and no patching priority', () => {
		const body = text(render(FlowGenerationCatchment, { props: { value: null, stations } }).body);
		expect(body).toMatch(/<option value=""[^>]*>No station: the catchment rain series, as before stations<\/option>/);
		expect(body).toMatch(/<option value="s1"[^>]*>Ridge<\/option>/);
		// Satellite rain patches gaps; it is never the catchment's station.
		expect(body.match(/<select[^>]*>[\s\S]*?<\/select>/)![0]).not.toMatch(/CHIRPS/);
		expect(body).not.toContain('data-testid="flowgen-patch"');
		expect(body).not.toContain('Scale to catchment MAP');
		expect(body).toContain('forecast days are never patched');
	});

	it('with a station, shows its patching priority (CHIRPS by default), its scaling and its correcting station', () => {
		const body = text(render(FlowGenerationCatchment, { props: { value: { catchment: { stationId: 's1' } }, stations } }).body);
		expect(body).toContain('aria-label="Then patch gaps from, for the catchment"');
		expect(body.match(/data-testid="flowgen-patch-entry" data-source="([^"]+)"/g)!.map((x) => x.split('"').at(-2))).toEqual(['chirps']);
		expect(body).toContain('the catchment’s CHIRPS, corrected month by month against the station’s rain at the catchment’s MAP');
		expect(body).toMatch(/<input type="checkbox"[^>]*checked/);
		expect(body).toContain('× catchment MAP ÷ station MAP');
		expect(body).toContain('Its station (Ridge)');
		expect(body).toContain('Change it in Series details');
		// The main station is no choice in its own patch list.
		expect(body.match(/aria-label="Then patch gaps from, for the catchment"[\s\S]*?<\/ol>/)![0]).not.toMatch(/<option value="s1"/);
	});

	it('keeps a stored chain, unscaled, against another correcting station', () => {
		const value = { catchment: { stationId: 's1', scaleToMap: false, correctAgainst: 's2', patch: [{ source: 'station' as const, stationId: 's2' }, { source: 'chirps' as const }] } };
		const body = text(render(FlowGenerationCatchment, { props: { value, stations } }).body);
		expect(body.match(/data-testid="flowgen-patch-entry" data-source="([^"]+)"/g)!.map((x) => x.split('"').at(-2))).toEqual(['s2', 'chirps']);
		expect(body).toContain('× 1, as recorded');
		expect(body).not.toMatch(/<input type="checkbox"[^>]*checked/);
		expect(body).toMatch(/<option value="s2" selected[^>]*>Vlei<\/option>/);
	});

	it('names a deleted station instead of picking another', () => {
		const body = text(render(FlowGenerationCatchment, { props: { value: { catchment: { stationId: 'gone' } }, stations } }).body);
		expect(body).toContain('A station the project no longer has');
		expect(body).toContain('data-testid="flowgen-catchment-missing"');
		expect(body).not.toContain('data-testid="flowgen-patch"');
	});

	it('says how to add a station when the project has none', () => {
		const body = text(render(FlowGenerationCatchment, { props: { value: null, stations: [] } }).body);
		expect(body).toContain('data-testid="flowgen-catchment-no-stations"');
		expect(body).not.toContain('No station: the catchment rain series');
	});

	it('for a viewer, disables the fields and has no chain controls', () => {
		const body = text(render(FlowGenerationCatchment, { props: { value: { catchment: { stationId: 's1' } }, stations, readonly: true } }).body);
		expect(body).toMatch(/<select[^>]*disabled[^>]*>\s*<option value=""/);
		expect(body).toMatch(/<input type="checkbox"[^>]*disabled/);
		expect(body).not.toContain('Add a source');
		expect(body).toContain('See it in Series details');
	});
});
