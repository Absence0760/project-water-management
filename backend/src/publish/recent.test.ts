// Farms short in the 7 and 30 days to dataUntil (WP-2.14), stored with a
// publication for the portfolio dashboard.
import type { NetworkNode, ProjectionRun } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { recentShortfall } from './recent.js';

const DAYS = 40; // 2026-01-01 … 2026-02-09
const farm = (id: string) => ({ id, name: id, kind: 'farm' }) as unknown as NetworkNode;
const gauge = { id: 'g', name: 'Weir', kind: 'gauge' } as unknown as NetworkNode;

function runWith(deficits: Record<string, (number | null)[]>): ProjectionRun {
	return {
		startDate: '2026-01-01',
		endDate: '2026-02-09',
		nodes: [gauge, ...Object.keys(deficits).map(farm)],
		transfers: [],
		series: (nodeId, key) => (key === 'deficit' && nodeId ? deficits[nodeId] : undefined)
	};
}
const zeros = () => new Array<number | null>(DAYS).fill(0);
const withShort = (day: number, v = 5) => {
	const a = zeros();
	a[day] = v;
	return a;
};
// The windows analyseSeason gives a 40-day run to its last day: the last 30 days, indices 10…39.
const last30 = { from: 10, to: 39 };

describe('recentShortfall', () => {
	it('counts a farm short this week in both windows, one short only earlier in the month in the 30 days', () => {
		const r = recentShortfall(runWith({ thisWeek: withShort(36), earlier: withShort(15), never: zeros(), beforeWindow: withShort(5) }), { last30: { ...last30, fromDate: '', toDate: '' } });
		expect(r).toEqual({ to: '2026-02-09', from7: '2026-02-03', from30: '2026-01-11', farmsShort7: 1, farmsShort30: 2 });
	});

	it('the window edges are inclusive: day to−6 is this week, day to−7 is not', () => {
		expect(recentShortfall(runWith({ a: withShort(33) }), { last30: { ...last30, fromDate: '', toDate: '' } }).farmsShort7).toBe(1);
		expect(recentShortfall(runWith({ a: withShort(32) }), { last30: { ...last30, fromDate: '', toDate: '' } })).toMatchObject({ farmsShort7: 0, farmsShort30: 1 });
	});

	it('float noise and missing days are not short days', () => {
		const a = zeros();
		a[38] = 1e-9;
		a[37] = null;
		expect(recentShortfall(runWith({ a }), { last30: { ...last30, fromDate: '', toDate: '' } })).toMatchObject({ farmsShort7: 0, farmsShort30: 0 });
	});

	it('a network with no farms counts none', () => {
		expect(recentShortfall(runWith({}), { last30: { ...last30, fromDate: '', toDate: '' } })).toMatchObject({ farmsShort7: 0, farmsShort30: 0 });
	});

	it('a window cut short by the run start (a run under 30 days) counts what there is', () => {
		const r = recentShortfall(runWith({ a: withShort(2) }), { last30: { from: 0, to: 4, fromDate: '', toDate: '' } });
		expect(r).toEqual({ to: '2026-01-05', from7: '2026-01-01', from30: '2026-01-01', farmsShort7: 1, farmsShort30: 1 });
	});
});
