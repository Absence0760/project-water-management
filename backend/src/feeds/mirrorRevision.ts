// A revision of our CHIRPS copy reaching the cell cache without a feed
// (245_mirror_revision.sql, issue #604 D9): the worker's tick reads a
// product's manifest and, when its revision is newer than the one the cache
// was brought up to, applies it. The function marks every cached final of
// the changed days in the region stale; the feeds' re-check then reads them
// again from the copy and logs what changed in chirps_revision (210), as for
// a file CHC rewrote. Worker side only, in a transaction with no user
// (db/tx.ts withoutUser): the functions refuse any other caller.
import type { Db } from '../db/tx.js';
import type { CacheOrigin } from './cellCacheStore.js';
import type { ChirpsDailyProduct } from './config.js';

/** A region in degrees, edges on the 0.05° grid. */
export interface MirrorRegion {
	w: number;
	s: number;
	e: number;
	n: number;
}

/**
 * One entry of a manifest's `changes`: the days a revision of the copy
 * changed. `region` (optional, not in the manifest spec) narrows the cells to
 * mark, inside the manifest's region; without it the whole region's cached
 * cells are marked for those days.
 */
export interface MirrorChange {
	revision: number;
	days: [string, string];
	cellsChanged: number;
	maxAbsDiff: number;
	region?: MirrorRegion;
}

/** The parts of a product's manifest.json the apply reads; the rest is stored as it is. */
export interface MirrorManifest {
	product: string;
	revision: number;
	region: MirrorRegion;
	grid: { origin: { lat: number; lon: number }; step: number };
	changes: MirrorChange[];
	[key: string]: unknown;
}

export interface MirrorApplyResult {
	/** The revision the cache is now brought up to. */
	revision: number;
	/** False when the manifest's revision was not newer than the stored one: nothing changed. */
	applied: boolean;
	/** Cell-days newly marked stale. */
	marked: number;
}

/** The revision of the copy `origin` / `product`'s cache was last brought up to (null: none yet). */
export async function mirrorRevision(db: Db, origin: CacheOrigin, product: ChirpsDailyProduct): Promise<number | null> {
	const { rows } = await db.query<{ revision: number | null }>('SELECT app_mirror_revision($1, $2) AS revision', [origin, product]);
	return rows[0]?.revision ?? null;
}

/**
 * Bring `origin` / `product`'s cache up to `manifest`'s revision
 * (app_mirror_apply_revision): every manifest change newer than the stored
 * revision marks the cached finals of its days stale. Re-applying the same
 * (or an older) revision changes nothing. Throws what the function raises
 * (23514 for a manifest or change out of bounds, 42501 from a session with a
 * user).
 */
export async function applyMirrorRevision(db: Db, origin: CacheOrigin, product: ChirpsDailyProduct, manifest: MirrorManifest): Promise<MirrorApplyResult> {
	const { rows } = await db.query<MirrorApplyResult>('SELECT revision, applied, marked FROM app_mirror_apply_revision($1, $2, $3, $4, $5)', [
		origin,
		product,
		manifest.revision,
		JSON.stringify(manifest.changes ?? []),
		JSON.stringify(manifest)
	]);
	return rows[0]!;
}
