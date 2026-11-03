import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { contrast, cssHex, worstDe } from '#lib/a11y/colourVision.js';
import { CATCHMENT_LINE_ID, LINE_TOKENS, countWindow, cumulativeLines, dayAt, eachAtOnce, firstDayInView, lastDayInView, m3ToMm3, rebase, runningTotal, volumeBetween } from './cumulative';

const epoch = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

describe('runningTotal', () => {
	it('adds up daily m³/day into Mm³ at the end of each day', () => {
		const { totals, gapDays } = runningTotal([1_000_000, 500_000, 250_000]);
		expect(totals).toEqual([1, 1.5, 1.75]);
		expect(gapDays).toBe(0);
		expect(m3ToMm3(2_500_000)).toBe(2.5);
	});

	it('carries the last total across a day with no value (null, NaN, Infinity) and counts those days', () => {
		const { totals, gapDays } = runningTotal([null, 2_000_000, null, NaN, 1_000_000, Infinity]);
		// Nothing counted before the first value: 0, not a gap in the line.
		expect(totals).toEqual([0, 2, 2, 2, 3, 3]);
		expect(gapDays).toBe(4);
	});

	it('is empty for no days', () => {
		expect(runningTotal([])).toEqual({ totals: [], gapDays: 0 });
	});
});

describe('rebase', () => {
	const totals = [1, 3, 6, 10];
	it('counts from a later day: that day shows its own volume, the days before are not drawn', () => {
		expect(rebase(totals, 2)).toEqual([null, null, 3, 7]);
		expect(rebase(totals, 3)).toEqual([null, null, null, 4]);
	});
	it('leaves the totals as they are from day 0 (a copy)', () => {
		const out = rebase(totals, 0);
		expect(out).toEqual(totals);
		expect(out).not.toBe(totals);
	});
	it('keeps a carried total flat after rebasing (a gap adds nothing)', () => {
		const { totals: t } = runningTotal([1e6, null, null, 2e6]);
		expect(rebase(t, 1)).toEqual([null, 0, 0, 2]);
	});
});

describe('the days in view', () => {
	const start = '2021-10-01';
	it('takes the first day whose point is at or after the left edge, and the last at or before the right', () => {
		expect(firstDayInView(start, 120, epoch('2021-10-01'))).toBe(0);
		expect(firstDayInView(start, 120, epoch('2021-10-11'))).toBe(10);
		// A zoom box from mid-day: that day's point is outside the view.
		expect(firstDayInView(start, 120, epoch('2021-10-11') + 3600)).toBe(11);
		expect(lastDayInView(start, 120, epoch('2021-10-20') + 3600)).toBe(19);
		expect(lastDayInView(start, 120, epoch('2021-10-20'))).toBe(19);
	});
	it('stays within the record', () => {
		expect(firstDayInView(start, 120, epoch('2020-01-01'))).toBe(0);
		expect(firstDayInView(start, 120, epoch('2030-01-01'))).toBe(119);
		expect(lastDayInView(start, 120, epoch('2030-01-01'))).toBe(119);
		expect(lastDayInView(start, 120, epoch('2020-01-01'))).toBe(0);
		expect(firstDayInView(start, 0, 0)).toBe(0);
	});
	it('names the day an index is', () => {
		expect(dayAt(start, 0)).toBe('2021-10-01');
		expect(dayAt(start, 31)).toBe('2021-11-01');
	});

	describe('under a skewed time zone', () => {
		const tz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = tz;
		});
		it('never moves a day, east or west of UTC, across a leap day', () => {
			for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Africa/Johannesburg']) {
				process.env.TZ = zone;
				expect(firstDayInView('2024-02-27', 10, epoch('2024-03-01')), zone).toBe(3);
				expect(lastDayInView('2024-02-27', 10, epoch('2024-02-29')), zone).toBe(2);
				expect(dayAt('2024-02-27', 3), zone).toBe('2024-03-01');
			}
		});
	});
});

