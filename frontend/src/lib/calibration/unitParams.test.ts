// Parameters from (issue #659 option 2): each land unit's choice, its options, what it runs on by the engine's rule,
// and the fit plan's live refusal (a borrowing cycle, a location left with no unit draining through it).
import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, newCalibrationZone, type NetworkNode, type ProjectSettings } from '@water-management/engine';
import { locationChoices, unitParamsLine, unitParamsPlanError, unitParamsRows, withUnitParamsFrom } from './unitParams';

const node = (id: string, name: string, kind: NetworkNode['kind'], downstreamNodeId: string | null, areaKm2 = 0) => ({ id, name, kind, downstreamNodeId, areaKm2 }) as NetworkNode;
/** The weir H (Farm A) and the kloof K (Farm C) drain to the outlet G, as Farm B does; P is a pump with no land. */
const nodes = [
	node('G', 'Outflow gauge', 'gauge', null),
	node('H', 'Weir', 'gauge', 'G'),
	node('K', 'Kloof', 'gauge', 'G'),
	node('A', 'Farm A', 'farm', 'H', 40),
	node('C', 'Farm C', 'farm', 'K', 10),
	node('B', 'Farm B', 'farm', 'G', 60),
	node('P', 'Pump', 'farm', 'G', 0)
];
const settings = (over: Partial<ProjectSettings> = {}): ProjectSettings => ({
	...defaultProjectSettings(),
	calibrateAtOutlet: true,
	calibrationRest: 'nearest',
	calibrationZones: [{ ...newCalibrationZone('H'), enabled: true }, { ...newCalibrationZone('K'), enabled: true }],
	...over
});
const view = (rows: ReturnType<typeof unitParamsRows>) => rows.map((r) => [r.name, r.value, r.options.map((o) => o.label), r.runsOn, r.stale]);

describe('unitParamsRows', () => {
	it('lists every land unit with its own zone first and every other ticked location, and what it runs on', () => {
		expect(locationChoices(nodes, settings())).toEqual([
			{ nodeId: 'K', label: 'Kloof' },
			{ nodeId: 'H', label: 'Weir' },
			{ nodeId: 'G', label: 'Outflow gauge (outlet)' }
		]);
		expect(view(unitParamsRows(nodes, settings(), null))).toEqual([
			['Farm A', '', ['Its own zone (Weir)', 'Kloof', 'Outflow gauge (outlet)'], 'Weir (its own zone)', false],
			['Farm B', '', ['Its own zone (Outflow gauge)', 'Kloof', 'Weir'], 'Outflow gauge (its own zone)', false],
			['Farm C', '', ['Its own zone (Kloof)', 'Weir', 'Outflow gauge (outlet)'], 'Kloof (its own zone)', false]
		]);
	});

	it('says a borrowed unit runs on its donor’s, and treats its own location chosen by name as its own zone', () => {
		const rows = unitParamsRows(nodes, settings({ unitParamsFrom: { C: 'H', A: 'H' } }), { C: 'H', A: 'H' });
		// The borrowed unit first, then the rest by name.
		expect(view(rows).map((r) => [r[0], r[1], r[3]])).toEqual([
			['Farm C', 'H', 'Weir (borrowed)'],
			['Farm A', '', 'Weir (its own zone)'],
			['Farm B', '', 'Outflow gauge (its own zone)']
		]);
		expect(unitParamsLine(rows)).toBe('Farm C from Weir');
		expect(unitParamsLine(unitParamsRows(nodes, settings(), null))).toBe('No unit borrows another location’s parameters');
		const four = [...nodes, node('D', 'Farm D', 'farm', 'G', 3), node('E', 'Farm E', 'farm', 'G', 3)];
		expect(unitParamsLine(unitParamsRows(four, settings(), { A: 'K', B: 'H', D: 'H', E: 'K' }))).toBe('4 units borrow another location’s parameters');
	});

	it('offers the rule for units outside every location to a unit with no location downstream', () => {
		// The outlet not ticked: Farm B is below every ticked gauge.
		const nearest = unitParamsRows(nodes, settings({ calibrateAtOutlet: false }), null).find((r) => r.name === 'Farm B')!;
		// The rule's location is offered by name too: choosing it pins the unit there whatever the rule becomes.
		expect([nearest.options.map((o) => o.label), nearest.runsOn]).toEqual([['Nearest upstream (Kloof)', 'Kloof', 'Weir'], 'Kloof (nearest upstream)']);
		const pinned = unitParamsRows(nodes, settings({ calibrateAtOutlet: false }), { B: 'K' }).find((r) => r.name === 'Farm B')!;
		expect([pinned.value, pinned.runsOn]).toEqual(['K', 'Kloof (borrowed)']);
		const plain = unitParamsRows(nodes, settings({ calibrateAtOutlet: false, calibrationRest: 'default' }), null).find((r) => r.name === 'Farm B')!;
		expect([plain.options[0]!.label, plain.runsOn]).toEqual(['The catchment parameters (no location)', 'The catchment parameters']);
	});

	it('keeps a choice of a location no longer ticked, marked, and says the unit takes its own zone’s', () => {
		const s = settings({ calibrationZones: [{ ...newCalibrationZone('H'), enabled: true }, { ...newCalibrationZone('K'), enabled: false }] });
		const c = unitParamsRows(nodes, s, { A: 'K' }).find((r) => r.name === 'Farm A')!;
		expect([c.value, c.stale, c.options.at(-1)!.label, c.runsOn]).toEqual(['K', true, 'Kloof (not a ticked location)', 'Weir (its own zone)']);
	});

	it('is empty with no ticked location', () => {
		expect(unitParamsRows(nodes, settings({ calibrateAtOutlet: false, calibrationZones: [] }), null)).toEqual([]);
	});

	it('reads settings from before engine 1.110.0 as the run does (a legacy site at the weir)', () => {
		const legacy = { ...defaultProjectSettings(), calibrationSiteNodeId: 'H' };
		expect(locationChoices(nodes, legacy)).toEqual([{ nodeId: 'H', label: 'Weir' }]);
		// Every unit is the weir's: Farm A its own zone, the rest the headline's (the legacy rule).
		expect(unitParamsRows(nodes, legacy, null).map((r) => r.runsOn)).toEqual(['Weir (its own zone)', 'Weir (the headline’s)', 'Weir (the headline’s)']);
	});
});

