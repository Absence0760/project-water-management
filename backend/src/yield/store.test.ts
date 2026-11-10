import { describe, expect, it } from 'vitest';
import type { ModelInput } from '@water-management/engine';
import { ApiError } from '../http/errors.js';
import { canonicalYieldRequest, checkPatternNode, checkYieldNode, yieldDedupeKey, YieldRequest } from './store.js';

const run = '11111111-1111-4111-8111-111111111111';
const nodeId = '22222222-2222-4222-8222-222222222222';

describe('YieldRequest', () => {
	it('fills the defaults when params are absent or empty', () => {
		for (const body of [{ nodeId, runId: run, kind: 'firm' }, { nodeId, runId: run, kind: 'firm', params: {} }]) {
			expect(YieldRequest.parse(body).params).toEqual({ pattern: 'constant', assurance: 1, tolerance: 0.001, points: 11 });
		}
	});

	it('takes exactly one of runId and scenarioId', () => {
		expect(YieldRequest.safeParse({ nodeId, kind: 'firm' }).success).toBe(false);
		expect(YieldRequest.safeParse({ nodeId, kind: 'firm', runId: run, scenarioId: run }).success).toBe(false);
		expect(YieldRequest.safeParse({ nodeId, kind: 'curve', scenarioId: run }).success).toBe(true);
	});

	it('bounds the params: 12 non-negative factors, assurance 0.5–1, 8–12 points, no extra keys', () => {
		const p = (params: unknown) => YieldRequest.safeParse({ nodeId, runId: run, kind: 'curve', params }).success;
		expect(p({ pattern: new Array(12).fill(1) })).toBe(true);
		expect(p({ pattern: new Array(11).fill(1) })).toBe(false);
		expect(p({ pattern: [-1, ...new Array(11).fill(1)] })).toBe(false);
		expect(p({ assurance: 0.4 })).toBe(false);
		expect(p({ points: 7 })).toBe(false);
		expect(p({ points: 13 })).toBe(false);
		expect(p({ extra: 1 })).toBe(false);
	});
});

