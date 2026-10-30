// Ids named in the tools' output (names.ts; issue #610, the 2026-10-30 production
// test): settings, warnings and network fields by name, keys too; the `id`
// fields kept as tool arguments; a node id that matches no node said plainly.
// Against Postgres and RLS: assistant-tools.db.test.ts.
import { describe, expect, it } from 'vitest';
import { GONE_NODE, nameIds, nodeWords, type IdNames } from './names.js';

const GAUGE = '11111111-1111-4111-8111-111111111111';
const UNIT = '22222222-2222-4222-8222-222222222222';
const TRANSFER = '33333333-3333-4333-8333-333333333333';
const SERIES = '44444444-4444-4444-8444-444444444444';
const GONE = '55555555-5555-4555-8555-555555555555';

const ids: IdNames = {
	names: new Map([
		[GAUGE, nodeWords({ name: 'Outlet weir', kind: 'gauge' })],
		[UNIT, nodeWords({ name: 'Upper', kind: 'farm' })],
		[TRANSFER, "the transfer 'Upper → Outlet weir'"],
		[SERIES, "the series 'Weir record'"]
	]),
	nodes: new Set([GAUGE, UNIT])
};

describe('nameIds', () => {
	it('names node ids in settings, as values, keys and inside sentences', () => {
		const out = nameIds(
			{
				settings: {
					calibrationSiteNodeId: GAUGE,
					calibrationZones: [{ nodeId: GAUGE, enabled: true }],
					rainStations: { units: { [UNIT]: { stationId: SERIES } } },
					droughtRestriction: { ewrTrigger: { siteNodeId: GONE }, damNodeIds: [UNIT, GONE] }
				},
				warnings: [{ code: 'calibration.zone.badParams', params: { node: GAUGE }, message: `calibration zone at gauge node ${GAUGE}: bad` }],
				series: { [`flow_observed_m3s@${GAUGE}`]: 1 }
			},
			ids
		);
		expect(out).toEqual({
			settings: {
				calibrationSiteNodeId: "the gauge 'Outlet weir'",
				calibrationZones: [{ nodeId: "the gauge 'Outlet weir'", enabled: true }],
				rainStations: { units: { "the hydrological unit 'Upper'": { stationId: "the series 'Weir record'" } } },
				droughtRestriction: { ewrTrigger: { siteNodeId: GONE_NODE }, damNodeIds: ["the hydrological unit 'Upper'", GONE_NODE] }
			},
			warnings: [{ code: 'calibration.zone.badParams', params: { node: "the gauge 'Outlet weir'" }, message: "calibration zone at the gauge 'Outlet weir': bad" }],
			series: { "flow_observed_m3s@the gauge 'Outlet weir'": 1 }
		});
		expect(JSON.stringify(out)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}/);
	});

	it('keeps `id` fields (a tool argument, beside its name) and names the references beside them', () => {
		const out = nameIds({ nodes: [{ id: UNIT, name: 'Upper', drainsInto: GAUGE }], transfers: [{ id: TRANSFER, from: 'Upper' }], node: { id: GAUGE, name: 'Outlet weir' } }, ids);
		expect(out).toEqual({
			nodes: [{ id: UNIT, name: 'Upper', drainsInto: "the gauge 'Outlet weir'" }],
			transfers: [{ id: TRANSFER, from: 'Upper' }],
			node: { id: GAUGE, name: 'Outlet weir' }
		});
	});

	it('leaves a node field holding a name, other text and numbers as they are', () => {
		expect(nameIds({ node: 'Upper', nodeId: null, x: 3, note: 'a short id-like word abc' }, ids)).toEqual({ node: 'Upper', nodeId: null, x: 3, note: 'a short id-like word abc' });
	});

	it('names a node by its kind in the app’s words, an unnamed one as such', () => {
		expect(nodeWords({ name: 'Town', kind: 'user' })).toBe("the other water user 'Town'");
		expect(nodeWords({ name: ' ', kind: 'farm' })).toBe("the hydrological unit 'unnamed'");
	});
});
