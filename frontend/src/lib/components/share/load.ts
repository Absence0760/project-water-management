// Loading the /share page (WP-2.3 phase 2): the view, then the two flow
// series for the chart. Pure over an API, so the outcomes are unit-tested.
import { ApiError } from '$lib/api/client';
import type { ShareSeries, ShareSeriesKey, ShareView } from '$lib/api/types';
import { flowMonths, type FlowMonth } from './chart';

export interface ShareApi {
	view: (token: string) => Promise<ShareView>;
	series: (token: string, key: ShareSeriesKey) => Promise<ShareSeries>;
}

export type ShareLoad =
	/** No token in the address (a link cut short). */
	| { state: 'nolink' }
	/** The server's 404: unknown, revoked or expired, or nothing published. */
	| { state: 'dead' }
	| { state: 'error'; message: string }
	/**
	 * `months` null: no chart (a catchment with too few farms, or a series the
	 * run doesn't have). `chartFailed`: the series couldn't be loaded (the page
	 * says so; the status and the notice stand without it).
	 */
	| { state: 'ready'; view: ShareView; months: FlowMonth[] | null; chartFailed: boolean };

const is404 = (e: unknown) => e instanceof ApiError && e.status === 404;

/** The chart's months, or null when either series isn't there to show. Any other failure throws. */
export async function loadFlow(api: ShareApi, token: string): Promise<FlowMonth[] | null> {
	try {
		const [flow, ewr] = await Promise.all([api.series(token, 'simulated_outflow'), api.series(token, 'ewr')]);
		const months = flowMonths(flow, ewr);
		return months.length ? months : null;
	} catch (e) {
		if (is404(e)) return null;
		throw e;
	}
}

export async function loadShare(api: ShareApi, token: string | null): Promise<ShareLoad> {
	if (!token) return { state: 'nolink' };
	try {
		const view = await api.view(token);
		try {
			return { state: 'ready', view, months: await loadFlow(api, token), chartFailed: false };
		} catch {
			return { state: 'ready', view, months: null, chartFailed: true };
		}
	} catch (e) {
		if (is404(e)) return { state: 'dead' };
		return { state: 'error', message: e instanceof Error ? e.message : String(e) };
	}
}
