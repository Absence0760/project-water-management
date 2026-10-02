// The s21 water use (issue #72, 142_allocation_water_use.sql,
// docs/allocations.md § Importing): WARMS registers per water use, per
// property, and a 21(b) row's "volume" is a dam's storage, not a take.
//  - a WARMS-shaped extract's 21(b) rows store as storage only (volume 0,
//    the storage), and its ambiguous rows (no code, two uses, another s21
//    use, a missing or non-annual unit) are refused, not stored;
//  - the API and 142's CHECK refuse a storage-only row with a take, no
//    storage, or groundwater;
//  - a run's input marks a storage-only row and leaves a take as before;
//  - the comparison counts the storage and never the 21(b) row as a take;
//  - the export writes water_use and reads back;
//  - a farmer's farm view shows their own farm's registered totals only
//    (positive control: the WUA's preview of the same farm).
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { allocationsForRun } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let farmer: User;
let projectId: string;
let runId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id, { damCapacityM3: 150_000 });
const farmB = node('Farm B', outlet.id);

const EXTRACT = [
	'Registration Number,Property Description,Farm Name,Registered User,Resource Type,Water Use,Registered Volume,Unit,Valid From',
	'WU-1,Portion 1,Farm A,Invented Holder A,Surface,21(a),"60,000",m3/a,2000-01-01',
	'WU-1,Portion 1,Farm A,Invented Holder A,Surface,21(b),"100,000",m3/a,2000-01-01',
	'WU-2,Portion 2,Farm A,Invented Holder A,Groundwater,21(a),12,Ml/a,2000-01-01',
	'WU-3,Portion 3,Farm B,Invented Holder B,Surface,21(b),40,Ml,2000-01-01',
	'WU-4,Portion 4,Farm B,Invented Holder B,Surface,,"5,000",m3/a,2000-01-01',
	'WU-5,Portion 5,Farm B,Invented Holder B,Surface,21(a)(b),"5,000",m3/a,2000-01-01',
	'WU-6,Portion 6,Farm B,Invented Holder B,Surface,21(c),"5,000",m3/a,2000-01-01',
	'WU-7,Portion 7,Farm B,Invented Holder B,Surface,21(a),"5,000",,2000-01-01',
	'WU-8,Portion 8,Farm B,Invented Holder B,Surface,21(a),500,m3/month,2000-01-01'
].join('\n');

beforeAll(async () => {
	[owner, viewer, farmer] = (await Promise.all(['Wowner', 'Wviewer', 'Wfarmer'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Water use' })).body.project.id;
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = {
		nodes: [outlet, farmA, farmB],
		crops: [crop],
		cropAreas: [farmA, farmB].map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 60_000 })),
		transfers: []
	};
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
}, 60_000);

const body = (extra: Record<string, unknown> = {}) => ({ kind: 'warms_extract', fileName: 'water-use.csv', text: EXTRACT, reference: 'synthetic', ...extra });

describe('importing a WARMS extract per s21 water use', () => {
	it('previews 21(b) rows as storage and refuses the ambiguous ones', async () => {
		const res = await owner.call('POST', `/projects/${projectId}/allocations/import`, body());
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.summary).toMatchObject({ rows: 9, valid: 4, invalid: 5 });
		const by = (line: number) => res.body.rows.find((r: { line: number }) => r.line === line);
		expect(by(2)).toMatchObject({ waterUse: '21a', volumeM3PerYear: 60_000, storageM3: null, errors: [] });
		expect(by(3)).toMatchObject({ waterUse: '21b', volumeM3PerYear: 0, storageM3: 100_000, errors: [] });
		expect(by(4)).toMatchObject({ waterUse: '21a', waterSource: 'groundwater', volumeM3PerYear: 12_000, errors: [] });
		expect(by(5)).toMatchObject({ waterUse: '21b', volumeM3PerYear: 0, storageM3: 40_000, errors: [] });
		for (const line of [6, 7, 8, 9, 10]) expect(by(line).errors.length, String(line)).toBeGreaterThan(0);
	});

	it('refuses a WARMS extract with no water-use column', async () => {
		const res = await owner.call('POST', `/projects/${projectId}/allocations/import`, body({ text: 'Registration Number,Farm Name,Resource Type,Registered Volume (m3/a)\nR1,Farm A,Surface,100\n' }));
		expect(res.status).toBe(422);
		expect(res.body.error).toMatch(/no water-use column found/);
	});

	it('stores the 21(b) rows as storage only and none of the refused rows', async () => {
		const res = await owner.call('POST', `/projects/${projectId}/allocations/import/commit`, body());
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body).toMatchObject({ imported: 4, skipped: 5 });
		const rows = await asOwner(
			`SELECT registration_no AS reg, water_use AS use, water_source AS src, volume_m3_year AS vol, storage_m3 AS sto
			 FROM allocation WHERE project_id = $1 ORDER BY registration_no, water_use`,
			[projectId]
		);
		expect(rows).toEqual([
			{ reg: 'WU-1', use: '21a', src: 'surface', vol: 60_000, sto: null },
			{ reg: 'WU-1', use: '21b', src: 'surface', vol: 0, sto: 100_000 },
			{ reg: 'WU-2', use: '21a', src: 'groundwater', vol: 12_000, sto: null },
			{ reg: 'WU-3', use: '21b', src: 'surface', vol: 0, sto: 40_000 }
		]);
	});
});

