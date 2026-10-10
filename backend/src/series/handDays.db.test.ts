// Setting or clearing one day of a series by hand (issue #477; PUT
// /projects/:id/series/:seriesId/days/:date, 212_series_hand_days.sql). It
// goes through the merge path (series/merge.ts mergeInto): unit conversion,
// the row lock, a series revision and series.merged in the history. The day
// is marked as edited by hand: a person's upload or paste that writes it
// releases the mark, a replace releases all, a restore puts them back, and an
// API key's ingest (like a data feed) never writes over it.
import { describe, expect, it } from 'vitest';
import { anon, app, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Meta = { id: string; handDays: [string, string][] | null; rerunQueuedFor?: string | null };

const flow = (startDate: string, values: (number | null)[], unit = 'm³/s') => ({ kind: 'flow_observed_m3s', unit, startDate, values });

async function setup(name: string) {
	const u = await signUp(name);
	const p = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const s = await u.call('PUT', `/projects/${p}/series`, flow('2021-10-01', [1.2, 0.8, 0.6, 0.4]));
	expect(s.status, JSON.stringify(s.body)).toBe(200);
	return { u, p, sid: s.body.id as string };
}
const setDay = (u: User, p: string, sid: string, date: string, body: unknown) => u.call('PUT', `/projects/${p}/series/${sid}/days/${date}`, body);
const values = async (u: User, p: string, sid: string) => (await u.call('GET', `/projects/${p}/series/${sid}`)).body.values as (number | null)[];
const meta = async (u: User, p: string, sid: string) => ((await u.call('GET', `/projects/${p}/series`)).body.series as Meta[]).find((s) => s.id === sid)!;
const history = async (u: User, p: string) =>
	(await u.call('GET', `/projects/${p}/history?kind=series.merged`)).body.items as { subject: Record<string, unknown> }[];

describe('a day edited by hand', () => {
	it('sets the day, converted from the unit given, marks it, and keeps the old values as a revision', async () => {
		const { u, p, sid } = await setup('HandSet');
		const r = await setDay(u, p, sid, '2021-10-02', { value: 650, unit: 'l/s' });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body).toMatchObject({ id: sid, handDays: [['2021-10-02', '2021-10-02']] });
		expect('rerunQueuedFor' in r.body).toBe(true);
		expect((await values(u, p, sid)).map((v) => (v === null ? null : Math.round(v * 1e6) / 1e6))).toEqual([1.2, 0.65, 0.6, 0.4]);
		// In the history like a merge: one day changed, by hand, with a revision to restore.
		const h = await history(u, p);
		expect(h[0]!.subject).toMatchObject({ seriesId: sid, daysChanged: 1, entry: 'hand', date: '2021-10-02' });
		expect(h[0]!.subject.revisionId).toBeTruthy();
		// The series' own unit when none is given; neighbouring edits join into one range.
		expect((await setDay(u, p, sid, '2021-10-03', { value: 0.5 })).body.handDays).toEqual([['2021-10-02', '2021-10-03']]);
		expect((await values(u, p, sid))[2]).toBe(0.5);
	});

	it('clears a day with null, and the cleared day stays marked', async () => {
		const { u, p, sid } = await setup('HandClear');
		const r = await setDay(u, p, sid, '2021-10-04', { value: null });
		expect(r.status).toBe(200);
		expect(await values(u, p, sid)).toEqual([1.2, 0.8, 0.6, null]);
		expect((await meta(u, p, sid)).handDays).toEqual([['2021-10-04', '2021-10-04']]);
	});

	it('records nothing when the value is what the day already holds', async () => {
		const { u, p, sid } = await setup('HandSame');
		expect((await setDay(u, p, sid, '2021-10-01', { value: 1.2 })).body.handDays).toBeNull();
		expect(await history(u, p)).toHaveLength(0);
	});

	it('refuses a day outside the series, a bad date, a negative, an unknown unit and other fields', async () => {
		const { u, p, sid } = await setup('HandBad');
		const outside = await setDay(u, p, sid, '2021-10-05', { value: 1 });
		expect(outside.status).toBe(400);
		expect(outside.body.error).toContain('2021-10-01 to 2021-10-04');
		expect((await setDay(u, p, sid, '2021-09-30', { value: 1 })).status).toBe(400);
		expect((await setDay(u, p, sid, '2021-02-30', { value: 1 })).status).toBe(400);
		expect((await setDay(u, p, sid, '02-10-2021', { value: 1 })).status).toBe(400);
		expect((await setDay(u, p, sid, '2021-10-02', { value: -1 })).status).toBe(400);
		expect((await setDay(u, p, sid, '2021-10-02', { value: 1, unit: 'furlongs' })).status).toBe(400);
		expect((await setDay(u, p, sid, '2021-10-02', { value: 1, kind: 'rain_catchment_mm' })).status).toBe(400);
		expect((await setDay(u, p, sid, '2021-10-02', {})).status).toBe(400);
		// Too large once converted (the upload's own check, toCanonicalUnit).
		expect((await setDay(u, p, sid, '2021-10-02', { value: 1e12, unit: 'm³/s' })).status).toBe(400);
		expect(await values(u, p, sid)).toEqual([1.2, 0.8, 0.6, 0.4]);
		expect(await history(u, p)).toHaveLength(0);
	});

	it('needs an editor: a viewer is refused, a stranger sees nothing, a signed-out caller is 401', async () => {
		const { u: owner, p, sid } = await setup('HandOwner');
		const editor = await signUp('HandEditor');
		const viewer = await signUp('HandViewer');
		const stranger = await signUp('HandStranger');
		expect((await owner.call('POST', `/projects/${p}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${p}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		expect((await setDay(viewer, p, sid, '2021-10-02', { value: 2 })).status).toBe(403);
		expect((await setDay(stranger, p, sid, '2021-10-02', { value: 2 })).status).toBe(404);
		expect((await anon('PUT', `/projects/${p}/series/${sid}/days/2021-10-02`, { value: 2 })).status).toBe(401);
		// A series of another project is not found, even for an editor of this one.
		const other = await setup('HandOther');
		expect((await setDay(owner, p, other.sid, '2021-10-02', { value: 2 })).status).toBe(404);
		expect((await setDay(owner, p, 'not-a-uuid', '2021-10-02', { value: 2 })).status).toBe(404);
		expect(await values(owner, p, sid)).toEqual([1.2, 0.8, 0.6, 0.4]);
		// Positive controls: an editor member may edit, and a viewer reads the value and its mark (RLS lets both through).
		expect((await setDay(editor, p, sid, '2021-10-02', { value: 2 })).status).toBe(200);
		expect((await values(viewer, p, sid))[1]).toBe(2);
		expect((await meta(viewer, p, sid)).handDays).toEqual([['2021-10-02', '2021-10-02']]);
		// The stranger still reads nothing of it.
		expect((await stranger.call('GET', `/projects/${p}/series/${sid}`)).status).toBe(404);
	});

	it("is released by a person's upload or paste that writes the day, and kept where it leaves the day blank", async () => {
		const { u, p, sid } = await setup('HandRelease');
		await setDay(u, p, sid, '2021-10-02', { value: 5 });
		await setDay(u, p, sid, '2021-10-04', { value: 6 });
		// A merge (the upload form, and a paste: the same request) with a value on 10-02 and a blank on 10-04.
		expect((await u.call('POST', `/projects/${p}/series/merge`, flow('2021-10-02', [0.9, null, null]))).status).toBe(200);
		expect(await values(u, p, sid)).toEqual([1.2, 0.9, 0.6, 6]);
		expect((await meta(u, p, sid)).handDays).toEqual([['2021-10-04', '2021-10-04']]);
		// A replace is new values throughout: no mark left.
		expect((await u.call('PUT', `/projects/${p}/series`, flow('2021-10-01', [1, 1]))).body.handDays).toBeNull();
	});

	it('is never written over by an API key’s ingest', async () => {
		const { u, p, sid } = await setup('HandKey');
		await setDay(u, p, sid, '2021-10-02', { value: 5 });
		await setDay(u, p, sid, '2021-10-03', { value: null });
		const secret = (await u.call('POST', `/projects/${p}/api-keys`, { name: 'Logger' })).body.secret as string;
		const r = await app.request('/ingest/v1/series/merge', {
			method: 'POST',
			headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
			body: JSON.stringify({ ...flow('2021-10-02', [0.7, 0.7, 0.7, 0.7]), name: '' })
		});
		expect(r.status).toBe(200);
		// The two hand days keep the person's value (and blank); the key's other days go in.
		expect(await values(u, p, sid)).toEqual([1.2, 5, null, 0.7, 0.7]);
		expect((await meta(u, p, sid)).handDays).toEqual([['2021-10-02', '2021-10-03']]);
	});

	it('comes back with the values a restore puts back', async () => {
		const { u, p, sid } = await setup('HandRestore');
		await setDay(u, p, sid, '2021-10-02', { value: 5 });
		// Replaced whole: the marks go, and the values before are kept as a revision.
		await u.call('PUT', `/projects/${p}/series`, flow('2021-10-01', [1, 1, 1, 1]));
		const revs = (await u.call('GET', `/projects/${p}/series/${sid}/revisions`)).body.revisions as { id: string }[];
		const r = await u.call('POST', `/projects/${p}/series/${sid}/revisions/${revs[0]!.id}/restore`, {});
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body.handDays).toEqual([['2021-10-02', '2021-10-02']]);
		expect(await values(u, p, sid)).toEqual([1.2, 5, 0.6, 0.4]);
		// And the revision of the hand edit itself (recorded after the merge wrote) holds the marks from before it: none.
		const older = revs.at(-1)!;
		const back = await u.call('POST', `/projects/${p}/series/${sid}/revisions/${older.id}/restore`, {});
		expect(back.body.handDays).toBeNull();
		expect(await values(u, p, sid)).toEqual([1.2, 0.8, 0.6, 0.4]);
	});

	it('goes with a copy, the exported document and an import, which refuses a backwards range', async () => {
		const { u, p, sid } = await setup('HandCopy');
		await setDay(u, p, sid, '2021-10-02', { value: 5 });
		await setDay(u, p, sid, '2021-10-03', { value: null });
		const want = [['2021-10-02', '2021-10-03']];
		const copy = await u.call('POST', `/projects/${p}/copy`, { name: 'Hand copy' });
		expect(copy.status).toBe(201);
		const copied = (await u.call('GET', `/projects/${copy.body.project.id}/series`)).body.series as Meta[];
		expect(copied[0]!.handDays).toEqual(want);
		const doc = (await u.call('GET', `/projects/${p}/export.json`)).body as { series: Record<string, unknown>[] };
		expect(doc.series[0]!.handDays).toEqual(want);
		const imported = await u.call('POST', '/projects/import', { ...doc, name: 'Hand imported' });
		expect(imported.status, JSON.stringify(imported.body)).toBe(201);
		const again = (await u.call('GET', `/projects/${imported.body.project.id}/export.json`)).body as { series: Record<string, unknown>[] };
		expect(again.series).toEqual(doc.series);
		const backwards = { ...doc, name: 'Hand bad', series: [{ ...doc.series[0], handDays: [['2021-10-03', '2021-10-02']] }] };
		expect((await u.call('POST', '/projects/import', backwards)).status).toBe(400);
		// A series without marks exports without the key.
		const bare = (await u.call('POST', '/projects', { name: 'Hand bare' })).body.project.id as string;
		await u.call('PUT', `/projects/${bare}/series`, flow('2021-10-01', [1]));
		expect('handDays' in ((await u.call('GET', `/projects/${bare}/export.json`)).body.series[0] as object)).toBe(false);
	});
});
