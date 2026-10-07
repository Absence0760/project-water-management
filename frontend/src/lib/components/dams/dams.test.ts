import { describe, expect, it } from 'vitest';
import type { DamLevel } from '$lib/components/overview/damLevels';
import { changeWords, damCards, damChange, damChanges, damsSummary, fmtVolume, modelDams, pickDam, storageChartSeries, storageSpark } from './dams';

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
		expect(cards).toEqual([expect.objectContaining({ nodeId: 'gone', name: 'Old dam', farm: false, nowCapacityM3: 0 })]);
	});

	it('shows the model’s capacity now, and marks a dam edited since the run (issue #444)', () => {
		const runNodes = [
			{ id: 'a', name: 'Upper farm', kind: 'farm', damCapacityM3: 140_000, damMinPct: 0.1 },
			{ id: 'b', name: 'Lower farm', kind: 'farm', damCapacityM3: 90_000 }
		];
		const cards = damCards(nodes, [level('b', 20, { capacityM3: 90_000 }), level('a', 60, { capacityM3: 140_000 })], runNodes);
		// The figures stay the run's; the head shows today's capacity, and the edit is named.
		expect(cards[1]).toMatchObject({ nodeId: 'a', capacityM3: 140_000, nowCapacityM3: 150_000 });
		expect(cards[1]!.change?.text).toBe('Dam settings changed since the run: capacity 140\u202f000 m³ in the run, 150\u202f000 m³ now. Re-run to update.');
		expect(cards[0]).toMatchObject({ nodeId: 'b', nowCapacityM3: 90_000, change: null });
		// Without the run's model there is nothing to compare: no mark.
		expect(damCards(nodes, [level('a', 60)]).every((c) => c.change === null)).toBe(true);
		// A dam not in the run has no run figures to be stale.
		expect(damCards(nodes, [], runNodes).every((c) => c.change === null)).toBe(true);
		// Removed from the model since the run: the card stays, marked.
		const gone = damCards([], [level('a', 60)], runNodes);
		expect(gone[0]).toMatchObject({ nowCapacityM3: 0, change: { capacity: { run: 140_000, now: 0 } } });
		expect(gone[0]!.change?.text).toBe('Dam settings changed since the run: dam removed. Re-run to update.');
	});
});

