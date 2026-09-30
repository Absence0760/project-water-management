// The scenario request bodies (schema.ts): the engine's validateScenarioOps
// wrapped in zod, with every id tightened to a UUID, and the ops hash.
import { blankEwrRuleTable, canonicalJson, type ScenarioOp } from '@water-management/engine';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkOps, CreateScenarioBody, opsSha256, PatchScenarioBody, STATUS_MOVES } from './schema.js';

const a = crypto.randomUUID();
const b = crypto.randomUUID();
const t = crypto.randomUUID();

describe('checkOps', () => {
	it('accepts valid ops with UUID ids, rebuilt from their known fields only', () => {
		const { ops, errors } = checkOps([
			{ op: 'node.set', nodeId: a, field: 'damCapacityM3', value: 5, extra: 'dropped' },
			{ op: 'transfer.set', transferId: t, field: 'toNodeId', value: b },
			{ op: 'settings.set', path: 'effectiveRainFraction', value: 0.8 },
			{ op: 'series.scale', kind: 'rain_catchment_mm', factor: 0.9 }
		]);
		expect(errors).toEqual([]);
		expect(ops[0]).toEqual({ op: 'node.set', nodeId: a, field: 'damCapacityM3', value: 5 });
	});

	it('names every id that is not a UUID by path, including a transfer end set by value', () => {
		const { errors } = checkOps([
			{ op: 'node.remove', nodeId: 'farm-a' },
			{ op: 'transfer.set', transferId: t, field: 'fromNodeId', value: 'x' },
			{ op: 'cropArea.set', nodeId: a, cropId: 'c1', areaM2: 1 },
			{ op: 'landCover.remove', patchId: 'p' }
		]);
		expect(errors).toEqual(['ops[0].nodeId: must be a UUID', 'ops[1].value: must be a UUID', 'ops[2].cropId: must be a UUID', 'ops[3].patchId: must be a UUID']);
		// Borehole ops (WP-3.9): the new borehole's id and node, and the one removed.
		const bh = { id: 'bh', nodeId: a, name: 'BH', capacityM3Day: 1, annualCapM3: null, mode: 'supplemental', emergencyBelowPct: 0.3, target: 'direct', depletionFactor: 0 };
		expect(checkOps([{ op: 'borehole.add', borehole: bh }, { op: 'borehole.remove', boreholeId: 'x' }]).errors).toEqual(['ops[0].borehole.id: must be a UUID', 'ops[1].boreholeId: must be a UUID']);
		expect(checkOps([{ op: 'borehole.add', borehole: { ...bh, id: b } }]).errors).toEqual([]);
		// Demand-object ops (engine ≥ 1.41.0): the new object's id and unit, and the object set or removed.
		const dobj = { id: 'do', nodeId: 'farm', name: 'Town', category: 'municipal', sizing: 'monthly', monthlyM3Day: new Array(12).fill(1), count: null, litresPerUnitDay: null, lossPct: 0, monthlyFactor: null, returnPct: 0, priority: 'first', destination: 'internal', enabled: true, note: '' };
		expect(
			checkOps([
				{ op: 'demandObject.add', demandObject: dobj },
				{ op: 'demandObject.set', demandObjectId: 'x', field: 'count', value: 1 },
				{ op: 'demandObject.remove', demandObjectId: 'y' }
			]).errors
		).toEqual(['ops[0].demandObject.id: must be a UUID', 'ops[0].demandObject.nodeId: must be a UUID', 'ops[1].demandObjectId: must be a UUID', 'ops[2].demandObjectId: must be a UUID']);
		expect(checkOps([{ op: 'demandObject.add', demandObject: { ...dobj, id: b, nodeId: a } }, { op: 'demandObject.remove', demandObjectId: b }]).errors).toEqual([]);
		// A non-id value of transfer.set is not an id.
		expect(checkOps([{ op: 'transfer.set', transferId: t, field: 'priority', value: 3 }]).errors).toEqual([]);
		// demand.scale (issue #53 R1): each node it names, by its place in the list; none named is every farm.
		expect(checkOps([{ op: 'demand.scale', factor: 0.85, nodeIds: [a, 'farm-b'] }]).errors).toEqual(['ops[0].nodeIds[1]: must be a UUID']);
		expect(checkOps([{ op: 'demand.scale', factor: 0.85, nodeIds: [a, b], months: [12, 1], category: 'farm' }, { op: 'demand.scale', factor: 0.7 }]).errors).toEqual([]);
		// ewrRule.set (engine ≥ 1.6.0): the site's gauge; null (the outlet) has no id.
		const table = { ...blankEwrRuleTable(null), source: 'Invented study' };
		expect(checkOps([{ op: 'ewrRule.set', table: { ...table, siteNodeId: 'weir' } }]).errors).toEqual(['ops[0].table.siteNodeId: must be a UUID']);
		expect(checkOps([{ op: 'ewrRule.set', table }, { op: 'ewrRule.set', table: { ...table, siteNodeId: a } }]).errors).toEqual([]);
	});

	it('names the ids of the later ops (engine ≥ 1.35.0): a move, an insert and its upstream nodes, a crop, a patch, a site, a volume', () => {
		const n = { id: 'n', name: 'New dam', kind: 'farm', downstreamNodeId: a, areaKm2: 0, areaHiKm2: 0, areaLoKm2: 0, flowShareManual: null, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 1, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 1, lossReturnFraction: 0 };
		const al = { id: 'al', nodeId: 'farm', waterSource: 'surface', volumeM3PerYear: 1 };
		expect(
			checkOps([
				{ op: 'node.move', nodeId: 'x', downstreamNodeId: 'y' },
				{ op: 'node.insert', node: n, upstreamNodeIds: [b, 'z'] },
				{ op: 'crop.set', cropId: 'c', field: 'name', value: 'X' },
				{ op: 'crop.remove', cropId: 'c' },
				{ op: 'landCover.set', patchId: 'p', field: 'areaKm2', value: 1 },
				{ op: 'ewrRule.remove', siteNodeId: 'weir' },
				{ op: 'allocation.set', allocation: al },
				{ op: 'allocation.remove', allocationId: 'al' }
			]).errors
		).toEqual([
			'ops[0].nodeId: must be a UUID',
			'ops[0].downstreamNodeId: must be a UUID',
			'ops[1].node.id: must be a UUID',
			'ops[1].upstreamNodeIds[1]: must be a UUID',
			'ops[2].cropId: must be a UUID',
			'ops[3].cropId: must be a UUID',
			'ops[4].patchId: must be a UUID',
			'ops[5].siteNodeId: must be a UUID',
			'ops[6].allocation.id: must be a UUID',
			'ops[6].allocation.nodeId: must be a UUID',
			'ops[7].allocationId: must be a UUID'
		]);
		// The outlet's table (null) names no id.
		expect(checkOps([{ op: 'ewrRule.remove', siteNodeId: null }, { op: 'allocation.set', allocation: { ...al, id: t, nodeId: a } }, { op: 'node.move', nodeId: a, downstreamNodeId: b }]).errors).toEqual([]);
	});

	it("reports the engine validator's errors first, unchanged", () => {
		expect(checkOps('nope').errors).toEqual(['ops: must be a list']);
		expect(checkOps([{ op: 'node.set', nodeId: a, field: 'damMinPct', value: 2 }]).errors).toEqual(['ops[0].value: must be at most 1']);
		expect(checkOps([{ op: 'demand.scale', factor: 2.5, nodeIds: ['x'] }]).errors).toEqual(['ops[0].factor: must be at most 2']);
		// A rule table Settings wouldn't save, in the Settings form's words.
		expect(checkOps([{ op: 'ewrRule.set', table: { ...blankEwrRuleTable('x'), source: '' } }]).errors).toEqual([
			'ops[0].table.source: Say where the table comes from (Reserve determination, gazette notice, table).'
		]);
	});
});

