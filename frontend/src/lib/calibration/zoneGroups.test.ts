// Calibration locations' groups as the Network and the Map colour them (issue #555 round 4; issue #659): the engine's
// own rule (resolveLocations), upstream first, the headline last, the catchment-parameter units after; borrowed and
// rest units marked; null when every unit runs on one parameter set.
import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, newCalibrationZone, type NetworkNode, type ProjectSettings } from '@water-management/engine';
import { keyEntryText, unitCount, unitPlacement, unitZoneText, zoneByUnit, zoneGroups, zoneKeyEntries, zoneName, ZONE_TOKENS, type ZoneGroup } from './zoneGroups';

const node = (id: string, name: string, kind: NetworkNode['kind'], downstreamNodeId: string | null, areaKm2 = 0) => ({ id, name, kind, downstreamNodeId, areaKm2 }) as NetworkNode;
/** A drains to the weir H, H and B to the outlet G; U is a farm with no land area. */
const zoneNodes = [node('G', 'Outlet', 'gauge', null), node('H', 'Weir', 'gauge', 'G'), node('A', 'Farm A', 'farm', 'H', 40), node('B', 'Farm B', 'farm', 'G', 60), node('U', 'Pump', 'farm', 'G', 0)];
const settings = (over: Partial<ProjectSettings> = {}): ProjectSettings => ({
	...defaultProjectSettings(),
	unitRain: { mode: 'perUnit' } as never,
	calibrationZones: [{ ...newCalibrationZone('H'), enabled: true, gr4j: { x1: 900, x2: 0, x3: 220, x4: 3.1 } }],
	...over
});
const view = (g: ZoneGroup[] | null) => g?.map((x) => [x.key, x.nodeId, x.kind, x.name, x.headline, x.units, x.borrowed, x.rest, x.fitted, x.token]);

describe('zoneGroups', () => {
	it('groups a legacy project’s units by location, upstream first, the site (the headline) last, each in its own colour', () => {
		const g = zoneGroups(zoneNodes, settings())!;
		expect(view(g)).toEqual([
			['H', 'H', 'gauge', 'Weir', false, ['A'], [], [], true, ZONE_TOKENS[0]],
			['G', 'G', 'outlet', 'Outlet', true, ['B'], [], [], true, ZONE_TOKENS[1]]
		]);
		expect([...zoneByUnit(g).entries()].map(([u, z]) => [u, z.key])).toEqual([
			['A', 'H'],
			['B', 'G']
		]);
	});

	// The weir H (Farm A, 40 km²) and the kloof K (Farm C and Farm E, 15 km²) both drain to the outlet G, as Farm B does.
	const branched = [...zoneNodes, node('K', 'Kloof', 'gauge', 'G'), node('C', 'Farm C', 'farm', 'K', 10), node('E', 'Farm E', 'farm', 'K', 5)];
	const both = (over: Partial<ProjectSettings>) =>
		settings({ calibrateAtOutlet: false, calibrationZones: [{ ...newCalibrationZone('H'), enabled: true, gr4j: { x1: 900, x2: 0, x3: 220, x4: 3.1 } }, { ...newCalibrationZone('K'), enabled: true }], ...over });

	it('marks a unit borrowed by Parameters from with its donor, and a rest unit with the rule that placed it (issue #659)', () => {
		// E borrows the weir's; B, below every ticked gauge, takes the nearest upstream (a tie at the outlet: Kloof by name).
		// The headline is the weir, by the larger area above it, so it is last.
		const g = zoneGroups(branched, both({ calibrationRest: 'nearest', unitParamsFrom: { E: 'H' } }))!;
		expect(g.map((x) => [x.key, x.headline, x.units, x.borrowed, x.rest])).toEqual([
			['K', false, ['B', 'C'], [], ['B']],
			['H', true, ['A', 'E'], ['E'], []]
		]);
		const [k, h] = g as [ZoneGroup, ZoneGroup];
		// The headline rule's count words say what the units were given.
		expect(zoneKeyEntries(zoneGroups(branched, both({ calibrationRest: 'headline', unitParamsFrom: { E: 'H' } }))!).map(keyEntryText)).toContain('Weir zone (headline): 2 units, 1 given the headline’s parameters');
		expect([unitPlacement(h, 'E'), unitPlacement(k, 'B'), unitPlacement(k, 'C')]).toEqual(['borrowed', 'rest', 'zone']);
		expect(unitZoneText(h, 'E')).toBe('borrowed from Weir');
		expect(unitZoneText(k, 'B')).toBe('nearest upstream: Kloof, not fitted yet');
		expect(unitZoneText(k, 'C')).toBe('Kloof zone, not fitted yet');
		expect(zoneKeyEntries(g).map(keyEntryText)).toEqual(['Kloof zone, not fitted yet: 2 units, 1 placed by nearest upstream', 'Weir zone (headline): 1 unit', 'Borrowed from Weir: 1 unit']);
		expect(zoneKeyEntries(g).map((e) => e.marker)).toEqual([false, false, true]);
		// A location whose every unit is borrowed away has no group to colour (the fit refuses it): here one group is left.
		expect(zoneGroups(branched, both({ calibrationRest: 'nearest', unitParamsFrom: { C: 'H', E: 'H', B: 'H' } }))).toBeNull();
	});

	it('puts the units outside every location on the catchment parameters last, under the rule ‘default’', () => {
		const g = zoneGroups(branched, both({ calibrationRest: 'default' }))!;
		expect(g.map((x) => [x.key, x.units])).toEqual([
			['K', ['C', 'E']],
			['H', ['A']],
			['default', ['B']]
		]);
		const d = g[2]!;
		expect([d.nodeId, d.kind, d.token, zoneName(d), unitZoneText(d, 'B')]).toEqual([null, 'default', ZONE_TOKENS[2], 'Catchment parameters (no location)', 'Catchment parameters (no location)']);
	});

	it('is null with no ticked gauge, when the only ticked gauge is unusable, or with one group', () => {
		expect(zoneGroups(zoneNodes, null)).toBeNull();
		expect(zoneGroups(zoneNodes, settings({ calibrationZones: [] }))).toBeNull();
		expect(zoneGroups(zoneNodes, settings({ calibrationZones: [{ ...newCalibrationZone('H'), enabled: false }] }))).toBeNull();
		// A project still holding Fragmentation's retired `catchment` runs Per unit (issue #658): its zones apply.
		expect(zoneGroups(zoneNodes, settings({ unitRain: { mode: 'catchment' } }))).not.toBeNull();
		// A legacy site at the weir with no other zone: the weir is the only location, every unit its group's.
		expect(zoneGroups(zoneNodes, settings({ calibrationSiteNodeId: 'H', calibrationZones: [] }))).toBeNull();
	});

	it('names a group, the outlet’s, the headline’s and one not fitted yet', () => {
		const g = { kind: 'gauge', name: 'Weir', headline: false, fitted: true } as const;
		expect(zoneName(g)).toBe('Weir zone');
		expect(zoneName({ ...g, fitted: false })).toBe('Weir zone, not fitted yet');
		expect(zoneName({ ...g, kind: 'outlet', name: 'Outlet', headline: true })).toBe('Outlet zone (outlet, headline)');
		expect(unitCount(1)).toBe('1 unit');
		expect(unitCount(3)).toBe('3 units');
	});
});
