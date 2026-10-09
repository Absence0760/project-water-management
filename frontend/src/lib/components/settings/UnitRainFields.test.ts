// Settings → Flow generation → Rain for each unit (UnitRainFields.svelte,
// issue #482), rendered with Svelte's server renderer: off shows the switch
// alone; on shows the coverage, the gauge MAP, its source once set, and the
// MAP period; a problem sits under its field, named by aria-describedby. The
// browser flow is pinned by e2e/tests/unit-rain.spec.ts.
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import UnitRainFields from './UnitRainFields.svelte';

vi.mock('$app/paths', () => ({ base: '' }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/') } }));
// FieldHistoryLine reads the field's history through the app's API client.
vi.mock('$env/static/public', () => ({ PUBLIC_API_URL: 'http://localhost:3001' }));

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
	});

	it('on, says how many units have a MAP and shows the gauge MAP and the default period', () => {
		const { body } = render(UnitRainFields, { props: { value: { mode: 'perUnit' }, nodes } });
		expect(body).toMatch(/<input type="checkbox"[^>]*checked/);
		expect(body).toContain('1 of 2 units with land has a MAP.');
		// The one without is named, linked to its form.
		expect(body).toMatch(/Without a MAP:.*<a href="\?tab=network&amp;edit=b">Lower unit<\/a>/s);
		expect(body).toContain('Rain gauge’s MAP');
		expect(body).not.toContain('Source of the gauge’s MAP');
		expect(body).toContain('MAP period');
		expect(body).toMatch(/value="1991"/);
		expect(body).toMatch(/value="2020"/);
	});

	it('asks for the gauge MAP’s source once the MAP is set, with the problem under it', () => {
		const { body } = render(UnitRainFields, { props: { value: { mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: '' }, nodes } });
		expect(body).toContain('Source of the gauge’s MAP');
		const err = body.match(/<span class="err[^"]*" id="([^"]+)"[^>]*>Say where the rain gauge’s MAP comes from/);
		expect(err).not.toBeNull();
		expect(body).toMatch(new RegExp(`aria-invalid="true"[^>]*aria-describedby="[^"]*${err![1]}"|aria-describedby="[^"]*${err![1]}"[^>]*aria-invalid="true"`));
	});

	it('notes a short period without an error, and shows a reversed one as the period’s problem', () => {
		const short = render(UnitRainFields, { props: { value: { mode: 'perUnit', mapPeriod: { start: '2010-01-01', end: '2012-12-31' } }, nodes } }).body;
		expect(short).toContain('data-testid="unit-rain-period-note"');
		expect(short).not.toContain('data-testid="unit-rain-error"');
		const reversed = render(UnitRainFields, { props: { value: { mode: 'perUnit', mapPeriod: { start: '2015-01-01', end: '2001-12-31' } }, nodes } }).body;
		expect(reversed).toContain('The MAP period’s first year must not be after its last.');
	});

	it('for a viewer, the switch is disabled and the source is read-only, still focusable', () => {
		const { body } = render(UnitRainFields, { props: { value: { mode: 'perUnit', gaugeMapMm: 640, gaugeMapSource: 'gauge record' }, nodes, readonly: true } });
		expect(body).toMatch(/<input type="checkbox"[^>]*disabled/);
		expect(body).toMatch(/<input[^>]*id="[^"]*-gsrc"[^>]*readonly/);
	});
});
