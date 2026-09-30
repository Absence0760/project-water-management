// The review triggers' view model (issue #53 R6): an outlook's stored table
// in words, from a table the engine drew on its invented test catchment.
import { describe, expect, it } from 'vitest';
import type { OutlookTriggerTable, OutlookTriggers } from '$lib/api/types';
import { buildTriggersView, triggerRuleView } from './triggers';

const lvl = (levelId: string, yearsMet: number, meets: boolean) => ({ levelId, label: `${levelId} %`, yearsMet, nYears: 12, meets, seasonEndStorageM3: null, demandMet: null });
/** A hand-made table in the engine's shape: three bands over 90 000 m³, fullest first (invented). */
const table = {
	reviewDate: '2013-01-01',
	seasonEnd: '2013-04-30',
	days: 120,
	metric: 'daysBelowEwr',
	capacityM3: 90_000,
	representative: 'lowerEdge',
	bandSource: 'historicalTerciles',
	history: [],
	lowestOnRecordM3: 12_000,
	share: 0.8,
	shareIsDefault: true,
	nYears: 12,
	enoughYears: true,
	rows: [
		{ band: { fromM3: 60_000, toM3: 90_000 }, startStorageM3: 60_000, storageM3ByDam: {}, level: { id: '100', label: '100 %' }, reason: 'met', metYears: 11, nYears: 12, perLevel: [lvl('100', 11, true), lvl('70', 12, true)] },
		{ band: { fromM3: 30_000, toM3: 60_000 }, startStorageM3: 30_000, storageM3ByDam: {}, level: { id: '70', label: '70 %' }, reason: 'met', metYears: 10, nYears: 12, perLevel: [lvl('100', 7, false), lvl('70', 10, true)] },
		{ band: { fromM3: 0, toM3: 30_000 }, startStorageM3: 12_000, storageM3ByDam: {}, startFrom: 'lowestOnRecord', level: null, reason: 'noLevelMeets', metYears: null, nYears: 12, perLevel: [lvl('100', 3, false), lvl('70', 6, false)] }
	],
	monotone: true,
	notes: [],
	warnings: []
} as unknown as OutlookTriggerTable;
const stored: OutlookTriggers = { reviewDate: '2014-01-01', table, problem: null, excluded: [{ waterYear: 2012, reason: 'theSeason' }], failures: [] };

describe('buildTriggersView', () => {
	it('an outlook without a review date has no table', () => {
		expect(buildTriggersView({ triggers: null })).toEqual({ kind: 'none' });
		expect(buildTriggersView({})).toEqual({ kind: 'none' });
	});

	it('says why a table couldn’t be drawn', () => {
		expect(buildTriggersView({ triggers: { ...stored, table: null, problem: 'review triggers need a farm dam' } })).toEqual({ kind: 'notDrawn', reviewDate: '1 Jan 2014', problem: 'review triggers need a farm dam' });
	});

	it('words each band, fullest first, with the engine’s sentence, and never advises', () => {
		const v = buildTriggersView({ triggers: stored });
		if (v.kind !== 'table') throw new Error(v.kind);
		expect(v.reviewDate).toBe('1 Jan 2014');
		expect(v.ranOn).toBe('1 Jan 2013');
		expect(v.rows.map((r) => [r.band, r.fromShare, r.level, r.met])).toEqual([
			['At or above 60\u202f000 m³', '67 %', '100 %', '11 of 12 years'],
			['At or above 30\u202f000 m³', '33 %', '70 %', '10 of 12 years'],
			['Below 30\u202f000 m³', '0 %', null, '–']
		]);
		expect(v.rows[0]!.words).toBe('At or above 60\u202f000 m³ on 1 January 2013: 100 % met the EWR on every day of the season in 11 of 12 analogue years.');
		expect(v.rows[2]!.words).toMatch(/^Below 30\u202f000 m³ on 1 January 2013 \(run from the lowest storage on record for the date, 12\u202f000 m³\): no demand level/);
		expect(v.rows[1]!.perLevel).toEqual([
			{ label: '100 %', met: '7 of 12', meets: false },
			{ label: '70 %', met: '10 of 12', meets: true }
		]);
		// Its own season isn't listed as left out: it never was an analogue.
		expect(v.excluded).toEqual([]);
		expect(JSON.stringify(v)).not.toMatch(/recommend|likely|should|best|optimal/i);
	});
});

describe('triggerRuleView (engine 1.46.0, WP-3.8)', () => {
	const levels = [
		{ id: '100', label: '100 %', ops: [{ op: 'demand.scale' as const, factor: 1 }] },
		{ id: '70', label: '70 %', ops: [{ op: 'demand.scale' as const, factor: 0.7 }] }
	];
	it('is null without a table', () => {
		expect(triggerRuleView({ triggers: null, levels })).toBeNull();
		expect(triggerRuleView({ triggers: { ...stored, table: null }, levels })).toBeNull();
	});
	it('turns the table into the rule: reviewed on the review date, lifted the day after the season, a level per band that cuts', () => {
		const v = triggerRuleView({ triggers: stored, levels })!;
		expect(v.rule!.reviewDates).toEqual(['01-01']);
		expect(v.rule!.liftDates).toEqual(['05-01']);
		// 70 % below 60 000 of 90 000 m³ (two thirds); the band where no level met the rule keeps it, for the WUA to decide.
		expect(v.rule!.levels).toHaveLength(1);
		expect(v.rule!.levels[0]!.belowPct).toBeCloseTo(2 / 3, 12);
		expect(v.words).toMatch(/^reviewed 1 Jan, lifted 1 May; 70 % \(below 66\.7 %\): crops 30 %/);
		expect(v.notes.join('\n')).toMatch(/no demand level met the planning rule/);
	});
});
