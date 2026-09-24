import { beforeAll, describe, expect, it } from 'vitest';
import { importProjectData } from '../../scripts/import-project.js';
import { app, monthly, node, signUp } from '../__tests__/helpers.js';
import { ProjectFile, type ProjectDocument } from '../projects/document.js';

type User = Awaited<ReturnType<typeof signUp>>;
const BOM = '\uFEFF';

/** Raw GET (the helper's `call` parses JSON; these bodies are CSV). */
async function download(u: User, path: string) {
	const res = await app.request(path, { headers: { cookie: u.cookie, origin: 'http://localhost:7777' } });
	// Decode by hand: Response.text() silently drops a leading BOM.
	const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
	return { status: res.status, headers: res.headers, text };
}

const lines = (csv: string) => csv.replace(BOM, '').replace(/\r\n$/, '').split('\r\n');

let owner: User;
let viewer: User;
let stranger: User;
let projectId: string;
let runId: string;
let rainId: string;
const outlet = node('Gauge', null);
const farm = node('Farm, "upper"', outlet.id, { damCapacityM3: 200_000 });
const farm2 = node('Farm 2', farm.id, { damCapacityM3: 50_000 });
const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
const DAYS = 30;
const rain = Array.from({ length: DAYS }, (_, i) => (i % 7 === 0 ? 25 : i === 3 ? null : 0));

beforeAll(async () => {
	owner = await signUp('Owner');
	viewer = await signUp('Viewer');
	stranger = await signUp('Stranger');
	const { body } = await owner.call('POST', '/projects', { name: 'Catchment Ä / Export', description: 'round trip' });
	projectId = body.project.id;
	await owner.call('PATCH', `/projects/${projectId}`, {
		settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(500), effectiveRainFraction: 0.6 }
	});
	const model = {
		nodes: [outlet, farm, farm2],
		crops: [crop],
		cropAreas: [
			{ nodeId: farm.id, cropId: crop.id, areaM2: 50_000 },
			{ nodeId: farm2.id, cropId: crop.id, areaM2: 20_000 }
		],
		transfers: [
			{
				id: crypto.randomUUID(),
				fromNodeId: farm.id,
				toNodeId: farm2.id,
				months: [1, 2, 3],
				maxRateM3s: 0.01,
				dailyCapM3: null,
				minStoragePct: 0.2,
				enabled: true
			}
		]
	};
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	const put = await owner.call('PUT', `/projects/${projectId}/series`, {
		kind: 'rain_catchment_mm',
		unit: 'mm',
		startDate: '2024-02-15',
		values: rain
	});
	rainId = put.body.id;
	await owner.call('PUT', `/projects/${projectId}/series`, {
		kind: 'flow_observed_m3s',
		name: 'Gauge A',
		unit: 'm3/s',
		startDate: '2024-02-15',
		values: rain.map((r) => (r === null ? null : 0.01 + r / 1000))
	});
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'Baseline' });
	expect(run.status).toBe(201);
	runId = run.body.run.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
});

