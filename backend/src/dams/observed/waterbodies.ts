// The Waterbodies pass: DE Africa Waterbodies' wet-area time series for each
// dam matched to a waterbody, into the mirror bucket for the worker to load
// (issue #604 R5; handover.ts for the files, docs/architecture.md § Dam
// observations, docs/data-sources.md for the source). The fetcher Lambda runs
// it daily (lambda-fetcher.ts `{"mode":"dams-weekly"}`, infra/dam_observations.tf),
// outside the VPC; each uid is asked again once a week (REFRESH_DAYS).
//
// The series: one public CSV per waterbody,
//   <DEAFRICA_SERVICES_BASE>waterbodies/v0.0.2/surface_area_change/<uid[0..4]>/<uid>.csv
// with the header WATERBODIES_HEADER. Checked 2026-10-27: the objects were
// last written 2024-02-26 and a sampled series ends 2023-09-17, so the public
// CSVs look frozen, though the product says it updates weekly. The pass reads
// them anyway (a conditional GET costs one small request a week), and WOfS
// over the dam's own outline is the current source (R5-C). There is therefore
// no recency alarm for this source, only the heartbeat (infra/dam_observations.tf).
//
// A row, as stored (ObservationRow):
//   date         the row's date (its first 10 characters, so a timestamp reads too)
//   wetAreaM2    area_wet_m2: the wet area seen
//   pctObserved  100 − pc_invalid: the share of the waterbody seen clearly
// A row where nothing was seen clearly (pc_invalid 100, or pc_wet empty, as
// the CSV leaves it on a fully invalid date) is dropped: it carries no
// observation, and stored as 0 m² wet it would read as an empty dam to anyone
// who forgot to check the share. A partly seen row is kept with its share,
// and the reader decides the threshold (dam_observation.pct_observed). Two
// rows on one date (overlapping passes) keep the one seen most clearly.
//
// Politeness (#604 "The rule"): feeds/http.ts's User-Agent, at most one
// request a second, a conditional GET on the ETag the last fetch kept (a
// frozen file costs a 304), and an HTTP 403 (refused) or 429/503 (throttled,
// whose Retry-After the client honours host-wide) stops the run at once,
// never retried: the status says why, and the invocation fails. A uid whose
// file is missing (404) or unreadable is skipped, recorded, and tried next
// time; the others go on.
//
// Locally (FEED_SOURCE=fixtures) fixtureWaterbodiesHttp answers from the
// committed synthetic series (backend/fixtures/waterbodies/series/), no network.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FeedFormatError, FeedRefusedError, FeedThrottledError, FeedUnavailableError } from '../../feeds/errors.js';
import type { ConditionalText, FeedHttp } from '../../feeds/http.js';
import type { MirrorStore } from '../../mirror/store.js';
import { type ObservationFile, type PassStatus, readObservationFile, readStatus, readWanted, recencyDays, WATERBODY_UID, writeObservationFile, writeStatus } from './handover.js';
import { DEAFRICA_SERVICES_BASE } from './upstream.js';

/** Where the per-waterbody series live (v0.0.2: the newest version with public time series, 2026-10-27). */
export const WATERBODIES_SERIES_BASE = `${DEAFRICA_SERVICES_BASE}waterbodies/v0.0.2/surface_area_change/`;
export const waterbodiesUrl = (uid: string) => `${WATERBODIES_SERIES_BASE}${uid.slice(0, 4)}/${uid}.csv`;
export const WATERBODIES_HEADER = ['date', 'px_total', 'px_wet', 'area_wet_m2', 'px_dry', 'area_dry_m2', 'px_invalid', 'area_invalid_m2', 'pc_wet', 'pc_dry', 'pc_invalid'] as const;

/** A uid is asked again once its last good fetch is this many days old (the schedule is daily: a day's slack on a week). */
export const REFRESH_DAYS = 6;
/** The least gap between two requests' starts. */
export const REQUEST_INTERVAL_MS = 1000;