describe('withUnitParamsFrom', () => {
	it('sets and clears one unit’s choice, null when none is left', () => {
		expect(withUnitParamsFrom(null, 'C', 'H')).toEqual({ C: 'H' });
		expect(withUnitParamsFrom({ C: 'H' }, 'A', 'K')).toEqual({ C: 'H', A: 'K' });
		expect(withUnitParamsFrom({ C: 'H' }, 'C', null)).toBeNull();
		expect(withUnitParamsFrom({ C: 'H', A: 'K' }, 'C', '')).toEqual({ A: 'K' });
	});
});

describe('unitParamsPlanError', () => {
	// A second unit above the weir and above the kloof, so borrowing one away leaves each location a unit of its own.
	const more = [...nodes, node('A2', 'Farm A2', 'farm', 'H', 5), node('C2', 'Farm C2', 'farm', 'K', 5)];

	it('is null when the fit can run, and when no location is ticked', () => {
		expect(unitParamsPlanError(more, settings(), { C: 'H' })).toBeNull();
		expect(unitParamsPlanError(nodes, settings({ calibrateAtOutlet: false, calibrationZones: [] }), null)).toBeNull();
	});

	it('names both gauges of a borrowing cycle', () => {
		// Farm A (above the weir) borrows the kloof's and Farm C (above the kloof) the weir's: each needs the other fitted first.
		const e = unitParamsPlanError(more, settings(), { A: 'K', C: 'H' });
		expect(e).toMatch(/^Fit automatically can’t run: the units above "(Weir|Kloof)" borrow "(Kloof|Weir)"'s parameters/);
		expect(e).toContain('change one unit\'s Parameters from');
	});

	it('refuses a location every unit of whose zone is borrowed away', () => {
		expect(unitParamsPlanError(nodes, settings(), { C: 'H' })).toMatch(/^Fit automatically can’t run: the calibration location "Kloof" has no land unit in its group/);
	});
});
