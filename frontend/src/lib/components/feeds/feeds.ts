// Settings → Data feeds (docs/ui.md § Data feeds; API: docs/api.md § Data
// feeds). The types mirror backend/src/feeds/store.ts FeedMeta; the calls go
// through the app's API client, and the form helpers are pure so they can be
// tested without a page.
import { CHIRPS_V3_RNL, CHIRPS_V3_SAT, provenanceLabel, sameProvenance, type SeriesMeta, type SeriesProvenance } from '@water-management/engine';
import type { Api } from '$lib/api';
import type { UnitRainApplyBody, UnitRainApplyResult, UnitRainProposal } from '$lib/api/types';
import { ApiError } from '$lib/api/client';
import { fmtDate, fmtDay, fmtNum } from '$lib/format/number';
import { kindLabel } from '$lib/series/kinds';

export type FeedSource = 'chirps' | 'chirps_gefs' | 'dws';
/** CHIRPS v3's two daily products (backend/src/feeds/config.ts CHIRPS_DAILY_PRODUCTS). */
export type ChirpsProduct = 'sat' | 'rnl';
export type FeedState = 'ok' | 'stale' | 'failing' | 'pending' | 'disabled';

export interface GridCell {
	lat: number;
	lon: number;
	weight?: number;
}

/** A bounding box in degrees: the feed reads every 0.05° cell it overlaps, area weighted (backend feeds/config.ts bboxCells). */
export interface Bbox {
	south: number;
	west: number;
	north: number;
	east: number;
}

/** The catchment boundary a feed's cells were computed from (backend feeds/config.ts BoundaryMark, issue #326 B-rain). */
export interface BoundaryMark {
	featureId: string;
	name: string;
	/** The boundary's version when its cells were taken (map_feature.updated_at). */
	updatedAt: string;
	areaKm2: number;
}

export interface FeedMeta {
	id: string;
	source: FeedSource;
	config: {
		cells?: GridCell[];
		bbox?: Bbox;
		skipNoData?: boolean;
		station?: string;
		startDate?: string;
		staleAfterDays?: number;
		product?: ChirpsProduct;
		boundary?: BoundaryMark;
		/** The land unit's parcel the cells came from (issue #482, …/feeds/chirps/from-units): the feed writes that unit's own rain. */
		unit?: { nodeId: string; featureId: string; updatedAt: string; areaKm2: number };
	};
	targetKind: string;
	targetName: string;
	enabled: boolean;
	/** Always daily (backend FEED_SCHEDULES): no source publishes more often. */
	schedule: 'daily';
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
	/** What the feed writes (CHIRPS sat v3.0 …); null for the forecast and DWS. */
	writes: SeriesProvenance | null;
	/** The target series now, or null when it doesn't exist. */
	series: { filled: boolean; provenance: SeriesProvenance | null } | null;
	/** The target holds another product or version: every fetch is refused until an owner confirms replacing it. */
	versionConflict: boolean;
	/** A confirmed replacement waiting for the next fetch: what it will replace ('' = unrecorded). */
	replaceFrom: string | null;
	/** A confirmed replacement being backfilled in its stage: the new record so far. */
	rebuilding?: { startDate: string; through: string; updatedAt: string } | null;
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
	| { code: 'ok'; newest: string | null; checked: string }
	| { code: 'rebuilding'; from: string; through: string }
	| { code: 'rebuild-stalled'; from: string; through: string; since: string };

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
	config: ({ cells: GridCell[] } | { bbox: Bbox; skipNoData?: true }) & { product?: ChirpsProduct; startDate?: string } | { station: string };
	targetKind: string;
	targetName: string;
	schedule: 'daily';
	/** The owner confirmed replacing a target that holds another product or version (issue #40c). */
	replaceSeries?: boolean;
}

/** A boundary cell in the proposal: its weight in the mean and the share of it inside the boundary. */
export interface BoundaryCell {
	lat: number;
	lon: number;
	weight: number;
	share: number;
}

