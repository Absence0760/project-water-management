// Loading the /share page (WP-2.3 phase 2): the view, then the two flow
// series for the chart. Pure over an API, so the outcomes are unit-tested.
import { ApiError } from '$lib/api/client';
import type { SharePack, ShareScenario, ShareSeries, ShareSeriesKey, ShareView } from '$lib/api/types';
import { flowMonths, type FlowMonth } from './chart';

export interface ShareApi {
	view: (token: string) => Promise<ShareView>;
	series: (token: string, key: ShareSeriesKey) => Promise<ShareSeries>;
	scenario: (token: string) => Promise<ShareScenario>;
	pack: (token: string) => Promise<SharePack>;
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

/**
 * Every month of the run, or null when either series isn't there to show (the
 * page draws the latest, recentMonths; the member summary its period's). Any
 * other failure throws.
 */
export async function loadFlow(api: ShareApi, token: string): Promise<FlowMonth[] | null> {
	try {
		const [flow, ewr] = await Promise.all([api.series(token, 'simulated_outflow'), api.series(token, 'ewr')]);
		const months = flowMonths(flow, ewr, Infinity);
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

/** A scenario link (WP-3.15): the same dead-link and error states as the catchment view's. */
export type ScenarioShareLoad =
	| { state: 'nolink' }
	| { state: 'dead' }
	| { state: 'error'; message: string }
	| { state: 'ready'; view: ShareScenario };

export async function loadScenarioShare(api: Pick<ShareApi, 'scenario'>, token: string | null): Promise<ScenarioShareLoad> {
	if (!token) return { state: 'nolink' };
	try {
		return { state: 'ready', view: await api.scenario(token) };
	} catch (e) {
		if (is404(e)) return { state: 'dead' };
		return { state: 'error', message: e instanceof Error ? e.message : String(e) };
	}
}

/** A pack link (128): the same dead-link and error states. A withdrawn or superseded pack is `ready`: the page says it no longer stands. */
export type PackShareLoad =
	| { state: 'nolink' }
	| { state: 'dead' }
	| { state: 'error'; message: string }
	| { state: 'ready'; view: SharePack };

export async function loadPackShare(api: Pick<ShareApi, 'pack'>, token: string | null): Promise<PackShareLoad> {
	if (!token) return { state: 'nolink' };
	try {
		return { state: 'ready', view: await api.pack(token) };
	} catch (e) {
		if (is404(e)) return { state: 'dead' };
		return { state: 'error', message: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Wraps a loader so only its latest call's answer counts: an earlier call that
 * comes back later answers `{ current: false }`. The page loads again when a
 * new link is pasted into the tab (hashchange) or on Try again, and an earlier
 * link's slower answer must never replace the newer one's.
 */
export function latestOnly<A extends unknown[], R>(load: (...args: A) => Promise<R>): (...args: A) => Promise<{ current: true; value: R } | { current: false }> {
	let seq = 0;
	return async (...args: A) => {
		const mine = ++seq;
		const value = await load(...args);
		return mine === seq ? { current: true, value } : { current: false };
	};
}
