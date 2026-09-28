// The seasonal outlook screen's view model (issue #53 R5): the request the
// editor's levels and monthly plan make, where an outlook stands, the stored
// result in words (the engine's numbers, formatted), the pending badges, too
// few years, and never a word of advice. The result is built with the
// engine's own summariseOutlook from invented members, as the backend's job
// stores it.
import { summariseOutlook, type OutlookMember, type ProjectModel } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { OutlookResult, OutlookSettings } from '$lib/api/types';
import { outlookError, resolveOutlook } from './settings';
import { buildOutlookView, monthlyPlanOps, outlookRequest, outlookState, parseLevels, seasonMonths } from './view';

const SEASON = { decisionDate: '2012-10-01', seasonEnd: '2013-04-30' };
const DEFAULTS: OutlookSettings = { season: null, planningShare: null };
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
function member(wy: number, below: number, factor: number): OutlookMember {
	return {
		waterYear: wy,
		label: `${wy}/${String((wy + 1) % 100).padStart(2, '0')}`,
		analogueFrom: `${wy}-10-01`,
		analogueTo: `${wy + 1}-04-30`,
		seasonEndStorageM3: 40_000 + (wy - 2000) * 1000 * (1.2 - factor),
		storageM3ByDam: { dam: 40_000 },
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

/** 100 % meets the EWR in 7 of n years, 85 % in 9, 70 % in every one (invented). */
function result(n = 12, planningShare?: number): OutlookResult {
	const analogues = years(n).map((wy) => ({ waterYear: wy, label: `${wy}/${String((wy + 1) % 100).padStart(2, '0')}`, from: `${wy}-10-01`, to: `${wy + 1}-04-30` }));
	const level = (id: string, label: string, factor: number, metIn: number) => ({
		id,
		label,
		problems: [],
		members: years(n).map((wy, i) => member(wy, i < metIn ? 0 : 5 + i, factor))
	});
	const s = summariseOutlook({
		season: SEASON,
		model,
		analogues,
		excluded: [{ waterYear: 1999, reason: 'outsideRecord' }],
		levels: [level('0', '100 %', 1, 7), level('1', '85 %', 0.85, 9), level('2', '70 %', 0.7, n), { id: '3', label: 'Gone', problems: ['op 1 (demand.scale): node x not found'], members: [] }],
		startStorageM3: 52_000,
		...(planningShare !== undefined ? { planningShare } : {})
	});
	return { ...s, excluded: [...s.excluded, { waterYear: 1980, reason: 'overLimit' }], failures: [] };
}

describe('the request', () => {
	it('parses demand levels in order, refusing duplicates, out-of-range and too many (fewer with a monthly plan)', () => {
		expect(parseLevels('100, 85, 70')).toEqual({ levels: [100, 85, 70], error: null });
		expect(parseLevels('100% 92.5;60')).toEqual({ levels: [100, 92.5, 60], error: null });
		expect(parseLevels('').error).toMatch(/at least one/);
		expect(parseLevels('100, 100').error).toBe('100 % is listed twice.');
		expect(parseLevels('201').error).toMatch(/from 0 to 200 %/);
		expect(parseLevels('100 90 80 70 60 50 40').error).toBe('An outlook has at most 6 demand levels.');
		expect(parseLevels('100 90 80 70 60 50', 5).error).toBe('An outlook has at most 6 demand levels, the monthly plan included.');
	});

	it('the season’s months, in order, across the new year or not', () => {
		expect(seasonMonths(null)).toEqual([10, 11, 12, 1, 2, 3, 4]);
		expect(seasonMonths({ startMonth: 3, startDay: 1, endMonth: 8, endDay: 31 })).toEqual([3, 4, 5, 6, 7, 8]);
		expect(seasonMonths({ startMonth: 5, startDay: 1, endMonth: 5, endDay: 20 })).toEqual([5]);
		expect(seasonMonths({ startMonth: 5, startDay: 15, endMonth: 5, endDay: 14 })).toHaveLength(12);
	});

	it('a monthly plan is R1’s months form, one demand.scale per level; a month out of range is refused', () => {
		const months = [10, 11, 12, 1, 2, 3, 4];
		const pcts = { 10: 100, 11: 100, 12: 90, 1: 80, 2: 80, 3: 80, 4: 90 };
		expect(monthlyPlanOps(pcts, months)).toEqual({
			ops: [
				{ op: 'demand.scale', factor: 1, months: [10, 11] },
				{ op: 'demand.scale', factor: 0.9, months: [12, 4] },
				{ op: 'demand.scale', factor: 0.8, months: [1, 2, 3] }
			],
			error: null
		});
		expect(monthlyPlanOps({ ...pcts, 2: 250 }, months).error).toBe('Feb: enter a level from 0 to 200 %.');
	});

	it('one level per demand level, one op each, plus the plan; the season and share are left to the project’s settings', () => {
		const plan = { label: 'Taper', ops: [{ op: 'demand.scale' as const, factor: 0.8, months: [1, 2] }] };
		const r = outlookRequest('run', [100, 85], plan);
		expect(r).toEqual({
			name: 'Seasonal outlook 100 % / 85 % / Taper',
			baseRunId: 'run',
			levels: [
				{ label: '100 %', ops: [{ op: 'demand.scale', factor: 1 }] },
				{ label: '85 %', ops: [{ op: 'demand.scale', factor: 0.85 }] },
				plan
			]
		});
		expect(r).not.toHaveProperty('decisionDate');
		expect(r).not.toHaveProperty('planningShare');
	});
});

describe('outlookState', () => {
	const job = (status: string, extra = {}) => ({ id: 'j', status, error: null, progress: null, ...extra }) as never;
	it('follows the outlook’s status and its job’s', () => {
		expect(outlookState({ status: 'complete', job: null })).toEqual({ kind: 'complete' });
		expect(outlookState({ status: 'pending', job: job('queued') })).toMatchObject({ kind: 'pending', text: 'Queued: waiting for the background worker.' });
		expect(outlookState({ status: 'pending', job: job('running', { progress: 40 }) })).toMatchObject({ kind: 'pending', progress: 40 });
		expect(outlookState({ status: 'pending', job: job('dead', { error: 'no rain' }) })).toEqual({ kind: 'stuck', text: 'This outlook could not run: no rain' });
		expect(outlookState({ status: 'pending', job: null }).kind).toBe('stuck');
	});
});

describe('buildOutlookView', () => {
	it('each level’s medians and 10–90 % ranges as the engine summarised them, the planning figure in its words, and the level that didn’t run', () => {
		const r = result();
		const v = buildOutlookView({ ...SEASON, result: r });
		expect(v.season).toBe('1 Oct 2012 – 30 Apr 2013 (212 days)');
		expect(v.metricLabel).toBe('Days below the pragmatic EWR at the outlet');
		expect(v.ewrHeading).toBe('Days below the EWR');
		expect(v.nYears).toBe(12);
		expect(v.tooFewYears).toBeNull();
		expect(v.start).toBe('The units’ dams held 52\u202f000 m³ of 80\u202f000 m³ at the end of 30 Sep 2012: every year starts from there.');
		const [l100, l85, l70, gone] = v.rows;
		const s = r.levels[0]!.seasonEndStorageM3!;
		expect(l100).toMatchObject({ label: '100 %', kind: 'ran', nYears: 12, yearsMet: 'EWR met on every day in 7 of 12 years' });
		expect(l100!.storage).toEqual({ median: `${Math.round(s.p50).toLocaleString('en-US').replace(/,/g, '\u202f')} m³`, band: `${Math.round(s.p10).toLocaleString('en-US').replace(/,/g, '\u202f')} m³ – ${Math.round(s.p90).toLocaleString('en-US').replace(/,/g, '\u202f')} m³` });
		expect(l100!.demandMet).toEqual({ median: '90 %', band: '90 % – 90 %' });
		// 85 % meets in 9 of 12 (75 %), under the default 80 %; 70 % in all 12: the planning figure.
		expect(l85!.planning).toBe(false);
		expect(l70).toMatchObject({ planning: true, yearsMet: 'EWR met on every day in 12 of 12 years' });
		expect(l70!.ewr).toEqual({ median: '0 %', band: '0 % – 0 %' });
		expect(gone).toMatchObject({ kind: 'notRun', problems: ['op 1 (demand.scale): node x not found'] });
		expect(v.planning).toBe('70 %: met the EWR on every day of the season in 12 of 12 analogue years, the highest demand level to do so in at least 80 % of them.');
		expect(v.excluded).toEqual(['1999/00 (its season is not all in the record)', '1980/81 (older than the newest 40 years)']);
		expect(v.warnings).toContain('Gone: not run (op 1 (demand.scale): node x not found)');
		// The per-year table: one column per level that ran.
		expect(v.yearColumns).toEqual(['100 %', '85 %', '70 %']);
		expect(v.years).toHaveLength(12);
		expect(v.years[0]!.cells[0]).toMatchObject({ ewr: '0 days below', met: true });
		expect(v.years[11]!.cells[0]).toMatchObject({ ewr: '16 days below', met: false });
	});

	it('shows the planning share the outlook ran, the default or the project’s, with no pending badge (O3, O6 confirmed, issue #90)', () => {
		const byDefault = buildOutlookView({ ...SEASON, result: result() });
		expect(byDefault.share).toBe('80 % of analogue years');
		expect(byDefault).not.toHaveProperty('seasonPending');
		expect(byDefault).not.toHaveProperty('sharePending');
		const chosen = buildOutlookView({ ...SEASON, result: result(12, 0.7) });
		expect(chosen.share).toBe('70 % of analogue years');
		// 85 % meets in 9 of 12 = 75 %: at a 70 % share it is the planning figure.
		expect(chosen.rows[1]!.planning).toBe(true);
	});

	it('with too few years: no ranges and no planning figure, and it says why', () => {
		const v = buildOutlookView({ ...SEASON, result: result(4) });
		expect(v.enoughYears).toBe(false);
		expect(v.tooFewYears).toBe('Only 4 analogue years: at least 10 are needed for the 10–90 % range and a planning figure, so only each year’s values are shown.');
		expect(v.rows[0]!.storage).toEqual({ median: '–', band: '' });
		expect(v.rows.some((r) => r.planning)).toBe(false);
		expect(v.planning).toMatch(/^Only 4 analogue years in the record: not enough to judge/);
		expect(v.years).toHaveLength(4);
	});

	it('never words a result as the app choosing or advising a level', () => {
		for (const r of [result(), result(4), result(12, 1)]) {
			const words = JSON.stringify(buildOutlookView({ ...SEASON, result: r }));
			expect(words).not.toMatch(/recommend|likely|should|best|optimal/i);
		}
	});
});

describe('settings.outlook in the form', () => {
	it('fills the defaults for an older API, copies what it is given, and blocks Save as the backend refuses', () => {
		expect(resolveOutlook({})).toEqual(DEFAULTS);
		const season = { startMonth: 11, startDay: 15, endMonth: 3, endDay: 31 };
		const r = resolveOutlook({ outlook: { season, planningShare: 0.7 } });
		expect(r).toEqual({ season, planningShare: 0.7 });
		expect(r.season).not.toBe(season);
		expect(outlookError(DEFAULTS)).toBeNull();
		expect(outlookError({ season, planningShare: 1 })).toBeNull();
		expect(outlookError({ season: { ...season, endMonth: 2, endDay: 29 }, planningShare: null })).toMatch(/season end .*\(29 February/);
		expect(outlookError({ season: { ...season, startDay: 31, startMonth: 11 }, planningShare: null })).toMatch(/decision date/);
		expect(outlookError({ season: { startMonth: 4, startDay: 1, endMonth: 4, endDay: 1 }, planningShare: null })).toMatch(/at least two days/);
		expect(outlookError({ season: null, planningShare: 0 })).toMatch(/planning share/);
		expect(outlookError({ season: null, planningShare: 1.2 })).toMatch(/planning share/);
	});
});