/** GET …/feeds/chirps/from-boundary (backend feeds/fromBoundary.ts). */
export interface BoundaryProposal {
	boundary: BoundaryMark;
	cells: BoundaryCell[];
	rows: number;
	/** The whole area of the cells read, and the part inside the boundary, km². */
	cellsKm2: number;
	insideKm2: number;
	method: string;
	/** What Apply does: nothing (a feed reads this boundary already), give an empty feed the cells, or attach a new feed. */
	apply:
		| { action: 'none'; feedId: string }
		| { action: 'update'; feedId: string; targetKind: string; targetName: string }
		| { action: 'create'; targetKind: string; targetName: string };
	canApply: boolean;
}

export function feedsApi(api: Pick<Api, 'request'>, projectId: string) {
	const base = `/projects/${encodeURIComponent(projectId)}/feeds`;
	const one = (id: string) => `${base}/${encodeURIComponent(id)}`;
	return {
		list: () => api.request<FeedList>('GET', base),
		create: (body: FeedBody) => api.request<{ feed: FeedMeta }>('POST', base, body).then((r) => r.feed),
		update: (id: string, patch: Partial<FeedBody> & { enabled?: boolean; replaceSeries?: boolean }) => api.request<{ feed: FeedMeta }>('PATCH', one(id), patch).then((r) => r.feed),
		remove: (id: string) => api.request<void>('DELETE', one(id)),
		runNow: (id: string) => api.request<{ created: boolean }>('POST', `${one(id)}/run-now`),
		/** The CHIRPS cells the map's catchment boundary covers, and what applying them would do (issue #326 B-rain). */
		boundaryProposal: () => api.request<BoundaryProposal>('GET', `${base}/chirps/from-boundary`),
		/** Apply the proposal made from this version of the boundary (refused once the boundary has changed). */
		applyBoundary: (p: Pick<BoundaryProposal, 'boundary' | 'apply'>) =>
			api
				.request<{ feed: FeedMeta }>('POST', `${base}/chirps/from-boundary`, {
					featureId: p.boundary.featureId,
					updatedAt: p.boundary.updatedAt,
					...(p.apply.action === 'update' ? { feedId: p.apply.feedId } : p.apply.action === 'create' ? { targetName: p.apply.targetName } : {})
				})
				.then((r) => r.feed),
		/** Each land unit's CHIRPS cells from its parcel on the map, and its own feed (issue #482); `product`: as POST would set them up with it. */
		unitsProposal: (product?: ChirpsProduct) => api.request<UnitRainProposal>('GET', `${base}/chirps/from-units${product ? `?product=${product}` : ''}`),
		/** Create or update one CHIRPS feed per unit into its own rain series. */
		applyUnits: (body: UnitRainApplyBody) => api.request<UnitRainApplyResult>('POST', `${base}/chirps/from-units`, body)
	};
}

/** The form's state: text fields as typed. */
export interface FeedDraft {
	source: FeedSource;
	/** CHIRPS / CHIRPS-GEFS: read listed cells, or every cell a bounding box overlaps. */
	area: 'cells' | 'bbox';
	/** One cell per line: "lat, lon" or "lat, lon, weight". */
	cells: string;
	/** "south, west, north, east" in degrees. */
	bbox: string;
	/** A bounding box only: leave out its sea (no-data) cells and average the rest. */
	skipNoData: boolean;
	station: string;
	targetKind: string;
	targetName: string;
	schedule: 'daily';
	/** CHIRPS only: which v3 daily product. */
	product: ChirpsProduct;
	/** CHIRPS only: the first day to fetch, YYYY-MM-DD, or '' for the default (60 days back). */
	startDate: string;
}

export const emptyDraft = (source: FeedSource = 'chirps', kinds: string[] = []): FeedDraft => ({
	source,
	area: 'cells',
	cells: '',
	bbox: '',
	skipNoData: false,
	station: '',
	targetKind: kinds[0] ?? '',
	targetName: '',
	schedule: 'daily',
	product: 'sat',
	startDate: ''
});

/** The first day each CHIRPS v3 daily product has (backend CHIRPS_PRODUCT_FIRST_DAY). */
export const CHIRPS_PRODUCT_FIRST_DAY: Record<ChirpsProduct, string> = { sat: '1998-01-01', rnl: '1981-01-01' };

