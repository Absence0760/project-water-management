// A unit's area from an earlier outline of its polygon on the map (issue #646 F6, ./mapAreas.ts): the run warns,
// with its code, and computes nothing else differently. Synthetic values only (public repo).
import { describe, expect, it } from 'vitest';
import { mapAreaWarnings } from './mapAreas';
import type { ModelInput, NetworkNode } from './project';
import { runModel } from './run';
import { applyScenario } from './scenario';
import { sameOutput } from './testing/invariants';
import { withWarningScope } from './warningCodes';

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 1,
		pctUpstreamToDam: 0,
		pctRunoffToDam: 0,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

const model = { nodes: [node('A', { name: 'Upper', areaKm2: 12, downstreamNodeId: 'G' }), node('G', { name: 'Outflow', kind: 'gauge', areaKm2: 0 })], crops: [], cropAreas: [], transfers: [] };
const TEXT = '"Upper": its area is from an earlier outline of its polygon on the map: the run used 12.00 km², the outline is 14.10 km² now. Use the new area on the Map (Checks), or keep the old one.';

describe('mapAreaWarnings', () => {
	it('warns for a unit whose area is its earlier outline’s, with the code and its figures', () => {
		const { warnings, codes } = withWarningScope((scope) => {
			const w = mapAreaWarnings({ model, mapAreas: [{ nodeId: 'A', modelKm2: 12, outlineKm2: 14.1 }] });
			return { warnings: w, codes: scope.codesOf(w) };
		});
		expect(warnings).toEqual([TEXT]);
		expect(codes).toEqual([{ code: 'map.areaFromEarlierOutline', params: { unit: 'Upper', modelKm2: 12, mapKm2: 14.1 }, text: TEXT }]);
	});

	it('says nothing when the outline gives the same area, the run’s area isn’t the model’s (a scenario set it), or the unit is gone', () => {
		expect(mapAreaWarnings({ model, mapAreas: [{ nodeId: 'A', modelKm2: 12, outlineKm2: 12 }] })).toEqual([]);
		// A scenario set the area itself: it isn't the earlier outline's any more.
		expect(mapAreaWarnings({ model, mapAreas: [{ nodeId: 'A', modelKm2: 11, outlineKm2: 14.1 }] })).toEqual([]);
		expect(mapAreaWarnings({ model, mapAreas: [{ nodeId: 'gone', modelKm2: 12, outlineKm2: 14.1 }] })).toEqual([]);
		// Only a land unit has an area from the map.
		expect(mapAreaWarnings({ model, mapAreas: [{ nodeId: 'G', modelKm2: 0, outlineKm2: 3 }] })).toEqual([]);
		expect(mapAreaWarnings({ model })).toEqual([]);
		expect(mapAreaWarnings({ model, mapAreas: null })).toEqual([]);
	});

	it('ignores a malformed list or entry, never throwing (it only warns)', () => {
		expect(mapAreaWarnings({ model, mapAreas: 'x' as never })).toEqual([]);
		expect(mapAreaWarnings({ model, mapAreas: [null as never, { nodeId: 'A', modelKm2: '12', outlineKm2: 14 } as never, { nodeId: 'A', modelKm2: 12, outlineKm2: Number.NaN }] })).toEqual([]);
	});
});

describe('a run with mapAreas', () => {
	const DAYS = 366;
	const base: ModelInput = {
		settings: { apanMm: [150, 180, 220, 230, 190, 160, 110, 80, 60, 60, 80, 110], simulationStart: '2020-01-01', simulationEnd: '2020-12-31' },
		model,
		series: { rain_catchment_mm: { startDate: '2020-01-01', values: Array.from({ length: DAYS }, (_, i) => (i % 3 === 0 ? 0 : 2)) } }
	};
	const mapAreas = [{ nodeId: 'A', modelKm2: 12, outlineKm2: 14.1 }];

	it('adds the coded warning, and changes nothing else the run computes', () => {
		const plain = runModel(base);
		const told = runModel({ ...base, mapAreas });
		expect(plain.summary.warnings).not.toContain(TEXT);
		expect(told.summary.warnings).toContain(TEXT);
		expect(told.summary.warningCodes?.filter((c) => c.code === 'map.areaFromEarlierOutline')).toEqual([{ code: 'map.areaFromEarlierOutline', params: { unit: 'Upper', modelKm2: 12, mapKm2: 14.1 }, text: TEXT }]);
		const strip = (o: ReturnType<typeof runModel>) => ({
			...o,
			summary: { ...o.summary, warnings: o.summary.warnings.filter((w) => w !== TEXT), warningCodes: o.summary.warningCodes?.filter((c) => c.text !== TEXT) }
		});
		expect(sameOutput(strip(plain), strip(told))).toBe(true);
	});

	it('a scenario that sets the unit’s area runs without it', () => {
		const { input } = applyScenario({ ...base, mapAreas }, [{ op: 'node.set', nodeId: 'A', field: 'areaKm2', value: 14.1 } as never]);
		expect(runModel(input).summary.warnings).not.toContain(TEXT);
	});
});
