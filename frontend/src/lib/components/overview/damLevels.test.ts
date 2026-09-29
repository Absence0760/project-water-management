import { damCapacityOn, damFigures, fromEpochDay, toEpochDay, type FarmSummary, type NetworkNode } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { damColouring } from '$lib/components/network/farmColour';
import { AGO_DAYS, capacityOnDate, damEndPctFromSummary, damEndTile, damInRun, damLevel, damLevelsFromSummary, damsInRun, damsToday, levelBand, loadDamLevels, LOW_PCT, sortDamLevels, YEAR_DAYS, type DamLevel } from './damLevels';

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

	it("leaves a forecast run's forecast days out: the end is the day before the forecast (issue #51)", () => {
		// 2025-01-01 … 01-05 recorded, 01-06 … 01-08 forecast (a dry tail that empties the dam).
		const s = series('2025-01-01', [900, 500, 250, 400, 600, 100, 50, 20]);
		const l = damLevel(dam, s, '2025-01-06')!;
		expect(l).toEqual(damLevel(dam, series('2025-01-01', [900, 500, 250, 400, 600])));
		expect(l).toMatchObject({ endPct: 60, endDate: '2025-01-05', lowPct: 25, lowDate: '2025-01-03' });
		// Positive control: without forecastFrom the tail counts.
		expect(damLevel(dam, s)).toMatchObject({ endPct: 2, endDate: '2025-01-08', lowPct: 2 });
		// The summary's figures (the record's) and the cut series agree, dated the same day.
		const fromSummary = damLevelsFromSummary([dam], [{ nodeId: 'f1', name: 'f1', ...damFigures([900, 500, 250, 400, 600], 1000, 0.1, '2025-01-01')! } as FarmSummary], '2025-01-05')![0];
		expect(fromSummary).toEqual(l);
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

describe('damInRun and damEndPctFromSummary: the Network card’s Dam at end of run (issue #173)', () => {
	const refs = [{ key: 'dam_storage', nodeId: 'a' }];
	const summary = [{ nodeId: 'a', name: 'A', damEndM3: 400, damLowM3: 300, damLowDate: '2024-12-01', damDaysAtMin: 0 } as FarmSummary];

	it('reads the end of the run against the run’s capacity, as the map’s colour by dam level does, after a capacity edit', () => {
		// The run modelled a 1 000 m³ dam; the model has since been edited to 500 m³.
		const run = [{ id: 'a', name: 'A', kind: 'farm', damCapacityM3: 1000, damMinPct: 0 }];
		const live = [{ id: 'a', name: 'A', kind: 'farm', damCapacityM3: 500, damMinPct: 0 }];
		const dam = damInRun(run, live, refs, 'a')!;
		expect(dam.capacityM3).toBe(1000);
		expect(damEndPctFromSummary(dam, summary, '2025-01-01')).toBe(40);
		// The map's colouring reads the same figure (damLevelsFromSummary over damsInRun).
		expect(damLevelsFromSummary(damsInRun(run, live, refs), summary, '2025-01-01')![0]!.endPct).toBe(40);
	});

	it('is null for a dam the run stored no storage for, and undefined without the summary figure', () => {
		const run = [{ id: 'a', name: 'A', kind: 'farm', damCapacityM3: 1000 }];
		expect(damInRun(run, [], [], 'a')).toBeNull();
		expect(damInRun(run, [], refs, 'b')).toBeNull();
		expect(damEndPctFromSummary({ nodeId: 'a', capacityM3: 1000 }, [{ nodeId: 'a', name: 'A' } as FarmSummary], '2025-01-01')).toBeUndefined();
		expect(damEndPctFromSummary({ nodeId: 'a', capacityM3: 1000 }, [], '2025-01-01')).toBeUndefined();
	});
});

describe('damEndTile: what the Network card writes (issue #173)', () => {
	const end = (over: Partial<Parameters<typeof damEndTile>[0] & object> = {}) => ({ nodeId: 'a', inRun: true, pct: 36.4, capacityM3: 150_000, ...over });

	it('shows the % alone when the capacity is unchanged since the run', () => {
		expect(damEndTile(end(), 150_000)).toEqual({ value: '36%', sub: null });
	});

	it('says what the % is a share of when the capacity was edited since the run', () => {
		expect(damEndTile(end(), 75_000)).toEqual({ value: '36%', sub: 'of 150\u202f000 m³ in the run' });
	});

	it('reads a farm as the map’s colour by dam level does: a dam removed since is "No dam", one added since is not in the run', () => {
		const run = { name: 'Baseline', ago: 'today' };
		const live = (damCapacityM3: number) => [{ id: 'a', name: 'A', kind: 'farm', damCapacityM3 } as NetworkNode];
		const level = { nodeId: 'a', name: 'A', capacityM3: 150_000, minPct: 0, endPct: 36.4, endDate: '2025-01-01', lowPct: 30, lowDate: '2024-12-01', daysAtMin: 0, agoPct: null };
		expect(damEndTile(end(), 0)).toEqual({ value: 'No dam', sub: null });
		expect(damColouring(live(0), [level], run, false).byNode.get('a')!.text).toBe('no dam');
		expect(damEndTile({ nodeId: 'a', inRun: false, pct: null, capacityM3: 0 }, 5_000)).toEqual({ value: '–', sub: 'not in this run' });
		expect(damColouring(live(5_000), [], run, false).byNode.get('a')!.text).toBe('not in this run');
		// Same % on both after a capacity edit.
		expect(damColouring(live(75_000), [level], run, false).byNode.get('a')!.text).toBe('36% full');
		expect(damEndTile(end(), 75_000).value).toBe('36%');
	});

	it('is a dash while loading or before the run is read, and "No dam" without a dam', () => {
		expect(damEndTile(end({ pct: null }), 150_000)).toEqual({ value: '–', sub: null });
		expect(damEndTile(null, 5_000)).toEqual({ value: '–', sub: null });
		expect(damEndTile(null, 0)).toEqual({ value: 'No dam', sub: null });
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

describe("levels against the day's capacity (issue #67: sediment, an in-service date)", () => {
	// 60 days from 2020-01-01; the dam was surveyed in 2025 at 1 000 m³ and loses 5 % a year, so in 2020 it held ~1 250 m³.
	const start = '2020-01-01';
	const DAYS = 60;
	const node = (over: Partial<NetworkNode> = {}) => ({ id: 'f1', name: 'Upper farm', kind: 'farm', damCapacityM3: 1000, damMinPct: 0.1, ...over });
	const sediment = { damSurveyDate: '2025-01-01', damSedimentPctPerYear: 0.05 };
	const refs = [{ key: 'dam_storage', nodeId: 'f1' }];
	const capOn = (n: ReturnType<typeof node>, i: number) => damCapacityOn(n as NetworkNode, toEpochDay(start) + i);
	// Storage just under the day's capacity on every day: the dam was nearly full throughout.
	const nearlyFull = (n: ReturnType<typeof node>) => series(start, Array.from({ length: DAYS }, (_, i) => 0.98 * capOn(n, i)));

	it('keeps a long record surveyed later within 0–100 %, a share of each day’s capacity', () => {
		const n = node(sediment);
		const [d] = damsInRun([n], [], refs);
		expect(d!.dev).toEqual({ damSurveyDate: '2025-01-01', damSedimentPctPerYear: 0.05, damInServiceFrom: null });
		const s = nearlyFull(n);
		expect(s.values[DAYS - 1]!).toBeGreaterThan(1000); // above the entered capacity: the old reading was over 100 %
		const l = damLevel(d!, s)!;
		expect(l.endPct).toBeCloseTo(98, 9);
		expect(l.agoPct).toBeCloseTo(98, 9);
		expect(l.lowPct).toBeCloseTo(98, 9);
		expect(l.endCapacityM3).toBe(capOn(n, DAYS - 1));
		expect(l.agoCapacityM3).toBe(capOn(n, DAYS - 1 - AGO_DAYS));
		expect(capacityOnDate(d!, l.endDate)).toBe(l.endCapacityM3);
		// All dams together: a share of the capacities on those days, so also 98 % with no change.
		// The map's colour by dam level reads the same share, not "over 100 %".
		expect(damColouring([n as NetworkNode], [l], { name: 'R', ago: 'today' }, false).byNode.get('f1')!.text).toBe('98% full');
		const today = damsToday([l])!;
		expect(today.pct).toBeCloseTo(98, 9);
		expect(today.change).toBeCloseTo(0, 9);
		// The summary's figures (engine damFigures with the day's capacity) read the same.
		const fig = damFigures(s.values, 1000, 0.1, start, (i) => capOn(n, i))!;
		const fromSummary = damLevelsFromSummary([d!], [{ nodeId: 'f1', name: 'Upper farm', ...fig } as FarmSummary], l.endDate)![0]!;
		expect(fromSummary.endPct).toBeCloseTo(l.endPct, 9);
		expect(fromSummary.agoPct).toBeCloseTo(l.agoPct!, 9);
		expect(fromSummary.lowPct).toBeCloseTo(l.lowPct, 9);
		expect(damEndPctFromSummary(d!, [{ nodeId: 'f1', name: 'Upper farm', ...fig } as FarmSummary], l.endDate)).toBeCloseTo(98, 9);
	});

	it('counts the days at the minimum against the day’s capacity', () => {
		const n = node(sediment);
		const [d] = damsInRun([n], [], refs);
		// Held at 10 % of the day's capacity: every day is at the minimum (against 1 000 m³ it read 12.5 %, none).
		const s = series(start, Array.from({ length: DAYS }, (_, i) => 0.1 * capOn(n, i)));
		expect(damLevel(d!, s)!.daysAtMin).toBe(DAYS);
		expect(damLevel(d!, s)!.endPct).toBeCloseTo(10, 9);
	});

	it('reads a dam before it is in service as empty, and a share of its capacity after', () => {
		// In service from day 40: capacity 0 before it, 1 000 m³ from it.
		const inService = fromEpochDay(toEpochDay(start) + 40);
		const n = node({ damInServiceFrom: inService });
		const [d] = damsInRun([n], [], refs);
		const s = series(start, Array.from({ length: DAYS }, (_, i) => (i < 40 ? 0 : 500)));
		const l = damLevel(d!, s)!;
		expect(l.endPct).toBe(50);
		expect(l.agoPct).toBe(0); // 30 days before the end, no dam yet
		expect(l.agoCapacityM3).toBe(0);
		expect(l.daysAtMin).toBe(0); // the days without a dam aren't "at its minimum"
		for (const x of [l.endPct, l.agoPct!, l.lowPct]) expect(x >= 0 && x <= 100).toBe(true);
		// No capacity 30 days back across all dams: no change to show rather than a division by 0.
		expect(damsToday([l])).toMatchObject({ pct: 50, change: null });
	});

	it('positive control: a dam whose fields change nothing reads exactly as before', () => {
		const plain = node();
		const [d] = damsInRun([plain], [], refs);
		expect(d).toEqual({ nodeId: 'f1', name: 'Upper farm', capacityM3: 1000, minPct: 10 });
		// A sediment rate without a survey date, or an in-service date on no farm, changes nothing either.
		expect(damsInRun([node({ damSedimentPctPerYear: 0.05 })], [], refs)[0]).toEqual(d);
		const s = series(start, Array.from({ length: DAYS }, (_, i) => 400 + i));
		const l = damLevel(d!, s)!;
		expect(l).toEqual(damLevel(dam, s));
		expect(l.endCapacityM3).toBeUndefined();
		expect(l.endPct).toBe(((400 + DAYS - 1) / 1000) * 100);
	});
});
