// The indices pass: NOAA CPC's ONI and AAO into the data mirror (issue #620
// step 3; docs/data-sources.md § climate-indices, docs/deployment.md § The
// data mirror). The fetcher Lambda runs it once a day on its own EventBridge
// rule (lambda-fetcher.ts, `{"mode":"daily-ingest","pass":"indices"}`,
// infra/feeds.tf, off until `climate_indices_enabled`). The worker reads what
// it writes when an outlook asks for the climate-state analogues
// (outlooks/store.ts, engine outlook/climate.ts).
//
// What a run does:
//   1. Fetches CPC's two files whole (sources/cpc.ts), one request each,
//      paced REQUEST_INTERVAL_MS apart: two requests a day to a host whose
//      files change about once a month.
//   2. Parses each strictly (a changed page refuses the whole file).
//   3. Writes `indices/<id>.json` (the engine's MonthlyIndexSeries) only when
//      its values changed (the SHA-256 of the canonical JSON), and records it
//      in `indices/manifest.json`: the URL, the hash, the months held, the
//      revision (moves only on a change), when it was fetched and changed.
//      The manifest is written last, so a reader that follows it never meets
//      a file it doesn't describe as written.
// A file that fails (an HTTP 403 above all, a throttle, a changed format) is
// reported and the other still copied; a 403 or throttle ends the run at
// once, with no retry, as in the other passes. The run reports the error
// rather than throwing, so the caller can still publish the lag metric
// (MirrorLagDays{Product=indices}: today minus the end of the older of the
// two newest months held) and log the outcome before it fails the invocation.
//
// FEED_SOURCE=fixtures (dev, CI, e2e) answers both URLs from invented values
// (feeds/fixtures.ts), never the network; the committed synthetic copy
// (backend/fixtures/mirror/indices/) is this pass's output on that copy's day
// (scripts/gen-mirror-fixture.ts).
import { createHash } from 'node:crypto';
import type { ClimateIndexId, MonthlyIndexSeries } from '@water-management/engine';
import { toEpochDay } from '@water-management/engine/calendar';
import type { AbsolutePath } from '@zarrita/storage';
import { z } from 'zod';
import { FeedFormatError, FeedRefusedError, FeedThrottledError } from '../feeds/errors.js';
import type { FeedHttp } from '../feeds/http.js';
import { AAO_URL, CPC_FILE_MAX_BYTES, ONI_URL, parseAao, parseOni } from '../feeds/sources/cpc.js';
import { MirrorManifestError } from '../mirror/manifest.js';
import type { MirrorStore } from '../mirror/store.js';
import { MIRROR_LAG_METRIC, MIRROR_METRIC_NAMESPACE, pacedHttp, REQUEST_INTERVAL_MS } from './daily.js';

/**
 * The engine's CLIMATE_INDEX_IDS, written out: a value import of the engine's
 * index would pull the whole model into the fetcher's bundle (indices.test.ts
 * checks the two agree).
 */
export const INDEX_IDS: readonly ClimateIndexId[] = ['oni', 'aao'];

export const INDICES_MANIFEST_KEY = '/indices/manifest.json' as AbsolutePath;
export const indexKey = (id: ClimateIndexId) => `/indices/${id}.json` as AbsolutePath;

const SOURCES: Record<ClimateIndexId, { url: string; parse: (text: string) => MonthlyIndexSeries }> = {
	oni: { url: ONI_URL, parse: parseOni },
	aao: { url: AAO_URL, parse: parseAao }
};

const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const IndexEntry = z
	.object({
		url: z.string().url(),
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
		firstMonth: YearMonth,
		through: YearMonth,
		revision: z.number().int().min(1),
		fetchedAt: z.string().datetime(),
		changedAt: z.string().datetime()
	})
	.strict();
export type IndexEntry = z.output<typeof IndexEntry>;

