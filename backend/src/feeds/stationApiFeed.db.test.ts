// A station API feed's routes and its key (issue #784; 321_feed_source_station_api.sql): attach with a key, replace
// it, clear it; the key never comes back in an answer or the history; data_feed_credential's RLS (owners write,
// editors read, viewers can't, with positive controls); its trigger (the feed's own project, a station API feed); a
// key change keeps the feed's progress; the server switch; and the job's row carrying the sealed key.
//
// DB test files run one at a time; afterEach removes every feed, so no other file's tick finds one due.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { openFeedCredential } from './credential.js';
import { CREDENTIAL_MISSING_WARNING, STATION_API_OFF_MESSAGE } from './routes.js';
import { feedForJob } from './store.js';

type User = Awaited<ReturnType<typeof signUp>>;

afterEach(async () => {
	vi.unstubAllEnvs();
	await asOwner('DELETE FROM data_feed');
	await asOwner(`DELETE FROM job WHERE kind IN ('feed_fetch', 'feed_ingest')`);
});

const SECRET = 'station-secret-0123456789-wxyz';
const OTHER_SECRET = 'replacement-secret-9876543210-abcd';
const format = { format: 'json', records: 'data', time: 't', value: 'rain', timeFormat: 'iso', resolution: 'daily' };
const config = (over: Record<string, unknown> = {}) => ({
	url: 'https://api.example.com/v1/stations/{station}/rain?from={start}&to={end}',
	station: 'ST-1',
	auth: { kind: 'header', name: 'X-Station-Key' },
	format,
	...over
});
const station = (over: Record<string, unknown> = {}) => ({ source: 'station_api', config: config(), enabled: false, ...over });

async function project(owner: User, name = 'Station feeds') {
	return (await owner.call('POST', '/projects', { name })).body.project.id as string;
}
async function member(owner: User, pid: string, u: User, role: 'viewer' | 'editor' | 'owner') {
	expect((await owner.call('POST', `/projects/${pid}/members`, { email: u.email, role })).status).toBe(201);
}
const sealedOf = async (feedId: string) => ((await asOwner('SELECT sealed FROM data_feed_credential WHERE feed_id = $1', [feedId]))[0]?.sealed ?? null) as string | null;
/** No answer, audit event or feed config holds the secret or the sealed bytes. */
function expectNoKey(what: unknown, ...secrets: (string | null)[]) {
	const text = JSON.stringify(what);
	for (const s of secrets) if (s) expect(text).not.toContain(s);
}

