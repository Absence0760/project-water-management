import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** A small runnable catchment: outlet gauge + one farm with a crop, rain and observed flow. */
async function runnableProject(owner: User, name = 'Catchment C') {
	const { body } = await owner.call('POST', '/projects', { name });
	const projectId = body.project.id as string;
	const outlet = node('Gauge', null);
	const farm = node('Rooikloof', outlet.id, { damCapacityM3: 100_000 });
	const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 }], transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	const days = 60;
	const rain = Array.from({ length: days }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect(
		(await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain }))
			.status
	).toBe(200);
	expect(
		(
			await owner.call('PUT', `/projects/${projectId}/series`, {
				kind: 'flow_observed_m3s',
				unit: 'm3/s',
				startDate: '2020-01-01',
				values: new Array(days).fill(0.2)
			})
		).status
	).toBe(200);
	return { projectId, model, farm };
}

async function run(u: User, projectId: string, label: string) {
	const res = await u.call('POST', `/projects/${projectId}/runs`, { label });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.run.id as string;
}

const compare = (u: User, a: string, b: string) => u.call('GET', `/compare/runs?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);

describe('GET /compare/runs', () => {
	it('compares two runs of one project: results, inputs snapshot and what changed', async () => {
		const u = await signUp('Hydro');
		const { projectId, model } = await runnableProject(u);
		const base = await run(u, projectId, 'Baseline');
		const raised = structuredClone(model);
		raised.nodes[1]!.damCapacityM3 = 150_000;
		expect((await u.call('PUT', `/projects/${projectId}/model`, raised)).status).toBe(200);
		const dam = await run(u, projectId, 'Dam raise');

		const res = await compare(u, `${projectId}:${base}`, `${projectId}:${dam}`);
		expect(res.status).toBe(200);
		expect(res.body.a.project).toEqual({ id: projectId, name: 'Catchment C' });
		expect(res.body.a.run).toMatchObject({ id: base, label: 'Baseline', startDate: '2020-01-01', endDate: '2020-02-29' });
		expect(res.body.b.run.label).toBe('Dam raise');
		// The stored inputs snapshot is exposed here (and only here).
		expect(res.body.a.run.inputs.model.nodes[1].damCapacityM3).toBe(100_000);
		expect(res.body.b.run.inputs.series.rain_catchment_mm).toEqual({
			startDate: '2020-01-01',
			length: 60,
			valuesSha256: expect.stringMatching(/^[0-9a-f]{64}$/)
		});
		expect(res.body.b.run.summary.farms[0].name).toBe('Rooikloof');
		expect(res.body.changes).toEqual([
			{ area: 'network', kind: 'changed', subject: 'Rooikloof', text: 'Rooikloof: dam capacity 100,000 m³ → 150,000 m³' }
		]);
		expect(res.body.comparison.samePeriod).toBe(true);
		expect(res.body.comparison.farms).toHaveLength(1);
		expect(res.body.comparison.farms[0].name).toBe('Rooikloof');
		expect(res.body.comparison.calibration).not.toBeNull();
		expect(res.body.catchmentSeries.map((s: { key: string }) => s.key)).toEqual(
			expect.arrayContaining(['natural_flow', 'simulated_outflow', 'observed_flow', 'ewr'])
		);

		// The run's own detail endpoint still doesn't return inputs.
		expect((await u.call('GET', `/projects/${projectId}/runs/${base}`)).body.run.inputs).toBeUndefined();
	});

	it('keeps the WR2012 reference in the run snapshot and summary, lists every change to it, and rejects implausible data', async () => {
		const u = await signUp('Reference');
		const { projectId } = await runnableProject(u);
		// Synthetic reference: 12 Mm³/a over an invented 40 km² quaternary; the farm is 10 km².
		const monthlyMm3 = [31, 30, 31, 31, 28.25, 31, 30, 31, 30, 31, 31, 30].map((d) => (12 * d) / 365.25);
		const reference = { quaternary: 'Z99A', areaKm2: 40, marMm3: 12, monthlyMm3, periodStart: 1990, periodEnd: 2009, mapMm: null, source: 'Synthetic table' };
		const set = (wr2012: unknown) => u.call('PATCH', `/projects/${projectId}`, { settings: { wr2012 } });
		const saved = await set({ reference });
		expect(saved.status, JSON.stringify(saved.body)).toBe(200);
		expect(saved.body.project.settings.wr2012).toMatchObject({ reference, scaling: 'area', calibrationPenalty: { enabled: false } });
		const first = await run(u, projectId, 'With WR2012');

		// Patching another WR2012 group keeps the stored reference.
		expect((await set({ scaling: 'areaRain', calibrationPenalty: { enabled: true, weight: 1, marLowMm3: null, marHighMm3: null } })).status).toBe(200);
		expect((await set({ reference: { ...reference, marMm3: 13, monthlyMm3: monthlyMm3.map((v) => (v * 13) / 12) } })).status).toBe(200);
		const second = await run(u, projectId, 'Changed WR2012');

		const res = await compare(u, `${projectId}:${first}`, `${projectId}:${second}`);
		expect(res.status).toBe(200);
		expect(res.body.a.run.inputs.settings.wr2012.reference).toEqual(reference);
		expect(res.body.b.run.inputs.settings.wr2012).toMatchObject({ scaling: 'areaRain', calibrationPenalty: { enabled: true, weight: 1 } });
		expect(res.body.changes.map((c: { text: string }) => c.text)).toEqual([
			'WR2012 naturalised MAR: 12 Mm³/a → 13 Mm³/a',
			'WR2012 monthly means: changed in 12 months',
			'WR2012 scaling: area ratio → area and rainfall ratio',
			'WR2012 calibration penalty: off → on',
			'WR2012 calibration penalty weight: 0.5 → 1'
		]);
		// The report compares natural flow, scaled by area (10 km² of a 40 km² quaternary).
		const report = res.body.a.run.summary.wr2012;
		expect(report).toMatchObject({ quaternary: 'Z99A', compared: 'natural_flow', scaling: { rule: 'area', factor: 0.25 } });
		expect(report.scaledMarMm3).toBeCloseTo(3, 10);
		expect(res.body.comparison.wr2012.marRatioWhole.a).toBeCloseTo(report.whole.ratio, 12);

		// Plausibility: a MAR above the rain on the quaternary, or monthly means that don't add up.
		const tooWet = await set({ reference: { ...reference, mapMm: 250 } }); // 250 mm × 40 km² = 10 Mm³ < 12
		expect(tooWet.status).toBe(400);
		expect(JSON.stringify(tooWet.body)).not.toMatch(/postgres|pg_|SQL/i);
		expect((await set({ reference: { ...reference, monthlyMm3: new Array(12).fill(0.38) } })).status).toBe(400);
		expect((await set({ reference: null })).status).toBe(200);
	});

	it('lists a series whose values were corrected within the same dates', async () => {
		const u = await signUp('Corrector');
		const { projectId } = await runnableProject(u);
		const before = await run(u, projectId, 'Before');
		const series = (await u.call('GET', `/projects/${projectId}/series`)).body.series as { id: string; kind: string }[];
		const rain = series.find((x) => x.kind === 'rain_catchment_mm')!;
		const values = (await u.call('GET', `/projects/${projectId}/series/${rain.id}`)).body.values as number[];
		values[10] = 55; // a corrected reading, same dates
		expect(
			(await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values }))
				.status
		).toBe(200);
		const after = await run(u, projectId, 'After');
		// Positive control: an unchanged rerun lists nothing.
		const same = await run(u, projectId, 'Same again');

		const res = await compare(u, `${projectId}:${before}`, `${projectId}:${after}`);
		expect(res.body.changes).toEqual([
			{
				area: 'series',
				kind: 'changed',
				subject: 'Rainfall (catchment)',
				text: 'Rainfall (catchment) values changed (same dates, 2020-01-01 to 2020-02-29)'
			}
		]);
		expect((await compare(u, `${projectId}:${after}`, `${projectId}:${same}`)).body.changes).toEqual([]);
	});

	it('compares runs across a copied project, matching farms by name', async () => {
		const u = await signUp('Copier');
		const { projectId: c } = await runnableProject(u);
		const baseC = await run(u, c, 'C baseline');
		const copy = await u.call('POST', `/projects/${c}/copy`, { name: 'Catchment D' });
		const d = copy.body.project.id as string;
		const modelD = (await u.call('GET', `/projects/${d}/model`)).body;
		const farmD = modelD.nodes.find((n: { name: string }) => n.name === 'Rooikloof');
		const apples = { id: crypto.randomUUID(), name: 'Apples', cropFactor: monthly(0.9) };
		modelD.crops.push(apples);
		modelD.cropAreas.push({ nodeId: farmD.id, cropId: apples.id, areaM2: 400_000 });
		expect((await u.call('PUT', `/projects/${d}/model`, modelD)).status).toBe(200);
		const runD = await run(u, d, 'D apples');

		const res = await compare(u, `${c}:${baseC}`, `${d}:${runD}`);
		expect(res.status).toBe(200);
		expect(res.body.b.project.name).toBe('Catchment D');
		const f = res.body.comparison.farms[0];
		expect(f.name).toBe('Rooikloof');
		expect(f.nodeIdA).not.toBe(f.nodeIdB);
		expect(res.body.comparison.onlyInA).toEqual([]);
		expect(res.body.comparison.onlyInB).toEqual([]);
		expect(res.body.changes.map((x: { text: string }) => x.text)).toEqual([
			'Crop "Apples" added',
			'Crop "Apples" added to Rooikloof (40 ha)'
		]);
	});

	it('returns 404 when either side is not visible, 200 for a viewer of both', async () => {
		const owner = await signUp('Owner');
		const other = await signUp('Other');
		const viewer = await signUp('Viewer');
		const { projectId: p1 } = await runnableProject(owner, 'P1');
		const r1 = await run(owner, p1, 'one');
		const { projectId: p2 } = await runnableProject(other, 'P2');
		const r2 = await run(other, p2, 'two');

		// Positive control: the owner sees their own comparison.
		expect((await compare(owner, `${p1}:${r1}`, `${p1}:${r1}`)).status).toBe(200);
		// A stranger sees neither side.
		expect((await compare(other, `${p1}:${r1}`, `${p1}:${r1}`)).status).toBe(404);
		// One visible side is not enough, in either position.
		expect((await compare(owner, `${p1}:${r1}`, `${p2}:${r2}`)).status).toBe(404);
		expect((await compare(other, `${p1}:${r1}`, `${p2}:${r2}`)).status).toBe(404);

		// A viewer on both projects can compare across them.
		expect((await owner.call('POST', `/projects/${p1}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		expect((await compare(viewer, `${p1}:${r1}`, `${p2}:${r2}`)).status).toBe(404);
		expect((await other.call('POST', `/projects/${p2}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const ok = await compare(viewer, `${p1}:${r1}`, `${p2}:${r2}`);
		expect(ok.status).toBe(200);
		expect(ok.body.b.project.name).toBe('P2');
	});

	it('404s a run named under the wrong project, 400s a malformed reference', async () => {
		const u = await signUp('Mixer');
		const { projectId: p1 } = await runnableProject(u, 'M1');
		const { projectId: p2 } = await runnableProject(u, 'M2');
		const r2 = await run(u, p2, 'two');
		expect((await compare(u, `${p1}:${r2}`, `${p2}:${r2}`)).status).toBe(404);
		expect((await compare(u, `${p1}:not-a-uuid`, `${p2}:${r2}`)).status).toBe(404);
		expect((await compare(u, p1, `${p2}:${r2}`)).status).toBe(400);
		expect((await u.call('GET', `/compare/runs?a=${p2}:${r2}`)).status).toBe(400);
	});
});
