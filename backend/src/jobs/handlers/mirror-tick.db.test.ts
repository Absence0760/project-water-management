// The worker tick's look at our CHIRPS copy (handlers/mirror-tick.ts, issue
// #604 R2-D): nothing with CHIRPS_SOURCE=chc; with mirror, each product's
// manifest recorded in mirror_copy for the API, an unchanged manifest skipped,
// and a new revision marking the cached finals of its days stale, after which
// the feeds read them again and their series change, with a History event
// (the rewrite fixture stands in for the copy's new values, as in
// recheck.db.test.ts); the same revision again changes nothing. Since 246's
// fixes: the first manifest marks every cached final once (the baseline, for
// finals CHC rewrote before the copy existed), a part bounded by cell-days
// moves on tick after tick, and only the unapplied tail of `changes` is
// passed, in batches when it is long.
//
// DB test files run one at a time; this one removes every feed, feed job,
// cached cell and mirror row after each test.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { asOwner, signUp } from '../../__tests__/helpers.js';
import { withUser } from '../../db/tx.js';
import { FIXTURE_CELL, REWRITE_FIXTURE } from '../../feeds/fixtures.js';
import { mirrorCopy } from '../../feeds/mirrorRevision.js';
import { fixtureMirrorUrl } from '../../mirror/source.js';
import { runTick } from '../runner.js';
import { resetMirrorTick, runMirrorTick } from './mirror-tick.js';

const dirs: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	resetMirrorTick();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	await asOwner('DELETE FROM chirps_cell_year');
	await asOwner('DELETE FROM chirps_file');
	await asOwner('DELETE FROM chirps_cell_stale');
	await asOwner('DELETE FROM chirps_revision');
	await asOwner('DELETE FROM mirror_change');
	await asOwner('DELETE FROM mirror_manifest');
	await asOwner('DELETE FROM mirror_copy');
});

/** A copy of the committed sample copy's manifests (the arrays aren't read here), as MIRROR_URL. */
function tempCopy(): string {
	const dir = mkdtempSync(join(tmpdir(), 'wm-mirror-tick-'));
	dirs.push(dir);
	const src = new URL(fixtureMirrorUrl()).pathname;
	for (const p of ['rnl', 'sat', 'prelim', 'era5l', 'imerg_late']) cpSync(join(src, p, 'manifest.json'), join(dir, p, 'manifest.json'));
	vi.stubEnv('MIRROR_URL', pathToFileURL(`${dir}/`).href);
	return dir;
}
const editManifest = (dir: string, product: string, edit: (m: Record<string, unknown>) => void) => {
	const path = join(dir, product, 'manifest.json');
	const m = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	edit(m);
	writeFileSync(path, `${JSON.stringify(m, null, 2)}\n`);
};
const mirrorRows = () => asOwner(`SELECT origin, product, revision FROM mirror_manifest ORDER BY product`);
const copyRows = () => asOwner(`SELECT origin, product, revision, to_char(final_through, 'YYYY-MM-DD') AS final_through FROM mirror_copy ORDER BY product`);

