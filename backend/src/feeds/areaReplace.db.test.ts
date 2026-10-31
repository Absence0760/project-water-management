// A feed re-reading its whole record over new cells (296_feed_area_replace,
// feeds/routes.ts areaCheck, feeds/ingest.ts stageReplacement, series/replace.ts
// replaceFeedRecord), end to end on the fixtures: new cells under the feed's
// own days are refused without a confirmation (positive control: a feed whose
// series holds none of its days takes them); with one, the record backfills
// over the new cells into the stage while runs read the old record whole,
// then swaps in in one transaction (a failure in it leaves nothing half
// applied), replacing only the feed's own days and keeping a person's;
// withdrawing puts the old cells back; a reference ET feed's per-day product
// record (292) is rebuilt with the record; and the boundary's rain takes
// over the default series through the feed that writes it.
//
// DB test files run one at a time; like feeds.db.test.ts this file removes
// every feed, feed job and the shared cell cache after each test.
import { fromEpochDay, toEpochDay } from '@water-management/engine/calendar';
import { afterEach, describe, expect, it } from 'vitest';
import { et0FixtureValue, ET0_FIXTURE_HOLDS } from '../../scripts/et0-fixture.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { runTick } from '../jobs/runner.js';
import { et0FeedDays } from '../runs/execute.js';
import { utcToday } from './fetch.js';
import { FIXTURE_CELL } from './fixtures.js';
import { ET0_FIXTURE } from './fromMirrorEt0.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(async () => {
	await asOwner('DROP TRIGGER IF EXISTS test_refuse_replace ON audit_event');
	await asOwner('DROP FUNCTION IF EXISTS test_refuse_replace()');
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
	await asOwner('DELETE FROM chirps_cell_year');
	await asOwner('DELETE FROM chirps_file');
	await asOwner('DELETE FROM chirps_cell_stale');
});

const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const home = () => ({ ...FIXTURE_CELL(), weight: 1 });
/** The fixture grid's cell east of the home cell: another area, with other values. */
const east = () => ({ lat: FIXTURE_CELL().lat, lon: Number((FIXTURE_CELL().lon + 0.05).toFixed(9)), weight: 1 });

async function project(owner: User, name = 'Area replacement') {
	return (await owner.call('POST', '/projects', { name })).body.project.id as string;
}
/** Run the feed's fetches until it is caught up (Run now pulls each next window forward). */
async function catchUp(owner: User, pid: string, feedId: string, max = 4) {
	for (let i = 0; i < max; i++) {
		const r = await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		if (r.status !== 200 && r.status !== 202) break;
		await tick();
		const left = await asOwner(`SELECT id FROM job WHERE kind = 'feed_fetch' AND payload->>'feedId' = $1 AND status IN ('queued', 'failed')`, [feedId]);
		if (!left.length) return;
	}
}
const row = async (pid: string, kind: string, name: string) =>
	(
		await asOwner(
			`SELECT id, to_char(start_date, 'YYYY-MM-DD') AS "startDate", "values", feed_id AS "feedId", feed_days::text AS "feedDays", hand_days::text AS "handDays",
				feed_agera5_days::text AS agera5, feed_power_days::text AS power
			 FROM time_series WHERE project_id = $1 AND kind = $2 AND name = $3`,
			[pid, kind, name]
		)
	)[0] as { id: string; startDate: string; values: (number | null)[]; feedId: string | null; feedDays: string | null; handDays: string | null; agera5: string | null; power: string | null };
const feedState = async (feedId: string) =>
	(await asOwner('SELECT replace_series_from AS "from", replace_config_from AS "configFrom", config FROM data_feed WHERE id = $1', [feedId]))[0] as {
		from: string | null;
		configFrom: Record<string, unknown> | null;
		config: Record<string, unknown>;
	};
const stage = (feedId: string) => asOwner(`SELECT to_char(start_date, 'YYYY-MM-DD') AS start, cardinality("values") AS n FROM feed_stage WHERE feed_id = $1`, [feedId]);

/** A CHIRPS feed over the home cell into the default series, caught up over its last 150 days. */
async function homeFeed(name: string) {
	const owner = await signUp(name);
	const pid = await project(owner);
	const r = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [home()], startDate: addDays(-150) } });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	const feedId = r.body.feed.id as string;
	await catchUp(owner, pid, feedId);
	const s = await row(pid, 'rain_chirps_mm', '');
	expect(s.feedId).toBe(feedId);
	expect(s.values.filter((v) => v !== null).length).toBeGreaterThan(100);
	return { owner, pid, feedId, first: s.startDate };
}

