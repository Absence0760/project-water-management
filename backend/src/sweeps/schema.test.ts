// The sweep request body (issue #53 R2): member op sets go through the
// scenario op validation, names are unique, and the member count is capped.
import { describe, expect, it } from 'vitest';
import { CreateSweepBody, SWEEP_MEMBERS_MAX, SweepPayload } from './schema.js';

const baseRunId = '11111111-1111-4111-8111-111111111111';
const scale = (factor: number) => [{ op: 'demand.scale', factor }];
const body = (members: unknown[], extra: Record<string, unknown> = {}) => ({ name: 'Demand levels', baseRunId, members, ...extra });
const issues = (raw: unknown) => {
	const r = CreateSweepBody.safeParse(raw);
	return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('CreateSweepBody', () => {
	it('takes a base run and named demand.scale members, trimming names', () => {
		const r = CreateSweepBody.parse(body([{ name: ' 100 % ', ops: scale(1) }, { name: '85 %', ops: scale(0.85) }, { name: '70 %', ops: scale(0.7) }]));
		expect(r.members.map((m) => m.name)).toEqual(['100 %', '85 %', '70 %']);
		expect(r.members[1]!.ops).toEqual([{ op: 'demand.scale', factor: 0.85 }]);
	});

	it('accepts a member with no ops (the base run as it is)', () => {
		expect(CreateSweepBody.parse(body([{ name: 'As is', ops: [] }])).members[0]!.ops).toEqual([]);
	});

	it('refuses ops the scenario validation refuses: a factor out of range, an unknown op, a node id that is not a UUID', () => {
		expect(issues(body([{ name: 'Too much', ops: scale(3) }])).join('\n')).toMatch(/^members\.0\.ops: ops\[0\]\.factor/);
		expect(issues(body([{ name: 'Bogus', ops: [{ op: 'demand.double' }] }]))).toHaveLength(1);
		expect(issues(body([{ name: 'Bad id', ops: [{ op: 'demand.scale', factor: 0.5, nodeIds: ['farm-1'] }] }]))).toEqual([
			'members.0.ops: ops[0].nodeIds[0]: must be a UUID'
		]);
	});

	it('refuses two members with the same name, whatever the case', () => {
		expect(issues(body([{ name: 'Dry', ops: scale(0.7) }, { name: 'dry', ops: scale(0.5) }]))).toEqual(['members.1.name: two members are called "dry"']);
	});

	it(`needs 1 to ${SWEEP_MEMBERS_MAX} members`, () => {
		expect(issues(body([]))).toEqual(['members: a sweep needs at least one member']);
		const many = Array.from({ length: SWEEP_MEMBERS_MAX + 1 }, (_, i) => ({ name: `m${i}`, ops: scale(i / 10) }));
		expect(issues(body(many))).toEqual([`members: a sweep has at most ${SWEEP_MEMBERS_MAX} members`]);
		expect(issues(body(many.slice(0, SWEEP_MEMBERS_MAX)))).toEqual([]);
	});

	it('refuses unknown keys, a missing name and a base run that is not a UUID', () => {
		expect(issues(body([{ name: 'a', ops: [] }], { extra: 1 }))).toHaveLength(1);
		expect(issues(body([{ name: 'a', ops: [], note: 'x' }]))).toHaveLength(1);
		expect(issues(body([{ name: '  ', ops: [] }]))).toEqual(['members.0.name: a member needs a name']);
		expect(issues(body([{ name: 'a', ops: [] }], { baseRunId: 'run-1' }))[0]).toMatch(/^baseRunId:/);
	});
});

describe('SweepPayload', () => {
	it('is the sweep id and nothing else', () => {
		expect(SweepPayload.parse({ sweepId: baseRunId })).toEqual({ sweepId: baseRunId });
		expect(SweepPayload.safeParse({ sweepId: baseRunId, members: [] }).success).toBe(false);
	});
});