/** The client the pass needs: a conditional text GET (feeds/http.ts liveHttp, or the fixture below). */
export type WaterbodiesHttp = Required<Pick<FeedHttp, 'textConditional'>>;

/** One CSV as observation rows (see the header). Throws FeedFormatError on a changed layout or an unreadable value. */
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
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw bad('no date');
		const invalid = Number(cells[at('pc_invalid')]);
		if (cells[at('pc_invalid')] === '' || !Number.isFinite(invalid) || invalid < 0 || invalid > 100.0001) throw bad('no share invalid');
		const pctObserved = Math.max(0, Math.min(100, 100 - invalid));
		// Nothing seen clearly: no observation (the header says why it is dropped).
		if (cells[at('pc_wet')] === '' || pctObserved === 0) continue;
		const wet = Number(cells[at('area_wet_m2')]);
		if (cells[at('area_wet_m2')] === '' || !Number.isFinite(wet) || wet < 0 || wet >= 1e12) throw bad('no wet area');
		const row = { date, wetAreaM2: wet, pctObserved, upstreamKey: uid };
		const held = byDate.get(date);
		if (!held || row.pctObserved > held.pctObserved) byDate.set(date, row);
	}
	return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

export interface WaterbodiesPassOptions {
	store: MirrorStore;
	http: WaterbodiesHttp;
	/** Today (UTC), ISO: for the recency metric. */
	today: string;
	/** Epoch ms after which no new uid is started. */
	deadline?: number;
	/** 0 in fixtures mode. */
	intervalMs?: number;
	refreshDays?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

export interface WaterbodiesPassResult {
	/** uids whose file was written (changed upstream, or first fetched). */
	fetched: string[];
	/** uids the upstream answered 304 for: the file held is still theirs. */
	unchanged: string[];
	/** uids whose request failed another way (404, a changed layout, a timeout): skipped, tried next run. */
	failed: string[];
	/** Listed uids fetched recently enough to wait. */
	fresh: number;
	stopped: 'no_list' | 'done' | 'deadline' | 'refused' | 'throttled';
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

/** One pass (see the header). Throws only for the mirror itself; the upstream's failures are reported. */
export async function runWaterbodiesPass(opts: WaterbodiesPassOptions): Promise<WaterbodiesPassResult> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const interval = opts.intervalMs ?? REQUEST_INTERVAL_MS;
	const refreshMs = (opts.refreshDays ?? REFRESH_DAYS) * 86_400_000;
	const { store, today } = opts;
	let requests = 0;
	let last = -Infinity;
	const paced = async (url: string, etag: string | null): Promise<ConditionalText | null> => {
		const left = last + interval - now();
		if (left > 0) await sleep(left);
		last = now();
		requests++;
		return opts.http.textConditional(url, etag);
	};

	const wanted = await readWanted(store);
	const previous = await readStatus(store, 'waterbodies');
	const perKey: PassStatus['perKey'] = {};
	// Only the listed uids are kept: a dam no longer matched drops out of the status too.
	for (const uid of wanted?.waterbodies ?? []) if (previous?.perKey[uid]) perKey[uid] = previous.perKey[uid]!;
	const done = (r: Omit<WaterbodiesPassResult, 'requests' | 'recencyDays'>): WaterbodiesPassResult => ({ ...r, requests, recencyDays: recencyDays({ perKey }, today) });
	if (!wanted) return done({ fetched: [], unchanged: [], failed: [], fresh: 0, stopped: 'no_list', error: null });

	const lastGood = (uid: string) => (perKey[uid]?.lastGood ? Date.parse(perKey[uid]!.lastGood!) : -Infinity);
	const due = wanted.waterbodies.filter((u) => WATERBODY_UID.test(u) && lastGood(u) <= now() - refreshMs).sort((a, b) => lastGood(a) - lastGood(b) || (a < b ? -1 : 1));

