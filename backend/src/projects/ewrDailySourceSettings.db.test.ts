// Where the daily EWR at the outlet comes from (settings.ewrDailySource,
// engine ≥ 1.77.0, issue #455, docs/model.md §2.9f) through the API: an editor
// saves it, a viewer reads it but can't change it, the engine's checks refuse
// an unusable source with a 400 that names the field (no database error text),
// a patch replaces it whole, and a run reports the scale factor it used.
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const tab = { method: 'tab', scaling: 'area', tableMarMm3: null, tableAreaKm2: 40, tabM3s: monthly(0.05), naturalPctM3s: null, reservePctM3s: null };

async function project(u: User) {
	const projectId = (await u.call('POST', '/projects', { name: 'Daily EWR source' })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Farm', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	return projectId;
}

describe('settings.ewrDailySource', () => {
	it('an editor saves it, a viewer reads it but cannot change it; a run reports the scale factor', async () => {
		const owner = await signUp('DailyEwrOwner');
		const editor = await signUp('DailyEwrEditor');
		const viewer = await signUp('DailyEwrViewer');
		const id = await project(owner);
		for (const [u, role] of [
			[editor, 'editor'],
			[viewer, 'viewer']
		] as const) {
			expect((await owner.call('POST', `/projects/${id}/members`, { email: u.email, role })).status).toBe(201);
		}
		// The pragmatic EWR until someone picks another.
		expect((await viewer.call('GET', `/projects/${id}`)).body.project.settings.ewrDailySource).toBeNull();

		const set = await editor.call('PATCH', `/projects/${id}`, { settings: { ewrDailySource: tab } });
		expect(set.status, JSON.stringify(set.body)).toBe(200);
		// Positive control: the viewer reads the editor's source.
		expect((await viewer.call('GET', `/projects/${id}`)).body.project.settings.ewrDailySource).toEqual(tab);
		const denied = await viewer.call('PATCH', `/projects/${id}`, { settings: { ewrDailySource: null } });
		expect([403, 404]).toContain(denied.status);
		expect((await owner.call('GET', `/projects/${id}`)).body.project.settings.ewrDailySource).toEqual(tab);

		const run = await editor.call('POST', `/projects/${id}/runs`, { label: 'TAB' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const info = run.body.run.summary.catchment.outletEwr;
		// The farm's area (the helper's) ÷ the table's 40 km².
		expect(info).toMatchObject({ method: 'tab', scaling: 'area', tableAreaKm2: 40 });
		expect(info.scale).toBeCloseTo(info.modelAreaKm2 / 40, 12);
	});

	it('saves the Reserve table choice with the third table, and a run reads it and says so (issue #552)', async () => {
		const owner = await signUp('DailyEwrReserveTable');
		const id = await project(owner);
		const grid = (f: number) => Array.from({ length: 12 }, () => [10, 8, 6, 5, 4, 3, 2, 1.5, 1, 0.5].map((v) => v * f));
		const pct = { ...tab, method: 'percentile', tabM3s: null, naturalPctM3s: grid(1), reservePctM3s: grid(0.6), lowFlowPctM3s: grid(0.3), reserveTable: 'withoutHighFlows' };
		const refused = await owner.call('PATCH', `/projects/${id}`, { settings: { ewrDailySource: { ...pct, lowFlowPctM3s: null } } });
		expect(refused.status).toBe(400);
		expect(JSON.stringify(refused.body)).toContain('daily EWR source: lowFlowPctM3s:');
		const set = await owner.call('PATCH', `/projects/${id}`, { settings: { ewrDailySource: pct } });
		expect(set.status, JSON.stringify(set.body)).toBe(200);
		expect(set.body.project.settings.ewrDailySource).toEqual(pct);
		const run = await owner.call('POST', `/projects/${id}/runs`, { label: 'Without high flows' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		expect(run.body.run.summary.catchment.outletEwr).toMatchObject({ method: 'percentile', reserveTable: 'withoutHighFlows' });
		// Positive control: the total, chosen, carries no reserveTable.
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { ewrDailySource: { ...pct, reserveTable: 'total' } } })).status).toBe(200);
		const total = await owner.call('POST', `/projects/${id}/runs`, { label: 'Total' });
		expect(total.status).toBe(201);
		expect(total.body.run.summary.catchment.outletEwr.method).toBe('percentile');
		expect(total.body.run.summary.catchment.outletEwr.reserveTable).toBeUndefined();
	});

	it('refuses an unusable source with the field named, and a patch replaces the source whole', async () => {
		const owner = await signUp('DailyEwrChecks');
		const id = await project(owner);
		const bad = await owner.call('PATCH', `/projects/${id}`, { settings: { ewrDailySource: { ...tab, tableAreaKm2: null } } });
		expect(bad.status).toBe(400);
		const text = JSON.stringify(bad.body);
		expect(text).toContain('daily EWR source: tableAreaKm2: Scaling by area needs');
		expect(text).not.toMatch(/violates|syntax error|relation "/i);
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { ewrDailySource: { ...tab, extra: 1 } } })).status).toBe(400);

		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { ewrDailySource: tab } })).status).toBe(200);
		const pragmatic = { method: 'pragmatic', scaling: 'mar', tableMarMm3: null, tableAreaKm2: null, tabM3s: null, naturalPctM3s: null, reservePctM3s: null };
		const back = await owner.call('PATCH', `/projects/${id}`, { settings: { ewrDailySource: pragmatic } });
		expect(back.status).toBe(200);
		// Whole: the TAB flows went with the patch, nothing merged from the stored source.
		expect(back.body.project.settings.ewrDailySource).toEqual(pragmatic);
	});

	it('a source saved with the MAR ratio keeps it after the default moved to the area ratio (issue #523 D2, #90 B2)', async () => {
		const owner = await signUp('DailyEwrMarKept');
		const id = await project(owner);
		// A new project has no source: the pragmatic EWR, so the area-ratio default reaches no stored settings.
		expect((await owner.call('GET', `/projects/${id}`)).body.project.settings.ewrDailySource).toBeNull();
		const mar = { ...tab, scaling: 'mar', tableMarMm3: 25, tableAreaKm2: 40 };
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { ewrDailySource: mar } })).status).toBe(200);
		// An unrelated settings save leaves the stored choice alone.
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(140) } })).status).toBe(200);
		expect((await owner.call('GET', `/projects/${id}`)).body.project.settings.ewrDailySource).toEqual(mar);

		const run = await owner.call('POST', `/projects/${id}/runs`, { label: 'MAR ratio' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const info = run.body.run.summary.catchment.outletEwr;
		// Scaled by the MAR although the table area is entered too: the stored scaling, not the default, decides.
		expect(info).toMatchObject({ method: 'tab', scaling: 'mar', tableMarMm3: 25 });
		expect(info.scale).toBeCloseTo(info.modelMarMm3 / 25, 12);
	});
});
