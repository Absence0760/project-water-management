import { describe, expect, it } from 'vitest';
import { yieldDedupeKey, YieldRequest } from './store.js';

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
});
