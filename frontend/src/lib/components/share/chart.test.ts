import { afterEach, describe, expect, it } from 'vitest';
import type { ShareSeries } from '$lib/api/types';
import { CHART_BASE } from '$lib/components/farm/chart';
import { addMonths, FLOW_MONTHS, flowCaption, flowChart, flowMonths, flowRows, flowSummary, flowVerdict, monthsBelow, recentMonths } from './chart';

const sp = (s: string) => s.replace(/[  ]/g, ' ');
const series = (key: ShareSeries['key'], startMonth: string, values: (number | null)[]): ShareSeries => ({
	key,
	label: key,
	unit: 'm³/day',
	monthly: { startMonth, values },
	recent: { startDate: `${startMonth}-01`, values: [] }
});

describe('addMonths', () => {
	it('crosses years both ways', () => {
		expect(addMonths('2021-10', 0)).toBe('2021-10');
		expect(addMonths('2021-10', 3)).toBe('2022-01');
		expect(addMonths('2021-10', 26)).toBe('2023-12');
		expect(addMonths('2022-01', -1)).toBe('2021-12');
	});
});

describe('flowMonths', () => {
	it('pairs each month with the reserve of the same month, and keeps the latest ones', () => {
		const flow = series('simulated_outflow', '2021-10', [10, 20, 30, 40]);
		const ewr = series('ewr', '2021-11', [5, 25, 35]);
		expect(flowMonths(flow, ewr)).toEqual([
			{ month: '2021-10', flow: 10, ewr: null },
			{ month: '2021-11', flow: 20, ewr: 5 },
			{ month: '2021-12', flow: 30, ewr: 25 },
			{ month: '2022-01', flow: 40, ewr: 35 }
		]);
		expect(flowMonths(flow, ewr, 2).map((m) => m.month)).toEqual(['2021-12', '2022-01']);
		const long = series('simulated_outflow', '2020-01', Array.from({ length: 40 }, (_, i) => i));
		expect(flowMonths(long, long)).toHaveLength(24);
		expect(flowMonths(long, long)[0]!.month).toBe('2021-05');
	});
});

describe('flowChart', () => {
	const months = flowMonths(series('simulated_outflow', '2023-01', [1000, null, 3000, 4000]), series('ewr', '2023-01', [2000, 2000, 2000, 2000]));

	it('breaks the flow line at a month with no value and rounds the axis', () => {
		const c = flowChart(months, 300);
		expect(c.flow).toHaveLength(2);
		expect(c.ewr).toHaveLength(1);
		expect(c.ticks.map((t) => sp(t.label))).toEqual(['4 000', '2 000', '0']);
		expect(c.ticks[2]!.y).toBe(CHART_BASE);
		// Every point sits inside the plot.
		for (const p of [...c.flow, ...c.ewr].join(' ').split(' ')) {
			const [x, y] = p.split(',').map(Number) as [number, number];
			expect(x).toBeGreaterThan(c.axisLeft);
			expect(x).toBeLessThan(300);
			expect(y).toBeLessThanOrEqual(CHART_BASE);
		}
	});

	it('labels fewer months on a narrow chart, always the latest', () => {
		const many = flowMonths(series('simulated_outflow', '2022-01', Array(24).fill(1)), series('ewr', '2022-01', Array(24).fill(1)));
		const narrow = flowChart(many, 320).labels;
		const wide = flowChart(many, 1200).labels;
		expect(narrow.length).toBeLessThan(wide.length);
		expect(narrow.at(-1)!.label).toBe(wide.at(-1)!.label);
		expect(narrow.at(-1)!.x).toBeCloseTo(320 - (320 - flowChart(many, 320).axisLeft) / 48, 5);
		expect(wide).toHaveLength(24);
	});

	it('draws an empty or all-zero series without dividing by zero', () => {
		const c = flowChart(flowMonths(series('simulated_outflow', '2023-01', [0, 0]), series('ewr', '2023-01', [0, 0])), 200);
		expect(c.flow[0]).not.toContain('NaN');
		expect(flowChart([], 200).flow).toEqual([]);
	});
});

describe('the words', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});

	it('sums the chart up and gives every month in the table, in any time zone', () => {
		for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
			process.env.TZ = zone;
			const months = flowMonths(series('simulated_outflow', '2023-11', [1000, 3000, null]), series('ewr', '2023-11', [2000, 2000, 2000]));
			expect(monthsBelow(months).map((m) => m.month)).toEqual(['2023-11']);
			expect(flowSummary(months)).toBe(
				'River flow at the catchment outlet each month against its ecological reserve, November 2023 to January 2024. The mean flow was below the reserve in 1 of the 3 months. The numbers are in the table below.'
			);
			expect(flowCaption(months)).toBe('Nov 2023 to Jan 2024. Monthly means of the modelled daily flow.');
			expect(flowRows(months).map((r) => ({ ...r, flow: sp(r.flow), ewr: sp(r.ewr) }))).toEqual([
				{ label: 'Nov 2023', flow: '1 000 m³', ewr: '2 000 m³' },
				{ label: 'Dec 2023', flow: '3 000 m³', ewr: '2 000 m³' },
				{ label: 'Jan 2024', flow: '–', ewr: '2 000 m³' }
			]);
		}
	});

	it('says so when every month, or none, was below', () => {
		const all = flowMonths(series('simulated_outflow', '2023-01', [1, 1]), series('ewr', '2023-01', [2, 2]));
		const none = flowMonths(series('simulated_outflow', '2023-01', [3, 3]), series('ewr', '2023-01', [2, 2]));
		expect(flowSummary(all)).toContain('below the reserve in every month');
		expect(flowSummary(none)).toContain('above the reserve in every month');
		expect(flowSummary([])).toBe('No flows to show.');
	});
});

describe('recentMonths and flowVerdict', () => {
	it('draws the latest FLOW_MONTHS on the page', () => {
		const all = Array.from({ length: 40 }, (_, i) => ({ month: addMonths('2020-01', i), flow: 1, ewr: 2 }));
		expect(recentMonths(all)).toHaveLength(FLOW_MONTHS);
		expect(recentMonths(all).at(-1)!.month).toBe(all.at(-1)!.month);
		expect(recentMonths(all.slice(0, 3))).toHaveLength(3);
	});

	it('is the summary sentence’s verdict on its own', () => {
		const months = [
			{ month: '2023-01', flow: 1, ewr: 2 },
			{ month: '2023-02', flow: 3, ewr: 2 }
		];
		expect(flowVerdict(months)).toBe('The mean flow was below the reserve in 1 of the 2 months.');
		expect(flowSummary(months)).toContain(flowVerdict(months));
	});
});

describe('a chart longer than two years', () => {
	it('labels the years, not bare month names', () => {
		const months = Array.from({ length: 360 }, (_, i) => ({ month: addMonths('1994-01', i), flow: 1, ewr: 2 }));
		const labels = flowChart(months, 680).labels.map((l) => l.label);
		expect(labels.length).toBeGreaterThan(2);
		for (const l of labels) expect(l).toMatch(/^\d{4}$/);
		const xs = flowChart(months, 680).labels.map((l) => l.x);
		for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(48);
	});

	it('keeps month names within two years', () => {
		const months = Array.from({ length: FLOW_MONTHS }, (_, i) => ({ month: addMonths('2022-01', i), flow: 1, ewr: 2 }));
		expect(flowChart(months, 680).labels.every((l) => !/^\d{4}$/.test(l.label))).toBe(true);
	});
});
