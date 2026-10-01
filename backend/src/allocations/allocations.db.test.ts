// Allocations (roadmap WP-3.10 first slice; 038_allocations.sql,
// docs/allocations.md): the API end to end, and RLS with positive controls.
//  - the synthetic WARMS extract previews with ≥ 90 % matched, commits with
//    its file hash as provenance, refuses a second import of the same file,
//    and an import can be undone;
//  - manual entry, edit (manual match) and delete; history records each;
//  - viewers read volumes but never holder names (D3), editors read both, a
//    farmer reads only the allocations (and names) on their own farm, another
//    project's member reads nothing;
//  - a run's comparison sums the run's own supplied series per water year;
//  - the export guards formula-looking cells and hides names from viewers.
import { compareAllocations } from '@water-management/engine';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

const FIXTURE = readFileSync(new URL('./fixtures/warms-synthetic.csv', import.meta.url), 'utf8');

let owner: User;
let editor: User;
let viewer: User;
let farmer: User;
let stranger: User;
let projectId: string;
let otherProjectId: string;
let runId: string;
const outlet = node('Weir', null);
const farms = ['Farm A', 'Farm B', 'Farm C', 'Farm D', 'Farm E'].map((name) => node(name, outlet.id));
const farmA = farms[0]!;
const farmB = farms[1]!;

const rowsAs = async <T = Record<string, unknown>>(u: User, sql: string, params: unknown[] = []) =>
	withUser(u.id, async (db) => (await db.query<T & Record<string, unknown>>(sql, params)).rows);

beforeAll(async () => {
	[owner, editor, viewer, farmer, stranger] = (await Promise.all(['Aowner', 'Aeditor', 'Aviewer', 'Afarmer', 'Astranger'].map((n) => signUp(n)))) as [
		User,
		User,
		User,
		User,
		User
	];
	projectId = (await owner.call('POST', '/projects', { name: 'Allocations' })).body.project.id;
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = {
		nodes: [outlet, ...farms],
		crops: [crop],
		cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 60_000 })),
		transfers: []
	};
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'allocations' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	runId = run.body.run.id;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	otherProjectId = (await stranger.call('POST', '/projects', { name: 'Elsewhere' })).body.project.id;
}, 60_000);

const importBody = (extra: Record<string, unknown> = {}) => ({ kind: 'warms_extract', fileName: 'warms-synthetic.csv', text: FIXTURE, reference: 'synthetic', ...extra });

