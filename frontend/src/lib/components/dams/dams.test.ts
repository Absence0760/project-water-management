import { describe, expect, it } from 'vitest';
import type { DamLevel } from '$lib/components/overview/damLevels';
import { changeWords, damCards, damsSummary, fmtVolume, modelDams, pickDam, storageChartSeries, storageSpark } from './dams';

const level = (nodeId: string, endPct: number, over: Partial<DamLevel> = {}): DamLevel => ({
	nodeId,
	name: nodeId,
	capacityM3: 1000,
	minPct: 0,
	endPct,
	endDate: '2022-01-28',
	lowPct: endPct,
	lowDate: '2022-01-01',
	daysAtMin: 0,
	agoPct: null,
	...over
});

const nodes = [
	{ id: 'g', name: 'Outflow gauge', kind: 'gauge', damCapacityM3: 0 },
	{ id: 'a', name: 'Upper farm', kind: 'farm', damCapacityM3: 150_000, damMinPct: 0.1 },
	{ id: 'b', name: 'Lower farm', kind: 'farm', damCapacityM3: 90_000 },
	{ id: 'w', name: 'Weir', kind: 'gauge', damCapacityM3: 5_000 }
];

describe('modelDams', () => {
	it('keeps farms with a capacity of at least 1 m³, in node order (a gauge’s capacity is inert in the engine)', () => {
		expect(modelDams(nodes)).toEqual([
			{ nodeId: 'a', name: 'Upper farm', capacityM3: 150_000, minPct: 10, farm: true },
			{ nodeId: 'b', name: 'Lower farm', capacityM3: 90_000, minPct: 0, farm: true }
		]);
		expect(modelDams([{ id: 'x', name: '', kind: 'farm', damCapacityM3: 0.5 }])).toEqual([]);
	});
});

describe('damCards', () => {
	it('puts the dams with levels first, in their order, then the rest in node order', () => {
		const cards = damCards(nodes, [level('b', 20), level('a', 60, { capacityM3: 140_000 })]);
		expect(cards.map((c) => c.nodeId)).toEqual(['b', 'a']);
		// The run's capacity, not the live model's (it was edited since).
		expect(cards[1]).toMatchObject({ name: 'Upper farm', capacityM3: 140_000, farm: true });
		const later = damCards([...nodes, { id: 'c', name: 'New farm', kind: 'farm', damCapacityM3: 5_000 }], [level('b', 20)]);
		expect(later.map((c) => [c.nodeId, c.level?.endPct ?? null])).toEqual([
			['b', 20],
			['a', null],
			['c', null]
		]);
	});

	it('before a run, every dam in node order with its capacity and no level', () => {
		expect(damCards(nodes, []).map((c) => [c.nodeId, c.capacityM3, c.level])).toEqual([
			['a', 150_000, null],
			['b', 90_000, null]
		]);
	});

	it('keeps a dam the run has though the model has since lost it', () => {
		const cards = damCards([], [level('gone', 50, { name: 'Old dam' })]);
		expect(cards).toEqual([expect.objectContaining({ nodeId: 'gone', name: 'Old dam', farm: false })]);
	});
});

describe('pickDam', () => {
	const cards = damCards(nodes, [level('b', 20), level('a', 60)]);
	it('picks the dam the URL names, else the first (emptiest)', () => {
		expect(pickDam(cards, 'a')?.nodeId).toBe('a');
		expect(pickDam(cards, null)?.nodeId).toBe('b');
		expect(pickDam(cards, 'nope')?.nodeId).toBe('b');
		expect(pickDam([], 'a')).toBeNull();
	});
});

describe('the header line', () => {
	it('counts the dams and their capacity in words, then the run', () => {
		expect(fmtVolume(2_400_000)).toBe('2.4 million m³');
		expect(fmtVolume(12_345_678)).toBe('12.3 million m³');
		expect(fmtVolume(150_000)).toBe('150\u202f000 m³');
		expect(damsSummary(3, 2_400_000, 'latest run “Baseline”, ran today')).toBe('3 dams · 2.4 million m³ capacity · latest run “Baseline”, ran today');
		expect(damsSummary(1, 5_000, null)).toBe('1 dam · 5\u202f000 m³ capacity · no run yet');
		expect(damsSummary(0, 0, 'x')).toBe('No dams in the model yet');
	});
});

