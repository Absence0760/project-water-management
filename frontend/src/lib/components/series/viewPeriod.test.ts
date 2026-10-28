import { describe, expect, it } from 'vitest';
import { viewPeriod, viewPeriodHref } from './viewPeriod';

describe('a link to the chart on one period', () => {
	it('names the record and the period, and lands on the chart', () => {
		expect(viewPeriodHref('a b/c', '2015-03-10', '2015-03-12')).toBe('?tab=series&series=a%20b%2Fc&view=2015-03-10~2015-03-12#data-chart');
	});

	it('reads back the period it wrote', () => {
		const view = new URLSearchParams(viewPeriodHref('s1', '2015-03-10', '2015-03-12').slice(1).split('#')[0]).get('view');
		expect(viewPeriod(view)).toEqual({ start: '2015-03-10', end: '2015-03-12' });
		expect(viewPeriod('2015-03-10~2015-03-10')).toEqual({ start: '2015-03-10', end: '2015-03-10' });
	});

	it('names no period for a missing, malformed or backwards parameter', () => {
		for (const p of [null, '', '2015-03-10', '2015-03-10~', '2015-3-10~2015-03-12', '2015-03-12~2015-03-10', '2015-03-10~2015-03-12~2015-03-14', '2015-13-45~2015-13-46'])
			expect(viewPeriod(p), String(p)).toBeNull();
	});
});
