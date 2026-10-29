import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_BUSY_ANSWER, HOST_SLOT_DEFAULT_MS, HOST_SLOT_MARGIN_MS, HostBusyAnswer, hostReservationKey, hostSlotKey, hostSlots, type SlotS3, slotHostFor, takeHostSlotWaiting } from './hostSlot.js';

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), 'host-slot-'));
	dirs.push(d);
	return d;
};

/**
 * The S3 calls the slot makes, with S3's conditional writes: If-None-Match: *
 * on an existing key and If-Match on another ETag answer 412
 * PreconditionFailed, as S3 does (and as ingest/fakes3.py does for the Python side).
 */
class FakeS3 implements SlotS3 {
	objects = new Map<string, string>();
	calls: [string, string, Record<string, unknown>][] = [];
	static etag = (b: string) => `"${createHash('md5').update(b).digest('hex')}"`;
	async send(command: unknown): Promise<unknown> {
		const c = command as { constructor: { name: string }; input: { Bucket: string; Key: string; Body?: string; IfNoneMatch?: string; IfMatch?: string } };
		const { Key, Body, IfNoneMatch, IfMatch } = c.input;
		const k = `${c.input.Bucket}/${Key}`;
		const held = this.objects.get(k);
		this.calls.push([c.constructor.name, Key, { IfNoneMatch, IfMatch }]);
		switch (c.constructor.name) {
			case 'GetObjectCommand':
				if (held === undefined) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
				return { Body: { transformToString: async () => held }, ETag: FakeS3.etag(held) };
			case 'PutObjectCommand':
				if ((IfNoneMatch === '*' && held !== undefined) || (IfMatch !== undefined && (held === undefined || FakeS3.etag(held) !== IfMatch))) {
					throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
				}
				this.objects.set(k, Body!);
				return {};
			case 'DeleteObjectCommand':
				this.objects.delete(k);
				return {};
			default:
				throw new Error(`unexpected ${c.constructor.name}`);
		}
	}
}

const KEY = 'ingest-state/hosts/chc/lease.json';
const RESERVED = 'ingest-state/hosts/chc/reserved.json';

