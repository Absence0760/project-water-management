import { damFigures, type FarmSummary } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { AGO_DAYS, damLevel, damLevelsFromSummary, damsInRun, damsToday, levelBand, loadDamLevels, LOW_PCT, sortDamLevels, YEAR_DAYS, type DamLevel } from './damLevels';

const dam = { nodeId: 'f1', name: 'Upper farm', capacityM3: 1000, minPct: 10 };
const series = (startDate: string, values: (number | null)[]) => ({ startDate, values });

describe('damLevel', () => {
	it('takes the last day with a value as the end, and the lowest day of the last year', () => {
		const l = damLevel(dam, series('2025-01-01', [900, 500, 250, 400, 600, null]));
		expect(l).toEqual({
			nodeId: 'f1',
			name: 'Upper farm',
			capacityM3: 1000,
			minPct: 10,
			endPct: 60,
			endDate: '2025-01-05',
			lowPct: 25,
			lowDate: '2025-01-03',
			daysAtMin: 0,
			agoPct: null
		});
	});

	it('looks back one year from the end only: an older low does not count', () => {
		const values = [0, ...Array(YEAR_DAYS).fill(800)];
		const l = damLevel(dam, series('2024-01-01', values))!;
		expect(l.lowPct).toBe(80);
		expect(l.endDate).toBe('2024-12-31'); // index 365 of a leap year
		// The first day of the lowest stretch.
		expect(l.lowDate).toBe('2024-01-02');
	});

	it('counts the days at or below the minimum level in that year', () => {
		const l = damLevel(dam, series('2025-06-01', [100, 100.0000001, 99, 150, 100]))!;
		expect(l.daysAtMin).toBe(4);
		expect(damLevel({ ...dam, minPct: 0 }, series('2025-06-01', [0, 0]))!.daysAtMin).toBe(0);
	});

	it('is null without capacity or without any finite value', () => {
		expect(damLevel({ ...dam, capacityM3: 0 }, series('2025-01-01', [1]))).toBeNull();
		expect(damLevel(dam, series('2025-01-01', [null, Number.NaN]))).toBeNull();
		expect(damLevel(dam, series('2025-01-01', []))).toBeNull();
	});
});

describe('sortDamLevels and levelBand', () => {
	const l = (name: string, endPct: number, minPct = 0): DamLevel =>
		({ nodeId: name, name, capacityM3: 1, minPct, endPct, endDate: '', lowPct: 0, lowDate: '', daysAtMin: 0, agoPct: null });

	it('puts the emptiest dam first, then by name', () => {
		expect(sortDamLevels([l('B', 50), l('A', 50), l('C', 5)]).map((x) => x.name)).toEqual(['C', 'A', 'B']);
	});

	it('bands a dam at its minimum, below the low line, or fine', () => {
		expect(levelBand(l('x', 10, 10))).toBe('at-min');
		expect(levelBand(l('x', LOW_PCT - 1, 10))).toBe('low');
		expect(levelBand(l('x', LOW_PCT, 10))).toBe('ok');
		expect(levelBand(l('x', 0))).toBe('low');
	});
});

describe('loadDamLevels', () => {
	it('fetches every dam at most `atOnce` at a time, reports progress, and sorts emptiest first', async () => {
		const dams = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ nodeId: id, name: id.toUpperCase(), capacityM3: 100, minPct: 0, end: 90 - i * 20 }));
		let inFlight = 0;
		let most = 0;
		const progress: number[] = [];
		const levels = await loadDamLevels(
			dams,
			async (id) => {
				inFlight++;
				most = Math.max(most, inFlight);
				await new Promise((r) => setTimeout(r, 1));
				inFlight--;
				return { startDate: '2025-01-01', values: id === 'c' ? [null] : [dams.find((d) => d.nodeId === id)!.end] };
			},
			2,
			(n) => progress.push(n)
		);
		expect(most).toBe(2);
		expect(progress).toEqual([1, 2, 3, 4, 5]);
		// 'c' has no value: left out.
		expect(levels.map((l) => [l.nodeId, l.endPct])).toEqual([['e', 10], ['d', 30], ['b', 70], ['a', 90]]);
	});
});

describe('damLevel: 30 days before the end', () => {
	it('reads the storage AGO_DAYS before the last day with a value', () => {
		const values = [...Array(AGO_DAYS).fill(0), 700, ...Array(AGO_DAYS - 1).fill(500), 400, null];
		const l = damLevel(dam, series('2025-01-01', values))!;
		expect(l.endPct).toBe(40);
		expect(l.agoPct).toBe(70);
	});

	it('is null when the run is shorter, or has no value that day', () => {
		expect(damLevel(dam, series('2025-01-01', Array(AGO_DAYS).fill(500)))!.agoPct).toBeNull();
		expect(damLevel(dam, series('2025-01-01', [null, ...Array(AGO_DAYS).fill(500)]))!.agoPct).toBeNull();
	});
});

describe('damsToday', () => {
	const l = (capacityM3: number, endPct: number, agoPct: number | null, endDate = '2025-06-30'): DamLevel =>
		({ nodeId: String(capacityM3), name: '', capacityM3, minPct: 0, endPct, endDate, lowPct: 0, lowDate: '', daysAtMin: 0, agoPct });

	it('weights each dam by its capacity, and gives the change over the last 30 days in points', () => {
		// 90 000 m³ at 20 % and 10 000 m³ at 100 %: 28 000 of 100 000 m³, not the plain mean of 60 %.
		const d = damsToday([l(90_000, 20, 30), l(10_000, 100, 100, '2025-07-01')])!;
		expect(d.pct).toBeCloseTo(28, 10);
		expect(d.change).toBeCloseTo(-9, 10); // 28 − 37
		expect(d.dams).toBe(2);
		expect(d.endDate).toBe('2025-07-01');
	});

	it('has no change when a dam lacks the earlier value, and is null without dams', () => {
		expect(damsToday([l(100, 50, 40), l(100, 50, null)])!.change).toBeNull();
		expect(damsToday([])).toBeNull();
	});
});