describe('importing a WARMS extract', () => {
	let sourceId: string;

	it('previews without writing, matching at least 90 % of rows', async () => {
		const res = await editor.call('POST', `/projects/${projectId}/allocations/import`, importBody());
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.summary).toEqual({ rows: 10, valid: 10, invalid: 0, matched: 9, unmatched: 1 });
		expect(res.body.sha256).toMatch(/^[0-9a-f]{64}$/);
		const a = res.body.rows.find((r: { registrationNo: string }) => r.registrationNo === 'SYN-0001');
		expect(a).toMatchObject({ nodeId: farmA.id, matchedBy: 'name', volumeM3PerYear: 120_000 });
		const [{ n }] = await asOwner('SELECT count(*)::int AS n FROM allocation WHERE project_id = $1', [projectId]);
		expect(n).toBe(0);
	});

	it('is refused to a viewer, and a file with an ID-number column is refused', async () => {
		expect((await viewer.call('POST', `/projects/${projectId}/allocations/import`, importBody())).status).toBe(403);
		const res = await editor.call('POST', `/projects/${projectId}/allocations/import`, importBody({ text: 'registration_no,ID Number,volume_m3_year\nR1,8001015009087,5\n' }));
		expect(res.status).toBe(422);
		expect(res.body.error).toMatch(/personal-information columns/);
	});

	it('commits with a manual match, the file hash as provenance, and a history event', async () => {
		const preview = (await editor.call('POST', `/projects/${projectId}/allocations/import`, importBody())).body;
		const z = preview.rows.find((r: { registrationNo: string }) => r.registrationNo === 'SYN-0010');
		const res = await editor.call('POST', `/projects/${projectId}/allocations/import/commit`, importBody({ matches: { [String(z.line)]: farmB.id } }));
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		expect(res.body).toMatchObject({ imported: 10, skipped: 0, unmatched: 0 });
		sourceId = res.body.source.id;
		expect(res.body.source).toMatchObject({ kind: 'warms_extract', fileName: 'warms-synthetic.csv', sha256: preview.sha256, rows: 10, reference: 'synthetic' });
		const list = (await editor.call('GET', `/projects/${projectId}/allocations`)).body;
		expect(list.allocations).toHaveLength(10);
		// What an allocation can be matched to: the farms, never the outlet gauge.
		expect(list.nodes.map((n: { name: string }) => n.name)).toEqual(['Farm A', 'Farm B', 'Farm C', 'Farm D', 'Farm E']);
		expect(list.allocations.find((a: { registrationNo: string }) => a.registrationNo === 'SYN-0010')).toMatchObject({ nodeId: farmB.id, sourceId, holder: 'Nobody Z' });
		const [{ kind }] = await asOwner('SELECT kind FROM audit_event WHERE project_id = $1 ORDER BY id DESC LIMIT 1', [projectId]);
		expect(kind).toBe('allocation.imported');
	});

	it('stores the extract\'s unverified "Existing lawful use" as a claim, not as verified (#281)', async () => {
		const rows = await asOwner(`SELECT a.authorisation FROM allocation a WHERE a.project_id = $1 AND a.registration_no = 'SYN-0004'`, [projectId]);
		expect(rows).toEqual([{ authorisation: 'existing_lawful_use_claimed' }]);
	});

	it('refuses the same file twice, naming the day it was imported where the catchment is', async () => {
		// Imported at 22:30 UTC: the next day in South Africa (the project's zone, 058).
		await asOwner(`UPDATE allocation_source SET imported_at = '2026-09-25T22:30:00Z' WHERE project_id = $1`, [projectId]);
		const res = await editor.call('POST', `/projects/${projectId}/allocations/import`, importBody({ fileName: 'renamed.csv' }));
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/already imported \(as “warms-synthetic\.csv” on 2026-09-26\)/);
	});

	it('undoes an import with its rows, and allows it again after', async () => {
		const extra = FIXTURE.replace(/SYN-00/g, 'TMP-00');
		const done = await editor.call('POST', `/projects/${projectId}/allocations/import/commit`, importBody({ fileName: 'tmp.csv', text: extra }));
		expect(done.status).toBe(201);
		expect((await editor.call('GET', `/projects/${projectId}/allocations`)).body.allocations).toHaveLength(20);
		expect((await editor.call('DELETE', `/projects/${projectId}/allocations/sources/${done.body.source.id}`)).status).toBe(204);
		expect((await editor.call('GET', `/projects/${projectId}/allocations`)).body.allocations).toHaveLength(10);
		expect(sourceId).toBeTruthy();
	});
});

describe('entering allocations by hand', () => {
	let aid: string;

	it('creates, edits and deletes one, recording each', async () => {
		const created = await editor.call('POST', `/projects/${projectId}/allocations`, {
			nodeId: null,
			registrationNo: 'HAND-1',
			holder: 'Hand Entered',
			authorisation: 'licence',
			waterSource: 'groundwater',
			volumeM3PerYear: 5000,
			validFrom: '2020-01-01'
		});
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		aid = created.body.allocation.id;
		expect(created.body.allocation).toMatchObject({ sourceId: null, nodeId: null, holder: 'Hand Entered', purpose: 'irrigation', validFrom: '2020-01-01' });
		const patched = await editor.call('PATCH', `/projects/${projectId}/allocations/${aid}`, { nodeId: farmB.id, holder: '' });
		expect(patched.status).toBe(200);
		expect(patched.body.allocation).toMatchObject({ nodeId: farmB.id, nodeName: 'Farm B', holder: null });
		const kinds = (await asOwner('SELECT kind FROM audit_event WHERE project_id = $1 ORDER BY id DESC LIMIT 2', [projectId])).map((r) => r.kind);
		expect(kinds).toEqual(['allocation.changed', 'allocation.created']);
		expect((await editor.call('DELETE', `/projects/${projectId}/allocations/${aid}`)).status).toBe(204);
		expect((await editor.call('PATCH', `/projects/${projectId}/allocations/${aid}`, { volumeM3PerYear: 1 })).status).toBe(404);
	});

	it('stores each authorisation, Schedule 1 and claimed existing lawful use included (136, #281)', async () => {
		for (const authorisation of ['registration', 'licence', 'general_authorisation', 'schedule_1', 'existing_lawful_use_claimed', 'existing_lawful_use']) {
			const res = await editor.call('POST', `/projects/${projectId}/allocations`, { nodeId: null, authorisation, waterSource: 'surface', volumeM3PerYear: 1 });
			expect(res.status, JSON.stringify(res.body)).toBe(201);
			expect(res.body.allocation.authorisation).toBe(authorisation);
			const [stored] = (await asOwner('SELECT authorisation FROM allocation WHERE id = $1', [res.body.allocation.id])) as { authorisation: string }[];
			expect(stored!.authorisation).toBe(authorisation);
			expect((await editor.call('DELETE', `/projects/${projectId}/allocations/${res.body.allocation.id}`)).status).toBe(204);
		}
		expect((await editor.call('POST', `/projects/${projectId}/allocations`, { nodeId: null, authorisation: 'entitlement', waterSource: 'surface', volumeM3PerYear: 1 })).status).toBe(400);
		await expect(
			asOwner(`INSERT INTO allocation (project_id, authorisation, water_source, volume_m3_year) VALUES ($1, 'entitlement', 'surface', 1)`, [projectId])
		).rejects.toThrow(/allocation_authorisation_check/);
	});

	it('refuses bad input: the outlet gauge as a node, dates out of order, a viewer writing', async () => {
		const base = { nodeId: null, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1 };
		expect((await editor.call('POST', `/projects/${projectId}/allocations`, { ...base, nodeId: outlet.id })).status).toBe(400);
		expect((await editor.call('POST', `/projects/${projectId}/allocations`, { ...base, validFrom: '2021-01-01', validTo: '2020-01-01' })).status).toBe(400);
		expect((await editor.call('POST', `/projects/${projectId}/allocations`, { ...base, volumeM3PerYear: -1 })).status).toBe(400);
		expect((await viewer.call('POST', `/projects/${projectId}/allocations`, base)).status).toBe(403);
		expect((await farmer.call('GET', `/projects/${projectId}/allocations`)).status).toBe(403);
		expect((await stranger.call('GET', `/projects/${projectId}/allocations`)).status).toBe(404);
	});
});