describe('CHC request slot (feeds/hostSlot.ts)', () => {
	it('is the key the Python side takes, for CHIRPS and CHIRPS-GEFS only', () => {
		expect(hostSlotKey('chc')).toBe(KEY);
		expect(slotHostFor('chirps')).toBe('chc');
		expect(slotHostFor('chirps_gefs')).toBe('chc');
		for (const s of ['dws', 'ecmwf_ens', 'agera5_et0'] as const) expect(slotHostFor(s)).toBeNull();
	});

	it('has no slot without a copy, or in the committed synthetic one: callers go on as before', () => {
		expect(hostSlots(undefined)).toBeNull();
		expect(hostSlots('')).toBeNull();
		expect(hostSlots(pathToFileURL('/repo/backend/fixtures/mirror/').href)).toBeNull();
		expect(() => hostSlots('http://example.com/x')).toThrow(/MIRROR_URL must be/);
	});

	it('S3: created with If-None-Match, released by its owner; a second taker is busy and told who holds it until when', async () => {
		const s3 = new FakeS3();
		const now = 1_000_000_000_000;
		const slots = hostSlots('s3://mirror/pre', { s3, now: () => now })!;
		const a = await slots.take('chc', { holder: 'fetcher:chirps', remainingMs: 300_000 });
		if (!('held' in a)) throw new Error('expected the slot');
		expect(s3.calls[0]).toEqual(['PutObjectCommand', `pre/${KEY}`, { IfNoneMatch: '*', IfMatch: undefined }]);
		// The body the Python side reads: owner, expiry in epoch seconds (the holder's deadline plus the margin), holder.
		expect(JSON.parse(s3.objects.get(`mirror/pre/${KEY}`)!)).toEqual({ owner: a.held.owner, expires: (now + 300_000 + HOST_SLOT_MARGIN_MS) / 1000, holder: 'fetcher:chirps' });
		const b = await slots.take('chc', { holder: 'fetcher:prelim', remainingMs: null });
		expect(b).toEqual({ busy: { holder: 'fetcher:chirps', until: new Date(now + 300_000 + HOST_SLOT_MARGIN_MS).toISOString() } });
		await a.held.release();
		expect(s3.objects.has(`mirror/pre/${KEY}`)).toBe(false);
		// Control: free again, the next taker gets it.
		const c = await slots.take('chc', { holder: 'fetcher:prelim', remainingMs: null });
		expect('held' in c).toBe(true);
		expect(JSON.parse(s3.objects.get(`mirror/pre/${KEY}`)!).expires).toBe((now + HOST_SLOT_DEFAULT_MS + HOST_SLOT_MARGIN_MS) / 1000);
	});

	it('S3: a slot held by the Python ingest is busy; an expired one is taken over with If-Match on its ETag', async () => {
		const s3 = new FakeS3();
		const now = 2_000_000_000_000;
		const slots = hostSlots('s3://mirror', { s3, now: () => now })!;
		const python = `${JSON.stringify({ owner: 'abc', expires: now / 1000 + 600, holder: 'ingest:rnl:backfill' })}\n`;
		s3.objects.set(`mirror/${KEY}`, python);
		expect(await slots.take('chc', { holder: 'fetcher:chirps', remainingMs: 1000 })).toMatchObject({ busy: { holder: 'ingest:rnl:backfill' } });
		expect(s3.objects.get(`mirror/${KEY}`)).toBe(python); // left alone
		// A dead run's slot (Python's product leases carry no holder): expired, taken over.
		const dead = `${JSON.stringify({ owner: 'dead', expires: now / 1000 - 1 })}\n`;
		s3.objects.set(`mirror/${KEY}`, dead);
		const t = await slots.take('chc', { holder: 'fetcher:chirps', remainingMs: 1000 });
		if (!('held' in t)) throw new Error('expected the slot');
		expect(s3.calls.filter(([c]) => c === 'PutObjectCommand').at(-1)).toEqual(['PutObjectCommand', KEY, { IfNoneMatch: undefined, IfMatch: FakeS3.etag(dead) }]);
		expect(JSON.parse(s3.objects.get(`mirror/${KEY}`)!).owner).toBe(t.held.owner);
	});

	it('S3: a backfill execution’s hold is busy by its name, like any holder (ingest/lease.py hold_host_for_backfill)', async () => {
		const s3 = new FakeS3();
		const now = 2_000_000_000_000;
		const slots = hostSlots('s3://mirror', { s3, now: () => now })!;
		const hold = `${JSON.stringify({ owner: 'backfill:arn:aws:states:x:1:execution:sm:run-1', expires: now / 1000 + 420, holder: 'ingest:backfill:run-1' })}\n`;
		s3.objects.set(`mirror/${KEY}`, hold);
		expect(await slots.take('chc', { holder: 'fetcher:chirps', remainingMs: 1000 })).toEqual({ busy: { holder: 'ingest:backfill:run-1', until: new Date(now + 420_000).toISOString() } });
		expect(s3.objects.get(`mirror/${KEY}`)).toBe(hold);
	});

	it('S3: a free slot with a live reservation is given back at once and answers busy (reserved); an expired one is ignored', async () => {
		const s3 = new FakeS3();
		const now = 2_000_000_000_000;
		const slots = hostSlots('s3://mirror/pre', { s3, now: () => now })!;
		expect(hostReservationKey('chc')).toBe(RESERVED);
		const reservation = JSON.stringify({ owner: 'backfill:run-1', expires: now / 1000 + 300, holder: 'ingest:backfill:run-1' });
		s3.objects.set(`mirror/pre/${RESERVED}`, reservation);
		expect(await slots.take('chc', { holder: 'fetcher:chirps', remainingMs: 1000 })).toEqual({
			busy: { holder: 'ingest:backfill:run-1', until: new Date(now + 300_000).toISOString(), reserved: true }
		});
		expect(s3.objects.has(`mirror/pre/${KEY}`)).toBe(false); // given back
		expect(s3.objects.get(`mirror/pre/${RESERVED}`)).toBe(reservation); // only ever read here
		// Expired (the backfill gave up or took its turn and died): ignored.
		s3.objects.set(`mirror/pre/${RESERVED}`, JSON.stringify({ owner: 'backfill:run-1', expires: now / 1000 - 1 }));
		const t = await slots.take('chc', { holder: 'fetcher:chirps', remainingMs: 1000 });
		expect('held' in t).toBe(true);
	});

	it('S3: a reservation that can’t be read is ignored and logged: it is advisory, the slot is what counts', async () => {
		const s3 = new FakeS3();
		const send = s3.send.bind(s3);
		s3.send = async (command: unknown) => {
			if ((command as { input: { Key: string } }).input.Key === RESERVED) throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
			return send(command);
		};
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const t = await hostSlots('s3://mirror', { s3 })!.take('chc', { holder: 'fetcher:chirps', remainingMs: 1000 });
		expect('held' in t).toBe(true);
		expect(warn.mock.calls.map(([l]) => JSON.parse(l as string)).find((l) => l.event === 'host_slot_reservation_unreadable')).toMatchObject({ host: 'chc', error: 'AccessDenied' });
		warn.mockRestore();
	});

	it('S3: release leaves a slot someone else holds now', async () => {
		const s3 = new FakeS3();
		const slots = hostSlots('s3://mirror', { s3 })!;
		const t = await slots.take('chc', { holder: 'fetcher:chirps', remainingMs: 1000 });
		if (!('held' in t)) throw new Error('expected the slot');
		const other = JSON.stringify({ owner: 'someone-else', expires: Date.now() / 1000 + 600 });
		s3.objects.set(`mirror/${KEY}`, other);
		await t.held.release();
		expect(s3.objects.get(`mirror/${KEY}`)).toBe(other);
	});

	it('S3: a failure other than a lost race throws (the fetcher fails closed)', async () => {
		const slots = hostSlots('s3://mirror', {
			s3: {
				send: async () => {
					throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
				}
			}
		})!;
		await expect(slots.take('chc', { holder: 'fetcher:chirps', remainingMs: 1000 })).rejects.toThrow(/Access Denied/);
	});

	it('file://: the same file, owner-only, the same busy and takeover rules', async () => {
		const d = tmp();
		let now = 1_000_000;
		const slots = hostSlots(pathToFileURL(`${d}/`).href, { now: () => now })!;
		const path = join(d, KEY);
		const a = await slots.take('chc', { holder: 'fetcher:prelim', remainingMs: 10_000 });
		if (!('held' in a)) throw new Error('expected the slot');
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(await slots.take('chc', { holder: 'fetcher:gefs', remainingMs: 10_000 })).toMatchObject({ busy: { holder: 'fetcher:prelim' } });
		await a.held.release();
		expect(existsSync(path)).toBe(false);
		// A slot the Python side left (expired): taken over.
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ owner: 'dead', expires: now / 1000 - 1 }));
		now += 1;
		const b = await slots.take('chc', { holder: 'fetcher:gefs', remainingMs: 10_000 });
		if (!('held' in b)) throw new Error('expected the slot');
		expect(JSON.parse(readFileSync(path, 'utf8')).owner).toBe(b.held.owner);
		await b.held.release();
		// A live reservation beside it: the free slot is given back.
		writeFileSync(join(d, RESERVED), JSON.stringify({ owner: 'backfill:local', expires: now / 1000 + 300, holder: 'ingest:backfill:local' }));
		expect(await slots.take('chc', { holder: 'fetcher:gefs', remainingMs: 10_000 })).toMatchObject({ busy: { holder: 'ingest:backfill:local', reserved: true } });
		expect(existsSync(path)).toBe(false);
	});
});