describe('cumulativeLines', () => {
	const refs = [
		{ key: 'simulated_outflow', nodeId: null },
		{ key: 'observed_flow', nodeId: null },
		{ key: 'outflow', nodeId: 'lower' },
		{ key: 'outflow', nodeId: 'upper' },
		{ key: 'supplied', nodeId: 'upper' },
		{ key: 'outflow', nodeId: 'gauge' },
		{ key: 'outflow', nodeId: 'town' },
		{ key: 'outflow', nodeId: 'gone' }
	];
	const order = new Map([
		['gauge', 0],
		['upper', 1],
		['lower', 2],
		['town', 3]
	]);
	const names = new Map([
		['upper', 'Upper farm'],
		['lower', 'Lower farm'],
		['gauge', 'Outflow gauge'],
		['town', 'Town']
	]);
	const live = new Map([
		['gauge', 'gauge'],
		['upper', 'farm'],
		['lower', 'farm'],
		['town', 'user']
	]);

	it('draws the catchment outlet first, then each hydrological unit’s outflow in network order: no gauge, other user or unknown node', () => {
		const lines = cumulativeLines(refs, undefined, live, order, names);
		expect(lines.map((l) => [l.id, l.nodeId, l.key, l.label])).toEqual([
			[CATCHMENT_LINE_ID, null, 'simulated_outflow', 'Catchment outlet (simulated outflow)'],
			['upper', 'upper', 'outflow', 'Upper farm'],
			['lower', 'lower', 'outflow', 'Lower farm']
		]);
	});

	it('takes each node’s kind from the run’s own model first: a unit removed since keeps its line', () => {
		const snap = [{ id: 'gone', kind: 'farm' }, { id: 'upper', kind: 'farm' }, { id: 'lower', kind: 'gauge' }];
		const lines = cumulativeLines(refs, snap, live, order, names);
		expect(lines.map((l) => [l.id, l.label])).toEqual([
			[CATCHMENT_LINE_ID, 'Catchment outlet (simulated outflow)'],
			['upper', 'Upper farm'],
			['gone', 'Unknown hydrological unit']
		]);
	});

	it('gives each line the line palette in order, then repeats it dashed past the seventh', () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ key: 'outflow', nodeId: `n${i}` }));
		const kinds = new Map(many.map((r) => [r.nodeId, 'farm']));
		const ord = new Map(many.map((r, i) => [r.nodeId, i]));
		const lines = cumulativeLines(many, undefined, kinds, ord, new Map());
		expect(lines.map((l) => l.color)).toEqual([...LINE_TOKENS, ...LINE_TOKENS.slice(0, 3)]);
		expect(lines.map((l) => l.style)).toEqual([...Array(7).fill('line'), 'dashed', 'dashed', 'dashed']);
		expect(new Set(lines.map((l) => `${l.color}|${l.style}`)).size).toBe(10);
	});

	it('has no lines for a run that stored no outflow', () => {
		expect(cumulativeLines([{ key: 'supplied', nodeId: 'upper' }], undefined, live, order, names)).toEqual([]);
	});
});

describe('LINE_TOKENS', () => {
	const css = readFileSync(new URL('../../../app.css', import.meta.url), 'utf8');
	for (const theme of ['light', 'dark'] as const) {
		it(`each line holds 3:1 on the card, and neighbours stay apart for every reader (${theme})`, () => {
			const card = cssHex(css, theme, '--surface');
			for (const t of LINE_TOKENS) expect(contrast(cssHex(css, theme, t), card), t).toBeGreaterThanOrEqual(3);
			for (let i = 0; i + 1 < LINE_TOKENS.length; i++) {
				const [a, b] = [LINE_TOKENS[i]!, LINE_TOKENS[i + 1]!];
				expect(worstDe(cssHex(css, theme, a), cssHex(css, theme, b)), `${a} ${b}`).toBeGreaterThanOrEqual(12);
			}
		});
	}
});

describe('eachAtOnce', () => {
	it('runs at most N at a time and keeps the items’ order', async () => {
		let running = 0;
		let peak = 0;
		const done: number[] = [];
		const out = await eachAtOnce(
			[5, 1, 4, 2, 3, 6],
			async (n) => {
				running++;
				peak = Math.max(peak, running);
				await new Promise((r) => setTimeout(r, n));
				running--;
				return n * 10;
			},
			4,
			(d) => done.push(d)
		);
		expect(out).toEqual([50, 10, 40, 20, 30, 60]);
		expect(peak).toBe(4);
		expect(done).toEqual([1, 2, 3, 4, 5, 6]);
	});
	it('rejects on the first failure', async () => {
		await expect(eachAtOnce([1, 2], async (n) => (n === 2 ? Promise.reject(new Error('no')) : n))).rejects.toThrow('no');
	});
	it('resolves an empty list at once', async () => {
		expect(await eachAtOnce([], async () => 1)).toEqual([]);
	});
});

describe('countWindow and volumeBetween', () => {
	const start = '2021-10-01';
	const view = { min: epoch('2021-10-11'), max: epoch('2021-10-20') };
	it('counts from the run’s first day, or with fromView from the first day in view, to the last day in view', () => {
		expect(countWindow(start, 120, view, false)).toEqual({ from: 0, to: 19 });
		expect(countWindow(start, 120, view, true)).toEqual({ from: 10, to: 19 });
		// No view yet (the chart hasn't drawn): the whole run.
		expect(countWindow(start, 120, null, true)).toEqual({ from: 0, to: 119 });
	});
	it('gives the volume over the window, the same as the rebased line’s last value', () => {
		const { totals } = runningTotal([1e6, 2e6, 3e6, 4e6]);
		expect(volumeBetween(totals, 0, 3)).toBe(10);
		expect(volumeBetween(totals, 2, 3)).toBe(7);
		expect(volumeBetween(totals, 2, 3)).toBe(rebase(totals, 2)[3]);
		expect(volumeBetween(totals, 3, 2)).toBeNull();
		expect(volumeBetween([], 0, 0)).toBeNull();
	});
});
