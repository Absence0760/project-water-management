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
// passes, which have no retry but tomorrow's, wait a little instead
// (takeHostSlotWaiting). The Python side raises HostBusy.
//
// Locally the same file under a `file://` MIRROR_URL, created with O_EXCL (the
// Python side's local lease). With no MIRROR_URL, or the committed synthetic
// copy, there is no slot and every caller goes on as before.
import { open, readFile, rm, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { type MirrorLocation, parseMirrorUrl } from '../mirror/url.js';
import type { FeedSource } from './config.js';

/** The hosts with a shared slot: CHC only (DWS asked for nothing across processes, and only the fetcher asks it). */
export type SlotHost = 'chc';

/** The slot a per-feed fetch of `source` takes: CHIRPS and CHIRPS-GEFS are CHC's (the same host feed-fetch.ts fetchGroup groups them by). */
export const slotHostFor = (source: FeedSource): SlotHost | null => (source === 'chirps' || source === 'chirps_gefs' ? 'chc' : null);

/** The slot's key in the mirror (under its prefix). The Python side's lease.host_slot_key names the same one. */
export const hostSlotKey = (host: SlotHost): string => `ingest-state/hosts/${host}/lease.json`;

/** How long past its holder's deadline a slot lasts (ingest/lease.py HOST_SLOT_MARGIN_S). */
export const HOST_SLOT_MARGIN_MS = 60_000;
/** A holder with no deadline (a local run, a test) is given Lambda's longest run (ingest/lease.py HOST_SLOT_DEFAULT_S). */
export const HOST_SLOT_DEFAULT_MS = 15 * 60_000;

/**
 * The fetcher's answer to a per-feed fetch it didn't start because the slot
 * was held: not a failure. The worker queues the feed's fetch again
 * (feed-ingest.ts), and its health is untouched.
 */
export const HostBusyAnswer = z.object({ ok: z.literal(false), deferred: z.literal('host_busy') }).strict();
export type HostBusyAnswer = z.output<typeof HostBusyAnswer>;
export const HOST_BUSY_ANSWER: HostBusyAnswer = { ok: false, deferred: 'host_busy' };
/** How long a deferred feed fetch waits before it is queued again: about one backfill month and its pause (infra/ingest_backfill.tf). */
export const HOST_BUSY_RETRY_SECONDS = 120;

/** A slot this process holds. */
export interface HeldSlot {
	readonly owner: string;
	/** Let it go (only if it is still ours). Never throws: a slot left behind expires on its own. */
	release(): Promise<void>;
}

/** The outcome of a take: held, or busy with who holds it (the holder's name, e.g. `ingest:rnl:backfill`) and until when. */
export type SlotTake = { held: HeldSlot } | { busy: { holder: string | null; until: string | null } };

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
	take(host: SlotHost, o: { holder: string; remainingMs: number | null }): Promise<SlotTake>;
}

const body = (owner: string, holder: string, nowMs: number, remainingMs: number | null) =>
	`${JSON.stringify({ owner, expires: (nowMs + (remainingMs === null ? HOST_SLOT_DEFAULT_MS : Math.max(0, remainingMs)) + HOST_SLOT_MARGIN_MS) / 1000, holder })}\n`;

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

	key(host: SlotHost): string {
		return this.prefix ? `${this.prefix}/${hostSlotKey(host)}` : hostSlotKey(host);
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

	async take(host: SlotHost, o: { holder: string; remainingMs: number | null }): Promise<SlotTake> {
		const Key = this.key(host);
		const owner = randomUUID();
		const now = this.now();
		const mine = body(owner, o.holder, now, o.remainingMs);
		const held = (): SlotTake => ({ held: { owner, release: () => this.#release(Key, owner) } });
		if (await this.#put(Key, mine, { IfNoneMatch: '*' })) return held();
		const got = await this.#read(Key);
		// Released between our put and this read: once more from the start.
		if (!got) return (await this.#put(Key, mine, { IfNoneMatch: '*' })) ? held() : { busy: { holder: null, until: null } };
		if (expiresAt(got.body) > now) return { busy: busyOf(got.body) };
		// Expired (its holder died): take it over, unless someone else just did.
		return (await this.#put(Key, mine, { IfMatch: got.etag })) ? held() : { busy: { holder: null, until: null } };
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

class FileSlots implements HostSlots {
	constructor(
		readonly dir: string,
		readonly now: () => number
	) {}

	async take(host: SlotHost, o: { holder: string; remainingMs: number | null }): Promise<SlotTake> {
		const path = join(this.dir, hostSlotKey(host));
		await mkdir(dirname(path), { recursive: true });
		const owner = randomUUID();
		const now = this.now();
		for (let attempt = 0; attempt < 2; attempt++) {
			let fh;
			try {
				// Owner only: nothing else on the machine reads it (the Python side's 0o600).
				fh = await open(path, 'wx', 0o600);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
				const b = parseBody(await readFile(path, 'utf8').catch(() => ''));
				if (expiresAt(b) > now) return { busy: busyOf(b) };
				await rm(path, { force: true });
				continue;
			}
			try {
				await fh.writeFile(body(owner, o.holder, now, o.remainingMs));
			} finally {
				await fh.close();
			}
			return { held: { owner, release: () => this.#release(path, owner) } };
		}
		return { busy: { holder: null, until: null } };
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

/** How long a scheduled pass waits for a held slot, and how often it looks. */
export const HOST_SLOT_WAIT_MS = 180_000;
export const HOST_SLOT_POLL_MS = 15_000;

/**
 * Take the slot, waiting up to `waitMs` for a held one, looking every
 * `pollMs` (a sleep, not a spin). For the fetcher's scheduled passes: each
 * runs once a day (the GEFS pass a few times a morning) with no retry, and a
 * backfill month holds the slot a minute or two then pauses at least a
 * minute (infra/ingest_backfill.tf), so a short wait nearly always lands in
 * a pause where skipping would cost a day. Gives up (busy) at the wait's end
 * or `deadline` (epoch ms), whichever is first.
 */
export async function takeHostSlotWaiting(
	slots: HostSlots,
	host: SlotHost,
	o: { holder: string; deadline: number; waitMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }
): Promise<SlotTake> {
	const now = o.now ?? Date.now;
	const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const giveUpAt = Math.min(now() + (o.waitMs ?? HOST_SLOT_WAIT_MS), o.deadline);
	for (;;) {
		const t = await slots.take(host, { holder: o.holder, remainingMs: o.deadline - now() });
		if ('held' in t) return t;
		const pause = o.pollMs ?? HOST_SLOT_POLL_MS;
		if (now() + pause > giveUpAt) return t;
		await sleep(pause);
	}
}
