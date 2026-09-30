// The review triggers as WP-3.8's drought restriction rule (engine 1.52.0,
// docs/model.md §2.15a, §2.7i): restrictionRuleFromTriggers, and the outlook
// and its triggers running without the rule (withoutDroughtRestriction).
import { describe, expect, it } from 'vitest';
import { droughtRestrictionIssues } from '../network/restriction';
import type { DroughtRestrictionRule } from '../project';
import { runModelWithoutChecks } from '../run';
import type { ScenarioOp } from '../scenario/ops';
import { runSeasonalOutlook, withoutDroughtRestriction } from './outlook';
import { testCatchment } from './testCatchment';
import { restrictionRuleFromTriggers, runReviewTriggers } from './triggers';

const scale = (factor: number, more: Partial<Extract<ScenarioOp, { op: 'demand.scale' }>> = {}): ScenarioOp[] => [{ op: 'demand.scale', factor, ...more }];
const LEVELS = [
	{ id: 'l100', label: '100 %', ops: scale(1) },
	{ id: 'l85', label: '85 %', ops: scale(0.85) },
	{ id: 'l70', label: '70 %', ops: scale(0.7) }
];
// Three bands of a 300 000 m³ total, fullest first, as reviewTriggerTable gives them.
const row = (fromM3: number, toM3: number, level: string | null) => ({ band: { fromM3, toM3 }, level: level ? { id: level, label: LEVELS.find((l) => l.id === level)!.label } : null });
const table = (rows: ReturnType<typeof row>[]) => ({ reviewDate: '2014-01-01', seasonEnd: '2014-04-30', capacityM3: 300_000, rows });