describe('a storage-only row typed in or changed', () => {
	let damId: string;

	it('is refused with a take, without a storage, or as groundwater; stored as one otherwise', async () => {
		const base = { nodeId: farmB.id, authorisation: 'registration', waterSource: 'surface', waterUse: '21b' };
		for (const [extra, msg] of [
			[{ volumeM3PerYear: 10, storageM3: 5 }, /registers no take/],
			[{ volumeM3PerYear: 0 }, /needs its storage/],
			[{ volumeM3PerYear: 0, storageM3: 5, waterSource: 'groundwater' }, /surface water/]
		] as const) {
			const res = await owner.call('POST', `/projects/${projectId}/allocations`, { ...base, ...extra });
			expect(res.status, JSON.stringify(res.body)).toBe(400);
			expect(JSON.stringify(res.body)).toMatch(msg);
		}
		const ok = await owner.call('POST', `/projects/${projectId}/allocations`, { ...base, volumeM3PerYear: 0, storageM3: 25_000 });
		expect(ok.status, JSON.stringify(ok.body)).toBe(201);
		expect(ok.body.allocation).toMatchObject({ waterUse: '21b', volumeM3PerYear: 0, storageM3: 25_000 });
		damId = ok.body.allocation.id;
		// A take typed in without a water use is a take, as before 142.
		const take = await owner.call('POST', `/projects/${projectId}/allocations`, { nodeId: farmB.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 7_000 });
		expect(take.body.allocation.waterUse).toBe('21a');
	});

	it('a change that would make it a take with storage-only marks is refused; back to a take is allowed', async () => {
		expect((await owner.call('PATCH', `/projects/${projectId}/allocations/${damId}`, { volumeM3PerYear: 9 })).status).toBe(400);
		expect((await owner.call('PATCH', `/projects/${projectId}/allocations/${damId}`, { storageM3: null })).status).toBe(400);
		const res = await owner.call('PATCH', `/projects/${projectId}/allocations/${damId}`, { waterUse: '21a', volumeM3PerYear: 9 });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.allocation).toMatchObject({ waterUse: '21a', volumeM3PerYear: 9, storageM3: 25_000 });
		expect((await owner.call('PATCH', `/projects/${projectId}/allocations/${damId}`, { waterUse: '21b', volumeM3PerYear: 0 })).status).toBe(200);
	});

	it('142’s CHECK refuses one written past the API', async () => {
		await expect(
			asOwner(`INSERT INTO allocation (project_id, authorisation, water_source, volume_m3_year, storage_m3, water_use) VALUES ($1, 'registration', 'surface', 10, 5, '21b')`, [projectId])
		).rejects.toThrow(/allocation_storage_only_check/);
		await expect(asOwner(`INSERT INTO allocation (project_id, authorisation, water_source, volume_m3_year, storage_m3, water_use) VALUES ($1, 'registration', 'surface', 0, 5, '21c')`, [projectId])).rejects.toThrow(
			/allocation_water_use_check/
		);
	});
});

