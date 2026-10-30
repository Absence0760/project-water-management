// The Waterbodies pass: DE Africa Waterbodies' wet-area time series for each
// dam matched to a waterbody, into the mirror bucket for the worker to load
// (issue #604 R5; handover.ts for the files, docs/architecture.md § Dam
// observations, docs/data-sources.md for the source). The fetcher Lambda runs
// it hourly (lambda-fetcher.ts `{"mode":"dams-weekly"}`, infra/dam_observations.tf,
// hourly for the WOfS backfill's sake), outside the VPC; each uid is asked
// again once a week (REFRESH_DAYS), and one that failed a day later
// (RETRY_DAYS), never every run.
//
// The source: DE Africa's Waterbodies API (v0.0.3), which they named the
// supported way to the series (Michael Wellington, DE Africa, to the operator,
// 2026-10-30; the v0.0.2 public CSVs on S3 ended 2023-09 and v0.0.3 has none)
// and keep current within about a week. Two requests:
//   uid → wb_id   the API is keyed by an integer wb_id, not the uid (a geohash)
//                 the polygons and our match carry, so the pass asks DE
//                 Africa's GeoServer WFS for it, up to WFS_BATCH uids a
//                 request (wbIdsUrl), once per uid: the id is kept in the
//                 status (perKey.wbId) and asked again only after the API
//                 answers 404 for it (DE Africa note uids and ids may change
//                 between versions). Kept here, not in waterbody_reference:
//                 only the fetcher, which has the internet, ever needs it, and
//                 it needs no migration nor a reload of the polygons.
//   the series    <DEAFRICA_WATERBODIES_API>waterbody/<wb_id>/observations/csv?start_date=…&end_date=<today>
//                 with the header WATERBODIES_HEADER. It sends no ETag nor
//                 Last-Modified, so there is no conditional GET: the weekly
//                 fetch asks only from OVERLAP_DAYS before the newest date
//                 held (late scenes and reprocessed recent ones land inside
//                 it) and merges that into the file; the whole series is
//                 asked again every FULL_REFRESH_DAYS (perKey.fullAt), when the
//                 file held isn't this wb_id's, and on the first fetch. The
//                 merge adds and revises dates but never drops one held, so
//                 an empty or short answer can't erase history (a date DE
//                 Africa withdrew goes at the next whole fetch). A weekly
//                 fetch that changes nothing writes no file (counted
//                 `unchanged`), so the worker loads nothing.
// The series is current, so the recency metric is alarmed like WOfS's
// (infra/dam_observations.tf dam_recency_waterbodies).
//
// A row, as stored (ObservationRow):
//   date         the row's date (its first 10 characters, so a timestamp reads too)
//   wetAreaM2    area_wet_m2: the wet area seen
//   pctObserved  percent_observed − percent_invalid: the share of the waterbody
//                seen clearly. In the API's rows wet + dry + invalid = observed
//                (areas and percents alike), each a share of the historical
//                extent: percent_observed is how much of the waterbody the
//                scene covered at all (under 100 when the scene's edge cuts it),
//                and percent_invalid the part of it under cloud or shadow.
//                So this is percent_wet + percent_dry, and with a whole scene
//                100 − percent_invalid, as v0.0.2's 100 − pc_invalid was.
//                (DE Africa's series holds only dates under 10 % invalid,
//                Datasets/Waterbodies.ipynb, so most rows are 90–100.)
// A row where nothing was seen clearly (a share of 0, or an empty wet area) is
// dropped: it carries no observation, and stored as 0 m² wet it would read as
// an empty dam to anyone who forgot to check the share. A partly seen row is
// kept with its share, and the reader decides the threshold
// (dam_observation.pct_observed). Two rows on one date (overlapping passes)
// keep the one seen most clearly.
//
// Politeness (#604 "The rule"): feeds/http.ts's User-Agent, host allowlist and
// path prefixes, at most one request a second (the WFS lookups included), and
// an HTTP 403 (refused) or 429/503 (throttled, whose Retry-After the client
// honours host-wide) stops the run at once, never retried: the status says
// why, and the invocation fails. The source is then left alone for a day (or
// a longer Retry-After): the next runs ask nothing and publish no heartbeat,
// so the heartbeat alarm is the alert (handover.ts pausedUntil,
// docs/deployment.md § Dam observations). A uid with no v0.0.3 waterbody in
// the WFS (`no_waterbody`), no series (404) or an unreadable answer is
// skipped, recorded, and tried a day later; the others go on.
//
// Locally (FEED_SOURCE=fixtures) fixtureWaterbodiesHttp answers both requests
// from the committed synthetic fixture (backend/fixtures/waterbodies/: the
// polygons' wb_id, and series/<wb_id>.csv), no network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FeedFormatError, FeedRefusedError, FeedThrottledError, FeedUnavailableError } from '../../feeds/errors.js';
import type { ConditionalText, FeedHttp } from '../../feeds/http.js';
import type { MirrorStore } from '../../mirror/store.js';
import {
	isCalendarDate,
	type ObservationFile,
	type PassStatus,
	pausedUntil,
	readObservationFile,
	readStatus,
	readWanted,
	recencyDays,
	stopRetryAfter,
	WATERBODY_UID,
	WOFS_FIRST_DATE,
	writeObservationFile,
	writeStatus
} from './handover.js';
import { DEAFRICA_GEOSERVER_WFS, DEAFRICA_WATERBODIES_API } from './upstream.js';

