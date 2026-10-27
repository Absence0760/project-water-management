// The worker tick's look at our CHIRPS copy (issue #604 R2-D, design D9;
// docs/data-model.md § Mirror revisions). Not a job: runTick (jobs/runner.ts)
// calls it once per tick, with no user, before it queues the due feeds.
//
// Only with CHIRPS_SOURCE=mirror (mirror/source.ts). For each product (rnl,
// sat, prelim) it reads the manifest from the copy (mirrorStore) and, when it
// changed, records how far the product runs in mirror_copy (246,
// app_mirror_record_copy): the API's data feeds panel reads that, since only
// the worker reaches the copy. For the finals products (rnl, sat), when its
// revision is newer than the one the cache was brought up to
// (app_mirror_revision) it applies it (app_mirror_apply_revision, 245/246):
// every cached final of the changed days is marked stale, and each CHIRPS
// feed over those cells reads them again on its next fetch, and refreshes its
// series from what changed (210's re-check, feeds/ingest.ts
// refreshRevisedDays), with a History event.
//
// What it passes the apply (nextBatch): with no revision stored yet (the first
// manifest this cache sees, at the cutover) no entries at all, as the
// function's baseline marks every cached final in the region instead; after
// that only the entries newer than the stored revision, since `changes` only
// grows and the function takes at most 1000. A backlog of more goes in
// batches at revision boundaries, each recorded as its own revision.
//
// Cheap when nothing moved: one manifest request per product per tick at
// most, and none of the work when the manifest's ETag (S3) or size and
// modification time (a file:// copy) is the one already handled by this
// process. A large revision is applied in parts, one transaction each, as
// many as fit the tick's time; the rest next tick (the function resumes
// after the parts already marked). A failure is logged and left to the next
// tick: the rest of the tick goes on.
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AbsolutePath } from '@zarrita/storage';
import { withoutUser } from '../../db/tx.js';
import { cacheOrigin, type CacheOrigin } from '../../feeds/cellCacheStore.js';
import {
	applyMirrorRevision,
	MIRROR_MAX_CHANGES,
	type MirrorChange,
	type MirrorManifest,
	mirrorRevision,
	recordMirrorCopy
} from '../../feeds/mirrorRevision.js';
import { logEvent } from '../../logging/logEvent.js';
import { safeError } from '../../logging/safeError.js';
import { parseManifest } from '../../mirror/manifest.js';
import { chirpsSource, mirrorStore, mirrorUrl } from '../../mirror/source.js';
import { type S3Sender, S3Store } from '../../mirror/store.js';

/** The finals products whose revisions reach the cache (the preliminary values replace themselves). */
export const MIRROR_FINALS = ['rnl', 'sat'] as const;
export type MirrorFinalsProduct = (typeof MIRROR_FINALS)[number];
/** Every product whose manifest is recorded in mirror_copy. */
export const MIRROR_PRODUCTS = [...MIRROR_FINALS, 'prelim'] as const;
export type MirrorTickProduct = (typeof MIRROR_PRODUCTS)[number];

export type MirrorProductStatus =
	/** The manifest is the one this process already handled. */
	| 'unchanged'
	/** Not in the copy yet. */
	| 'missing'
	/** Recorded in mirror_copy; the cache is at (or past) the manifest's revision (prelim: recorded only). */
	| 'current'
	/** The revision is recorded. */
	| 'applied'
	/** Some parts marked, the rest next tick. */
	| 'partial'
	/** A fetch held a day the apply needed, or another tick was applying (55P03, 40P01): next tick. */
	| 'busy'
	/** Anything else, logged: next tick. */
	| 'failed';

export interface MirrorProductResult {
	status: MirrorProductStatus;
	/** The manifest's revision, when it was read. */
	revision?: number;
	/** Cell-days marked stale this tick. */
	marked?: number;
	/** Apply calls (parts) made this tick. */
	parts?: number;
}

export type MirrorTickResult = Record<MirrorTickProduct, MirrorProductResult>;

export interface MirrorTickOptions {
	/** Stop starting parts once this much time has passed (default 60 s). */
	budgetMs?: number;
	/** Most parts per product per tick (default 10: 40,000 days, a whole product). */
	maxParts?: number;
	/** The S3 client the conditional GET goes through (tests). */
	s3?: S3Sender;
	env?: Record<string, string | undefined>;
}

/** Per process: the manifest tag (ETag, or size and mtime) of each origin and product whose revision is fully handled. */
const handled = new Map<string, string>();
/** Forget what this process handled (tests). */
export function resetMirrorTick(): void {
	handled.clear();
}