/** What a feed of this source and product writes, as the series records it (backend feedProvenance). */
export const feedWrites = (source: FeedSource, product: ChirpsProduct = 'sat'): SeriesProvenance | null =>
	source !== 'chirps' ? null : product === 'rnl' ? CHIRPS_V3_RNL : CHIRPS_V3_SAT;

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
	if (lines.length > BBOX_MAX_CELLS) return { error: `At most ${BBOX_MAX_CELLS} cells.` };
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

/** The CHIRPS grid's cell size; cell edges fall on its multiples (backend CHIRPS_CELL_DEG). */
const CELL_DEG = 0.05;
/** The server's bounding-box limits (backend BBOX_MAX_CELLS, BBOX_MAX_ROWS). */
export const BBOX_MAX_CELLS = 100;
export const BBOX_MAX_ROWS = 25;
/** The cell indices [first, last) a pair of box edges spans, as the server counts them (a box edge on a grid line adds no sliver). */
const span = (lo: number, hi: number) => Math.max(0, Math.ceil(hi / CELL_DEG - 1e-6) - Math.floor(lo / CELL_DEG + 1e-6));

/** How many 0.05° cells a box covers, as the server counts them. */
export const bboxCellCount = (b: Bbox) => span(b.south, b.north) * span(b.west, b.east);

/**
 * For a box that leaves out its sea cells: how many of its cells the last
 * fetch averaged ("38 of 40 cells"), or null. The count is the ingest's
 * (last_meta.cellsUsed), which refuses a fetch whose count changed.
 */
export function cellsUsedNote(f: Pick<FeedMeta, 'config' | 'lastMeta'>): string | null {
	const n = f.lastMeta?.cellsUsed;
	if (!f.config.bbox || !f.config.skipNoData || typeof n !== 'number') return null;
	return `${n} of ${bboxCellCount(f.config.bbox)} cells`;
}

/**
 * Parse the bounding-box field, "south, west, north, east" in degrees. Returns
 * the box, or the first problem in words; the limits are the server's
 * (backend/src/feeds/config.ts GridConfig). U+2212 counts as "-", as in parseCells.
 */
export function parseBbox(text: string): { bbox: Bbox } | { error: string } {
	const parts = text.replace(/\u2212/g, '-').split(/[,\s]+/).filter(Boolean);
	if (!parts.length) return { error: 'Enter the bounding box as “south, west, north, east” in degrees.' };
	if (parts.length !== 4 || !parts.every((p) => NUM.test(p))) return { error: 'The bounding box should be four numbers: “south, west, north, east”.' };
	const [south, west, north, east] = parts.map(Number) as [number, number, number, number];
	if ([south, north].some((v) => v < -60 || v > 60)) return { error: 'The box’s latitudes must be between -60 and 60 (the CHIRPS grid).' };
	if ([west, east].some((v) => v < -180 || v > 180)) return { error: 'The box’s longitudes must be between -180 and 180.' };
	if (!(south < north)) return { error: 'The south edge must be below the north edge (south is the more negative latitude south of the equator).' };
	if (!(west < east)) return { error: 'The west edge must be west of the east edge; a box can’t cross 180°.' };
	const rows = span(south, north);
	const cells = rows * span(west, east);
	if (cells === 0) return { error: 'The box is too thin to cover a grid cell.' };
	if (cells > BBOX_MAX_CELLS || rows > BBOX_MAX_ROWS) {
		return {
			error: `The box covers ${cells} grid cells in ${rows} rows; at most ${BBOX_MAX_CELLS} cells in ${BBOX_MAX_ROWS} rows (about 0.5° × 0.5°, and at most 1.25° from south to north). Shrink it, or list cells instead.`
		};
	}
	return { bbox: { south, west, north, east } };
}