describe('who sees what (RLS)', () => {
	it('shows volumes to a viewer but no holder names; an editor sees both (control)', async () => {
		const asViewer = (await viewer.call('GET', `/projects/${projectId}/allocations`)).body;
		expect(asViewer.canSeeHolders).toBe(false);
		expect(asViewer.allocations).toHaveLength(10);
		expect(asViewer.allocations.every((a: { holder: unknown }) => a.holder === null)).toBe(true);
		expect(await rowsAs(viewer, 'SELECT user_display FROM allocation_holder WHERE project_id = $1', [projectId])).toEqual([]);
		// Positive control: the editor reads the names.
		expect((await rowsAs(editor, 'SELECT user_display FROM allocation_holder WHERE project_id = $1', [projectId])).length).toBeGreaterThan(0);
	});

	it('shows a farmer only the allocations and names on their own farm', async () => {
		const rows = await rowsAs<{ node_id: string }>(farmer, 'SELECT node_id FROM allocation WHERE project_id = $1', [projectId]);
		expect(rows.length).toBe(2);
		expect(new Set(rows.map((r) => r.node_id))).toEqual(new Set([farmA.id]));
		const names = await rowsAs<{ user_display: string }>(farmer, 'SELECT user_display FROM allocation_holder WHERE project_id = $1', [projectId]);
		expect(names.map((n) => n.user_display)).toEqual(['Invented Holdings A', 'Invented Holdings A']);
	});

	it("hides one project's allocations from another project's members (control: own is visible)", async () => {
		expect(await rowsAs(stranger, 'SELECT id FROM allocation WHERE project_id = $1', [projectId])).toEqual([]);
		expect(await rowsAs(stranger, 'SELECT id FROM allocation_source WHERE project_id = $1', [projectId])).toEqual([]);
		expect((await rowsAs(owner, 'SELECT id FROM allocation WHERE project_id = $1', [projectId])).length).toBe(10);
	});

	it("refuses a node from another project", async () => {
		const other = node('Stranger farm', null);
		await stranger.call('PUT', `/projects/${otherProjectId}/model`, { nodes: [other, node('Theirs', other.id)], crops: [], cropAreas: [], transfers: [] });
		const res = await editor.call('POST', `/projects/${projectId}/allocations`, { nodeId: other.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1 });
		expect(res.status).toBe(400);
	});
});

