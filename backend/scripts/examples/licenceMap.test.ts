// The licence comparison map example (licenceMap.ts, issue #510) as the seed
// builds it: a valid project, a map with an area for every unit but one, and
// registered volumes that put each unit in its band of the Allocations tab's
// map, read the way the backend reads a stored run (allocations/runUse.ts).
import { compareAllocations, runModelChecked, useBand, type AllocationComparison, type AllocationUseNode, type ModelOutput } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkGeometry } from '../../src/geo/geojson.js';
import { modelProblems } from '../../src/model/validate.js';
import { ProjectFile } from '../../src/projects/document.js';
import { inputOf, type ExampleProject } from './catchments.js';
import { buildLicenceMap, GROUNDWATER_M3, GROUNDWATER_UNIT, IDLE_UNIT, LICENCE_MAP_NAME, LICENCE_UNITS, licenceAllocations, licenceMapFeatures } from './licenceMap.js';

let ex: ExampleProject;
let out: ModelOutput;
let useNodes: AllocationUseNode[];
beforeAll(() => {
	ex = buildLicenceMap();
	out = runModelChecked(inputOf(ex));
	// As runUseNodes reads a stored run: each unit's supplied, groundwater and river series.
	const get = (nodeId: string, key: string) => out.series.find((s) => s.nodeId === nodeId && s.key === key)?.values ?? null;
	useNodes = ex.model.nodes
		.filter((n) => n.kind === 'farm' || n.kind === 'user')
		.filter((n) => get(n.id, 'supplied'))
		.map((n) => ({
			nodeId: n.id,
			name: n.name,
			kind: n.kind as 'farm' | 'user',
			supplied: get(n.id, 'supplied')!,
			groundwater: get(n.id, 'groundwater_used'),
			groundwaterToDam: get(n.id, 'groundwater_to_dam'),
			riverAbstraction: get(n.id, 'river_abstraction'),
			riverTakes: out.series.filter((s) => s.nodeId === n.id && (s.key === 'offtake_used' || s.key.startsWith('river_take@'))).map((s) => s.values),
			damCapacityM3: n.damCapacityM3
		}));
});

const compare = (allocations: ReturnType<typeof licenceAllocations>): AllocationComparison =>
	compareAllocations({
		startDate: ex.series.find((s) => s.kind === 'rain_catchment_mm')!.startDate,
		nodes: useNodes,
		allocations: allocations.map((a, i) => ({ id: String(i), nodeId: a.nodeId, waterSource: a.waterSource, volumeM3PerYear: a.volumeM3PerYear }))
	});

describe('the licence comparison map example', () => {
	it('parses as a project document with no model problems, and runs with every self-check passing', () => {
		const parsed = ProjectFile.safeParse(ex);
		expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
		expect(modelProblems(ex.model)).toEqual([]);
		expect(ex.name).toBe(LICENCE_MAP_NAME);
		expect(out.summary.verification?.passed, JSON.stringify(out.summary.verification?.checks.filter((c) => !c.passed))).toBe(true);
	});

	it('has about eight units, every one in the comparison (the idle one too)', () => {
		expect(LICENCE_UNITS).toHaveLength(8);
		expect(useNodes.map((n) => n.name).sort()).toEqual(LICENCE_UNITS.map((u) => u.name).sort());
	});

	it('draws an area for every unit but one, each linked to its unit and passing the import’s checks', () => {
		const features = licenceMapFeatures(ex.model);
		for (const f of features) expect(checkGeometry(f.geometry), f.name).not.toHaveProperty('problem');
		const parcels = features.filter((f) => f.kind === 'farm_parcel').map((f) => f.node);
		expect(parcels.sort()).toEqual(LICENCE_UNITS.filter((u) => u.polygon).map((u) => u.name).sort());
		expect(LICENCE_UNITS.filter((u) => !u.polygon)).toHaveLength(1);
	});

	it('registers volumes that put each unit in its band of the map, whatever the engine’s numbers', () => {
		const allocations = licenceAllocations(compare([]));
		expect(allocations.every((a) => a.holder.endsWith('(invented)'))).toBe(true);
		const c = compare(allocations);
		const bandOf = (name: string, source: 'surface' | 'groundwater' = 'surface') => {
			const side = c.nodes.find((n) => n.name === name)![source];
			return useBand(side.meanModelledM3PerYear ?? 0, side.meanRegisteredM3PerYear ?? 0);
		};
		expect(Object.fromEntries(LICENCE_UNITS.map((u) => [u.name, bandOf(u.name)]))).toEqual({
			Groenkloof: 'under',
			Oranjedraai: 'near',
			Randhoek: 'near',
			Rooiheuwel: 'over',
			Brandvlei: 'far',
			Grysvlakte: 'unregistered',
			Stilwater: 'none',
			Sonderkaart: 'under'
		});
		// The r = 1 unit sits on the edge, not just inside it.
		const edge = c.nodes.find((n) => n.name === 'Randhoek')!.surface;
		expect((edge.meanModelledM3PerYear ?? 0) / (edge.meanRegisteredM3PerYear ?? 1)).toBeCloseTo(1, 9);
		// One groundwater registration, so the source toggle has something to show; the unit has no borehole.
		const gw = allocations.filter((a) => a.waterSource === 'groundwater');
		expect(gw.map((a) => [useNodes.find((n) => n.nodeId === a.nodeId)!.name, a.volumeM3PerYear])).toEqual([[GROUNDWATER_UNIT, GROUNDWATER_M3]]);
		expect(bandOf(GROUNDWATER_UNIT, 'groundwater')).toBe('under');
		expect(c.nodes.find((n) => n.name === IDLE_UNIT)!.surface.meanModelledM3PerYear).toBe(0);
	});

	it('refuses to seed when a unit meant to use water uses none', () => {
		const c = compare([]);
		const broken = { nodes: c.nodes.map((n) => (n.name === 'Brandvlei' ? { ...n, surface: { ...n.surface, meanModelledM3PerYear: 0 } } : n)) };
		expect(() => licenceAllocations(broken)).toThrow(/Brandvlei modelled no surface use/);
	});
});
