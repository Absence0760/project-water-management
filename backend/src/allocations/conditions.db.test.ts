// Allocations, second slice (issue #72; 103_allocation_conditions.sql,
// docs/allocations.md): licence conditions through the API and the table's
// CHECKs, the allocations every run's input now carries (without names), the
// project's comparison band (settings.allocationTolerance) and a capped run
// (settings.allocationMode, engine 1.18.0) end to end.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let viewer: User;
let projectId: string;
const outlet = node('Weir', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);

const base = { authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1000 };
const updatedAt = async () => ((await asOwner('SELECT updated_at FROM project WHERE id = $1', [projectId]))[0]!.updated_at as Date).getTime();

beforeAll(async () => {
	[owner, viewer] = (await Promise.all(['Cowner', 'Cviewer'].map((n) => signUp(n)))) as [User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Licence conditions' })).body.project.id;
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = { nodes: [outlet, farmA, farmB], crops: [crop], cropAreas: [farmA, farmB].map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 60_000 })), transfers: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(0) } })).status).toBe(200);
	const rain = Array.from({ length: 730 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
}, 60_000);

describe('licence conditions (103)', () => {
	it('stores months (sorted), the maximum rate and conditions in words, and clears them', async () => {
		const res = await owner.call('POST', `/projects/${projectId}/allocations`, {
			...base,
			nodeId: farmA.id,
			registrationNo: 'COND-1',
			months: [12, 1, 10, 11, 2, 3],
			maxRateM3s: 0.05,
			conditions: ['No abstraction below 0.2 m³/s at the weir', 'Meter and report monthly']
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body.allocation).toMatchObject({ months: [1, 2, 3, 10, 11, 12], maxRateM3s: 0.05, conditions: ['No abstraction below 0.2 m³/s at the weir', 'Meter and report monthly'] });
		const aid = res.body.allocation.id;
		const cleared = await owner.call('PATCH', `/projects/${projectId}/allocations/${aid}`, { months: null, maxRateM3s: null, conditions: [] });
		expect(cleared.status).toBe(200);
		expect(cleared.body.allocation).toMatchObject({ months: null, maxRateM3s: null, conditions: [] });
		// A row entered before 103, or without them: none stated.
		const plain = await owner.call('POST', `/projects/${projectId}/allocations`, { ...base, nodeId: farmB.id, registrationNo: 'COND-2' });
		expect(plain.body.allocation).toMatchObject({ months: null, maxRateM3s: null, conditions: [] });
		for (const id of [aid, plain.body.allocation.id]) expect((await owner.call('DELETE', `/projects/${projectId}/allocations/${id}`)).status).toBe(204);
	});

	it('a PATCH changes only what it sends: the name, registration number and conditions stay', async () => {
		const res = await owner.call('POST', `/projects/${projectId}/allocations`, {
			...base,
			nodeId: farmA.id,
			registrationNo: 'KEEP-1',
			holder: 'Invented Keeper',
			propertyRef: 'Portion 2',
			purpose: 'livestock',
			storageM3: 9000,
			validFrom: '2020-10-01',
			reference: 'letter',
			months: [4],
			maxRateM3s: 0.2,
			conditions: ['Keep this']
		});
		expect(res.status).toBe(201);
		const aid = res.body.allocation.id;
		const patched = await owner.call('PATCH', `/projects/${projectId}/allocations/${aid}`, { volumeM3PerYear: 2500 });
		expect(patched.status).toBe(200);
		const { createdAt: _c, updatedAt: _u, volumeM3PerYear, ...rest } = patched.body.allocation;
		const { createdAt: _c0, updatedAt: _u0, volumeM3PerYear: before, ...was } = res.body.allocation;
		expect([before, volumeM3PerYear]).toEqual([1000, 2500]);
		expect(rest).toEqual(was);
		// The history names the one field sent.
		const [{ subject: detail }] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'allocation.changed' ORDER BY id DESC LIMIT 1`, [projectId]);
		expect(detail.fields).toEqual(['volumeM3PerYear']);
		expect((await owner.call('DELETE', `/projects/${projectId}/allocations/${aid}`)).status).toBe(204);
	});

	it('refuses a month outside 1–12 or twice, a negative rate, an empty or 21st condition', async () => {
		for (const bad of [{ months: [13] }, { months: [0] }, { months: [3, 3] }, { months: [] }, { maxRateM3s: -1 }, { conditions: [''] }, { conditions: new Array(21).fill('c') }, { conditions: ['x'.repeat(501)] }]) {
			const res = await owner.call('POST', `/projects/${projectId}/allocations`, { ...base, ...bad });
			expect(res.status, JSON.stringify(bad)).toBe(400);
		}
	});

	it('the table refuses what the API would, whoever writes (CHECKs)', async () => {
		const insert = (col: string, value: string) =>
			asOwner(`INSERT INTO allocation (project_id, authorisation, water_source, volume_m3_year, ${col}) VALUES ($1, 'licence', 'surface', 1, ${value})`, [projectId]);
		for (const [col, value] of <[string, string][]>[
			['months', `'{13}'`],
			['months', `'{}'`],
			['months', `'{1,NULL}'`],
			['max_rate_m3s', '-1'],
			['conditions', `'{"a": 1}'`],
			['conditions', `(SELECT jsonb_agg(x) FROM generate_series(1, 21) x)`]
		])
			await expect(insert(col, value), `${col} ${value}`).rejects.toThrow(/check constraint/);
		// Positive control: a valid row goes in.
		await insert('months', `'{1,2,12}'`);
		await asOwner(`DELETE FROM allocation WHERE project_id = $1`, [projectId]);
	});

	it('imports them from the template and exports them in its layout', async () => {
		const text = [
			'registration_no,farm,authorisation,water_source,volume_m3_year,months,max_rate_m3s,conditions',
			'IMP-1,Farm A,licence,surface,500,Oct-Mar,0.01,Stop below 0.1 m3/s | Meter monthly'
		].join('\n');
		const res = await owner.call('POST', `/projects/${projectId}/allocations/import/commit`, { kind: 'csv', fileName: 'conditions.csv', text });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const list = (await owner.call('GET', `/projects/${projectId}/allocations`)).body.allocations;
		expect(list[0]).toMatchObject({ registrationNo: 'IMP-1', months: [1, 2, 3, 10, 11, 12], maxRateM3s: 0.01, conditions: ['Stop below 0.1 m3/s', 'Meter monthly'] });
		const csv = await app.request(`/projects/${projectId}/allocations/export.csv`, { headers: { cookie: owner.cookie, origin: 'http://localhost:7777' } });
		const [head, row] = (await csv.text()).split('\r\n');
		expect(head).toContain('months,max_rate_m3s,conditions,source_file');
		expect(row).toContain('1 2 3 10 11 12,0.01,Stop below 0.1 m3/s | Meter monthly,conditions.csv');
		await owner.call('DELETE', `/projects/${projectId}/allocations/sources/${res.body.source.id}`);
	});
});

describe('allocations in the run input (engine 1.18.0)', () => {
	it('adds none to a project that has none: its input is what it was', async () => {
		const res = await viewer.call('GET', `/projects/${projectId}/model-input`);
		expect(res.status).toBe(200);
		expect(res.body.input.model).not.toHaveProperty('allocations');
	});

	it('carries what the engine reads and no name, registration number or property', async () => {
		const res = await owner.call('POST', `/projects/${projectId}/allocations`, { ...base, nodeId: farmA.id, holder: 'Invented Holder', registrationNo: 'REG-SECRET', propertyRef: 'Portion 9', months: [1] });
		expect(res.status).toBe(201);
		const input = (await viewer.call('GET', `/projects/${projectId}/model-input`)).body.input;
		expect(input.model.allocations).toEqual([
			{ id: res.body.allocation.id, nodeId: farmA.id, waterSource: 'surface', volumeM3PerYear: 1000, storageM3: null, validFrom: null, validTo: null, months: [1], maxRateM3s: null }
		]);
		expect(JSON.stringify(input)).not.toMatch(/Invented Holder|REG-SECRET|Portion 9/);
	});

	it('marks the latest run out of date when what a run reads changes, and not for a note', async () => {
		const { allocations } = (await owner.call('GET', `/projects/${projectId}/allocations`)).body;
		const aid = allocations[0].id;
		const t0 = await updatedAt();
		expect((await owner.call('PATCH', `/projects/${projectId}/allocations/${aid}`, { reference: 'letter of 3 May' })).status).toBe(200);
		expect(await updatedAt()).toBe(t0);
		expect((await owner.call('PATCH', `/projects/${projectId}/allocations/${aid}`, { volumeM3PerYear: 2000 })).status).toBe(200);
		expect(await updatedAt()).toBeGreaterThan(t0);
	});
});

describe('the allocation settings (issue #72)', () => {
	let runId: string;

	it('caps a run at the registered volume (settings.allocationMode), and says so', async () => {
		await asOwner('DELETE FROM allocation WHERE project_id = $1', [projectId]);
		// Farm A's surface volume: a trickle, so the cap binds in both water years.
		expect((await owner.call('POST', `/projects/${projectId}/allocations`, { ...base, nodeId: farmA.id, volumeM3PerYear: 500 })).status).toBe(201);
		expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { allocationMode: 'cap', allocationTolerance: 0.2 } })).status).toBe(200);
		const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'capped' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		runId = run.body.run.id;
		const [{ summary }] = await asOwner('SELECT summary FROM model_run WHERE id = $1', [runId]);
		expect(summary.verification.passed).toBe(true);
		expect(summary.allocations).toMatchObject({ mode: 'cap', tolerance: 0.2, used: 1, notMatched: 0 });
		const [{ values }] = await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = 'supplied'`, [runId, farmA.id]);
		const firstYear = (values as number[]).slice(0, 365).reduce((s, v) => s + v, 0);
		expect(firstYear).toBeLessThanOrEqual(500 * (1 + 1e-9));
		expect(firstYear).toBeCloseTo(500, 6);
		// Farm B has no volume: not capped.
		const [{ values: b }] = await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = 'supplied'`, [runId, farmB.id]);
		expect((b as number[]).slice(0, 365).reduce((s, v) => s + v, 0)).toBeGreaterThan(500);
	});

	it('the comparison reads against the project’s band and says what the run’s mode was; ?tolerance= still overrides', async () => {
		const res = await viewer.call('GET', `/projects/${projectId}/runs/${runId}/allocations`);
		expect(res.status).toBe(200);
		expect(res.body.comparison.tolerance).toBe(0.2);
		expect(res.body.run.allocationMode).toBe('cap');
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${runId}/allocations?tolerance=0.05`)).body.comparison.tolerance).toBe(0.05);
	});

	it('refuses a mode that isn’t one, a band outside [0, 1), and a viewer changing either', async () => {
		expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { allocationMode: 'capped' } })).status).toBe(400);
		expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { allocationTolerance: 1 } })).status).toBe(400);
		expect((await viewer.call('PATCH', `/projects/${projectId}`, { settings: { allocationTolerance: 0.3 } })).status).toBe(403);
		const s = (await viewer.call('GET', `/projects/${projectId}`)).body.project.settings;
		expect([s.allocationMode, s.allocationTolerance]).toEqual(['cap', 0.2]);
	});

	it('a capped run keeps to the stored licence’s months of use and maximum rate (engine 1.34.0)', async () => {
		await asOwner('DELETE FROM allocation WHERE project_id = $1', [projectId]);
		// A volume far above the demand, so only the conditions bind: January only, at most 0.0001 m³/s (8.64 m³ a day).
		const created = await owner.call('POST', `/projects/${projectId}/allocations`, { ...base, nodeId: farmA.id, volumeM3PerYear: 1e9, months: [1], maxRateM3s: 0.0001 });
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'licence conditions' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const id = run.body.run.id;
		const [{ summary }] = await asOwner('SELECT summary FROM model_run WHERE id = $1', [id]);
		expect(summary.verification.passed).toBe(true);
		const series = async (nodeId: string, key: string) =>
			(await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = $3`, [id, nodeId, key]))[0]!.values as number[];
		const G = await series(farmA.id, 'supplied');
		const room = await series(farmA.id, 'allocation_room_surface');
		const perDay = 0.0001 * 86_400;
		const d0 = Date.UTC(2021, 9, 1);
		const january = (t: number) => new Date(d0 + t * 86_400_000).getUTCMonth() === 0;
		let atRate = 0;
		for (let t = 0; t < G.length; t++) {
			expect(room[t]!, `day ${t}`).toBeLessThanOrEqual(january(t) ? perDay * (1 + 1e-12) : 0);
			expect(G[t]!, `day ${t}`).toBeLessThanOrEqual(january(t) ? perDay * (1 + 1e-12) : 0);
			if (january(t) && Math.abs(G[t]! - perDay) < 1e-9) atRate++;
		}
		// Positive controls: the rate binds on January days the river has more than it (not all: the fixture's river runs
		// low), and Farm B (no licence) takes more than that rate in other months.
		expect(atRate).toBeGreaterThan(20);
		const B = await series(farmB.id, 'supplied');
		expect(B.some((v, t) => !january(t) && v > perDay)).toBe(true);
	});
});