describe('restrictionRuleFromTriggers', () => {
	it('turns each band below the fullest into a level from the band above’s lower edge, cutting 1 − its factor, reviewed on the review date and lifted the day after the season end', () => {
		const { rule, notes } = restrictionRuleFromTriggers(table([row(200_000, 300_000, 'l100'), row(100_000, 200_000, 'l85'), row(0, 100_000, 'l70')]), LEVELS);
		expect(notes).toEqual([]);
		expect(rule!.reviewDates).toEqual(['01-01']);
		expect(rule!.liftDates).toEqual(['05-01']);
		expect(rule!.levels.map((l) => [l.label, l.belowPct])).toEqual([
			['85 %', 2 / 3],
			['70 %', 1 / 3]
		]);
		// Every part of demand, as demand.scale without a part scales the whole unit.
		expect(Object.keys(rule!.levels[0]!.cuts).sort()).toEqual(['crops', 'domestic', 'external', 'industrial', 'irrigation', 'livestock', 'municipal', 'other']);
		expect(rule!.levels[0]!.cuts.crops).toBeCloseTo(0.15, 12);
		expect(rule!.levels[1]!.cuts.domestic).toBeCloseTo(0.3, 12);
		expect(droughtRestrictionIssues(rule)).toEqual([]);
		expect(rule!.source).toMatch(/Review triggers/);
	});

	it('carries a part’s own factor, and says what it can’t carry', () => {
		const levels = [
			{ id: 'a', label: 'A', ops: [...scale(0.8, { part: 'crops' }), ...scale(0.9, { part: 'municipal' })] },
			{ id: 'b', label: 'B', ops: [...scale(0.5, { part: 'crops' }), ...scale(0.7, { part: 'municipal' }), ...scale(0.5, { nodeIds: ['x'] }), ...scale(0.9, { category: 'user' })] }
		];
		const { rule, notes } = restrictionRuleFromTriggers({ ...table([]), rows: [{ band: { fromM3: 150_000, toM3: 300_000 }, level: { id: 'a', label: 'A' } }, { band: { fromM3: 0, toM3: 150_000 }, level: { id: 'b', label: 'B' } }] }, levels);
		// The fullest band cuts too: in force below 100 %.
		expect(rule!.levels.map((l) => l.belowPct)).toEqual([1, 0.5]);
		expect(rule!.levels[0]!.cuts).toEqual({ crops: expect.closeTo(0.2, 12), municipal: expect.closeTo(0.1, 12) });
		expect(rule!.levels[1]!.cuts).toEqual({ crops: 0.5, municipal: expect.closeTo(0.3, 12) });
		expect(notes.join('\n')).toMatch(/fullest band's level \(A\) cuts demand too/);
		expect(notes.join('\n')).toMatch(/B: a demand change limited to some hydrological units or months isn't carried/);
		expect(notes.join('\n')).toMatch(/B: a demand change on the other water users isn't carried/);
		expect(droughtRestrictionIssues(rule)).toEqual([]);
	});

	it('a band where no level met the rule takes the band above’s cuts; a table that isn’t monotone keeps the deeper cut; equal bands merge', () => {
		const { rule, notes } = restrictionRuleFromTriggers(table([row(200_000, 300_000, 'l100'), row(100_000, 200_000, 'l70'), row(50_000, 100_000, 'l85'), row(0, 50_000, null)]), LEVELS);
		// 70 % from 2/3 down; the 85 % band below is raised to 70 %'s cut and so merges, as does the band without a level.
		expect(rule!.levels).toHaveLength(1);
		expect(rule!.levels[0]!.belowPct).toBeCloseTo(2 / 3, 12);
		expect(notes.join('\n')).toMatch(/isn't monotone: 85 % below 33\.3 % cuts the crops less than the band above/);
		expect(notes.join('\n')).toMatch(/no demand level met the planning rule, so it takes the cuts of the band above/);
		expect(droughtRestrictionIssues(rule)).toEqual([]);
	});

	it('two bands with one lower edge make one level (the deeper cuts), so the rule can always be saved', () => {
		const { rule, notes } = restrictionRuleFromTriggers(table([row(200_000, 300_000, 'l100'), row(200_000, 200_000, 'l85'), row(0, 200_000, 'l70')]), LEVELS);
		expect(droughtRestrictionIssues(rule)).toEqual([]);
		expect(rule!.levels.map((l) => [l.label, l.belowPct])).toEqual([['70 %', 2 / 3]]);
		expect(rule!.levels[0]!.cuts.crops).toBeCloseTo(0.3, 12);
		expect(notes.join('\n')).toMatch(/Two bands start at 66\.7 % of capacity/);
		// A table over no capacity has no threshold at all: no rule, and the reason.
		const none = restrictionRuleFromTriggers({ ...table([row(0, 0, 'l100'), row(0, 0, 'l70')]), capacityM3: 0 }, LEVELS);
		expect(none.rule).toBeNull();
	});

	it('a top band of full dams only is no level: the band below it starts below 100 %', () => {
		const { rule, notes } = restrictionRuleFromTriggers(table([row(300_000, 300_000, 'l85'), row(100_000, 300_000, 'l85'), row(0, 100_000, 'l70')]), LEVELS);
		expect(droughtRestrictionIssues(rule)).toEqual([]);
		expect(rule!.levels.map((l) => [l.label, l.belowPct])).toEqual([
			['85 %', 1],
			['70 %', 1 / 3]
		]);
		expect(notes.join('\n')).toMatch(/band of full dams only \(85 %\) is no level/);
	});

	it('no rule when no band cuts; a season ending 28 February lifts on 1 March', () => {
		expect(restrictionRuleFromTriggers(table([row(0, 300_000, 'l100')]), LEVELS).rule).toBeNull();
		const r = restrictionRuleFromTriggers({ ...table([row(150_000, 300_000, 'l100'), row(0, 150_000, 'l70')]), reviewDate: '2015-11-15', seasonEnd: '2016-02-28' }, LEVELS);
		expect(r.rule!.reviewDates).toEqual(['11-15']);
		expect(r.rule!.liftDates).toEqual(['03-01']);
	});
});

describe('the outlook and its triggers run without the drought restriction rule', () => {
	const input = testCatchment();
	const rule: DroughtRestrictionRule = { reviewDates: ['01-01'], levels: [{ belowPct: 0.9, cuts: { crops: 0.5 } }] };
	const ruled = { ...input, settings: { ...input.settings, droughtRestriction: rule } };

	it('withoutDroughtRestriction drops the rule and leaves an input without one as it is', () => {
		expect(withoutDroughtRestriction(input)).toBe(input);
		expect('droughtRestriction' in withoutDroughtRestriction(ruled).settings).toBe(false);
		// The rule changes a run, so the outlooks below are the same because the rule is dropped, not by chance.
		const a = runModelWithoutChecks(ruled).series.find((s) => s.nodeId === 'a' && s.key === 'supplied')!.values;
		const b = runModelWithoutChecks(input).series.find((s) => s.nodeId === 'a' && s.key === 'supplied')!.values;
		expect(a).not.toEqual(b);
	});

	it('refuses a base run made with the rule: its history is the restricted one', () => {
		const restrictedRun = runModelWithoutChecks(ruled);
		const opts = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30', levels: LEVELS };
		expect(() => runSeasonalOutlook(ruled, { ...opts, baseRun: restrictedRun })).toThrow(/made with the drought restriction rule/);
		expect(() => runReviewTriggers(input, { reviewDate: '2013-01-01', seasonEnd: '2013-04-30', levels: LEVELS, baseRun: restrictedRun })).toThrow(/made with the drought restriction rule/);
	});

	it('the outlook and the trigger table are the ones without the rule, to the bit', () => {
		const opts = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30', levels: LEVELS };
		expect(runSeasonalOutlook(ruled, opts)).toEqual(runSeasonalOutlook(input, opts));
		const t = { reviewDate: '2013-01-01', seasonEnd: '2013-04-30', levels: LEVELS };
		expect(runReviewTriggers(ruled, t)).toEqual(runReviewTriggers(input, t));
	});
});
