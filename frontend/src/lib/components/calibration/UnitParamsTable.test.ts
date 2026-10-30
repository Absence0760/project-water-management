// Parameters from (issue #659 option 2), rendered with Svelte's server renderer: a row per land unit with its select
// named for the unit, what it runs on, the fit's refusal in a live region, and nothing while no location is ticked.
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, newCalibrationZone, type NetworkNode, type ProjectSettings } from '@water-management/engine';
import UnitParamsTable from './UnitParamsTable.svelte';

const node = (id: string, name: string, kind: NetworkNode['kind'], downstreamNodeId: string | null, areaKm2 = 0) => ({ id, name, kind, downstreamNodeId, areaKm2 }) as NetworkNode;
const nodes = [node('G', 'Outflow gauge', 'gauge', null), node('H', 'Weir', 'gauge', 'G'), node('A', 'Upper farm', 'farm', 'H', 12), node('B', 'Lower farm', 'farm', 'G', 20)];
const settings = (over: Partial<ProjectSettings> = {}): ProjectSettings => ({
	...defaultProjectSettings(),
	calibrateAtOutlet: true,
	calibrationRest: 'nearest',
	calibrationZones: [{ ...newCalibrationZone('H'), enabled: true }],
	...over
});

describe('UnitParamsTable', () => {
	it('lists each land unit with a select named for it and what it runs on, folded while every unit takes its own zone’s', () => {
		const html = render(UnitParamsTable, { props: { assignments: null, nodes, settings: settings(), readonly: false } }).body;
		expect(html).toContain('<legend class="label">Parameters from</legend>');
		expect(html).toContain('aria-label="Parameters from: Lower farm"');
		expect(html).toContain('aria-label="Parameters from: Upper farm"');
		expect(html).toContain('Outflow gauge (its own zone)');
		expect(html).toContain('every unit takes its own zone’s');
		expect(html).not.toContain('data-testid="unit-params-error"');
	});

	it('shows the fit’s refusal when a choice leaves a location with no unit draining through it', () => {
		const html = render(UnitParamsTable, { props: { assignments: { A: 'G' }, nodes, settings: settings({ unitParamsFrom: { A: 'G' } }), readonly: false } }).body;
		expect(html).toMatch(/<div role="status">(<!--\[0-->)?<div class="alert alert-warning" data-testid="unit-params-error">Fit automatically can’t run: the calibration location "Weir" has no land unit/);
		expect(html).toContain('1 unit borrows another location’s parameters');
	});

	it('is nothing while no location is ticked', () => {
		const html = render(UnitParamsTable, { props: { assignments: null, nodes, settings: settings({ calibrateAtOutlet: false, calibrationZones: [] }), readonly: false } }).body;
		expect(html).not.toContain('unit-params');
	});
});