describe('bodies', () => {
	it('creates with defaults, and refuses unknown keys', () => {
		expect(CreateScenarioBody.parse({ name: ' Dam ', baseRunId: a })).toEqual({ name: 'Dam', description: '', baseRunId: a, ops: [], ownedNodeIds: [] });
		expect(CreateScenarioBody.safeParse({ name: 'Dam', baseRunId: a, status: 'submitted' }).success).toBe(false);
		expect(CreateScenarioBody.safeParse({ name: '  ', baseRunId: a }).success).toBe(false);
		expect(CreateScenarioBody.parse({ name: 'D', baseRunId: a, ownedNodeIds: [a, a, b] }).ownedNodeIds).toEqual([a, b]);
	});

	it('patches at least one field', () => {
		expect(PatchScenarioBody.safeParse({}).success).toBe(false);
		expect(PatchScenarioBody.parse({ ops: [] })).toEqual({ ops: [] });
		expect(PatchScenarioBody.safeParse({ ops: [{ op: 'node.remove', nodeId: 'x' }] }).success).toBe(false);
	});

	it('allows only the documented status moves', () => {
		expect(STATUS_MOVES).toEqual({ draft: ['submitted'], submitted: ['withdrawn', 'decided'], withdrawn: ['draft'], decided: [] });
	});
});

describe('opsSha256', () => {
	it('hashes the canonical JSON, so key order does not matter', () => {
		const op = { op: 'node.set', nodeId: a, field: 'damCapacityM3', value: 5 } as ScenarioOp;
		const reordered = { value: 5, field: 'damCapacityM3', nodeId: a, op: 'node.set' } as unknown as ScenarioOp;
		expect(opsSha256([op])).toBe(opsSha256([reordered]));
		expect(opsSha256([op])).toBe(createHash('sha256').update(canonicalJson([op])).digest('hex'));
		expect(opsSha256([])).not.toBe(opsSha256([op]));
	});
});
