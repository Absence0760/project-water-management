// A series records where its values came from and the unit they were given in
// (107_series_source.sql, issue #66): an upload records both, a replace
// records exactly what it was, a merge into a series holding values keeps the
// series' own, PATCH …/series/:id sets the source (an editor, logged), and
// a revision, a copy, the exported document and a run's input carry them.
// Also the project's gap-fill setting (engine flowGapFill.ts) as the settings
// route checks it.
import { describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Meta = { id: string; name: string; unit: string; source: string | null; sourceUnit: string | null; sourceUnitFactor: number | null };

async function project(u: User, name: string) {
	return (await u.call('POST', '/projects', { name })).body.project.id as string;
}
const put = (u: User, pid: string, body: Record<string, unknown>) =>
	u.call('PUT', `/projects/${pid}/series`, { kind: 'flow_observed_m3s', unit: 'l/s', startDate: '2001-01-01', values: [1000, 2000], ...body });
const merge = (u: User, pid: string, body: Record<string, unknown>) =>
	u.call('POST', `/projects/${pid}/series/merge`, { kind: 'flow_observed_m3s', unit: 'm³/s', startDate: '2001-01-03', values: [3], ...body });
const meta = async (u: User, pid: string, name = '') => ((await u.call('GET', `/projects/${pid}/series`)).body.series as Meta[]).find((s) => s.name === name)!;
const origin = (m: Meta) => ({ source: m.source, sourceUnit: m.sourceUnit, sourceUnitFactor: m.sourceUnitFactor });

describe('series source and unit', () => {
	it('an upload records its source and the unit it was given in; a replace records exactly what it was', async () => {
		const u = await signUp('SrcPut');
		const pid = await project(u, 'Src');
		const r = await put(u, pid, { source: '  DWS X1H001 ' });
		expect(r.status).toBe(200);
		// Stored in m³/s, and the l/s it came in, with the factor.
		expect(r.body).toMatchObject({ unit: 'm³/s', source: 'DWS X1H001', sourceUnit: 'l/s', sourceUnitFactor: 0.001 });
		expect((await u.call('GET', `/projects/${pid}/series/${r.body.id}`)).body.values).toEqual([1, 2]);
		// A replace that doesn't say a source clears it; its unit is the new file's.
		expect((await put(u, pid, { unit: 'm³/s', values: [1, 2] })).body).toMatchObject({ source: null, sourceUnit: 'm³/s', sourceUnitFactor: 1 });
		// The same rules as the database CHECK.
		expect((await put(u, pid, { source: '' })).status).toBe(400);
		expect((await put(u, pid, { source: 'a\nb' })).status).toBe(400);
		expect((await put(u, pid, { source: 'x'.repeat(201) })).status).toBe(400);
		expect((await put(u, pid, { source: 7 })).status).toBe(400);
	});

	it('a merge records the source on a new series and keeps a filled series’ own', async () => {
		const u = await signUp('SrcMerge');
		const pid = await project(u, 'Src');
		expect((await merge(u, pid, { name: 'New', source: 'Logger 7' })).body).toMatchObject({ source: 'Logger 7', sourceUnit: 'm³/s', sourceUnitFactor: 1 });
		await put(u, pid, { source: 'DWS X1H001' });
		const before = origin(await meta(u, pid));
		// Other days, in another unit and from another source: the series keeps its own record of where it came from.
		expect((await merge(u, pid, { unit: 'ML/day', source: 'Farm file' })).status).toBe(200);
		expect(origin(await meta(u, pid))).toEqual(before);
	});

	it('PATCH …/series/:id sets or clears the source, as an editor, logged; the values and unit stay', async () => {
		const owner = await signUp('SrcOwner');
		const viewer = await signUp('SrcViewer');
		const stranger = await signUp('SrcStranger');
		const pid = await project(owner, 'Src');
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const s = (await put(owner, pid, {})).body as Meta & { updatedAt: string };
		expect((await viewer.call('PATCH', `/projects/${pid}/series/${s.id}`, { source: 'x' })).status).toBe(403);
		expect((await stranger.call('PATCH', `/projects/${pid}/series/${s.id}`, { source: 'x' })).status).toBe(404);
		expect((await owner.call('PATCH', `/projects/${pid}/series/${s.id}`, { source: ' ' })).status).toBe(400);
		// The given unit is the upload's, never a person's to restate.
		expect((await owner.call('PATCH', `/projects/${pid}/series/${s.id}`, { sourceUnit: 'm³/s' })).status).toBe(400);
		// Positive control: the owner (an editor) sets it; the values, unit and updatedAt stay.
		const patched = await owner.call('PATCH', `/projects/${pid}/series/${s.id}`, { source: 'DWS X1H001' });
		expect(patched.status).toBe(200);
		expect(patched.body).toMatchObject({ id: s.id, updatedAt: s.updatedAt, source: 'DWS X1H001', sourceUnit: 'l/s', sourceUnitFactor: 0.001 });
		expect((await meta(viewer, pid)).source).toBe('DWS X1H001');
		// The same again logs nothing; null clears it.
		await owner.call('PATCH', `/projects/${pid}/series/${s.id}`, { source: 'DWS X1H001' });
		expect((await owner.call('PATCH', `/projects/${pid}/series/${s.id}`, { source: null })).body.source).toBeNull();
		const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'series.labelled' ORDER BY id`, [pid]);
		expect(events.map((e) => e.subject.origin)).toEqual([
			{ from: 'source not recorded · given in l/s (× 0.001)', to: 'DWS X1H001 · given in l/s (× 0.001)' },
			{ from: 'DWS X1H001 · given in l/s (× 0.001)', to: 'source not recorded · given in l/s (× 0.001)' }
		]);
	});

	it('a restore brings the source and unit back with the values they describe', async () => {
		const u = await signUp('SrcRestore');
		const pid = await project(u, 'Src');
		const first = (await put(u, pid, { source: 'DWS X1H001' })).body as Meta;
		await put(u, pid, { unit: 'm³/s', values: [5, 6], source: 'Farm file' });
		const revs = (await u.call('GET', `/projects/${pid}/series/${first.id}/revisions`)).body.revisions as { id: string; source: string | null; sourceUnit: string | null }[];
		expect(revs[0]).toMatchObject({ source: 'DWS X1H001', sourceUnit: 'l/s' });
		expect((await u.call('POST', `/projects/${pid}/series/${first.id}/revisions/${revs[0]!.id}/restore`)).status).toBe(200);
		expect(origin(await meta(u, pid))).toEqual({ source: 'DWS X1H001', sourceUnit: 'l/s', sourceUnitFactor: 0.001 });
	});

	it('a copy, the exported document and an import keep them; a run’s input carries them', async () => {
		const u = await signUp('SrcCopy');
		const pid = await project(u, 'Src source');
		await put(u, pid, { source: 'DWS X1H001' });
		const want = { source: 'DWS X1H001', sourceUnit: 'l/s', sourceUnitFactor: 0.001 };
		const copy = await u.call('POST', `/projects/${pid}/copy`, { name: 'Src copy' });
		expect(origin(await meta(u, copy.body.project.id))).toEqual(want);
		const doc = (await u.call('GET', `/projects/${pid}/export.json`)).body as { series: Record<string, unknown>[] };
		expect(doc.series[0]).toMatchObject(want);
		const imported = await u.call('POST', '/projects/import', { ...doc, name: 'Src imported' });
		expect(imported.status).toBe(201);
		expect(origin(await meta(u, imported.body.project.id))).toEqual(want);
		// And the re-imported project exports them back exactly: the with-source round trip.
		const again = (await u.call('GET', `/projects/${imported.body.project.id}/export.json`)).body as { series: Record<string, unknown>[] };
		expect(again.series).toEqual(doc.series);
		// A document without them records none (not the file's unit, which holds converted values), and exports without the keys.
		const bare = { ...doc, name: 'Src bare', series: [{ kind: 'flow_observed_m3s', name: '', unit: 'm³/s', startDate: '2001-01-01', values: [1] }] };
		const b = await u.call('POST', '/projects/import', bare);
		expect(origin(await meta(u, b.body.project.id))).toEqual({ source: null, sourceUnit: null, sourceUnitFactor: null });
		const bareBack = (await u.call('GET', `/projects/${b.body.project.id}/export.json`)).body as { series: Record<string, unknown>[] };
		expect(bareBack.series).toEqual(bare.series);
		// Half a unit record is refused whole.
		expect((await u.call('POST', '/projects/import', { ...bare, series: [{ ...bare.series[0], sourceUnit: 'l/s' }] })).status).toBe(400);
		const input = (await u.call('GET', `/projects/${pid}/model-input`)).body.input as { series: Record<string, { origin?: unknown }> };
		expect(input.series.flow_observed_m3s!.origin).toEqual({ source: 'DWS X1H001', unit: 'l/s', factor: 0.001 });
	});
});

describe('settings.flowGapFill', () => {
	it('takes a spec per record, and refuses a record filling itself or out-of-bound days', async () => {
		const u = await signUp('GapFillSettings');
		const pid = await project(u, 'Gaps');
		const spec = { interpolateMaxDays: 5, donor: 'flow_logger_m3s', donorMaxDays: 60, donorMinOverlapDays: 365 };
		const patch = (flowGapFill: unknown) => u.call('PATCH', `/projects/${pid}`, { settings: { flowGapFill } });
		const ok = await patch({ flow_observed_m3s: spec });
		expect(ok.status).toBe(200);
		expect(ok.body.project.settings.flowGapFill).toEqual({ flow_observed_m3s: spec, flow_logger_m3s: null });
		// Retired: whether filled days are scored is qualityFlags.infilled, one control.
		expect((await patch({ useFilledDays: true })).status).toBe(400);
		expect((await patch({ flow_logger_m3s: { ...spec } })).status).toBe(400);
		expect((await patch({ flow_observed_m3s: { ...spec, interpolateMaxDays: 31 } })).status).toBe(400);
		expect((await patch({ flow_observed_m3s: { ...spec, donorMinOverlapDays: 10 } })).status).toBe(400);
		expect((await patch({ flow_observed_m3s: { ...spec, extra: 1 } })).status).toBe(400);
		// Off again.
		expect((await patch({ flow_observed_m3s: null })).body.project.settings.flowGapFill.flow_observed_m3s).toBeNull();
	});
});
