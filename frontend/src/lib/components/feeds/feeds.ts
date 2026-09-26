// Settings → Data feeds (docs/ui.md § Data feeds; API: docs/api.md § Data
// feeds). The types mirror backend/src/feeds/store.ts FeedMeta; the calls go
// through the app's API client, and the form helpers are pure so they can be
// tested without a page.
import type { Api } from '$lib/api';
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
	health: { state: FeedState; stale: boolean; staleAfterDays: number; message: string };
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

/** The request body for a draft, or the first problem in words. */
export function draftToBody(d: FeedDraft): { body: FeedBody } | { error: string } {
	const common = { source: d.source, targetKind: d.targetKind, targetName: d.targetName.trim(), schedule: d.schedule };
	if (d.source === 'dws') {
		const station = d.station.trim().toUpperCase();
		if (!DWS_STATION.test(station)) return { error: 'A DWS station code looks like A2H012: letter, digit, letter, three digits.' };
		return { body: { ...common, config: { station } } };
	}
	const cells = parseCells(d.cells);
	if ('error' in cells) return cells;
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
 * The server's health sentence (backend/src/feeds/health.ts) with its calendar
 * days written the way the rest of the panel writes them: "newest data
 * 2026-09-01" → "newest data 1 Sep 2026". Only bare YYYY-MM-DD days are
 * rewritten (never a timestamp), read from the string, so no time zone
 * shifts them.
 */
export const healthMessage = (message: string) => message.replace(/\b\d{4}-\d{2}-\d{2}\b(?![T:\d])/g, (d) => fmtDay(d));

/** How many feeds need attention (stale or failing), for the section's warning. */
export const needsAttention = (feeds: readonly Pick<FeedMeta, 'health'>[]) =>
	feeds.filter((f) => f.health.state === 'failing' || f.health.state === 'stale').length;
