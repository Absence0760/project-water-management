// get_network (issue #610): fields picked by name, so nothing personal or
// registered reaches the model, and each gauge lists what is above it.
import { describe, expect, it } from 'vitest';
import type { ProjectModel } from '@water-management/engine';
import { node } from '../../__tests__/helpers.js';
import { networkView } from './network.js';

const outlet = node('Outlet', null);
const weir = { ...node('Middle weir', outlet.id), kind: 'gauge', damCapacityM3: 0 };
const upper = node('Upper', weir.id, { damCapacityM3: 50_000 });
const dry = node('Dry', weir.id, { damCapacityM3: 0 });
const lower = node('Lower', outlet.id);
const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: [] };

const model = {
	nodes: [outlet, weir, upper, dry, lower].map((n) => ({ ...n, contactEmail: 'someone@example.com' })),
	crops: [crop],
	cropAreas: [{ nodeId: upper.id, cropId: crop.id, areaM2: 250_000 }],
	transfers: [{ id: 't', fromNodeId: upper.id, toNodeId: null, months: [1, 2], maxRateM3s: 0.1, dailyCapM3: null, minStoragePct: 0.2, enabled: true, priority: 0 }],
	boreholes: [{ id: 'b', nodeId: lower.id, name: 'BH-17 on the Smit property' }],
	demandObjects: [{ id: 'd', nodeId: lower.id, name: 'J. Smit household' }],
	allocations: [{ nodeId: upper.id, volumeM3PerYear: 123_456 }]
} as unknown as ProjectModel;

describe('networkView', () => {
	const view = networkView(model);
	const json = JSON.stringify(view);

	it('sends no registered volume, label of a borehole or demand, or field it doesn’t pick', () => {
		for (const leak of ['123456', 'Smit', 'example.com', 'contactEmail', 'allocations', 'sortOrder']) expect(json).not.toContain(leak);
	});

	it('gives each node its kind, where it drains, its dam and crop hectares; boreholes and other demands counted', () => {
		const by = Object.fromEntries(view.nodes.map((n) => [n.name, n]));
		expect(by.Outlet).toMatchObject({ kind: 'gauge', outlet: true });
		expect(by.Upper).toMatchObject({ kind: 'farm', drainsInto: weir.id, dam: { capacityM3: 50_000, pctRunoffToDam: 0.5 }, cropHa: { Citrus: 25 } });
		expect(by.Dry!.dam).toBeNull();
		expect(by.Lower).toMatchObject({ boreholes: 1, otherDemands: 1 });
		expect(view.transfers).toEqual([{ from: 'Upper', to: 'outside the catchment', months: [1, 2], maxRateM3s: 0.1, dailyCapM3: null, minStoragePct: 0.2, enabled: true }]);
	});

	it('lists the units, dams and gauges above each gauge', () => {
		const by = Object.fromEntries(view.nodes.map((n) => [n.name, n]));
		expect(by['Middle weir']!.above).toEqual({ units: 2, areaKm2: 30, dams: [{ id: upper.id, name: 'Upper', capacityM3: 50_000 }], gauges: [] });
		expect(by.Outlet!.above).toMatchObject({ units: 3, gauges: [{ id: weir.id, name: 'Middle weir' }] });
		expect(by.Outlet!.above!.dams.map((d) => d.name).sort()).toEqual(['Lower', 'Upper']);
		expect(by.Upper!.above).toBeUndefined();
	});

	it('stays under the tool result cap for a 60-unit catchment', () => {
		const out = node('Out', null);
		const units = Array.from({ length: 60 }, (_, i) => node(`Unit ${i + 1}`, out.id));
		expect(JSON.stringify(networkView({ nodes: [out, ...units] } as unknown as ProjectModel)).length).toBeLessThan(40_000);
	});
});
