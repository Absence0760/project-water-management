import { beforeAll, describe, expect, it } from 'vitest';
import { importProjectData } from '../../scripts/import-project.js';
import { app, asOwner, makeStoredLegacyRun, monthly, node, signUp } from '../__tests__/helpers.js';
import { CSV_DISCLAIMER_COMMENT } from '@water-management/engine';
import { LEGACY_RUN_CSV_COMMENT, runProvenanceComment } from './csv.js';
import { flowDurationTable } from './fdc.js';
import { localDate } from '../projects/timeZone.js';
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
/** A result CSV's lines after its disclaimer line, which must be the first (docs/legal/disclaimer-review.md § 1). */
const afterDisclaimer = (csv: string) => {
	const rows = lines(csv);
	expect(rows[0]).toBe(CSV_DISCLAIMER_COMMENT);
	return rows.slice(1);
};
/** A daily CSV's table (header row first): its lines after the leading `#` lines (the run's provenance, and a legacy run's warning). */
const table = (csv: string) => {
	const rows = lines(csv);
	while (rows[0]?.startsWith('#')) rows.shift();
	return rows;
};

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
				enabled: true,
				priority: 0
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
		const rows = table(res.text);
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
		const header = table(res.text)[0]!;
		// FarmTemplate order with the column letters, the intermediate columns included (engine 0.12.0).
		// The soil-water store (engine 0.14.0) sits with the demand columns. The crop
		// requirement is the workbook's F; the abstraction demand (N1) has no workbook letter.
		expect(header.split(',').slice(0, 8)).toEqual([
			'date',
			'Gross irrigation demand (before effective rain) (m³/day)',
			"Effective rain used against demand (from the day's rain or the soil store) (m³/day)",
			'Soil-water store at the end of the day (mm)',
			'Crop water requirement (net irrigation need) [F] (m³/day)',
			'Irrigation demand (abstraction: crop requirement ÷ efficiency) (m³/day)',
			'Irrigation supplied [G] (m³/day)',
			'Inflow from upstream [H] (m³/day)'
		]);
		expect(header).toContain('Dam storage [Q] (m³)');
		expect(header).toContain('Irrigation return flow [T] (m³/day)');
		const cols = header.split(',');
		const v = cols.indexOf('Balance check (should be 0) [V] (m³/day)');
		expect(v).toBe(cols.indexOf('Outflow [U] (m³/day)') + 1);
		// Every day's balance check is float noise.
		for (const r of table(res.text).slice(1)) expect(Math.abs(Number(r.split(',')[v]))).toBeLessThan(1e-6);
	});

	it('says which run made it on a leading # line (the catchment and all-farms files without a dam, a farm file with its dam)', async () => {
		const r = (await viewer.call('GET', `/projects/${projectId}/runs/${runId}`)).body.run;
		const run = {
			label: 'Baseline',
			engineVersion: r.engineVersion as string,
			runoffModel: 'gr4j',
			createdAt: new Date(r.createdAt).toISOString(),
			startDate: r.startDate as string,
			endDate: r.endDate as string
		};
		const base = `/projects/${projectId}/runs/${runId}/export`;
		const first = async (path: string) => afterDisclaimer((await download(viewer, path)).text).slice(0, 2);
		expect(await first(`${base}/daily.csv`)).toEqual([
			`# run=Baseline; engine=${run.engineVersion}; runoff_model=gr4j; created=${run.createdAt}; period=2024-02-15..2024-03-15`,
			expect.stringMatching(/^date,/)
		]);
		expect(await first(`${base}/daily.csv?nodeId=${farm.id}`)).toEqual([runProvenanceComment({ ...run, damCapacityM3: 200_000 }), expect.stringMatching(/^date,/)]);
		expect(await first(`${base}/daily.csv?nodeId=${farm2.id}`)).toEqual([runProvenanceComment({ ...run, damCapacityM3: 50_000 }), expect.stringMatching(/^date,/)]);
		// A gauge is not a farm: no dam key.
		expect(await first(`${base}/daily.csv?nodeId=${outlet.id}`)).toEqual([runProvenanceComment(run), expect.stringMatching(/^date,/)]);
		expect(await first(`${base}/farms.csv?key=runoff`)).toEqual([runProvenanceComment(run), expect.stringMatching(/^date,/)]);
		// The same line on a narrowed window: the period is the run's, not the window's.
		expect((await first(`${base}/daily.csv?from=2024-02-28&to=2024-03-01`))[0]).toBe(runProvenanceComment(run));
	});

	it('keeps a hostile run label inert and one line in the provenance line', async () => {
		const label = '=HYPERLINK("http://x","y"); engine=0.0.0\r\n2024-01-01,999';
		const made = await owner.call('POST', `/projects/${projectId}/runs`, { label });
		expect(made.status).toBe(201);
		const rows = afterDisclaimer((await download(viewer, `/projects/${projectId}/runs/${made.body.run.id}/export/daily.csv`)).text);
		expect(rows[0]).toMatch(/^# run=%3DHYPERLINK\(%22http:\/\/x%22%2C%22y%22\)%3B engine%3D0\.0\.0%0D%0A2024-01-01%2C999; engine=/);
		expect(rows[0]).not.toMatch(/[,"]/);
		expect(rows[1]).toMatch(/^date,/);
		expect(decodeURIComponent(/^# run=([^;]*);/.exec(rows[0]!)![1]!)).toBe(label);
		expect((await owner.call('DELETE', `/projects/${projectId}/runs/${made.body.run.id}`)).status).toBeLessThan(300);
	});

	it('honours a from/to window and rejects bad ones', async () => {
		const base = `/projects/${projectId}/runs/${runId}/export/daily.csv`;
		const res = await download(owner, `${base}?from=2024-02-28&to=2024-03-01`);
		expect(table(res.text).map((r) => r.slice(0, 10))).toEqual(['date,Natur', '2024-02-28', '2024-02-29', '2024-03-01']);
		expect((await download(owner, `${base}?from=2024-03-02&to=2024-03-01`)).status).toBe(400);
		expect((await download(owner, `${base}?from=2030-01-01`)).status).toBe(400);
		expect((await download(owner, `${base}?from=2024-02-31`)).status).toBe(400);
		expect((await download(owner, `${base}?nodeId=${crypto.randomUUID()}`)).status).toBe(404);
		expect((await download(owner, `${base}?nodeId=not-a-uuid`)).status).toBe(400);
	});
});

describe('all-farms daily export', () => {
	const base = () => `/projects/${projectId}/runs/${runId}/export/farms.csv`;
	/** One column of a farm's own daily CSV, by header. */
	async function farmColumn(nodeId: string, header: string) {
		const rows = table((await download(owner, `/projects/${projectId}/runs/${runId}/export/daily.csv?nodeId=${nodeId}`)).text);
		const i = rows[0]!.split(',').indexOf(header);
		expect(i, header).toBeGreaterThan(0);
		return rows.slice(1).map((r) => r.split(',')[i]);
	}
	/** The farm cells of a farms.csv data row (numbers only, so a plain split is safe). */
	const cells = (row: string) => row.split(',').slice(1);

	// The run's farm order is upstream first (Farm 2 drains into Farm "upper").
	it('puts every farm side by side in the run order, like [Fragmented flow] (I)', async () => {
		const res = await download(viewer, `${base()}?key=runoff`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toMatch(/_baseline_all-farms_runoff_daily_\d{4}-\d{2}-\d{2}\.csv"$/);
		expect(res.text.startsWith(BOM)).toBe(true);
		const rows = table(res.text);
		expect(rows[0]).toBe('date,Farm 2 [I] (m³/day),"Farm, ""upper"" [I] (m³/day)"');
		expect(rows).toHaveLength(DAYS + 1);
		expect(rows[1]!.startsWith('2024-02-15,')).toBe(true);
		// The same numbers as each farm's own daily CSV, column I.
		const upper = await farmColumn(farm.id, 'Farm runoff [I] (m³/day)');
		const lower = await farmColumn(farm2.id, 'Farm runoff [I] (m³/day)');
		expect(rows.slice(1).map(cells)).toEqual(lower.map((l, d) => [l, upper[d]]));
		expect(upper.some((v) => Number(v) > 0)).toBe(true); // not a table of zeros
	});

	it('exports the fragmented EWR (Y) the same way', async () => {
		const rows = table((await download(owner, `${base()}?key=ewr`)).text);
		expect(rows[0]).toBe('date,Farm 2 [Y] (m³/day),"Farm, ""upper"" [Y] (m³/day)"');
		const upper = await farmColumn(farm.id, 'EWR share [Y] (m³/day)');
		const lower = await farmColumn(farm2.id, 'EWR share [Y] (m³/day)');
		expect(rows.slice(1).map(cells)).toEqual(lower.map((l, d) => [l, upper[d]]));
		// A constant monthly EWR split by share: positive every day for both farms.
		expect(upper.every((v) => Number(v) > 0) && lower.every((v) => Number(v) > 0)).toBe(true);
	});

	it('honours a from/to window and rejects a bad key or window', async () => {
		const rows = table((await download(owner, `${base()}?key=runoff&from=2024-02-28&to=2024-03-01`)).text);
		expect(rows.slice(1).map((r) => r.slice(0, 10))).toEqual(['2024-02-28', '2024-02-29', '2024-03-01']);
		expect((await download(owner, base())).status).toBe(400); // key is required
		expect((await download(owner, `${base()}?key=natural_flow`)).status).toBe(400); // a catchment series, not a farm one
		expect((await download(owner, `${base()}?key=runoff&from=2024-03-02&to=2024-03-01`)).status).toBe(400);
		expect((await download(owner, `${base()}?key=runoff&from=2030-01-01`)).status).toBe(400);
	});
});

describe('run summary export', () => {
	it('writes the farm table, catchment and calibration blocks', async () => {
		const res = await download(viewer, `/projects/${projectId}/runs/${runId}/export/summary.csv`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toMatch(/_baseline_summary_\d{4}-\d{2}-\d{2}\.csv"$/);
		const rows = afterDisclaimer(res.text);
		expect(rows[0]).toBe('Project,Catchment Ä / Export');
		expect(rows.some((r) => r.startsWith('"Farm, ""upper""",'))).toBe(true);
		expect(rows.some((r) => r.startsWith('Farm 2,'))).toBe(true);
		// Each farm's flow share as the run applied it (engine 0.27.0), in %, right after the name; together 100 %.
		const header = rows.find((r) => r.startsWith('Farm,Flow share (%),'));
		expect(header).toBeDefined();
		const lower = Number(rows.find((r) => r.startsWith('Farm 2,'))!.split(',')[1]);
		const upper = Number(rows.find((r) => r.startsWith('"Farm, ""upper""",'))!.split(',')[2]); // the quoted name holds a comma
		expect(lower).toBeGreaterThan(0);
		expect(upper).toBeGreaterThan(0);
		expect(lower + upper).toBeCloseTo(100, 9);
		// The runoff model the run used, and each dam's capacity from the run's own model (hydrologist review, #17).
		expect(rows.some((r) => /^Runoff model,\w+$/.test(r))).toBe(true);
		const cap = header!.split(',').indexOf('Dam capacity (m³)');
		expect(cap).toBeGreaterThan(0);
		expect(rows.find((r) => r.startsWith('Farm 2,'))!.split(',')[cap]).toBe('50000');
		expect(rows.find((r) => r.startsWith('"Farm, ""upper""",'))!.split(',')[cap + 1]).toBe('200000'); // + 1: the name's comma
		expect(rows).toContain('Catchment');
		expect(rows.some((r) => r.startsWith('NSE,'))).toBe(true);
		// The engine's self-checks and the water balance (engine 0.12.0).
		expect(rows).toContain('Self-checks');
		expect(rows).toContain('All passed,yes');
		// incl. the soil-water store (engine 0.14.0), the EWR attribution (0.17.0), groundwater (0.23.0), land cover (0.24.0) and registered volumes (1.18.0)
		expect(rows.filter((r) => r.endsWith(',passed,'))).toHaveLength(10);
		// The curtailment table names its EWR attribution rule, and the EWR sites follow it (Q17).
		expect(rows).toContain('Curtailment targets');
		expect(rows.some((r) => r.startsWith('EWR attribution,"net impact pro rata (Q17)'))).toBe(true);
		expect(rows).toContain('EWR sites (reporting window)');
		expect(rows).toContain('Water balance by water year (Oct–Sep)');
		expect(rows.some((r) => r.startsWith('Whole run,'))).toBe(true);
		expect(rows).toContain('Farm daily columns (the daily CSV of a farm)');
		// The FDC chart's Q10–Q95 table (issue #45), from the run's own catchment series: the natural row is
		// the daily CSV's natural flow column in m³/s through the same engine function.
		expect(rows).toContain('Days ranked,Flow record,Q10 (m³/s),Q50 (m³/s),Q90 (m³/s),Q95 (m³/s),Days');
		const fdc = rows.filter((r) => r.startsWith('Whole run,Natural,') || r.startsWith('Whole run,Simulated outflow,') || r.startsWith('Whole run,Observed,'));
		expect(fdc).toHaveLength(3);
		const daily = table((await download(viewer, `/projects/${projectId}/runs/${runId}/export/daily.csv`)).text);
		const naturalM3Day = daily.slice(1).map((r) => (r.split(',')[1] === '' ? null : Number(r.split(',')[1])));
		const expected = flowDurationTable([{ key: 'natural_flow', values: naturalM3Day }]).wholeRun[0]!;
		expect(fdc[0]!.split(',').slice(2).map(Number)).toEqual([expected.q10, expected.q50, expected.q90, expected.q95, expected.n]);
	});

	it('dates the file name by the project’s time zone, not UTC (issue #45)', async () => {
		// Two zones 25 hours apart are never on the same calendar day, so the name shows which one was used.
		const dated = async (zone: string) => {
			expect((await owner.call('PATCH', `/projects/${projectId}`, { timeZone: zone })).status).toBe(200);
			const before = new Date();
			const res = await download(viewer, `/projects/${projectId}/runs/${runId}/export/summary.csv`);
			const after = new Date();
			const date = /_(\d{4}-\d{2}-\d{2})\.csv"$/.exec(res.headers.get('content-disposition') ?? '')?.[1];
			expect([localDate(before, zone), localDate(after, zone)]).toContain(date);
			return date;
		};
		try {
			expect(await dated('Pacific/Kiritimati')).not.toBe(await dated('Pacific/Pago_Pago'));
		} finally {
			expect((await owner.call('PATCH', `/projects/${projectId}`, { timeZone: 'Africa/Johannesburg' })).status).toBe(200);
		}
	});

	it('404s for a run of another project', async () => {
		const other = await owner.call('POST', '/projects', { name: 'Other' });
		const res = await download(owner, `/projects/${other.body.project.id}/runs/${runId}/export/summary.csv`);
		expect(res.status).toBe(404);
	});
});

describe('legacy run CSV comment (audit H1)', () => {
	let legacyProjectId: string;
	let legacyRunId: string;

	beforeAll(async () => {
		const { body } = await owner.call('POST', '/projects', { name: 'Legacy export' });
		legacyProjectId = body.project.id;
		expect((await owner.call('PATCH', `/projects/${legacyProjectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
		const legacyOutlet = node('Outlet', null);
		const legacyFarm = node('Farm', legacyOutlet.id);
		expect((await owner.call('PUT', `/projects/${legacyProjectId}/model`, { nodes: [legacyOutlet, legacyFarm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		expect(
			(await owner.call('PUT', `/projects/${legacyProjectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2024-01-01', values: rain })).status
		).toBe(200);
		const run = await owner.call('POST', `/projects/${legacyProjectId}/runs`, { label: 'Legacy' });
		expect(run.status).toBe(201);
		legacyRunId = run.body.run.id;
		// Saved on the legacy model before engine 1.0.0 removed it (the API can't make one now).
		await makeStoredLegacyRun(legacyRunId);
	});

	it('starts daily.csv and summary.csv with the legacy comment, the disclaimer, the provenance line and the header after it', async () => {
		const daily = await download(owner, `/projects/${legacyProjectId}/runs/${legacyRunId}/export/daily.csv`);
		const dailyRows = lines(daily.text);
		// The warning first (row 1 says so, as on summary.csv), the disclaimer, then the run's provenance, then the header.
		expect(dailyRows[0]).toBe(LEGACY_RUN_CSV_COMMENT);
		expect(dailyRows[1]).toBe(CSV_DISCLAIMER_COMMENT);
		expect(dailyRows[2]).toMatch(/^# run=Legacy; engine=[^;]+; runoff_model=legacy; created=[^;]+; period=2024-01-01\.\.\d{4}-\d{2}-\d{2}$/);
		expect(dailyRows[3]).toMatch(/^date,/);
		expect(daily.text.startsWith(BOM)).toBe(true);

		const summary = await download(owner, `/projects/${legacyProjectId}/runs/${legacyRunId}/export/summary.csv`);
		const summaryRows = lines(summary.text);
		expect(summaryRows[0]).toBe(LEGACY_RUN_CSV_COMMENT);
		expect(summaryRows[1]).toBe(CSV_DISCLAIMER_COMMENT);
		expect(summaryRows[2]).toBe('Project,Legacy export');
	});

	it('does not prefix a GR4J run’s exports (positive control, the Baseline run from the outer suite)', async () => {
		const daily = await download(owner, `/projects/${projectId}/runs/${runId}/export/daily.csv`);
		expect(afterDisclaimer(daily.text)[0]).toMatch(/^# run=Baseline; /);
		expect(lines(daily.text)).not.toContain(LEGACY_RUN_CSV_COMMENT);
		const summary = await download(owner, `/projects/${projectId}/runs/${runId}/export/summary.csv`);
		expect(afterDisclaimer(summary.text)[0]).toBe('Project,Catchment Ä / Export');
	});
});

describe('all-farms export after the network changed', () => {
	it('uses a renamed farm\'s current name and keeps a deleted farm, named as the run knew it (a run keeps its series, 024_scenarios)', async () => {
		const { body } = await owner.call('POST', '/projects', { name: 'Changed network' });
		const pid = body.project.id;
		const out = node('Outlet', null);
		const a = node('Farm A', out.id);
		const b = node('Farm B', out.id);
		await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(150) } });
		const put = (nodes: unknown[]) => owner.call('PUT', `/projects/${pid}/model`, { nodes, crops: [], cropAreas: [], transfers: [] });
		expect((await put([out, a, b])).status).toBe(200);
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2024-01-01', values: rain })).status).toBe(200);
		const run = await owner.call('POST', `/projects/${pid}/runs`, { label: 'Before' });
		expect(run.status).toBe(201);
		const path = `/projects/${pid}/runs/${run.body.run.id}/export/farms.csv?key=runoff`;
		expect(table((await download(owner, path)).text)[0]).toBe('date,Farm A [I] (m³/day),Farm B [I] (m³/day)'); // positive control

		expect((await put([out, { ...a, name: 'Farm A (renamed)' }])).status).toBe(200);
		expect(table((await download(owner, path)).text)[0]).toBe('date,Farm A (renamed) [I] (m³/day),Farm B [I] (m³/day)');
	});
});

describe('land cover in the farm exports (WP-1.35)', () => {
	it('puts the land-cover reduction beside runoff I, which adds back to natural × share, and the all-farms table accepts it', async () => {
		const { body } = await owner.call('POST', '/projects', { name: 'Invaded' });
		const pid = body.project.id;
		await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(150) } });
		// Equal areas, so equal shares: the clear farm's runoff is natural flow × that share.
		const out = node('Outlet', null);
		const invaded = node('Invaded farm', out.id, { areaKm2: 10 });
		const clear = node('Clear farm', out.id, { areaKm2: 10 });
		const patch = { id: crypto.randomUUID(), nodeId: invaded.id, coverClass: 'invasive', areaKm2: 3, densityPct: 0.6, factors: null };
		expect((await owner.call('PUT', `/projects/${pid}/model`, { nodes: [out, invaded, clear], crops: [], cropAreas: [], transfers: [], landCover: [patch] })).status).toBe(200);
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2024-01-01', values: rain })).status).toBe(200);
		const run = await owner.call('POST', `/projects/${pid}/runs`, { label: 'Invaded' });
		expect(run.status).toBe(201);
		const base = `/projects/${pid}/runs/${run.body.run.id}/export`;

		// The daily CSV: the reduction right after I.
		const rows = table((await download(owner, `${base}/daily.csv?nodeId=${invaded.id}`)).text);
		// Header cells, RFC 4180: the land-cover label has a comma, so it is quoted. Data rows are plain numbers.
		const cols = [...rows[0]!.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)].map((m) => m[1]!.replace(/^"|"$/g, '').replace(/""/g, '"')).slice(0, -1);
		const i = cols.indexOf('Farm runoff [I] (m³/day)');
		expect(cols[i + 1]).toBe('Runoff removed by land cover (invasive plants, forestry) (m³/day)');
		const all = table((await download(owner, `${base}/farms.csv?key=runoff`)).text);
		const clearCol = all[0]!.split(',').indexOf('Clear farm [I] (m³/day)');
		expect(clearCol).toBeGreaterThan(0);
		const clearRunoff = all.slice(1).map((r) => Number(r.split(',')[clearCol]));
		let removed = 0;
		rows.slice(1).forEach((r, d) => {
			const [I, red] = [Number(r.split(',')[i]), Number(r.split(',')[i + 1])];
			expect(I + red).toBeCloseTo(clearRunoff[d]!, 6);
			removed += red;
		});
		expect(removed).toBeGreaterThan(0); // positive control: the cover did remove runoff

		// The all-farms table takes the reduction too; only the farm with land cover has the series.
		const cover = await download(owner, `${base}/farms.csv?key=landcover_reduction`);
		expect(cover.status).toBe(200);
		expect(table(cover.text)[0]).toBe('date,Invaded farm (m³/day)');
		expect(table(cover.text)).toHaveLength(rain.length + 1);
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
		// Eight 60 000-day gauges (~7 MB as JSON), built in one statement: the
		// export's refusal is under test, not the series PUT, and eight 60 000-value
		// PUTs cost ~0.7 s of API parsing and inserts (the same series the PUT path
		// would store, which the series routes' own tests cover).
		await asOwner(
			`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
			 SELECT $1, 'rain_catchment_mm', 'gauge ' || k, 'mm', '1900-01-01', v.a
			 FROM generate_series(0, 7) k, (SELECT array_agg(1.23456789 + i ORDER BY i)::float8[] AS a FROM generate_series(0, 59999) i) v`,
			[body.project.id]
		);
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
			`/projects/${projectId}/runs/${runId}/export/farms.csv?key=runoff`,
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
