// The worker tick's look at our CHIRPS copy (handlers/mirror-tick.ts, issue
// #604 R2-D): nothing with CHIRPS_SOURCE=chc; with mirror, each product's
// manifest recorded in mirror_copy for the API, an unchanged manifest skipped,
// and a new revision marking the cached finals of its days stale, after which
// the feeds read them again and their series change, with a History event
// (the rewrite fixture stands in for the copy's new values, as in
// recheck.db.test.ts); the same revision again changes nothing.
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
	for (const p of ['rnl', 'sat', 'prelim']) cpSync(join(src, p, 'manifest.json'), join(dir, p, 'manifest.json'));
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
		expect(await copyRows()).toHaveLength(3);
	});

	it('records each product for the API; skips a manifest it already handled; records a new month without a revision', async () => {
		const dir = tempCopy();
		vi.stubEnv('CHIRPS_SOURCE', 'mirror');
		const r = (await runTick({ reports: false, alerts: false, maxJobs: 0 })).mirror;
		// The sample copy is revision 1 with no changes: brought up to it, nothing to mark.
		expect(r).toMatchObject({ rnl: { status: 'applied', revision: 1, marked: 0 }, sat: { status: 'applied', revision: 1, marked: 0 }, prelim: { status: 'current' } });
		expect(await mirrorRows()).toEqual([
			{ origin: 'fixtures', product: 'rnl', revision: 1 },
			{ origin: 'fixtures', product: 'sat', revision: 1 }
		]);
		const u = await signUp('CopyPanel');
		// What the API reads (a signed-in session): every product, the preliminary one's last day too.
		expect(await withUser(u.id, (db) => mirrorCopy(db, 'fixtures'))).toMatchObject({
			sat: { revision: 1, finalThrough: '2025-12-31' },
			rnl: { revision: 1 },
			prelim: { revision: 1, prelimThrough: '2026-02-06', finalThrough: null }
		});
		// Nothing changed: no manifest is read again.
		expect(await runMirrorTick()).toEqual({ rnl: { status: 'unchanged' }, sat: { status: 'unchanged' }, prelim: { status: 'unchanged' } });
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
		vi.stubEnv('CHIRPS_SOURCE', 'mirror');
		const u = await signUp('MirrorTickFeed');
		const pid = (await u.call('POST', '/projects', { name: 'Tick' })).body.project.id as string;
		const f = await u.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ ...FIXTURE_CELL(), weight: 1 }], startDate: addDays(-(rw.fromDaysAgo + 10)) } });
		expect(f.status, JSON.stringify(f.body)).toBe(201);
		await u.call('POST', `/projects/${pid}/feeds/${f.body.feed.id}/run-now`);
		await drain();
		expect(await runMirrorTick()).toMatchObject({ sat: { status: 'applied', revision: 1, marked: 0 } });
		const before = await series(u, pid);

		// The copy's revision 2 changes the rewritten days.
		const [from, to] = [addDays(-rw.fromDaysAgo), addDays(-rw.toDaysAgo)];
		editManifest(dir, 'sat', (m) => {
			m.revision = 2;
			m.changes = [{ revision: 2, days: [from, to], cellsChanged: 40, maxAbsDiff: 5 }];
		});
		vi.stubEnv('FEED_FIXTURE_REWRITE', '1');
		const r = await runMirrorTick();
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
		expect(await runMirrorTick()).toMatchObject({ sat: { status: 'current', revision: 2 } });
		expect(await asOwner('SELECT 1 FROM chirps_cell_stale')).toEqual([]);
	});
});
