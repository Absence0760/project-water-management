// Settings → Data feeds (docs/ui.md § Data feeds; API: docs/api.md § Data
// feeds). The types mirror backend/src/feeds/store.ts FeedMeta; the calls go
// through the app's API client, and the form helpers are pure so they can be
// tested without a page.
import type { SeriesMeta } from '@water-management/engine';
import type { Api } from '$lib/api';
import { ApiError } from '$lib/api/client';
import { fmtDate, fmtDay } from '$lib/format/number';
import { kindLabel } from '$lib/series/kinds';

export type FeedSource = 'chirps' | 'chirps_gefs' | 'dws';
export type FeedState = 'ok' | 'stale' | 'failing' | 'pending' | 'disabled';

export interface GridCell {
	lat: number;
	lon: number;
	weight?: number;
}

export interface FeedMeta {
	id: string;
	source: FeedSource;
	config: { cells?: GridCell[]; station?: string; startDate?: string; staleAfterDays?: number };
	targetKind: string;
	targetName: string;
	enabled: boolean;
	schedule: 'daily' | 'hourly';
	createdAt: string;
	updatedAt: string;
	actingUser: string | null;
	lastAttemptAt: string | null;
	lastSuccessAt: string | null;
	lastDataDate: string | null;
	lastValue: number | null;
	consecutiveFailures: number;
	lastError: string | null;
	lastMeta: Record<string, string | number> | null;
	health: FeedHealth;
}

/** Why a feed is in its state (backend/src/feeds/health.ts HealthReason); days are YYYY-MM-DD, UTC. */
export type HealthReason =
	| { code: 'off'; newest: string | null }
	| { code: 'failing'; failures: number; error: string | null; newest: string | null }
	| { code: 'old-forecast'; newest: string }
	| { code: 'old-data'; newest: string }
	| { code: 'no-data' }
	| { code: 'not-fetched'; since: string; after: 'attached' | 'changed' }
	| { code: 'waiting' }
	| { code: 'ok'; newest: string | null; checked: string };

export interface FeedHealth {
	state: FeedState;
	stale: boolean;
	staleAfterDays: number;
	reason: HealthReason;
}

export interface SourceOption {
	source: FeedSource;
	label: string;
	kinds: string[];
	unit: string;
}

export interface FeedList {
	feeds: FeedMeta[];
	sources: SourceOption[];
	schedules: string[];
	/** fixtures: this server reads synthetic files, not the real sources. */
	mode: 'fixtures' | 'live';
	canEdit: boolean;
	canRun: boolean;
}

export interface FeedBody {
	source: FeedSource;
	config: { cells: GridCell[] } | { station: string };
	targetKind: string;
	targetName: string;
	schedule: 'daily' | 'hourly';
}

export function feedsApi(api: Pick<Api, 'request'>, projectId: string) {
	const base = `/projects/${encodeURIComponent(projectId)}/feeds`;
	const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
	return {
		list: () => api.request<FeedList>('GET', base),
		create: (body: FeedBody) => api.request<{ feed: FeedMeta }>('POST', base, body).then((r) => r.feed),
		update: (id: string, patch: Partial<FeedBody> & { enabled?: boolean }) => api.request<{ feed: FeedMeta }>('PATCH', one(id), patch).then((r) => r.feed),
		remove: (id: string) => api.request<void>('DELETE', one(id)),
		runNow: (id: string) => api.request<{ created: boolean }>('POST', `${one(id)}/run-now`)
	};
}

/** The form's state: text fields as typed. */
export interface FeedDraft {
	source: FeedSource;
	/** One cell per line: "lat, lon" or "lat, lon, weight". */
	cells: string;
	station: string;
	targetKind: string;
	targetName: string;
	schedule: 'daily' | 'hourly';
}

export const emptyDraft = (source: FeedSource = 'chirps', kinds: string[] = []): FeedDraft => ({
	source,
	cells: '',
	station: '',
	targetKind: kinds[0] ?? '',
	targetName: '',
	schedule: 'daily'
});

const NUM = /^[+-]?(\d+\.?\d*|\.\d+)$/;
/** The largest cell weight the server takes (GridConfig). */
const MAX_WEIGHT = 1000;

/**
 * Parse the cells box. Returns the cells, or the first problem in words. The
 * limits are the server's (backend/src/feeds/config.ts GridConfig). A typeset
 * minus sign (U+2212, as the sample-grid hint writes it) counts as "-", so a
 * value copied from the page parses.
 */