describe('runMirrorTick', () => {
	it('does nothing with CHIRPS_SOURCE=chc: nothing read, nothing applied or recorded', async () => {
		tempCopy();
		vi.stubEnv('CHIRPS_SOURCE', 'chc');
		expect(await runMirrorTick()).toBeNull();
		expect((await runTick({ reports: false, alerts: false, maxJobs: 0 })).mirror).toBeNull();
		expect(await mirrorRows()).toEqual([]);
		expect(await copyRows()).toEqual([]);
		// Positive control: the same copy with mirror is read and recorded.
		vi.stubEnv('CHIRPS_SOURCE', 'mirror');
		expect(await runMirrorTick()).toMatchObject({ rnl: { status: 'applied' }, sat: { status: 'applied' }, prelim: { status: 'current' } });
		expect(await copyRows()).toHaveLength(5);
	});

	it('records each product for the API; skips a manifest it already handled; records a new month without a revision', async () => {
		const dir = tempCopy();
		vi.stubEnv('CHIRPS_SOURCE', 'mirror');
		const r = (await runTick({ reports: false, alerts: false, maxJobs: 0 })).mirror;
		// The sample copy is revision 1 with no changes: brought up to it, nothing to mark.
		expect(r).toMatchObject({
			rnl: { status: 'applied', revision: 1, marked: 0 },
			sat: { status: 'applied', revision: 1, marked: 0 },
			era5l: { status: 'applied', revision: 1, marked: 0 },
			imerg_late: { status: 'applied', revision: 1, marked: 0 },
			prelim: { status: 'current' }
		});
		expect(await mirrorRows()).toEqual([
			{ origin: 'fixtures', product: 'era5l', revision: 1 },
			{ origin: 'fixtures', product: 'imerg_late', revision: 1 },
			{ origin: 'fixtures', product: 'rnl', revision: 1 },
			{ origin: 'fixtures', product: 'sat', revision: 1 }
		]);
		const u = await signUp('CopyPanel');
		// What the API reads (a signed-in session): every product, the preliminary one's last day too.
		expect(await withUser(u.id, (db) => mirrorCopy(db, 'fixtures'))).toMatchObject({
			sat: { revision: 1, finalThrough: '2025-12-31' },
			rnl: { revision: 1 },
			prelim: { revision: 1, prelimThrough: '2026-02-06', finalThrough: null },
			era5l: { revision: 1, finalThrough: '2025-12-30', prelimThrough: null },
			imerg_late: { revision: 1, finalThrough: null, prelimThrough: '2026-02-08' }
		});
		// Nothing changed: no manifest is read again.
		expect(await runMirrorTick()).toEqual({
			rnl: { status: 'unchanged' },
			sat: { status: 'unchanged' },
			era5l: { status: 'unchanged' },
			imerg_late: { status: 'unchanged' },
			prelim: { status: 'unchanged' }
		});
		// The ingest adds a month: finalThrough moves, the revision doesn't.
		editManifest(dir, 'rnl', (m) => {
			(m.files as { url: string }[]).push({ ...(m.files as { url: string }[]).at(-1)!, url: (m.files as { url: string }[]).at(-1)!.url.replace('2025.12', '2026.01') });
			m.years = { first: 2023, last: 2026 };
			m.finalThrough = '2026-01-31';
		});
		expect(await runMirrorTick()).toMatchObject({ rnl: { status: 'current', revision: 1 }, sat: { status: 'unchanged' } });
		expect((await copyRows()).find((c: { product: string }) => c.product === 'rnl')).toMatchObject({ revision: 1, final_through: '2026-01-31' });
	});

	it('an invalid manifest is logged and tried again next tick; the other products go on', async () => {
		const dir = tempCopy();
		vi.stubEnv('CHIRPS_SOURCE', 'mirror');
		editManifest(dir, 'sat', (m) => void (m.revision = 0));
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await runMirrorTick()).toMatchObject({ rnl: { status: 'applied' }, sat: { status: 'failed' }, prelim: { status: 'current' } });
		expect(err.mock.calls.some((c) => String(c[0]).includes('mirror_revision_failed'))).toBe(true);
		err.mockRestore();
		editManifest(dir, 'sat', (m) => void (m.revision = 1));
		expect(await runMirrorTick()).toMatchObject({ sat: { status: 'applied' } });
	});
});

