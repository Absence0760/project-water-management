import { describe, expect, it } from 'vitest';
import { makeStoredLegacyRun, monthly, node, signUp } from '../__tests__/helpers.js';

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
	// GR4J (the default runoff model) refuses to run without A-pan evaporation.
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
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
			valuesSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
			provenance: null
		});
		expect(res.body.b.run.summary.farms[0].name).toBe('Rooikloof');
		expect(res.body.changes).toEqual([
			{ area: 'network', kind: 'changed', subject: 'Rooikloof', text: 'Rooikloof: dam capacity 100\u202f000 m³ → 150\u202f000 m³' }
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
		// Neither run used the legacy runoff model (audit H1): both GR4J.
		expect(res.body.a.run.legacy).toBe(false);
		expect(res.body.b.run.legacy).toBe(false);
	});

	it('flags a stored legacy-runoff-model run on its own side, independently of the other (audit H1)', async () => {
		const u = await signUp('Hydrolegacy');
		const { projectId } = await runnableProject(u);
		const gr4jRun = await run(u, projectId, 'GR4J');
		// A run saved on the legacy model before engine 1.0.0 removed it (the API can't make one now).
		const legacyRun = await run(u, projectId, 'Legacy');
		await makeStoredLegacyRun(legacyRun);

		const res = await compare(u, `${projectId}:${gr4jRun}`, `${projectId}:${legacyRun}`);
		expect(res.status).toBe(200);
		expect(res.body.a.run.legacy).toBe(false);
		expect(res.body.b.run.legacy).toBe(true);
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
				text: 'Rainfall (catchment) values changed on 1 of the 60 days both runs cover (2020-01-01 to 2020-02-29); their total rose 30.6% (180 → 235)'
			}
		]);
		expect((await compare(u, `${projectId}:${after}`, `${projectId}:${same}`)).body.changes).toEqual([]);
	});

	it('notes a change of CHIRPS product or version between two runs (issue #40 part c)', async () => {
		const u = await signUp('Versioner');
		const { projectId } = await runnableProject(u);
		const chirps = (product: string, productVersion: string) =>
			u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_chirps_mm', unit: 'mm', startDate: '2020-01-01', values: new Array(60).fill(1), product, productVersion });
		expect((await chirps('CHIRPS', '2.0')).status).toBe(200);
		const v2 = await run(u, projectId, 'On v2');
		expect((await chirps('CHIRPS sat', '3.0')).status).toBe(200);
		const v3 = await run(u, projectId, 'On v3');
		const res = await compare(u, `${projectId}:${v2}`, `${projectId}:${v3}`);
		expect(res.body.b.run.inputs.series.rain_chirps_mm.provenance).toEqual({ product: 'CHIRPS sat', version: '3.0' });
		// The same values under another label: only the version line.
		expect(res.body.changes).toEqual([
			{
				area: 'series',
				kind: 'changed',
				subject: 'Rainfall (CHIRPS)',
				text: 'Rainfall (CHIRPS) is now CHIRPS sat v3.0 (was CHIRPS v2.0): the monthly CHIRPS factors are fitted on the new values, and a calibration made on the old ones no longer holds'
			}
		]);
		// The run's own detail carries its input series' labels (for its fit record's "forcing changed since fit").
		const detail = await u.call('GET', `/projects/${projectId}/runs/${v2}`);
		expect(detail.body.run.inputSeries.rain_chirps_mm.provenance).toEqual({ product: 'CHIRPS', version: '2.0' });
		// "Changes since this run" says it too.
		const since = await u.call('GET', `/projects/${projectId}/runs/${v2}/changes-since`);
		expect(since.body.changes.map((c: { text: string }) => c.text)).toEqual([expect.stringMatching(/^Rainfall \(CHIRPS\) is now CHIRPS sat v3\.0 \(was CHIRPS v2\.0\)/)]);
	});

	it('finds rain cut on the shared days even when a day was added (the date change no longer hides it)', async () => {
		const u = await signUp('Hider');
		const { projectId } = await runnableProject(u);
		const before = await run(u, projectId, 'Before');
		const series = (await u.call('GET', `/projects/${projectId}/series`)).body.series as { id: string; kind: string }[];
		const rain = series.find((x) => x.kind === 'rain_catchment_mm')!;
		const values = (await u.call('GET', `/projects/${projectId}/series/${rain.id}`)).body.values as number[];
		const cut = [...values.map((v) => v * 0.85), 0];
		expect(
			(await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: cut })).status
		).toBe(200);
		const after = await run(u, projectId, 'Cut and extended');

		const texts = (await compare(u, `${projectId}:${before}`, `${projectId}:${after}`)).body.changes.map((x: { text: string }) => x.text);
		expect(texts).toContain('Rainfall (catchment) series extended to 2020-03-01 (was 2020-02-29)');
		expect(texts).toContain('Rainfall (catchment) values changed on 9 of the 60 days both runs cover (2020-01-01 to 2020-02-29); their total fell 15% (180 → 153)');
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

	it('says who changed each model and settings line between two runs of one project, and when (issue #42)', async () => {
		const owner = await signUp('AttrOwner');
		const editor = await signUp('AttrEditor');
		const viewer = await signUp('AttrViewer');
		const { projectId, model } = await runnableProject(owner, 'Attributed');
		for (const [u, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
			expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
		}
		const base = await run(owner, projectId, 'Baseline');
		// The editor raises the dam twice (the second with a reason), the owner changes a setting.
		const raised = structuredClone(model);
		raised.nodes[1]!.damCapacityM3 = 120_000;
		expect((await editor.call('PUT', `/projects/${projectId}/model`, raised)).status).toBe(200);
		raised.nodes[1]!.damCapacityM3 = 150_000;
		expect((await editor.call('PUT', `/projects/${projectId}/model`, { ...raised, reason: 'Licence application 2026' })).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(160) } })).status).toBe(200);
		const after = await run(owner, projectId, 'Raised');

		// A viewer sees the attribution (the positive control for the null cases below).
		const res = await compare(viewer, `${projectId}:${base}`, `${projectId}:${after}`);
		expect(res.status).toBe(200);
		const { changes, attribution } = res.body as {
			changes: { area: string; text: string }[];
			attribution: { revisions: { id: string; actor: string; createdAt: string; reason: string | null }[]; truncated: boolean; changedBy: (string | null)[] };
		};
		expect(attribution.truncated).toBe(false);
		expect(attribution.changedBy).toHaveLength(changes.length);
		// Newest first: the setting, then the two dam raises.
		expect(attribution.revisions.map((r) => r.actor)).toEqual(['AttrOwner', 'AttrEditor', 'AttrEditor']);
		const by = (text: string) => attribution.revisions.find((r) => r.id === attribution.changedBy[changes.findIndex((c) => c.text.startsWith(text))]);
		// The dam line is credited to the save that made it 150,000 m³, with its reason and time.
		expect(changes.some((c) => c.text === 'Rooikloof: dam capacity 100\u202f000 m³ → 150\u202f000 m³')).toBe(true);
		expect(by('Rooikloof: dam capacity')).toMatchObject({ actor: 'AttrEditor', reason: 'Licence application 2026' });
		expect(by('Rooikloof: dam capacity')!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(by('A-pan evaporation')).toMatchObject({ actor: 'AttrOwner' });

		// Reversed (the later run as A): no attribution, the diff itself unchanged in length.
		const back = await compare(viewer, `${projectId}:${after}`, `${projectId}:${base}`);
		expect(back.status).toBe(200);
		expect(back.body.attribution).toBeNull();
		// Across projects: no attribution either (each project has its own history).
		const other = await runnableProject(owner, 'Other');
		const otherRun = await run(owner, other.projectId, 'Other run');
		expect((await compare(owner, `${projectId}:${base}`, `${other.projectId}:${otherRun}`)).body.attribution).toBeNull();
	});
});
