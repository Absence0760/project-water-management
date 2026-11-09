// Evaporation proposed from the map (issue #326 B-evap;
// 180_evaporation_reference.sql, 181_evaporation_accepted.sql,
// geo/evaporationRoutes.ts), end to end against Postgres with the committed
// synthetic grid loaded (reference ET, kind et0; the four cells centred on
// 21.3–21.4° E, 33.6–33.7° S hold the base row exactly):
//  - a viewer reads the proposal over the catchment boundary: the base row,
//    its annual sum, full coverage, the dataset cited and marked synthetic,
//    which settings it goes into (GR4J's PE), and what the settings hold now;
//  - an editor accepts it: settings.pe becomes the monthly row with a source
//    naming the dataset, the A-pan row and pan coefficient are untouched (no
//    conversion), one settings revision whose reason names the dataset,
//    version and method, and a provenance row that stops being current once
//    the row is typed over; a viewer can't;
//  - an A-pan dataset's values go into the A-pan row instead, and leave the
//    PE input alone;
//  - an A-pan dataset whose source states no period (317, issue #755) is
//    read, proposed and cited without one, and 317's check keeps a period
//    both years or neither (neither only for A-pan);
//  - the S-pan kind (316) is gone again (318, issue #738: the WRC Atlas has
//    no S-pan grids): its CHECK refuses one;
//  - the CCWR A-pan grid (Atlas-Apan-2007) asked for by label is none loaded
//    (200, dataset null) until it is loaded, then proposed and used as the
//    A-pan row with a revision citing it as modelled; any grid asked for that
//    isn't loaded reads the same;
//  - refusals: no boundary, a boundary over cells with no value, accepting an
//    unknown dataset, an extra field (400); a stranger (404); a farmer (403);
//  - the loader writes the grid and its dataset row, and a reload replaces them;
//  - the grid is read-only to the app role (control: it reads it); the
//    provenance's target must match its kind.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSyntheticEvaporation } from '../../scripts/import-evaporation.js';
import { asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { ATLAS_APAN, atlasApanMethodFor, replaceEvaporationDataset } from './evaporationGrid.js';
import type { Position } from './geojson.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let farmer: User;
let projectId: string;
let bareProjectId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const rect = (w: number, s: number, e: number, n: number): Position[][] => [
	[
		[w, s],
		[e, s],
		[e, n],
		[w, n],
		[w, s]
	]
];
/** Inside the synthetic grid's four base cells. */
const BOUNDARY = rect(21.26, -33.74, 21.44, -33.56);
/** Over the synthetic grid's "sea" (no values). */
const AT_SEA = rect(20.5, -34.5, 20.8, -34.3);
const BASE = [120, 150, 175, 180, 150, 130, 90, 65, 50, 55, 75, 95];

const at = (p: string, pid = projectId) => `/projects/${pid}${p}`;
const proposals = (u: User, q = '', pid = projectId) => u.call('GET', at(`/evaporation-proposals${q}`, pid));
const accept = (u: User, body: Record<string, unknown>, pid = projectId) => u.call('POST', at('/evaporation-from-map', pid), body);
const lastReason = async (pid = projectId) => (await asOwner('SELECT reason FROM model_revision WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [pid]))[0]!.reason as string;
const settings = async () => (await owner.call('GET', at(''))).body.project.settings;

beforeAll(async () => {
	[owner, editor, viewer, stranger, farmer] = (await Promise.all(['Eowner', 'Eeditor', 'Eviewer', 'Estranger', 'Efarmer'].map((n) => signUp(n)))) as [User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Evaporation from the map' })).body.project.id;
	expect((await owner.call('PUT', at('/model'), { nodes: [outlet, farmA], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', at('/members'), { email: u.email, role })).status).toBe(201);
	expect((await owner.call('POST', at('/farmers'), { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	bareProjectId = (await owner.call('POST', '/projects', { name: 'No boundary yet' })).body.project.id;
	await loadSyntheticEvaporation(process.env.TEST_MIGRATION_DATABASE_URL!);
	const b = await editor.call('POST', at('/map/features'), { kind: 'catchment_boundary', name: 'Catchment', geometry: { type: 'Polygon', coordinates: BOUNDARY } });
	expect(b.status, JSON.stringify(b.body)).toBe(201);
}, 60_000);

afterAll(async () => {
	await asOwner(`DELETE FROM evaporation_dataset WHERE dataset = ANY($1::text[])`, [['test-apan', 'test-apan-no-period']]);
});

describe('the proposal', () => {
	it('gives a viewer the boundary’s monthly means, the dataset cited, where they go and what the settings hold', async () => {
		const res = await proposals(viewer);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const b = res.body;
		expect(b.dataset).toMatchObject({ dataset: 'synthetic', kind: 'et0', version: 'synthetic 1', firstYear: 1991, lastYear: 2020, cellDeg: 0.1, synthetic: true, source: expect.stringMatching(/^SYNTHETIC/) });
		expect(b.dataset.originLon).toBeCloseTo(0.05, 9);
		expect(b.dataset.method).toMatch(/^Pre-summarised at import: each 0.1° cell's daily reference evapotranspiration \(ET₀\) summed into calendar-month totals and averaged over 1991–2020/);
		expect(b.datasets).toEqual(expect.arrayContaining([{ dataset: 'synthetic', kind: 'et0', version: 'synthetic 1', synthetic: true }]));
		expect(b.boundary).toMatchObject({ name: 'Catchment' });
		expect(b.target).toBe('pe');
		expect(b.proposal).toEqual({ monthlyMm: BASE, annualMm: 1335, coverage: 1, cells: 4 });
		expect(b.settings).toEqual({ apanMm: Array(12).fill(0), peKind: 'pan', peMm: null, dailyApan: null });
		expect(b.accepted).toEqual([]);
	});

	it('says which days a daily A-pan record covers, so the panel can say it still drives them (round 4)', async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Daily A-pan record' })).body.project.id as string;
		expect((await proposals(owner, '', pid)).body.settings.dailyApan).toBeNull();
		// Its last day is the last with a value: a trailing blank isn't data.
		await asOwner(`INSERT INTO time_series (project_id, kind, unit, start_date, "values") VALUES ($1, 'evap_apan_mm', 'mm', '2020-01-30', ARRAY[5, 6, NULL]::float8[])`, [pid]);
		expect((await proposals(owner, '', pid)).body.settings.dailyApan).toEqual({ from: '2020-01-30', to: '2020-01-31' });
	});

	it('says why there is nothing to propose, answers a grid that isn’t loaded as none loaded, and is 404 for a stranger, 403 for a farmer', async () => {
		const bare = (await proposals(owner, '', bareProjectId)).body;
		expect(bare).toMatchObject({ boundary: null, proposal: null, dataset: { dataset: 'synthetic' } });
		// Model settings → Demand asks for the CCWR A-pan grid by label: not loaded is none loaded, the loaded grids still listed.
		const none = await proposals(viewer, '?dataset=nope');
		expect(none.status).toBe(200);
		expect(none.body).toMatchObject({ dataset: null, target: null, proposal: null, boundary: { name: expect.any(String) } });
		expect(none.body.datasets.map((d: { dataset: string }) => d.dataset)).toContain('synthetic');
		expect((await proposals(stranger)).status).toBe(404);
		expect((await proposals(farmer)).status).toBe(403);
		expect((await accept(farmer, { dataset: 'synthetic' })).status).toBe(403);
	});
});

describe('accepting the proposal', () => {
	it('writes GR4J’s monthly PE with its source, leaves the A-pan row and pan coefficient alone, and cites the dataset; a viewer can’t', async () => {
		expect((await accept(viewer, { dataset: 'synthetic' })).status).toBe(403);
		const before = await settings();
		const res = await accept(editor, { dataset: 'synthetic' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ target: 'pe', monthlyMm: BASE, dataset: 'synthetic', revisionId: expect.any(String) });
		const s = await settings();
		expect(s.pe).toEqual({ kind: 'monthly', mm: BASE, source: expect.stringMatching(/^Proposed from the map: reference evapotranspiration \(FAO-56 Penman-Monteith ET₀\), SYNTHETIC .*synthetic 1, 1991–2020 monthly means; dataset “synthetic”\), area-weighted over the 4 grid cells the catchment boundary “Catchment” covers \(100 % of it has values\); taken as GR4J's PE unchanged\.$/) });
		expect(s.apanMm).toEqual(before.apanMm);
		expect(s.panCoefficient).toEqual(before.panCoefficient);
		expect(await lastReason()).toMatch(/^GR4J’s monthly PE from the map: 1335 mm a year of reference evapotranspiration .*; SYNTHETIC .* Pre-summarised at import/);
		const acc = (await proposals(viewer)).body.accepted;
		expect(acc).toEqual([
			expect.objectContaining({ target: 'pe', kind: 'et0', monthlyMm: BASE, dataset: 'synthetic', version: 'synthetic 1', coverage: 1, current: true })
		]);
		expect((await proposals(viewer)).body.settings).toMatchObject({ peKind: 'monthly', peMm: BASE });
		// The boundary it was summarised over, as it stood (273, issue #646 F8): the map's list carries it for the Checks.
		const map = (await viewer.call('GET', at('/map/features'))).body;
		const b = map.features.find((f: { kind: string }) => f.kind === 'catchment_boundary');
		expect(map.accepted.evaporation).toEqual([{ target: 'pe', boundary: { featureId: b.id, updatedAt: b.updatedAt, areaM2: b.areaM2 } }]);
	});

	it('the provenance stops being current once the row is typed over', async () => {
		const s = await settings();
		const typed = { ...s.pe, mm: BASE.map((v, i) => (i === 3 ? v + 10 : v)) };
		expect((await editor.call('PATCH', at(''), { settings: { pe: typed } })).status).toBe(200);
		expect((await proposals(viewer)).body.accepted[0]).toMatchObject({ target: 'pe', current: false });
	});

	it('an A-pan dataset fills the A-pan row and leaves the PE input alone', async () => {
		await asOwner(
			`INSERT INTO evaporation_dataset (dataset, kind, source, version, method, attribution, first_year, last_year, cell_deg, origin_lon, origin_lat)
			 VALUES ('test-apan', 'apan', 'Test A-pan grid', 'v1', 'Test method.', 'none', 2000, 2009, 0.1, 0.05, 0.05)`
		);
		const row = [200, 210, 220, 230, 200, 180, 120, 90, 70, 75, 100, 150];
		// The boundary's four cells: rows ⌊(lat − 0.05) / 0.1⌋ = −338, −337; columns 212, 213.
		await asOwner(
			`INSERT INTO evaporation_cell_reference (dataset, row_idx, col_idx, monthly_mm)
			 SELECT 'test-apan', r, c, $1::real[] FROM unnest(ARRAY[-338, -337]) r, unnest(ARRAY[212, 213]) c`,
			[row]
		);
		const p = (await proposals(viewer, '?dataset=test-apan')).body;
		expect(p).toMatchObject({ target: 'apan', proposal: { monthlyMm: row, coverage: 1, cells: 4 } });
		const pe = (await settings()).pe;
		const res = await accept(editor, { dataset: 'test-apan' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ target: 'apan', monthlyMm: row });
		const s = await settings();
		expect(s.apanMm).toEqual(row);
		expect(s.pe).toEqual(pe);
		expect(await lastReason()).toMatch(/^A-pan evaporation from the map: 1845 mm a year of Class-A pan evaporation, .*; Test A-pan grid \(v1, 2000–2009 monthly means; dataset “test-apan”\)\. Test method\./);
		const acc = (await proposals(viewer)).body.accepted;
		expect(acc.map((a: { target: string; current: boolean }) => [a.target, a.current])).toEqual([
			['apan', true],
			['pe', false]
		]);
		// A real dataset is the default ahead of the synthetic one.
		expect((await proposals(viewer)).body.dataset.dataset).toBe('test-apan');
		await asOwner(`DELETE FROM evaporation_dataset WHERE dataset = 'test-apan'`);
	});

	it('an A-pan grid whose source states no period (issue #755) is read, proposed and cited without one; a dated grid is the control', async () => {
		const row = [190, 200, 210, 220, 190, 170, 110, 85, 65, 70, 95, 140];
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			// A short source, so the revision reason (500 characters) keeps the whole citation.
			const meta = { dataset: 'test-apan-no-period', kind: 'apan' as const, source: 'Test Atlas grid', version: 'v1', attribution: ATLAS_APAN.attribution, method: atlasApanMethodFor(0.1, null, null) };
			const cells = [-338, -337].flatMap((r) => [212, 213].map((c) => ({ row: r, col: c, monthlyMm: row })));
			expect(await replaceEvaporationDataset(client, meta, { cellDeg: 0.1, originLon: 0.05, originLat: 0.05, firstYear: null, lastYear: null, cells, partial: 0 })).toBe(4);
		} finally {
			await client.end();
		}
		expect(await asOwner(`SELECT first_year, last_year FROM evaporation_dataset WHERE dataset = 'test-apan-no-period'`)).toEqual([{ first_year: null, last_year: null }]);
		// A viewer reads it, its years null (the panel says no period, never "null–null").
		const p = (await proposals(viewer, '?dataset=test-apan-no-period')).body;
		expect(p).toMatchObject({ target: 'apan', dataset: { dataset: 'test-apan-no-period', firstYear: null, lastYear: null }, proposal: { monthlyMm: row, coverage: 1, cells: 4 } });
		// Control: a dated grid still carries its years.
		const dated = (await proposals(viewer, '?dataset=synthetic')).body;
		expect(dated.dataset).toMatchObject({ firstYear: 1991, lastYear: 2020 });
		const res = await accept(editor, { dataset: 'test-apan-no-period' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect((await settings()).apanMm).toEqual(row);
		const reason = await lastReason();
		expect(reason).toContain('Test Atlas grid (v1, monthly means, no period stated by the source; dataset “test-apan-no-period”)');
		expect(reason).not.toMatch(/null|NaN/);
		expect((await proposals(viewer, '?dataset=test-apan-no-period')).body.dataset.method).toContain('the Atlas states no period for its means');
		await asOwner(`DELETE FROM evaporation_dataset WHERE dataset = 'test-apan-no-period'`);
	});

	it('the CCWR A-pan grid (Atlas-Apan-2007) is none loaded until it is loaded, then proposed and used as the A-pan row, cited as modelled', async () => {
		expect((await proposals(viewer, '?dataset=Atlas-Apan-2007')).body).toMatchObject({ dataset: null, proposal: null });
		expect((await accept(editor, { dataset: 'Atlas-Apan-2007' })).status).toBe(400);
		const row = [180, 195, 215, 225, 195, 165, 105, 80, 60, 65, 90, 135];
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		try {
			const meta = { ...ATLAS_APAN, kind: 'apan' as const, method: atlasApanMethodFor(0.1, null, null) };
			const cells = [-338, -337].flatMap((r) => [212, 213].map((c) => ({ row: r, col: c, monthlyMm: row })));
			expect(await replaceEvaporationDataset(client, meta, { cellDeg: 0.1, originLon: 0.05, originLat: 0.05, firstYear: null, lastYear: null, cells, partial: 0 })).toBe(4);
		} finally {
			await client.end();
		}
		try {
			const p = (await proposals(viewer, '?dataset=Atlas-Apan-2007')).body;
			expect(p).toMatchObject({ target: 'apan', dataset: { dataset: 'Atlas-Apan-2007', firstYear: null, lastYear: null }, proposal: { monthlyMm: row, coverage: 1, cells: 4 } });
			const res = await accept(editor, { dataset: 'Atlas-Apan-2007' });
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			expect((await settings()).apanMm).toEqual(row);
			expect(await lastReason()).toMatch(/^A-pan evaporation from the map: [\d.]+ mm a year of modelled A-pan equivalent reference potential evaporation \(WRC Atlas, not a measured pan\)/);
		} finally {
			await asOwner(`DELETE FROM evaporation_dataset WHERE dataset = 'Atlas-Apan-2007'`);
		}
	});

	it('refuses what it can’t re-derive; nothing changes', async () => {
		const before = await settings();
		const err = async (body: Record<string, unknown>, status = 400, pid = projectId, u = editor) => {
			const res = await accept(u, body, pid);
			expect(res.status, JSON.stringify(res.body)).toBe(status);
			return res.body.error as string;
		};
		expect(await err({ dataset: 'nope' })).toMatch(/No evaporation dataset “nope”/);
		expect(await err({ dataset: 'synthetic', extra: 1 })).toBeTruthy();
		expect(await err({ dataset: 'synthetic' }, 400, bareProjectId, owner)).toMatch(/^There is no catchment boundary on the map/);
		expect(await err({ dataset: 'synthetic' }, 404, projectId, stranger)).toBeTruthy();
		const sea = await owner.call('POST', at('/map/features', bareProjectId), { kind: 'catchment_boundary', name: 'Offshore', geometry: { type: 'Polygon', coordinates: AT_SEA } });
		expect(sea.status).toBe(201);
		expect(await err({ dataset: 'synthetic' }, 400, bareProjectId, owner)).toMatch(/can’t be summarised over the boundary: the grid has no value inside the boundary/);
		expect((await proposals(owner, '', bareProjectId)).body.proposal).toEqual({ problem: expect.stringMatching(/no value inside the boundary/) });
		expect(await settings()).toEqual(before);
	});
});

describe('the grid and the provenance', () => {
	it('the loader writes the dataset row and the cells, and a reload replaces them', async () => {
		const count = async () => (await asOwner(`SELECT count(*)::integer AS n FROM evaporation_cell_reference WHERE dataset = 'synthetic'`))[0]!.n as number;
		// The fixture's cells (backend/fixtures/geo/evaporation.synthetic.json): 21 × 21 less the 12 "sea" cells.
		expect(await count()).toBe(429);
		const [d] = await asOwner(`SELECT kind, cell_deg, first_year, last_year, version FROM evaporation_dataset WHERE dataset = 'synthetic'`);
		expect(d).toEqual({ kind: 'et0', cell_deg: 0.1, first_year: 1991, last_year: 2020, version: 'synthetic 1' });
		await asOwner(`UPDATE evaporation_cell_reference SET monthly_mm = array_fill(1::real, ARRAY[12]) WHERE dataset = 'synthetic' AND row_idx = -338 AND col_idx = 212`);
		expect(await loadSyntheticEvaporation(process.env.TEST_MIGRATION_DATABASE_URL!)).toEqual({ written: 429, problems: [] });
		expect(await count()).toBe(429);
		const [cell] = await asOwner(`SELECT monthly_mm FROM evaporation_cell_reference WHERE dataset = 'synthetic' AND row_idx = -338 AND col_idx = 212`);
		expect(cell!.monthly_mm).toEqual(BASE);
	});

	it('the provenance’s target matches its kind (control: a well-formed row goes in)', async () => {
		const insert = (target: string, kind: string) =>
			withUser(editor.id, (db) =>
				db.query(
					`INSERT INTO evaporation_accepted (project_id, target, monthly_mm, dataset, kind, source, version, method, coverage)
					 VALUES ($1, $2, $3, 'synthetic', $4, 's', 'v', 'm', 1)
					 ON CONFLICT (project_id, target) DO UPDATE SET kind = EXCLUDED.kind`,
					[projectId, target, BASE, kind]
				)
			);
		await expect(insert('apan', 'et0')).rejects.toThrow(/check constraint/);
		await insert('apan', 'apan');
		// A member reads it (positive control); a non-member sees nothing and can't write one.
		expect((await withUser(viewer.id, (db) => db.query('SELECT 1 FROM evaporation_accepted WHERE project_id = $1', [projectId]))).rowCount).toBeGreaterThan(0);
		expect((await withUser(stranger.id, (db) => db.query('SELECT 1 FROM evaporation_accepted WHERE project_id = $1', [projectId]))).rowCount).toBe(0);
		await expect(
			withUser(stranger.id, (db) =>
				db.query(
					`INSERT INTO evaporation_accepted (project_id, target, monthly_mm, dataset, kind, source, version, method, coverage) VALUES ($1, 'pe', $2, 'x', 'et0', 's', 'v', 'm', 1)`,
					[projectId, BASE]
				)
			)
		).rejects.toThrow(/row-level security/);
		// A viewer reads it but can't write it.
		await expect(
			withUser(viewer.id, (db) => db.query(`UPDATE evaporation_accepted SET coverage = 0.5 WHERE project_id = $1 RETURNING 1`, [projectId]))
		).resolves.toMatchObject({ rowCount: 0 });
	});

	it('a period is both years or, for an A-pan grid only, neither (317, 318; control: both null on an A-pan grid goes in)', async () => {
		const insert = (dataset: string, kind: string, first: number | null, last: number | null) =>
			asOwner(
				`INSERT INTO evaporation_dataset (dataset, kind, source, version, method, attribution, first_year, last_year, cell_deg, origin_lon, origin_lat)
				 VALUES ($1, $2, 's', 'v', 'm', 'a', $3, $4, 0.1, 0.05, 0.05)`,
				[dataset, kind, first, last]
			);
		try {
			await insert('test-period-apan', 'apan', null, null);
			await expect(insert('test-period-et0', 'et0', null, null)).rejects.toThrow(/evaporation_dataset_period_check/);
			await expect(insert('test-period-half', 'apan', 1950, null)).rejects.toThrow(/evaporation_dataset_period_check/);
			await expect(insert('test-period-half', 'apan', null, 1999)).rejects.toThrow(/evaporation_dataset_period_check/);
			await expect(insert('test-period-back', 'apan', 1999, 1950)).rejects.toThrow(/check constraint/);
			// The S-pan kind is no longer admitted, with or without a period (318, issue #738).
			await expect(insert('test-period-span', 'span', null, null)).rejects.toThrow(/evaporation_dataset_kind_check/);
			await expect(insert('test-period-span', 'span', 1950, 1999)).rejects.toThrow(/evaporation_dataset_kind_check/);
			// The app role reads the no-period row like any other.
			const read = await withUser(viewer.id, (db) => db.query(`SELECT first_year, last_year FROM evaporation_dataset WHERE dataset = 'test-period-apan'`));
			expect(read.rows).toEqual([{ first_year: null, last_year: null }]);
		} finally {
			await asOwner(`DELETE FROM evaporation_dataset WHERE dataset LIKE 'test-period-%'`);
		}
	});

	it('the grid is read-only to the app role (control: it reads it)', async () => {
		const read = await withUser(viewer.id, (db) => db.query(`SELECT version FROM evaporation_dataset WHERE dataset = 'synthetic'`));
		expect(read.rows).toEqual([{ version: 'synthetic 1' }]);
		await expect(withUser(viewer.id, (db) => db.query(`DELETE FROM evaporation_cell_reference WHERE dataset = 'synthetic'`))).rejects.toThrow(/permission denied/);
		await expect(withUser(editor.id, (db) => db.query(`UPDATE evaporation_dataset SET version = 'x'`))).rejects.toThrow(/permission denied/);
	});
});
