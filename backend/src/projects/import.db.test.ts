// POST /projects/import (WP-1.8): a project document in, a new project out,
// atomically and under the importer's RLS. Synthetic data only.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { anon, app, monthly, node, signUp } from '../__tests__/helpers.js';
import type { ProjectDocument } from './document.js';
import { IMPORT_MAX_BYTES } from './import.js';

// Fails the model save of the next import when set, so a failure lands
// after the project row is in: the whole import must roll back.
const failSave = vi.hoisted(() => ({ on: false }));
vi.mock('../model/store.js', async (importOriginal) => {
	const mod = await importOriginal<typeof import('../model/store.js')>();
	return {
		...mod,
		saveModel: async (...args: Parameters<typeof mod.saveModel>) => {
			if (failSave.on) throw new Error('simulated failure mid-import');
			return mod.saveModel(...args);
		}
	};
});

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';

/** POST a raw body to the import route (the helper's `call` always JSON-encodes). */
async function postRaw(u: User | null, body: string, query = '', { contentLength = false } = {}) {
	const res = await app.request(`/projects/import${query}`, {
		method: 'POST',
		headers: {
			origin: ORIGIN,
			'content-type': 'application/json',
			...(u ? { cookie: u.cookie } : {}),
			// As a browser and Lambda send it; without it the cap is enforced while streaming.
			...(contentLength ? { 'content-length': String(Buffer.byteLength(body)) } : {})
		},
		body
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

const importFile = (u: User, doc: unknown, query = '') => postRaw(u, JSON.stringify(doc), query);

async function exportDoc(u: User, projectId: string): Promise<ProjectDocument> {
	const res = await app.request(`/projects/${projectId}/export.json`, { headers: { cookie: u.cookie, origin: ORIGIN } });
	expect(res.status).toBe(200);
	return (await res.json()) as ProjectDocument;
}

const projectNames = async (u: User) => (await u.call('GET', '/projects')).body.projects.map((p: { name: string }) => p.name) as string[];

/** A document with its ids replaced by names, so two imports of one file compare equal. */
function normalize(d: ProjectDocument) {
	const nodeName = new Map(d.model.nodes.map((n) => [n.id, n.name]));
	const cropName = new Map(d.model.crops.map((c) => [c.id, c.name]));
	const settings = d.settings as { ewrRules?: { siteNodeId: string | null }[] };
	return {
		name: d.name,
		description: d.description,
		settings: {
			...settings,
			ewrRules: settings.ewrRules?.map((t) => ({ ...t, siteNodeId: t.siteNodeId && nodeName.get(t.siteNodeId) }))
		},
		engineVersion: d.engineVersion,
		series: d.series,
		nodes: d.model.nodes
			.map(({ id: _id, downstreamNodeId, ...n }) => ({ ...n, downstream: downstreamNodeId && nodeName.get(downstreamNodeId) }))
			.sort((a, b) => a.name.localeCompare(b.name)),
		crops: d.model.crops.map(({ id: _id, ...c }) => c).sort((a, b) => a.name.localeCompare(b.name)),
		cropAreas: d.model.cropAreas
			.map((a) => ({ node: nodeName.get(a.nodeId), crop: cropName.get(a.cropId), areaM2: a.areaM2 }))
			.sort((a, b) => `${a.node}/${a.crop}`.localeCompare(`${b.node}/${b.crop}`)),
		transfers: d.model.transfers.map(({ id: _id, fromNodeId, toNodeId, ...t }) => ({ ...t, from: nodeName.get(fromNodeId), to: nodeName.get(toNodeId) })),
		landCover: (d.model.landCover ?? []).map(({ id: _id, nodeId, ...p }) => ({ ...p, node: nodeName.get(nodeId) }))
	};
}

/** A small synthetic project document that runs (GR4J with A-pan, rain and flow). */
function syntheticDoc(name = 'Imported catchment') {
	const outlet = node('Outlet gauge', null);
	const farm = node('Farm A', outlet.id, { damCapacityM3: 150_000 });
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 12 : 0));
	return {
		name,
		description: 'synthetic',
		settings: { apanMm: monthly(150) },
		model: { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 40_000 }], transfers: [] },
		series: [
			{ kind: 'rain_catchment_mm', name: '', unit: 'mm', startDate: '2022-01-01', values: rain },
			{ kind: 'flow_observed_m3s', name: 'Outlet', unit: 'm3/s', startDate: '2022-01-01', values: rain.map((r) => 0.02 + r / 1000) }
		]
	};
}

