import { describe, expect, it } from 'vitest';
import { ApiError } from '$lib/api/client';
import type { SharePack, ShareScenario, ShareSeries, ShareSeriesKey, ShareView } from '$lib/api/types';
import { loadPackShare, loadScenarioShare, loadShare, type ShareApi } from './load';

const TOKEN = 'x'.repeat(43);
const VIEW = { project: { name: 'Sandspruit' } } as ShareView;
const series = (key: ShareSeriesKey, values: number[]): ShareSeries => ({ key, label: key, unit: 'm³/day', monthly: { startMonth: '2023-01', values }, recent: { startDate: '2023-01-01', values: [] } });

function fakeApi(over: Partial<ShareApi> = {}): ShareApi & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		view: async (t) => {
			calls.push(`view ${t}`);
			return VIEW;
		},
		series: async (t, key) => {
			calls.push(`series ${key}`);
			return series(key, key === 'ewr' ? [2, 2] : [1, 3]);
		},
		scenario: async (t) => {
			calls.push(`scenario ${t}`);
			return { project: { id: 'p', name: 'Sandspruit' } } as ShareScenario;
		},
		pack: async (t) => {
			calls.push(`pack ${t}`);
			return { project: { id: 'p' }, pack: { title: 'Sandspruit' } } as SharePack;
		},
		...over
	};
}

describe('loadShare', () => {
	it('asks nothing without a token', async () => {
		const api = fakeApi();
		expect(await loadShare(api, null)).toEqual({ state: 'nolink' });
		expect(api.calls).toEqual([]);
	});

	it('loads the view, then the outflow and reserve for the chart', async () => {
		const api = fakeApi();
		const r = await loadShare(api, TOKEN);
		expect(r).toEqual({ state: 'ready', view: VIEW, chartFailed: false, months: [{ month: '2023-01', flow: 1, ewr: 2 }, { month: '2023-02', flow: 3, ewr: 2 }] });
		expect(api.calls).toEqual([`view ${TOKEN}`, 'series simulated_outflow', 'series ewr']);
	});

	it('is a dead link on the view’s 404, and an error on anything else', async () => {
		expect(await loadShare(fakeApi({ view: async () => Promise.reject(new ApiError(404, 'not found')) }), TOKEN)).toEqual({ state: 'dead' });
		expect(await loadShare(fakeApi({ view: async () => Promise.reject(new ApiError(0, 'Could not reach the server')) }), TOKEN)).toEqual({ state: 'error', message: 'Could not reach the server' });
	});

	it('shows no chart when the series answer 404 (too few farms), and says so when they fail', async () => {
		const none = await loadShare(fakeApi({ series: async () => Promise.reject(new ApiError(404, 'not found')) }), TOKEN);
		expect(none).toMatchObject({ state: 'ready', months: null, chartFailed: false });
		const failed = await loadShare(fakeApi({ series: async () => Promise.reject(new ApiError(500, 'The server had a problem')) }), TOKEN);
		expect(failed).toMatchObject({ state: 'ready', months: null, chartFailed: true });
	});
});

describe('loadScenarioShare (WP-3.15)', () => {
	it('asks nothing without a token, and reads the scenario with one', async () => {
		const api = fakeApi();
		expect(await loadScenarioShare(api, null)).toEqual({ state: 'nolink' });
		expect(api.calls).toEqual([]);
		expect(await loadScenarioShare(api, TOKEN)).toMatchObject({ state: 'ready', view: { project: { name: 'Sandspruit' } } });
		expect(api.calls).toEqual([`scenario ${TOKEN}`]);
	});

	it('turns a 404 into the dead-link state and anything else into an error', async () => {
		const dead = fakeApi({ scenario: async () => Promise.reject(new ApiError(404, 'not found')) });
		expect(await loadScenarioShare(dead, TOKEN)).toEqual({ state: 'dead' });
		const down = fakeApi({ scenario: async () => Promise.reject(new Error('offline')) });
		expect(await loadScenarioShare(down, TOKEN)).toEqual({ state: 'error', message: 'offline' });
	});
});

describe('loadPackShare (128)', () => {
	it('asks nothing without a token, and reads the pack with one', async () => {
		const api = fakeApi();
		expect(await loadPackShare(api, null)).toEqual({ state: 'nolink' });
		expect(api.calls).toEqual([]);
		expect(await loadPackShare(api, TOKEN)).toMatchObject({ state: 'ready', view: { pack: { title: 'Sandspruit' } } });
		expect(api.calls).toEqual([`pack ${TOKEN}`]);
	});

	it('turns a 404 into the dead-link state and anything else into an error', async () => {
		expect(await loadPackShare(fakeApi({ pack: async () => Promise.reject(new ApiError(404, 'not found')) }), TOKEN)).toEqual({ state: 'dead' });
		expect(await loadPackShare(fakeApi({ pack: async () => Promise.reject(new Error('offline')) }), TOKEN)).toEqual({ state: 'error', message: 'offline' });
	});
});
