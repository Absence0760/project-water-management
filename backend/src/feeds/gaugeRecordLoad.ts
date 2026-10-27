// The worker's side of the weekly DWS pass (issue #604 R3-B;
// 247_gauge_record.sql, ingest/dws.ts for the handover through the mirror
// bucket). Not a job: runTick (jobs/runner.ts) calls runDwsTick once per
// tick, with no user, beside the mirror tick.
//
// Only with DWS_WEEKLY=on in a live process (FEED_SOURCE=live; Terraform sets
// it from dws_weekly_enabled, infra/jobs.tf), so the worker writes nothing to
// a bucket the weekly pass doesn't read, and never to the committed synthetic
// copy. Each tick:
//   1. Publishes the station list: the river gauges enabled DWS feeds name
//      (app_dws_feed_stations), written to dws/stations.json only when it
//      differs from what is there (one GET when this process hasn't seen it).
//   2. Loads what the pass fetched: reads dws/status.json and, for each
//      station whose last good fetch this process hasn't loaded, its
//      dws/<station>.json into gauge_record (app_gauge_record_load_web,
//      source dws-web, origin dws). The function skips a file no newer than
//      what the store holds, so a restarted worker reloading every station
//      writes nothing twice.
// A failure is logged and left to the next tick; the rest of the tick goes on.
import { withoutUser, type Db } from '../db/tx.js';
import { readStationFile, readStations, readStatus, type StationFile, writeStations } from '../ingest/dws.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import { mirrorStore } from '../mirror/source.js';
import type { MirrorStore } from '../mirror/store.js';

type Env = Record<string, string | undefined>;

/** Whether this process hands stations to the weekly pass and loads what it fetched. */
export function dwsWeeklyOn(env: Env = process.env): boolean {
	const v = env.DWS_WEEKLY?.trim() ?? '';
	if (v !== '' && v !== 'on' && v !== 'off') throw new Error(`unknown DWS_WEEKLY "${v}" (expected on or off)`);
	return v === 'on' && env.FEED_SOURCE?.trim() === 'live';
}

/** Load one station's web pass, as the worker (no user): rows written, or false when the store already held it. */
export async function loadWebFile(db: Db, origin: 'dws' | 'fixtures', f: Pick<StationFile, 'station' | 'from' | 'to' | 'fetchedAt' | 'rows'>): Promise<number | false> {
	const { rows } = await db.query<{ written: number; applied: boolean }>(
		'SELECT written, applied FROM app_gauge_record_load_web($1, $2, $3, $4, $5::date[], $6::double precision[], $7::text[], $8)',
		[origin, f.station, f.from, f.to, f.rows.map((r) => r[0]), f.rows.map((r) => r[1]), f.rows.map((r) => r[2]), f.fetchedAt]
	);
	return rows[0]!.applied ? rows[0]!.written : false;
}

export interface DwsTickResult {
	/** Stations enabled DWS feeds name. */
	stations: number;
	/** The list was written this tick. */
	published: boolean;
	/** Station files loaded into the store this tick. */
	loaded: number;
	/** Station files the store already held. */
	unchanged: number;
	/** Station files that could not be read or loaded (logged; tried next tick). */
	failed: number;
}

/** Per process: the list last seen in the bucket, and each station's last good fetch already loaded. */
let published: string | null = null;
const loaded = new Map<string, string>();
/** Forget what this process saw (tests). */
export function resetDwsTick(): void {
	published = null;
	loaded.clear();
}

/** One tick's handover (see the header); null when it is off. Never throws. */
export async function runDwsTick(o: { store?: MirrorStore; env?: Env; now?: () => number } = {}): Promise<DwsTickResult | null> {
	const env = o.env ?? process.env;
	let on: boolean;
	try {
		on = dwsWeeklyOn(env);
	} catch (err) {
		logEvent('error', { event: 'dws_tick_failed', step: 'config', ...safeError(err) });
		return null;
	}
	if (!on) return null;
	const now = o.now ?? Date.now;
	const result: DwsTickResult = { stations: 0, published: false, loaded: 0, unchanged: 0, failed: 0 };
	let store: MirrorStore;
	try {
		store = o.store ?? mirrorStore(env);
	} catch (err) {
		logEvent('error', { event: 'dws_tick_failed', step: 'store', ...safeError(err) });
		return result;
	}

	// 1. The station list.
	try {
		const stations = await withoutUser(async (db) => (await db.query<{ s: string }>('SELECT s FROM app_dws_feed_stations() AS s')).rows.map((r) => r.s));
		result.stations = stations.length;
		const key = stations.join(',');
		if (published !== key) {
			const there = await readStations(store).catch(() => null);
			if (there?.stations.join(',') !== key) {
				await writeStations(store, { v: 1, at: new Date(now()).toISOString(), stations });
				result.published = true;
			}
			published = key;
		}
	} catch (err) {
		logEvent('error', { event: 'dws_tick_failed', step: 'stations', ...safeError(err) });
	}

	// 2. What the pass fetched.
	try {
		const status = await readStatus(store);
		for (const [station, s] of Object.entries(status?.stations ?? {})) {
			if (!s.okAt || loaded.get(station) === s.okAt) continue;
			try {
				const file = await readStationFile(store, station);
				// The pass writes the file before the status names its fetch, so a listed fetch has its file; a missing one is retried next tick.
				if (!file || file.station !== station) {
					result.failed++;
					continue;
				}
				const written = await withoutUser((db) => loadWebFile(db, 'dws', file));
				if (written === false) result.unchanged++;
				else result.loaded++;
				loaded.set(station, s.okAt);
			} catch (err) {
				result.failed++;
				// No station code in the log, as the fetcher's lines (lambda-fetcher.ts): the code ties a project to a place.
				logEvent('error', { event: 'dws_load_failed', ...safeError(err) });
			}
		}
	} catch (err) {
		logEvent('error', { event: 'dws_tick_failed', step: 'status', ...safeError(err) });
	}
	if (result.published || result.loaded || result.failed) logEvent(result.failed ? 'warn' : 'info', { event: 'dws_tick', ...result });
	return result;
}
