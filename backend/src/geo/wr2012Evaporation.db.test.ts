// WR2012's monthly evaporation per quaternary (310_quaternary_evaporation.sql;
// docs/maps.md § Quaternary evaporation, § WR2012 evaporation by quaternary;
// docs/api.md § Catchment map): the loader (quaternary_evaporation, the MAE
// and zone context on quaternary_reference), GET /projects/:id/evaporation-wr2012
// (each quaternary the boundary overlaps with its share, S-pan, A-pan and
// module agreement; the catchment's area-weighted rows), POST
// …/evaporation-from-wr2012 (the A-pan row as it stands, one settings revision
// naming the dataset, quaternaries, shares and module files) and POST
// …/evaporation-from-span (typed S-pan, converted). A viewer reads (positive
// control), a farmer gets 403, a stranger 404; a viewer can't accept;
// water_app can't write the table. Invented data only: the committed synthetic
// rows (region Z) and an invented region Y out at sea.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importQuaternaries, parseArgs } from '../../scripts/import-quaternaries.js';
import { loadSyntheticQuaternaryEvaporation } from '../../scripts/import-quaternary-evaporation.js';
import { node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { quaternaryRecords, replaceDataset } from './loadQuaternaries.js';
import { quaternaryEvaporationRecords, replaceQuaternaryEvaporation } from './loadQuaternaryEvaporation.js';

type User = Awaited<ReturnType<typeof signUp>>;

const OWNER_URL = () => process.env.TEST_MIGRATION_DATABASE_URL!;
/** An invented dataset in drainage region Y, out at sea (no other test's outlines are there). */
const YT = 'wr2012-evap-test';
const MONTHS = ['oct', 'nov', 'dec', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep'];
const box = (w: number, s: number, e: number, n: number) => [
	[w, s],
	[e, s],
	[e, n],
	[w, n],
	[w, s]
];

let owner: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let noMapId: string;
let spanOnlyId: string;
const outlet = node('Outlet weir', null);
const farm = node('Farm A', outlet.id);
const model = () => ({ nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] });
const at = (path = '', id = projectId) => `/projects/${id}${path}`;

const asOwner = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
	const client = new pg.Client({ connectionString: OWNER_URL() });
	await client.connect();
	try {
		return (await client.query<T>(sql, params)).rows;
	} finally {
		await client.end();
	}
};
const reasons = async (id: string) =>
	(await withUser(owner.id, (db) => db.query<{ reason: string }>(`SELECT reason FROM model_revision WHERE project_id = $1 AND source = 'settings_patch' ORDER BY created_at, id`, [id]))).rows.map((r) => r.reason);
const settingsOf = async (id: string) => (await owner.call('GET', at('', id))).body.project.settings as { apanMm: number[] };
const boundary = async (id: string, ring: number[][], name = 'Test catchment') =>
	expect((await owner.call('POST', at('/map/features', id), { kind: 'catchment_boundary', name, geometry: { type: 'Polygon', coordinates: [ring] } })).status).toBe(201);
const synthetic = async () => (await asOwner<{ code: string; span_mm: number[] | null; apan_mm: number[] | null }>(`SELECT code, span_mm, apan_mm FROM quaternary_evaporation WHERE dataset = 'synthetic' ORDER BY code`));

/** Region Y: one outline, Y01A, with no evaporation loaded for it. */
async function loadRegionY() {
	const features = [{ type: 'Feature', properties: { code: 'Y01A', maeMm: 1800, evapZone: '3B' }, geometry: { type: 'Polygon', coordinates: [box(40, -41, 40.25, -40.75)] } }];
	const got = quaternaryRecords({ type: 'FeatureCollection', features }, 'INVENTED region Y (test)');
	expect(got.problems).toEqual([]);
	const client = new pg.Client({ connectionString: OWNER_URL() });
	await client.connect();
	try {
		await replaceDataset(client, YT, got.records);
	} finally {
		await client.end();
	}
}

