// A flow record's site (084_gauge_records, engine 1.4.0, issue #64): PATCH
// …/series/:id { siteNodeId } attaches an observed or logger record to a gauge
// node inside the network. A run reads it as that gauge's own record
// (`<kind>@<node id>`, only the plausibility checks use it), the outlet's
// records stay the series with no site, the run stores and reproduces it, and
// a copy, the exported document and an import carry it to the new gauge ids.
// Each refusal has its positive control. Synthetic values only.
import { gaugeSeriesKey, type ModelInput } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadModelInput, loadRunInput } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

const DAYS = 30;
const flow = (v: number) => Array.from({ length: DAYS }, (_, i) => v + (i % 3));

/** Outlet gauge G ← gauge H ← farm A, 30 days of rain, an outlet record ('') and one to attach ('Upper weir'). */
async function gaugedProject(u: User, name: string) {
	const id = (await u.call('POST', '/projects', { name })).body.project.id as string;
	const outlet = node('Outlet', null);
	const upper = node('Upper weir', outlet.id, { kind: 'gauge', areaKm2: 0 });
	const farm = node('Farm', upper.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, upper, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${id}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 5 === 0 ? 10 : 0));
	const put = (body: Record<string, unknown>) => u.call('PUT', `/projects/${id}/series`, { unit: 'm3/s', startDate: '2020-01-01', ...body });
	expect((await put({ kind: 'rain_catchment_mm', unit: 'mm', values: rain })).status).toBe(200);
	const outletRecord = (await put({ kind: 'flow_observed_m3s', name: '', values: flow(2) })).body.id as string;
	const gaugeRecord = (await put({ kind: 'flow_observed_m3s', name: 'Upper weir', values: flow(1) })).body.id as string;
	const rainId = ((await u.call('GET', `/projects/${id}/series`)).body.series as { id: string; kind: string }[]).find((s) => s.kind === 'rain_catchment_mm')!.id;
	return { id, outlet, upper, farm, model, outletRecord, gaugeRecord, rainId };
}

const site = (u: User, pid: string, seriesId: string, siteNodeId: string | null) => u.call('PATCH', `/projects/${pid}/series/${seriesId}`, { siteNodeId });
const input = (u: User, pid: string) => withUser(u.id, (db) => loadModelInput(db, pid));
const seriesList = async (u: User, pid: string) => (await u.call('GET', `/projects/${pid}/series`)).body.series as { name: string; kind: string; siteNodeId: string | null }[];

