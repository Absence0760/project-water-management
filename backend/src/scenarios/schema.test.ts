// The scenario request bodies (schema.ts): the engine's validateScenarioOps
// wrapped in zod, with every id tightened to a UUID, and the ops hash.
import { canonicalJson, type ScenarioOp } from '@water-management/engine';
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
		// A non-id value of transfer.set is not an id.
		expect(checkOps([{ op: 'transfer.set', transferId: t, field: 'priority', value: 3 }]).errors).toEqual([]);
	});

	it("reports the engine validator's errors first, unchanged", () => {
		expect(checkOps('nope').errors).toEqual(['ops: must be a list']);
		expect(checkOps([{ op: 'node.set', nodeId: a, field: 'damMinPct', value: 2 }]).errors).toEqual(['ops[0].value: must be at most 1']);
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
