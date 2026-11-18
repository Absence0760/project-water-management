// node.set cropRemoteNodeId (engine 1.118.0): a team scenario may point a
// unit's crops at another unit's dam, checked against the scenario's model as
// its earlier ops leave it (a dam the scenario adds counts), refused when the
// unit named has no dam then or a later op takes it away, and refused in an
// application. Synthetic catchment: invented names and values only.
import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode } from '../project';
import { runModel } from '../run';
import { checkAll } from '../testing/invariants';
import { combineScenarios } from './combine';
import { applyScenario, classifyOp } from './overrides';
import { validateScenarioOps, type ScenarioOp } from './ops';

function node(id: string, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: `Farm ${id}`,
		kind: 'farm',
		downstreamNodeId: null,
		sortOrder: 0,
		areaKm2: 5,
		pctUpstreamToDam: 0.5,
		pctRunoffToDam: 0.8,
		damCapacityM3: 0,
		damInitialPct: 0.5,
		damMinPct: 0,
		divertCapacityM3Day: 5000,
		irrigationEfficiency: 0.8,
		returnFlowFraction: 0,
		damAreaFullM2: null,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

/** Outlet gauge G; farm A (a dam) and farm B (no dam) drain into it, B growing lucerne. */
function base(): ModelInput {
	const days = 400;
	const rain = Array.from({ length: days }, (_, t) => (t % 13 === 0 ? 35 : t % 4 === 0 ? 5 : 0));
	return {
		settings: {
			apanMm: [150, 180, 210, 220, 190, 160, 110, 80, 60, 60, 80, 110],
			ewrPragmaticM3PerDay: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
		},
		model: {
			nodes: [
				node('G', { name: 'Outlet gauge', kind: 'gauge', areaKm2: 0, divertCapacityM3Day: 0 }),
				node('A', { name: 'Doringkloof', downstreamNodeId: 'G', damCapacityM3: 150_000, sortOrder: 1 }),
				node('B', { name: 'Vlakvlei', downstreamNodeId: 'G', sortOrder: 2 })
			],
			crops: [{ id: 'c1', name: 'Lucerne', cropFactor: [0.8, 0.9, 1, 1, 1, 0.9, 0.8, 0.6, 0.5, 0.5, 0.6, 0.7] }],
			cropAreas: [{ nodeId: 'B', cropId: 'c1', areaM2: 300_000 }],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: rain } }
	};
}

/** The scenario's new dam: Hexberg, a unit with no land of its own, draining into the outlet. */
const addHexberg: ScenarioOp = { op: 'node.add', node: node('H', { name: 'Hexberg', downstreamNodeId: 'G', areaKm2: 0, damCapacityM3: 400_000, sortOrder: 3 }) };
/** Vlakvlei's crops: half from the river, half from `from`'s dam through a 2,000 m³/day pipe (one edit group). */
const drawFrom = (from: string): ScenarioOp[] => [
	{ op: 'node.set', nodeId: 'B', field: 'cropShareDam', value: 0 },
	{ op: 'node.set', nodeId: 'B', field: 'cropShareRiver', value: 0.5 },
	{ op: 'node.set', nodeId: 'B', field: 'cropShareRemote', value: 0.5 },
	{ op: 'node.set', nodeId: 'B', field: 'cropRemoteCapM3Day', value: 2000 },
	{ op: 'node.set', nodeId: 'B', field: 'cropRemoteNodeId', value: from }
];

