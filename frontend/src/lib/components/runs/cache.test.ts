import type { DailySeries } from '@water-management/engine';
import { describe, expect, it, vi } from 'vitest';
import { cachedSeries, forgetRun, prefetchSeries } from './cache';

const series = (v: number): DailySeries => ({ startDate: '2021-10-01', values: [v] });
const ref = (key: string, nodeId: string | null = null) => ({ key, nodeId }) as never;

describe('prefetchSeries', () => {
	it('starts every wanted series the run stores, and a chart asking later gets the same request', async () => {
		const runId = crypto.randomUUID();
		const fetch = vi.fn((key: string, _nodeId: string | null) => Promise.resolve(series(key.length)));
		prefetchSeries(runId, [ref('ewr'), ref('simulated_outflow'), ref('ewr', 'farm-1')], [{ key: 'ewr', nodeId: null }, { key: 'simulated_outflow', nodeId: null }, { key: 'natural_flow', nodeId: null }], fetch);
		// natural_flow isn't stored by this run: not asked for.
		expect(fetch.mock.calls.map(([key, nodeId]) => [key, nodeId])).toEqual([
			['ewr', null],
			['simulated_outflow', null]
		]);
		const again = vi.fn(() => Promise.resolve(series(0)));
		await expect(cachedSeries(runId, 'ewr', null, again)).resolves.toEqual(series(3));
		expect(again).not.toHaveBeenCalled();
		forgetRun(runId);
	});

	it('leaves a failed prefetch out of the cache, so the chart fetches it again', async () => {
		const runId = crypto.randomUUID();
		prefetchSeries(runId, [ref('ewr')], [{ key: 'ewr', nodeId: null }], () => Promise.reject(new Error('offline')));
		await Promise.resolve();
		await Promise.resolve();
		const retry = vi.fn(() => Promise.resolve(series(1)));
		await expect(cachedSeries(runId, 'ewr', null, retry)).resolves.toEqual(series(1));
		expect(retry).toHaveBeenCalledTimes(1);
		forgetRun(runId);
	});
});