describe('takeHostSlotWaiting (the scheduled passes)', () => {
	const held = (n: number) => {
		let tries = 0;
		return {
			tries: () => tries,
			slots: {
				take: async () => (++tries > n ? { held: { owner: 'x', release: async () => {} } } : { busy: { holder: 'ingest:rnl:backfill', until: null } })
			}
		};
	};
	const clock = () => {
		let t = 0;
		return { now: () => t, sleep: async (ms: number) => void (t += ms), at: () => t };
	};

	it('takes a free slot at once (positive control)', async () => {
		const h = held(0);
		const c = clock();
		expect(await takeHostSlotWaiting(h.slots, 'chc', { holder: 'p', deadline: 1e9, now: c.now, sleep: c.sleep })).toHaveProperty('held');
		expect(c.at()).toBe(0);
	});

	it('looks again every poll until the holder lets go', async () => {
		const h = held(3);
		const c = clock();
		expect(await takeHostSlotWaiting(h.slots, 'chc', { holder: 'p', deadline: 1e9, waitMs: 180_000, pollMs: 15_000, now: c.now, sleep: c.sleep })).toHaveProperty('held');
		expect(h.tries()).toBe(4);
		expect(c.at()).toBe(45_000);
	});

	it('gives up busy at the end of its wait, or sooner at the deadline', async () => {
		const c = clock();
		const h = held(Infinity);
		expect(await takeHostSlotWaiting(h.slots, 'chc', { holder: 'p', deadline: 1e9, waitMs: 60_000, pollMs: 15_000, now: c.now, sleep: c.sleep })).toEqual({ busy: { holder: 'ingest:rnl:backfill', until: null } });
		expect(c.at()).toBe(60_000);
		const c2 = clock();
		await takeHostSlotWaiting(held(Infinity).slots, 'chc', { holder: 'p', deadline: 20_000, waitMs: 180_000, pollMs: 15_000, now: c2.now, sleep: c2.sleep });
		expect(c2.at()).toBe(15_000);
	});
});

describe('HOST_BUSY_ANSWER', () => {
	it('is the deferral the worker recognises, and nothing else is', () => {
		expect(HostBusyAnswer.safeParse(HOST_BUSY_ANSWER).success).toBe(true);
		for (const r of [{ ok: false, error: 'x' }, { ok: false, deferred: 'other' }, { ok: false, deferred: 'host_busy', error: 'x' }, { ok: true }]) {
			expect(HostBusyAnswer.safeParse(r).success).toBe(false);
		}
	});
});
