import { droughtRestrictionIssues, RESTRICTION_DATES_MAX, RESTRICTION_LEVELS_MAX } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { joinMonthDay, noticeDay, PART_LABEL, restrictionFormError, restrictionProblemAt, splitMonthDay, startingRule, withCut, withDateAdded, withLevelAdded } from './droughtRestriction';

describe('the drought restriction form (engine 1.54.0, WP-3.8)', () => {
	it('starts from a rule the engine accepts: reviews on 1 October and 1 January, lifted 1 May, three deepening levels', () => {
		const r = startingRule();
		expect(droughtRestrictionIssues(r)).toEqual([]);
		expect(r.reviewDates).toEqual(['10-01', '01-01']);
		expect(r.levels.map((l) => l.belowPct)).toEqual([0.6, 0.4, 0.25]);
		// People's water is cut least.
		for (const l of r.levels) expect(l.cuts.domestic!).toBeLessThan(l.cuts.crops!);
	});

	it('names the rule’s first problem where it is, and none for a good rule or off', () => {
		expect(restrictionFormError(null)).toBeNull();
		expect(restrictionFormError(startingRule())).toBeNull();
		expect(restrictionFormError({ ...startingRule(), reviewDates: [] })).toBe('Review dates: needs at least one review date.');
		expect(restrictionFormError({ ...startingRule(), liftDates: ['10-01'] })).toMatch(/^Lift dates: 1 Oct is both a review date and a lift date\.$/);
		const shallower = startingRule();
		shallower.levels[1]!.belowPct = 0.7;
		expect(restrictionFormError(shallower)).toMatch(/^Level 2: level 2 must start below level 1's 60 %/);
		const less = startingRule();
		less.levels[2]!.cuts.crops = 0.1;
		expect(restrictionFormError(less)).toMatch(/^Level 3: level 3 cuts crops less than level 2/);
	});

	it('says where the first problem is fixed, so the form can show it there', () => {
		expect(restrictionProblemAt(null)).toBeNull();
		expect(restrictionProblemAt(startingRule())).toBeNull();
		expect(restrictionProblemAt({ ...startingRule(), reviewDates: [] })).toBe('reviewDates');
		expect(restrictionProblemAt({ ...startingRule(), liftDates: ['10-01'] })).toBe('liftDates');
		const shallower = startingRule();
		shallower.levels[1]!.belowPct = 0.7;
		expect(restrictionProblemAt(shallower)).toBe('level-1');
	});

	it('edits dates, levels and cuts', () => {
		expect(splitMonthDay('10-05')).toEqual({ month: 10, day: 5 });
		expect(joinMonthDay(1, 9)).toBe('01-09');
		expect(withDateAdded(['01-01'])).toEqual(['01-01', '02-01']);
		const full = Array.from({ length: RESTRICTION_DATES_MAX }, (_, m) => joinMonthDay(m + 1, 1));
		expect(withDateAdded(full)).toEqual(full);
		const levels = withLevelAdded(startingRule().levels);
		expect(levels).toHaveLength(4);
		expect(levels[3]).toEqual({ label: 'Level 4', belowPct: 0.13, cuts: startingRule().levels[2]!.cuts });
		expect(droughtRestrictionIssues({ ...startingRule(), levels })).toEqual([]);
		let six = levels;
		while (six.length < RESTRICTION_LEVELS_MAX) six = withLevelAdded(six);
		expect(withLevelAdded(six)).toHaveLength(RESTRICTION_LEVELS_MAX);
		const l = startingRule().levels[0]!;
		expect(withCut(l, 'livestock', 0.15).cuts.livestock).toBe(0.15);
		expect('crops' in withCut(l, 'crops', null).cuts).toBe(false);
		expect(PART_LABEL.crops).toBe('Crops (irrigation of the crop areas)');
		expect(PART_LABEL.municipal).toBe('Municipal (town) demand objects');
	});
});

describe('the published notice’s day (engine 1.54.0)', () => {
	it('is the day in the project’s time zone, not the timestamp’s UTC day', () => {
		// 00:30 on 3 November in Johannesburg is 22:30 on the 2nd in UTC.
		expect(noticeDay('2026-11-02T22:30:00Z', 'Africa/Johannesburg')).toBe('2026-11-03');
		expect(noticeDay('2026-11-03T08:00:00Z', 'Africa/Johannesburg')).toBe('2026-11-03');
		expect(noticeDay('2026-11-03T08:00:00Z', 'Pacific/Auckland')).toBe('2026-11-03');
		expect(noticeDay('2026-11-03T12:00:00Z', 'Pacific/Auckland')).toBe('2026-11-04');
	});
});