describe('the run comparison', () => {
	it("sums the run's own supplied series per water year against the registered volumes", async () => {
		const res = await viewer.call('GET', `/projects/${projectId}/runs/${runId}/allocations`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const { comparison } = res.body;
		// Not a cap run: no cap years to show.
		expect(res.body.capYears).toEqual([]);
		expect(comparison.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['Farm A', 'Farm B', 'Farm C', 'Farm D', 'Farm E']);
		const a = comparison.nodes.find((n: { nodeId: string }) => n.nodeId === farmA.id);
		// The engine's own arithmetic on the stored series, not a copy of it.
		const [supplied] = await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = 'supplied'`, [runId, farmA.id]);
		const total = (supplied.values as number[]).reduce((s, v) => s + v, 0);
		const modelled = [...a.surface.years, ...a.groundwater.years].reduce((s: number, y: { modelledM3: number }) => s + y.modelledM3, 0);
		expect(modelled).toBeCloseTo(total, 3);
		// Farm A: 120 000 m³ surface + 15 000 m³ groundwater registered; the run starts 1 Oct 2021, so 2021/22 is whole.
		expect(a.surface.years[0]).toMatchObject({ waterYear: 2021, partial: false });
		expect(a.surface.years[0].registeredM3).toBeCloseTo(120_000, 6);
		expect(a.groundwater.years[0].registeredM3).toBeCloseTo(15_000, 6);
		// 150 000 m³ registered against the 100 000 m³ dam: 50 000 m³ smaller, below the band (issue #72).
		expect(a.storage).toEqual({ registeredM3: 150_000, modelledCapacityM3: farmA.damCapacityM3, differenceM3: farmA.damCapacityM3 - 150_000, status: 'under' });
		const again = compareAllocations({
			startDate: '2021-10-01',
			nodes: [{ nodeId: farmA.id, name: 'Farm A', kind: 'farm', supplied: supplied.values }],
			allocations: []
		});
		expect(a.surface.years[0].modelledM3).toBeCloseTo(again.nodes[0]!.surface.years[0]!.modelledM3, 6);
	});

	it('counts groundwater pumped into the dam once: as groundwater, netted out of the dam draw on the surface side (issue #46)', async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Allocations: dam-target borehole' })).body.project.id;
		const out = node('Weir', null);
		const f = node('Pumped farm', out.id, { damCapacityM3: 20_000, damInitialPct: 0.2, supplyRule: 'riverFirst', pumpCapacityM3Day: 60 });
		const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
		const bh = { id: crypto.randomUUID(), nodeId: f.id, name: 'BH-dam', capacityM3Day: 200, annualCapM3: null, mode: 'primary', emergencyBelowPct: 0.3, target: 'dam', depletionFactor: 0 };
		const m = { nodes: [out, f], crops: [crop], cropAreas: [{ nodeId: f.id, cropId: crop.id, areaM2: 60_000 }], transfers: [], boreholes: [bh] };
		expect((await owner.call('PUT', `/projects/${pid}/model`, m)).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(0) } })).status).toBe(200);
		const rain = Array.from({ length: 365 }, (_, i) => (i % 9 === 0 ? 25 : 0));
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
		const run = await owner.call('POST', `/projects/${pid}/runs`, { label: 'dam-target' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const res = await owner.call('GET', `/projects/${pid}/runs/${run.body.run.id}/allocations`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const x = res.body.comparison.nodes.find((n: { nodeId: string }) => n.nodeId === f.id);

		const rows = await asOwner(`SELECT key, "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key IN ('supplied', 'groundwater_used', 'groundwater_to_dam', 'river_abstraction')`, [
			run.body.run.id,
			f.id
		]);
		const s = Object.fromEntries(rows.map((r) => [r.key as string, r.values as number[]]));
		expect(Object.keys(s).sort()).toEqual(['groundwater_to_dam', 'groundwater_used', 'river_abstraction', 'supplied']);
		const sum = (a: number[]) => a.reduce((t, v) => t + v, 0);
		const toDam = sum(s.groundwater_to_dam!);
		const damDraw = sum(s.supplied!.map((v, i) => Math.max(v - s.groundwater_used![i]! - s.river_abstraction![i]!, 0)));
		// The fixture exercises the rule: water is pumped into the dam, drawn out of it, and the river pump runs.
		expect(toDam).toBeGreaterThan(0);
		expect(damDraw).toBeGreaterThan(0);
		expect(sum(s.river_abstraction!)).toBeGreaterThan(0);
		// One whole water year, 2021/22.
		expect(x.groundwater.years).toHaveLength(1);
		expect(x.groundwater.years[0].modelledM3).toBeCloseTo(sum(s.groundwater_used!) + toDam, 3);
		expect(x.surface.years[0].modelledM3).toBeCloseTo(sum(s.supplied!) - sum(s.groundwater_used!) - Math.min(toDam, damDraw), 3);
	});

	it("leaves a forecast run's forecast days out (issue #51); an ordinary run of the same record is the control", async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Allocations: forecast' })).body.project.id;
		const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
		const weir = node('Weir', null);
		const farm = node('Forecast farm', weir.id);
		const m = { nodes: [weir, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 60_000 }], transfers: [] };
		expect((await owner.call('PUT', `/projects/${pid}/model`, m)).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
		const rain = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
		const ordinary = await owner.call('POST', `/projects/${pid}/runs`, { label: 'ordinary' });
		expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(201);
		// 30 dry days of forecast rain after the 400-day record (2021-10-01 … 2022-11-04): the farm irrigates through them.
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_forecast_mm', unit: 'mm', startDate: '2022-11-05', values: new Array(30).fill(0) })).status).toBe(200);
		const forecast = await owner.call('POST', `/projects/${pid}/runs`, { label: 'forecast', forecast: true });
		expect(forecast.status, JSON.stringify(forecast.body)).toBe(201);
		const use = async (id: string) => {
			const res = await owner.call('GET', `/projects/${pid}/runs/${id}/allocations`);
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			return res.body;
		};
		const f = await use(forecast.body.run.id);
		expect(f.run.forecastFrom).toBe('2022-11-05');
		// The forecast run stored the forecast days, and they held use.
		const [stored] = await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = 'supplied'`, [forecast.body.run.id, farm.id]);
		const tail = (stored.values as number[]).slice(400);
		expect(tail).toHaveLength(30);
		expect(tail.reduce((s, v) => s + v, 0)).toBeGreaterThan(0);
		// Its comparison is the ordinary run's to the m³: the record only.
		const o = await use(ordinary.body.run.id);
		expect(o.run.forecastFrom).toBeNull();
		const years = (b: { comparison: { nodes: { nodeId: string; surface: { years: { waterYear: number; modelledM3: number }[] } }[] } }) =>
			b.comparison.nodes.find((n) => n.nodeId === farm.id)!.surface.years.map((y) => [y.waterYear, Math.round(y.modelledM3)]);
		expect(years(f)).toEqual(years(o));
	});

	it('takes a tolerance, and refuses one out of range', async () => {
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${runId}/allocations?tolerance=0.25`)).body.comparison.tolerance).toBe(0.25);
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${runId}/allocations?tolerance=2`)).status).toBe(400);
		expect((await farmer.call('GET', `/projects/${projectId}/runs/${runId}/allocations`)).status).toBe(403);
	});

	it('is a 404 for someone who isn’t a member, the same as a run that doesn’t exist, and never reads another project’s run', async () => {
		// Positive control: a member reads it.
		expect((await viewer.call('GET', `/projects/${projectId}/runs/${runId}/allocations`)).status).toBe(200);
		const res = await stranger.call('GET', `/projects/${projectId}/runs/${runId}/allocations`);
		expect(res.status).toBe(404);
		expect(JSON.stringify(res.body)).not.toMatch(/Farm A|comparison|capYears/);
		expect((await stranger.call('GET', `/projects/${projectId}/runs/${crypto.randomUUID()}/allocations`)).status).toBe(404);
		// Their own project, this project's run: not found, not this run's comparison.
		expect((await stranger.call('GET', `/projects/${otherProjectId}/runs/${runId}/allocations`)).status).toBe(404);
	});
});

describe('the allocations export', () => {
	const get = async (u: User) => {
		const r = await app.request(`/projects/${projectId}/allocations/export.csv`, { headers: { cookie: u.cookie, origin: 'http://localhost:7777' } });
		return { status: r.status, text: await r.text() };
	};

	it('quotes formula-looking cells and keeps names from viewers', async () => {
		const res = await editor.call('POST', `/projects/${projectId}/allocations`, {
			nodeId: farmB.id,
			registrationNo: '=HYPERLINK("x")',
			holder: '@evil',
			authorisation: 'licence',
			waterSource: 'surface',
			volumeM3PerYear: 1
		});
		expect(res.status).toBe(201);
		const asEditor = await get(editor);
		expect(asEditor.status).toBe(200);
		expect(asEditor.text).toContain(`"'=HYPERLINK(""x"")"`);
		expect(asEditor.text).toContain("'@evil");
		expect(asEditor.text.split('\r\n')[0]).toContain('holder');
		const asViewer = await get(viewer);
		expect(asViewer.text.split('\r\n')[0]).not.toContain('holder');
		expect(asViewer.text).not.toContain('Invented Holdings');
		expect(asViewer.text).toContain('warms-synthetic.csv');
	});
});