describe('new cells under a feed’s record (296)', () => {
	it('are refused without a confirmation; confirmed, the feed re-reads from its first own day, and a later start date is refused', async () => {
		const { owner, pid, feedId, first } = await homeFeed('AreaRefuse');
		const before = await feedState(feedId);
		const refused = await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { config: { cells: [east()] } });
		expect(refused.status).toBe(409);
		expect(refused.body).toMatchObject({ error: expect.stringMatching(/never splices two areas into one record/), details: { code: 'series_area' } });
		expect(await feedState(feedId)).toEqual(before);
		// A box over the same area is another area too (its own cells and weights).
		const late = await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { config: { cells: [east()], startDate: addDays(-10) }, replaceSeries: true });
		expect(late.status).toBe(409);
		expect(late.body.details).toMatchObject({ code: 'series_backfill', firstDay: first });

		const ok = await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { config: { cells: [east()] }, replaceSeries: true });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect(ok.body.feed).toMatchObject({ replaceFrom: 'area:CHIRPS sat/3.0', versionConflict: false, config: { cells: [east()], startDate: first } });
		expect((await feedState(feedId)).configFrom).toEqual(before.config);
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'feed.configured' ORDER BY id DESC LIMIT 1`, [pid]);
		expect(ev.subject).toMatchObject({ feedId, action: 'changed', replaceSeries: 'area:CHIRPS sat/3.0' });
		// A save that leaves the pending cells as they are keeps the confirmation.
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { enabled: true })).body.feed).toMatchObject({ replaceFrom: 'area:CHIRPS sat/3.0' });

		// Positive control: a feed whose series holds none of its own days takes new cells without asking.
		const other = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [home()] }, targetName: 'Zz empty' });
		const moved = await owner.call('PATCH', `/projects/${pid}/feeds/${other.body.feed.id}`, { config: { cells: [east()] } });
		expect(moved.status).toBe(200);
		expect(moved.body.feed).toMatchObject({ replaceFrom: null, config: { cells: [east()] } });
	});

	it('withdrawing puts the old cells back and discards the stage; putting the old cells back withdraws it too', async () => {
		const { owner, pid, feedId } = await homeFeed('AreaWithdraw');
		const old = (await feedState(feedId)).config;
		await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { config: { cells: [east()] }, replaceSeries: true });
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		await tick();
		expect(await stage(feedId)).toHaveLength(1);
		const w = await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { replaceSeries: false });
		expect(w.status).toBe(200);
		expect(w.body.feed).toMatchObject({ replaceFrom: null, rebuilding: null });
		expect(await feedState(feedId)).toEqual({ from: null, configFrom: null, config: old });
		expect(await stage(feedId)).toEqual([]);
		// Withdrawing onto another new area is refused: it would splice.
		await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { config: { cells: [east()] }, replaceSeries: true });
		const onto = await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { config: { cells: [{ ...east(), weight: 2 }, home()] }, replaceSeries: false });
		expect(onto.status).toBe(409);
		// Saving the old cells back (no replaceSeries) withdraws it.
		const back = await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { config: old });
		expect(back.status).toBe(200);
		expect(back.body.feed).toMatchObject({ replaceFrom: null, config: { cells: [home()] } });
		expect((await feedState(feedId)).configFrom).toBeNull();
	});

	it('stages the record while runs read the old one whole, then swaps it in: the feed’s days are the new area’s, a person’s days stay, the old values are a revision', async () => {
		const { owner, pid, feedId, first } = await homeFeed('AreaSwap');
		const old = await row(pid, 'rain_chirps_mm', '');
		// A person's days: one merged (released from the feed, 031) and one edited by hand (212).
		const merged = addDays(-100);
		const hand = addDays(-90);
		expect((await owner.call('POST', `/projects/${pid}/series/merge`, { kind: 'rain_chirps_mm', name: '', unit: 'mm', startDate: merged, values: [77] })).status).toBe(200);
		expect((await owner.call('PUT', `/projects/${pid}/series/${old.id}/days/${hand}`, { value: 88 })).status).toBe(200);
		const withPerson = await row(pid, 'rain_chirps_mm', '');
		const at = (s: { startDate: string; values: (number | null)[] }, day: string) => s.values[toEpochDay(day) - toEpochDay(s.startDate)] ?? null;

		await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { config: { cells: [east()] }, replaceSeries: true });
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		expect((await tick()).done).toBe(1);
		// Window 1 is staged; the live series, and so a run, is the old record with the person's days, whole.
		expect(await stage(feedId)).toEqual([{ start: first, n: 120 }]);
		expect((await row(pid, 'rain_chirps_mm', '')).values).toEqual(withPerson.values);
		const feed = (await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds.find((f: { id: string }) => f.id === feedId);
		expect(feed).toMatchObject({ replaceFrom: 'area:CHIRPS sat/3.0', rebuilding: { startDate: first }, health: { reason: { code: 'rebuilding' } } });
		expect(await asOwner(`SELECT id FROM series_revision WHERE project_id = $1 AND reason = 'feed_replace'`, [pid])).toEqual([]);

		// The control: the east cell's own record, read by a feed of its own into another series.
		const control = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [east()], startDate: first }, targetName: 'Zz control' });
		await catchUp(owner, pid, control.body.feed.id as string);
		const want = await row(pid, 'rain_chirps_mm', 'Zz control');

		await catchUp(owner, pid, feedId);
		const now = await row(pid, 'rain_chirps_mm', '');
		expect(await stage(feedId)).toEqual([]);
		expect(await feedState(feedId)).toMatchObject({ from: null, configFrom: null });
		// Every day but the person's is the new area's, as the control read it.
		const end = fromEpochDay(toEpochDay(want.startDate) + want.values.length - 1);
		let compared = 0;
		for (let d = toEpochDay(first); d <= toEpochDay(end); d++) {
			const day = fromEpochDay(d);
			if (day === merged || day === hand) continue;
			expect(at(now, day), day).toBe(at(want, day));
			compared++;
		}
		expect(compared).toBeGreaterThan(100);
		expect(at(want, merged)).not.toBeNull();
		expect(at(now, merged)).toBe(77);
		expect(at(now, hand)).toBe(88);
		// The person's days are not the feed's; the hand edit is still marked (212).
		expect(now.feedId).toBe(feedId);
		expect(now.feedDays).toContain(`${first},${merged})`);
		expect(now.feedDays).toContain(`${addDays(-99)},${hand})`);
		expect(now.handDays).toBe(`{[${hand},${addDays(-89)})}`);
		// The old record is kept as one feed_replace revision, and the history says the feed re-read it over new cells.
		const revs = await asOwner(`SELECT reason, "values" FROM series_revision WHERE project_id = $1 AND reason = 'feed_replace'`, [pid]);
		expect(revs).toHaveLength(1);
		expect(revs[0].values).toEqual(withPerson.values);
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'series.replaced' ORDER BY id DESC LIMIT 1`, [pid]);
		expect(ev.subject).toMatchObject({ feedId, source: 'chirps', area: true });
		expect((await asOwner('SELECT last_meta FROM data_feed WHERE id = $1', [feedId]))[0].last_meta).toMatchObject({ replaced: 'area' });
	});

	it('a swap that fails part way leaves nothing applied: the series, the stage and the confirmation are as they were, and the retry swaps', async () => {
		const { owner, pid, feedId } = await homeFeed('AreaAtomic');
		const before = await row(pid, 'rain_chirps_mm', '');
		await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { config: { cells: [east()] }, replaceSeries: true });
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		await tick();
		const staged = await stage(feedId);
		expect(staged).toHaveLength(1);
		// The swap's last step (its series.replaced event) fails, after the series row was written.
		await asOwner(`CREATE FUNCTION test_refuse_replace() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$`);
		await asOwner(`CREATE TRIGGER test_refuse_replace BEFORE INSERT ON audit_event FOR EACH ROW WHEN (NEW.kind = 'series.replaced') EXECUTE FUNCTION test_refuse_replace()`);
		await owner.call('POST', `/projects/${pid}/feeds/${feedId}/run-now`);
		const failed = await tick();
		expect(failed.done).toBe(0);
		expect(await row(pid, 'rain_chirps_mm', '')).toEqual(before);
		expect(await stage(feedId)).toEqual(staged);
		expect((await feedState(feedId)).from).toBe('area:CHIRPS sat/3.0');
		expect(await asOwner(`SELECT id FROM series_revision WHERE project_id = $1 AND reason = 'feed_replace'`, [pid])).toEqual([]);

		await asOwner('DROP TRIGGER test_refuse_replace ON audit_event');
		await catchUp(owner, pid, feedId);
		expect(await stage(feedId)).toEqual([]);
		expect((await feedState(feedId)).from).toBeNull();
		expect((await row(pid, 'rain_chirps_mm', '')).values).not.toEqual(before.values);
	});

	it('the boundary’s rain takes over the default series through the feed that writes it', async () => {
		const { owner, pid, feedId, first } = await homeFeed('AreaBoundary');
		const ring = [
			[21.21, -33.79],
			[21.33, -33.79],
			[21.33, -33.69],
			[21.21, -33.69],
			[21.21, -33.79]
		];
		const b = (await owner.call('POST', `/projects/${pid}/map/features`, { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: [ring] } })).body.feature;
		const at = `/projects/${pid}/feeds/chirps/from-boundary`;
		const p = (await owner.call('GET', at)).body;
		expect(p.replace).toEqual({ available: true, targetName: '', product: 'sat', startDate: first, feedId, area: true });
		const r = await owner.call('POST', at, { featureId: b.id, updatedAt: b.updatedAt, replace: true });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body.feed).toMatchObject({ id: feedId, targetName: '', replaceFrom: 'area:CHIRPS sat/3.0', config: { boundary: { featureId: b.id }, startDate: first } });
		expect(r.body.feed.config.cells).toHaveLength(9);
		expect((await feedState(feedId)).configFrom).toMatchObject({ cells: [home()] });
		// No second feed: the default series stays the one runs read, and is rebuilt in place.
		expect((await owner.call('GET', `/projects/${pid}/feeds`)).body.feeds).toHaveLength(1);
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'feed.configured' ORDER BY id DESC LIMIT 1`, [pid]);
		expect(ev.subject).toMatchObject({ feedId, action: 'changed', boundary: { featureId: b.id }, cells: 9, replaceSeries: 'area:CHIRPS sat/3.0' });
	});
});

describe('a reference ET feed’s record over new cells (296)', () => {
	const { y0, x0 } = ET0_FIXTURE.block;
	/** 0.05° cell centres inside two of the fixture block's 0.1° cells. */
	const A = { lat: -35.5 + (y0 + 1) * 0.1 + 0.025, lon: 10 + (x0 + 2) * 0.1 + 0.025, weight: 1 };
	const B = { lat: -35.5 + (y0 + 2) * 0.1 + 0.025, lon: 10 + (x0 + 1) * 0.1 + 0.025, weight: 1 };
	const round2 = (v: number) => Math.round(v * 100) / 100;

	it('swaps in the new area’s values and rebuilds which product wrote each day (292)', async () => {
		// Fixtures mode (the default): the committed copy, re-dated to today.
		const shift = toEpochDay(utcToday()) - toEpochDay(ET0_FIXTURE.today);
		const owner = await signUp('AreaEt0');
		const pid = await project(owner);
		const feedId = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'agera5_et0', config: { cells: [A] } })).body.feed.id as string;
		await catchUp(owner, pid, feedId);
		// Caught up in one fetch: an ET feed's window ends yesterday, and nothing more is queued (before 296 one was, every minute).
		expect(await asOwner(`SELECT id FROM job WHERE kind = 'feed_fetch' AND payload->>'feedId' = $1 AND status = 'queued'`, [feedId])).toEqual([]);
		const before = await row(pid, 'evap_et0_mm', '');
		const last = fromEpochDay(toEpochDay(before.startDate) + before.values.length - 1);
		const agera5Through = fromEpochDay(toEpochDay(ET0_FIXTURE_HOLDS.agera5.finalThrough) + shift);
		const powerFrom = fromEpochDay(toEpochDay(agera5Through) + 1);
		// A person's day on the newest (POWER's) days: kept through the swap, and no product's.
		const mine = last;
		expect((await owner.call('POST', `/projects/${pid}/series/merge`, { kind: 'evap_et0_mm', name: '', unit: 'mm', startDate: mine, values: [9.5] })).status).toBe(200);
		const powerTo = fromEpochDay(toEpochDay(mine) - 1);

		const ok = await owner.call('PATCH', `/projects/${pid}/feeds/${feedId}`, { config: { cells: [B] }, replaceSeries: true });
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect(ok.body.feed).toMatchObject({ replaceFrom: 'area:', config: { startDate: before.startDate } });
		await catchUp(owner, pid, feedId);
		expect(await stage(feedId)).toEqual([]);

		const now = await row(pid, 'evap_et0_mm', '');
		const value = (day: string) => now.values[toEpochDay(day) - toEpochDay(now.startDate)];
		const fixtureDay = (day: string) => fromEpochDay(toEpochDay(day) - shift);
		expect(value(agera5Through)).toBe(round2(et0FixtureValue(fixtureDay(agera5Through), 2, 1, 'agera5')));
		expect(value(powerFrom)).toBe(round2(et0FixtureValue(fixtureDay(powerFrom), 2, 1, 'power')));
		expect(value(agera5Through)).not.toBe(before.values[toEpochDay(agera5Through) - toEpochDay(before.startDate)]);
		expect(value(mine)).toBe(9.5);
		// The product record, rebuilt with the record: AgERA5 to its last day, POWER after, the person's day neither's.
		expect(await withUser(owner.id, (db) => et0FeedDays(db, now.id))).toEqual({
			agera5: [[now.startDate, agera5Through]],
			power: [[powerFrom, powerTo]],
			unrecorded: []
		});
	});
});