export const DWS_STATION = /^[A-Z]\d[A-Z]\d{3}$/;
/** Only river gauges (H codes) can be fed: the backend's DWS_RIVER_GAUGE (feeds/config.ts) says why. */
export const DWS_RIVER_GAUGE = /^[A-Z]\d[H]\d{3}$/;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The request body for a draft, or the first problem in words and the field it is in. */
export function draftToBody(d: FeedDraft): { body: FeedBody } | { error: string; field: 'cells' | 'bbox' | 'station' | 'start' } {
	const common = { source: d.source, targetKind: d.targetKind, targetName: d.targetName.trim(), schedule: d.schedule };
	if (d.source === 'dws') {
		const station = d.station.trim().toUpperCase();
		if (!DWS_STATION.test(station)) return { error: 'A DWS station code looks like A2H012: letter, digit, letter, three digits.', field: 'station' };
		if (!DWS_RIVER_GAUGE.test(station)) return { error: 'Only a DWS river gauge can be fed (an H code, e.g. A2H012): a reservoir’s (R) daily table is its spillway discharge, not the river’s flow.', field: 'station' };
		return { body: { ...common, config: { station } } };
	}
	let place: { cells: GridCell[] } | { bbox: Bbox; skipNoData?: true };
	if (d.area === 'bbox') {
		const box = parseBbox(d.bbox);
		if ('error' in box) return { error: box.error, field: 'bbox' };
		place = d.skipNoData ? { ...box, skipNoData: true } : box;
	} else {
		const cells = parseCells(d.cells);
		if ('error' in cells) return { error: cells.error, field: 'cells' };
		place = { cells: cells.cells };
	}
	if (d.source !== 'chirps') return { body: { ...common, config: place } };
	// CHIRPS: one daily product end to end, from no earlier than its first day (issue #40 part c).
	const start = d.startDate.trim();
	const first = CHIRPS_PRODUCT_FIRST_DAY[d.product];
	if (start && !ISO_DAY.test(start)) return { error: 'The start date should be a day, YYYY-MM-DD.', field: 'start' };
	if (start && start < first) {
		return {
			error:
				d.product === 'sat'
					? `The sat product begins on ${first}. For earlier days choose the rnl product, which reads 1981 onwards for the whole record.`
					: `CHIRPS begins on ${first}.`,
			field: 'start'
		};
	}
	return {
		body: {
			...common,
			config: { ...place, ...(d.product === 'rnl' ? { product: 'rnl' as const } : {}), ...(start ? { startDate: start } : {}) }
		}
	};
}

/**
 * A feed about to write into a series that holds values of another product or
 * version (or an unrecorded one): what it holds and what the feed writes, or
 * null when the feed may merge (same version, empty, or a source with no
 * version). The server refuses the attach without a confirmation either way.
 */
export function versionClash(
	series: Pick<SeriesMeta, 'length' | 'product' | 'productVersion'> | null,
	body: Pick<FeedBody, 'source' | 'config'>
): { holds: string; writes: string } | null {
	const writes = feedWrites(body.source, 'product' in body.config ? body.config.product : undefined);
	if (!writes || !series || !(series.length > 0)) return null;
	const holds = series.product && series.productVersion ? { product: series.product, version: series.productVersion } : null;
	return sameProvenance(holds, writes) ? null : { holds: provenanceLabel(holds), writes: provenanceLabel(writes) };
}

/** A listed feed whose target holds another version: what to tell the owner, or null. */
export function conflictMessage(f: Pick<FeedMeta, 'versionConflict' | 'series' | 'writes' | 'replaceFrom' | 'rebuilding'>): string | null {
	if (!f.versionConflict || !f.writes) return null;
	const holds = provenanceLabel(f.series?.provenance);
	const writes = provenanceLabel(f.writes);
	if (f.replaceFrom !== null) {
		return `Replacement confirmed: the feed backfills ${writes} from its start date, then replaces the series (${holds}) with it whole. Until then runs use the series as it is. Refit afterwards.`;
	}
	return `The series holds ${holds} and this feed writes ${writes}, so every fetch is refused: two versions spliced into one record would break it. Replace the series, or remove the feed and attach it to a separate series.`;
}

/** The product and version a feed writes, for its summary line (" · CHIRPS sat v3.0"), or ''. */
export const describeWrites = (f: Pick<FeedMeta, 'writes'>) => (f.writes ? ` · ${provenanceLabel(f.writes)}` : '');

