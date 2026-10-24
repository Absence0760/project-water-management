// The rain feed from the map's catchment boundary (issue #326 B-rain,
// feeds/fromBoundary.ts): the proposal (editor) and Apply (owner) as the
// roles see them, with positive controls; no boundary, a boundary changed
// since the proposal, one too big, and another project's boundary; giving
// the cells to an empty feed, never to one whose series holds a record; the
// History naming the boundary; the plain feed routes refusing the boundary
// mark; and the applied feed fetching offline through the fixtures.
//
// DB test files run one at a time; like feeds.db.test.ts this file removes
// every feed and feed job after each test, so no other file's tick finds one.
import { afterEach, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { runTick } from '../jobs/runner.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(async () => {
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	// The applied feed's fetch fills the shared cell cache (208): leave it empty for the next file.
	await asOwner('DELETE FROM chirps_cell_year');
	await asOwner('DELETE FROM chirps_file');
	await asOwner('DELETE FROM chirps_cell_stale');
});

const ring = (w: number, s: number, e: number, n: number) => [
	[w, s],
	[e, s],
	[e, n],
	[w, n],
	[w, s]
];
/** A catchment of about 0.12° × 0.1° (about 110 km²) inside the fixture grid's cover. */
const CATCHMENT = { type: 'Polygon', coordinates: [ring(21.21, -33.79, 21.33, -33.69)] };

async function setup() {
	const owner = await signUp('BoundaryOwner');
	const editor = await signUp('BoundaryEditor');
	const viewer = await signUp('BoundaryViewer');
	const pid = (await owner.call('POST', '/projects', { name: 'Rain from the boundary' })).body.project.id as string;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const) {
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: u.email, role })).status).toBe(201);
	}
	return { owner, editor, viewer, pid };
}
const at = (pid: string) => `/projects/${pid}/feeds/chirps/from-boundary`;
async function drawBoundary(u: User, pid: string, geometry: unknown = CATCHMENT, name = 'Test catchment') {
	const r = await u.call('POST', `/projects/${pid}/map/features`, { kind: 'catchment_boundary', name, geometry });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	return r.body.feature as { id: string; updatedAt: string; areaM2: number };
}
const apply = (u: User, pid: string, b: { id: string; updatedAt: string }, extra: Record<string, unknown> = {}) =>
	u.call('POST', at(pid), { featureId: b.id, updatedAt: b.updatedAt, ...extra });

