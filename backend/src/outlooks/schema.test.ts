// The outlook request body (issue #53 R5): levels go through the scenario op
// validation and must be demand.scale only, labels are unique, the level
// count is capped, and the season is both dates or neither, checked by the
// engine's resolveSeason.
import { describe, expect, it } from 'vitest';
import { CreateOutlookBody, OUTLOOK_LEVELS_MAX, OutlookPayload } from './schema.js';

const baseRunId = '11111111-1111-4111-8111-111111111111';
const scale = (factor: number, extra: Record<string, unknown> = {}) => [{ op: 'demand.scale', factor, ...extra }];
const body = (levels: unknown[], extra: Record<string, unknown> = {}) => ({ name: 'Outlook', baseRunId, levels, ...extra });
const levels = [
	{ label: '100 %', ops: scale(1) },
	{ label: '85 %', ops: scale(0.85) },
	{ label: '70 %', ops: scale(0.7) }
];
const issues = (raw: unknown) => {
	const r = CreateOutlookBody.safeParse(raw);
	return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('CreateOutlookBody', () => {
	it('takes a base run and labelled demand.scale levels (a monthly plan too), trimming labels; season, share and years optional', () => {
		const monthly = { label: ' Taper ', ops: [...scale(1, { months: [10, 11, 12] }), ...scale(0.7, { months: [1, 2, 3, 4] })] };
		const r = CreateOutlookBody.parse(body([...levels, monthly]));
		expect(r.levels.map((l) => l.label)).toEqual(['100 %', '85 %', '70 %', 'Taper']);
		expect(r.levels[3]!.ops).toHaveLength(2);
		expect(r.decisionDate).toBeUndefined();
		const full = CreateOutlookBody.parse(body(levels, { decisionDate: '2012-10-01', seasonEnd: '2013-04-30', planningShare: 0.75, analogueYears: [2001, 2002] }));
		expect(full).toMatchObject({ decisionDate: '2012-10-01', seasonEnd: '2013-04-30', planningShare: 0.75, analogueYears: [2001, 2002] });
		// A level with no ops is today's demand as it is.
		expect(CreateOutlookBody.parse(body([{ label: 'As is', ops: [] }])).levels[0]!.ops).toEqual([]);
	});

	it('refuses an op that is not demand.scale (it would change the history), and ops the scenario validation refuses', () => {
		const other = issues(body([{ label: 'Bigger dam', ops: [{ op: 'node.set', nodeId: baseRunId, field: 'damCapacityM3', value: 1 }] }]));
		expect(other.join('\n')).toMatch(/only demand\.scale ops make a demand level/);
		expect(issues(body([{ label: 'Too much', ops: scale(3) }])).join('\n')).toMatch(/^levels\.0\.ops: ops\[0\]\.factor/);
		expect(issues(body([{ label: 'Bad month', ops: scale(0.5, { months: [13] }) }])).join('\n')).toMatch(/months/);
	});

	it(`refuses no levels, more than ${OUTLOOK_LEVELS_MAX}, two with one label (any case), and unknown keys`, () => {
		expect(issues(body([]))).toHaveLength(1);
		const many = Array.from({ length: OUTLOOK_LEVELS_MAX + 1 }, (_, i) => ({ label: `L${i}`, ops: scale(i / 10) }));
		expect(issues(body(many))).toEqual([`levels: an outlook has at most ${OUTLOOK_LEVELS_MAX} demand levels`]);
		expect(issues(body([{ label: 'x', ops: [] }, { label: 'X', ops: [] }]))).toEqual(['levels.1.label: two demand levels are called "X"']);
		expect(issues(body(levels, { site: 'outlet' }))).toHaveLength(1);
	});

	it("wants both dates or neither, real dates in order, a season of at most a year (the engine's words), a share in (0, 1] and distinct years", () => {
		expect(issues(body(levels, { decisionDate: '2012-10-01' }))).toEqual(['seasonEnd: give both the decision date and the season end, or neither']);
		expect(issues(body(levels, { decisionDate: '2012-10-01', seasonEnd: '2012-09-30' })).join('\n')).toMatch(/before its decision date/);
		expect(issues(body(levels, { decisionDate: '2012-02-30', seasonEnd: '2012-09-30' })).join('\n')).toMatch(/not an ISO date/);
		expect(issues(body(levels, { decisionDate: '2012-10-01', seasonEnd: '2013-10-02' })).join('\n')).toMatch(/at most 366/);
		expect(issues(body(levels, { decisionDate: '1 Oct', seasonEnd: '2013-04-30' }))).toHaveLength(1);
		for (const s of [0, 1.5, -1]) expect(issues(body(levels, { planningShare: s })), String(s)).toHaveLength(1);
		expect(issues(body(levels, { analogueYears: [2001, 2001] }))).toEqual(['analogueYears: names a water year more than once']);
		expect(issues(body(levels, { analogueYears: [2001.5] }))).toHaveLength(1);
		expect(issues(body(levels, { analogueYears: [] }))).toHaveLength(1);
	});
});

describe('OutlookPayload', () => {
	it('is the outlook id only', () => {
		expect(OutlookPayload.parse({ outlookId: baseRunId })).toEqual({ outlookId: baseRunId });
		expect(OutlookPayload.safeParse({ outlookId: 'x' }).success).toBe(false);
		expect(OutlookPayload.safeParse({ outlookId: baseRunId, more: 1 }).success).toBe(false);
	});
});
