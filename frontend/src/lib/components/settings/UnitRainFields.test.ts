// Settings → Flow calibration → Rain into GR4J → Rain for each unit (UnitRainFields.svelte,
// issue #482), rendered with Svelte's server renderer: off shows the switch
// alone; on shows the coverage, the gauge MAP read from the catchment rain
// station (issue #553) with a link to edit it, and the MAP period; a problem sits under its field, named by aria-describedby. The
// browser flow is pinned by e2e/tests/unit-rain.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import UnitRainFields from './UnitRainFields.svelte';

vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p}`, asset: (f: string) => `/${f}` }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/') } }));
// FieldHistoryLine reads the field's history through the app's API client.
vi.mock('$app/env/public', () => ({ PUBLIC_API_URL: 'http://localhost:3001' }));

/** The markup without Svelte's hydration comments, stripped until none are left, so one split by another can't survive as a fresh '<!--' (CodeQL js/incomplete-multi-character-sanitization). */
const text = (body: string) => {
	let s = body;
	for (let prev = ''; prev !== s; ) {
		prev = s;
		s = s.replace(/<!--[\s\S]*?-->/g, '');
	}
	return s;
};

const nodes = [
	{ id: 'a', name: 'Upper unit', kind: 'farm' as const, areaKm2: 10, mapMm: 700 },
	{ id: 'b', name: 'Lower unit', kind: 'farm' as const, areaKm2: 5, mapMm: null }
];

describe('UnitRainFields', () => {
	it('shows only the switch while off', () => {
		const { body } = render(UnitRainFields, { props: { value: null, nodes } });
		expect(body).toContain('Runoff from each unit’s own rain');
		expect(body).not.toContain('checked');
		expect(body).not.toContain('MAP period');
		expect(body).not.toContain('Rain gauge’s MAP');
		expect(body).toContain('id="set-unit-rain"');
	});

	it('on, says how many units have a MAP and shows the gauge MAP and the default period', () => {
		const { body } = render(UnitRainFields, { props: { value: { mode: 'perUnit' }, nodes } });
		expect(body).toMatch(/<input type="checkbox"[^>]*checked/);
		expect(body).toContain('1 of 2 units with land has a MAP.');
		// The one without is named, linked to its form's Catchment area card (section=area).
		expect(body).toMatch(/Without a MAP:.*<a href="\?tab=network&amp;edit=b&amp;section=area">Lower unit<\/a>/s);
		expect(body).toContain('Rain gauge’s MAP');
		// A read-out now, not a field: the station's MAP is edited in Series details (issue #553).
		expect(body).not.toMatch(/id="[^"]*-gmap"/);
		expect(body).not.toContain('Source of the gauge’s MAP');
		expect(body).toContain('MAP period');
		expect(body).toMatch(/value="1991"/);
		expect(body).toMatch(/value="2020"/);
	});

	it('reads the gauge MAP from the catchment rain station, with a link to change it in Series details', () => {
		const catchmentRain = { id: 'r1', name: 'Gauge A', station: { mapMm: 745, mapSource: 'station record 1991–2020', lat: null, lon: null } };
		const body = text(render(UnitRainFields, { props: { value: { mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: 'old' }, nodes, catchmentRain } }).body);
		expect(body).toMatch(/data-from="station"[^>]*>\s*<strong>745 mm<\/strong> \(station record 1991–2020\), the station MAP of “Gauge A”/);
		expect(body).toMatch(/<a href="\?tab=series&amp;series=r1#data-chart"[^>]*>Change it in Series details<\/a>/);
	});

	it('still shows an older project’s settings gauge MAP while the station has none, and says where to set it', () => {
		const catchmentRain = { id: 'r1', name: 'Gauge A', station: null };
		const body = text(render(UnitRainFields, { props: { value: { mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: 'gauge record' }, nodes, catchmentRain } }).body);
		expect(body).toMatch(/data-from="settings"[^>]*>\s*<strong>640 mm<\/strong> \(gauge record\), kept from these settings/);
		expect(body).toContain('>Set it in Series details</a>');
		const none = render(UnitRainFields, { props: { value: { mode: 'perUnit' }, nodes, catchmentRain: null } }).body;
		expect(none).toContain('the project has no catchment rain series yet');
		expect(none).not.toContain('unit-rain-gauge-map-edit');
	});

	it('notes a short period without an error, and shows a reversed one as the period’s problem', () => {
		const short = render(UnitRainFields, { props: { value: { mode: 'perUnit', mapPeriod: { start: '2010-01-01', end: '2012-12-31' } }, nodes } }).body;
		expect(short).toContain('data-testid="unit-rain-period-note"');
		expect(short).not.toContain('data-testid="unit-rain-error"');
		const reversed = render(UnitRainFields, { props: { value: { mode: 'perUnit', mapPeriod: { start: '2015-01-01', end: '2001-12-31' } }, nodes } }).body;
		expect(reversed).toContain('The MAP period’s first year must not be after its last.');
	});

	it('offers the reference gauge (none by default), and once one is set the reference unit, with the problem under it until one is picked', () => {
		const none = render(UnitRainFields, { props: { value: { mode: 'perUnit' }, nodes } }).body;
		expect(none).toContain('Reference gauge');
		expect(none).toContain('<option value="rain_catchment_mm@a">Upper unit’s own gauge</option>');
		expect(none).not.toContain('Reference unit');
		const unpicked = render(UnitRainFields, { props: { value: { mode: 'perUnit', reference: { gauge: 'rain_catchment_mm', unitId: '' } }, nodes } }).body;
		expect(unpicked).toContain('Reference unit');
		expect(unpicked).toMatch(/data-testid="unit-rain-error">Pick the reference unit/);
		const picked = render(UnitRainFields, { props: { value: { mode: 'perUnit', reference: { gauge: 'rain_catchment_mm', unitId: 'a' } }, nodes } }).body;
		expect(picked).not.toContain('data-testid="unit-rain-error"');
		expect(picked).not.toContain('unit-rain-reference-gone');
		const gone = render(UnitRainFields, { props: { value: { mode: 'perUnit', reference: { gauge: 'rain_catchment_mm', unitId: 'removed' } }, nodes } }).body;
		expect(gone).toContain('data-testid="unit-rain-reference-gone"');
	});

	it('for a viewer, the switch is disabled and the gauge MAP’s link only shows it', () => {
		const catchmentRain = { id: 'r1', name: 'Gauge A', station: { mapMm: 745, mapSource: 'station record', lat: null, lon: null } };
		const { body } = render(UnitRainFields, { props: { value: { mode: 'perUnit' }, nodes, catchmentRain, readonly: true } });
		expect(body).toMatch(/<input type="checkbox"[^>]*disabled/);
		expect(body).toContain('>See it in Series details</a>');
	});
});