describe('a flow record’s site (084_gauge_records)', () => {
	let owner: User;
	let p: Awaited<ReturnType<typeof gaugedProject>>;
	beforeAll(async () => {
		owner = await signUp('SiteOwner');
		p = await gaugedProject(owner, 'Sited');
	});

	it('before any site, every record is the outlet’s: the first by name is the one a run reads', async () => {
		const i = await input(owner, p.id);
		expect(i.series.flow_observed_m3s!.values).toEqual(flow(2));
		expect(Object.keys(i.series).filter((k) => k.includes('@'))).toEqual([]);
		expect((await seriesList(owner, p.id)).every((s) => s.siteNodeId === null)).toBe(true);
	});

	it('attaching a record to a gauge makes it that gauge’s own, and records who moved it', async () => {
		const res = await site(owner, p.id, p.gaugeRecord, p.upper.id);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ id: p.gaugeRecord, siteNodeId: p.upper.id });
		const i = await input(owner, p.id);
		// The outlet's record is still the one with no site; the gauge's is keyed by its node.
		expect(i.series.flow_observed_m3s!.values).toEqual(flow(2));
		expect(i.series[gaugeSeriesKey('flow_observed_m3s', p.upper.id)]!.values).toEqual(flow(1));
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'series.site_changed' ORDER BY id DESC LIMIT 1`, [p.id]);
		expect(ev.subject).toMatchObject({ seriesId: p.gaugeRecord, name: 'Upper weir', site: { from: 'the outlet', to: 'Upper weir' } });
		// Setting the same site again changes nothing and records nothing.
		const n = async () => (await asOwner(`SELECT count(*)::int AS n FROM audit_event WHERE project_id = $1 AND kind = 'series.site_changed'`, [p.id]))[0].n;
		const before = await n();
		expect((await site(owner, p.id, p.gaugeRecord, p.upper.id)).status).toBe(200);
		expect(await n()).toBe(before);
	});

	it('with its only other record at a gauge, the outlet has none: a sited record never falls back to the outlet', async () => {
		const u = await signUp('SiteOnly');
		const q = await gaugedProject(u, 'Only');
		expect((await u.call('DELETE', `/projects/${q.id}/series/${q.outletRecord}`)).status).toBe(204);
		expect((await site(u, q.id, q.gaugeRecord, q.upper.id)).status).toBe(200);
		const i = await input(u, q.id);
		expect(i.series.flow_observed_m3s).toBeUndefined();
		expect(i.series[gaugeSeriesKey('flow_observed_m3s', q.upper.id)]).toBeDefined();
	});

	it('refuses a site that is not a gauge above the outlet, a rain series, or another project’s node (positive control above)', async () => {
		expect((await site(owner, p.id, p.gaugeRecord, p.farm.id)).body.error).toMatch(/a record's site is a gauge$/);
		expect((await site(owner, p.id, p.gaugeRecord, p.outlet.id)).body.error).toMatch(/that gauge is the outlet/);
		expect((await site(owner, p.id, p.rainId, p.upper.id)).body.error).toMatch(/only an observed or logger flow record has a site/);
		const other = await gaugedProject(owner, 'Other');
		const cross = await site(owner, p.id, p.gaugeRecord, other.upper.id);
		expect(cross.status).toBe(400);
		expect(cross.body.error).toMatch(/no such hydrological unit in this project/);
		// Rain may still be told it is at the outlet (null): nothing to refuse.
		expect((await site(owner, p.id, p.rainId, null)).status).toBe(200);
		// The database holds both rules on its own (CHECK and the same-project trigger).
		await expect(asOwner('UPDATE time_series SET site_node_id = $2 WHERE id = $1', [p.rainId, p.upper.id])).rejects.toThrow(/time_series_site_flow_only/);
		await expect(asOwner('UPDATE time_series SET site_node_id = $2 WHERE id = $1', [p.gaugeRecord, other.upper.id])).rejects.toThrow(/belongs to a different project/);
		expect((await seriesList(owner, p.id)).find((s) => s.name === 'Upper weir')!.siteNodeId).toBe(p.upper.id);
	});

	it('only an editor moves a record: a viewer is refused, the owner (above) is not', async () => {
		const viewer = await signUp('SiteViewer');
		expect((await owner.call('POST', `/projects/${p.id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		expect((await site(viewer, p.id, p.gaugeRecord, null)).status).toBe(403);
		expect((await seriesList(viewer, p.id)).find((s) => s.name === 'Upper weir')!.siteNodeId).toBe(p.upper.id);
	});

	it('a run checks the gauge’s record there, stores it, and reproduces it from its stored inputs', async () => {
		const res = await owner.call('POST', `/projects/${p.id}/runs`, { label: 'gauged' });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const runId = res.body.run.id as string;
		const summary = (await owner.call('GET', `/projects/${p.id}/runs/${runId}`)).body.run.summary;
		expect(summary.plausibility.gauges.map((g: { nodeId: string }) => g.nodeId)).toEqual([p.upper.id]);
		expect(summary.plausibility.gauges[0].naturalised.years[0].days).toBe(DAYS);
		const kinds = (await asOwner('SELECT kind FROM run_input_series WHERE run_id = $1 ORDER BY kind', [runId])).map((r: { kind: string }) => r.kind);
		expect(kinds).toContain(gaugeSeriesKey('flow_observed_m3s', p.upper.id));
		const again: ModelInput = await withUser(owner.id, (db) => loadRunInput(db, runId));
		expect(again.series[gaugeSeriesKey('flow_observed_m3s', p.upper.id)]!.values).toEqual(flow(1));
	});

	it('a copy and the exported document carry the site to the new gauge; an import checks it', async () => {
		const copy = await owner.call('POST', `/projects/${p.id}/copy`, { name: 'Sited copy' });
		expect(copy.status).toBe(201);
		const cid = copy.body.project.id as string;
		const copyGauge = ((await owner.call("GET", `/projects/${cid}/model`)).body.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper weir')!;
		expect(copyGauge.id).not.toBe(p.upper.id);
		expect((await seriesList(owner, cid)).find((s) => s.name === 'Upper weir')!.siteNodeId).toBe(copyGauge.id);
		expect((await seriesList(owner, cid)).find((s) => s.name === '' && s.kind === 'flow_observed_m3s')!.siteNodeId).toBeNull();

		const doc = (await owner.call('GET', `/projects/${p.id}/export.json`)).body as { series: { name: string; kind: string; siteNodeId?: string }[] };
		expect(doc.series.find((s) => s.name === 'Upper weir')!.siteNodeId).toBe(p.upper.id);
		expect('siteNodeId' in doc.series.find((s) => s.name === '' && s.kind === 'flow_observed_m3s')!).toBe(false);
		const imported = await owner.call('POST', '/projects/import', { ...doc, name: 'Sited import' });
		expect(imported.status).toBe(201);
		const iid = imported.body.project.id as string;
		const importedGauge = ((await owner.call("GET", `/projects/${iid}/model`)).body.nodes as { id: string; name: string }[]).find((n) => n.name === 'Upper weir')!;
		expect((await seriesList(owner, iid)).find((s) => s.name === 'Upper weir')!.siteNodeId).toBe(importedGauge.id);
		// A file whose site is the farm is refused.
		const bad = structuredClone(doc);
		bad.series.find((s) => s.name === 'Upper weir')!.siteNodeId = p.farm.id;
		const refused = await owner.call('POST', '/projects/import', { ...bad, name: 'Bad site' });
		expect(refused.status).toBe(400);
		expect(refused.body.details).toEqual([{ message: 'series flow_observed_m3s "Upper weir": its site "Farm" is not a gauge above the outlet' }]);
	});

	it('a gauge deleted from the model keeps its record apart: the outlet still reads its own, and the run warns', async () => {
		const u = await signUp('SiteGone');
		const q = await gaugedProject(u, 'Gone');
		expect((await site(u, q.id, q.gaugeRecord, q.upper.id)).status).toBe(200);
		// The farm now drains straight to the outlet; the gauge leaves the model.
		const farm = { ...q.farm, downstreamNodeId: q.outlet.id };
		expect((await u.call('PUT', `/projects/${q.id}/model`, { ...q.model, nodes: [q.outlet, farm] })).status).toBe(200);
		expect((await seriesList(u, q.id)).find((s) => s.name === 'Upper weir')!.siteNodeId).toBe(q.upper.id);
		const i = await input(u, q.id);
		expect(i.series.flow_observed_m3s!.values).toEqual(flow(2));
		const res = await u.call('POST', `/projects/${q.id}/runs`, { label: 'gone' });
		expect(res.status).toBe(201);
		const summary = (await u.call('GET', `/projects/${q.id}/runs/${res.body.run.id}`)).body.run.summary;
		expect(summary.plausibility.gauges).toBeUndefined();
		expect(summary.warnings).toContainEqual(expect.stringMatching(/record is attached to a hydrological unit that is no longer in the model/));
		// And it can be moved back to the outlet.
		expect((await site(u, q.id, q.gaugeRecord, null)).body.siteNodeId).toBeNull();
	});

	it('a deleted gauge record restored from its revision is back at its gauge; an outlet record restores to the outlet (085)', async () => {
		const u = await signUp('SiteRestore');
		const q = await gaugedProject(u, 'Restore');
		expect((await site(u, q.id, q.gaugeRecord, q.upper.id)).status).toBe(200);
		const revisionOf = async (seriesId: string) => {
			const res = await u.call('GET', `/projects/${q.id}/series/${seriesId}/revisions`);
			return res.body.revisions[0] as { id: string; siteNodeId: string | null };
		};
		const restore = (seriesId: string, revId: string) => u.call('POST', `/projects/${q.id}/series/${seriesId}/revisions/${revId}/restore`, {});

		// The gauge's record: deleted, then restored.
		expect((await u.call('DELETE', `/projects/${q.id}/series/${q.gaugeRecord}`)).status).toBe(204);
		const gaugeRev = await revisionOf(q.gaugeRecord);
		expect(gaugeRev.siteNodeId).toBe(q.upper.id);
		const back = await restore(q.gaugeRecord, gaugeRev.id);
		expect(back.status).toBe(200);
		expect(back.body).toMatchObject({ name: 'Upper weir', siteNodeId: q.upper.id });
		// It is the gauge's again, not the outlet's: the run reads it under its gauge's key.
		const i = await input(u, q.id);
		expect(i.series[gaugeSeriesKey('flow_observed_m3s', q.upper.id)]!.values).toEqual(flow(1));
		expect(i.series.flow_observed_m3s!.values).toEqual(flow(2));

		// Positive control: the outlet's record, deleted and restored, is the outlet's.
		expect((await u.call('DELETE', `/projects/${q.id}/series/${q.outletRecord}`)).status).toBe(204);
		const outletRev = await revisionOf(q.outletRecord);
		expect(outletRev.siteNodeId).toBeNull();
		const outletBack = await restore(q.outletRecord, outletRev.id);
		expect(outletBack.status).toBe(200);
		expect(outletBack.body.siteNodeId).toBeNull();
		expect((await input(u, q.id)).series.flow_observed_m3s!.values).toEqual(flow(2));
	});

	it('refuses to restore a gauge record whose gauge has left the model, rather than put it at the outlet', async () => {
		const u = await signUp('SiteRestoreGone');
		const q = await gaugedProject(u, 'Restore gone');
		expect((await site(u, q.id, q.gaugeRecord, q.upper.id)).status).toBe(200);
		expect((await u.call('DELETE', `/projects/${q.id}/series/${q.gaugeRecord}`)).status).toBe(204);
		const rev = (await u.call('GET', `/projects/${q.id}/series/${q.gaugeRecord}/revisions`)).body.revisions[0] as { id: string };
		const farm = { ...q.farm, downstreamNodeId: q.outlet.id };
		expect((await u.call('PUT', `/projects/${q.id}/model`, { ...q.model, nodes: [q.outlet, farm] })).status).toBe(200);
		const refused = await u.call('POST', `/projects/${q.id}/series/${q.gaugeRecord}/revisions/${rev.id}/restore`, {});
		expect(refused.status).toBe(409);
		expect(refused.body.error).toMatch(/measured at a gauge that is no longer in the model/);
		// Nothing was written: the record is still gone.
		expect((await seriesList(u, q.id)).some((s) => s.name === 'Upper weir')).toBe(false);
	});
});