	const fetched: string[] = [];
	const unchanged: string[] = [];
	const failed: string[] = [];
	let stopped: WaterbodiesPassResult['stopped'] = 'done';
	let error: unknown = null;
	for (const uid of due) {
		if (opts.deadline !== undefined && now() >= opts.deadline) {
			stopped = 'deadline';
			break;
		}
		const triedAt = new Date(now()).toISOString();
		// The file held, for its ETag; one that no longer reads is fetched whole.
		const held = await readObservationFile(store, 'waterbodies', uid).catch(() => null);
		const url = waterbodiesUrl(uid);
		try {
			const got = await paced(url, held?.upstream[0]?.etag ?? null);
			if (got === null) throw new FeedUnavailableError('HTTP 404');
			if (got.status === 'not-modified') {
				perKey[uid] = { ...perKey[uid], lastGood: triedAt, ...(held?.rows.length ? { newest: held.rows.at(-1)!.date } : {}) };
				delete perKey[uid]!.error;
				unchanged.push(uid);
				continue;
			}
			const rows = parseWaterbodiesCsv(got.text, uid);
			const file: ObservationFile = {
				source: 'waterbodies',
				key: uid,
				fetchedAt: triedAt,
				upstream: [{ url, ...(got.etag ? { etag: got.etag } : {}), ...(got.lastModified ? { lastModified: got.lastModified } : {}) }],
				rows
			};
			await writeObservationFile(store, file);
			perKey[uid] = { lastGood: triedAt, ...(rows.length ? { newest: rows.at(-1)!.date } : {}) };
			fetched.push(uid);
		} catch (err) {
			if (err instanceof FeedRefusedError || err instanceof FeedThrottledError) {
				stopped = err instanceof FeedRefusedError ? 'refused' : 'throttled';
				error = err;
				perKey[uid] = { ...perKey[uid], error: stopped };
				break;
			}
			// The upstream's answer for this uid; anything else (the mirror write failing) is ours: stop and fail.
			if (!(err instanceof FeedFormatError || err instanceof FeedUnavailableError)) throw err;
			perKey[uid] = { ...perKey[uid], error: errorCode(err) };
			failed.push(uid);
		}
	}

	const stale = stopped === 'refused' || stopped === 'throttled';
	await writeStatus(store, { source: 'waterbodies', ranAt: new Date(now()).toISOString(), stopped: stale, ...(stale ? { reason: stopped } : {}), perKey });
	return done({ fetched, unchanged, failed, fresh: wanted.waterbodies.length - due.length, stopped, error });
}

// --- FEED_SOURCE=fixtures -----------------------------------------------------------------

/** The committed synthetic series, one <uid>.csv each (scripts/waterbodies-fixture.ts writes them). */
export const WATERBODIES_FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/waterbodies/series/', import.meta.url));

/** The Waterbodies URLs answered from the synthetic series, with an ETag of their bytes; every other URL is a 404. No network. */
export function fixtureWaterbodiesHttp(dir = WATERBODIES_FIXTURE_DIR): WaterbodiesHttp {
	return {
		async textConditional(url, etag) {
			if (!url.startsWith(WATERBODIES_SERIES_BASE)) return null;
			const m = /^([0-9a-z]{4})\/([0-9a-z]{6,12})\.csv$/.exec(url.slice(WATERBODIES_SERIES_BASE.length));
			if (!m || m[2]!.slice(0, 4) !== m[1]) return null;
			let bytes: Buffer;
			try {
				bytes = readFileSync(`${dir}${m[2]}.csv`);
			} catch {
				return null;
			}
			const tag = `"fx-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}"`;
			if (etag === tag) return { status: 'not-modified' };
			return { status: 'ok', text: bytes.toString('utf8'), etag: tag, lastModified: 'Mon, 26 Feb 2024 00:00:00 GMT' };
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