describe('runs and the comparison', () => {
	beforeAll(async () => {
		const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'water use' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		runId = run.body.run.id;
	}, 60_000);

	it('a run’s input marks a storage-only row, and a take reads as before 142 (no waterUse)', async () => {
		const list = await withUser(owner.id, (db) => allocationsForRun(db, projectId));
		const dams = list.filter((a) => a.waterUse === '21b');
		expect(dams.length).toBe(3);
		for (const d of dams) expect(d.volumeM3PerYear).toBe(0);
		for (const a of list.filter((x) => x.waterUse !== '21b')) expect(Object.hasOwn(a, 'waterUse')).toBe(false);
	});

	it('compares the dam with its registered storage and never counts the 21(b) row as a take', async () => {
		const res = await owner.call('GET', `/projects/${projectId}/runs/${runId}/allocations`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const a = res.body.comparison.nodes.find((n: { nodeId: string }) => n.nodeId === farmA.id);
		// Farm A: 100 000 m³ registered (WU-1 21(b)) against a 150 000 m³ dam: 50 000 m³ larger, above the band.
		expect(a.storage).toEqual({ registeredM3: 100_000, modelledCapacityM3: 150_000, differenceM3: 50_000, status: 'over' });
		const [dam] = await asOwner(`SELECT id FROM allocation WHERE project_id = $1 AND registration_no = 'WU-1' AND water_use = '21b'`, [projectId]);
		expect(a.surface.allocationIds).not.toContain(dam!.id);
		expect(a.surface.years[0].registeredM3).toBeGreaterThan(0);
	});
});

describe('the export', () => {
	it('writes water_use, and the file reads back as storage', async () => {
		const r = await app.request(`/projects/${projectId}/allocations/export.csv`, { headers: { cookie: owner.cookie, origin: 'http://localhost:7777' } });
		const text = await r.text();
		const [header, ...lines] = text.trim().split('\r\n');
		expect(header!.split(',')).toContain('water_use');
		const back = await owner.call('POST', `/projects/${projectId}/allocations/import`, { kind: 'csv', fileName: 'back.csv', text, reference: '' });
		expect(back.status, JSON.stringify(back.body)).toBe(200);
		expect(back.body.summary.invalid).toBe(0);
		const dams = back.body.rows.filter((x: { waterUse: string }) => x.waterUse === '21b');
		expect(dams.length).toBe(lines.filter((l) => l.includes(',21b,') || l.endsWith(',21b')).length);
		expect(dams.every((d: { volumeM3PerYear: number; storageM3: number }) => d.volumeM3PerYear === 0 && d.storageM3 > 0)).toBe(true);
	});
});

describe('the farmer’s farm view (issue #72)', () => {
	beforeAll(async () => {
		expect((await owner.call('POST', `/projects/${projectId}/publication`, { runId })).status).toBe(201);
	});

	it('shows a farmer their own farm’s registered totals, no names or numbers', async () => {
		const res = await farmer.call('GET', `/projects/${projectId}/farm/${farmA.id}`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.registered).toEqual({ asOf: res.body.today, surfaceM3PerYear: 60_000, groundwaterM3PerYear: 12_000, storageM3: 100_000 });
		const raw = JSON.stringify(res.body);
		expect(raw).not.toMatch(/Invented Holder|WU-1|WU-2|Portion 1/);
		// Positive control: the WUA previewing the same farm sees the same totals.
		expect((await owner.call('GET', `/projects/${projectId}/farm/${farmA.id}`)).body.registered).toEqual(res.body.registered);
		// A viewer the owners haven't let read each volume (162, D3) previews the farm without them.
		expect((await viewer.call('GET', `/projects/${projectId}/farm/${farmA.id}`)).body.registered).toBeNull();
	});

	it('never shows another farm’s, and counts only what is in force today', async () => {
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${farmB.id}`)).status).toBe(404);
		// Farm B through the WUA's eyes has registrations; a lapsed one on Farm A doesn't count.
		expect((await owner.call('GET', `/projects/${projectId}/farm/${farmB.id}`)).body.registered).not.toBeNull();
		expect(
			(await owner.call('POST', `/projects/${projectId}/allocations`, { nodeId: farmA.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 999, validTo: '2001-01-01' })).status
		).toBe(201);
		// Nor does Schedule 1 permissible use: it isn't registered with DWS.
		expect(
			(await owner.call('POST', `/projects/${projectId}/allocations`, { nodeId: farmA.id, authorisation: 'schedule_1', waterSource: 'surface', volumeM3PerYear: 888 })).status
		).toBe(201);
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${farmA.id}`)).body.registered.surfaceM3PerYear).toBe(60_000);
	});

	it('is null for a farm with nothing registered', async () => {
		await asOwner(`DELETE FROM allocation WHERE project_id = $1 AND node_id = $2`, [projectId, farmA.id]);
		expect((await farmer.call('GET', `/projects/${projectId}/farm/${farmA.id}`)).body.registered).toBeNull();
	});
});