describe('damsInRun', () => {
	const refs = [
		{ key: 'dam_storage', nodeId: 'a' },
		{ key: 'dam_storage', nodeId: 'b' },
		{ key: 'natural_flow', nodeId: 'c' }
	];
	it('keeps nodes with a capacity and a stored dam_storage series, from the run’s own model', () => {
		const run = [
			{ id: 'a', name: 'A', kind: 'farm', damCapacityM3: 500, damMinPct: 0.1 },
			{ id: 'b', name: '', damCapacityM3: 0 },
			{ id: 'c', name: 'C', damCapacityM3: 800 }
		];
		const live = [{ id: 'a', name: 'A', damCapacityM3: 9_999, damMinPct: 0 }];
		expect(damsInRun(run, live, refs)).toEqual([{ nodeId: 'a', name: 'A', capacityM3: 500, minPct: 10 }]);
	});

	it('turns the model’s minimum level (a fraction) into the % damLevel compares with, on farms only', () => {
		const run = [
			{ id: 'a', name: 'A', kind: 'farm', damCapacityM3: 1000, damMinPct: 0.25 },
			{ id: 'b', name: 'B', kind: 'gauge', damCapacityM3: 1000, damMinPct: 0.25 }
		];
		const dams = damsInRun(run, [], refs);
		expect(dams.map((d) => d.minPct)).toEqual([25, 0]);
		// A dam held at 25 % of its capacity is at its minimum level; the gauge's has none.
		const held = { startDate: '2025-06-01', values: [250, 250] };
		expect(damLevel(dams[0]!, held)).toMatchObject({ minPct: 25, daysAtMin: 2 });
		expect(levelBand(damLevel(dams[0]!, held)!)).toBe('at-min');
		expect(damLevel(dams[1]!, held)).toMatchObject({ minPct: 0, daysAtMin: 0 });
	});

	it('falls back to the live model for a run saved without one', () => {
		expect(damsInRun(undefined, [{ id: 'b', name: '', damCapacityM3: 50, damMinPct: 'x' }], refs)).toEqual([
			{ nodeId: 'b', name: '(unnamed)', capacityM3: 50, minPct: 0 }
		]);
	});
});

describe('damLevelsFromSummary (engine ≥ 1.2.0, issue #55)', () => {
	const farm = (nodeId: string, over: Partial<FarmSummary> = {}) => ({ nodeId, name: nodeId, ...over }) as FarmSummary;
	const dams = [
		{ nodeId: 'a', name: 'A', capacityM3: 1000, minPct: 10 },
		{ nodeId: 'b', name: 'B', capacityM3: 500, minPct: 0 }
	];

	it('turns the summary figures into levels, emptiest first, ending on the run\'s last day', () => {
		const farms = [
			farm('a', { damEndM3: 600, damAgoM3: 700, damLowM3: 100, damLowDate: '2025-03-01', damDaysAtMin: 12 }),
			farm('b', { damEndM3: 100, damAgoM3: null, damLowM3: 50, damLowDate: '2025-04-02', damDaysAtMin: 0 })
		];
		expect(damLevelsFromSummary(dams, farms, '2025-06-30')).toEqual([
			{ nodeId: 'b', name: 'B', capacityM3: 500, minPct: 0, endPct: 20, endDate: '2025-06-30', lowPct: 10, lowDate: '2025-04-02', daysAtMin: 0, agoPct: null },
			{ nodeId: 'a', name: 'A', capacityM3: 1000, minPct: 10, endPct: 60, endDate: '2025-06-30', lowPct: 10, lowDate: '2025-03-01', daysAtMin: 12, agoPct: 70 }
		]);
	});

	it('is null when any dam lacks the figures (a run from before them), so the caller reads the series', () => {
		expect(damLevelsFromSummary(dams, [farm('a', { damEndM3: 1, damLowM3: 1, damLowDate: '2025-01-01', damDaysAtMin: 0 }), farm('b')], '2025-01-01')).toBeNull();
		expect(damLevelsFromSummary(dams, [], '2025-01-01')).toBeNull();
		expect(damLevelsFromSummary([], [], '2025-01-01')).toEqual([]);
	});

	it('matches damLevel() on the same series: the engine\'s damFigures follows the same rules', () => {
		// A deterministic pseudo-random walk over two years and a bit, with gaps and a stretch held at the minimum.
		let seed = 7;
		const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		for (const [len, minPct] of [[800, 20], [40, 0], [10, 35], [366, 15]] as const) {
			const cap = 5000;
			let x = cap / 2;
			const values: (number | null)[] = Array.from({ length: len }, (_, i) => {
				x = Math.min(cap, Math.max((minPct / 100) * cap, x + (rnd() - 0.55) * 400));
				return i % 97 === 5 ? null : x;
			});
			const d = { nodeId: 'n', name: 'N', capacityM3: cap, minPct };
			const series = { startDate: '2023-02-10', values };
			const fig = damFigures(values, cap, minPct / 100, series.startDate)!;
			const fromSummary = damLevelsFromSummary([d], [farm('n', fig)], damLevel(d, series)!.endDate)![0];
			expect(fromSummary).toEqual(damLevel(d, series));
		}
	});
});
