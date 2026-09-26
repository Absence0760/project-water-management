// A series says which product and version it holds (032_series_provenance.sql,
// issue #40 part c): set by an upload, an import or PATCH …/series/:id, kept
// by a merge, refused when a merge would splice two versions into one record,
// and carried by a project's copy and its exported document.
import { describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const V2 = { product: 'CHIRPS', productVersion: '2.0' };
const V3 = { product: 'CHIRPS sat', productVersion: '3.0' };

async function project(u: User, name: string) {
	return (await u.call('POST', '/projects', { name })).body.project.id as string;
}
const put = (u: User, pid: string, body: Record<string, unknown>) =>
	u.call('PUT', `/projects/${pid}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2001-01-01', values: [1, 2], ...body });
const merge = (u: User, pid: string, body: Record<string, unknown>) =>
	u.call('POST', `/projects/${pid}/series/merge`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2001-01-03', values: [3], ...body });
/** The CHIRPS series' label (by name). */
const label = async (u: User, pid: string, name = '') =>
	((await u.call('GET', `/projects/${pid}/series`)).body.series as { kind: string; name: string; product: string | null; productVersion: string | null }[])
		.filter((s) => s.kind === 'rain_chirps_mm' && s.name === name)
		.map((s) => ({ product: s.product, productVersion: s.productVersion }))[0];

describe('series provenance', () => {
	it('an upload says what it holds, or clears it: a replace describes the new values', async () => {
		const u = await signUp('ProvPut');
		const pid = await project(u, 'Prov');
		expect((await put(u, pid, V2)).body).toMatchObject(V2);
		expect(await label(u, pid)).toEqual(V2);
		// A replace that doesn't say leaves the new values unrecorded, not wrongly labelled v2.
		expect((await put(u, pid, {})).body).toMatchObject({ product: null, productVersion: null });
		// Both or neither, and the same character rules as the database CHECKs.
		expect((await put(u, pid, { product: 'CHIRPS' })).status).toBe(400);
		expect((await put(u, pid, { product: 'CHIRPS', productVersion: '' })).status).toBe(400);
		expect((await put(u, pid, { product: '<b>', productVersion: '2.0' })).status).toBe(400);
	});

	it('a merge keeps the label; days of another version are refused (409), days of the same one merge, and they label an empty series', async () => {
		const u = await signUp('ProvMerge');
		const pid = await project(u, 'Prov');
		await put(u, pid, V2);
		const refused = await merge(u, pid, V3);
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/^the series holds CHIRPS v2\.0 and these days are CHIRPS sat v3\.0: merging them would splice two versions/);
		const values = async () => {
			const list = (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; name: string }[];
			return (await u.call('GET', `/projects/${pid}/series/${list.find((s) => s.name === '')!.id}`)).body.values;
		};
		expect(await values()).toEqual([1, 2]);
		// Positive controls: the same version, and days that don't say.
		expect((await merge(u, pid, V2)).status).toBe(200);
		expect((await merge(u, pid, { startDate: '2001-01-04', values: [4] })).body).toMatchObject(V2);
		expect(await values()).toEqual([1, 2, 3, 4]);
		// Into a new series, the days' label becomes the series'.
		expect((await merge(u, pid, { name: 'New', ...V3 })).body).toMatchObject({ name: 'New', ...V3 });
		// An all-blank series has nothing to splice onto.
		await put(u, pid, { name: 'Blank', values: [null, null] });
		expect((await merge(u, pid, { name: 'Blank', ...V3 })).body).toMatchObject(V3);
	});

	it('PATCH …/series/:id labels a series without touching its values, as an editor, and logs it', async () => {
		const owner = await signUp('ProvOwner');
		const viewer = await signUp('ProvViewer');
		const stranger = await signUp('ProvStranger');
		const pid = await project(owner, 'Prov');
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const s = (await put(owner, pid, {})).body as { id: string; updatedAt: string };
		expect((await viewer.call('PATCH', `/projects/${pid}/series/${s.id}`, V2)).status).toBe(403);
		expect((await stranger.call('PATCH', `/projects/${pid}/series/${s.id}`, V2)).status).toBe(404);
		expect((await owner.call('PATCH', `/projects/${pid}/series/${s.id}`, {})).status).toBe(400);
		expect((await owner.call('PATCH', `/projects/${pid}/series/${s.id}`, { ...V2, values: [9] })).status).toBe(400);
		expect((await owner.call('PATCH', `/projects/${pid}/series/not-a-uuid`, V2)).status).toBe(404);
		// Positive control: the owner (an editor) labels it; the values and their updatedAt stay.
		const patched = await owner.call('PATCH', `/projects/${pid}/series/${s.id}`, V2);
		expect(patched.status).toBe(200);
		expect(patched.body).toMatchObject({ id: s.id, updatedAt: s.updatedAt, ...V2 });
		expect(await label(viewer, pid)).toEqual(V2);
		const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'series.labelled' ORDER BY id`, [pid]);
		expect(events.map((e) => e.subject.provenance)).toEqual([{ from: 'an unrecorded version', to: 'CHIRPS v2.0' }]);
		// The same label again changes nothing and logs nothing; null clears it.
		await owner.call('PATCH', `/projects/${pid}/series/${s.id}`, V2);
		expect((await owner.call('PATCH', `/projects/${pid}/series/${s.id}`, { product: null, productVersion: null })).body).toMatchObject({ product: null });
		expect((await asOwner(`SELECT count(*)::int AS n FROM audit_event WHERE project_id = $1 AND kind = 'series.labelled'`, [pid]))[0].n).toBe(2);
	});

	it('a copy and the exported document keep the label, and an import stores it', async () => {
		const u = await signUp('ProvCopy');
		const pid = await project(u, 'Prov source');
		await put(u, pid, V2);
		await put(u, pid, { kind: 'rain_catchment_mm', startDate: '2001-01-01', values: [5] });
		const copy = await u.call('POST', `/projects/${pid}/copy`, { name: 'Prov copy' });
		expect(copy.status).toBe(201);
		expect(await label(u, copy.body.project.id)).toEqual(V2);

		const doc = (await u.call('GET', `/projects/${pid}/export.json`)).body as { series: Record<string, unknown>[] };
		expect(doc.series.find((s) => s.kind === 'rain_chirps_mm')).toMatchObject(V2);
		// A series with none recorded exports without the keys, as before.
		expect(doc.series.find((s) => s.kind === 'rain_catchment_mm')).not.toHaveProperty('product');
		const imported = await u.call('POST', '/projects/import', { ...doc, name: 'Prov imported' });
		expect(imported.status).toBe(201);
		expect(await label(u, imported.body.project.id)).toEqual(V2);
		// A document with a half label is refused whole.
		const half = { ...doc, name: 'Half', series: [{ kind: 'rain_chirps_mm', unit: 'mm', startDate: '2001-01-01', values: [1], product: 'CHIRPS' }] };
		expect((await u.call('POST', '/projects/import', half)).status).toBe(400);
	});
});