describe('station API feed: attach, replace and clear its key', () => {
	it('an owner attaches a feed with a key, replaces it and clears it; answers and the history never carry it', async () => {
		const owner = await signUp('StationOwner');
		const viewer = await signUp('StationViewer');
		const pid = await project(owner);
		await member(owner, pid, viewer, 'viewer');

		const created = await owner.call('POST', `/projects/${pid}/feeds`, station({ credential: { secret: SECRET } }));
		expect(created.status).toBe(201);
		const fid = created.body.feed.id as string;
		expect(created.body.feed).toMatchObject({ source: 'station_api', targetKind: 'rain_catchment_mm', credential: { saved: true, hint: 'wxyz' } });
		expect(created.body.feed.credential.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(created.body.warning).toBeUndefined();
		const sealed1 = await sealedOf(fid);
		expect(sealed1).toBeTruthy();
		// Sealed to the fetcher, bound to this feed: it opens to the key with the private key and the feed's id.
		expect(openFeedCredential(sealed1!, fid)).toEqual({ secret: SECRET });
		expectNoKey(created.body, SECRET, sealed1);

		// The list: the owner sees the hint; a viewer sees that a key is saved, not its hint.
		const ownerList = await owner.call('GET', `/projects/${pid}/feeds`);
		expect(ownerList.body.feeds[0].credential).toMatchObject({ saved: true, hint: 'wxyz' });
		const viewerList = await viewer.call('GET', `/projects/${pid}/feeds`);
		expect(viewerList.status).toBe(200);
		expect(viewerList.body.feeds[0].credential).toMatchObject({ saved: true, hint: null });
		expectNoKey([ownerList.body, viewerList.body], SECRET, sealed1);

		// Replace: a new sealed value; the config is untouched.
		const replaced = await owner.call('PATCH', `/projects/${pid}/feeds/${fid}`, { credential: { secret: OTHER_SECRET } });
		expect(replaced.status).toBe(200);
		expect(replaced.body.feed.credential).toMatchObject({ saved: true, hint: 'abcd' });
		const sealed2 = await sealedOf(fid);
		expect(sealed2).not.toBe(sealed1);
		expect(openFeedCredential(sealed2!, fid)).toEqual({ secret: OTHER_SECRET });
		expectNoKey(replaced.body, SECRET, OTHER_SECRET, sealed1, sealed2);

		// Clear: none saved, and the answer says the feed's auth needs one.
		const cleared = await owner.call('PATCH', `/projects/${pid}/feeds/${fid}`, { credential: null });
		expect(cleared.status).toBe(200);
		expect(cleared.body.feed.credential).toEqual({ saved: false, hint: null, updatedAt: null });
		expect(cleared.body.warning).toBe(CREDENTIAL_MISSING_WARNING);
		expect(await sealedOf(fid)).toBeNull();

		// The history: what happened to the key, never the key.
		const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'feed.configured' ORDER BY id`, [pid]);
		expect(events.map((e) => (e.subject as { credential?: string }).credential)).toEqual(['saved', 'replaced', 'cleared']);
		expectNoKey(events, SECRET, OTHER_SECRET, sealed1, sealed2);
		const history = await owner.call('GET', `/projects/${pid}/history`);
		expectNoKey(history.body, SECRET, OTHER_SECRET, sealed1, sealed2);
		// Nor the feed's own row.
		expectNoKey(await asOwner('SELECT * FROM data_feed WHERE id = $1', [fid]), SECRET, OTHER_SECRET);
	});

	it('a feed whose auth sends a key may be saved without one, and the answer says so; a short key keeps no hint', async () => {
		const owner = await signUp('StationNoKey');
		const pid = await project(owner);
		const res = await owner.call('POST', `/projects/${pid}/feeds`, station());
		expect(res.status).toBe(201);
		expect(res.body.feed.credential).toEqual({ saved: false, hint: null, updatedAt: null });
		expect(res.body.warning).toBe(CREDENTIAL_MISSING_WARNING);
		const short = await owner.call('PATCH', `/projects/${pid}/feeds/${res.body.feed.id}`, { credential: { secret: 'short-key' } });
		expect(short.body.feed.credential).toMatchObject({ saved: true, hint: null });
		expect(short.body.warning).toBeUndefined();
		// Auth that sends nothing: no warning, and no key accepted.
		const none = await owner.call('POST', `/projects/${pid}/feeds`, station({ config: config({ auth: { kind: 'none' } }), targetName: 'Open' }));
		expect(none.status).toBe(201);
		expect(none.body.warning).toBeUndefined();
		const refused = await owner.call('PATCH', `/projects/${pid}/feeds/${none.body.feed.id}`, { credential: { secret: SECRET } });
		expect(refused.status).toBe(400);
		expect(refused.body.details[0]).toMatchObject({ path: ['credential'] });
		expect(refused.body.details[0].message).toMatch(/sends no key/);
		expectNoKey(refused.body, SECRET);
	});

	it('refuses a key on another source, and clearing one there; a feed moved to sending no key drops its key', async () => {
		const owner = await signUp('StationOther');
		const pid = await project(owner);
		const chirps = { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] }, enabled: false };
		const withKey = await owner.call('POST', `/projects/${pid}/feeds`, { ...chirps, credential: { secret: SECRET } });
		expect(withKey.status).toBe(400);
		expect(withKey.body.details[0]).toMatchObject({ path: ['credential'], message: 'only a weather station API feed keeps a key' });
		expectNoKey(withKey.body, SECRET);
		const plain = await owner.call('POST', `/projects/${pid}/feeds`, chirps);
		expect(plain.status).toBe(201);
		expect(plain.body.feed.credential).toBeUndefined();
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${plain.body.feed.id}`, { credential: { secret: SECRET } })).status).toBe(400);
		expect((await owner.call('PATCH', `/projects/${pid}/feeds/${plain.body.feed.id}`, { credential: null })).status).toBe(400);

		const st = await owner.call('POST', `/projects/${pid}/feeds`, station({ credential: { secret: SECRET } }));
		const fid = st.body.feed.id as string;
		const toNone = await owner.call('PATCH', `/projects/${pid}/feeds/${fid}`, { config: config({ auth: { kind: 'none' } }) });
		expect(toNone.status).toBe(200);
		expect(toNone.body.feed.credential).toEqual({ saved: false, hint: null, updatedAt: null });
		expect(await sealedOf(fid)).toBeNull();
		const [last] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'feed.configured' ORDER BY id DESC LIMIT 1`, [pid]);
		expect(last!.subject).toMatchObject({ action: 'changed', credential: 'cleared' });
	});

	it('editors and viewers cannot write a key, through the routes or the table', async () => {
		const owner = await signUp('StationOwner2');
		const editor = await signUp('StationEditor');
		const viewer = await signUp('StationViewer2');
		const pid = await project(owner);
		await member(owner, pid, editor, 'editor');
		await member(owner, pid, viewer, 'viewer');
		const fid = (await owner.call('POST', `/projects/${pid}/feeds`, station({ credential: { secret: SECRET } }))).body.feed.id as string;
		const before = await sealedOf(fid);

		for (const u of [editor, viewer]) {
			expect((await u.call('PATCH', `/projects/${pid}/feeds/${fid}`, { credential: { secret: OTHER_SECRET } })).status).toBe(403);
			expect((await u.call('PATCH', `/projects/${pid}/feeds/${fid}`, { credential: null })).status).toBe(403);
			expect((await u.call('POST', `/projects/${pid}/feeds`, station({ targetName: 'Mine', credential: { secret: OTHER_SECRET } }))).status).toBe(403);
			// Straight at the table: no update or delete lands, and no insert passes the policy.
			const n = await withUser(u.id, async (db) => {
				const up = await db.query(`UPDATE data_feed_credential SET sealed = 'x' WHERE feed_id = $1`, [fid]);
				const del = await db.query('DELETE FROM data_feed_credential WHERE feed_id = $1', [fid]);
				return (up.rowCount ?? 0) + (del.rowCount ?? 0);
			});
			expect(n).toBe(0);
			await expect(withUser(u.id, (db) => db.query(`INSERT INTO data_feed_credential (feed_id, project_id, sealed) VALUES ($1, $2, 'x') ON CONFLICT DO NOTHING`, [fid, pid]))).rejects.toThrow(/row-level security/);
		}
		expect(await sealedOf(fid)).toBe(before);
	});
});

describe('data_feed_credential RLS and trigger', () => {
	it('viewers cannot read a key row; editors and owners can (positive control)', async () => {
		const owner = await signUp('CredOwner');
		const editor = await signUp('CredEditor');
		const viewer = await signUp('CredViewer');
		const stranger = await signUp('CredStranger');
		const pid = await project(owner);
		await member(owner, pid, editor, 'editor');
		await member(owner, pid, viewer, 'viewer');
		const fid = (await owner.call('POST', `/projects/${pid}/feeds`, station({ credential: { secret: SECRET } }))).body.feed.id as string;
		const count = (u: User) => withUser(u.id, async (db) => (await db.query('SELECT feed_id FROM data_feed_credential WHERE feed_id = $1', [fid])).rows.length);
		expect(await count(owner)).toBe(1);
		expect(await count(editor)).toBe(1);
		expect(await count(viewer)).toBe(0);
		expect(await count(stranger)).toBe(0);
		// The viewer still sees the feed itself (the control that the row exists for them to miss).
		expect(await withUser(viewer.id, async (db) => (await db.query('SELECT id FROM data_feed WHERE id = $1', [fid])).rows.length)).toBe(1);
	});

	it('refuses a key row naming another project’s feed, or a feed of another source', async () => {
		const owner = await signUp('CredCross');
		const a = await project(owner, 'A');
		const b = await project(owner, 'B');
		const fa = (await owner.call('POST', `/projects/${a}/feeds`, station())).body.feed.id as string;
		const ins = (feed: string, projectId: string) =>
			withUser(owner.id, (db) => db.query(`INSERT INTO data_feed_credential (feed_id, project_id, sealed) VALUES ($1, $2, 'sealed-bytes')`, [feed, projectId]));
		await expect(ins(fa, b)).rejects.toMatchObject({ code: '23503' });
		const chirps = (await owner.call('POST', `/projects/${a}/feeds`, { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] }, enabled: false })).body.feed.id as string;
		await expect(ins(chirps, a)).rejects.toMatchObject({ code: '23514' });
		// Positive control: the same insert for the feed's own project lands, stamped with who saved it.
		await ins(fa, a);
		expect(await asOwner('SELECT updated_by FROM data_feed_credential WHERE feed_id = $1', [fa])).toEqual([{ updated_by: owner.id }]);
	});
});

describe('station API feed: progress, the server switch, the URL and the job row', () => {
	it('changing the key keeps the feed’s progress', async () => {
		const owner = await signUp('CredProgress');
		const pid = await project(owner);
		const fid = (await owner.call('POST', `/projects/${pid}/feeds`, station({ credential: { secret: SECRET } }))).body.feed.id as string;
		await asOwner(`UPDATE data_feed SET last_data_date = '2026-10-01', last_value = 4.5, last_meta = '{"through":"2026-10-02"}' WHERE id = $1`, [fid]);
		const res = await owner.call('PATCH', `/projects/${pid}/feeds/${fid}`, { credential: { secret: OTHER_SECRET } });
		expect(res.status).toBe(200);
		expect(res.body.feed).toMatchObject({ lastDataDate: '2026-10-01', lastValue: 4.5 });
		const cleared = await owner.call('PATCH', `/projects/${pid}/feeds/${fid}`, { credential: null });
		expect(cleared.body.feed).toMatchObject({ lastDataDate: '2026-10-01' });
	});

	it('STATION_API_FEEDS off refuses attaching one (or moving a feed onto the source); a feed already attached can still change', async () => {
		const owner = await signUp('CredSwitch');
		const pid = await project(owner);
		const fid = (await owner.call('POST', `/projects/${pid}/feeds`, station())).body.feed.id as string;
		const chirps = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] }, enabled: false })).body.feed.id as string;
		for (const off of ['off', '']) {
			vi.stubEnv('STATION_API_FEEDS', off);
			expect((await owner.call('GET', `/projects/${pid}/feeds`)).body.stationApiFeeds).toBe(false);
			const refused = await owner.call('POST', `/projects/${pid}/feeds`, station({ targetName: 'Second' }));
			expect(refused).toMatchObject({ status: 400, body: { error: STATION_API_OFF_MESSAGE } });
			const moved = await owner.call('PATCH', `/projects/${pid}/feeds/${chirps}`, { source: 'station_api', config: config(), targetKind: 'rain_catchment_mm', targetName: 'Moved' });
			expect(moved).toMatchObject({ status: 400, body: { error: STATION_API_OFF_MESSAGE } });
		}
		const kept = await owner.call('PATCH', `/projects/${pid}/feeds/${fid}`, { credential: { secret: SECRET } });
		expect(kept.status).toBe(200);
		expect(kept.body.feed.credential.saved).toBe(true);
	});

	it('refuses a URL carrying a key, pointing at the key field', async () => {
		const owner = await signUp('CredUrl');
		const pid = await project(owner);
		const res = await owner.call('POST', `/projects/${pid}/feeds`, station({ config: config({ url: 'https://api.example.com/rain?api_key=abc123&from={start}' }) }));
		expect(res.status).toBe(400);
		expect(res.body.details[0].path).toEqual(['config', 'url']);
		expect(res.body.details[0].message).toMatch(/the URL carries a key \(api_key=…\).*key field/);
		expect(await asOwner('SELECT id FROM data_feed WHERE project_id = $1', [pid])).toEqual([]);
	});

	it('the job’s row carries the sealed key of a station API feed, and none for another source', async () => {
		const owner = await signUp('CredJob');
		const pid = await project(owner);
		const fid = (await owner.call('POST', `/projects/${pid}/feeds`, station({ credential: { secret: SECRET } }))).body.feed.id as string;
		const row = await withUser(owner.id, (db) => feedForJob(db, pid, fid));
		expect(row!.credential).toBe(await sealedOf(fid));
		expect(openFeedCredential(row!.credential!, fid)).toEqual({ secret: SECRET });
		// Another feed's id doesn't open it (the seal is bound to the feed).
		await expect(async () => openFeedCredential(row!.credential!, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(/could not be opened/);
		await owner.call('PATCH', `/projects/${pid}/feeds/${fid}`, { credential: null });
		expect((await withUser(owner.id, (db) => feedForJob(db, pid, fid)))!.credential).toBeNull();
		const chirps = (await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ lat: -20.12, lon: 25.17 }] }, enabled: false })).body.feed.id as string;
		expect((await withUser(owner.id, (db) => feedForJob(db, pid, chirps)))!.credential).toBeNull();
	});
});