/** `indices/manifest.json`: what the copy holds of each index. */
export const IndicesManifest = z
	.object({
		v: z.literal(1),
		indices: z.object({ oni: IndexEntry.optional(), aao: IndexEntry.optional() }).strict()
	})
	.strict();
export type IndicesManifest = z.output<typeof IndicesManifest>;

/** A stored index file: the engine's series. */
const IndexFile = z
	.object({
		id: z.enum(['oni', 'aao']),
		firstMonth: YearMonth,
		values: z.array(z.number().finite().nullable()).min(1).max(12 * 300)
	})
	.strict();

const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const encodeJson = (v: unknown) => new TextEncoder().encode(`${JSON.stringify(v)}\n`);
const monthIndex = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthText = (i: number) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;

/** The SHA-256 of a series' canonical JSON (its id, first month and values): what decides a revision. */
export function indexHash(s: MonthlyIndexSeries): string {
	return createHash('sha256').update(JSON.stringify({ id: s.id, firstMonth: s.firstMonth, values: s.values })).digest('hex');
}

/** The copy's indices manifest, or null when it holds none. */
export async function readIndicesManifest(store: MirrorStore): Promise<IndicesManifest | null> {
	const bytes = await store.get(INDICES_MANIFEST_KEY);
	if (bytes === undefined) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(decode(bytes));
	} catch {
		throw new MirrorManifestError('the data copy’s indices/manifest.json is not valid JSON');
	}
	const r = IndicesManifest.safeParse(raw);
	if (!r.success) throw new MirrorManifestError(`the data copy’s indices/manifest.json is invalid: ${r.error.issues[0]!.message}`);
	return r.data;
}

/** What the outlook reads: each index the manifest lists, checked against its hash, and the manifest's entries (the provenance). */
export interface HeldIndices {
	series: MonthlyIndexSeries[];
	entries: Partial<Record<ClimateIndexId, IndexEntry>>;
}

/**
 * The indices the copy holds (the manifest's, each file checked against its
 * entry's hash, so a file and a manifest from two runs never mix). An index
 * the manifest doesn't list is left out; the engine then says it isn't held.
 */
export async function readClimateIndices(store: MirrorStore): Promise<HeldIndices> {
	const m = await readIndicesManifest(store);
	const out: HeldIndices = { series: [], entries: {} };
	if (!m) return out;
	for (const id of INDEX_IDS) {
		const entry = m.indices[id];
		if (!entry) continue;
		const bytes = await store.get(indexKey(id));
		if (bytes === undefined) throw new MirrorManifestError(`the data copy’s manifest lists indices/${id}.json, which it doesn’t hold`);
		let raw: unknown;
		try {
			raw = JSON.parse(decode(bytes));
		} catch {
			throw new MirrorManifestError(`the data copy’s indices/${id}.json is not valid JSON`);
		}
		const f = IndexFile.safeParse(raw);
		if (!f.success || f.data.id !== id) throw new MirrorManifestError(`the data copy’s indices/${id}.json is invalid`);
		if (indexHash(f.data) !== entry.sha256) throw new MirrorManifestError(`the data copy’s indices/${id}.json doesn’t match its manifest`);
		out.series.push(f.data);
		out.entries[id] = entry;
	}
	return out;
}