describe('changeWords', () => {
	it('says up, down or no change in words, never by colour alone', () => {
		expect(changeWords({ endPct: 53, agoPct: 64 }, 30)).toEqual({ text: 'down 11 pp in 30 days', dir: 'down' });
		expect(changeWords({ endPct: 70, agoPct: 64.4 }, 30)).toEqual({ text: 'up 6 pp in 30 days', dir: 'up' });
		expect(changeWords({ endPct: 64.2, agoPct: 64 }, 30)).toEqual({ text: 'no change in 30 days', dir: 'flat' });
		expect(changeWords({ endPct: 50, agoPct: null }, 30)).toBeNull();
	});
});

describe('storageSpark', () => {
	it('covers the last year as % of capacity, ending on the last day, with the window’s first and last day', () => {
		// 400 days from 1 Jan 2021: the first 35 fall outside the year; the year runs full → empty.
		const values = Array.from({ length: 400 }, (_, i) => (i < 35 ? 0 : 1000 * (1 - (i - 35) / 364)));
		const s = storageSpark({ startDate: '2021-01-01', values }, 1000)!;
		expect(s.values.length).toBeLessThanOrEqual(62); // 60 steps' lows, the first and the last day
		expect(s.x[0]).toBe(0);
		expect(s.values[0]).toBeCloseTo(100, 5); // full
		expect(s.x.at(-1)).toBe(1);
		expect(s.values.at(-1)).toBeCloseTo(0, 5); // empty on the last day
		expect(s.ends).toEqual(['5 Feb 2021', '4 Feb 2022']);
		expect(s.labels[0]).toBe('5 Feb 2021');
		expect(s.labels.at(-1)).toBe('4 Feb 2022');
		expect(s.x.every((x, i) => i === 0 || x > s.x[i - 1]!)).toBe(true);
	});

	it('keeps each step’s lowest day, so a one-day dip shows and the low is the dam’s lowest in its last year', () => {
		const values: (number | null)[] = Array.from({ length: 120 }, () => 500);
		values[40] = 120; // a one-day dip
		values[41] = 120; // the same level again: the first day is the low
		values[60] = null;
		values[61] = 5000; // over capacity: kept as is (the line is clamped when drawn)
		const s = storageSpark({ startDate: '2021-10-01', values: [...values, null, null] }, 1000, 365, 30)!;
		const low = s.values.indexOf(Math.min(...s.values));
		expect(s.values[low]).toBe(12);
		expect(s.labels[low]).toBe('10 Nov 2021');
		expect(s.values.every((v) => v <= 50)).toBe(true); // each step's low, never the spike
		expect(s.ends).toEqual(['1 Oct 2021', '28 Jan 2022']);
	});

	it('needs two values and a capacity', () => {
		expect(storageSpark({ startDate: '2021-01-01', values: [5] }, 10)).toBeNull();
		expect(storageSpark({ startDate: '2021-01-01', values: [null, null] }, 10)).toBeNull();
		expect(storageSpark({ startDate: '2021-01-01', values: [1, 2] }, 0)).toBeNull();
	});
});

describe('storageChartSeries', () => {
	const series = { startDate: '2021-10-01', values: [500, null, 250] };
	it('m³: storage, the capacity and the minimum level, each over the same days', () => {
		const out = storageChartSeries(series, 1000, 10, 'm3');
		expect(out.map((s) => [s.label, s.style ?? 'line', s.values])).toEqual([
			['Storage', 'line', [500, null, 250]],
			['Capacity', 'dashed', [1000, 1000, 1000]],
			['Minimum level', 'dashed', [100, 100, 100]]
		]);
		expect(out.every((s) => s.startDate === '2021-10-01')).toBe(true);
	});

	it('% full: capacity at 100, no minimum line when the dam has none', () => {
		const out = storageChartSeries(series, 1000, 0, 'pct');
		expect(out.map((s) => s.values)).toEqual([
			[50, null, 25],
			[100, 100, 100]
		]);
	});
});