export function parseCells(text: string): { cells: GridCell[] } | { error: string } {
	const lines = text
		.replace(/\u2212/g, '-')
		.split(/\n|;/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (!lines.length) return { error: 'Enter at least one grid cell as “latitude, longitude”.' };
	if (lines.length > 25) return { error: 'At most 25 cells.' };
	const cells: GridCell[] = [];
	for (const [i, line] of lines.entries()) {
		const parts = line.split(/[,\s]+/).filter(Boolean);
		if (parts.length < 2 || parts.length > 3 || !parts.every((p) => NUM.test(p))) {
			return { error: `Cell ${i + 1} (“${line}”) should be “latitude, longitude” or “latitude, longitude, weight”.` };
		}
		const [lat, lon, weight] = parts.map(Number) as [number, number, number | undefined];
		if (lat < -60 || lat > 60) return { error: `Cell ${i + 1}: the latitude must be between -60 and 60 (the CHIRPS grid).` };
		if (lon < -180 || lon > 180) return { error: `Cell ${i + 1}: the longitude must be between -180 and 180.` };
		if (weight !== undefined && !(weight > 0 && weight <= MAX_WEIGHT)) return { error: `Cell ${i + 1}: the weight must be above 0 and at most ${MAX_WEIGHT}.` };
		cells.push(weight === undefined ? { lat, lon } : { lat, lon, weight });
	}
	return { cells };
}

export const DWS_STATION = /^[A-Z]\d[A-Z]\d{3}$/;
/** Only river gauges (H codes) can be fed: the backend's DWS_RIVER_GAUGE (feeds/config.ts) says why. */
export const DWS_RIVER_GAUGE = /^[A-Z]\d[H]\d{3}$/;

/** The request body for a draft, or the first problem in words and the field it is in. */
export function draftToBody(d: FeedDraft): { body: FeedBody } | { error: string; field: 'cells' | 'station' } {
	const common = { source: d.source, targetKind: d.targetKind, targetName: d.targetName.trim(), schedule: d.schedule };
	if (d.source === 'dws') {
		const station = d.station.trim().toUpperCase();
		if (!DWS_STATION.test(station)) return { error: 'A DWS station code looks like A2H012: letter, digit, letter, three digits.', field: 'station' };
		if (!DWS_RIVER_GAUGE.test(station)) return { error: 'Only a DWS river gauge can be fed (an H code, e.g. A2H012): a reservoir’s (R) daily table is its spillway discharge, not the river’s flow.', field: 'station' };
		return { body: { ...common, config: { station } } };
	}
	const cells = parseCells(d.cells);
	if ('error' in cells) return { error: cells.error, field: 'cells' };
	return { body: { ...common, config: { cells: cells.cells } } };
}

/** Where a feed reads, in words. */
export function describePlace(f: Pick<FeedMeta, 'source' | 'config'>): string {
	if (f.source === 'dws') return `station ${f.config.station ?? '?'}`;
	const cells = f.config.cells ?? [];
	if (cells.length === 1) return `cell ${cells[0]!.lat}, ${cells[0]!.lon}`;
	return `${cells.length} cells`;
}

export const describeTarget = (f: Pick<FeedMeta, 'targetKind' | 'targetName'>) => `${kindLabel(f.targetKind)}${f.targetName ? ` · ${f.targetName}` : ''}`;

/**
 * Who the feed's fetches run as, after the schedule (" · runs as Ann"). With
 * no acting owner (that account was deleted) the scheduler skips the feed
 * until an owner saves it; the panel has no edit form, so the way to save it
 * is to switch it off and on again (each save makes the saver the acting
 * owner: 018_feeds.sql data_feed_stamp).
 */
export const describeRunsAs = (f: Pick<FeedMeta, 'actingUser'>) =>
	f.actingUser ? ` · runs as ${f.actingUser}` : ' · no acting owner: scheduled fetches are skipped until an owner switches it off and on again';

export const STATE_LABELS: Record<FeedState, string> = {
	ok: 'OK',
	stale: 'Stale',
	failing: 'Failing',
	pending: 'Waiting',
	disabled: 'Off'
};

/** "Last data 21 Sep 2026 · checked 2026-09-24 06:00", or what is missing. */
export function describeTimes(f: Pick<FeedMeta, 'lastDataDate' | 'lastAttemptAt'>): string {
	const data = f.lastDataDate ? `Last data ${fmtDay(f.lastDataDate)}` : 'No data yet';
	return f.lastAttemptAt ? `${data} · checked ${fmtDate(f.lastAttemptAt, true)}` : `${data} · not checked yet`;
}

/**
 * The health sentence for a feed, from the server's reason code and its facts
 * (backend/src/feeds/health.ts). Days are calendar days, written with fmtDay
 * ("1 Sep 2026") straight from their YYYY-MM-DD, so no time zone shifts them.
 * A code this client doesn't know (a newer server) falls back to the state.
 */
export function healthMessage(h: FeedHealth): string {
	const r = h.reason;
	const newest = (d: string | null) => (d ? `newest data ${fmtDay(d)}` : 'no data yet');
	switch (r.code) {
		case 'off':
			return `Switched off; ${newest(r.newest)}.`;
		case 'failing': {
			const what = r.failures === 1 ? 'The last fetch failed' : `The last ${r.failures} fetches failed`;
			const n = newest(r.newest);
			return `${what}: ${r.error ?? 'unknown error'}. ${n.charAt(0).toUpperCase()}${n.slice(1)}.`;
		}
		case 'old-forecast':
			return `No new forecast: it reaches only ${fmtDay(r.newest)}, less than ${-h.staleAfterDays} days ahead.`;
		case 'old-data':
			return `No new data: the newest day, ${fmtDay(r.newest)}, is more than ${h.staleAfterDays} days old.`;
		case 'no-data':
			return 'Fetches succeed but have found no data yet: check the cells or station.';
		case 'not-fetched':
			return `Not fetched since it was ${r.after} on ${fmtDay(r.since)}: the background worker may not be running.`;
		case 'waiting':
			return 'Waiting for its first fetch.';
		case 'ok':
			return `OK; ${newest(r.newest)}, checked ${fmtDay(r.checked)}.`;
		default:
			return `${STATE_LABELS[h.state] ?? 'Unknown state'}.`;
	}
}

/**
 * The existing series a new feed would take over, or null. A feed replaces
 * its target's values on every day it fetches, uploaded and imported ones
 * included (docs/architecture.md § Data feeds), so the form asks first when
 * the target already holds data. A series another feed already writes is not
 * a takeover: the server refuses a second feed for it with its own message.
 */
export function takeoverOf(
	series: readonly Pick<SeriesMeta, 'kind' | 'name' | 'length'>[],
	feeds: readonly Pick<FeedMeta, 'targetKind' | 'targetName'>[],
	target: Pick<FeedBody, 'targetKind' | 'targetName'>
): Pick<SeriesMeta, 'kind' | 'name' | 'length'> | null {
	if (feeds.some((f) => f.targetKind === target.targetKind && f.targetName === target.targetName)) return null;
	return series.find((s) => s.kind === target.targetKind && s.name === target.targetName && s.length > 0) ?? null;
}

/**
 * A series name for the feed that no series or feed of that kind uses yet
 * ("CHIRPS", "CHIRPS 2", "DWS A2H012"), so the feed's values sit beside the
 * existing record instead of replacing it.
 */
export function separateName(
	body: Pick<FeedBody, 'source' | 'config' | 'targetKind'>,
	series: readonly Pick<SeriesMeta, 'kind' | 'name'>[],
	feeds: readonly Pick<FeedMeta, 'targetKind' | 'targetName'>[]
): string {
	const base = 'station' in body.config ? `DWS ${body.config.station}` : body.source === 'chirps_gefs' ? 'CHIRPS-GEFS' : 'CHIRPS';
	const taken = new Set([...series.filter((s) => s.kind === body.targetKind).map((s) => s.name), ...feeds.filter((f) => f.targetKind === body.targetKind).map((f) => f.targetName)]);
	let name = base;
	for (let i = 2; taken.has(name); i++) name = `${base} ${i}`;
	return name;
}

/** How many feeds need attention (stale or failing), for the section's warning. */
export const needsAttention = (feeds: readonly Pick<FeedMeta, 'health'>[]) =>
	feeds.filter((f) => f.health.state === 'failing' || f.health.state === 'stale').length;

/**
 * What to show for a failed call. The server's own message (already written
 * for people, and never raw database text: backend/src/http/errors.ts) starts
 * with a capital; anything else, such as a script error, gets a generic
 * sentence instead of its raw text.
 */
export function errorText(e: unknown): string {
	if (e instanceof ApiError && e.message) return e.message.charAt(0).toUpperCase() + e.message.slice(1);
	return 'Something went wrong. Try again, or reload the page.';
}
