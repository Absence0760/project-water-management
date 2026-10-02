import { describe, expect, it } from 'vitest';
import type { ApplicationQuestion } from '$lib/api';
import { askables, opsText, ruleLabel, rulesText } from './questions';

const q = (problem: string, askedAt: string, answer: string | null = null): ApplicationQuestion => ({
	id: askedAt,
	askedAt,
	problem,
	opIndexes: [0],
	rules: ['shares'],
	answer,
	answeredAt: answer ? askedAt : null
});

describe('"Ask the assessors why" (164)', () => {
	it('words each rule kind by what it is about, never a unit', () => {
		expect(ruleLabel('shares')).toBe('flow shares');
		expect(ruleLabel('area')).toBe('catchment area');
		expect(ruleLabel('supplyRor')).toBe('a supply rule on a unit you can’t see');
		expect(ruleLabel('bhEmergency')).toBe('a borehole rule on a unit you can’t see');
		expect(ruleLabel('crop')).toBe('a rule about an item you can’t see');
		expect(rulesText(['shares'])).toBe('flow shares');
		expect(rulesText(['shares', 'area', 'shares'])).toBe('flow shares and catchment area');
		expect(rulesText([])).toBe('a rule about an item you can’t see');
	});

	it('numbers the ops as the problem lines do', () => {
		expect(opsText([2])).toBe('change 3');
		expect(opsText([4, 2, 3])).toBe('changes 3–5');
		expect(opsText([0, 2])).toBe('changes 1 and 3');
	});

	it('lists the masked lines only, each with the newest question on its very words', () => {
		const problems = ["op 1 (node.set): doesn't apply to the catchment as modelled", 'op 2 (node.set): no node X'];
		const masked = [{ problem: 0, ops: [0], rules: ['shares'] }];
		expect(askables(problems, masked, [])).toEqual([{ problem: 0, line: problems[0], ops: [0], rules: ['shares'], asked: null }]);
		const older = q(problems[0]!, '2026-10-01T08:00:00Z', 'Reduce it.');
		const newer = q(problems[0]!, '2026-10-01T09:00:00Z');
		expect(askables(problems, masked, [older, newer, q('another line', '2026-10-01T10:00:00Z')])[0]!.asked).toBe(newer);
		// A ref past the lines (a stale check) is dropped; none at all on a team scenario.
		expect(askables(problems, [{ problem: 5, ops: [4], rules: ['area'] }], [])).toEqual([]);
		expect(askables(problems, undefined, [])).toEqual([]);
	});
});
