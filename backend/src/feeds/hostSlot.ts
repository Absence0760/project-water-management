// CHC's one request slot, shared across our Lambdas (issue #604).
//
// CHC asked (2026-10-27) for one file at a time and about 1 request a second
// **in total across all our Lambdas**; their bot protection blocks an address
// for hours above about 2 a second. Two of our processes ask CHC: this
// backend's fetcher Lambda (per-feed CHIRPS / CHIRPS-GEFS fetches, the daily
// preliminary pass and the GEFS pass) and the Python mirror-ingest Lambda
// (ingest/, the rnl and sat runs and the backfill). Each paces itself to about
// a request a second, and the fetch-requests FIFO queue's `chc` message group
// keeps the fetcher to one fetch at a time (infra/feeds.tf), but nothing kept
// the two Lambdas apart: while both ran, CHC saw about 2 a second.
//
// So before either asks CHC anything it takes this slot: one lease object,
// `ingest-state/hosts/chc/lease.json` in the mirror bucket, by S3 conditional
// writes, exactly as the ingest's own product leases (ingest/lease.py
// hold_host, which takes the same object):
//
//   - created with If-None-Match: * , holding an owner token, the holder's
//     name and an expiry (epoch seconds);
//   - an expired one (a run that died holding it) taken over with If-Match on
//     its ETag, so two takers can't both win;
//   - released at the end by its owner (read, compare the owner, delete).
//
// The expiry is the holder's own hard deadline (the Lambda's time left) plus
// HOST_SLOT_MARGIN_MS, so no renewal is needed (a Lambda can't run past its
// deadline) and a run killed by its timeout frees the slot a minute later.
//
// Held by someone else, taking it doesn't wait (`busy`): the per-feed fetch
// answers HOST_BUSY_ANSWER and the worker queues the feed's fetch again in
// HOST_BUSY_RETRY_SECONDS (jobs/handlers/feed-ingest.ts), so no feed fails,
// no SQS receive is spent and no Lambda time is burnt waiting. The scheduled
// passes, which have no retry but tomorrow's, wait for it instead, reserving
// the next turn while they wait (takeHostSlotWaiting). The Python side raises
// HostBusy.
//
// A backfill execution holds the slot for its whole run (ingest/lease.py
// hold_host_for_backfill, issue #618 step 4): every month of it takes the slot
// as one owner, keeps it through the pause between months, and the state
// machine's last step releases it (infra/ingest_backfill.tf). Nothing here
// changes for that: the fetcher sees the slot held by
// `ingest:backfill:<execution name>` and defers, every 2 minutes, until it ends.
//
// The reservation (`ingest-state/hosts/chc/reserved.json`, hostReservationKey):
// a waiter that finds the slot held reserves the next turn, so it isn't
// outrun by a per-feed crawl's back-to-back fetches. Two kinds of waiter
// write one: a backfill month or an operator's check (ingest/lease.py
// _reserve), and the fetcher's scheduled passes (takeHostSlotWaiting,
// HostSlots.reserve). The same body as the slot's (owner, expiry in epoch
// seconds, holder), live for HOST_RESERVATION_MS and renewed by each look;
// created with If-None-Match, replaced only when it is the writer's own or
// expired (If-Match on its ETag), so a waiter never overwrites another's live
// reservation: it just waits behind it. Its writer withdraws it (only its
// own) once it holds the slot or gives up. A taker here that gets a free slot
// while someone else's live reservation exists lets it go again at once and
// answers busy (`reserved: true`); a reservation with the taker's own owner
// token doesn't count. It is advisory, so one that can't be read or written
// (a missing grant, an S3 error) is ignored and logged: the slot itself is
// what keeps CHC to one process.
//
// Locally the same file under a `file://` MIRROR_URL, written whole by a hard link (the
// Python side's local lease). With no MIRROR_URL, or the committed synthetic
// copy, there is no slot and every caller goes on as before.
import { link, readFile, rename, rm, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { type MirrorLocation, parseMirrorUrl } from '../mirror/url.js';
import { logEvent } from '../logging/logEvent.js';
import { safeError } from '../logging/safeError.js';
import type { FeedSource } from './config.js';

/** The hosts with a shared slot: CHC only (DWS asked for nothing across processes, and only the fetcher asks it). */
export type SlotHost = 'chc';

/** The slot a per-feed fetch of `source` takes: CHIRPS and CHIRPS-GEFS are CHC's (the same host feed-fetch.ts fetchGroup groups them by). */
export const slotHostFor = (source: FeedSource): SlotHost | null => (source === 'chirps' || source === 'chirps_gefs' ? 'chc' : null);

/** The slot's key in the mirror (under its prefix). The Python side's lease.host_slot_key names the same one. */
export const hostSlotKey = (host: SlotHost): string => `ingest-state/hosts/${host}/lease.json`;
/** The next turn at the slot, reserved by a waiter: a backfill month, an operator's check (ingest/lease.py host_reservation_key) or a scheduled pass here. */
export const hostReservationKey = (host: SlotHost): string => `ingest-state/hosts/${host}/reserved.json`;

/** How long past its holder's deadline a slot lasts (ingest/lease.py HOST_SLOT_MARGIN_S). */
export const HOST_SLOT_MARGIN_MS = 60_000;
/** A holder with no deadline (a local run, a test) is given Lambda's longest run (ingest/lease.py HOST_SLOT_DEFAULT_S). */
export const HOST_SLOT_DEFAULT_MS = 15 * 60_000;
/** How long a reservation lasts past its last renewal (ingest/lease.py RESERVATION_S); a waiting pass renews it at every look (HOST_SLOT_POLL_MS). */
export const HOST_RESERVATION_MS = 5 * 60_000;

/**
 * The fetcher's answer to a per-feed fetch it didn't start because the slot
 * was held: not a failure. The worker queues the feed's fetch again
 * (feed-ingest.ts), and its health is untouched.
 */
export const HostBusyAnswer = z.object({ ok: z.literal(false), deferred: z.literal('host_busy') }).strict();
export type HostBusyAnswer = z.output<typeof HostBusyAnswer>;
export const HOST_BUSY_ANSWER: HostBusyAnswer = { ok: false, deferred: 'host_busy' };
/**
 * How long a deferred feed fetch waits before it is queued again. A daily
 * rnl/sat run holds the slot minutes; a backfill execution holds it for its
 * whole run (hours), and its fetches keep deferring at this pace until the
 * release, then resume within one interval.
 */
export const HOST_BUSY_RETRY_SECONDS = 120;

/** A slot this process holds. */
export interface HeldSlot {
	readonly owner: string;
	/** Let it go (only if it is still ours). Never throws: a slot left behind expires on its own. */
	release(): Promise<void>;
}

/**
 * The outcome of a take: held, or busy with who holds it (the holder's name,
 * e.g. `ingest:rnl:monthly`, `ingest:backfill:<execution name>`) and until
 * when; `reserved` when the slot was free but another waiter (a backfill
 * month, a scheduled pass) had reserved the turn (then holder and until are
 * the reservation's).
 */
export type SlotTake = { held: HeldSlot } | { busy: { holder: string | null; until: string | null; reserved?: true } };

/** The subset of S3Client the slot sends through (an injected client in tests). */
export interface SlotS3 {
	send(command: unknown): Promise<unknown>;
}

interface SlotBody {
	owner?: unknown;
	expires?: unknown;
	holder?: unknown;
}

/** The shared slots in the copy MIRROR_URL names. */
export interface HostSlots {
	/**
	 * Take the slot. `owner` (default: a fresh token) is the token the slot is
	 * written with; a reservation with the same owner is the taker's own and
	 * is not yielded to.
	 */
	take(host: SlotHost, o: { holder: string; remainingMs: number | null; owner?: string }): Promise<SlotTake>;
	/**
	 * Reserve the next turn for `owner`, or renew its own reservation, for
	 * HOST_RESERVATION_MS. False, writing nothing, when someone else's live
	 * reservation stands: it is never overwritten.
	 */
	reserve(host: SlotHost, o: { owner: string; holder: string }): Promise<boolean>;
	/** Withdraw `owner`'s reservation, only ever its own. */
	withdraw(host: SlotHost, owner: string): Promise<void>;
}

const body = (owner: string, holder: string, nowMs: number, remainingMs: number | null) =>
	`${JSON.stringify({ owner, expires: (nowMs + (remainingMs === null ? HOST_SLOT_DEFAULT_MS : Math.max(0, remainingMs)) + HOST_SLOT_MARGIN_MS) / 1000, holder })}\n`;
/** A reservation's body: the slot's fields, live for HOST_RESERVATION_MS (ingest/lease.py _reserve). */
const reservationBody = (owner: string, holder: string, nowMs: number) => `${JSON.stringify({ owner, expires: (nowMs + HOST_RESERVATION_MS) / 1000, holder: holder.slice(0, 80) })}\n`;

function parseBody(text: string): SlotBody {
	try {
		const v = JSON.parse(text) as unknown;
		return typeof v === 'object' && v !== null ? (v as SlotBody) : {};
	} catch {
		// A torn or foreign body is no holder: treated as expired.
		return {};
	}
}

const expiresAt = (b: SlotBody): number => (typeof b.expires === 'number' && Number.isFinite(b.expires) ? b.expires * 1000 : 0);
const busyOf = (b: SlotBody) => ({
	holder: typeof b.holder === 'string' ? b.holder.slice(0, 80) : null,
	until: expiresAt(b) > 0 ? new Date(expiresAt(b)).toISOString() : null
});

/**
 * Once a slot is taken: someone else's live reservation (a backfill month or
 * a scheduled pass waiting for this turn) means letting it go again and
 * answering busy; the taker's own (the same owner token) doesn't. Read
 * failures are ignored and logged: the reservation is advisory (module header).
 */
async function yieldToReservation(host: SlotHost, readReservation: () => Promise<SlotBody | null>, held: HeldSlot, now: number): Promise<SlotTake> {
	let r: SlotBody | null;
	try {
		r = await readReservation();
	} catch (err) {
		logEvent('warn', { event: 'host_slot_reservation_unreadable', host, ...safeError(err) });
		return { held };
	}
	if (!r || expiresAt(r) <= now || r.owner === held.owner) return { held };
	await held.release();
	return { busy: { ...busyOf(r), reserved: true } };
}

/** S3's answers to a conditional write that lost: 412 Precondition Failed, or 409 when two land at once. */
function isConflict(err: unknown): boolean {
	const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
	return e?.name === 'PreconditionFailed' || e?.name === 'ConditionalRequestConflict' || e?.$metadata?.httpStatusCode === 412 || e?.$metadata?.httpStatusCode === 409;
}
function isMissing(err: unknown): boolean {
	const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
	return e?.name === 'NoSuchKey' || e?.name === 'NotFound' || e?.$metadata?.httpStatusCode === 404;
}

class S3Slots implements HostSlots {
	#client: Promise<{ s3: SlotS3; sdk: typeof import('@aws-sdk/client-s3') }>;

	constructor(
		readonly bucket: string,
		readonly prefix: string,
		client: SlotS3 | undefined,
		readonly now: () => number
	) {
		this.#client = import('@aws-sdk/client-s3').then((sdk) => ({ s3: client ?? new sdk.S3Client({}), sdk }));
	}

	key(host: SlotHost, of: (host: SlotHost) => string = hostSlotKey): string {
		return this.prefix ? `${this.prefix}/${of(host)}` : of(host);
	}

	async #read(Key: string): Promise<{ body: SlotBody; etag: string } | null> {
		const { s3, sdk } = await this.#client;
		try {
			const r = (await s3.send(new sdk.GetObjectCommand({ Bucket: this.bucket, Key }))) as { Body?: { transformToString(): Promise<string> }; ETag?: string };
			return { body: parseBody(r.Body ? await r.Body.transformToString() : ''), etag: r.ETag ?? '' };
		} catch (err) {
			if (isMissing(err)) return null;
			throw err;
		}
	}

	async #put(Key: string, Body: string, cond: { IfNoneMatch: '*' } | { IfMatch: string }): Promise<boolean> {
		const { s3, sdk } = await this.#client;
		try {
			await s3.send(new sdk.PutObjectCommand({ Bucket: this.bucket, Key, Body, ContentType: 'application/json', ...cond }));
			return true;
		} catch (err) {
			if (isConflict(err)) return false;
			throw err;
		}
	}

	async take(host: SlotHost, o: { holder: string; remainingMs: number | null; owner?: string }): Promise<SlotTake> {
		const Key = this.key(host);
		const owner = o.owner ?? randomUUID();
		const now = this.now();
		const mine = body(owner, o.holder, now, o.remainingMs);
		const reservation = async () => (await this.#read(this.key(host, hostReservationKey)))?.body ?? null;
		const held = (): Promise<SlotTake> => yieldToReservation(host, reservation, { owner, release: () => this.#release(Key, owner) }, now);
		if (await this.#put(Key, mine, { IfNoneMatch: '*' })) return held();
		const got = await this.#read(Key);
		// Released between our put and this read: once more from the start.
		if (!got) return (await this.#put(Key, mine, { IfNoneMatch: '*' })) ? held() : { busy: { holder: null, until: null } };
		if (expiresAt(got.body) > now) return { busy: busyOf(got.body) };
		// Expired (its holder died): take it over, unless someone else just did.
		return (await this.#put(Key, mine, { IfMatch: got.etag })) ? held() : { busy: { holder: null, until: null } };
	}

	async reserve(host: SlotHost, o: { owner: string; holder: string }): Promise<boolean> {
		const Key = this.key(host, hostReservationKey);
		const now = this.now();
		const mine = reservationBody(o.owner, o.holder, now);
		if (await this.#put(Key, mine, { IfNoneMatch: '*' })) return true;
		const got = await this.#read(Key);
		// Withdrawn between our put and this read: once more from the start.
		if (!got) return this.#put(Key, mine, { IfNoneMatch: '*' });
		// Ours (a renewal) or expired: replaced, unless someone else just did. Another's live one stands.
		if (got.body.owner === o.owner || expiresAt(got.body) <= now) return this.#put(Key, mine, { IfMatch: got.etag });
		return false;
	}

	async withdraw(host: SlotHost, owner: string): Promise<void> {
		const Key = this.key(host, hostReservationKey);
		const got = await this.#read(Key);
		if (got?.body.owner !== owner) return;
		const { s3, sdk } = await this.#client;
		await s3.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key }));
	}

	async #release(Key: string, owner: string): Promise<void> {
		try {
			const got = await this.#read(Key);
			// Ours unless it expired and was taken over, which a Lambda can't outlive.
			if (got?.body.owner !== owner) return;
			const { s3, sdk } = await this.#client;
			await s3.send(new sdk.DeleteObjectCommand({ Bucket: this.bucket, Key }));
		} catch {
			// It expires on its own (HOST_SLOT_MARGIN_MS past the holder's deadline).
		}
	}
}

// The local `file://` slot, for dev and tests only. Taking a free slot is
// atomic: the body is written to a temporary file and hard-linked into place,
// which fails if the slot exists, so a reader never sees an empty or partial
// body (one reads as no holder). But taking over an expired one and releasing are read
// then remove, so two processes meeting the same expired file at the same
// instant could both take it. Plain files offer no compare-and-swap (no flock
// in Node, and ingest/lease.py shares this file), and locally the worst case is
// two dev processes reading the fixtures at once. Production uses S3Slots,
// whose conditional writes (IfNoneMatch, IfMatch) are atomic.
class FileSlots implements HostSlots {
	constructor(
		readonly dir: string,
		readonly now: () => number
	) {}

	async take(host: SlotHost, o: { holder: string; remainingMs: number | null; owner?: string }): Promise<SlotTake> {
		const path = join(this.dir, hostSlotKey(host));
		await mkdir(dirname(path), { recursive: true });
		const owner = o.owner ?? randomUUID();
		const now = this.now();
		for (let attempt = 0; attempt < 2; attempt++) {
			const tmp = `${path}.${owner}.tmp`;
			// Owner only: nothing else on the machine reads it (the Python side's 0o600).
			await writeFile(tmp, body(owner, o.holder, now, o.remainingMs), { flag: 'wx', mode: 0o600 });
			try {
				await link(tmp, path);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
				const b = parseBody(await readFile(path, 'utf8').catch(() => ''));
				if (expiresAt(b) > now) return { busy: busyOf(b) };
				await rm(path, { force: true });
				continue;
			} finally {
				await rm(tmp, { force: true });
			}
			const reservation = async () => {
				try {
					return parseBody(await readFile(join(this.dir, hostReservationKey(host)), 'utf8'));
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
					throw err;
				}
			};
			return yieldToReservation(host, reservation, { owner, release: () => this.#release(path, owner) }, now);
		}
		return { busy: { holder: null, until: null } };
	}

	// A reservation is written whole like the slot: created by a hard link
	// (fails if one exists), renewed or taken over from an expired one by a
	// rename (read then replace, as the Python side's local _put; the class
	// comment's caveat applies).
	async reserve(host: SlotHost, o: { owner: string; holder: string }): Promise<boolean> {
		const path = join(this.dir, hostReservationKey(host));
		await mkdir(dirname(path), { recursive: true });
		const now = this.now();
		const tmp = `${path}.${randomUUID()}.tmp`;
		await writeFile(tmp, reservationBody(o.owner, o.holder, now), { flag: 'wx', mode: 0o600 });
		try {
			try {
				await link(tmp, path);
				return true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			}
			const b = parseBody(await readFile(path, 'utf8').catch(() => ''));
			if (b.owner !== o.owner && expiresAt(b) > now) return false;
			await rename(tmp, path);
			return true;
		} finally {
			await rm(tmp, { force: true });
		}
	}

	async withdraw(host: SlotHost, owner: string): Promise<void> {
		const path = join(this.dir, hostReservationKey(host));
		let b: SlotBody;
		try {
			b = parseBody(await readFile(path, 'utf8'));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw err;
		}
		if (b.owner === owner) await rm(path, { force: true });
	}

	async #release(path: string, owner: string): Promise<void> {
		try {
			if (parseBody(await readFile(path, 'utf8')).owner === owner) await rm(path, { force: true });
		} catch {
			// Gone already, or unreadable: it expires on its own.
		}
	}
}

/**
 * The slots in the copy `url` (MIRROR_URL) names, or null when there is none:
 * no MIRROR_URL, or the committed synthetic copy (backend/fixtures/mirror),
 * which nothing writes. Throws MirrorUrlError for a malformed URL.
 */
export function hostSlots(url: string | undefined, opts: { s3?: SlotS3; now?: () => number } = {}): HostSlots | null {
	const v = url?.trim();
	if (!v || /\/backend\/fixtures\/mirror\/?$/.test(v)) return null;
	const at: MirrorLocation = parseMirrorUrl(v);
	const now = opts.now ?? Date.now;
	return at.kind === 'file' ? new FileSlots(at.dir, now) : new S3Slots(at.bucket, at.prefix, opts.s3, now);
}

/**
 * How often a waiting scheduled pass looks at the slot and renews its
 * reservation. A per-feed fetch that finds the freed slot reserved gives it
 * back at once and asks again in HOST_BUSY_RETRY_SECONDS (2 minutes), so a
 * pass looking every 15 s takes its turn well before that.
 */
export const HOST_SLOT_POLL_MS = 15_000;

/**
 * The time a scheduled pass keeps for its own work: it stops waiting this
 * long before its deadline. The preliminary pass makes at most ~80 requests
 * (DAILY_MAX_FILES, 20 days, × ~4 range requests) and the GEFS pass ~50–64,
 * at one a second (ingest/daily.ts REQUEST_INTERVAL_MS), plus a manifest
 * save per day or issue: about a minute and a half at most, so 150 s leaves
 * room for S3's round trips. Both save as they go and stop at their
 * deadline, so a pass that gets the slot late copies what fits and its next
 * run catches up.
 *
 * The rest of the run is spent waiting, because one per-feed CHIRPS fetch
 * holds the slot for up to the fetcher's whole 900 s run (infra/feeds.tf
 * fetcher_timeout_seconds), 9–12 minutes in production (524, 660 and 707 s,
 * back to back, on 2026-11-01, when the old 180 s wait skipped the day). Less
 * the save margin (lambda-fetcher.ts DAILY_SAVE_MARGIN_MS, 20 s) and this, a
 * pass waits about 730 s, which outlasts each of those; its reservation then
 * keeps the next fetch from taking the freed slot first, so one fetch is the
 * most it waits behind. A fetch that took the slot just before the pass
 * started (up to ~885 s) can still outlast it: then the pass skips that run.
 */
export const HOST_SLOT_PASS_WORK_MS = 150_000;

/**
 * Take the slot for a scheduled pass, waiting for a held one until its
 * `deadline` (epoch ms) less HOST_SLOT_PASS_WORK_MS, or for `waitMs` from now
 * when given (never past the deadline), looking every `pollMs` (a sleep, not
 * a spin). Each pass runs once a day (the GEFS pass a few times a morning)
 * with no retry, so a skip costs a day: while it waits it reserves the next
 * turn (HostSlots.reserve, renewed at every look), so a per-feed fetch that
 * would take the freed slot first yields to it. Someone else's live
 * reservation (a waiting backfill's) is left alone, and the pass just waits
 * behind it. Its own reservation is withdrawn once it holds the slot or gives
 * up. A reservation that can't be written or withdrawn is logged and the wait
 * goes on: it is advisory (module header). Gives up (busy) at the wait's end.
 */
export async function takeHostSlotWaiting(
	slots: HostSlots,
	host: SlotHost,
	o: { holder: string; deadline: number; waitMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }
): Promise<SlotTake> {
	const now = o.now ?? Date.now;
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const pause = o.pollMs ?? HOST_SLOT_POLL_MS;
	const giveUpAt = Math.min(o.waitMs === undefined ? o.deadline - HOST_SLOT_PASS_WORK_MS : now() + o.waitMs, o.deadline);
	// One owner for every look and the reservation, so the pass never yields to its own.
	const owner = randomUUID();
	let reserving = false;
	try {
		for (;;) {
			const t = await slots.take(host, { holder: o.holder, remainingMs: o.deadline - now(), owner });
			if ('held' in t) return t;
			if (now() + pause > giveUpAt) return t;
			reserving = true;
			try {
				// False: another waiter's live reservation stands; wait behind it.
				await slots.reserve(host, { owner, holder: o.holder });
			} catch (err) {
				logEvent('warn', { event: 'host_slot_reservation_failed', host, holder: o.holder, ...safeError(err) });
			}
			await sleep(pause);
		}
	} finally {
		if (reserving) {
			try {
				await slots.withdraw(host, owner);
			} catch (err) {
				// It lapses on its own, HOST_RESERVATION_MS after the last look.
				logEvent('warn', { event: 'host_slot_reservation_failed', host, holder: o.holder, ...safeError(err) });
			}
		}
	}
}