describe('the rain feed from the catchment boundary', () => {
	it('proposes the boundary’s area-weighted cells to editors, and owners apply it: a CHIRPS feed with those cells, recorded in the History', async () => {
		const { owner, editor, viewer, pid } = await setup();
		const b = await drawBoundary(editor, pid);

		// Viewers neither see the proposal nor apply it; editors see it but can't apply (feeds are the owner's).
		expect((await viewer.call('GET', at(pid))).status).toBe(403);
		expect((await apply(viewer, pid, b)).status).toBe(403);
		const seen = await editor.call('GET', at(pid));
		expect(seen.status).toBe(200);
		expect(seen.body.canApply).toBe(false);
		expect((await apply(editor, pid, b)).status).toBe(403);

		// Positive control: the owner.
		const p = (await owner.call('GET', at(pid))).body;
		expect(p.canApply).toBe(true);
		expect(p.boundary).toEqual({ featureId: b.id, name: 'Test catchment', updatedAt: b.updatedAt, areaKm2: expect.any(Number) });
		expect(p.boundary.areaKm2).toBeCloseTo(b.areaM2 / 1e6, 2);
		// 0.12° × 0.10° on the 0.05° grid: 3 whole-or-part columns × 3 rows (the edges cut cells at 21.20/21.35 and −33.80/−33.65).
		expect(p.cells).toHaveLength(9);
		expect(p.rows).toBe(3);
		expect(p.insideKm2).toBeCloseTo(b.areaM2 / 1e6, 0);
		expect(p.method).toMatch(/^area-weighted over 9 CHIRPS v3 cells/);
		// No CHIRPS record yet: the default series, sat over the last 60 days (startDate null), and nothing to replace.
		expect(p.apply).toEqual({ action: 'create', targetKind: 'rain_chirps_mm', targetName: '', product: 'sat', startDate: null });
		expect(p.runSeries).toBeNull();
		expect(p.replace).toBeNull();

		const r = await apply(owner, pid, b);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.feed).toMatchObject({
			source: 'chirps',
			targetKind: 'rain_chirps_mm',
			targetName: '',
			config: { cells: p.cells.map(({ lat, lon, weight }: { lat: number; lon: number; weight: number }) => ({ lat, lon, weight })), boundary: p.boundary }
		});
		const [ev] = await asOwner(`SELECT kind, subject FROM audit_event WHERE project_id = $1 AND kind = 'feed.configured' ORDER BY id DESC LIMIT 1`, [pid]);
		expect(ev.subject).toMatchObject({ action: 'created', source: 'chirps', boundary: { featureId: b.id, name: 'Test catchment' }, cells: 9 });

		// Applied: the proposal now says so, and offers nothing to do.
		expect((await owner.call('GET', at(pid))).body.apply).toEqual({ action: 'none', feedId: r.body.feed.id });
	});

	it('says clearly when there is no boundary, and refuses one too big for a feed', async () => {
		const { owner, pid } = await setup();
		const none = await owner.call('GET', at(pid));
		expect(none.status).toBe(409);
		expect(none.body.error).toMatch(/no catchment boundary on its map/);
		expect((await apply(owner, pid, { id: crypto.randomUUID(), updatedAt: new Date().toISOString() })).status).toBe(409);

		await drawBoundary(owner, pid, { type: 'Polygon', coordinates: [ring(21, -34, 21.6, -33.4)] });
		const big = await owner.call('GET', at(pid));
		expect(big.status).toBe(409);
		expect(big.body.error).toMatch(/covers 144 of the 0\.05° CHIRPS cells in 12 rows; one feed reads at most 100 cells/);
	});

	it('refuses a boundary changed since the proposal, and never reaches another project’s boundary', async () => {
		const { owner, editor, pid } = await setup();
		const b = await drawBoundary(owner, pid);
		const moved = await editor.call('PATCH', `/projects/${pid}/map/features/${b.id}`, { geometry: { type: 'Polygon', coordinates: [ring(21.21, -33.79, 21.3, -33.7)] } });
		expect(moved.status, JSON.stringify(moved.body)).toBe(200);
		const stale = await apply(owner, pid, b);
		expect(stale.status).toBe(409);
		expect(stale.body.error).toMatch(/changed since this proposal/);
		// Positive control: the new version applies.
		expect((await apply(owner, pid, moved.body.feature)).status).toBe(201);

		// Another project's boundary: its id is not this project's boundary, and its project is not readable.
		const other = await signUp('OtherOwner');
		const opid = (await other.call('POST', '/projects', { name: 'Someone else’s' })).body.project.id as string;
		const ob = await drawBoundary(other, opid, CATCHMENT, 'Private catchment');
		expect((await owner.call('GET', at(opid))).status).toBe(404);
		expect((await apply(owner, opid, ob)).status).toBe(404);
		const cross = await apply(owner, pid, ob);
		expect(cross.status).toBe(409);
		expect(JSON.stringify(cross.body)).not.toMatch(/Private catchment/);
	});

	it('gives the cells to a CHIRPS feed whose series is empty, keeping its product and start date; never to one with a record', async () => {
		const { owner, pid } = await setup();
		const b = await drawBoundary(owner, pid);
		const feed = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ lat: -33.72, lon: 21.27 }], product: 'rnl', startDate: '2020-01-01' } })).body.feed;
		const p = (await owner.call('GET', at(pid))).body;
		expect(p.apply).toEqual({ action: 'update', feedId: feed.id, targetKind: 'rain_chirps_mm', targetName: '', product: 'rnl', startDate: '2020-01-01' });
		const r = await apply(owner, pid, b, { feedId: feed.id });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body.feed.config).toMatchObject({ product: 'rnl', startDate: '2020-01-01', boundary: { featureId: b.id } });
		expect(r.body.feed.config.cells).toHaveLength(9);
		expect(r.body.feed.config.bbox).toBeUndefined();
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'feed.configured' ORDER BY id DESC LIMIT 1`, [pid]);
		expect(ev.subject).toMatchObject({ action: 'changed', feedId: feed.id, boundary: { name: 'Test catchment' } });

		// Once the series holds a record, new cells would splice two areas: refused, and the proposal is a separate series.
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2026-01-01', values: [1, 2, 3], product: 'CHIRPS rnl', productVersion: '3.0' });
		const b2 = (await owner.call('PATCH', `/projects/${pid}/map/features/${b.id}`, { geometry: { type: 'Polygon', coordinates: [ring(21.21, -33.79, 21.3, -33.7)] } })).body.feature;
		const spliced = await apply(owner, pid, b2, { feedId: feed.id });
		expect(spliced.status).toBe(409);
		expect(spliced.body.error).toMatch(/never splices two areas/);
		// From the record's first day, sat (it starts after 1998).
		expect((await owner.call('GET', at(pid))).body.apply).toEqual({ action: 'create', targetKind: 'rain_chirps_mm', targetName: 'CHIRPS boundary', product: 'sat', startDate: '2026-01-01' });
		expect((await apply(owner, pid, b2, { targetName: '' })).status).toBe(409);
		const sep = await apply(owner, pid, b2);
		expect(sep.status).toBe(201);
		expect(sep.body.feed.targetName).toBe('CHIRPS boundary');
	});

	it('waits for a fetch that is out: its answer was asked for with the old cells', async () => {
		const { owner, pid } = await setup();
		const b = await drawBoundary(owner, pid);
		const feed = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ lat: -33.72, lon: 21.27 }] } })).body.feed;
		// A fetch sent to the fetcher and not yet applied (029's columns, as app_begin_feed_fetch sets them).
		await asOwner(`UPDATE data_feed SET fetch_job_id = gen_random_uuid(), fetch_start = '2026-01-01', fetch_end = '2026-01-31' WHERE id = $1`, [feed.id]);
		const out = await apply(owner, pid, b, { feedId: feed.id });
		expect(out.status).toBe(409);
		expect(out.body.details).toMatchObject({ code: 'feed_fetching' });
		expect((await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds.find((f: { id: string }) => f.id === feed.id).config.boundary).toBeUndefined();
		// Positive control: once it has come back (cleared by app_take_feed_fetch), the cells apply.
		await asOwner(`UPDATE data_feed SET fetch_job_id = NULL, fetch_start = NULL, fetch_end = NULL WHERE id = $1`, [feed.id]);
		expect((await apply(owner, pid, b, { feedId: feed.id })).status).toBe(200);
	});

	it('refuses a feed that is not CHIRPS daily rainfall, and an id that is not a feed of the project', async () => {
		const { owner, pid } = await setup();
		const b = await drawBoundary(owner, pid);
		const gefs = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps_gefs', config: { cells: [{ lat: -33.72, lon: 21.27 }] } })).body.feed;
		expect((await apply(owner, pid, b, { feedId: gefs.id })).status).toBe(409);
		expect((await apply(owner, pid, b, { feedId: crypto.randomUUID() })).status).toBe(404);
		expect((await apply(owner, pid, b, { feedId: gefs.id, role: 'owner' })).status).toBe(400);
	});

	it('the plain feed routes can’t claim the boundary mark', async () => {
		const { owner, pid } = await setup();
		const boundary = { featureId: crypto.randomUUID(), name: 'Forged', updatedAt: new Date().toISOString(), areaKm2: 1 };
		const cells = [{ lat: -33.72, lon: 21.27 }];
		const forged = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells, boundary } });
		expect(forged.status).toBe(400);
		const feed = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells } })).body.feed;
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${feed.id}`, { config: { cells, boundary } })).status).toBe(400);
		// A new config without the mark is fine, and a change that leaves the config alone keeps the one the route wrote.
		const b = await drawBoundary(owner, pid);
		expect((await apply(owner, pid, b, { feedId: feed.id })).status).toBe(200);
		const off = await owner.call('PATCH', `/projects/${pid}/feeds/${feed.id}`, { enabled: false });
		expect(off.body.feed.config.boundary).toMatchObject({ featureId: b.id });
		const recut = await owner.call('PATCH', `/projects/${pid}/feeds/${feed.id}`, { config: { cells } });
		expect(recut.status).toBe(200);
		expect(recut.body.feed.config.boundary).toBeUndefined();
	});

	it('fetches offline: the applied feed fills its series from the fixtures (FEED_SOURCE=fixtures)', async () => {
		const { owner, pid } = await setup();
		const b = await drawBoundary(owner, pid);
		const feed = (await apply(owner, pid, b)).body.feed;
		expect((await owner.call('POST', `/projects/${pid}/feeds/${feed.id}/run-now`)).status).toBe(202);
		await runTick({ feeds: false, reports: false, alerts: false });
		const listed = (await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds[0];
		expect(listed).toMatchObject({ consecutiveFailures: 0, lastError: null });
		expect(listed.lastDataDate).not.toBeNull();
		const series = ((await owner.call('GET', `/projects/${pid}/series`)).body.series as { kind: string; length: number }[]).find((s) => s.kind === 'rain_chirps_mm');
		expect(series!.length).toBeGreaterThan(50);
	});
});