beforeAll(async () => {
	[owner, viewer, farmer, stranger] = (await Promise.all(['W12owner', 'W12viewer', 'W12farmer', 'W12stranger'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'WR2012 evaporation' })).body.project.id;
	noMapId = (await owner.call('POST', '/projects', { name: 'WR2012 evaporation, no map' })).body.project.id;
	spanOnlyId = (await owner.call('POST', '/projects', { name: 'WR2012 evaporation, S-pan only' })).body.project.id;
	expect((await owner.call('PUT', at('/model'), model())).status).toBe(200);
	expect((await owner.call('POST', at('/members'), { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', at('/farmers'), { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	const args = parseArgs([]);
	if (typeof args === 'string') throw new Error(args);
	expect(await importQuaternaries(OWNER_URL(), args)).toEqual({ written: 6, problems: [] });
	expect(await loadSyntheticQuaternaryEvaporation(OWNER_URL())).toEqual({ written: 6, problems: [] });
	await loadRegionY();
	// 0.15° west of the Z01A/Z01B divide (21.25°E) and 0.05° east of it: 75 % and 25 %.
	await boundary(projectId, box(21.1, -33.7, 21.3, -33.6));
	// Inside Z02C, whose configurations give S-pan but no irrigation module.
	await boundary(spanOnlyId, box(21.55, -33.95, 21.65, -33.85), 'In Z02C');
}, 60_000);

afterAll(async () => {
	await asOwner('DELETE FROM quaternary_reference WHERE dataset = $1', [YT]);
	await asOwner('DELETE FROM quaternary_evaporation WHERE dataset = $1', [YT]);
});

describe('loading the evaporation', () => {
	it('stores each quaternary’s S-pan and A-pan rows with their provenance, and the MAE and zone context on the outlines', async () => {
		const rows = await asOwner<{ code: string; span_modules: number; span_agree: number; apan_modules: number; apan: boolean; span_files: string[]; source: string }>(
			`SELECT code, span_modules, span_agree, apan_modules, apan_mm IS NOT NULL AS apan, span_files, source FROM quaternary_evaporation WHERE dataset = 'synthetic' ORDER BY code`
		);
		expect(rows.map((r) => [r.code, r.span_modules, r.span_agree, r.apan_modules, r.apan])).toEqual([
			['Z01A', 2, 2, 2, true],
			['Z01B', 3, 2, 1, true],
			['Z01C', 1, 1, 1, true],
			['Z02A', 1, 1, 1, true],
			['Z02B', 1, 1, 2, true],
			['Z02C', 1, 1, 0, false]
		]);
		expect(rows[0]!.span_files).toEqual(['Z1RU1.DAT', 'Z1RU11.DAT']);
		expect(rows[0]!.source).toMatch(/^SYNTHETIC/);
		expect(await asOwner(`SELECT mae_mm, evap_zone FROM quaternary_reference WHERE code = 'Z01A'`)).toEqual([{ mae_mm: 1500, evap_zone: 'Z1' }]);
	});

	it('a reload replaces its dataset, in one transaction, and leaves the outlines alone', async () => {
		const client = new pg.Client({ connectionString: OWNER_URL() });
		await client.connect();
		try {
			const S = new Array(12).fill(120);
			const csv = ['code,' + [...MONTHS.map((m) => `span_${m}`), ...MONTHS.map((m) => `apan_${m}`)].join(','), ['Y01A', ...S, ...new Array(12).fill('')].join(',')].join('\n');
			await replaceQuaternaryEvaporation(client, YT, quaternaryEvaporationRecords(csv).records, 'INVENTED (test)');
			expect(await asOwner('SELECT code FROM quaternary_evaporation WHERE dataset = $1', [YT])).toEqual([{ code: 'Y01A' }]);
			await replaceQuaternaryEvaporation(client, YT, [], 'INVENTED (test)');
			expect(await asOwner('SELECT code FROM quaternary_evaporation WHERE dataset = $1', [YT])).toEqual([]);
			expect(await asOwner('SELECT code FROM quaternary_reference WHERE dataset = $1', [YT])).toEqual([{ code: 'Y01A' }]);
		} finally {
			await client.end();
		}
	});

	it('the table refuses a row out of range, a missing month, or neither row; a lone MAE on the outlines', async () => {
		const ins = (span: unknown, apan: unknown, sm = 1, am = 1) =>
			asOwner(`INSERT INTO quaternary_evaporation (dataset, code, span_mm, apan_mm, span_modules, span_agree, apan_modules, apan_agree, source) VALUES ($1, 'Y01A', $2, $3, $4, $4, $5, $5, 'x')`, [YT, span, apan, sm, am]);
		await expect(ins([...new Array(11).fill(100), 1200], null, 1, 0)).rejects.toThrow(/check constraint/);
		await expect(ins(new Array(11).fill(100), null, 1, 0)).rejects.toThrow(/check constraint/);
		await expect(ins(null, null, 0, 0)).rejects.toThrow(/check constraint/);
		await expect(ins(new Array(12).fill(100), null, 0, 0)).rejects.toThrow(/check constraint/);
		await expect(asOwner(`UPDATE quaternary_reference SET evap_zone = NULL WHERE code = 'Y01A'`)).rejects.toThrow(/quaternary_reference_evaporation_pair/);
	});

	it('is read-only to the app role (control: a signed-in user reads it)', async () => {
		const rows = await withUser(viewer.id, async (db) => (await db.query(`SELECT code FROM quaternary_evaporation WHERE dataset = 'synthetic'`)).rows);
		expect(rows.length).toBe(6);
		await expect(withUser(owner.id, (db) => db.query(`UPDATE quaternary_evaporation SET span_modules = span_modules WHERE dataset = 'synthetic'`))).rejects.toThrow(/permission denied/);
		await expect(withUser(owner.id, (db) => db.query(`DELETE FROM quaternary_evaporation`))).rejects.toThrow(/permission denied/);
		await expect(withUser(owner.id, (db) => db.query(`UPDATE quaternary_reference SET mae_mm = 1 WHERE code = 'Z01A'`))).rejects.toThrow(/permission denied/);
	});
});

describe('GET …/evaporation-wr2012', () => {
	it('with no boundary proposes nothing, but says which quaternary datasets are loaded', async () => {
		const res = await owner.call('GET', at('/evaporation-wr2012', noMapId));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ boundary: null, evaporation: null, settings: { dailyApan: [] } });
		expect(res.body.datasets).toEqual(expect.arrayContaining([{ dataset: 'synthetic', count: 6 }]));
	});

	it('lists each quaternary the boundary overlaps with its share, S-pan, A-pan and module agreement, and the catchment’s weighted rows', async () => {
		const res = await viewer.call('GET', at('/evaporation-wr2012'));
		expect(res.status).toBe(200);
		expect(res.body.boundary).toMatchObject({ name: 'Test catchment' });
		const ev = res.body.evaporation;
		expect(ev.problem).toBeNull();
		const [a, b] = ev.quaternaries as { code: string; share: number; spanMm: number[]; apanMm: number[]; zone: string; maeMm: number; disagree: boolean; span: { modules: number; agree: number; othersMm: number[] }; files: number; synthetic: boolean }[];
		expect([a!.code, b!.code]).toEqual(['Z01A', 'Z01B']);
		expect(a!.share).toBeCloseTo(0.75, 2);
		expect(b!.share).toBeCloseTo(0.25, 2);
		expect([a!.zone, a!.maeMm, a!.synthetic, a!.disagree, a!.files]).toEqual(['Z1', 1500, true, false, 4]);
		expect(b!.disagree).toBe(true);
		expect(b!.span).toEqual({ modules: 3, agree: 2, othersMm: [1620] });
		const rows = await synthetic();
		const za = rows.find((r) => r.code === 'Z01A')!;
		const zb = rows.find((r) => r.code === 'Z01B')!;
		expect(a!.apanMm).toEqual(za.apan_mm);
		expect(ev.apanMm[0]).toBeCloseTo(a!.share * za.apan_mm![0]! + b!.share * zb.apan_mm![0]!, 0);
		expect(ev.spanMm[0]).toBeCloseTo(a!.share * za.span_mm![0]! + b!.share * zb.span_mm![0]!, 0);
		expect(ev.apanCoverage).toBeCloseTo(1, 6);
		expect(JSON.stringify(res.body)).not.toContain('coordinates');
	});

	it('a quaternary with S-pan but no irrigation module proposes no A-pan, and says to convert its S-pan', async () => {
		const res = await owner.call('GET', at('/evaporation-wr2012', spanOnlyId));
		expect(res.status).toBe(200);
		expect(res.body.evaporation).toMatchObject({ apanMm: null, apanCoverage: 0 });
		expect(res.body.evaporation.spanMm).toHaveLength(12);
		expect(res.body.evaporation.problem).toMatch(/^no irrigation module gives the A-pan of Z02C, only its S-pan: convert that with the equation you pick/);
		expect(res.body.evaporation.quaternaries).toEqual([expect.objectContaining({ code: 'Z02C', apanMm: null, why: 'no irrigation module gives its A-pan, only S-pan' })]);
	});

	it('is a viewer’s read: a farmer gets 403 and a stranger 404 (control: the viewer reads it above)', async () => {
		expect((await farmer.call('GET', at('/evaporation-wr2012'))).status).toBe(403);
		expect((await stranger.call('GET', at('/evaporation-wr2012'))).status).toBe(404);
	});
});

describe('POST …/evaporation-from-wr2012', () => {
	it('a viewer can’t accept (403), a farmer 403, a stranger 404, and nothing changes', async () => {
		const before = await settingsOf(projectId);
		expect((await viewer.call('POST', at('/evaporation-from-wr2012'), {})).status).toBe(403);
		expect((await farmer.call('POST', at('/evaporation-from-wr2012'), {})).status).toBe(403);
		expect((await stranger.call('POST', at('/evaporation-from-wr2012'), {})).status).toBe(404);
		expect((await settingsOf(projectId)).apanMm).toEqual(before.apanMm);
		expect(await reasons(projectId)).toEqual([]);
	});

	it('refuses what can’t be used, with its reason and never DB text; takes no numbers from the browser', async () => {
		const post = (body: unknown, id = projectId) => owner.call('POST', at('/evaporation-from-wr2012', id), body);
		expect((await post({}, noMapId)).body.error).toMatch(/no catchment boundary/);
		const none = await post({}, spanOnlyId);
		expect(none.status).toBe(400);
		expect(none.body.error).toMatch(/no irrigation module gives the A-pan of Z02C/);
		expect(none.body.error).not.toMatch(/quaternary_|SELECT/);
		expect((await post({ apanMm: new Array(12).fill(1) })).status).toBe(400);
		expect((await post({ conversion: 'wr90' })).status).toBe(400);
		expect(await reasons(projectId)).toEqual([]);
		expect(await reasons(spanOnlyId)).toEqual([]);
	});

	it('writes the catchment’s A-pan as it stands, re-derived on the server, as one revision naming the dataset, quaternaries, shares and module files', async () => {
		const listed = (await owner.call('GET', at('/evaporation-wr2012'))).body.evaporation;
		const res = await owner.call('POST', at('/evaporation-from-wr2012'), {});
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body).toMatchObject({ quaternaries: ['Z01A', 'Z01B'], apanMm: listed.apanMm, spanMm: listed.spanMm, revisionId: expect.any(String) });
		expect((await settingsOf(projectId)).apanMm).toEqual(listed.apanMm);
		const r = await reasons(projectId);
		expect(r).toHaveLength(1);
		expect(r[0]).toMatch(/^A-pan evaporation from WR2012’s WRSM2000 irrigation modules \(dataset “synthetic”\): \d+ mm a year, the area-weighted A-pan of the quaternaries under the catchment boundary “Test catchment”: Z01A 75 %, Z01B 25 %; from 3 module files; their runoff modules’ S-pan is \d+ mm a year\. SYNTHETIC/);
	});

	it('a catchment in one quaternary takes its row; one partly outside every quaternary says how much is left out', async () => {
		const one = (await owner.call('POST', '/projects', { name: 'WR2012 evaporation, one quaternary' })).body.project.id as string;
		await boundary(one, box(21.05, -33.95, 21.15, -33.85), 'In Z02A');
		const got = await owner.call('POST', at('/evaporation-from-wr2012', one), {});
		expect(got.status, JSON.stringify(got.body)).toBe(200);
		expect(got.body.apanMm).toEqual((await synthetic()).find((x) => x.code === 'Z02A')!.apan_mm);
		expect((await reasons(one)).at(-1)).toMatch(/the A-pan of the quaternary under the catchment boundary “In Z02A”: Z02A 100 %; from 1 module file;/);

		const edge = (await owner.call('POST', '/projects', { name: 'WR2012 evaporation, past the edge' })).body.project.id as string;
		// Half east of Z01C (21.75°E), where nothing is loaded.
		await boundary(edge, box(21.7, -33.7, 21.8, -33.6), 'Past the edge');
		const view = (await owner.call('GET', at('/evaporation-wr2012', edge))).body.evaporation;
		expect(view.apanCoverage).toBeCloseTo(0.5, 2);
		expect((await owner.call('POST', at('/evaporation-from-wr2012', edge), {})).status).toBe(200);
		expect((await reasons(edge)).at(-1)).toMatch(/; 50 % of the catchment has no WR2012 A-pan and is left out of the mean/);
	});
});

describe('POST …/evaporation-from-span (S-pan typed or pasted)', () => {
	const SPAN = [150, 170, 190, 195, 160, 140, 95, 70, 55, 57, 78, 105];

	it('a viewer can’t (403), a farmer 403, a stranger 404, and nothing changes', async () => {
		const before = await settingsOf(noMapId);
		for (const [u, status] of [
			[viewer, 404],
			[farmer, 404],
			[stranger, 404]
		] as const)
			expect((await u.call('POST', at('/evaporation-from-span', noMapId), { spanMm: SPAN, conversion: 'wr90' })).status).toBe(status);
		expect((await viewer.call('POST', at('/evaporation-from-span'), { spanMm: SPAN, conversion: 'wr90' })).status).toBe(403);
		expect((await farmer.call('POST', at('/evaporation-from-span'), { spanMm: SPAN, conversion: 'wr90' })).status).toBe(403);
		expect((await settingsOf(noMapId)).apanMm).toEqual(before.apanMm);
	});

	it('refuses a row that isn’t 12 months, an equation not picked, or a month under the equation’s floor', async () => {
		const post = (body: unknown) => owner.call('POST', at('/evaporation-from-span', noMapId), body);
		expect((await post({ spanMm: SPAN.slice(1), conversion: 'wr90' })).status).toBe(400);
		expect((await post({ spanMm: SPAN })).status).toBe(400);
		expect((await post({ spanMm: [...SPAN.slice(0, 11), -1], conversion: 'wr90' })).status).toBe(400);
		const low = await post({ spanMm: [...SPAN.slice(0, 8), 30, 31, 78, 105], conversion: 'wr90' });
		expect(low.status).toBe(400);
		expect(low.body.error).toMatch(/S-pan in Jun, Jul is below 32\.5 mm/);
		expect(await reasons(noMapId)).toEqual([]);
	});

	it('writes the converted A-pan row as one revision giving the S-pan months, the note and the equation', async () => {
		const res = await owner.call('POST', at('/evaporation-from-span', noMapId), { spanMm: SPAN, conversion: 'taljaard2023', note: 'Testdorp S-pan, 1980–2010' });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.apanMm[0]).toBeCloseTo((150 + 11.1745) / 0.8706, 1);
		expect((await settingsOf(noMapId)).apanMm).toEqual(res.body.apanMm);
		const r = (await reasons(noMapId)).at(-1)!;
		expect(r).toMatch(/^A-pan evaporation from S-pan typed or pasted \(Testdorp S-pan, 1980–2010\): \d+ mm a year from 1465 mm of S-pan \(Oct–Sep, mm: 150 170 190 195 160 140 95 70 55 57 78 105\), converted by the Taljaard \(2023\) general monthly equation, inverted; S-pan converted to A-pan by A = \(S \+ 11\.1745\) ÷ 0\.8706/);
	});
});