/** The v0.0.3 polygons' layer on DE Africa's GeoServer. */
export const WATERBODIES_LAYER = 'waterbodies:DEAfrica_Waterbodies_v0_0_3';
/** The series' columns (v0.0.3 API, checked 2026-10-30). */
export const WATERBODIES_HEADER = [
	'date',
	'area_wet_m2',
	'percent_wet',
	'area_dry_m2',
	'percent_dry',
	'area_invalid_m2',
	'percent_invalid',
	'area_observed_m2',
	'percent_observed'
] as const;

/** The most uids one WFS request asks for (a short URL; at most a few dozen matched dams a region). */
export const WFS_BATCH = 50;
/** The WFS request for some uids' wb_id: only those two properties, no geometry. The uids are WATERBODY_UID-checked. */
export function wbIdsUrl(uids: readonly string[]): string {
	if (!uids.length || uids.some((u) => !WATERBODY_UID.test(u))) throw new Error('wbIdsUrl takes checked uids');
	const q = [
		['service', 'WFS'],
		['version', '2.0.0'],
		['request', 'GetFeature'],
		['typeName', WATERBODIES_LAYER],
		['outputFormat', 'application/json'],
		['propertyName', 'uid,wb_id'],
		['cql_filter', `uid IN (${uids.map((u) => `'${u}'`).join(',')})`]
	];
	return `${DEAFRICA_GEOSERVER_WFS}?${q.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&')}`;
}
/** The series of one waterbody from `start` to `end` (ISO dates, inclusive). */
export const seriesUrl = (wbId: number, start: string, end: string) => `${DEAFRICA_WATERBODIES_API}waterbody/${wbId}/observations/csv?start_date=${start}&end_date=${end}`;

/** A uid is asked again once its last good fetch is this many days old (the schedule is hourly, so a week to within the hour). */
export const REFRESH_DAYS = 7;
/** A uid whose last ask failed (or was refused) is asked again only this many days later, whatever the schedule. */
export const RETRY_DAYS = 1;
/** A weekly fetch asks from this many days before the newest date held. */
export const OVERLAP_DAYS = 60;
/** The whole series is asked again this many days after the last whole fetch (a reprocessing upstream shows within a quarter). */
export const FULL_REFRESH_DAYS = 91;
/** The least gap between two requests' starts. */
export const REQUEST_INTERVAL_MS = 1000;

/** The client the pass needs: a text GET (feeds/http.ts liveHttp, or the fixture below), never conditional (no ETag upstream). */
export type WaterbodiesHttp = Required<Pick<FeedHttp, 'textConditional'>>;

const DAY_MS = 86_400_000;
const round2 = (x: number) => Math.round(x * 100) / 100;
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The WFS answer's uid → wb_id. Throws FeedFormatError on anything but a FeatureCollection of those two properties. */
export function parseWbIds(text: string): Map<string, number> {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		throw new FeedFormatError('the Waterbodies WFS answer is not JSON');
	}
	const features = (doc as { features?: unknown } | null)?.features;
	if (!Array.isArray(features)) throw new FeedFormatError('the Waterbodies WFS answer has no features');
	const out = new Map<string, number>();
	for (const f of features) {
		const p = (f as { properties?: { uid?: unknown; wb_id?: unknown } } | null)?.properties;
		const uid = p?.uid;
		const id = p?.wb_id;
		if (typeof uid !== 'string' || !WATERBODY_UID.test(uid) || typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
			throw new FeedFormatError('the Waterbodies WFS answer has a feature without a uid and wb_id');
		}
		if (out.has(uid) && out.get(uid) !== id) throw new FeedFormatError('the Waterbodies WFS answer gives a uid two ids');
		out.set(uid, id);
	}
	return out;
}

