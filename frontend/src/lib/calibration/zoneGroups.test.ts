// Calibration zones as the Network and the Map colour them (issue #555 round 4): the engine's own rule, upstream first,
// the site's zone last, each with a palette colour; null when no zone applies.
import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, newCalibrationZone, type NetworkNode, type ProjectSettings } from '@water-management/engine';
import { unitCount, zoneByUnit, zoneGroups, zoneName, ZONE_TOKENS } from './zoneGroups';

const node = (id: string, name: string, kind: NetworkNode['kind'], downstreamNodeId: string | null, areaKm2 = 0) => ({ id, name, kind, downstreamNodeId, areaKm2 }) as NetworkNode;
/** A drains to the weir H, H and B to the outlet G; U is a farm with no land area. */
const zoneNodes = [node('G', 'Outlet', 'gauge', null), node('H', 'Weir', 'gauge', 'G'), node('A', 'Farm A', 'farm', 'H', 40), node('B', 'Farm B', 'farm', 'G', 60), node('U', 'Pump', 'farm', 'G', 0)];
const settings = (over: Partial<ProjectSettings> = {}): ProjectSettings => ({
	...defaultProjectSettings(),
	unitRain: { mode: 'perUnit' } as never,
	calibrationZones: [{ ...newCalibrationZone('H'), enabled: true, gr4j: { x1: 900, x2: 0, x3: 220, x4: 3.1 } }],
	...over
});

describe('zoneGroups', () => {
	it('groups the land units by zone, upstream first, the site’s zone last, each in its own colour', () => {
		const g = zoneGroups(zoneNodes, settings())!;
		expect(g.map((x) => [x.nodeId, x.name, x.units, x.fitted, x.token])).toEqual([
			['H', 'Weir', ['A'], true, ZONE_TOKENS[0]],
			[null, 'Outlet', ['B'], true, ZONE_TOKENS[1]]
		]);
		expect([...zoneByUnit(g).entries()].map(([u, z]) => [u, z.nodeId])).toEqual([
			['A', 'H'],
			['B', null]
		]);
	});

	it('is null with no ticked gauge, or when the only ticked gauge is unusable', () => {
		expect(zoneGroups(zoneNodes, null)).toBeNull();
		expect(zoneGroups(zoneNodes, settings({ calibrationZones: [] }))).toBeNull();
		expect(zoneGroups(zoneNodes, settings({ calibrationZones: [{ ...newCalibrationZone('H'), enabled: false }] }))).toBeNull();
		// A project still holding Fragmentation's retired `catchment` runs Per unit (issue #658): its zones apply.
		expect(zoneGroups(zoneNodes, settings({ unitRain: { mode: 'catchment' } }))).not.toBeNull();
		// Since engine 1.110.0 (issue #659) the site's own gauge is a calibration location, the headline: its units are a group.
		expect(zoneGroups(zoneNodes, settings({ calibrationSiteNodeId: 'H' }))).not.toBeNull();
	});

	it('names a zone, the site’s and one not fitted yet', () => {
		expect(zoneName({ nodeId: 'H', name: 'Weir', fitted: true })).toBe('Weir zone');
		expect(zoneName({ nodeId: 'H', name: 'Weir', fitted: false })).toBe('Weir zone, not fitted yet');
		expect(zoneName({ nodeId: null, name: 'Outlet', fitted: true })).toBe('Outlet zone (calibration site)');
		expect(unitCount(1)).toBe('1 unit');
		expect(unitCount(3)).toBe('3 units');
	});
});