describe('damChange', () => {
	const dam = { id: 'a', kind: 'farm', damCapacityM3: 100_000, damMinPct: 0.1, damInitialPct: 0.5, damAreaFullM2: null, damAreaExponent: 0.7, damSeepagePerDay: 0, pctUpstreamToDam: 1, pctRunoffToDam: 0 };

	it('is null when nothing the run’s dam figures used has changed, or a side is missing', () => {
		expect(damChange(dam, { ...dam, name: 'Renamed', areaKm2: 9 })).toBeNull();
		expect(damChange(dam, { ...dam, damCapacityM3: 100_000.4 })).toBeNull();
		expect(damChange({ ...dam, damCapacityM3: 0 }, { ...dam, damCapacityM3: 0.5 })).toBeNull();
		expect(damChange(undefined, dam)).toBeNull();
		expect(damChange(dam, undefined)).toBeNull();
	});

	it('reads a field the run’s model lacks as its default, and skips the rest', () => {
		// An older run without the WP-3.5 and development fields ran as their defaults: the same as them stated.
		expect(damChange(dam, { ...dam, damReleaseRule: 'none', damCurve: null, damSeepageReturnPct: 1, damSurveyDate: null })).toBeNull();
		expect(damChange(dam, { ...dam, damReleaseRule: 'fixed' })?.other).toEqual(['release rule']);
		// A stored null (no area entered, estimated from the capacity) set to an area is a change.
		expect(damChange(dam, { ...dam, damAreaFullM2: 5_000 })?.other).toEqual(['surface area']);
		expect(damChange({ ...dam, damAreaFullM2: 5_000 }, dam)?.other).toEqual(['surface area']);
		const { damAreaExponent: _, ...older } = dam;
		expect(damChange(older, { ...dam, damAreaExponent: 0.9 })).toBeNull();
	});

	it('names a resize, an added or removed dam, and each other kind of edit once', () => {
		expect(damChange(dam, { ...dam, damCapacityM3: 2_500_000 })).toEqual({
			capacity: { run: 100_000, now: 2_500_000 },
			other: [],
			detail: 'capacity 100\u202f000 m³ in the run, 2.5 million m³ now. Re-run to update.',
			text: 'Dam settings changed since the run: capacity 100\u202f000 m³ in the run, 2.5 million m³ now. Re-run to update.'
		});
		expect(damChange({ ...dam, damCapacityM3: 0 }, dam)?.text).toBe('Dam settings changed since the run: dam added (100\u202f000 m³). Re-run to update.');
		expect(damChange(dam, { ...dam, damCapacityM3: 0 })?.text).toBe('Dam settings changed since the run: dam removed. Re-run to update.');
		const many = damChange(dam, { ...dam, damMinPct: 0.2, damAreaFullM2: 5_000, damAreaExponent: 0.8, damCurve: [{ levelM: 1, areaM2: 1, volumeM3: 1 }], pctRunoffToDam: 0.5 });
		expect(many?.capacity).toBeNull();
		expect(many?.other).toEqual(['minimum level', 'surface area', 'what flows into it']);
		expect(many?.text).toBe('Dam settings changed since the run: minimum level, surface area, what flows into it. Re-run to update.');
	});

	it('counts how its own unit draws on it, the supply rule and the crops’ supply table, as the dam’s own settings', () => {
		// An older run without the supply fields ran as their defaults: dam only, no table.
		expect(damChange(dam, { ...dam, supplyRule: 'damFirst', supplyTriggerPct: 0.4, supplyStopPct: 0.6, cropWaterSource: 'dam', cropShareDam: null, cropShareRiver: null, cropShareRemote: null })).toBeNull();
		expect(damChange(dam, { ...dam, supplyRule: 'riverFirst' })?.other).toEqual(['how its unit draws on it']);
		expect(damChange({ ...dam, supplyRule: 'trigger' }, { ...dam, supplyRule: 'trigger', supplyTriggerPct: 0.3 })?.other).toEqual(['how its unit draws on it']);
		const table = damChange(dam, { ...dam, cropShareDam: 0.6, cropShareRiver: 0.4, cropWaterSource: 'river' });
		expect(table?.other).toEqual(['how its unit draws on it']);
		expect(table?.detail).toBe('how its unit draws on it. Re-run to update.');
		// Not the dam's own settings, so not checked: the bed losses of the unit's reach, its area (its runoff), its river pump. (An upstream unit's edits never reach this comparison at all.)
		expect(damChange(dam, { ...dam, reachLossFrac: 0.2, reachLossMaxM3Day: 5_000, areaKm2: 20, pumpCapacityM3Day: 900 })).toBeNull();
	});

	it('maps every unit the run also has, leaving gauges and unchanged units out', () => {
		const run = [dam, { ...dam, id: 'b' }, { id: 'g', kind: 'gauge', damCapacityM3: 0 }];
		const live = [{ ...dam, damCapacityM3: 50_000 }, { ...dam, id: 'b' }, { id: 'g', kind: 'gauge', damCapacityM3: 9_000 }, { ...dam, id: 'new' }];
		expect([...damChanges(run, live).keys()]).toEqual(['a']);
		expect(damChanges(undefined, live).size).toBe(0);
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

describe("the sparkline and chart against the day's capacity (issue #67)", () => {
	// Capacity 1 250 m³ falling by 1 m³ a day (a dam losing capacity to sediment); the dam kept 90 % of it.
	const cap = (i: number) => 1250 - i;
	const values = Array.from({ length: 40 }, (_, i) => 0.9 * cap(i));

	it('keeps each sparkline point a share of that day’s capacity, never above 100 %', () => {
		const s = storageSpark({ startDate: '2021-01-01', values }, 1000, 365, 60, cap)!;
		for (const v of s.values) expect(v).toBeCloseTo(90, 9);
		// Against the entered 1 000 m³ it read up to 112.5 %.
		expect(Math.max(...storageSpark({ startDate: '2021-01-01', values }, 1000)!.values)).toBeGreaterThan(100);
	});

	it('draws the capacity and minimum lines at the day’s capacity in m³, and % as a share of it', () => {
		const [storage, capacity, min] = storageChartSeries({ startDate: '2021-01-01', values }, 1000, 10, 'm3', cap);
		expect(storage!.values).toEqual(values);
		expect(capacity!.values).toEqual(values.map((_, i) => cap(i)));
		expect(min!.values).toEqual(values.map((_, i) => 0.1 * cap(i)));
		const pct = storageChartSeries({ startDate: '2021-01-01', values }, 1000, 10, 'pct', cap);
		for (const v of pct[0]!.values) expect(v).toBeCloseTo(90, 9);
		expect(new Set(pct[1]!.values)).toEqual(new Set([100]));
		expect(new Set(pct[2]!.values)).toEqual(new Set([10]));
	});

	it('shows no % on a day before the dam is in service', () => {
		const inService = (i: number) => (i < 2 ? 0 : 1000);
		const [storage, capacity] = storageChartSeries({ startDate: '2021-01-01', values: [0, 0, 500] }, 1000, 0, 'pct', inService);
		expect(storage!.values).toEqual([null, null, 50]);
		expect(capacity!.values).toEqual([null, null, 100]);
		expect(storageSpark({ startDate: '2021-01-01', values: [0, 0, 500] }, 1000, 365, 60, inService)!.values).toEqual([0, 0, 50]);
	});

	it('positive control: without a changing capacity the lines are as before', () => {
		const s = { startDate: '2021-01-01', values: [500, 600] };
		expect(storageChartSeries(s, 1000, 10, 'pct', undefined)).toEqual(storageChartSeries(s, 1000, 10, 'pct'));
		expect(storageChartSeries(s, 1000, 10, 'pct')[0]!.values).toEqual([50, 60]);
		expect(storageSpark(s, 1000, 365, 60, undefined)).toEqual(storageSpark(s, 1000));
	});
});
