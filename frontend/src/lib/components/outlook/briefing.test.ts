// The seasonal outlook's briefing (docs/ui.md § Seasonal outlook): the six
// parts and the risk line, read from an outlook the engine's own
// summariseOutlook builds from invented members, and the base run's natural
// flow before and over the season. It counts past seasons; it never advises.
import { summariseOutlook, type OutlookMember, type ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { OutlookResult } from '#lib/api/types.js';
import { levelDescription } from '#lib/format/demandLevel.js';
import { buildBriefing, levelWords, naturalContext, planMonths, volume, windowTotal } from './briefing';

const SEASON = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30' };
const MONTHS = [10, 11, 12, 1, 2, 3, 4];
const model = {
	nodes: [
		{ id: 'out', name: 'Outlet', kind: 'gauge', damCapacityM3: 0 },
		{ id: 'dam', name: 'Farm', kind: 'farm', damCapacityM3: 80_000 }
	],
	crops: [],
	cropAreas: [],
	transfers: []
} as unknown as ProjectModel;
const years = (n: number) => Array.from({ length: n }, (_, i) => 2000 + i);
const label = (wy: number) => `${wy}/${String((wy + 1) % 100).padStart(2, '0')}`;

function member(wy: number, below: number, factor: number): OutlookMember {
	return {
		waterYear: wy,
		label: label(wy),
		analogueFrom: `${wy}-10-01`,
		analogueTo: `${wy + 1}-04-30`,
		seasonEndStorageM3: 40_000,
		storageM3ByDam: { dam: 40_000 },
		farms: {},
		demandM3: 100_000 * factor,
		suppliedM3: 90_000 * factor,
		demandMet: 0.9,
		userDemandM3: 0,
		userSuppliedM3: 0,
		userDemandMet: null,
		ewrDays: { days: 212, below },
		reserve: null
	};
}

/** Levels met in full in `metIn` of 12 years each (invented). */
function result(metIn: [number, number, number], n = 12): OutlookResult {
	const analogues = years(n).map((wy) => ({ waterYear: wy, label: label(wy), from: `${wy}-10-01`, to: `${wy + 1}-04-30` }));
	const level = (id: string, l: string, factor: number, met: number) => ({ id, label: l, problems: [], members: years(n).map((wy, i) => member(wy, i < met ? 0 : 5, factor)) });
	const s = summariseOutlook({
		season: SEASON,
		model,
		analogues,
		excluded: [],
		levels: [level('a', '100 %', 1, metIn[0]), level('b', '85 %', 0.85, metIn[1]), level('c', 'Taper', 0.8, metIn[2])],
		startStorageM3: 52_000
	});
	return { ...s, failures: [] };
}

const levels = [
	{ id: 'a', label: '100 %', ops: [{ op: 'demand.scale' as const, factor: 1 }] },
	{ id: 'b', label: '85 %', ops: [{ op: 'demand.scale' as const, factor: 0.85 }] },
	{
		id: 'c',
		label: 'Taper',
		ops: [
			{ op: 'demand.scale' as const, factor: 1, months: [10, 11, 12] },
			{ op: 'demand.scale' as const, factor: 0.8, months: [1, 2, 3, 4] }
		]
	}
];
const outlook = (r: OutlookResult, triggers: unknown = null) => ({ ...SEASON, reviewDate: '2013-01-01', levels, result: r, triggers: triggers as never });

describe('volume and windows', () => {
	it('words volumes in m³ below a million and million m³ above', () => {
		expect(volume(52_000)).toBe('52 000 m³');
		expect(volume(28_500_000)).toBe('28.5 million m³');
		expect(volume(4_215_000)).toBe('4.22 million m³');
		expect(volume(145_000_000)).toBe('145 million m³');
	});
	it('totals a window of a daily series, null outside it or over a missing day', () => {
		const s = { startDate: '2000-01-01', values: [1, 2, 3, null, 5] };
		expect(windowTotal(s, '2000-01-01', '2000-01-03')).toBe(6);
		expect(windowTotal(s, '2000-01-03', '2000-01-04')).toBeNull();
		expect(windowTotal(s, '1999-12-31', '2000-01-02')).toBeNull();
		expect(windowTotal(s, '2000-01-04', '2000-01-09')).toBeNull();
	});
});

describe('naturalContext (where the season starts)', () => {
	// 13 years of natural flow from 1 Oct 1999, 10 m³/day, and 20 m³/day in Apr–Sep 2012 (the months before the season).
	const start = '1999-10-01';
	const days = (Date.parse('2013-05-01') - Date.parse(start)) / 86_400_000;
	const values = Array.from({ length: days }, (_, t) => {
		const d = new Date(Date.parse(start) + t * 86_400_000).toISOString().slice(0, 10);
		return d >= '2012-04-01' && d < '2012-10-01' ? 20 : 10;
	});
	const analogues = years(12).map((wy) => ({ from: `${wy}-10-01`, to: `${wy + 1}-04-30` }));

	it('the six months before the decision date against the same months of every earlier year: twice the median, above normal', () => {
		const { inflow } = naturalContext({ startDate: start, values }, SEASON.decisionDate, analogues);
		expect(inflow).toMatchObject({ months: 'Apr – Sep', m3: 20 * 183, ofMedian: '200 %', cls: 'above', nYears: 12 });
	});

	it('the season’s natural flow in the analogue years as they happened: median and 10–90 %', () => {
		const { season } = naturalContext({ startDate: start, values }, SEASON.decisionDate, analogues);
		expect(season).toMatchObject({ nYears: 12 });
		expect(season!.median).toMatch(/^2 1\d\d m³$/);
	});

	it('nothing to compare when the record starts at the decision date', () => {
		const { inflow, season } = naturalContext({ startDate: SEASON.decisionDate, values: [1, 2, 3] }, SEASON.decisionDate, []);
		expect(inflow).toBeNull();
		expect(season).toBeNull();
	});

	it('no class with fewer than three earlier years', () => {
		const short = { startDate: '2010-04-01', values: Array.from({ length: 1000 }, () => 5) };
		const { inflow } = naturalContext(short, SEASON.decisionDate, []);
		expect(inflow).toMatchObject({ nYears: 2, cls: null });
	});
});

describe('levels in words', () => {
	it('a plain level by its change from today, a monthly plan by its months', () => {
		expect(levelWords(levels[0]!.ops)).toBe('Today’s demand');
		expect(levelWords(levels[1]!.ops)).toBe('15 % less demand');
		expect(levelWords(levels[2]!.ops)).toBeNull();
		expect(levelDescription(120)).toBe('20 % more demand');
		expect(planMonths(levels[2]!.ops, MONTHS)?.map((m) => `${m.month} ${m.pct}`)).toEqual(['Oct 100 %', 'Nov 100 %', 'Dec 100 %', 'Jan 80 %', 'Feb 80 %', 'Mar 80 %', 'Apr 80 %']);
		expect(planMonths(levels[0]!.ops, MONTHS)).toBeNull();
	});
});

describe('buildBriefing', () => {
	it('lower risk when the highest level met the requirement in the planning share; the levels side by side', () => {
		const b = buildBriefing(outlook(result([11, 12, 12])), MONTHS);
		expect(b.risk).toMatchObject({ level: 'lower', label: 'Lower risk' });
		expect(b.risk!.text).toBe('At 100 %, the highest level run, the EWR was met in full in 11 of 12 past seasons: at least the planning share (80 %).');
		expect(b.planning).toEqual({ label: '100 %' });
		expect(b.storage).toEqual({ text: '52 000 m³', share: '65 %' });
		expect(b.levels.map((l) => [l.label, l.description, l.supplied, l.endStorage, l.endShare, l.met, l.meetsShare, l.planning])).toEqual([
			['100 %', 'Today’s demand', '90 000 m³', '40 000 m³', '50 %', '11 of 12 years', true, true],
			['85 %', '15 % less demand', '76 500 m³', '40 000 m³', '50 %', '12 of 12 years', true, false],
			['Taper', null, '72 000 m³', '40 000 m³', '50 %', '12 of 12 years', true, false]
		]);
		expect(b.levels[2]!.plan).toBe('Oct 100 %, Nov 100 %, Dec 100 %, Jan 80 %, Feb 80 %, Mar 80 %, Apr 80 %');
		expect(b.plans).toEqual([{ label: 'Taper', months: expect.arrayContaining([{ month: 'Jan', pct: '80 %' }]) }]);
	});

	it('increasing risk when only a lower level met it; high when none did', () => {
		const inc = buildBriefing(outlook(result([7, 10, 12])), MONTHS);
		expect(inc.risk).toMatchObject({ level: 'increasing' });
		expect(inc.risk!.text).toBe('At 100 %, the EWR was met in full in 7 of 12 past seasons, under the planning share (80 %); 85 % met it in 10 of 12.');
		const high = buildBriefing(outlook(result([2, 3, 4])), MONTHS);
		expect(high.risk).toMatchObject({ level: 'high' });
		expect(high.planning).toBeNull();
		expect(high.messages[0]).toBe('In past seasons from this start, no level run met the EWR in full in 80 % of the years.');
	});

	it('no risk line with too few years', () => {
		expect(buildBriefing(outlook(result([1, 2, 3], 4)), MONTHS).risk).toBeNull();
	});

	it('sets each trigger band beside the planning figure', () => {
		const row = (fromM3: number, toM3: number, lv: string | null) => ({ band: { fromM3, toM3 }, level: lv ? { id: lv, label: lv } : null });
		const triggers = { reviewDate: '2013-01-01', table: { rows: [row(50_000, 80_000, '100 %'), row(25_000, 50_000, '85 %'), row(0, 25_000, null)] } };
		const b = buildBriefing(outlook(result([7, 10, 12]), triggers), MONTHS);
		expect(b.triggers).toEqual([
			{ band: 'At or above 50 000 m³', level: '100 %', vsPlanning: 'More than the planning figure (85 %)', tone: 'above' },
			{ band: 'At or above 25 000 m³', level: '85 %', vsPlanning: 'The planning figure', tone: 'same' },
			{ band: 'Below 25 000 m³', level: null, vsPlanning: 'No level met the EWR in the planning share from this storage', tone: 'none' }
		]);
		expect(b.messages).toContain('On 1 Jan 2013 the dams’ storage is read again: the review triggers give the level that met the EWR from each band of storage.');
	});

	it('key messages count past seasons and never advise', () => {
		const b = buildBriefing(outlook(result([7, 10, 12])), MONTHS);
		expect(b.messages).toEqual([
			'In past seasons from this start, 85 % met the EWR in full in 10 of 12 years: the highest level to do so in at least 80 % of them.',
			'At 100 %, hydrological units got a median 90 % of their demand over the season (10–90 %: 90 % – 90 %).',
			'All of this is worked out from past weather, not a forecast or a promise. The WUA decides the season’s level and publishes it as the restriction notice.'
		]);
		for (const m of [[11, 12, 12], [7, 10, 12], [2, 3, 4]] as const) {
			expect(JSON.stringify(buildBriefing(outlook(result([...m])), MONTHS))).not.toMatch(/recommend|likely|should|best|optimal/i);
		}
	});
});
