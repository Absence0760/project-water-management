// Our CHIRPS copy's state for the data feeds panel (feeds/rainCopy.ts, issue
// #604): read from mirror_copy (246), which the worker's mirror tick fills,
// never from the copy itself. Null with CHIRPS_SOURCE=chc (no query); "not
// checked yet" (`readable: false`) before any tick; the committed sample copy
// on time as of the day it was made once a tick has recorded it; a real copy
// (origin chc) counting its lags to today, with a product the tick hasn't
// seen behind.
//
// DB test files run one at a time; this one removes every mirror row it made
// after each test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIRROR_FIXTURE } from '../../scripts/gen-mirror-fixture.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { type Db, withoutUser, withUser } from '../db/tx.js';
import { resetMirrorTick, runMirrorTick } from '../jobs/handlers/mirror-tick.js';
import { recordMirrorCopy } from './mirrorRevision.js';
import { rainCopy, SAMPLE_COPY_MADE } from './rainCopy.js';

// Another file's tick may have recorded the copy.
beforeEach(() => asOwner('DELETE FROM mirror_copy'));
afterEach(async () => {
	vi.unstubAllEnvs();
	resetMirrorTick();
	await asOwner('DELETE FROM mirror_change');
	await asOwner('DELETE FROM mirror_manifest');
	await asOwner('DELETE FROM mirror_copy');
	await asOwner('DELETE FROM chirps_cell_stale');
});

const asUser = async <T>(fn: (db: Db) => Promise<T>): Promise<T> => withUser((await signUp('CopyPanel')).id, fn);
const manifest = (product: string, days: { finalThrough?: string; prelimThrough?: string }) => ({ product, revision: 2, finalThrough: null, prelimThrough: null, ...days });

describe('rainCopy', () => {
	it('is null while CHIRPS is read from CHC itself, without a query', async () => {
		const noDb = { query: () => Promise.reject(new Error('queried')) } as unknown as Db;
		expect(await rainCopy(noDb, { CHIRPS_SOURCE: 'chc' })).toBeNull();
		// The live default until the cutover.
		expect(await rainCopy(noDb, { FEED_SOURCE: 'live' })).toBeNull();
	});

	it('before the worker has ticked against the copy it is not checked yet; after a tick, the sample copy on time as of the day it was made', async () => {
		expect(SAMPLE_COPY_MADE).toBe(MIRROR_FIXTURE.today);
		const now = new Date('2026-10-27T12:00:00Z');
		expect(await asUser((db) => rainCopy(db, {}, now))).toEqual({ readable: false });
		// The worker's tick (fixtures: the committed sample copy) records the three manifests. (The test setup says chc.)
		vi.stubEnv('CHIRPS_SOURCE', 'mirror');
		expect(await runMirrorTick()).toMatchObject({ sat: { status: expect.any(String) }, prelim: { status: 'current' } });
		expect(await asUser((db) => rainCopy(db, {}, now))).toEqual({
			readable: true,
			sample: true,
			asOf: SAMPLE_COPY_MADE,
			final: { sat: { through: MIRROR_FIXTURE.finalThrough, behind: false }, rnl: { through: MIRROR_FIXTURE.finalThrough, behind: false } },
			preliminary: { through: MIRROR_FIXTURE.prelimThrough, behind: false }
		});
	});

	it('a real copy (origin chc) counts to today (UTC), reads only its own origin, and a product the tick hasn’t seen is behind', async () => {
		vi.stubEnv('FEED_SOURCE', 'live');
		const env = { CHIRPS_SOURCE: 'mirror' };
		// Only the sample's rows: nothing recorded for chc yet.
		await withoutUser((db) => recordMirrorCopy(db, 'fixtures', 'sat', manifest('sat', { finalThrough: '2025-12-31' })));
		expect(await asUser((db) => rainCopy(db, env, new Date('2026-02-10T00:00:00Z')))).toEqual({ readable: false });

		await withoutUser((db) => recordMirrorCopy(db, 'chc', 'sat', manifest('sat', { finalThrough: '2025-12-31', prelimThrough: '2026-02-06' })));
		await withoutUser((db) => recordMirrorCopy(db, 'chc', 'prelim', manifest('prelim', { prelimThrough: '2026-02-06' })));
		const at = (iso: string) => asUser((db) => rainCopy(db, env, new Date(iso)));
		// rnl not recorded: behind, holding nothing.
		expect(await at('2026-02-10T00:00:00Z')).toEqual({
			readable: true,
			sample: false,
			asOf: '2026-02-10',
			final: { sat: { through: '2025-12-31', behind: false }, rnl: { through: null, behind: true } },
			preliminary: { through: '2026-02-06', behind: false }
		});
		// Months later the same days are behind (and asOf is today in UTC, past 22:00 too).
		expect(await at('2026-10-27T23:30:00Z')).toMatchObject({ asOf: '2026-10-27', final: { sat: { behind: true } }, preliminary: { behind: true } });
		// The next record moves it on.
		await withoutUser((db) => recordMirrorCopy(db, 'chc', 'rnl', manifest('rnl', { finalThrough: '2025-12-31' })));
		expect(await at('2026-02-10T00:00:00Z')).toMatchObject({ final: { rnl: { through: '2025-12-31', behind: false } } });
	});
});