describe("another unit's demand shape (patternNodeId, engine 1.117.0)", () => {
	const other = '55555555-5555-4555-8555-555555555555';

	it("takes patternNodeId with the 'demand' pattern only, and a uuid", () => {
		const p = (params: unknown) => YieldRequest.safeParse({ nodeId, runId: run, kind: 'firm', params }).success;
		expect(p({ pattern: 'demand', patternNodeId: other })).toBe(true);
		expect(p({ pattern: 'constant', patternNodeId: other })).toBe(false);
		expect(p({ patternNodeId: other })).toBe(false);
		expect(p({ pattern: new Array(12).fill(1), patternNodeId: other })).toBe(false);
		expect(p({ pattern: 'demand', patternNodeId: 'farm' })).toBe(false);
	});

	it("a request without it parses and keys exactly as before; the dam's own id is the same request", () => {
		const before = YieldRequest.parse({ nodeId, runId: run, kind: 'firm', params: { pattern: 'demand' } });
		expect(before.params).toEqual({ pattern: 'demand', assurance: 1, tolerance: 0.001, points: 11 });
		expect('patternNodeId' in before.params).toBe(false);
		const own = canonicalYieldRequest(YieldRequest.parse({ nodeId, runId: run, kind: 'firm', params: { pattern: 'demand', patternNodeId: nodeId } }));
		expect(own).toEqual(before);
		expect(yieldDedupeKey(own)).toBe(yieldDedupeKey(before));
		const another = canonicalYieldRequest(YieldRequest.parse({ nodeId, runId: run, kind: 'firm', params: { pattern: 'demand', patternNodeId: other } }));
		expect(another.params.patternNodeId).toBe(other);
		expect(yieldDedupeKey(another)).not.toBe(yieldDedupeKey(before));
	});

	it('checkPatternNode: a unit of the model the caller may see, else 400 yield_pattern_unit', () => {
		const input = {
			model: {
				nodes: [
					{ id: nodeId, kind: 'farm', name: 'Hilltop' },
					{ id: other, kind: 'farm', name: 'Riverside' },
					{ id: run, kind: 'gauge', name: 'Gauge' }
				]
			}
		} as unknown as ModelInput;
		expect(() => checkPatternNode(input, undefined, null)).not.toThrow();
		expect(() => checkPatternNode(input, other, null)).not.toThrow();
		expect(() => checkPatternNode(input, other, new Set([nodeId, other]))).not.toThrow();
		for (const [id, visible] of [
			[run, null],
			['66666666-6666-4666-8666-666666666666', null],
			[other, new Set([nodeId])]
		] as const) {
			let err: unknown;
			try {
				checkPatternNode(input, id, visible);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(ApiError);
			expect(err).toMatchObject({ status: 400, code: 'yield_pattern_unit' });
		}
	});
});

describe('a unit with no dam (capacity 0): no firm yield, a curve only to an entered largest capacity', () => {
	const input = (cap: number, pctRunoffToDam = 1) =>
		({ model: { nodes: [{ id: nodeId, kind: 'farm', name: 'Hilltop', damCapacityM3: cap, pctRunoffToDam, pctUpstreamToDam: 0, divertCapacityM3Day: 0 }], transfers: [] } }) as unknown as ModelInput;
	const refusal = (f: () => void) => {
		try {
			f();
		} catch (e) {
			return e;
		}
		return null;
	};

	it('takes maxCapacityM3 on a curve only, above 0', () => {
		const p = (kind: string, params: unknown) => YieldRequest.safeParse({ nodeId, runId: run, kind, params }).success;
		expect(p('curve', { maxCapacityM3: 500_000 })).toBe(true);
		expect(p('firm', { maxCapacityM3: 500_000 })).toBe(false);
		expect(p('curve', { maxCapacityM3: 0 })).toBe(false);
		expect(p('curve', { maxCapacityM3: -1 })).toBe(false);
		// A request without it parses as before: the curve reads as twice the dam's capacity.
		expect('maxCapacityM3' in YieldRequest.parse({ nodeId, runId: run, kind: 'curve' }).params).toBe(false);
	});

	it('refuses a firm yield, and a curve without a largest capacity, with 400 yield_no_dam; a dam with a capacity takes both', () => {
		expect(refusal(() => checkYieldNode(input(0), nodeId, 'firm'))).toMatchObject({ status: 400, code: 'yield_no_dam' });
		expect(refusal(() => checkYieldNode(input(0), nodeId, 'firm', 500_000))).toMatchObject({ status: 400, code: 'yield_no_dam' });
		expect(refusal(() => checkYieldNode(input(0), nodeId, 'curve'))).toMatchObject({ status: 400, code: 'yield_no_dam' });
		expect(refusal(() => checkYieldNode(input(0), nodeId, 'curve', 500_000))).toBeNull();
		expect(refusal(() => checkYieldNode(input(0), nodeId, null))).toBeNull();
		expect(refusal(() => checkYieldNode(input(1_000), nodeId, 'firm'))).toBeNull();
		expect(refusal(() => checkYieldNode(input(1_000), nodeId, 'curve'))).toBeNull();
	});

	it('refuses a yield of a dam nothing routes water into with 400 yield_no_inflow, a sized curve too; the options read it', () => {
		expect(refusal(() => checkYieldNode(input(1_000, 0), nodeId, 'firm'))).toMatchObject({ status: 400, code: 'yield_no_inflow' });
		expect(refusal(() => checkYieldNode(input(1_000, 0), nodeId, 'curve'))).toMatchObject({ status: 400, code: 'yield_no_inflow' });
		expect(refusal(() => checkYieldNode(input(0, 0), nodeId, 'curve', 500_000))).toMatchObject({ status: 400, code: 'yield_no_inflow' });
		// No dam is said first: a firm yield of a unit with neither is yield_no_dam.
		expect(refusal(() => checkYieldNode(input(0, 0), nodeId, 'firm'))).toMatchObject({ code: 'yield_no_dam' });
		expect(refusal(() => checkYieldNode(input(0, 0), nodeId, null))).toBeNull();
	});
});

describe('yieldDedupeKey', () => {
	it('is the same for the same request whatever the key order, and differs by params', () => {
		const a = YieldRequest.parse({ nodeId, runId: run, kind: 'firm', params: { assurance: 0.9, pattern: 'demand' } });
		const b = YieldRequest.parse({ kind: 'firm', params: { pattern: 'demand', assurance: 0.9 }, runId: run, nodeId });
		const c = YieldRequest.parse({ nodeId, runId: run, kind: 'firm', params: { assurance: 0.95, pattern: 'demand' } });
		expect(yieldDedupeKey(a)).toBe(yieldDedupeKey(b));
		expect(yieldDedupeKey(a)).not.toBe(yieldDedupeKey(c));
		expect(yieldDedupeKey(a)).toMatch(new RegExp(`^yield:${run}:${nodeId}:[0-9a-f]{16}$`));
		expect(yieldDedupeKey(a).length).toBeLessThanOrEqual(200);
	});

	it('is a contributor’s own when given their id, within the column’s 200 characters', () => {
		const a = YieldRequest.parse({ nodeId, scenarioId: run, kind: 'curve' });
		const user = '33333333-3333-4333-8333-333333333333';
		expect(yieldDedupeKey(a, user)).toBe(`${yieldDedupeKey(a)}:${user}`);
		expect(yieldDedupeKey(a, user)).not.toBe(yieldDedupeKey(a, '44444444-4444-4444-8444-444444444444'));
		expect(yieldDedupeKey(a, user).length).toBeLessThanOrEqual(200);
	});
});
