// Renaming a series (issue #556): PATCH …/series/:id { name }, as an editor,
// unique among the project's series of one kind, logged as series.renamed.
// Refused for a series a data feed or an API key writes into by its name.
import { describe, expect, it } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Meta = { id: string; kind: string; name: string; updatedAt: string; source: string | null };

async function project(u: User, name: string) {
	return (await u.call('POST', '/projects', { name })).body.project.id as string;
}
const put = async (u: User, pid: string, body: Record<string, unknown>) => {
	const r = await u.call('PUT', `/projects/${pid}/series`, { kind: 'flow_logger_m3s', unit: 'm³/s', startDate: '2013-04-01', values: [1, 2], ...body });
	expect(r.status, JSON.stringify(r.body)).toBe(200);
	return r.body as Meta;
};
const rename = (u: User, pid: string, id: string, name: unknown) => u.call('PATCH', `/projects/${pid}/series/${id}`, { name });
const names = async (u: User, pid: string) => ((await u.call('GET', `/projects/${pid}/series`)).body.series as Meta[]).map((s) => `${s.kind}:${s.name}`).sort();
const renames = async (pid: string) =>
	(await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'series.renamed' ORDER BY id`, [pid])).map((e) => e.subject);

describe('renaming a series', () => {
	it('an editor renames it; the values, source and updatedAt stay; viewers see the new name; logged once', async () => {
		const owner = await signUp('RenOwner');
		const editor = await signUp('RenEditor');
		const viewer = await signUp('RenViewer');
		const stranger = await signUp('RenStranger');
		const pid = await project(owner, 'Rename');
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const s = await put(owner, pid, { name: 'Logger A1 (Curr. Day)', source: 'Workbook column' });

		expect((await rename(viewer, pid, s.id, 'Drift Logger')).status).toBe(403);
		expect((await rename(stranger, pid, s.id, 'Drift Logger')).status).toBe(404);
		expect((await rename(editor, pid, '00000000-0000-4000-8000-000000000000', 'Drift Logger')).status).toBe(404);
		// Positive control: an editor renames it (trimmed); nothing else about the series changes.
		const r = await rename(editor, pid, s.id, '  Drift Logger ');
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body).toMatchObject({ id: s.id, name: 'Drift Logger', updatedAt: s.updatedAt, source: 'Workbook column' });
		expect((await owner.call('GET', `/projects/${pid}/series/${s.id}`)).body.values).toEqual([1, 2]);
		// RLS: a viewer reads the series under its new name.
		expect(await names(viewer, pid)).toEqual(['flow_logger_m3s:Drift Logger']);
		// The same name again changes and logs nothing.
		expect((await rename(editor, pid, s.id, 'Drift Logger')).status).toBe(200);
		expect(await renames(pid)).toEqual([{ seriesId: s.id, kind: 'flow_logger_m3s', name: 'Drift Logger', rename: { from: 'Logger A1 (Curr. Day)', to: 'Drift Logger' } }]);
		// The History tab lists it.
		const history = (await viewer.call('GET', `/projects/${pid}/history`)).body;
		expect(JSON.stringify(history)).toContain('series.renamed');
	});

	it('refuses an empty, too long or multi-line name, and a name another series of its kind has (409)', async () => {
		const owner = await signUp('RenUnique');
		const pid = await project(owner, 'Rename unique');
		const a = await put(owner, pid, { name: 'Weir' });
		await put(owner, pid, { name: 'Drift Logger' });
		// The same name at another kind is fine.
		const rain = await put(owner, pid, { kind: 'rain_catchment_mm', unit: 'mm', name: 'Rain' });
		for (const bad of ['', '   ', 'x'.repeat(101), 'a\nb', 7, null]) expect((await rename(owner, pid, a.id, bad)).status, String(bad)).toBe(400);
		const taken = await rename(owner, pid, a.id, 'Drift Logger');
		expect(taken.status).toBe(409);
		expect(taken.body.error).toBe('another series of this kind already has that name');
		expect((await rename(owner, pid, rain.id, 'Drift Logger')).status).toBe(200);
		expect(await names(owner, pid)).toEqual(['flow_logger_m3s:Drift Logger', 'flow_logger_m3s:Weir', 'rain_catchment_mm:Drift Logger']);
		expect((await renames(pid)).length).toBe(1);
	});

	it('refuses a series a data feed writes into by its name (409); a feed elsewhere doesn’t stop it', async () => {
		const owner = await signUp('RenFeed');
		const pid = await project(owner, 'Rename feed');
		const fed = await put(owner, pid, { kind: 'rain_chirps_mm', unit: 'mm', name: '', product: 'CHIRPS sat', productVersion: '3.0' });
		const other = await put(owner, pid, { kind: 'rain_chirps_mm', unit: 'mm', name: 'Older CHIRPS' });
		const feed = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', config: { cells: [{ lat: -33.72, lon: 21.27 }] } });
		expect(feed.status, JSON.stringify(feed.body)).toBe(201);
		const r = await rename(owner, pid, fed.id, 'CHIRPS');
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/data feed writes into this series/);
		expect((await rename(owner, pid, other.id, 'CHIRPS v2')).status).toBe(200);
		// Nor may a series take the name a feed writes to: the feed would write into it.
		const aimed = await owner.call('POST', `/projects/${pid}/feeds`, { source: 'chirps', targetName: 'Farm CHIRPS', config: { cells: [{ lat: -33.8, lon: 21.3 }] } });
		expect(aimed.status, JSON.stringify(aimed.body)).toBe(201);
		const into = await rename(owner, pid, other.id, 'Farm CHIRPS');
		expect(into.status).toBe(409);
		expect(into.body.error).toMatch(/data feed writes into a series of that name/);
	});

	it('a rename with another label in one PATCH saves both', async () => {
		const owner = await signUp('RenBoth');
		const pid = await project(owner, 'Rename both');
		const s = await put(owner, pid, { name: 'Logger' });
		const r = await owner.call('PATCH', `/projects/${pid}/series/${s.id}`, { name: 'Drift Logger', source: 'Farm file' });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body).toMatchObject({ name: 'Drift Logger', source: 'Farm file' });
	});

	it('refuses a series an API key has pushed days into (409)', async () => {
		const owner = await signUp('RenKey');
		const pid = await project(owner, 'Rename key');
		const s = await put(owner, pid, { kind: 'rain_catchment_mm', unit: 'mm', name: 'Weir rain', startDate: '2024-01-01', values: [null] });
		const key = await owner.call('POST', `/projects/${pid}/api-keys`, { name: 'Weir logger' });
		expect(key.status, JSON.stringify(key.body)).toBe(201);
		const pushed = await app.request('/ingest/v1/series/merge', {
			method: 'POST',
			headers: { authorization: `Bearer ${key.body.secret}`, 'content-type': 'application/json' },
			body: JSON.stringify({ kind: 'rain_catchment_mm', name: 'Weir rain', unit: 'mm', startDate: '2024-01-02', values: [3] })
		});
		expect(pushed.status, await pushed.clone().text()).toBe(200);
		const r = await rename(owner, pid, s.id, 'Rain at the weir');
		expect(r.status).toBe(409);
		expect(r.body.error).toMatch(/API key writes into this series/);
	});
});