describe('run daily export', () => {
	it('exports the catchment series with dates, units, BOM and a slugged file name', async () => {
		const res = await download(viewer, `/projects/${projectId}/runs/${runId}/export/daily.csv`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(res.headers.get('content-disposition')).toMatch(
			/^attachment; filename="catchment-a-export_baseline_catchment_daily_\d{4}-\d{2}-\d{2}\.csv"$/
		);
		expect(res.text.startsWith(BOM)).toBe(true);
		const rows = lines(res.text);
		expect(rows[0]).toMatch(/^date,Natural flow \(m³\/day\),Simulated outflow \(m³\/day\),Observed flow \(m³\/day\),Pragmatic EWR/);
		expect(rows).toHaveLength(DAYS + 1);
		expect(rows[1]!.startsWith('2024-02-15,')).toBe(true);
		expect(rows[15]!.startsWith('2024-02-29,')).toBe(true); // leap day
		expect(rows[DAYS]!.startsWith('2024-03-15,')).toBe(true);
		// every row has the header's column count
		const n = rows[0]!.split(',').length;
		for (const r of rows.slice(1)) expect(r.split(',').length).toBe(n);
	});

	it('exports one node, quoting its name in the file only as a slug', async () => {
		const res = await download(owner, `/projects/${projectId}/runs/${runId}/export/daily.csv?nodeId=${farm.id}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toContain('_baseline_farm-upper_daily_');
		const header = lines(res.text)[0]!;
		// FarmTemplate order with the column letters, the intermediate columns included (engine 0.11.0).
		expect(header.split(',').slice(0, 6)).toEqual([
			'date',
			'Gross irrigation demand (before effective rain) (m³/day)',
			'Effective rain on the cropped area (m³/day)',
			'Irrigation demand (net) [F] (m³/day)',
			'Irrigation supplied [G] (m³/day)',
			'Inflow from upstream [H] (m³/day)'
		]);
		expect(header).toContain('Dam storage [Q] (m³)');
		expect(header).toContain('Irrigation return flow [T] (m³/day)');
		const cols = header.split(',');
		const v = cols.indexOf('Balance check (should be 0) [V] (m³/day)');
		expect(v).toBe(cols.indexOf('Outflow [U] (m³/day)') + 1);
		// Every day's balance check is float noise.
		for (const r of lines(res.text).slice(1)) expect(Math.abs(Number(r.split(',')[v]))).toBeLessThan(1e-6);
	});

	it('honours a from/to window and rejects bad ones', async () => {
		const base = `/projects/${projectId}/runs/${runId}/export/daily.csv`;
		const res = await download(owner, `${base}?from=2024-02-28&to=2024-03-01`);
		expect(lines(res.text).map((r) => r.slice(0, 10))).toEqual(['date,Natur', '2024-02-28', '2024-02-29', '2024-03-01']);
		expect((await download(owner, `${base}?from=2024-03-02&to=2024-03-01`)).status).toBe(400);
		expect((await download(owner, `${base}?from=2030-01-01`)).status).toBe(400);
		expect((await download(owner, `${base}?from=2024-02-31`)).status).toBe(400);
		expect((await download(owner, `${base}?nodeId=${crypto.randomUUID()}`)).status).toBe(404);
		expect((await download(owner, `${base}?nodeId=not-a-uuid`)).status).toBe(400);
	});
});

describe('run summary export', () => {
	it('writes the farm table, catchment and calibration blocks', async () => {
		const res = await download(viewer, `/projects/${projectId}/runs/${runId}/export/summary.csv`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toMatch(/_baseline_summary_\d{4}-\d{2}-\d{2}\.csv"$/);
		const rows = lines(res.text);
		expect(rows[0]).toBe('Project,Catchment Ä / Export');
		expect(rows.some((r) => r.startsWith('"Farm, ""upper""",'))).toBe(true);
		expect(rows.some((r) => r.startsWith('Farm 2,'))).toBe(true);
		expect(rows).toContain('Catchment');
		expect(rows.some((r) => r.startsWith('NSE,'))).toBe(true);
		// The engine's self-checks and the water balance (engine 0.11.0).
		expect(rows).toContain('Self-checks');
		expect(rows).toContain('All passed,yes');
		expect(rows.filter((r) => r.endsWith(',passed,'))).toHaveLength(5);
		expect(rows).toContain('Water balance by water year (Oct–Sep)');
		expect(rows.some((r) => r.startsWith('Whole run,'))).toBe(true);
		expect(rows).toContain('Farm daily columns (the daily CSV of a farm)');
	});

	it('404s for a run of another project', async () => {
		const other = await owner.call('POST', '/projects', { name: 'Other' });
		const res = await download(owner, `/projects/${other.body.project.id}/runs/${runId}/export/summary.csv`);
		expect(res.status).toBe(404);
	});
});

describe('input series export', () => {
	it('exports one series as date,value with empty cells for missing days', async () => {
		const res = await download(viewer, `/projects/${projectId}/series/${rainId}/export.csv`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toMatch(/_rain-catchment-mm_\d{4}-\d{2}-\d{2}\.csv"$/);
		const rows = lines(res.text);
		expect(rows.slice(0, 5)).toEqual(['date,rain_catchment_mm (mm)', '2024-02-15,25', '2024-02-16,0', '2024-02-17,0', '2024-02-18,']);
		expect(rows).toHaveLength(DAYS + 1);
	});
});

describe('project document export', () => {
	it('round-trips through pnpm import:project', async () => {
		const res = await download(owner, `/projects/${projectId}/export.json`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
		expect(res.headers.get('content-disposition')).toMatch(/filename="catchment-a-export_project_\d{4}-\d{2}-\d{2}\.json"/);
		const doc = JSON.parse(res.text) as ProjectDocument;
		expect(doc.format).toBe('water-management/project');
		expect(ProjectFile.safeParse(doc).success).toBe(true);

		const copyId = await importProjectData(doc, owner.email);
		expect(copyId).not.toBe(projectId);
		const again = JSON.parse((await download(owner, `/projects/${copyId}/export.json`)).text) as ProjectDocument;
		expect(normalize(again)).toEqual(normalize(doc));
		// fresh ids, same content
		expect(again.model.nodes.map((n) => n.id)).not.toContain(outlet.id);
	});

	it('refuses an export larger than the Lambda response budget with 413', async () => {
		const u = await signUp('Big');
		const { body } = await u.call('POST', '/projects', { name: 'Big' });
		const values = Array.from({ length: 60_000 }, (_, i) => 1.23456789 + i);
		for (let k = 0; k < 8; k++) {
			const r = await u.call('PUT', `/projects/${body.project.id}/series`, {
				kind: 'rain_catchment_mm',
				name: `gauge ${k}`,
				unit: 'mm',
				startDate: '1900-01-01',
				values
			});
			expect(r.status).toBe(200);
		}
		const res = await download(u, `/projects/${body.project.id}/export.json`);
		expect(res.status).toBe(413);
		expect(JSON.parse(res.text).error).toMatch(/larger than 5 MB/);
	});
});

describe('export access', () => {
	it('hides every export from non-members (404) and requires a session (401)', async () => {
		const paths = [
			`/projects/${projectId}/runs/${runId}/export/daily.csv`,
			`/projects/${projectId}/runs/${runId}/export/summary.csv`,
			`/projects/${projectId}/series/${rainId}/export.csv`,
			`/projects/${projectId}/export.json`
		];
		for (const p of paths) {
			expect((await download(viewer, p)).status, `viewer ${p}`).toBe(200); // positive control
			expect((await download(stranger, p)).status, `stranger ${p}`).toBe(404);
			expect((await app.request(p)).status, `anonymous ${p}`).toBe(401);
		}
	});
});

/** Replace ids with names so two imports of the same project compare equal. */
function normalize(d: ProjectDocument) {
	const nodeName = new Map(d.model.nodes.map((n) => [n.id, n.name]));
	const cropName = new Map(d.model.crops.map((c) => [c.id, c.name]));
	return {
		name: d.name,
		description: d.description,
		settings: d.settings,
		engineVersion: d.engineVersion,
		series: d.series,
		nodes: d.model.nodes
			.map(({ id: _id, downstreamNodeId, ...n }) => ({ ...n, downstream: downstreamNodeId && nodeName.get(downstreamNodeId) }))
			.sort((a, b) => a.name.localeCompare(b.name)),
		crops: d.model.crops.map(({ id: _id, ...c }) => c).sort((a, b) => a.name.localeCompare(b.name)),
		cropAreas: d.model.cropAreas
			.map((a) => ({ node: nodeName.get(a.nodeId), crop: cropName.get(a.cropId), areaM2: a.areaM2 }))
			.sort((a, b) => String(a.node).localeCompare(String(b.node))),
		transfers: d.model.transfers.map(({ id: _id, fromNodeId, toNodeId, ...t }) => ({
			...t,
			from: nodeName.get(fromNodeId),
			to: nodeName.get(toNodeId)
		}))
	};
}