/** One series as observation rows (see the header). Throws FeedFormatError on a changed layout or an unreadable value. */
export function parseWaterbodiesCsv(text: string, uid: string): ObservationFile['rows'] {
	const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
	if (!lines.length) throw new FeedFormatError('the Waterbodies series is empty');
	const head = lines[0]!.split(',').map((h) => h.trim());
	if (head.length !== WATERBODIES_HEADER.length || head.some((h, i) => h !== WATERBODIES_HEADER[i])) throw new FeedFormatError('the Waterbodies series columns changed');
	const at = (name: (typeof WATERBODIES_HEADER)[number]) => WATERBODIES_HEADER.indexOf(name);
	const byDate = new Map<string, ObservationFile['rows'][number]>();
	for (const [i, line] of lines.slice(1).entries()) {
		const cells = line.split(',').map((c) => c.trim());
		const bad = (what: string) => new FeedFormatError(`the Waterbodies series has a row (${i + 2}) with ${what}`);
		if (cells.length !== WATERBODIES_HEADER.length) throw bad('the wrong number of columns');
		const date = cells[at('date')]!.slice(0, 10);
		if (!isCalendarDate(date) || date < WOFS_FIRST_DATE) throw bad('no date');
		const share = (name: 'percent_observed' | 'percent_invalid') => {
			const v = Number(cells[at(name)]);
			if (cells[at(name)] === '' || !Number.isFinite(v) || v < 0 || v > 100.0001) throw bad(`no ${name}`);
			return v;
		};
		const pctObserved = round2(Math.max(0, Math.min(100, share('percent_observed') - share('percent_invalid'))));
		// Nothing seen clearly: no observation (the header says why it is dropped).
		if (cells[at('area_wet_m2')] === '' || pctObserved === 0) continue;
		const wet = Number(cells[at('area_wet_m2')]);
		if (!Number.isFinite(wet) || wet < 0 || wet >= 1e12) throw bad('no wet area');
		const row = { date, wetAreaM2: wet, pctObserved, upstreamKey: uid };
		const held = byDate.get(date);
		if (!held || row.pctObserved > held.pctObserved) byDate.set(date, row);
	}
	return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface WaterbodiesPassOptions {
	store: MirrorStore;
	http: WaterbodiesHttp;
	/** Today (UTC), ISO: the series' end_date, and the recency metric's day. */
	today: string;
	/** Epoch ms after which no new request is started. */
	deadline?: number;
	/** 0 in fixtures mode. */
	intervalMs?: number;
	refreshDays?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface WaterbodiesPassResult {
	/** uids whose file was written (new rows or changed ones, or first fetched). */
	fetched: string[];
	/** uids asked whose series held nothing new: the file held is still theirs, and isn't rewritten. */
	unchanged: string[];
	/** uids whose ask failed another way (no waterbody in the WFS, a 404, a changed layout, a timeout): skipped, asked again RETRY_DAYS later. */
	failed: string[];
	/** Listed uids fetched within REFRESH_DAYS, or asked within RETRY_DAYS, so waiting. */
	fresh: number;
	/** 'paused': the last run stopped refused or throttled, and the pause hasn't ended (nothing asked, nothing written). */
	stopped: 'no_list' | 'done' | 'deadline' | 'refused' | 'throttled' | 'paused';
	/** While paused, when the pause ends (ISO). */
	pausedUntil?: string;
	requests: number;
	/** Days from today back to the newest date any listed uid's file holds; null when none holds one. */
	recencyDays: number | null;
	/** What stopped the run (a refusal or throttling), or null. */
	error: unknown;
}

/** A failure's fixed code for the status file and the log: never an upstream body or a URL. */
function errorCode(err: unknown): string {
	if (err instanceof FeedFormatError) return 'format';
	if (err instanceof FeedUnavailableError) return /HTTP \d{3}/.exec(err.message)?.[0] ?? 'unavailable';
	return 'internal';
}

/** Whether two files' rows are the same observations. */
const sameRows = (a: ObservationFile['rows'], b: ObservationFile['rows']) =>
	a.length === b.length && a.every((r, i) => r.date === b[i]!.date && r.wetAreaM2 === b[i]!.wetAreaM2 && r.pctObserved === b[i]!.pctObserved && r.upstreamKey === b[i]!.upstreamKey);

/** One pass (see the header). Throws only for the mirror itself; the upstream's failures are reported. */
export async function runWaterbodiesPass(opts: WaterbodiesPassOptions): Promise<WaterbodiesPassResult> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const interval = opts.intervalMs ?? REQUEST_INTERVAL_MS;
	const refreshMs = (opts.refreshDays ?? REFRESH_DAYS) * DAY_MS;
	const retryMs = RETRY_DAYS * DAY_MS;
	const { store, today } = opts;
	let requests = 0;
	let last = -Infinity;
	const paced = async (url: string): Promise<ConditionalText | null> => {
		const left = last + interval - now();
		if (left > 0) await sleep(left);
		last = now();
		requests++;
		return opts.http.textConditional(url, null);
	};

	const previous = await readStatus(store, 'waterbodies');
	// Paused after a refusal or throttling: ask nothing, and leave the status (and so the pause) as it stands.
	const until = pausedUntil(previous);
	if (until !== null && now() < until) {
		return { fetched: [], unchanged: [], failed: [], fresh: 0, stopped: 'paused', pausedUntil: new Date(until).toISOString(), requests: 0, recencyDays: recencyDays(previous!, today), error: null };
	}
	const wanted = await readWanted(store);
	const perKey: PassStatus['perKey'] = {};
	// Only the listed uids are kept: a dam no longer matched drops out of the status too.
	for (const uid of wanted?.waterbodies ?? []) if (previous?.perKey[uid]) perKey[uid] = previous.perKey[uid]!;
	const done = (r: Omit<WaterbodiesPassResult, 'requests' | 'recencyDays'>): WaterbodiesPassResult => ({ ...r, requests, recencyDays: recencyDays({ perKey }, today) });
	if (!wanted) return done({ fetched: [], unchanged: [], failed: [], fresh: 0, stopped: 'no_list', error: null });

	const lastGood = (uid: string) => (perKey[uid]?.lastGood ? Date.parse(perKey[uid]!.lastGood!) : -Infinity);
	const lastTried = (uid: string) => (perKey[uid]?.triedAt ? Date.parse(perKey[uid]!.triedAt!) : -Infinity);
	// Due a week after its last good fetch, or at once while it has no wb_id (never fetched from the API: a uid
	// fetched from the v0.0.2 CSVs before has none), and never within a day of its last ask (a failing uid isn't asked every hour).
	const due = wanted.waterbodies
		.filter((u) => WATERBODY_UID.test(u) && (perKey[u]?.wbId === undefined || lastGood(u) <= now() - refreshMs) && lastTried(u) <= now() - retryMs)
		.sort((a, b) => lastGood(a) - lastGood(b) || (a < b ? -1 : 1));

	const fetched: string[] = [];
	const unchanged: string[] = [];
	const failed: string[] = [];
	let stopped: WaterbodiesPassResult['stopped'] = 'done';
	let error: unknown = null;
	const pastDeadline = () => opts.deadline !== undefined && now() >= opts.deadline;
	/** An upstream failure for `uids`: true when it stops the run (a refusal or throttling); rethrows what isn't the upstream's. */
	const fail = (err: unknown, uids: readonly string[], triedAt: string): boolean => {
		if (err instanceof FeedRefusedError || err instanceof FeedThrottledError) {
			stopped = err instanceof FeedRefusedError ? 'refused' : 'throttled';
			error = err;
			for (const uid of uids) perKey[uid] = { ...perKey[uid], error: stopped, triedAt };
			return true;
		}
		// The upstream's answer; anything else (the mirror write failing) is ours: stop and fail.
		if (!(err instanceof FeedFormatError || err instanceof FeedUnavailableError)) throw err;
		for (const uid of uids) {
			perKey[uid] = { ...perKey[uid], error: errorCode(err), triedAt };
			failed.push(uid);
		}
		return false;
	};
	const saveStatus = async () => {
		const stale = stopped === 'refused' || stopped === 'throttled';
		const retryAfterSeconds = stale ? stopRetryAfter(error) : undefined;
		await writeStatus(store, {
			source: 'waterbodies',
			ranAt: new Date(now()).toISOString(),
			stopped: stale,
			...(stale ? { reason: stopped } : {}),
			...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
			perKey
		});
	};
	try {
		// 1. The wb_id of each due uid that has none, WFS_BATCH a request.
		const unknown = due.filter((u) => perKey[u]?.wbId === undefined);
		for (let i = 0; i < unknown.length && stopped === 'done'; i += WFS_BATCH) {
			if (pastDeadline()) {
				stopped = 'deadline';
				break;
			}
			const batch = unknown.slice(i, i + WFS_BATCH);
			const triedAt = new Date(now()).toISOString();
			try {
				const got = await paced(wbIdsUrl(batch));
				if (got === null) throw new FeedUnavailableError('HTTP 404');
				if (got.status !== 'ok') throw new FeedUnavailableError('HTTP 304');
				const ids = parseWbIds(got.text);
				for (const uid of batch) {
					const id = ids.get(uid);
					if (id !== undefined) perKey[uid] = { ...perKey[uid], wbId: id };
					else {
						// Not a v0.0.3 waterbody (the polygons loaded are another version's, or DE Africa dropped it).
						// Its newest date (an older source's) leaves the status, as after a 404 below.
						const { newest: _stale, ...rest } = perKey[uid] ?? {};
						perKey[uid] = { ...rest, error: 'no_waterbody', triedAt };
						failed.push(uid);
					}
				}
			} catch (err) {
				if (fail(err, batch, triedAt)) break;
			}
		}
		// 2. Each due uid's series, from the API.
		for (const uid of due) {
			if (stopped !== 'done') break;
			const prev = perKey[uid];
			if (prev?.wbId === undefined || failed.includes(uid)) continue;
			if (pastDeadline()) {
				stopped = 'deadline';
				break;
			}
			const wbId = prev.wbId;
			const triedAt = new Date(now()).toISOString();
			// The file held, to add the recent part to; one that no longer reads, or is another source's (v0.0.2's
			// CSV, another wb_id), is fetched whole, as is every one once a quarter.
			const held = await readObservationFile(store, 'waterbodies', uid).catch(() => null);
			const ownFile = !!held?.rows.length && !!held.upstream[0]?.url.startsWith(`${DEAFRICA_WATERBODIES_API}waterbody/${wbId}/observations/csv?`);
			const wholeDue = !prev.fullAt || Date.parse(prev.fullAt) <= now() - FULL_REFRESH_DAYS * DAY_MS;
			const incremental = ownFile && !wholeDue;
			const start = incremental ? [WOFS_FIRST_DATE, addDays(held!.rows.at(-1)!.date, -OVERLAP_DAYS)].sort().at(-1)! : WOFS_FIRST_DATE;
			const url = seriesUrl(wbId, start, today);
			try {
				const got = await paced(url);
				if (got === null) {
					// No such waterbody: its id may have changed, so it is looked up again next time. Its newest date
					// leaves the status until a fetch succeeds, so the recency counts only uids being kept up.
					const { wbId: _gone, newest: _stale, ...rest } = prev;
					perKey[uid] = rest;
					throw new FeedUnavailableError('HTTP 404');
				}
				if (got.status !== 'ok') throw new FeedUnavailableError('HTTP 304');
				const parsed = parseWaterbodiesCsv(got.text, uid);
				let rows = parsed;
				if (incremental) {
					// New and revised dates over the held ones; none dropped (the header says why).
					const merged = new Map(held!.rows.map((r) => [r.date, r]));
					for (const r of parsed) merged.set(r.date, r);
					rows = [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
				}
				const newest = rows.length ? { newest: rows.at(-1)!.date } : {};
				if (incremental && sameRows(rows, held!.rows)) {
					perKey[uid] = { wbId, lastGood: triedAt, triedAt, ...newest, ...(prev.fullAt ? { fullAt: prev.fullAt } : {}) };
					unchanged.push(uid);
					continue;
				}
				await writeObservationFile(store, {
					source: 'waterbodies',
					key: uid,
					fetchedAt: triedAt,
					upstream: [{ url, ...(got.etag ? { etag: got.etag } : {}), ...(got.lastModified ? { lastModified: got.lastModified } : {}) }],
					rows
				});
				perKey[uid] = { wbId, lastGood: triedAt, triedAt, ...newest, fullAt: incremental ? prev.fullAt! : triedAt };
				fetched.push(uid);
			} catch (err) {
				if (fail(err, [uid], triedAt)) break;
			}
		}
	} catch (err) {
		// The mirror itself failed: keep what this run fetched before it (best effort), then fail.
		await saveStatus().catch(() => {});
		throw err;
	}
	await saveStatus();
	return done({ fetched, unchanged, failed, fresh: wanted.waterbodies.length - due.length, stopped, error });
}

// --- FEED_SOURCE=fixtures -----------------------------------------------------------------

/** The committed synthetic fixture (scripts/waterbodies-fixture.ts writes it): the polygons, with their wb_id, and series/<wb_id>.csv. */
export const WATERBODIES_FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/waterbodies/', import.meta.url));
export const WATERBODIES_FIXTURE_POLYGONS = 'waterbodies.synthetic.geojson';

/**
 * The WFS lookup and the series answered from the synthetic fixture: the WFS for the fixture polygons' uids (an
 * unknown uid is left out, as GeoServer does), the series filtered to start_date … end_date (a wb_id with no file
 * is a 404, as the API's "Waterbody not found"). A request the real services would refuse is an HTTP 400; any
 * other URL a 404. No network, and no ETag (the API sends none).
 */
export function fixtureWaterbodiesHttp(root = WATERBODIES_FIXTURE_ROOT): WaterbodiesHttp {
	let ids: Map<string, number> | null = null;
	const fixtureIds = () => {
		if (ids) return ids;
		const doc = JSON.parse(readFileSync(`${root}${WATERBODIES_FIXTURE_POLYGONS}`, 'utf8')) as { features: { properties: { uid: string; wb_id?: number } }[] };
		ids = new Map(doc.features.filter((f) => f.properties.wb_id !== undefined).map((f) => [f.properties.uid, f.properties.wb_id!]));
		return ids;
	};
	const ok = (text: string): ConditionalText => ({ status: 'ok', text, etag: null, lastModified: null });
	return {
		async textConditional(raw) {
			const url = URL.parse(raw);
			if (!url) return null;
			const q = url.searchParams;
			if (`${url.origin}${url.pathname}` === DEAFRICA_GEOSERVER_WFS) {
				const filter = /^uid IN \(('[0-9a-z]{6,12}'(?:,'[0-9a-z]{6,12}')*)\)$/.exec(q.get('cql_filter') ?? '');
				if (q.get('request') !== 'GetFeature' || q.get('typeName') !== WATERBODIES_LAYER || q.get('outputFormat') !== 'application/json' || !filter) {
					throw new FeedUnavailableError('HTTP 400');
				}
				const asked = filter[1]!.split(',').map((u) => u.slice(1, -1));
				const features = asked.filter((u) => fixtureIds().has(u)).map((u) => ({ type: 'Feature', geometry: null, properties: { uid: u, wb_id: fixtureIds().get(u) } }));
				return ok(JSON.stringify({ type: 'FeatureCollection', features, numberReturned: features.length }));
			}
			if (!raw.startsWith(DEAFRICA_WATERBODIES_API)) return null;
			const m = /^waterbody\/([1-9]\d{0,15})\/observations\/csv$/.exec(url.pathname.slice(new URL(DEAFRICA_WATERBODIES_API).pathname.length));
			if (!m) return null;
			const [from, to] = [q.get('start_date') ?? '', q.get('end_date') ?? ''];
			if (!isCalendarDate(from) || !isCalendarDate(to)) throw new FeedUnavailableError('HTTP 422');
			let text: string;
			try {
				text = readFileSync(`${root}series/${m[1]}.csv`, 'utf8');
			} catch {
				return null;
			}
			const [head, ...rows] = text.split('\n').filter((l) => l !== '');
			return ok(`${[head, ...rows.filter((l) => l.slice(0, 10) >= from && l.slice(0, 10) <= to)].join('\n')}\n`);
		}
	};
}

/** The pass's client for FEED_SOURCE (the live one only on the fetcher Lambda: feeds/http.ts). */
export async function waterbodiesHttp(mode: 'fixtures' | 'live'): Promise<WaterbodiesHttp> {
	if (mode === 'fixtures') return fixtureWaterbodiesHttp();
	const { feedHttp } = await import('../../feeds/http.js');
	const live = await feedHttp('live');
	if (!live.textConditional) throw new Error('the live feed client has no conditional GET');
	return { textConditional: live.textConditional };
}