let s3Client: Promise<S3Sender> | null = null;
const defaultS3 = () => (s3Client ??= import('@aws-sdk/client-s3').then((sdk) => new sdk.S3Client({}) as S3Sender));

/**
 * `product`'s manifest bytes and a tag for them, or 'unchanged' when the tag
 * is `known`, or null when the copy has no manifest. One request at most: a
 * stat and a read of one open file (file://), or a GET with If-None-Match (s3://).
 */
export async function fetchManifest(
	product: MirrorTickProduct,
	known: string | undefined,
	{ s3, env }: { s3?: S3Sender; env?: Record<string, string | undefined> } = {}
): Promise<{ tag: string; bytes: Uint8Array } | 'unchanged' | null> {
	const url = mirrorUrl(env);
	if (url.startsWith('file://')) {
		const path = join(fileURLToPath(url), product, 'manifest.json');
		// One open file: its stat and its bytes are the same file, even if the manifest is replaced meanwhile.
		let fh;
		try {
			fh = await open(path, 'r');
		} catch (err) {
			if ((err as { code?: string }).code === 'ENOENT') return null;
			throw err;
		}
		try {
			const st = await fh.stat();
			const tag = `${st.size}:${st.mtimeMs}`;
			if (tag === known) return 'unchanged';
			return { tag, bytes: new Uint8Array(await fh.readFile()) };
		} finally {
			await fh.close();
		}
	}
	const store = mirrorStore(env);
	if (!(store instanceof S3Store)) throw new Error('the copy is neither file:// nor s3://');
	const sdk = await import('@aws-sdk/client-s3');
	try {
		const r = (await (s3 ?? (await defaultS3())).send(
			new sdk.GetObjectCommand({ Bucket: store.bucket, Key: store.key(`/${product}/manifest.json` as AbsolutePath), ...(known ? { IfNoneMatch: known } : {}) })
		)) as { ETag?: string; Body?: { transformToByteArray(): Promise<Uint8Array> } };
		const bytes = r.Body ? new Uint8Array(await r.Body.transformToByteArray()) : new Uint8Array(0);
		// No ETag (never from S3): the bytes themselves are the tag, so an unchanged manifest still skips the database.
		return { tag: r.ETag ?? `len:${bytes.length}`, bytes };
	} catch (err) {
		const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
		if (e.$metadata?.httpStatusCode === 304 || e.name === 'NotModified') return 'unchanged';
		if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
		throw err;
	}
}

const BUSY = new Set(['55P03', '40P01']);

/**
 * The next call of the apply for `manifest` when the cache is at `stored`: the
 * revision to bring it to and the manifest to pass (its `changes` cut to that
 * call's entries, at most MIRROR_MAX_CHANGES; what mirror_manifest keeps).
 * - No revision stored: no entries (the function's baseline marks every
 *   cached final in the region, whatever the entries say).
 * - Else the entries newer than `stored` (the manifest keeps them in revision
 *   order, parseManifest), all of them when they fit, to the manifest's
 *   revision. When they don't, the first ones up to the last revision they
 *   hold whole, recorded as that revision; the next call goes on from it.
 * - A single revision of more entries than fit (never seen; CHC's largest
 *   rewrite is about 45 entries) is passed as one entry per year it touches,
 *   from its first to its last changed day that year, over the whole region:
 *   more marked than changed, but never stuck.
 */
export function nextBatch(manifest: MirrorManifest, stored: number | null): MirrorManifest {
	if (stored === null) return { ...manifest, changes: [] };
	const newer = manifest.changes.filter((c) => c.revision > stored);
	if (newer.length <= MIRROR_MAX_CHANGES) return { ...manifest, changes: newer };
	const r = newer[MIRROR_MAX_CHANGES - 1]!.revision;
	if (newer[MIRROR_MAX_CHANGES]!.revision !== r) return { ...manifest, revision: r, changes: newer.slice(0, MIRROR_MAX_CHANGES) };
	const firstOfR = newer.findIndex((c) => c.revision === r);
	if (firstOfR > 0) return { ...manifest, revision: newer[firstOfR - 1]!.revision, changes: newer.slice(0, firstOfR) };
	// One revision of more entries than a call takes: cover it year by year.
	const years = new Map<string, MirrorChange>();
	for (const c of newer) {
		if (c.revision !== r || c.cellsChanged === 0) continue;
		const [from, to] = c.days;
		for (const y of new Set([from.slice(0, 4), to.slice(0, 4)])) {
			const lo = from.slice(0, 4) === y ? from : `${y}-01-01`;
			const hi = to.slice(0, 4) === y ? to : `${y}-12-31`;
			const had = years.get(y);
			years.set(y, {
				revision: r,
				days: [had && had.days[0] < lo ? had.days[0] : lo, had && had.days[1] > hi ? had.days[1] : hi],
				cellsChanged: Math.max(had?.cellsChanged ?? 0, c.cellsChanged),
				maxAbsDiff: Math.max(had?.maxAbsDiff ?? 0, c.maxAbsDiff)
			});
		}
	}
	return { ...manifest, revision: r, changes: [...years.keys()].sort().map((y) => years.get(y)!) };
}