/** Where a feed reads, in words. */
export function describePlace(f: Pick<FeedMeta, 'source' | 'config'>): string {
	if (f.source === 'dws') return `station ${f.config.station ?? '?'}`;
	const b = f.config.bbox;
	// At least two decimals (a box is usually drawn on the 0.05° grid); a plain "-", as the cell line writes it.
	const deg = (v: number) => (Math.abs(Math.round(v * 100) - v * 100) < 1e-6 ? v.toFixed(2) : String(v));
	if (b) return `box ${deg(b.south)}, ${deg(b.west)} to ${deg(b.north)}, ${deg(b.east)}${f.config.skipNoData ? ', sea cells left out' : ''}`;
	const cells = f.config.cells ?? [];
	const from = f.config.boundary;
	if (from) return `${cells.length === 1 ? '1 cell' : `${cells.length} cells`} of the catchment boundary${from.name ? ` “${from.name}”` : ''}, area weighted`;
	const unit = f.config.unit;
	if (unit) return `${cells.length === 1 ? '1 cell' : `${cells.length} cells`} of a unit’s parcel (${fmtNum(unit.areaKm2, 2)} km²), area weighted`;
	if (cells.length === 1) return `cell ${cells[0]!.lat}, ${cells[0]!.lon}`;
	return `${cells.length} cells`;
}

/**
 * What a feed's target series means for the model, when it isn't the obvious
 * one (issue #51): CHIRPS written into the catchment rain series *is* the
 * catchment rain, used raw (docs/model.md "Where the CHIRPS and forecast
 * series come from"). Null for every other choice.
 */
export function targetHint(source: FeedSource, kind: string): string | null {
	if (source === 'chirps' && kind === 'rain_catchment_mm')
		return 'CHIRPS becomes the catchment rain itself: used as published, with no bias correction, and the checks against CHIRPS lose their reference. Pick it only for a catchment with no rain gauge.';
	return null;
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
		case 'rebuilding':
			return `Replacing the series: the new record runs ${fmtDay(r.from)} to ${fmtDay(r.through)} so far. The series stays as it is until the backfill completes.`;
		case 'rebuild-stalled':
			return `The replacement stopped growing on ${fmtDay(r.since)} (the new record runs ${fmtDay(r.from)} to ${fmtDay(r.through)}); the series stays as it is. Run it now, or withdraw the replacement.`;
		default:
			return `${STATE_LABELS[h.state] ?? 'Unknown state'}.`;
	}
}

/**
 * The days the last fetch left alone because the series already held a value
 * the feed didn't write (last_meta.kept, issue #30), or null when none.
 */
export function keptNote(meta: FeedMeta['lastMeta']): string | null {
	const n = meta?.kept;
	if (typeof n !== 'number' || !(n > 0)) return null;
	return n === 1 ? '1 day kept your own value' : `${n} days kept your own values`;
}

/**
 * The existing series a new feed would write into, or null. A feed keeps the
 * values already there, uploaded and imported ones included, and fills only
 * empty days (docs/architecture.md § Data feeds), so the series would mix two
 * records: the form asks first, offering a separate series. A series another
 * feed already writes is not asked about: the server refuses a second feed
 * for it with its own message.
 */
export function takeoverOf<S extends Pick<SeriesMeta, 'kind' | 'name' | 'length'>>(
	series: readonly S[],
	feeds: readonly Pick<FeedMeta, 'targetKind' | 'targetName'>[],
	target: Pick<FeedBody, 'targetKind' | 'targetName'>
): S | null {
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

// Whether a CHIRPS feed reads the map's boundary: its own module, so the Map tab's link imports it without this file.
export { boundaryFeedState } from './boundaryState';

/** "Attach a new CHIRPS feed into Rainfall — CHIRPS" and the like: what Apply will do, in words. */
export function applyWords(p: Pick<BoundaryProposal, 'apply'>, feeds: readonly Pick<FeedMeta, 'id' | 'targetKind' | 'targetName'>[]): string {
	const a = p.apply;
	if (a.action === 'none') return 'A CHIRPS feed already reads this boundary: nothing to apply.';
	if (a.action === 'update') {
		const f = feeds.find((x) => x.id === a.feedId);
		return `Apply gives the CHIRPS feed into ${describeTarget(f ?? a)} these cells in place of its own (its series holds no days yet, so nothing is spliced).`;
	}
	const own = a.targetName ? ' A series of its own: the one without a name already holds a record, and a feed never splices two areas into one.' : '';
	return `Apply attaches a new CHIRPS feed into ${describeTarget(a)}.${own} It reads the last 60 days at its first fetch, then keeps up daily.`;
}