// Issue #561: a project whose runs read a CHIRPS record (a workbook import's, no
// product recorded). The boundary's feed never takes over from it unseen: its
// series is named to sort after it, it backfills from the record's first day
// (rnl for a record before 1998), and replacing the record is a choice of its
// own, staged and swapped in whole.
describe('a boundary feed beside the CHIRPS record runs read (issue #561)', () => {
	const RECORD = 'Rainfall CHIRPS satelite (mm)';
	/** The series a run reads for CHIRPS now: the first with no site by name, in byte order (runs/execute.ts loadLiveInput). */
	const runPick = async (pid: string) =>
		(
			await asOwner(`SELECT name FROM time_series WHERE project_id = $1 AND kind = 'rain_chirps_mm' AND site_node_id IS NULL ORDER BY name COLLATE "C" LIMIT 1`, [pid])
		)[0]?.name as string | undefined;
	async function withRecord(startDate = '1995-01-01') {
		const s = await setup();
		const put = await s.owner.call('PUT', `/projects/${s.pid}/series`, { kind: 'rain_chirps_mm', name: RECORD, unit: 'mm', startDate, values: [1, 2, 3] });
		expect(put.status, JSON.stringify(put.body)).toBe(200);
		return { ...s, b: await drawBoundary(s.owner, s.pid) };
	}

	it('proposes a series that sorts after the record, read from its first day with rnl, and offers to replace it', async () => {
		const { owner, pid, b } = await withRecord();
		const p = (await owner.call('GET', at(pid))).body;
		expect(p.runSeries).toEqual({ name: RECORD, firstDay: '1995-01-01', lastDay: '1995-01-03' });
		expect(p.apply).toEqual({ action: 'create', targetKind: 'rain_chirps_mm', targetName: `${RECORD} (boundary)`, product: 'rnl', startDate: '1995-01-01' });
		expect(p.replace).toEqual({ available: true, targetName: RECORD, product: 'rnl', startDate: '1995-01-01' });

		const r = await apply(owner, pid, b);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.feed).toMatchObject({ targetName: `${RECORD} (boundary)`, config: { product: 'rnl', startDate: '1995-01-01' } });
		// Its first days arrive (as a fetch writes them): runs still read the record.
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', name: `${RECORD} (boundary)`, unit: 'mm', startDate: '2026-01-01', values: [4] })).status).toBe(200);
		expect(await runPick(pid)).toBe(RECORD);
	});

	it('refuses a name that would sort ahead of the record (“CHIRPS boundary”, the default series), positive control a name after it', async () => {
		const { owner, pid, b } = await withRecord();
		for (const targetName of ['CHIRPS boundary', '']) {
			const r = await apply(owner, pid, b, { targetName });
			expect(r.status).toBe(409);
			expect(r.body.details).toMatchObject({ code: 'series_takes_over', runSeries: RECORD, targetName });
		}
		expect((await apply(owner, pid, b, { targetName: 'Satellite boundary' })).status).toBe(201);
		expect(await runPick(pid)).toBe(RECORD);
	});

	it('takes a product and start date; sat clamps the default start to 1998, and an earlier one asked for is refused', async () => {
		const { owner, pid, b } = await withRecord();
		const sat = await apply(owner, pid, b, { product: 'sat' });
		expect(sat.status, JSON.stringify(sat.body)).toBe(201);
		expect(sat.body.feed.config).toMatchObject({ product: 'sat', startDate: '1998-01-01' });
		await asOwner('DELETE FROM data_feed WHERE project_id = $1', [pid]);
		expect((await apply(owner, pid, b, { product: 'sat', startDate: '1997-12-31' })).status).toBe(400);
		const chosen = await apply(owner, pid, b, { product: 'rnl', startDate: '2001-02-03' });
		expect(chosen.status).toBe(201);
		expect(chosen.body.feed.config).toMatchObject({ product: 'rnl', startDate: '2001-02-03' });
	});

	it('replaces the record only when asked: the feed writes it, backfilling from its first day, staged until complete', async () => {
		const { owner, pid, b } = await withRecord();
		// sat can't backfill a record from 1995: one product end to end.
		const sat = await apply(owner, pid, b, { replace: true, product: 'sat' });
		expect(sat.status).toBe(409);
		expect(sat.body.details).toMatchObject({ code: 'series_backfill' });
		expect((await apply(owner, pid, b, { replace: true, targetName: 'x' })).status).toBe(400);

		const r = await apply(owner, pid, b, { replace: true });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.feed).toMatchObject({ targetName: RECORD, config: { product: 'rnl', startDate: '1995-01-01', boundary: { featureId: b.id } } });
		const [row] = await asOwner('SELECT replace_series_from FROM data_feed WHERE id = $1', [r.body.feed.id]);
		expect(row.replace_series_from).not.toBeNull();
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'feed.configured' ORDER BY id DESC LIMIT 1`, [pid]);
		expect(ev.subject).toMatchObject({ action: 'created', targetName: RECORD, boundary: { featureId: b.id }, replaceSeries: expect.any(String) });
		expect(await runPick(pid)).toBe(RECORD);
		// A boundary feed now reads it: nothing more to apply or replace.
		const after = (await owner.call('GET', at(pid))).body;
		expect(after.apply).toEqual({ action: 'none', feedId: r.body.feed.id });
		expect(after.replace).toBeNull();
	});

	it('offers no replacement of a record another feed writes, or one already of the version the feed would write', async () => {
		const { owner, pid, b } = await withRecord();
		const other = await owner.call('POST', `/projects/${pid}/feeds`, {
			source: 'chirps',
			config: { cells: [{ lat: -33.72, lon: 21.27 }], product: 'rnl', startDate: '1995-01-01' },
			targetName: RECORD,
			replaceSeries: true
		});
		expect(other.status, JSON.stringify(other.body)).toBe(201);
		const p = (await owner.call('GET', at(pid))).body;
		expect(p.replace).toMatchObject({ available: false, targetName: RECORD, reason: expect.stringMatching(/a feed already writes “Rainfall CHIRPS satelite \(mm\)”/) });
		expect((await apply(owner, pid, b, { replace: true })).body.details).toMatchObject({ code: 'series_replace' });

		const same = await setup();
		await same.owner.call('PUT', `/projects/${same.pid}/series`, { kind: 'rain_chirps_mm', name: RECORD, unit: 'mm', startDate: '2001-01-01', values: [1], product: 'CHIRPS sat', productVersion: '3.0' });
		const sb = await drawBoundary(same.owner, same.pid);
		expect((await same.owner.call('GET', at(same.pid))).body.replace).toMatchObject({ available: false, reason: expect.stringMatching(/already holds CHIRPS v3 sat days of this version/) });
		expect((await apply(same.owner, same.pid, sb, { replace: true })).status).toBe(409);
	});
});

describe('a plain feed never takes over the series runs read (issue #561)', () => {
	it('refuses an attach or a re-target into a new series that sorts ahead of a filled one; positive controls a name after it and the series itself', async () => {
		const { owner, pid } = await setup();
		await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', name: 'Rainfall CHIRPS', unit: 'mm', startDate: '2001-01-01', values: [1, 2] });
		const cells = [{ lat: -33.72, lon: 21.27 }];
		const ahead = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells } });
		expect(ahead.status).toBe(409);
		expect(ahead.body.details).toMatchObject({ code: 'series_takes_over', runSeries: 'Rainfall CHIRPS', targetName: '' });
		expect(ahead.body.error).toMatch(/the series without a name would take over from “Rainfall CHIRPS” \(2001-01-01 to 2001-01-02\)/);
		const after = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells }, targetName: 'Rainfall CHIRPS 2' });
		expect(after.status, JSON.stringify(after.body)).toBe(201);
		const moved = await owner.call('PATCH', `/projects/${pid}/feeds/${after.body.feed.id}`, { targetName: 'CHIRPS feed' });
		expect(moved.status).toBe(409);
		expect(moved.body.details).toMatchObject({ code: 'series_takes_over' });
		// Another kind's series don't count: a forecast feed into the default name is fine.
		expect((await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps_gefs', config: { cells } })).status).toBe(201);
	});
});
