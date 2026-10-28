// Settings → Model selection for flow generation → Per unit's station table (FlowGenerationUnits.svelte, issue #553 round 3), rendered
// with Svelte's server renderer: a row per land unit with its station select (stations only: no satellite option),
// the scaling and its ratio, the correcting station, and each station in use once with its MAP; a viewer's fields
// are disabled with no select-several action. The browser flow is pinned by e2e/tests/flow-generation.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import FlowGenerationUnits from './FlowGenerationUnits.svelte';

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

const nodes = [
	{ id: 'a', name: 'Upper unit', kind: 'farm' as const, areaKm2: 10, mapMm: 900, mapSource: 'grid' },
	{ id: 'b', name: 'Lower unit', kind: 'farm' as const, areaKm2: 5, mapMm: null, mapSource: null },
	{ id: 'g', name: 'Gauge', kind: 'gauge' as const, areaKm2: 0, mapMm: null, mapSource: null }
];
const stations = [
	{ id: 's1', name: 'Ridge', station: { mapMm: 600, mapSource: 'ridge record', lat: null, lon: null } },
	{ id: 's2', name: 'Vlei', station: { mapMm: 500, mapSource: 'vlei record', lat: -33.9, lon: 18.9 } }
];
const rows = (body: string) => body.match(/data-testid="flowgen-row"/g)?.length ?? 0;

describe('FlowGenerationUnits', () => {
	it('lists each land unit with a station select of the stations only, and no station by default', () => {
		const body = text(render(FlowGenerationUnits, { props: { value: null, nodes, stations } }).body);
		expect(rows(body)).toBe(2);
		expect(body).toContain('0 of 2 units with land have a rainfall station.');
		expect(body).toContain('aria-label="Station for Upper unit"');
		expect(body).toContain('No station: as before stations');
		expect(body).toMatch(/<option value="s1"[^>]*>Ridge<\/option>/);
		// Satellite rain is a gap fill only, never a unit's station (operator, 2026-10-23).
		expect(body).not.toMatch(/<option[^>]*>[^<]*(CHIRPS|satellite)[^<]*<\/option>/i);
		expect(body).toContain('MAP: 900 mm (grid)');
		expect(body).toContain('MAP: No MAP');
		expect(body).not.toContain('data-testid="flowgen-stations"');
		// Tick-several is there for an editor.
		expect(body).toContain('Assign to the ticked units');
	});

	it('shows an assigned unit’s ratio and correcting station, and each station in use once with its MAP', () => {
		const value = { units: { a: { stationId: 's1' }, b: { stationId: 's1', correctAgainst: 's2' } } };
		const body = text(render(FlowGenerationUnits, { props: { value, nodes, stations } }).body);
		expect(body).toContain('2 of 2 units with land have a rainfall station.');
		expect(body).toContain('× 1.5');
		expect(body).toContain('× 1: the unit has no MAP');
		expect(body).toContain('aria-label="Station correcting Upper unit’s CHIRPS"');
		expect(body).toContain('Its station (Ridge)');
		// Ridge is listed once though two units run on it; Vlei corrects one.
		expect(body.match(/data-testid="flowgen-station"/g)).toHaveLength(2);
		expect(body).toContain('600 mm (ridge record)');
		expect(body).toContain('Runs Upper unit and Lower unit.');
		// Ridge has no place: it asks for the unit it stands in; Vlei reads its own.
		expect(body).toContain('Stands in');
		expect(body).toContain('Its CHIRPS is read at its own place');
	});

	it('names a station the project no longer has instead of picking another', () => {
		const body = text(render(FlowGenerationUnits, { props: { value: { units: { a: { stationId: 'gone' } } }, nodes, stations } }).body);
		expect(body).toContain('A station the project no longer has');
		expect(body).toContain('data-testid="flowgen-missing"');
	});

	it('says how to add a station when the project has none', () => {
		const body = text(render(FlowGenerationUnits, { props: { value: null, nodes, stations: [] } }).body);
		expect(body).toContain('data-testid="flowgen-no-stations"');
		expect(body).not.toContain('Assign to the ticked units');
	});

	it('for a viewer, disables the fields and has no select-several action', () => {
		const body = text(render(FlowGenerationUnits, { props: { value: { units: { a: { stationId: 's1' } } }, nodes, stations, readonly: true } }).body);
		expect(body).toMatch(/aria-label="Station for Upper unit"[^>]*disabled|disabled[^>]*aria-label="Station for Upper unit"/);
		expect(body).not.toContain('Assign to the ticked units');
		expect(body).not.toContain('Tick every unit');
		expect(body).toContain('See it in Series details');
	});
});
