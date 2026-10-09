// A land unit's own rain (209_unit_rain_series, issue #482): PATCH
// …/series/:id { siteNodeId } gives a rain series to a farm unit with an
// area. A run reads it under `<kind>@<unit id>` (engine unitRainSeriesKey),
// the catchment's rain stays the series with no site, and the export, the
// import, a copy and a restore carry it to the unit. A unit's MAP and its
// source (node.mapMm / mapSource) and settings.unitRain are validated as the
// engine's mapMmError and unitRainError say. Each refusal has its positive
// control. Synthetic values only.
import { unitRainSeriesKey } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadModelInput } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

const DAYS = 30;
const rain = (scale: number) => Array.from({ length: DAYS }, (_, i) => (i % 4 === 0 ? 8 * scale : 0));

/** Outlet ← gauge ← farm A (10 km²), farm B, a water user and a farm with no area; catchment rain and a rain series to give a unit. */
async function unitProject(u: User, name: string) {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const weir = node('Weir', outlet.id, { kind: 'gauge', areaKm2: 0 });
	const a = node('Unit A', weir.id);
	const b = node('Unit B', outlet.id);
	const user = node('Town', outlet.id, { kind: 'user', areaKm2: 0, damCapacityM3: 0, userDemandM3Day: monthly(100) });
	const bare = node('Bare', outlet.id, { areaKm2: 0 });
	const model = { nodes: [outlet, weir, a, b, user, bare], crops: [], cropAreas: [], transfers: [] };
	expect((await u.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	const put = async (body: Record<string, unknown>) => {
		const r = await u.call('PUT', `/projects/${id}/series`, { unit: 'mm', startDate: '2020-01-01', ...body });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		return r.body.id as string;
	};
	await put({ kind: 'rain_catchment_mm', values: rain(1) });
	const unitGauge = await put({ kind: 'rain_catchment_mm', name: 'A gauge', values: rain(2) });
	const unitChirps = await put({ kind: 'rain_chirps_mm', name: 'A chirps', values: rain(3) });
	return { id, outlet, weir, a, b, user, bare, model, unitGauge, unitChirps };
}

const site = (u: User, pid: string, seriesId: string, siteNodeId: string | null) => u.call('PATCH', `/projects/${pid}/series/${seriesId}`, { siteNodeId });
const input = (u: User, pid: string) => withUser(u.id, (db) => loadModelInput(db, pid));
const seriesList = async (u: User, pid: string) => (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; name: string; kind: string; siteNodeId: string | null }[];

describe('a land unit’s own rain (209_unit_rain_series)', () => {
	let owner: User;
	let editor: User;
	let viewer: User;
	let stranger: User;
	let p: Awaited<ReturnType<typeof unitProject>>;
	beforeAll(async () => {
		owner = await signUp('UnitRainOwner');
		editor = await signUp('UnitRainEditor');
		viewer = await signUp('UnitRainViewer');
		stranger = await signUp('UnitRainStranger');
		p = await unitProject(owner, 'Unit rain');
		for (const [u, role] of [
			[editor, 'editor'],
			[viewer, 'viewer']
		] as const) {
			expect((await owner.call('POST', `/projects/${p.id}/members`, { email: u.email, role })).status).toBe(201);
		}
	});

	it('an editor gives a rain series to a unit: the run reads it under the unit’s key, and the catchment keeps its own rain', async () => {
		const res = await site(editor, p.id, p.unitGauge, p.a.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ id: p.unitGauge, siteNodeId: p.a.id });
		expect((await site(editor, p.id, p.unitChirps, p.a.id)).status).toBe(200);
		// Positive control for the stranger below: a member sees it, sited.
		expect((await seriesList(viewer, p.id)).find((s) => s.id === p.unitGauge)!.siteNodeId).toBe(p.a.id);
		const i = await input(editor, p.id);
		expect(i.series[unitRainSeriesKey('rain_catchment_mm', p.a.id)]!.values).toEqual(rain(2));
		expect(i.series[unitRainSeriesKey('rain_chirps_mm', p.a.id)]!.values).toEqual(rain(3));
		// The catchment's rain is still the one with no site; the unit's never stands in for it.
		expect(i.series.rain_catchment_mm!.values).toEqual(rain(1));
		expect(i.series.rain_chirps_mm).toBeUndefined();
		expect(Object.keys(i.series).filter((k) => k.includes('@')).sort()).toEqual([`rain_catchment_mm@${p.a.id}`, `rain_chirps_mm@${p.a.id}`]);
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'series.site_changed' ORDER BY id DESC LIMIT 1`, [p.id]);
		expect(ev.subject).toMatchObject({ seriesId: p.unitChirps, site: { from: 'the catchment', to: 'Unit A' } });
	});

	it('a unit’s rain never moves the project’s recorded-rain end (dataUntil), which is the catchment’s', async () => {
		const u = await signUp('UnitRainUntil');
		const q = await unitProject(u, 'Until');
		const until = async () => (await u.call('GET', '/projects')).body.projects.find((x: { id: string }) => x.id === q.id).dataUntil;
		// Positive control: the unit's series still with no site reaches further, and counts (it is the catchment's then).
		const later = (await u.call('PUT', `/projects/${q.id}/series`, { kind: 'rain_chirps_mm', name: 'A later', unit: 'mm', startDate: '2020-03-01', values: [1, 2] })).body.id as string;
		expect(await until()).toBe('2020-03-02');
		expect((await site(u, q.id, later, q.a.id)).status).toBe(200);
		expect(await until()).toBe('2020-01-30');
	});

	it('a viewer can’t move it, and a stranger neither sees nor moves it (positive controls above)', async () => {
		expect((await site(viewer, p.id, p.unitGauge, p.b.id)).status).toBe(403);
		expect((await site(stranger, p.id, p.unitGauge, p.b.id)).status).toBe(404);
		expect((await stranger.call('GET', `/projects/${p.id}/series`)).status).toBe(404);
		expect((await seriesList(owner, p.id)).find((s) => s.id === p.unitGauge)!.siteNodeId).toBe(p.a.id);
	});

	it('refuses rain at a gauge, a water user, a unit with no area or another project’s unit, in the API and the database', async () => {
		const other = await unitProject(owner, 'Other unit rain');
		const refused = async (nodeId: string, re: RegExp) => {
			const r = await site(owner, p.id, p.unitGauge, nodeId);
			expect(r.status).toBe(400);
			expect(r.body.error).toMatch(re);
		};
		await refused(p.weir.id, /belongs to a land unit \(a farm\), not a gauge or a water user/);
		await refused(p.user.id, /belongs to a land unit/);
		await refused(p.bare.id, /that unit has no area/);
		await refused(other.a.id, /no such hydrological unit in this project/);
		// Positive control: another unit of this project.
		expect((await site(owner, p.id, p.unitGauge, p.b.id)).status).toBe(200);
		expect((await site(owner, p.id, p.unitGauge, p.a.id)).status).toBe(200);
		// The database holds the kind of node, and the project, on its own (209's trigger, 084's).
		await expect(asOwner('UPDATE time_series SET site_node_id = $2 WHERE id = $1', [p.unitGauge, p.weir.id])).rejects.toThrow(/belongs to a land unit/);
		await expect(asOwner('UPDATE time_series SET site_node_id = $2 WHERE id = $1', [p.unitGauge, other.a.id])).rejects.toThrow(/land unit|different project/);
		// Evaporation and forecast rain have no site at all (the kind CHECK).
		const evap = (await owner.call('PUT', `/projects/${p.id}/series`, { kind: 'evap_apan_mm', unit: 'mm', startDate: '2020-01-01', values: [5, 5] })).body.id as string;
		expect((await site(owner, p.id, evap, p.a.id)).body.error).toMatch(/only a flow record or a land unit’s rain has a site/);
		await expect(asOwner('UPDATE time_series SET site_node_id = $2 WHERE id = $1', [evap, p.a.id])).rejects.toThrow(/time_series_site_kind/);
		// Flow records keep their rules: a gauge above the outlet, never a farm (site.db.test.ts covers the rest).
		const flowId = (await owner.call('PUT', `/projects/${p.id}/series`, { kind: 'flow_observed_m3s', name: 'Weir', unit: 'm3/s', startDate: '2020-01-01', values: [1, 2] })).body.id as string;
		expect((await site(owner, p.id, flowId, p.a.id)).body.error).toMatch(/a flow record’s site is a gauge/);
		expect((await site(owner, p.id, flowId, p.weir.id)).status).toBe(200);
	});

	it('the export, an import and a copy take a unit’s rain to the unit’s new id; one whose unit has gone is left out', async () => {
		const u = await signUp('UnitRainCarry');
		const q = await unitProject(u, 'Carry');
		expect((await site(u, q.id, q.unitGauge, q.a.id)).status).toBe(200);
		expect((await site(u, q.id, q.unitChirps, q.b.id)).status).toBe(200);
		const doc = (await u.call('GET', `/projects/${q.id}/export.json`)).body as { series: { name: string; siteNodeId?: string }[] };
		expect(doc.series.find((s) => s.name === 'A gauge')!.siteNodeId).toBe(q.a.id);
		const imported = await u.call('POST', '/projects/import', { ...doc, name: 'Carry import' });
		expect(imported.status, JSON.stringify(imported.body)).toBe(201);
		const iid = imported.body.project.id as string;
		const unitIn = async (pid: string, name: string) => ((await u.call('GET', `/projects/${pid}/model`)).body.nodes as { id: string; name: string }[]).find((n) => n.name === name)!.id;
		expect((await seriesList(u, iid)).find((s) => s.name === 'A gauge')!.siteNodeId).toBe(await unitIn(iid, 'Unit A'));
		// A file whose rain names a gauge is refused, saying why.
		const bad = structuredClone(doc);
		bad.series.find((s) => s.name === 'A gauge')!.siteNodeId = q.weir.id;
		const refused = await u.call('POST', '/projects/import', { ...bad, name: 'Bad unit rain' });
		expect(refused.status).toBe(400);
		expect(refused.body.details).toEqual([{ message: 'series rain_catchment_mm "A gauge": its site "Weir": a unit’s own rain belongs to a land unit (a farm), not a gauge or a water user' }]);

		// Unit B leaves the model: its rain keeps its site (the run leaves it out), and is left out of the file and a copy.
		expect((await u.call('PUT', `/projects/${q.id}/model`, { ...q.model, nodes: q.model.nodes.filter((n) => n.id !== q.b.id) })).status).toBe(200);
		expect((await seriesList(u, q.id)).find((s) => s.name === 'A chirps')!.siteNodeId).toBe(q.b.id);
		const doc2 = (await u.call('GET', `/projects/${q.id}/export.json`)).body as { series: { name: string }[] };
		expect(doc2.series.map((s) => s.name)).not.toContain('A chirps');
		expect(doc2.series.map((s) => s.name)).toContain('A gauge');
		const copy = await u.call('POST', `/projects/${q.id}/copy`, { name: 'Carry copy' });
		expect(copy.status).toBe(201);
		const cid = copy.body.project.id as string;
		const copied = await seriesList(u, cid);
		expect(copied.find((s) => s.name === 'A chirps')).toBeUndefined();
		expect(copied.find((s) => s.name === 'A gauge')!.siteNodeId).toBe(await unitIn(cid, 'Unit A'));
		// The copy's catchment rain is the source's, and nothing else became it.
		expect((await input(u, cid)).series.rain_chirps_mm).toBeUndefined();
	});

	it('a restore puts a unit’s rain back at its unit, and refuses once the unit is no longer a land unit (085, 209)', async () => {
		const u = await signUp('UnitRainRestore');
		const q = await unitProject(u, 'Restore');
		expect((await site(u, q.id, q.unitGauge, q.a.id)).status).toBe(200);
		expect((await u.call('DELETE', `/projects/${q.id}/series/${q.unitGauge}`)).status).toBe(204);
		const rev = (await u.call('GET', `/projects/${q.id}/series/${q.unitGauge}/revisions`)).body.revisions[0] as { id: string; siteNodeId: string | null };
		expect(rev.siteNodeId).toBe(q.a.id);
		const restore = () => u.call('POST', `/projects/${q.id}/series/${q.unitGauge}/revisions/${rev.id}/restore`, {});
		// Unit A becomes a gauge: the restore would make its rain the catchment's, so it is refused.
		const asGauge = q.model.nodes.map((n) => (n.id === q.a.id ? { ...n, kind: 'gauge', areaKm2: 0 } : n));
		expect((await u.call('PUT', `/projects/${q.id}/model`, { ...q.model, nodes: asGauge })).status).toBe(200);
		const no = await restore();
		expect(no.status).toBe(409);
		expect(no.body).toMatchObject({ details: { code: 'site_gone' } });
		expect(no.body.error).toMatch(/would make it the catchment's rain/);
		// Positive control: a land unit again, and the restore puts it back at the unit.
		expect((await u.call('PUT', `/projects/${q.id}/model`, q.model)).status).toBe(200);
		const back = await restore();
		expect(back.status, JSON.stringify(back.body)).toBe(200);
		expect(back.body).toMatchObject({ name: 'A gauge', siteNodeId: q.a.id });
		expect((await input(u, q.id)).series[unitRainSeriesKey('rain_catchment_mm', q.a.id)]!.values).toEqual(rain(2));
	});
});

describe('a unit’s MAP (node.mapMm / mapSource) and settings.unitRain', () => {
	it('stores a MAP with its source, refuses one out of range or without a source, and drops a source with no MAP', async () => {
		const u = await signUp('UnitMap');
		const q = await unitProject(u, 'Unit MAP');
		const save = (patch: Record<string, unknown>) =>
			u.call('PUT', `/projects/${q.id}/model`, { ...q.model, nodes: q.model.nodes.map((n) => (n.id === q.a.id ? { ...n, ...patch } : n)) });
		const unitA = async () => ((await u.call('GET', `/projects/${q.id}/model`)).body.nodes as { id: string; mapMm: number | null; mapSource: string | null }[]).find((n) => n.id === q.a.id)!;
		expect((await save({ mapMm: 640, mapSource: '  Synthetic atlas, 1991–2020  ' })).status).toBe(200);
		expect(await unitA()).toMatchObject({ mapMm: 640, mapSource: 'Synthetic atlas, 1991–2020' });
		// The run gets it as the model has it.
		expect((await input(u, q.id)).model.nodes.find((n) => n.id === q.a.id)).toMatchObject({ mapMm: 640, mapSource: 'Synthetic atlas, 1991–2020' });
		for (const [patch, re] of [
			[{ mapMm: 640, mapSource: null }, /a MAP needs its source/],
			[{ mapMm: 640, mapSource: '   ' }, /a MAP needs its source/],
			[{ mapMm: 0, mapSource: 's' }, /mapMm/],
			[{ mapMm: 20_000, mapSource: 's' }, /mapMm/],
			[{ mapMm: 640, mapSource: 'x'.repeat(601) }, /mapSource/]
		] as const) {
			const r = await save(patch);
			expect(r.status, JSON.stringify(patch)).toBe(400);
			expect(JSON.stringify(r.body)).toMatch(re);
		}
		expect((await unitA()).mapMm).toBe(640);
		// No MAP: none, and its source isn't kept.
		expect((await save({ mapMm: null, mapSource: 'left behind' })).status).toBe(200);
		expect(await unitA()).toMatchObject({ mapMm: null, mapSource: null });
		// The database holds the bounds and the source rule on its own.
		await expect(asOwner('UPDATE node SET map_mm = 640, map_source = NULL WHERE id = $1', [q.a.id])).rejects.toThrow(/node_map_mm_needs_source/);
		await expect(asOwner(`UPDATE node SET map_mm = 0.5, map_source = 's' WHERE id = $1`, [q.a.id])).rejects.toThrow(/node_map_mm_range/);
		// An older model without the fields saves as before: no MAP.
		const legacy = q.model.nodes.map((n) => {
			const { ...rest } = n as Record<string, unknown>;
			delete rest.mapMm;
			delete rest.mapSource;
			return rest;
		});
		expect((await u.call('PUT', `/projects/${q.id}/model`, { ...q.model, nodes: legacy })).status).toBe(200);
		expect((await unitA()).mapMm).toBeNull();
	});

	it('takes settings.unitRain as the engine’s unitRainError allows, replaced whole', async () => {
		const u = await signUp('UnitRainSettings');
		const pid = (await u.call('POST', '/projects', { name: 'Unit rain settings' })).body.project.id as string;
		const patch = (unitRain: unknown) => u.call('PATCH', `/projects/${pid}`, { settings: { unitRain } });
		const stored = async () => (await u.call('GET', `/projects/${pid}`)).body.project.settings.unitRain;
		const full = { mode: 'perUnit', gaugeMapMm: 700, gaugeMapSource: 'Synthetic gauge record', mapPeriod: { start: '1991-01-01', end: '2020-12-31' } };
		expect((await patch(full)).status).toBe(200);
		expect(await stored()).toEqual(full);
		// Replaced whole: a patch that leaves out the gauge's MAP has none.
		expect((await patch({ mode: 'perUnit' })).status).toBe(200);
		expect(await stored()).toEqual({ mode: 'perUnit' });
		for (const [bad, re] of [
			[{ mode: 'every' }, /mode/],
			[{ mode: 'perUnit', gaugeMapMm: 700 }, /gauge a MAP needs its source/],
			[{ mode: 'perUnit', gaugeMapMm: 0, gaugeMapSource: 's' }, /gaugeMapMm/],
			[{ mode: 'perUnit', mapPeriod: { start: '2000-01-01', end: '2000-06-30' } }, /at least a year/],
			[{ mode: 'perUnit', mapPeriod: { start: '2000-02-30', end: '2010-01-01' } }, /not a calendar date/],
			[{ mode: 'perUnit', extra: 1 }, /unrecognized|extra/i]
		] as const) {
			const r = await patch(bad);
			expect(r.status, JSON.stringify(bad)).toBe(400);
			expect(JSON.stringify(r.body)).toMatch(re);
		}
		expect(await stored()).toEqual({ mode: 'perUnit' });
		// null: the catchment's rain again.
		expect((await patch(null)).status).toBe(200);
		expect(await stored()).toBeNull();
	});
});
