// A revision of our CHIRPS copy reaching the cell cache without a feed
// (245_mirror_revision.sql, in parts since 246_mirror_revision_parts.sql;
// issue #604 D9): the worker's tick (jobs/handlers/mirror-tick.ts) reads a
// product's manifest and, when its revision is newer than the one the cache
// was brought up to, applies it, one part (up to MIRROR_PART_DAYS days) per
// transaction. The function marks every cached final of the changed days in
// the region stale; the feeds' re-check then reads them again from the copy
// and logs what changed in chirps_revision (210), as for a file CHC rewrote.
// Worker side only, in a transaction with no user (db/tx.ts withoutUser): the
// functions refuse any other caller.
import type { Db } from '../db/tx.js';
import type { CacheOrigin } from './cellCacheStore.js';
import type { CacheProduct } from './cellCache.js';

/** A region in degrees, edges on the product's grid (0.05° or 0.1°). */
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

/** The most days one call of the apply marks (246): a larger revision is applied in parts, a transaction each. */
export const MIRROR_PART_DAYS = 4000;
/**
 * The most estimated cell-days one call of the apply marks (246): days times
 * the cell-year rows the cache holds that year in the region. An entry that
 * doesn't fit is split by days; a part takes at least one day.
 */
export const MIRROR_PART_CELL_DAYS = 1_000_000;
/** The most `changes` entries one call of the apply takes (246): the tick passes only the unapplied ones, in batches. */
export const MIRROR_MAX_CHANGES = 1000;

export interface MirrorApplyResult {
	/** The revision the cache is now brought up to (null: none yet, a first revision still in parts). */
	revision: number | null;
	/** True when this call recorded the manifest's revision (its last part). */
	applied: boolean;
	/** Cell-days marked stale by this call (a mark already there counts, its time refreshed). */
	marked: number;
	/** Entries of the revision not wholly marked yet: call again, in a new transaction. 0 when it is recorded, or was not newer. */
	remaining: number;
}

/** The revision of the copy `origin` / `product`'s cache was last brought up to (null: none yet). */
export async function mirrorRevision(db: Db, origin: CacheOrigin, product: CacheProduct): Promise<number | null> {
	const { rows } = await db.query<{ revision: number | null }>('SELECT app_mirror_revision($1, $2) AS revision', [origin, product]);
	return rows[0]?.revision ?? null;
}

/**
 * One part of bringing `origin` / `product`'s cache up to `manifest`'s
 * revision (app_mirror_apply_revision): the next days of the manifest's
 * changes newer than the stored revision, up to MIRROR_PART_DAYS days and
 * MIRROR_PART_CELL_DAYS estimated cell-days, have the cached finals of their
 * days marked stale (with no revision stored yet, the baseline: every cached
 * final in the region, year by year); the revision is recorded with the last
 * part (`remaining` 0, `applied`). `manifest.changes` is passed as it is, at
 * most MIRROR_MAX_CHANGES entries: the tick passes only the unapplied ones
 * (mirror-tick.ts nextBatch). Each part commits on its own, so the caller
 * calls again in a new transaction while `remaining` > 0, and a part lost to
 * a crash is picked up by the next call. Re-applying the same (or an older)
 * revision changes nothing. Throws what the function raises (23514 for a
 * manifest or change out of bounds, 42501 from a session with a user, 55P03
 * when a fetch holds a day it needs: try again later).
 */
export async function applyMirrorRevision(db: Db, origin: CacheOrigin, product: CacheProduct, manifest: MirrorManifest): Promise<MirrorApplyResult> {
	const { rows } = await db.query<MirrorApplyResult>('SELECT revision, applied, marked, remaining FROM app_mirror_apply_revision($1, $2, $3, $4, $5)', [
		origin,
		product,
		manifest.revision,
		JSON.stringify(manifest.changes ?? []),
		JSON.stringify(manifest)
	]);
	return rows[0]!;
}

/** A product of our copy, as `mirror_copy` holds it (246). */
export type MirrorCopyProduct = CacheProduct | 'prelim';

/**
 * Record how far `product` of the copy runs (its manifest's revision,
 * finalThrough and prelimThrough) in mirror_copy (app_mirror_record_copy,
 * worker only), for the API, which can't reach the copy. Called by the tick
 * whenever a manifest changed.
 */
export async function recordMirrorCopy(db: Db, origin: CacheOrigin, product: MirrorCopyProduct, manifest: { product: string; revision: number }): Promise<void> {
	await db.query('SELECT app_mirror_record_copy($1, $2, $3)', [origin, product, JSON.stringify(manifest)]);
}

export interface MirrorCopyRow {
	revision: number;
	finalThrough: string | null;
	prelimThrough: string | null;
	/** When the worker's tick last read a changed manifest (ISO). */
	seenAt: string;
}

/**
 * How far each product of the copy runs, as the worker's tick last recorded
 * it (mirror_copy): any signed-in session reads it (the API's data feeds
 * panel). A product the tick hasn't seen is absent.
 */
export async function mirrorCopy(db: Db, origin: CacheOrigin): Promise<Partial<Record<MirrorCopyProduct, MirrorCopyRow>>> {
	const { rows } = await db.query<MirrorCopyRow & { product: MirrorCopyProduct }>(
		`SELECT product, revision, to_char(final_through, 'YYYY-MM-DD') AS "finalThrough", to_char(prelim_through, 'YYYY-MM-DD') AS "prelimThrough",
			to_char(seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "seenAt"
		 FROM mirror_copy WHERE origin = $1`,
		[origin]
	);
	return Object.fromEntries(rows.map(({ product, ...r }) => [product, r]));
}