describe('node.set cropRemoteNodeId (engine 1.118.0)', () => {
	it('validates as a node.set field: an id or null, nothing else', () => {
		expect(validateScenarioOps([{ op: 'node.set', nodeId: 'B', field: 'cropRemoteNodeId', value: 'H' }]).errors).toEqual([]);
		expect(validateScenarioOps([{ op: 'node.set', nodeId: 'B', field: 'cropRemoteNodeId', value: null }]).errors).toEqual([]);
		expect(validateScenarioOps([{ op: 'node.set', nodeId: 'B', field: 'cropRemoteNodeId', value: 3 }]).errors.join()).toMatch(/must be an id/);
		// A gauge has no crops.
		expect(validateScenarioOps([{ op: 'node.set', nodeId: 'G', field: 'cropRemoteNodeId', value: 'A' }]).errors).toEqual([]);
		expect(applyScenario(base(), [{ op: 'node.set', nodeId: 'G', field: 'cropRemoteNodeId', value: 'A' }]).problems.join()).toMatch(/can't be set on a gauge/);
	});

	it('allows a dam the same scenario adds earlier, and the run draws on it', () => {
		const ops = [addHexberg, ...drawFrom('H')];
		expect(validateScenarioOps(ops).errors).toEqual([]);
		const r = applyScenario(base(), ops);
		expect(r.problems).toEqual([]);
		expect(r.applied.map((a) => a.index)).toEqual([0, 1, 2, 3, 4, 5]);
		const b = r.input.model.nodes.find((n) => n.id === 'B')!;
		expect(b.cropRemoteNodeId).toBe('H');
		expect(b.cropShareRemote).toBe(0.5);
		const out = runModel(r.input);
		expect(out.summary.warnings.filter((w) => /another unit's dam/.test(w))).toEqual([]);
		const piped = out.series.find((s) => s.nodeId === 'B' && s.key === 'remote_dam_in')?.values;
		expect(piped && Array.from(piped).some((v) => v > 0)).toBe(true);
		expect(checkAll(r.input)).toBeNull();
	});

	it('allows a dam a base unit gains earlier in the scenario (damCapacityM3 above 0)', () => {
		const ops: ScenarioOp[] = [{ op: 'node.set', nodeId: 'B', field: 'damCapacityM3', value: 0 }, { op: 'node.add', node: node('K', { name: 'Kliphoek', downstreamNodeId: 'G', areaKm2: 0, sortOrder: 4 }) }, { op: 'node.set', nodeId: 'K', field: 'damCapacityM3', value: 80_000 }, ...drawFrom('K')];
		const r = applyScenario(base(), ops);
		expect(r.problems).toEqual([]);
		expect(r.input.model.nodes.find((n) => n.id === 'B')!.cropRemoteNodeId).toBe('K');
	});

	it('refuses a unit with no dam at that point, checked against the scenario, not the base', () => {
		// Hexberg added after the op that names it: it doesn't exist yet.
		const late = applyScenario(base(), [...drawFrom('H'), addHexberg]);
		expect(late.problems.join('\n')).toMatch(/op 5 \(node\.set\): cropRemoteNodeId: no hydrological unit H in the scenario's model at this op/);
		expect(late.input.model.nodes.find((n) => n.id === 'B')!.cropRemoteNodeId ?? null).toBeNull();
		// Doringkloof's dam taken away earlier in the scenario: the base's dam doesn't count.
		const gone = applyScenario(base(), [{ op: 'node.set', nodeId: 'A', field: 'damCapacityM3', value: 0 }, ...drawFrom('A')]);
		expect(gone.problems.join('\n')).toMatch(/"Doringkloof" has no dam at this point in the scenario/);
		// The whole edit group goes: the shares alone (remote 0.5 with no unit) break the save rule.
		expect(gone.input.model.nodes.find((n) => n.id === 'B')!.cropShareRemote ?? null).toBeNull();
		// Itself, and a gauge.
		expect(applyScenario(base(), drawFrom('B')).problems.join()).toMatch(/can't supply its own crops' share from another unit's dam/);
		expect(applyScenario(base(), drawFrom('G')).problems.join()).toMatch(/"Outlet gauge" is a gauge/);
	});

	it('refuses a later op that takes the named dam away', () => {
		const shrink = applyScenario(base(), [addHexberg, ...drawFrom('H'), { op: 'node.set', nodeId: 'H', field: 'damCapacityM3', value: 0 }]);
		expect(shrink.problems).toEqual([`op 7 (node.set): "Vlakvlei": "Hexberg" has no dam to supply the crops' share from`]);
		expect(shrink.input.model.nodes.find((n) => n.id === 'H')!.damCapacityM3).toBe(400_000);
		const removed = applyScenario(base(), [addHexberg, ...drawFrom('H'), { op: 'node.remove', nodeId: 'H' }]);
		expect(removed.problems.join()).toMatch(/op 7 \(node\.remove\): .*needs that unit/);
		expect(removed.input.model.nodes.some((n) => n.id === 'H')).toBe(true);
	});

	it('clears back to none', () => {
		const b = base();
		Object.assign(b.model.nodes[2]!, { cropShareDam: 0, cropShareRiver: 0.5, cropShareRemote: 0.5, cropRemoteNodeId: 'A' });
		const r = applyScenario(b, [
			{ op: 'node.set', nodeId: 'B', field: 'cropShareRemote', value: 0 },
			{ op: 'node.set', nodeId: 'B', field: 'cropShareRiver', value: 1 },
			{ op: 'node.set', nodeId: 'B', field: 'cropRemoteNodeId', value: null }
		]);
		expect(r.problems).toEqual([]);
		expect(r.input.model.nodes[2]!.cropRemoteNodeId).toBeNull();
	});

	it('is refused in an application (under its mask), even for a dam the applicant adds', () => {
		const r = applyScenario(base(), [addHexberg, ...drawFrom('H')], { mask: { nodes: { A: 'Farm 1' } } });
		// The op itself, then the shares left without a unit to draw on break the save rule, so the group goes whole.
		expect(r.problems).toEqual([expect.stringMatching(/^op 6 \(node\.set\): an application can't draw its crops from another unit's dam/), expect.stringMatching(/needs that unit$/)]);
		expect(r.input.model.nodes.find((n) => n.id === 'B')!.cropShareRemote ?? null).toBeNull();
		// And a baseline change, never the applicant's proposal, if one were classified.
		expect(classifyOp({ op: 'node.set', nodeId: 'B', field: 'cropRemoteNodeId', value: 'H' }, ['B', 'H'])).toBe('baseline');
		expect(classifyOp({ op: 'node.set', nodeId: 'B', field: 'cropShareRemote', value: 0.5 }, ['B'])).toBe('proposal');
	});

	it('names the supplying unit for combineScenarios: removing it in another scenario conflicts', () => {
		const c = combineScenarios(base(), [
			{ id: 's1', name: 'Pipe', ops: drawFrom('A') },
			{ id: 's2', name: 'No dam', ops: [{ op: 'node.remove', nodeId: 'A' }] }
		]);
		expect(c.input).toBeNull();
		expect(c.conflicts.map((x) => x.target).join()).toMatch(/Doringkloof/);
	});
});
