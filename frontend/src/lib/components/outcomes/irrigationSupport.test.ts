import { toEpochDay } from '@water-management/engine';
import type { RunSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { SweepMember } from '#lib/api/types.js';
import {
	aboutMillion,
	axisPct,
	buildSupportView,
	equivalentHa,
	IRRIGATION_SUPPORT_MIN_YEARS,
	keyMessage,
	levelName,
	markerText,
	millionM3,
	plantedHaOf,
	spreadText,
	supportAxis,
	supportThreshold,
	type SupportLevel,
	type SupportYear
} from './irrigationSupport';
import { buildMatrixView, demandLevelOf } from './matrix';
import { resolveOutcomes } from './outcomeSettings';

const yr = (waterYear: number, naturalM3: number, met: boolean): SupportYear => ({ waterYear, label: `${waterYear}/${String((waterYear + 1) % 100).padStart(2, '0')}`, naturalM3, met });
/** Years 2000… with these volumes (million m³) and verdicts. */
const record = (vols: number[], met: (v: number, i: number) => boolean) => vols.map((v, i) => yr(2000 + i, v * 1e6, met(v, i)));
const TEN = [3, 9, 1, 7, 5, 10, 2, 8, 4, 6];

describe('supportThreshold', () => {
	it('is the wettest failing year, with the next wetter year (which met) as the spread', () => {
		const r = supportThreshold(record(TEN, (v) => v > 4));
		expect(r.kind).toBe('threshold');
		if (r.kind !== 'threshold') return;
		expect(r.thresholdM3).toBe(4e6);
		expect(r.wettestFailed.waterYear).toBe(2008);
		expect(r.nextMet.naturalM3).toBe(5e6);
		expect([r.failed, r.met, r.metAtOrBelow]).toEqual([4, 6, 0]);
	});

	it('takes the wettest failure when drier years met it anyway (timing), and counts them', () => {
		// 2 and 3 met, 4 and 6 failed: breaches reach 6, and two years at or below it met.
		const r = supportThreshold(record(TEN, (v) => ![1, 4, 6].includes(v)));
		expect(r.kind).toBe('threshold');
		if (r.kind !== 'threshold') return;
		expect(r.thresholdM3).toBe(6e6);
		expect(r.nextMet.naturalM3).toBe(7e6);
		expect(r.metAtOrBelow).toBe(3);
		expect(spreadText(r)).toBe('between 2009/10 (6.00, not met) and 2003/04 (7.00, met); 3 drier or equal years met it anyway');
	});

	it('never splits equal volumes: a tie with a failing year counts as met at or below, and the next met year is strictly wetter', () => {
		const years = [...record(TEN, (v) => v > 5), yr(2020, 5e6, true), yr(2021, 5e6, false)];
		const r = supportThreshold(years);
		expect(r.kind).toBe('threshold');
		if (r.kind !== 'threshold') return;
		expect(r.thresholdM3).toBe(5e6);
		expect(r.nextMet.naturalM3).toBe(6e6);
		expect(r.metAtOrBelow).toBe(1);
		// Independent of input order.
		expect(supportThreshold([...years].reverse())).toEqual(r);
	});

	it('draws no marker when no year failed', () => {
		const r = supportThreshold(record(TEN, () => true));
		expect(r).toEqual({ kind: 'neverFailed', driest: expect.objectContaining({ naturalM3: 1e6 }), met: 10 });
		expect(markerText(r)).toBe('Met in every year: no breach to mark');
	});

	it('draws no marker when every year failed, or the wettest did', () => {
		expect(supportThreshold(record(TEN, () => false)).kind).toBe('wettestFailed');
		const r = supportThreshold(record(TEN, (v) => v === 3));
		expect(r).toEqual({ kind: 'wettestFailed', wettest: expect.objectContaining({ naturalM3: 10e6 }), failed: 9, met: 1 });
		expect(markerText(r)).toBe('Not met even in the wettest year: no marker');
		expect(spreadText(r)).toBe('–');
	});

	it('needs IRRIGATION_SUPPORT_MIN_YEARS years', () => {
		expect(IRRIGATION_SUPPORT_MIN_YEARS).toBe(9);
		const eight = record(TEN.slice(0, 8), (v) => v > 4);
		expect(supportThreshold(eight)).toEqual({ kind: 'tooFewYears', nYears: 8 });
		expect(supportThreshold(record(TEN.slice(0, 9), (v) => v > 4)).kind).toBe('threshold');
	});
});

describe('numbers in words', () => {
	it('rounds "about" to two significant figures in million m³', () => {
		expect(aboutMillion(12_345_678)).toBe('12');
		expect(aboutMillion(1_234_567)).toBe('1.2');
		expect(aboutMillion(456_789)).toBe('0.46');
		expect(aboutMillion(196_000_000)).toBe('200');
		expect(aboutMillion(0)).toBe('0');
		expect(millionM3(12_345_678)).toBe('12.3');
		expect(millionM3(1_234_567)).toBe('1.23');
		expect(millionM3(123_456_789)).toBe('123');
	});

	it('names levels against today and gives the equivalent area', () => {
		expect([100, 85, 70, 92.5, 120].map(levelName)).toEqual(['Today’s irrigation', '15 % less irrigation', '30 % less irrigation', '7.5 % less irrigation', '20 % more irrigation']);
		expect(equivalentHa(85, 1200)).toBe(1020);
		expect(equivalentHa(85, 0)).toBeNull();
		expect(equivalentHa(85, null)).toBeNull();
	});

	it('reads the planted area from the run’s model', () => {
		expect(plantedHaOf({ cropAreas: [{ areaM2: 6_000_000 }, { areaM2: 6_000_000 }] })).toBe(1200);
		expect(plantedHaOf({ cropAreas: [] })).toBeNull();
		expect(plantedHaOf({})).toBeNull();
		expect(plantedHaOf(undefined)).toBeNull();
	});

	it('makes a round axis from 0 past the wettest year', () => {
		const a = supportAxis(387e6, 150e6);
		expect(a.maxM3).toBe(400e6);
		expect(a.ticks).toEqual([0, 50e6, 100e6, 150e6, 200e6, 250e6, 300e6, 350e6, 400e6]);
		const b = supportAxis(9.6e6, 4e6);
		expect(b.maxM3).toBe(10e6);
		expect(b.ticks.length).toBeGreaterThanOrEqual(4);
		expect(b.ticks.length).toBeLessThanOrEqual(9);
		expect(axisPct(5e6, b)).toBe(50);
		expect(axisPct(20e6, b)).toBe(100);
	});
});

const lvl = (pct: number, result: SupportLevel['result'], ha: string | null = null): SupportLevel => ({ id: `l${pct}`, pct, name: levelName(pct), haLabel: ha, years: [], result });
const thr = (m: number) => supportThreshold(record(TEN.map((v) => (v * m) / 4), (v) => v > m)) as SupportLevel['result'];

describe('keyMessage', () => {
	it('words today’s threshold, then each lower level against it, from the numbers', () => {
		const m = keyMessage([lvl(100, thr(4), '≈ 1 200 ha'), lvl(85, thr(3), '≈ 1 020 ha'), lvl(70, thr(2), '≈ 840 ha')], 10);
		expect(m).toBe(
			'At today’s irrigation demand (≈ 1 200 ha planted), the river’s requirement was not met in some years with about 4 million m³ of natural water or less, and was met in every wetter year. ' +
				'At 15 % less irrigation (≈ 1 020 ha) it falls to about 3 million m³ and at 30 % less irrigation (≈ 840 ha) it falls to about 2 million m³.'
		);
	});

	it('says when a level never failed, stays, or rises, and never recommends', () => {
		const m = keyMessage([lvl(100, thr(4)), lvl(85, thr(4)), lvl(70, supportThreshold(record(TEN, () => true)))], 10);
		expect(m).toContain('At 15 % less irrigation it stays at about 4 million m³');
		expect(m).toContain('at 30 % less irrigation it was met in every year.');
		expect(keyMessage([lvl(100, thr(3)), lvl(80, thr(4))], 10)).toContain('it rises to about 4 million m³');
		expect(m).not.toMatch(/recommend|should|safe/i);
	});

	it('lets levels that did the same share a clause, so a 12-level sweep stays short', () => {
		const levels = [120, 110, 100, 95, 90, 85, 80, 75, 70, 60, 50, 40].map((p) => lvl(p, p === 40 ? supportThreshold(record(TEN, () => true)) : thr(4), `≈ ${p} ha`));
		const m = keyMessage(levels, 30);
		expect(m).toMatch(/^At today’s irrigation demand \(≈ 100 ha planted\), /);
		expect(m).toContain('At 10 levels from 20 % more irrigation to 50 % less irrigation it stays at about 4 million m³ and at 60 % less irrigation (≈ 40 ha) it was met in every year.');
		const same = keyMessage([lvl(100, thr(4)), ...[90, 80, 70, 60].map((p) => lvl(p, thr(4)))], 10);
		expect(same).toContain('At every other level (4, from 10 % less irrigation to 40 % less irrigation) it stays at about 4 million m³.');
		expect(keyMessage([lvl(100, thr(4)), lvl(90, thr(3)), lvl(80, thr(3))], 10)).toContain('At 10 % less irrigation and 20 % less irrigation it falls to about 3 million m³.');
	});

	it('uses the first level without a 100 % one, and says when there are too few years', () => {
		expect(keyMessage([lvl(90, thr(4)), lvl(80, thr(3))], 10)).toMatch(/^At 10 % less irrigation, the river’s requirement/);
		expect(keyMessage([lvl(100, { kind: 'tooFewYears', nYears: 5 })], 5)).toBe('Only 5 complete water years in the record: too few to say where breaches begin (it takes 9).');
		expect(keyMessage([], 10)).toMatch(/nothing to compare/);
	});
});

// End to end from a stored sweep, through the outcome matrix's own view model, so the two read the same years.
const START = '2010-10-01';
const YEARS = 10;
const yearStarts = Array.from({ length: YEARS + 1 }, (_, i) => toEpochDay(`${2010 + i}-10-01`) - toEpochDay(START));
const DAYS = yearStarts[YEARS]!;
const yearOf = (t: number) => yearStarts.findIndex((s, i) => t >= s && t < yearStarts[i + 1]!);
/** Year i's flow: 1000 × (i + 1) m³/day, so the years rank driest (2010/11) to wettest. */
const natural = Array.from({ length: DAYS }, (_, t) => 1000 * (yearOf(t) + 1));
const yearTotal = (i: number) => 1000 * (i + 1) * (yearStarts[i + 1]! - yearStarts[i]!);

function member(position: number, factor: number, failsBelowYear: number, status: SweepMember['status'] = 'done'): SweepMember {
	return {
		id: `m${position}`,
		position,
		name: `${factor * 100} %`,
		ops: [{ op: 'demand.scale', factor }],
		opsSha256: '0'.repeat(64),
		status,
		problems: status === 'problems' ? ['No unit to scale.'] : [],
		startDate: START,
		endDate: null,
		finishedAt: null,
		summary: {} as unknown as RunSummary,
		series: [
			{ nodeId: null, key: 'natural_flow', label: 'Natural flow', unit: 'm³/day', values: natural },
			// One day below the EWR in each year before `failsBelowYear`, none after.
			{ nodeId: null, key: 'ewr_shortfall', label: 'EWR shortfall', unit: 'm³/day', values: Array.from({ length: DAYS }, (_, t) => (yearOf(t) < failsBelowYear && t === yearStarts[yearOf(t)]! ? -5 : 0)) }
		]
	};
}

function boardOf(members: SweepMember[], plantedHa: number | null = 1200, fullAllocation = false) {
	const v = buildMatrixView({ baseStartDate: START, baseNatural: natural, members, settings: resolveOutcomes({}) });
	return buildSupportView({ matrix: v.outcome!, classes: v.classes, members: members.map((m) => ({ id: m.id, pct: demandLevelOf(m)!, done: m.status === 'done' })), plantedHa, fullAllocation });
}

describe('buildSupportView', () => {
	it('reads each level’s threshold from the matrix’s years, under any TZ', () => {
		expect(process.env.TZ).toBeTruthy(); // the suite runs under a skewed TZ (vitest config)
		const b = boardOf([member(0, 1, 6), member(1, 0.85, 4), member(2, 0.7, 2)]);
		expect(b.nYears).toBe(10);
		expect(b.levels.map((l) => [l.name, l.haLabel, l.result.kind === 'threshold' ? l.result.thresholdM3 : null])).toEqual([
			['Today’s irrigation', '≈ 1 200 ha', yearTotal(5)],
			['15 % less irrigation', '≈ 1 020 ha', yearTotal(3)],
			['30 % less irrigation', '≈ 840 ha', yearTotal(1)]
		]);
		expect(b.levels[0]!.years.map((y) => y.label)).toEqual(['2010/11', '2011/12', '2012/13', '2013/14', '2014/15', '2015/16', '2016/17', '2017/18', '2018/19', '2019/20']);
		expect(b.axis!.maxM3).toBeGreaterThanOrEqual(yearTotal(9));
		expect(b.axis!.meanM3).toBeCloseTo(Array.from({ length: 10 }, (_, i) => yearTotal(i)).reduce((s, v) => s + v, 0) / 10, 3);
		expect(b.notes).toEqual([]);
		expect(b.keyMessage).toMatch(/^At today’s irrigation demand \(≈ 1 200 ha planted\)/);
	});

	it('notes a lower level whose breaches reach wetter years, without smoothing it', () => {
		const b = boardOf([member(0, 1, 3), member(1, 0.7, 5)]);
		expect(b.levels.map((l) => (l.result.kind === 'threshold' ? l.result.thresholdM3 : null))).toEqual([yearTotal(2), yearTotal(4)]);
		expect(b.notes).toHaveLength(1);
		expect(b.notes[0]).toMatch(/^30 % less irrigation breaches start in wetter years than at today’s irrigation/);
	});

	it('names a member that didn’t run instead of drawing it, and drops the area without one or on a full-allocation run', () => {
		const b = boardOf([member(0, 1, 6), member(1, 0.85, 4, 'problems')], null);
		expect(b.levels.map((l) => l.id)).toEqual(['m0']);
		expect(b.notRun).toEqual([{ id: 'm1', name: '15 % less irrigation' }]);
		expect(b.levels[0]!.haLabel).toBeNull();
		expect(boardOf([member(0, 1, 6)], 1200, true).levels[0]!.haLabel).toBeNull();
	});
});