async function tickProduct(origin: CacheOrigin, product: MirrorTickProduct, started: number, o: MirrorTickOptions): Promise<MirrorProductResult> {
	const key = `${origin}/${product}`;
	const got = await fetchManifest(product, handled.get(key), { s3: o.s3, env: o.env });
	if (got === 'unchanged') return { status: 'unchanged' };
	if (got === null) return { status: 'missing' };
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(got.bytes));
	} catch {
		raw = undefined;
	}
	// Checked here as the readers check it (a bad manifest is refused with a message naming the field), then by the function.
	const parsed = parseManifest(raw, product);
	// Recorded first, whatever happens to the revision: a new month moves finalThrough without one. Without
	// `changes`, which only grows and isn't read there.
	const { changes: _changes, ...summary } = parsed;
	await withoutUser((db) => recordMirrorCopy(db, origin, product, summary));
	if (product === 'prelim') {
		handled.set(key, got.tag);
		return { status: 'current', revision: parsed.revision };
	}
	const manifest = parsed as MirrorManifest;
	let stored = await withoutUser((db) => mirrorRevision(db, origin, product));
	if (stored !== null && manifest.revision <= stored) {
		handled.set(key, got.tag);
		return { status: 'current', revision: manifest.revision };
	}
	const budgetMs = o.budgetMs ?? 60_000;
	const maxParts = o.maxParts ?? 10;
	let marked = 0;
	let parts = 0;
	let applied = false;
	for (;;) {
		const batch = nextBatch(manifest, stored);
		const r = await withoutUser((db) => applyMirrorRevision(db, origin, product, batch));
		parts++;
		marked += r.marked;
		applied ||= r.applied;
		if (r.remaining === 0) {
			if (r.revision !== null && r.revision >= manifest.revision) {
				handled.set(key, got.tag);
				if (applied) logEvent('info', { event: 'mirror_revision_applied', origin, product, revision: manifest.revision, marked, parts });
				return { status: applied ? 'applied' : 'current', revision: manifest.revision, marked, parts };
			}
			// A batch of a backlog recorded (its own revision): the next batch goes on from it.
			stored = r.revision;
		}
		if (parts >= maxParts || Date.now() - started >= budgetMs) {
			logEvent('info', { event: 'mirror_revision_partial', origin, product, revision: manifest.revision, marked, parts, remaining: r.remaining });
			return { status: 'partial', revision: manifest.revision, marked, parts };
		}
	}
}

/**
 * Bring the cache up to the copy's revisions, one product after the other.
 * Null when this process doesn't read the copy (CHIRPS_SOURCE=chc): then
 * nothing is read and nothing applied. Never throws: a product that fails is
 * logged (`mirror_revision_failed`, or `mirror_revision_busy` when a fetch or
 * another tick held what it needed) and tried again next tick.
 */
export async function runMirrorTick(o: MirrorTickOptions = {}): Promise<MirrorTickResult | null> {
	const env = o.env ?? process.env;
	let source;
	try {
		source = chirpsSource(env);
	} catch (err) {
		logEvent('error', { event: 'mirror_revision_failed', ...safeError(err) });
		return null;
	}
	if (source !== 'mirror') return null;
	const origin = cacheOrigin();
	const started = Date.now();
	const result = {} as MirrorTickResult;
	for (const product of MIRROR_PRODUCTS) {
		try {
			result[product] = await tickProduct(origin, product, started, { ...o, env });
		} catch (err) {
			const code = (err as { code?: unknown }).code;
			if (typeof code === 'string' && BUSY.has(code)) {
				logEvent('info', { event: 'mirror_revision_busy', origin, product, code });
				result[product] = { status: 'busy' };
			} else {
				logEvent('error', { event: 'mirror_revision_failed', origin, product, ...safeError(err) });
				result[product] = { status: 'failed' };
			}
		}
	}
	return result;
}