export interface IndicesIngestOptions {
	store: MirrorStore;
	http: FeedHttp;
	/** Today (UTC), ISO. */
	today: string;
	/** The time of the run, ISO (the manifest's fetchedAt). */
	nowIso?: string;
	/** Minimum gap between two requests' starts; 0 in fixtures mode. */
	intervalMs?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface IndicesIngestResult {
	/** Indices whose values changed this run (a new revision written). */
	changed: ClimateIndexId[];
	/** Indices fetched with nothing new. */
	unchanged: ClimateIndexId[];
	/** The newest month each index holds after the run ("YYYY-MM"), or null. */
	through: Partial<Record<ClimateIndexId, string>>;
	/** Today minus the last day of the older of the two newest months; null unless both are held. */
	lagDays: number | null;
	stopped: 'done' | 'error';
	requests: number;
	/** The first failure (a 403 included), or null. */
	error: unknown;
}

/** The last day (epoch) of month index i. */
const lastDayOf = (i: number) => toEpochDay(`${monthText(i + 1)}-01`) - 1;

/** One run of the indices pass (the header). Never throws on an upstream failure: it is in `error`. */
export async function runIndicesIngest(opts: IndicesIngestOptions): Promise<IndicesIngestResult> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const { http, counter } = pacedHttp(opts.http, opts.intervalMs ?? REQUEST_INTERVAL_MS, now, sleep);
	const at = opts.nowIso ?? new Date(now()).toISOString();
	const manifest: IndicesManifest = (await readIndicesManifest(opts.store)) ?? { v: 1, indices: {} };
	const changed: ClimateIndexId[] = [];
	const unchanged: ClimateIndexId[] = [];
	let error: unknown = null;
	for (const id of INDEX_IDS) {
		const src = SOURCES[id];
		let series: MonthlyIndexSeries;
		try {
			const text = await http.text(src.url);
			if (text === null) throw new FeedFormatError(`CPC has no ${id.toUpperCase()} file at its address (HTTP 404)`);
			if (text.length > CPC_FILE_MAX_BYTES) throw new FeedFormatError(`the ${id.toUpperCase()} file is over ${CPC_FILE_MAX_BYTES} bytes`);
			series = src.parse(text);
		} catch (err) {
			error ??= err;
			// Refused or throttled: ask the host nothing more this run.
			if (err instanceof FeedRefusedError || err instanceof FeedThrottledError) break;
			continue;
		}
		const sha256 = indexHash(series);
		const prev = manifest.indices[id];
		const through = monthText(monthIndex(series.firstMonth) + series.values.length - 1);
		if (prev && prev.sha256 === sha256) {
			manifest.indices[id] = { ...prev, fetchedAt: at };
			unchanged.push(id);
			continue;
		}
		// A shorter series than the one held is a changed or truncated file: refuse it and keep the copy's.
		if (prev && monthIndex(through) < monthIndex(prev.through)) {
			error ??= new FeedFormatError(`the ${id.toUpperCase()} file now ends at ${through}, before the ${prev.through} the copy holds`);
			continue;
		}
		await opts.store.set(indexKey(id), encodeJson(series));
		manifest.indices[id] = { url: src.url, sha256, firstMonth: series.firstMonth, through, revision: (prev?.revision ?? 0) + 1, fetchedAt: at, changedAt: at };
		changed.push(id);
	}
	if (changed.length || unchanged.length) await opts.store.set(INDICES_MANIFEST_KEY, encodeJson(manifest));
	const through: IndicesIngestResult['through'] = {};
	for (const id of INDEX_IDS) if (manifest.indices[id]) through[id] = manifest.indices[id]!.through;
	const t = toEpochDay(opts.today);
	const lagDays = through.oni && through.aao ? t - lastDayOf(Math.min(monthIndex(through.oni), monthIndex(through.aao))) : null;
	return { changed, unchanged, through, lagDays, stopped: error === null ? 'done' : 'error', requests: counter.requests, error };
}

/** The pass's freshness as a CloudWatch Embedded Metric Format line: MirrorLagDays, Product=indices (daily.ts lagMetricLine). */
export function indicesLagMetricLine(lagDays: number, now = Date.now()): string {
	return JSON.stringify({
		_aws: {
			Timestamp: now,
			CloudWatchMetrics: [{ Namespace: MIRROR_METRIC_NAMESPACE, Dimensions: [['Product']], Metrics: [{ Name: MIRROR_LAG_METRIC, Unit: 'None' }] }]
		},
		Product: 'indices',
		[MIRROR_LAG_METRIC]: lagDays
	});
}