describe('a revision of the copy reaches the feeds (FEED_FETCHER=inline, the rewrite fixture as the copy’s new values)', () => {
	const today = () => new Date().toISOString().slice(0, 10);
	const addDays = (n: number) => fromEpochDay(toEpochDay(today()) + n);
	const tick = () => runTick({ feeds: false, reports: false, alerts: false });
	async function drain(max = 30) {
		for (let i = 0; i < max; i++) {
			await asOwner(`UPDATE job SET run_after = now() WHERE kind = 'feed_fetch' AND status = 'queued'`);
			if (!(await tick()).done) return;
		}
		throw new Error('the feed fetches never stopped');
	}
	const series = async (u: Awaited<ReturnType<typeof signUp>>, pid: string) => {
		const list = (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string }[];
		const meta = list.find((s) => s.kind === 'rain_chirps_mm')!;
		return (await u.call('GET', `/projects/${pid}/series/${meta.id}`)).body as { startDate: string; values: (number | null)[] };
	};

	it('marks the changed days stale; the feed reads them again and its series changes, with a History event; the same revision again changes nothing', async () => {
		const rw = REWRITE_FIXTURE();
		const dir = tempCopy();
		// The feeds read CHC's (fixture) files throughout, which FEED_FIXTURE_REWRITE rewrites: the stand-in for the
		// copy's revised values (the committed copy's arrays don't change). Only the tick reads the copy.
		vi.stubEnv('CHIRPS_SOURCE', 'chc');
		const mirrorTick = () => runMirrorTick({ env: { ...process.env, CHIRPS_SOURCE: 'mirror' } });
		const u = await signUp('MirrorTickFeed');
		const pid = (await u.call('POST', '/projects', { name: 'Tick' })).body.project.id as string;
		const f = await u.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ ...FIXTURE_CELL(), weight: 1 }], startDate: addDays(-(rw.fromDaysAgo + 10)) } });
		expect(f.status, JSON.stringify(f.body)).toBe(201);
		await u.call('POST', `/projects/${pid}/feeds/${f.body.feed.id}/run-now`);
		await drain();
		const fromChc = await series(u, pid);
		const finals = (
			await asOwner(
				`SELECT count(*)::int AS n FROM chirps_cell_year y, generate_series(1, 366) i WHERE y.origin = 'fixtures' AND y.product = 'sat' AND y.final[i] AND y.vals[i] IS NOT NULL`
			)
		)[0].n as number;
		expect(finals).toBeGreaterThan(30);
		// The first sight of the copy: the baseline marks every cached final (read before the copy existed), and records revision 1.
		expect(await mirrorTick()).toMatchObject({ sat: { status: 'applied', revision: 1, marked: finals } });
		expect((await asOwner(`SELECT count(*)::int AS n FROM chirps_cell_stale`))[0].n).toBe(finals);
		// The feed reads them all again; the values are the copy's, the same here, so nothing changes and nothing is logged.
		await u.call('POST', `/projects/${pid}/feeds/${f.body.feed.id}/run-now`);
		await drain(60);
		expect(await asOwner('SELECT 1 FROM chirps_cell_stale')).toEqual([]);
		expect(await asOwner('SELECT 1 FROM chirps_revision')).toEqual([]);
		const before = await series(u, pid);
		expect(before).toEqual(fromChc);
		// Once: another process seeing the same manifest marks nothing.
		resetMirrorTick();
		expect(await mirrorTick()).toMatchObject({ sat: { status: 'current', revision: 1 } });
		expect(await asOwner('SELECT 1 FROM chirps_cell_stale')).toEqual([]);

		// The copy's revision 2 changes the rewritten days.
		const [from, to] = [addDays(-rw.fromDaysAgo), addDays(-rw.toDaysAgo)];
		editManifest(dir, 'sat', (m) => {
			m.revision = 2;
			m.changes = [{ revision: 2, days: [from, to], cellsChanged: 40, maxAbsDiff: 5 }];
		});
		vi.stubEnv('FEED_FIXTURE_REWRITE', '1');
		const r = await mirrorTick();
		expect(r!.sat).toMatchObject({ status: 'applied', revision: 2 });
		const marked = r!.sat.marked!;
		expect(marked).toBeGreaterThan(10);
		expect((await asOwner(`SELECT count(*)::int AS n FROM chirps_cell_stale`))[0].n).toBe(marked);
		// The feed's next fetches read them again, ten days at a time.
		await u.call('POST', `/projects/${pid}/feeds/${f.body.feed.id}/run-now`);
		await drain();
		expect(await asOwner('SELECT 1 FROM chirps_cell_stale')).toEqual([]);
		const after = await series(u, pid);
		let changed = 0;
		for (let d = toEpochDay(after.startDate); d < toEpochDay(after.startDate) + after.values.length; d++) {
			const day = fromEpochDay(d);
			const was = before.values[d - toEpochDay(before.startDate)];
			const now = after.values[d - toEpochDay(after.startDate)];
			if (day >= from && day <= to) {
				expect(now, day).toBeCloseTo(was! * rw.factor, 1);
				if (was) changed++;
			} else expect(now, day).toBe(was);
		}
		expect(changed).toBeGreaterThan(5);
		const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'series.merged' AND subject ? 'chirpsRevision'`, [pid]);
		expect(events.reduce((n: number, e: { subject: { daysChanged: number } }) => n + e.subject.daysChanged, 0)).toBe(changed);

		// The same revision again (another process, which hasn't seen the manifest): nothing marked.
		resetMirrorTick();
		expect(await mirrorTick()).toMatchObject({ sat: { status: 'current', revision: 2 } });
		expect(await asOwner('SELECT 1 FROM chirps_cell_stale')).toEqual([]);
	});
});

describe('the tick and a large cache or a long changes list (246)', () => {
	const satManifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'sat', 'manifest.json'), 'utf8')) as { region: unknown };
	const storedSat = async () => ((await asOwner(`SELECT revision FROM mirror_manifest WHERE origin = 'fixtures' AND product = 'sat'`))[0]?.revision as number | undefined) ?? null;
	/** `n` cached fixtures cells in 2024 (from row 1600, column 4100, in the copy's region), each final on 1 March only. */
	const cacheMany = (n: number) =>
		asOwner(
			`INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through)
			 SELECT 'fixtures', 'sat', 1600 + k / 100, 4100 + k % 100, 2024, array_fill(NULL::real, ARRAY[366]), array_fill(false, ARRAY[366]), '2024-12-31'
			 FROM generate_series(0, $1::int - 1) k`,
			[n]
		).then(() => asOwner(`UPDATE chirps_cell_year SET vals[61] = 3, final[61] = true WHERE origin = 'fixtures'`));
	const day = (n: number) => new Date(Date.parse('2000-01-01') + n * 86_400_000).toISOString().slice(0, 10);
	/** Revision `last` with one one-day entry per revision 1…last (day k-1 after 2000-01-01), and `extra` entries of revision `last` more. */
	const longList = (dir: string, last: number) =>
		editManifest(dir, 'sat', (m) => {
			m.revision = last;
			m.changes = Array.from({ length: last }, (_, k) => ({ revision: k + 1, days: [day(k), day(k)], cellsChanged: 1, maxAbsDiff: 0.5 }));
		});
	/** One cached cell, final on every day of the long list's span (2000 to 2004). */
	const cacheSpan = async () => {
		for (let y = 2000; y <= 2004; y++) {
			await asOwner(
				`INSERT INTO chirps_cell_year (origin, product, row_idx, col_idx, year, vals, final, final_through)
				 VALUES ('fixtures', 'sat', 1600, 4100, $1, array_fill(1::real, ARRAY[366]), array_fill(true, ARRAY[366]), make_date($1, 12, 31))`,
				[y]
			);
		}
	};

	it('a baseline larger than one part moves on tick after tick until the revision is recorded', async () => {
		const dir = tempCopy();
		vi.stubEnv('CHIRPS_SOURCE', 'mirror');
		expect(satManifest(dir).region).toEqual({ w: 10, s: -35.5, e: 41, n: -8 });
		await cacheMany(3000);
		// One part a tick: 333 days of 2024 (1 March inside), then the rest.
		expect((await runMirrorTick({ maxParts: 1 }))!.sat).toMatchObject({ status: 'partial', marked: 3000, parts: 1 });
		expect(await storedSat()).toBeNull();
		expect((await runMirrorTick({ maxParts: 1 }))!.sat).toMatchObject({ status: 'applied', revision: 1, marked: 0, parts: 1 });
		expect(await storedSat()).toBe(1);
		expect((await asOwner(`SELECT count(*)::int AS n FROM chirps_cell_stale`))[0].n).toBe(3000);
		// Within one tick's parts it gets there too (another revision, a whole-year change: two parts).
		await asOwner('DELETE FROM chirps_cell_stale');
		editManifest(dir, 'sat', (m) => {
			m.revision = 2;
			m.changes = [{ revision: 2, days: ['2024-01-01', '2024-12-31'], cellsChanged: 3000, maxAbsDiff: 1 }];
		});
		expect((await runMirrorTick())!.sat).toMatchObject({ status: 'applied', revision: 2, marked: 3000, parts: 2 });
	});

	it('passes only the entries newer than the stored revision: a 1500-entry list whose last few are new applies', async () => {
		const dir = tempCopy();
		vi.stubEnv('CHIRPS_SOURCE', 'mirror');
		await cacheSpan();
		await asOwner(`INSERT INTO mirror_manifest (origin, product, revision, manifest) VALUES ('fixtures', 'sat', 1495, '{}')`);
		longList(dir, 1500);
		const r = (await runMirrorTick())!.sat;
		expect(r).toMatchObject({ status: 'applied', revision: 1500, marked: 5, parts: 1 });
		expect(await asOwner(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM chirps_cell_stale ORDER BY day`)).toEqual([1495, 1496, 1497, 1498, 1499].map((k) => ({ day: day(k) })));
		// What mirror_manifest keeps: the entries applied, not the whole history.
		expect((await asOwner(`SELECT jsonb_array_length(manifest -> 'changes') AS n FROM mirror_manifest WHERE origin = 'fixtures' AND product = 'sat'`))[0].n).toBe(5);
	});

	it('a backlog of more than 1000 new entries goes in batches, each recorded as its revision, and never sticks', async () => {
		const dir = tempCopy();
		vi.stubEnv('CHIRPS_SOURCE', 'mirror');
		await cacheSpan();
		await asOwner(`INSERT INTO mirror_manifest (origin, product, revision, manifest) VALUES ('fixtures', 'sat', 100, '{}')`);
		longList(dir, 1500);
		// One part a tick: the first batch (revisions 101–1100) is recorded as revision 1100, the next tick takes the rest.
		expect((await runMirrorTick({ maxParts: 1 }))!.sat).toMatchObject({ status: 'partial', marked: 1000, parts: 1 });
		expect(await storedSat()).toBe(1100);
		expect((await runMirrorTick({ maxParts: 1 }))!.sat).toMatchObject({ status: 'applied', revision: 1500, marked: 400, parts: 1 });
		expect(await storedSat()).toBe(1500);
		expect((await asOwner(`SELECT count(*)::int AS n FROM chirps_cell_stale`))[0].n).toBe(1400);
	});
});