let owner: User;
let sourceId: string;
let outletId: string;

beforeAll(async () => {
	owner = await signUp('Importer');
	// A source project with every part a document carries: a transfer, land
	// cover, an EWR rule table sited on a node, settings and two series.
	const { body } = await owner.call('POST', '/projects', { name: 'Round trip Ä', description: 'export → import' });
	sourceId = body.project.id;
	const outlet = node('Gauge', null);
	const farm = node('Farm, "upper"', outlet.id, { damCapacityM3: 200_000 });
	const farm2 = node('Farm 2', farm.id, { damCapacityM3: 50_000 });
	outletId = outlet.id;
	const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
	const model = {
		nodes: [outlet, farm, farm2],
		crops: [crop],
		cropAreas: [
			{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 },
			{ nodeId: farm2.id, cropId: crop.id, areaM2: 20_000 }
		],
		transfers: [
			{ id: crypto.randomUUID(), fromNodeId: farm.id, toNodeId: farm2.id, months: [1, 2, 3], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0.2, enabled: true, priority: 0 }
		],
		landCover: [{ id: crypto.randomUUID(), nodeId: farm.id, coverClass: 'pine', areaKm2: 1.5, densityPct: 0.6, factors: null }]
	};
	expect((await owner.call('PUT', `/projects/${sourceId}/model`, model)).status).toBe(200);
	const table = {
		siteNodeId: outlet.id,
		source: 'Synthetic table',
		component: 'total',
		unit: 'mcm',
		points: [10, 50, 90],
		ewr: Array.from({ length: 12 }, () => [1.5, 1, 0.5]),
		naturalSource: 'run',
		natural: null,
		scale: 1
	};
	const patched = await owner.call('PATCH', `/projects/${sourceId}`, {
		settings: { apanMm: monthly(150), effectiveRainFraction: 0.6, ewrRules: [table] }
	});
	expect(patched.status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 7 === 0 ? 25 : i === 3 ? null : 0));
	expect((await owner.call('PUT', `/projects/${sourceId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2024-02-15', values: rain })).status).toBe(200);
	expect(
		(await owner.call('PUT', `/projects/${sourceId}/series`, {
			kind: 'flow_observed_m3s',
			name: 'Gauge A',
			unit: 'm3/s',
			startDate: '2024-02-15',
			values: rain.map((r) => (r === null ? null : 0.01 + r / 1000))
		})).status
	).toBe(200);
});

describe('POST /projects/import', () => {
	it('round-trips export.json → import → export.json, equal apart from ids and exportedAt', async () => {
		const doc = await exportDoc(owner, sourceId);
		// The export posts as-is: its format, version, exportedAt and engineVersion keys are ignored.
		const res = await importFile(owner, doc);
		expect(res.status).toBe(201);
		const { project } = res.body;
		expect(project).toMatchObject({ name: 'Round trip Ä', description: 'export → import', role: 'owner', team: null });
		expect(project.id).not.toBe(sourceId);
		// The same shape POST /projects answers with (settings merged over the defaults).
		const created = await owner.call('POST', '/projects', { name: 'Shape reference' });
		expect(Object.keys(project).sort()).toEqual(Object.keys(created.body.project).sort());
		expect(res.body.runId).toBeUndefined();

		const again = await exportDoc(owner, project.id);
		expect(normalize(again)).toEqual(normalize(doc));
		// Fresh ids, and the EWR table's site follows its node to the new id.
		const newIds = again.model.nodes.map((n) => n.id);
		expect(newIds).not.toContain(outletId);
		const gauge = again.model.nodes.find((n) => n.name === 'Gauge')!;
		expect((again.settings as { ewrRules: { siteNodeId: string }[] }).ewrRules[0]!.siteNodeId).toBe(gauge.id);

		// The same file imports again (every id is fresh each time).
		const twice = await importFile(owner, doc);
		expect(twice.status).toBe(201);
		expect(normalize(await exportDoc(owner, twice.body.project.id))).toEqual(normalize(doc));
	});

	it('refuses a signed-out request with 401', async () => {
		expect((await postRaw(null, JSON.stringify(syntheticDoc()))).status).toBe(401);
		expect((await anon('POST', '/projects/import', syntheticDoc())).status).toBe(401);
	});

	it('imports into a team you may add to, and 404s for a team you are not in (nothing created)', async () => {
		const admin = await signUp('Teamadmin');
		const member = await signUp('Teammember');
		const teamViewer = await signUp('Teamviewer');
		const outsider = await signUp('Outsider');
		const teamId = (await admin.call('POST', '/teams', { name: 'Import Team' })).body.team.id;
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: teamViewer.email, role: 'viewer' })).status).toBe(201);

		// Positive control: a team member's import lands in the team, and the admin sees it.
		const ok = await importFile(member, syntheticDoc('Team import'), `?teamId=${teamId}`);
		expect(ok.status).toBe(201);
		expect(ok.body.project.team).toEqual({ id: teamId, name: 'Import Team' });
		expect(await projectNames(admin)).toContain('Team import');

		const denied = await importFile(outsider, syntheticDoc('Sneaky import'), `?teamId=${teamId}`);
		expect(denied.status).toBe(404);
		expect(denied.body).toEqual({ error: 'team not found' });
		expect(await projectNames(outsider)).toEqual([]);
		// A team viewer only reads the team's projects (as POST /projects: 403).
		expect((await importFile(teamViewer, syntheticDoc('Viewer import'), `?teamId=${teamId}`)).status).toBe(403);
		expect(await projectNames(admin)).toEqual(['Team import']);
		// A team id that isn't a uuid is a bad request.
		expect((await importFile(member, syntheticDoc(), '?teamId=nope')).status).toBe(400);
	});

	it('answers an invalid file with 400 and its problems, never raw database text, and creates nothing', async () => {
		const u = await signUp('Badfile');
		const good = syntheticDoc('Never created');

		const noModel = await importFile(u, { name: 'x', series: [] });
		expect(noModel.status).toBe(400);
		expect(noModel.body.error).toBe('invalid request');
		expect(noModel.body.details.some((d: { path: string[] }) => d.path[0] === 'model')).toBe(true);

		// Structural model rules zod can't express: two outlets.
		const twoOutlets = structuredClone(good);
		twoOutlets.model.nodes[1]!.downstreamNodeId = null;
		const r1 = await importFile(u, twoOutlets);
		expect(r1.status).toBe(400);
		expect(r1.body.error).toBe('invalid project file');
		expect(r1.body.details.map((d: { message: string }) => d.message)).toContain(
			'the network needs exactly one outflow hydrological unit (drains into nothing); found 2'
		);

		// Two series of one kind and name: the database keeps one, so it's refused up front.
		const dupe = structuredClone(good);
		dupe.series.push({ ...dupe.series[0]! });
		const r2 = await importFile(u, dupe);
		expect(r2.status).toBe(400);
		expect(r2.body.details.map((d: { message: string }) => d.message)).toContain('duplicate series rain_catchment_mm');

		// Not a calendar date (would otherwise fail inside Postgres as a 500).
		const badDate = structuredClone(good);
		badDate.series[0]!.startDate = '2022-02-30';
		expect((await importFile(u, badDate)).status).toBe(400);

		expect((await postRaw(u, '{"name":')).body).toEqual({ error: 'invalid JSON' });
		expect(await projectNames(u)).toEqual([]);
		// Positive control: the unbroken file imports.
		expect((await importFile(u, good)).status).toBe(201);
	});

	it('leaves no partial project when the import fails part-way', async () => {
		const u = await signUp('Midway');
		failSave.on = true;
		try {
			const res = await importFile(u, syntheticDoc('Half imported'));
			expect(res.status).toBe(500);
			expect(res.body).toEqual({ error: 'Internal server error' });
		} finally {
			failSave.on = false;
		}
		expect(await projectNames(u)).toEqual([]);
		expect((await importFile(u, syntheticDoc('Whole import'))).status).toBe(201);
		expect(await projectNames(u)).toEqual(['Whole import']);
	});

	it('runs the model after importing with run=1', async () => {
		const u = await signUp('Runner');
		const res = await importFile(u, syntheticDoc('Run on import'), '?run=1');
		expect(res.status).toBe(201);
		expect(res.body.runId).toMatch(/^[0-9a-f-]{36}$/);
		expect(res.body.runError).toBeUndefined();
		const runs = (await u.call('GET', `/projects/${res.body.project.id}/runs`)).body.runs;
		expect(runs.map((r: { id: string; label: string }) => [r.id, r.label])).toEqual([[res.body.runId, 'Initial run (import)']]);
	});

	it('keeps the import when the requested run fails, and says why (runError)', async () => {
		const u = await signUp('Norun');
		// GR4J (the default) refuses to run without A-pan evaporation.
		const doc = { ...syntheticDoc('Cannot run yet'), settings: {} };
		const res = await importFile(u, doc, '?run=1');
		expect(res.status).toBe(201);
		expect(res.body.runId).toBeUndefined();
		expect(res.body.runError).toMatch(/^model run failed: /);
		expect(await projectNames(u)).toEqual(['Cannot run yet']);
		expect((await u.call('GET', `/projects/${res.body.project.id}/runs`)).body.runs).toEqual([]);
	});

	it('recomputes the fit record’s hand-edit list instead of trusting the file', async () => {
		const u = await signUp('Fitfile');
		const period = { start: '2022-01-01', end: '2022-01-30', waterYears: [2021], scores: { days: 30, kgePrime: 0.7 } };
		const fitRecord = {
			fittedAt: '2026-09-24T10:00:00.000Z',
			engineVersion: '0.6.0',
			model: 'gr4j',
			objective: 'kgePrime',
			bounds: 'wide',
			seed: 42,
			budget: 300,
			evaluations: 900,
			cancelled: false,
			free: ['x1', 'x3'],
			params: { x1: 500, x2: 0, x3: 60, x4: 1.7 },
			startParams: { x1: 350, x2: 0, x3: 90, x4: 1.7 },
			flowKind: 'flow_observed_m3s',
			simulatedKey: 'simulated_outflow',
			calibrationStart: null,
			calibrationEnd: null,
			exclusions: [],
			validate: false,
			validationRecord: null,
			fit: period,
			before: period,
			splitSample: null,
			differential: null,
			independentRecord: null,
			notes: [],
			editedParams: []
		};
		// The file's X1 has been edited since the fit, but it claims no edits.
		const doc = { ...syntheticDoc('Fit import'), settings: { apanMm: monthly(150), gr4j: { x1: 900, x2: 0, x3: 60, x4: 1.7 }, fitRecord } };
		const res = await importFile(u, doc);
		expect(res.status).toBe(201);
		expect(res.body.project.settings.fitRecord.editedParams).toEqual(['x1']);
	});

	it('imports an export from before engine 1.0.0: the legacy calibration keys are dropped, a legacy model is refused with the reason', async () => {
		const u = await signUp('Oldfile');
		const calibration = { a: 0.1, b: 1.3, summerMonths: [1, 2], recessionFactors: [0.9, 0.95], rainThresholdMm: 3, catchmentAreaKm2: null };
		const res = await importFile(u, { ...syntheticDoc('Old GR4J export'), settings: { apanMm: monthly(150), runoffModel: 'gr4j', calibration } });
		expect(res.status).toBe(201);
		expect(res.body.project.settings.calibration).toEqual({ rainThresholdMm: 3, catchmentAreaKm2: null });
		const legacy = await importFile(u, { ...syntheticDoc('Old legacy export'), settings: { apanMm: monthly(150), runoffModel: 'legacy', calibration } });
		expect(legacy.status).toBe(400);
		expect(JSON.stringify(legacy.body)).toMatch(/legacy runoff model was removed in engine 1\.0\.0/);
		expect(JSON.stringify(legacy.body)).not.toMatch(/violates|constraint|relation|syntax error|SQLSTATE/i);
	});

	it('accepts a file up to the export cap and refuses a larger one with 413 and a hint', async () => {
		const u = await signUp('Bigfile');
		// Six 60 000-day series (the per-series maximum): between the general
		// 4 MB body cap and the import cap, so only the import's own cap lets it in.
		const values = Array.from({ length: 60_000 }, (_, i) => i + 0.123456);
		const big = {
			...syntheticDoc('Large import'),
			series: Array.from({ length: 6 }, (_, k) => ({ kind: 'rain_catchment_mm', name: `gauge ${k}`, unit: 'mm', startDate: '1900-01-01', values }))
		};
		const body = JSON.stringify(big);
		expect(body.length).toBeGreaterThan(4 * 1024 * 1024);
		expect(body.length).toBeLessThan(IMPORT_MAX_BYTES);
		const ok = await postRaw(u, body);
		expect(ok.status).toBe(201);

		const tooBig = JSON.stringify({ ...big, series: [...big.series, { ...big.series[0]!, name: 'gauge 6' }, { ...big.series[0]!, name: 'gauge 7' }] });
		expect(tooBig.length).toBeGreaterThan(IMPORT_MAX_BYTES);
		for (const contentLength of [false, true]) {
			const res = await postRaw(u, tooBig, '', { contentLength });
			expect(res.status, `content-length: ${contentLength}`).toBe(413);
			expect(res.body.error).toMatch(/^project file larger than 5 MB — /);
		}
		expect(await projectNames(u)).toEqual(['Large import']);
	});
});
