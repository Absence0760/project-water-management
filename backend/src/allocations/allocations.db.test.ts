// Allocations (roadmap WP-3.10 first slice; 038_allocations.sql,
// docs/allocations.md): the API end to end, and RLS with positive controls.
//  - the synthetic WARMS extract previews with ≥ 90 % matched, commits with
//    its file hash as provenance, refuses a second import of the same file,
//    and an import can be undone;
//  - manual entry, edit (manual match) and delete; history records each;
//  - viewers never read holder names (D3), and read each volume only once an
//    owner allows it (162): before that, totals per water source held by 5 or
//    more registered users, and no copy of the volumes in a run they read;
//    editors read both, a farmer reads only the allocations (and names) on
//    their own farm, another project's member reads nothing;
//  - a WARMS extract needs its reference (how it was obtained, 162);
//  - a run's comparison sums the run's own supplied series per water year;
//  - the export guards formula-looking cells and hides names from viewers.
import { allocationStatus, compareAllocations, type AllocationComparison, type AllocationStatus } from '@water-management/engine';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The report job's render request (REPORT_RENDERER=sqs in the render-claim test): captured, never sent.
const { sent } = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[] }));
vi.mock('../jobs/transport.js', async (orig) => ({
	...(await orig<typeof import('../jobs/transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: Record<string, unknown>) => void sent.push(message)
}));

import { figuresAt, holdsFigure } from '../__tests__/figures.js';
import { actForAuthority, anon, app, asOwner, DECISION, monthly, node, signUp } from '../__tests__/helpers.js';
import { reportRenderHandler } from '../jobs/handlers/report-render.js';
import { computeSweep } from '../sweeps/store.js';
import { buildPackManifest, ENGINE_VERSION, packManifestText } from '@water-management/engine';
import { createHash } from 'node:crypto';
import { withUser } from '../db/tx.js';
import { buildLadder, clearLadderJobs, SAMPLE, type LadderCtx } from '../__tests__/routeSamples.js';
import { membersAmong } from '../reports/store.js';

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

describe('what a viewer reads before the owners allow each volume (162, decision D3)', () => {
	const surfaceToday = 120_000 + 80_000 + 4_000 + 60_000 + 95_000 + 70_000 + 10_000;

	it('gives a viewer no allocation row, only totals for a source 5 or more registered users hold; an editor reads every row (positive control)', async () => {
		expect(await rowsAs(viewer, 'SELECT id FROM allocation WHERE project_id = $1', [projectId])).toEqual([]);
		expect((await rowsAs(editor, 'SELECT id FROM allocation WHERE project_id = $1', [projectId])).length).toBe(10);
		const asViewer = (await viewer.call('GET', `/projects/${projectId}/allocations`)).body;
		expect(asViewer).toMatchObject({ allocations: [], viewerUnits: false, unitsHidden: true, canSeeHolders: false });
		// Surface water: six registered users (A–E and Z). Groundwater: three (A, D, E), too few for a total.
		// The storage in force is four holders' (150 000, 90 000, 75 000, 100 000): fewer than 5, so not given (#523 G).
		expect(asViewer.totals).toEqual([{ waterSource: 'surface', holders: 6, registeredM3PerYear: surfaceToday, storageM3: null, storageWithheld: true }]);
		expect(JSON.stringify(asViewer)).not.toContain(String(150_000 + 90_000 + 75_000 + 100_000));
		expect(JSON.stringify(asViewer)).not.toMatch(/SYN-00|Invented Holdings|Portion 1/);
		const asEditor = (await editor.call('GET', `/projects/${projectId}/allocations`)).body;
		expect(asEditor).toMatchObject({ viewerUnits: false, unitsHidden: false, totals: null });
		expect(asEditor.allocations).toHaveLength(10);
	});

	it('refuses the totals’ volumes for a source fewer than 5 hold, counting a holder once however many farms or rows they have', async () => {
		const rows = await rowsAs<{ water_source: string; holders: number }>(viewer, 'SELECT DISTINCT water_source, holders FROM app_allocation_volumes($1)', [projectId]);
		expect(rows).toEqual([{ water_source: 'surface', holders: 6 }]);
		// One more groundwater row under a holder already counted (A, in other spacing and case) is still three holders.
		const extra = await editor.call('POST', `/projects/${projectId}/allocations`, { nodeId: farmB.id, holder: '  invented   HOLDINGS a ', authorisation: 'licence', waterSource: 'groundwater', volumeM3PerYear: 1 });
		expect(extra.status).toBe(201);
		expect((await rowsAs(viewer, "SELECT 1 FROM app_allocation_volumes($1) WHERE water_source = 'groundwater'", [projectId])).length).toBe(0);
		expect((await editor.call('DELETE', `/projects/${projectId}/allocations/${extra.body.allocation.id}`)).status).toBe(204);
		// An unnamed surface row on Farm A (whose rows name A) is A's, not a seventh holder.
		const unnamed = await editor.call('POST', `/projects/${projectId}/allocations`, { nodeId: farmA.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1 });
		expect(unnamed.status).toBe(201);
		expect(await rowsAs(viewer, 'SELECT DISTINCT water_source, holders FROM app_allocation_volumes($1)', [projectId])).toEqual([{ water_source: 'surface', holders: 6 }]);
		expect((await editor.call('DELETE', `/projects/${projectId}/allocations/${unnamed.body.allocation.id}`)).status).toBe(204);
		// A stranger isn't let in at all.
		await expect(rowsAs(stranger, 'SELECT 1 FROM app_allocation_volumes($1)', [projectId])).rejects.toThrow(/not a member/);
	});

	it('serves a viewer the run’s use summed per water source and year, and no comparison by unit', async () => {
		const res = await viewer.call('GET', `/projects/${projectId}/runs/${runId}/allocations`);
		expect(res.status).toBe(200);
		expect(res.body.comparison).toBeNull();
		expect(res.body.capYears).toEqual([]);
		const { totals } = res.body;
		expect(totals.sources.map((s: { waterSource: string }) => s.waterSource)).toEqual(['surface']);
		// The same sums as the editor's comparison over the units with a surface volume.
		const full = (await editor.call('GET', `/projects/${projectId}/runs/${runId}/allocations`)).body.comparison;
		const held = full.nodes.filter((n: { surface: { allocationIds: string[] } }) => n.surface.allocationIds.length > 0);
		const want = held.reduce((s: number, n: { surface: { years: { modelledM3: number }[] } }) => s + n.surface.years[0]!.modelledM3, 0);
		expect(totals.sources[0].years[0].modelledM3).toBeCloseTo(want, 6);
		expect(totals.sources[0].units).toBe(held.length);
		expect(JSON.stringify(res.body)).not.toMatch(/Farm [A-E]/);
	});

	it('leaves the volumes out of the run a viewer reads, and refuses them the allocations CSV', async () => {
		// A run made with the volumes in its input.
		const made = await owner.call('POST', `/projects/${projectId}/runs`, { label: 'with volumes' });
		expect(made.status).toBe(201);
		const id = made.body.run.id;
		const asEditor = (await editor.call('GET', `/projects/${projectId}/runs/${id}`)).body.run;
		expect(asEditor.model.allocations.length).toBeGreaterThan(0);
		const asViewer = (await viewer.call('GET', `/projects/${projectId}/runs/${id}`)).body.run;
		expect(asViewer.model.allocations).toEqual([]);
		expect(asViewer.summary.allocations.nodes).toEqual([]);
		// Compare-only: its numbers don't rest on the volumes, so its input comes without them.
		const input = (await viewer.call('GET', `/projects/${projectId}/runs/${id}/model-input`)).body.input;
		expect(input.model.allocations).toEqual([]);
		expect((await editor.call('GET', `/projects/${projectId}/runs/${id}/model-input`)).body.input.model.allocations.length).toBeGreaterThan(0);
		const compare = await viewer.call('GET', `/compare/runs?a=${encodeURIComponent(`${projectId}:${id}`)}&b=${encodeURIComponent(`${projectId}:${runId}`)}`);
		expect(compare.status, JSON.stringify(compare.body)).toBe(200);
		expect(compare.body.a.run.inputs.model.allocations).toEqual([]);
		expect(JSON.stringify(compare.body)).not.toContain('"volumeM3PerYear":120000');
		const csv = await app.request(`/projects/${projectId}/allocations/export.csv`, { headers: { cookie: viewer.cookie, origin: 'http://localhost:7777' } });
		expect(csv.status).toBe(403);
		expect((await owner.call('DELETE', `/projects/${projectId}/runs/${id}`)).status).toBe(204);
	});

	it('lets only an owner switch it, records it, and the app can’t write the column itself', async () => {
		expect((await editor.call('PUT', `/projects/${projectId}/allocations/viewer-units`, { on: true })).status).toBe(403);
		await expect(rowsAs(owner, 'UPDATE project SET allocations_viewer_units = true WHERE id = $1', [projectId])).rejects.toThrow(/only an owner/);
		const res = await owner.call('PUT', `/projects/${projectId}/allocations/viewer-units`, { on: true });
		expect(res.status).toBe(200);
		const [ev] = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'allocation.viewer_units' ORDER BY id DESC LIMIT 1`, [projectId]);
		expect(ev.subject).toEqual({ on: true });
		// Now the viewer reads each row (the tests below rely on it), never a name.
		expect((await rowsAs(viewer, 'SELECT id FROM allocation WHERE project_id = $1', [projectId])).length).toBe(10);
		expect((await viewer.call('GET', `/projects/${projectId}/allocations`)).body).toMatchObject({ viewerUnits: true, unitsHidden: false, totals: null });
	});

	it('needs a WARMS extract’s reference: how it was obtained', async () => {
		const res = await editor.call('POST', `/projects/${projectId}/allocations/import`, importBody({ reference: '  ' }));
		expect(res.status).toBe(400);
		expect(JSON.stringify(res.body)).toContain('DWS or CMA letter or terms');
		// A CSV of the template needs none (positive control: it reaches the parser, which reads the file).
		expect((await editor.call('POST', `/projects/${projectId}/allocations/import`, importBody({ kind: 'csv', reference: '' }))).status).not.toBe(400);
		await expect(asOwner(`INSERT INTO allocation_source (project_id, kind, file_name, sha256) VALUES ($1, 'warms_extract', 'x.csv', $2)`, [projectId, 'b'.repeat(64)])).rejects.toThrow(
			/allocation_source_warms_reference/
		);
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

	it('measures a dam beside the river at the intake: River to dam less the same day\'s spill, draws reported not counted; an older run reads by the draws (engine 1.82.0, issue #513)', async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Allocations: dam beside the river' })).body.project.id;
		const out = node('Weir', null);
		// Beside the river: none of the upstream inflow reaches the dam, River to dam fills it; small, so it spills.
		const f = node('Off-river farm', out.id, { damCapacityM3: 3_000, damInitialPct: 0.5, pctUpstreamToDam: 0, pctRunoffToDam: 0.3, divertCapacityM3Day: 400 });
		// On the river (all the upstream inflow into it): the draws rule, the control.
		const g = node('On-river farm', out.id, { damCapacityM3: 20_000, damInitialPct: 0.5, pctUpstreamToDam: 1, pctRunoffToDam: 0.3 });
		const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
		const m = { nodes: [out, f, g], crops: [crop], cropAreas: [{ nodeId: f.id, cropId: crop.id, areaM2: 30_000 }, { nodeId: g.id, cropId: crop.id, areaM2: 30_000 }], transfers: [] };
		expect((await owner.call('PUT', `/projects/${pid}/model`, m)).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(0) } })).status).toBe(200);
		const rain = Array.from({ length: 365 }, (_, i) => (i % 9 === 0 ? 25 : 0));
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
		const run = await owner.call('POST', `/projects/${pid}/runs`, { label: 'off-river' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const compare = async () => {
			const res = await owner.call('GET', `/projects/${pid}/runs/${run.body.run.id}/allocations`);
			expect(res.status, JSON.stringify(res.body)).toBe(200);
			return (id: string) => res.body.comparison.nodes.find((n: { nodeId: string }) => n.nodeId === id);
		};
		const x = (await compare())(f.id);

		const rows = await asOwner(`SELECT key, "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key IN ('supplied', 'diverted_to_dam', 'spill', 'intake_take')`, [run.body.run.id, f.id]);
		const s = Object.fromEntries(rows.map((r) => [r.key as string, r.values as number[]]));
		const sum = (a: number[]) => a.reduce((t, v) => t + v, 0);
		const O = s.diverted_to_dam!;
		const R = s.spill!;
		// The fixture diverts, spills on days it diverts, and draws on the dam.
		expect(sum(O)).toBeGreaterThan(0);
		expect(R.some((v, i) => v > 0 && O[i]! > 0)).toBe(true);
		expect(sum(s.supplied!)).toBeGreaterThan(0);
		const take = sum(O.map((o, i) => o - Math.min(R[i]!, o)));
		expect(sum(s.intake_take!)).toBeCloseTo(take, 3);
		expect(x.surface.measuredAt).toBe('intake');
		expect(x.surface.years).toHaveLength(1);
		expect(x.surface.years[0].modelledM3).toBeCloseTo(take, 3);
		// Draws (no river pump here: all of supplied) are reported, not added.
		expect(x.surface.years[0].damDrawM3).toBeCloseTo(sum(s.supplied!), 3);
		// The dam on the river keeps the draws rule (positive control: it has use to count).
		const y = (await compare())(g.id);
		expect(y.surface.measuredAt).toBeUndefined();
		expect(y.surface.years[0].modelledM3).toBeGreaterThan(0);
		// Its dam losses (evaporation + seepage that doesn't return) are reported beside the use, not in it (engine 1.83.0, #507 item 7).
		const gl = await asOwner(`SELECT key, "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key IN ('dam_evaporation', 'dam_seepage_lost')`, [run.body.run.id, g.id]);
		const losses = gl.reduce((t, r) => t + sum(r.values as number[]), 0);
		expect(losses).toBeGreaterThan(0);
		expect(y.surface.years[0].damLossesM3).toBeCloseTo(losses, 3);
		expect(y.groundwater.years[0].damLossesM3).toBeUndefined();
		// The dam beside the river reports none: its take at the intake already holds what the dam later loses.
		expect(x.surface.years[0].damLossesM3).toBeUndefined();

		// An older run: no intake_take (a 1.79.0–1.81.0 run stored diverted_loss instead, which isn't read): the draws.
		await asOwner(`UPDATE run_series SET key = 'diverted_loss' WHERE run_id = $1 AND node_id = $2 AND key = 'intake_take'`, [run.body.run.id, f.id]);
		const old = (await compare())(f.id);
		expect(old.surface.measuredAt).toBeUndefined();
		expect(old.surface.years[0].damDrawM3).toBeUndefined();
		expect(old.surface.years[0].modelledM3).toBeCloseTo(sum(s.supplied!), 3);
	});

	it('counts water a dam rule pumps out of the catchment as its source unit’s surface use (engine-audit.md X1), read from the run’s own stored rules', async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Allocations: transfer out of the catchment' })).body.project.id;
		const out = node('Weir', null);
		// A dam on the river (all the upstream inflow into it), full, with crops: its draws are its use.
		const f = node('Exporting farm', out.id, { damCapacityM3: 20_000, damInitialPct: 1, pctUpstreamToDam: 1, pctRunoffToDam: 0.3 });
		const g = node('Neighbour', out.id, { damCapacityM3: 20_000, damInitialPct: 1, pctUpstreamToDam: 1, pctRunoffToDam: 0.3 });
		const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
		const rule = {
			id: crypto.randomUUID(), fromNodeId: f.id, toNodeId: null, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], maxRateM3s: 30 / 86_400, dailyCapM3: null,
			minStoragePct: 0.2, enabled: true, priority: 0, monthlyRateM3s: null, source: 'dam', handsOffM3Day: null, handsOffEwr: false, lossPct: 0, sizing: 'demand',
			topUpDam: false, lossReturnPct: 0, lossReturnNodeId: null
		};
		const m = { nodes: [out, f, g], crops: [crop], cropAreas: [{ nodeId: f.id, cropId: crop.id, areaM2: 20_000 }, { nodeId: g.id, cropId: crop.id, areaM2: 20_000 }], transfers: [rule] };
		expect((await owner.call('PUT', `/projects/${pid}/model`, m)).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(0) } })).status).toBe(200);
		const rain = Array.from({ length: 365 }, (_, i) => (i % 9 === 0 ? 25 : 0));
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
		const run = await owner.call('POST', `/projects/${pid}/runs`, { label: 'export' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const res = await owner.call('GET', `/projects/${pid}/runs/${run.body.run.id}/allocations`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const at = (id: string) => res.body.comparison.nodes.find((n: { nodeId: string }) => n.nodeId === id);
		const sum = (a: number[]) => a.reduce((t, v) => t + v, 0);
		const series = async (id: string, key: string) => (await asOwner(`SELECT "values" FROM run_series WHERE run_id = $1 AND node_id = $2 AND key = $3`, [run.body.run.id, id, key]))[0]!.values as number[];
		const sent = sum(await series(f.id, `transfer_rule@${rule.id}`));
		expect(sent).toBeGreaterThan(0);
		const supplied = sum(await series(f.id, 'supplied'));
		expect(supplied).toBeGreaterThan(0);
		// The exporting unit's surface use is what it supplied plus what it sent out.
		expect(at(f.id).surface.years[0].modelledM3).toBeCloseTo(supplied + sent, 3);
		// Positive control: the neighbour, with no rule out, is its supply alone.
		expect(at(g.id).surface.years[0].modelledM3).toBeCloseTo(sum(await series(g.id, 'supplied')), 3);
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

// Issue #523 G–O: what a viewer kept from each volume reads of the registered volumes. Since round 4 (operator's
// decision, 2026-10-11) the only registered m³ they read is today's total per water source, at 5 or more holders in
// force with none (or two) dominating it; a run's water years and the evidence report's totals of other units give
// them the modelled use and the status only. Each test is the review's repro, which failed before, with an editor
// positive control.

/** A project with units `names` under a weir, rain from `start` for `days`, the editor and viewer as members. */
async function volumesProject(name: string, names: string[], start: string, days: number) {
	const pid = (await owner.call('POST', '/projects', { name })).body.project.id as string;
	const weir = node('Weir', null);
	const units = names.map((n) => node(n, weir.id));
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = { nodes: [weir, ...units], crops: [crop], cropAreas: units.map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 60_000 })), transfers: [] };
	expect((await owner.call('PUT', `/projects/${pid}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: days }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: start, values: rain })).status).toBe(200);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer']
	] as const)
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: u.email, role })).status).toBe(201);
	const add = async (nodeId: string | null, holder: string, volumeM3PerYear: number, dates: { validFrom?: string; validTo?: string } = {}) => {
		const res = await editor.call('POST', `/projects/${pid}/allocations`, { nodeId, holder, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear, ...dates });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return res.body.allocation.id as string;
	};
	const run = async (label: string) => {
		const made = await owner.call('POST', `/projects/${pid}/runs`, { label });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		return made.body.run.id as string;
	};
	return { pid, units, add, run };
}

type Section5 = { othersRegisteredWithheld?: true; units: { nodeId: string; aggregate?: number; sources: { meanRegisteredA: number | null; years: { waterYear: number; registeredA: number | null; registeredB: number | null; statusA: string | null; withheldA?: true }[] }[] }[] };
const others = (al: Section5) => al.units.find((u) => u.nodeId === 'others:surface')?.sources[0]?.years ?? null;

describe('#523 G: staggered dates (one holder since 2005, four from 2018 to 2024)', () => {
	const VOL = 123_457;
	const OTHER = 50_000;
	let pid: string;
	let run: string;

	beforeAll(async () => {
		const p = await volumesProject('Staggered holders', ['S1', 'S2', 'S3', 'S4', 'S5'], '2016-10-01', 3 * 365);
		pid = p.pid;
		await p.add(p.units[0]!.id, 'Staggered Holder One', VOL, { validFrom: '2005-10-01' });
		for (let i = 1; i < 5; i++) await p.add(p.units[i]!.id, `Staggered Holder ${i + 1}`, OTHER, { validFrom: '2018-10-01', validTo: '2024-09-30' });
		run = await p.run('staggered');
	}, 120_000);

	it('the database counts 5 holders of the source, each row a salted key (no name, no ordinal); an editor reads VOL on its row (positive control)', async () => {
		expect(await rowsAs(viewer, 'SELECT DISTINCT water_source, holders FROM app_allocation_volumes($1)', [pid])).toEqual([{ water_source: 'surface', holders: 5 }]);
		const keys = await rowsAs<{ holder: string }>(viewer, 'SELECT holder FROM app_allocation_volumes($1)', [pid]);
		expect(new Set(keys.map((k) => k.holder)).size).toBe(5);
		expect(keys.every((k) => /^[0-9a-f]{32}$/.test(k.holder))).toBe(true);
		expect((await editor.call('GET', `/projects/${pid}/allocations`)).body.allocations.map((a: { volumeM3PerYear: number }) => a.volumeM3PerYear)).toContain(VOL);
	});

	it('GET …/allocations: today only VOL is in force, so the viewer’s total is withheld, not VOL', async () => {
		const res = await viewer.call('GET', `/projects/${pid}/allocations`);
		expect(res.body.totals).toEqual([{ waterSource: 'surface', holders: 5, registeredM3PerYear: null, storageM3: null }]);
		expect(holdsFigure(JSON.stringify(res.body), VOL)).toBe(false);
	});

	it('GET …/runs/:runId/allocations: modelled use per year only, no status, and no judgement (the rows change in 2018); the editor’s comparison holds VOL (positive control)', async () => {
		const res = await viewer.call('GET', `/projects/${pid}/runs/${run}/allocations`);
		const src = res.body.totals.sources[0];
		expect(src.years.map((y: object) => Object.keys(y).sort())).toEqual(new Array(3).fill(['modelledM3', 'partial', 'waterYear']));
		expect(src.judgement).toBeNull();
		expect(JSON.stringify(res.body)).not.toMatch(/registered/i);
		expect(holdsFigure(JSON.stringify(res.body), VOL)).toBe(false);
		expect(holdsFigure(JSON.stringify((await editor.call('GET', `/projects/${pid}/runs/${run}/allocations`)).body.comparison), VOL)).toBe(true);
	});

	it('§ 5: the editor reads 2016 and 2017 withheld and 2018 the five’s total; the viewer reads no registered m³ in it at all', async () => {
		const asEditor = (await editor.call('GET', `/projects/${pid}/runs/${run}/evidence-report`)).body.report;
		const ed = others(asEditor.allocations)!;
		expect(ed.map((y) => [y.waterYear, y.withheldA ?? false])).toEqual([
			[2016, true],
			[2017, true],
			[2018, false]
		]);
		expect(ed[2]!.registeredA!).toBeCloseTo(VOL + 4 * OTHER, 6);
		expect(holdsFigure(JSON.stringify(asEditor.appendix), VOL)).toBe(true);
		const asViewer = (await viewer.call('GET', `/projects/${pid}/runs/${run}/evidence-report`)).body.report;
		expect(asViewer.allocations.othersRegisteredWithheld).toBe(true);
		expect(others(asViewer.allocations)!.every((y) => y.registeredA === null && y.registeredB === null)).toBe(true);
		for (const v of [VOL, VOL + 4 * OTHER]) expect(figuresAt(JSON.stringify(asViewer), v), String(v)).toEqual([]);
	});
});

describe('#523 K, L, M: no two figures a viewer reads at the same time differ by one holder’s volume', () => {
	// Five matched holders on S1–S5, a sixth unmatched (no unit, L), a seventh on S6 from 2018-10-01 (M).
	const V = [51_234, 52_345, 53_456, 54_567, 55_678];
	const UNMATCHED = 111_119;
	const LATER = 123_457;
	const TODAY = V.reduce((s, v) => s + v, 0) + UNMATCHED + LATER;
	let pid: string;
	let base: string;
	let scenarioRun: string;

	beforeAll(async () => {
		const p = await volumesProject('Same-time differences', ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'], '2016-10-01', 3 * 365);
		pid = p.pid;
		const ids = [];
		for (let i = 0; i < 5; i++) ids.push(await p.add(p.units[i]!.id, `Same Time Holder ${i + 1}`, V[i]!));
		await p.add(null, 'Same Time Unmatched', UNMATCHED);
		await p.add(p.units[5]!.id, 'Same Time Later', LATER, { validFrom: '2018-10-01' });
		base = await p.run('same time');
		// K: an editor's team scenario that takes S1's row away.
		const sc = await editor.call('POST', `/projects/${pid}/scenarios`, { name: 'Without S1', baseRunId: base, ops: [{ op: 'allocation.remove', allocationId: ids[0] }] });
		expect(sc.status, JSON.stringify(sc.body)).toBe(201);
		const ran = await editor.call('POST', `/projects/${pid}/scenarios/${sc.body.scenario.id}/runs`, {});
		expect(ran.status, JSON.stringify(ran.body)).toBe(201);
		scenarioRun = ran.body.run.id;
	}, 180_000);

	it('positive control: the editor reads each figure the differences would come from', async () => {
		const ed = others((await editor.call('GET', `/projects/${pid}/runs/${scenarioRun}/evidence-report`)).body.report.allocations)!;
		// K: in 2018 (S2–S5 and the later holder in the application, 5 holders) baseline less application is S1's volume.
		expect(ed[2]!.registeredA! - ed[2]!.registeredB!).toBeCloseTo(V[0]!, 3);
		// M: 2018 less 2017 is the later holder's.
		expect(ed[2]!.registeredA! - ed[1]!.registeredA!).toBeCloseTo(LATER, 3);
	});

	it('L and M: today’s total is shown, and no year of the run carries a registered m³ to subtract from it or from another year', async () => {
		const today = (await viewer.call('GET', `/projects/${pid}/allocations`)).body.totals[0];
		expect(today.registeredM3PerYear).toBe(TODAY);
		const text = JSON.stringify((await viewer.call('GET', `/projects/${pid}/runs/${base}/allocations`)).body);
		for (const v of [UNMATCHED, LATER, TODAY - UNMATCHED - LATER, TODAY - UNMATCHED]) expect(figuresAt(text, v), String(v)).toEqual([]);
		expect(text).not.toMatch(/registered/i);
	});

	it('K, L and M in the live evidence report: no registered m³ in the totals of other units, baseline or application', async () => {
		const r = (await viewer.call('GET', `/projects/${pid}/runs/${scenarioRun}/evidence-report`)).body.report;
		const ys = others(r.allocations)!;
		expect(ys.length).toBe(3);
		expect(ys.every((y) => y.registeredA === null && y.registeredB === null)).toBe(true);
		expect(r.allocations.units.every((u: Section5['units'][number]) => u.sources.every((s) => s.meanRegisteredA === null))).toBe(true);
		const text = JSON.stringify(r);
		for (const v of [V[0]!, LATER, UNMATCHED, V.reduce((s, x) => s + x, 0), V.reduce((s, x) => s + x, 0) + LATER]) expect(figuresAt(text, v), String(v)).toEqual([]);
	});
});

describe('#523 G1c: page 1’s "Registered vs modelled use" row counts no other unit’s years for a viewer', () => {
	// Every unit's whole years over the band, per team scenario run at a fixed band, bound one unit's volume; the
	// viewer's row and unitYears count the applicant's own units only, and a team scenario or baseline evidence has none.
	let pid: string;
	let base: string;
	let scenarioRun: string;
	type Row = { id: string; baseline: number | null; application: number | null; notAssessed: string | null; note: string | null };
	const useRow = (r: { rows: Row[] }) => r.rows.find((x) => x.id === 'registeredUse')!;

	beforeAll(async () => {
		const p = await volumesProject('Unit-years', ['U1', 'U2', 'U3', 'U4', 'U5'], '2016-10-01', 3 * 365);
		pid = p.pid;
		// Small volumes, so every whole year of every unit is over the band.
		for (let i = 0; i < 5; i++) await p.add(p.units[i]!.id, `Unit Years Holder ${i + 1}`, 10 + i);
		base = await p.run('unit-years');
		const sc = await editor.call('POST', `/projects/${pid}/scenarios`, { name: 'Unit-years team', baseRunId: base, ops: [] });
		expect(sc.status, JSON.stringify(sc.body)).toBe(201);
		const ran = await editor.call('POST', `/projects/${pid}/scenarios/${sc.body.scenario.id}/runs`, {});
		expect(ran.status, JSON.stringify(ran.body)).toBe(201);
		scenarioRun = ran.body.run.id;
	}, 180_000);

	it('positive control: the editor’s row and unitYears count every unit’s whole years over the band', async () => {
		for (const run of [base, scenarioRun]) {
			const r = (await editor.call('GET', `/projects/${pid}/runs/${run}/evidence-report`)).body.report;
			expect(r.allocations.units.map((u: { nodeId: string }) => u.nodeId)).toEqual(['others:surface']);
			expect(r.allocations.unitYears.judgedA).toBeGreaterThan(0);
			expect(r.allocations.unitYears.overA).toBe(r.allocations.unitYears.judgedA);
			expect(useRow(r).baseline).toBe(r.allocations.unitYears.overA);
			expect(useRow(r).notAssessed).toBeNull();
		}
	});

	it('the viewer’s row is withheld and unitYears counts nothing, on the team scenario and on baseline evidence', async () => {
		for (const run of [base, scenarioRun]) {
			const r = (await viewer.call('GET', `/projects/${pid}/runs/${run}/evidence-report`)).body.report;
			const row = useRow(r);
			expect([row.baseline, row.application, row.note]).toEqual([null, null, null]);
			expect(row.notAssessed).toMatch(/^Not shown: this project shows registered volumes to its editors and owners only/);
			expect(r.allocations.unitYears).toMatchObject({ overA: 0, judgedA: 0 });
			// The page-1 flag says nothing of the totals either (round 6).
			expect(r.flags.map((f: { id: string }) => f.id)).not.toContain('allocationsOver');
		}
	});
});

describe('#523 round 5: the band, cap and full-allocation runs, run visibility, erasure', () => {
	const V = [51_234, 52_345, 53_456, 54_567, 55_678];
	const LATER = 123_457;
	let pid: string;
	let base: string;
	let fullRun: string;
	let ids: string[];

	beforeAll(async () => {
		const p = await volumesProject('Round five', ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'], '2016-10-01', 3 * 365);
		pid = p.pid;
		ids = [];
		for (let i = 0; i < 5; i++) ids.push(await p.add(p.units[i]!.id, `Round Five Holder ${i + 1}`, V[i]!));
		ids.push(await p.add(p.units[5]!.id, 'Round Five Later', LATER, { validFrom: '2018-10-01' }));
		base = await p.run('round five');
		// An editor's team scenario that runs the baseline at full allocation: each unit's demand scaled to its volume.
		const sc = await editor.call('POST', `/projects/${pid}/scenarios`, { name: 'At full allocation', baseRunId: base, ops: [{ op: 'settings.set', path: 'allocationMode', value: 'fullAllocation' }] });
		expect(sc.status, JSON.stringify(sc.body)).toBe(201);
		const ran = await editor.call('POST', `/projects/${pid}/scenarios/${sc.body.scenario.id}/runs`, {});
		expect(ran.status, JSON.stringify(ran.body)).toBe(201);
		fullRun = ran.body.run.id;
	}, 180_000);

	it('R5-1: the viewer’s totals use the run’s own band, whatever ?tolerance= says; the editor’s comparison takes it (positive control)', async () => {
		const plain = await viewer.call('GET', `/projects/${pid}/runs/${base}/allocations`);
		expect(plain.status).toBe(200);
		expect(plain.body.totals.tolerance).toBe(0.1);
		for (const t of [0, 0.01, 0.37, 0.99]) expect((await viewer.call('GET', `/projects/${pid}/runs/${base}/allocations?tolerance=${t}`)).body, String(t)).toEqual(plain.body);
		const ed = async (t: number) => (await editor.call('GET', `/projects/${pid}/runs/${base}/allocations?tolerance=${t}`)).body.comparison;
		expect((await ed(0.37)).tolerance).toBe(0.37);
		const statuses = async (t: number) => (await ed(t)).nodes.flatMap((n: { surface: { years: { status: string }[] } }) => n.surface.years.map((y) => y.status));
		expect(await statuses(0)).not.toEqual(await statuses(0.99));
	});

	it('R5-2: a full-allocation run gives the viewer no totals by year, and § 5 no modelled use, so no two years differ by a holder’s volume; the editor reads them (positive control)', async () => {
		const res = await viewer.call('GET', `/projects/${pid}/runs/${fullRun}/allocations`);
		expect(res.status).toBe(200);
		expect([res.body.totals, res.body.totalsWithheld, res.body.comparison]).toEqual([null, 'allocation_mode', null]);
		// The report on a full-allocation run is its verdicts and counts only for this viewer (#523 I, verdictsOnly.ts),
		// stricter than § 5 without modelled use: no allocations section at all, so no two years to take one from the other.
		const r = (await viewer.call('GET', `/projects/${pid}/runs/${fullRun}/evidence-report`)).body.report;
		expect(r.withheld).toContain('allocations');
		expect(r.allocations.units).toEqual([]);
		expect(typeof r.allocations.notAssessed).toBe('string');
		expect(others(r.allocations)).toBeFalsy();
		// Positive control: the editor reads the application side's modelled use for every year.
		const ed = others((await editor.call('GET', `/projects/${pid}/runs/${fullRun}/evidence-report`)).body.report.allocations)! as unknown as { modelledB: number | null }[];
		expect(ed.every((y) => typeof y.modelledB === 'number')).toBe(true);
		expect((await editor.call('GET', `/projects/${pid}/runs/${fullRun}/allocations`)).body.comparison).not.toBeNull();
	});

	it('R5-3: app_run_allocation_holders answers only for a run the caller can read', async () => {
		const call = (u: User, run: string) => rowsAs<{ allocation_id: string }>(u, 'SELECT allocation_id FROM app_run_allocation_holders($1, $2, $3::text[])', [pid, run, ids]);
		expect(await call(viewer, base)).toHaveLength(6);
		// A draft application of someone else's, with a copy of the base run as its run: the viewer can't read it.
		// Planted as the schema owner, signed in as a contributor for the scenario's own trigger (a fresh session, then closed).
		const applicant = await signUp('R5applicant');
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: applicant.email, role: 'contributor' })).status).toBe(201);
		expect((await owner.call('POST', `/projects/${pid}/publication`, { runId: base })).status).toBeLessThan(300);
		const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
		await client.connect();
		let sc: { id: string };
		try {
			await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [applicant.id]);
			sc = (
				await client.query<{ id: string }>(
					`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, origin, status, owner_user_id) VALUES ($1, 'Hidden draft', $2, repeat('0', 64), 'applicant', 'draft', $3) RETURNING id`,
					[pid, base, applicant.id]
				)
			).rows[0]!;
		} finally {
			await client.end();
		}
		const [run] = await asOwner(
			`INSERT INTO model_run (id, project_id, created_by, label, engine_version, start_date, end_date, inputs, summary, scenario_id, trigger)
			 SELECT gen_random_uuid(), project_id, created_by, 'hidden', engine_version, start_date, end_date, inputs, summary, $2, trigger FROM model_run WHERE id = $1 RETURNING id`,
			[base, sc.id]
		);
		expect(await rowsAs(viewer, 'SELECT id FROM model_run WHERE id = $1', [run!.id])).toEqual([]);
		expect(await call(viewer, run!.id as string)).toEqual([]);
		// Its keys were frozen all the same (positive control: the table holds them).
		expect((await asOwner('SELECT count(*)::int AS n FROM run_allocation_holder WHERE run_id = $1', [run!.id]))[0]!.n).toBe(6);
	});

	it('erasure: when a holder’s name leaves the project, the runs’ frozen keys of it become the shared "gone"; a name still on another row is kept (positive control)', async () => {
		const key = async (aid: string) => (await asOwner('SELECT holder FROM run_allocation_holder WHERE run_id = $1 AND allocation_id = $2', [base, aid]))[0]!.holder as string;
		const before = await key(ids[0]!);
		expect(before).not.toBe('gone');
		// Holder 2's name goes on another row too, then off row 2: still in the project, so kept.
		const extra = await editor.call('POST', `/projects/${pid}/allocations`, { nodeId: null, holder: 'round five holder 2', authorisation: 'licence', waterSource: 'groundwater', volumeM3PerYear: 1 });
		expect(extra.status).toBe(201);
		const k2 = await key(ids[1]!);
		expect((await editor.call('PATCH', `/projects/${pid}/allocations/${ids[1]}`, { holder: '' })).status).toBe(200);
		expect(await key(ids[1]!)).toBe(k2);
		// Holder 1's only row: its name cleared, then the row deleted. Gone from every run that froze it.
		expect((await editor.call('PATCH', `/projects/${pid}/allocations/${ids[0]}`, { holder: '' })).status).toBe(200);
		expect(await key(ids[0]!)).toBe('gone');
		expect((await asOwner('SELECT count(*)::int AS n FROM run_allocation_holder WHERE holder = $1', [before]))[0]!.n).toBe(0);
		// The extra row deleted: holder 2's name leaves too.
		expect((await editor.call('DELETE', `/projects/${pid}/allocations/${extra.body.allocation.id}`)).status).toBe(204);
		expect(await key(ids[1]!)).toBe('gone');
	});
});

// Round 6: a status per water year at a fixed band, pooled over the years of several runs, pins the registered total
// (and so, by L and M, one holder's volume) to a few percent. The review's probe as a fixture: three 30-year runs
// whose use varies with the weather and the crop area. A viewer kept from each volume gets no status per year (and no
// judgement for a run whose rows change), so the interval they could derive is unbounded; the editor's figures give
// a narrow one (the positive control: the attack works on what the old route served).
describe('#523 round 6: statuses pooled over several runs give no interval for the registered volume', () => {
	const START = '1995-10-01';
	const YEARS = 30;
	let pid: string;
	const runs: string[] = [];
	let perHolder = 0;

	/** [lo, hi] for a registered total R, from (modelled use, status) pairs of years with the same R in force; null when nothing bounds it. */
	const pooled = (pairs: { m: number; status: AllocationStatus }[], t: number): [number, number] | null => {
		let lo = 0;
		let hi = Infinity;
		for (const { m, status } of pairs) {
			if (status === 'within') ((lo = Math.max(lo, m / (1 + t))), (hi = Math.min(hi, m / (1 - t))));
			else if (status === 'over') hi = Math.min(hi, m / (1 + t));
			else if (status === 'under') lo = Math.max(lo, m / (1 - t));
		}
		return lo > 0 && Number.isFinite(hi) ? [lo, hi] : null;
	};

	beforeAll(async () => {
		// A wet-and-dry rain series, seeded: each year's use differs.
		let seed = 7;
		const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
		const days = YEARS * 365 + 8;
		const wet = Array.from({ length: YEARS + 1 }, () => 0.4 + 1.2 * rnd());
		const p = await volumesProject('Pooled statuses', ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'], START, days);
		pid = p.pid;
		const rain = Array.from({ length: days }, (_, i) => (rnd() < 0.12 ? 18 * wet[Math.floor(i / 365)]! : 0));
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: START, values: rain })).status).toBe(200);
		const model = (await owner.call('GET', `/projects/${pid}/model`)).body;
		for (const factor of [0.8, 1, 1.25]) {
			const scaled = { nodes: model.nodes, crops: model.crops, transfers: model.transfers ?? [], cropAreas: model.cropAreas.map((a: { areaM2: number }) => ({ ...a, areaM2: 60_000 * factor })) };
			expect((await owner.call('PUT', `/projects/${pid}/model`, scaled)).status).toBe(200);
			runs.push(await p.run(`area × ${factor}`));
		}
		// Volumes set near the middle run's mean use, so years fall either side of the band.
		const probe = await p.add(p.units[0]!.id, 'Pooled Probe', 1);
		const c = (await editor.call('GET', `/projects/${pid}/runs/${runs[1]}/allocations`)).body.comparison as AllocationComparison;
		const unit = c.nodes.find((n) => n.nodeId === p.units[0]!.id)!.surface.years.filter((y) => !y.partial);
		perHolder = Math.round(unit.reduce((s, y) => s + y.modelledM3, 0) / unit.length);
		expect((await editor.call('DELETE', `/projects/${pid}/allocations/${probe}`)).status).toBe(204);
		for (let i = 0; i < 5; i++) await p.add(p.units[i]!.id, `Pooled Holder ${i + 1}`, perHolder);
		await p.add(p.units[5]!.id, 'Pooled Later', 123_457, { validFrom: '2018-10-01' });
		await p.add(null, 'Pooled Unmatched', 77_777);
	}, 600_000);

	it('positive control: the old route’s statuses (the editor’s sums, at the band) pin the five holders’ total to a few percent', async () => {
		const pairs: { m: number; status: AllocationStatus }[] = [];
		for (const run of runs) {
			const c = (await editor.call('GET', `/projects/${pid}/runs/${run}/allocations`)).body.comparison as AllocationComparison;
			const held = c.nodes.filter((n) => n.surface.allocationIds.length > 0);
			for (const y of held[0]!.surface.years) {
				if (y.partial || y.waterYear >= 2018) continue;
				const sum = (k: 'modelledM3' | 'registeredM3') => held.reduce((s, n) => s + n.surface.years.find((x) => x.waterYear === y.waterYear)![k], 0);
				pairs.push({ m: sum('modelledM3'), status: allocationStatus(sum('modelledM3'), sum('registeredM3'), 0.1) });
			}
		}
		const R = 5 * perHolder;
		const box = pooled(pairs, 0.1);
		expect(box).not.toBeNull();
		expect(box![0]).toBeLessThanOrEqual(R + 1);
		expect(box![1]).toBeGreaterThanOrEqual(R - 1);
		expect((box![1] - box![0]) / R).toBeLessThan(0.1);
	});

	it('the viewer gets no status for any year of any run, and no judgement, so pooling bounds nothing', async () => {
		const pairs: { m: number; status: AllocationStatus }[] = [];
		for (const run of runs) {
			const body = (await viewer.call('GET', `/projects/${pid}/runs/${run}/allocations`)).body;
			const src = body.totals.sources[0];
			expect(src.judgement).toBeNull();
			for (const y of src.years as { modelledM3: number; status?: AllocationStatus }[]) {
				expect(y.status).toBeUndefined();
				if (y.status) pairs.push({ m: y.modelledM3, status: y.status });
			}
			expect(JSON.stringify(body)).not.toMatch(/"(within|over|under)"/);
		}
		expect(pooled(pairs, 0.1)).toBeNull();
	});
});

describe('#523 N: rows deleted after a run keep the holder they had when it ran', () => {
	const VOL = 77_777;
	let pid: string;
	let run: string;

	beforeAll(async () => {
		// One holder on five units (finding 6's layout), a run, then every row deleted (as deleting the import does).
		const p = await volumesProject('Deleted rows', ['D1', 'D2', 'D3', 'D4', 'D5'], '2016-10-01', 365);
		pid = p.pid;
		const ids = [];
		for (const u of p.units) ids.push(await p.add(u.id, 'One Estate Holdings', VOL));
		run = await p.run('one holder');
		for (const id of ids) expect((await editor.call('DELETE', `/projects/${pid}/allocations/${id}`)).status).toBe(204);
	}, 120_000);

	it('§ 5 leaves the one holder out, for every reader: before, each gone row counted as its unit, 5 holders', async () => {
		for (const u of [editor, viewer]) {
			const r = (await u.call('GET', `/projects/${pid}/runs/${run}/evidence-report`)).body.report;
			expect(others(r.allocations)).toBeNull();
			expect(r.allocations.othersLeftOut).toBe(5);
		}
		// The run kept one key for all five rows (owner-only table: the app can't read it).
		const [k] = await asOwner('SELECT count(DISTINCT holder)::int AS n, count(*)::int AS rows FROM run_allocation_holder WHERE run_id = $1', [run]);
		expect(k).toEqual({ n: 1, rows: 5 });
		await expect(rowsAs(editor, 'SELECT 1 FROM run_allocation_holder')).rejects.toThrow(/permission denied/);
	});
});

describe('#523 O: a total one holder dominates isn’t shown (provisional dominance rule)', () => {
	it('today’s total of one estate of 900 000 m³/a and four farms of 1 is withheld; the editor reads each row (positive control)', async () => {
		const p = await volumesProject('Dominant estate', ['E1', 'E2', 'E3', 'E4', 'E5'], '2016-10-01', 365);
		await p.add(p.units[0]!.id, 'Large Estate', 900_000);
		for (let i = 1; i < 5; i++) await p.add(p.units[i]!.id, `Small Farm ${i}`, 1);
		const totals = (await viewer.call('GET', `/projects/${p.pid}/allocations`)).body.totals;
		expect(totals).toEqual([{ waterSource: 'surface', holders: 5, registeredM3PerYear: null, storageM3: null }]);
		expect(holdsFigure(JSON.stringify(totals), 900_004)).toBe(false);
		expect((await editor.call('GET', `/projects/${p.pid}/allocations`)).body.allocations).toHaveLength(5);
	});
});

// The canary sweep (issue #523 G1): the redaction of a viewer's copy of the
// volumes is opt-in per route, which is how the scenario base, the report PDFs
// and the evidence report's changes were missed. So every GET a viewer can
// call (from app.routes: a new one is swept the day it lands) is called as a
// viewer the project keeps from each volume, on a project whose runs carry a
// registered volume and a team scenario that sets another farm's, and no
// answer may hold either number, in figures or in words ("987 654 321").
// Four more holders' rows in force only from 2040 make the source one of 5
// holders, so the totals by source are computed over the canary alone (#523 G).
// An editor reads both on the routes that carry them (the positive control).
describe('no viewer GET carries a registered volume while the owners keep them from viewers (#523 G1)', () => {
	const ctx = {} as LadderCtx;
	const CANARY = 987_654_321;
	const SCENARIO_CANARY = 876_543_219;
	/** A storage-only (21b) row's registered storage. */
	const STORAGE_CANARY = 765_432_189;
	/** A sweep member's own registered volume on another farm. */
	const SWEEP_CANARY = 654_321_879;
	/** An issued licence's granted terms set this on Farm B, not the application's own unit (227, #523 G3). */
	const GRANTED_CANARY = 543_218_769;
	/** A variation on appeal sets this on Farm B (228, #523 G4). */
	const VARIED_CANARY = 432_187_659;
	const CANARIES = [CANARY, SCENARIO_CANARY, STORAGE_CANARY, SWEEP_CANARY, GRANTED_CANARY, VARIED_CANARY];
	/** The ladder run's last, partial water year: 400 days from 1 October 2021, so 35 days of 2022's. */
	const PARTIAL_DAYS = 35;
	/**
	 * Where an answer carries n, in any form the API words a volume in (__tests__/figures.ts): m³ a year, of either sign,
	 * in figures or in words ("987 654 321"); its megalitres, its share of a day (365 or 366, m³ or ML) or of the
	 * partial water year, matched by closeness; never the digits of an id key, a uuid or a hash (#523 G1c).
	 */
	const where = (text: string, n: number) => figuresAt(text, n, { partialDays: [PARTIAL_DAYS] });
	const seen = (text: string, n: number) => where(text, n).length > 0;
	/** Where a JSON answer carries a registered volume as a number (a key starting registered or meanRegistered, #523 K/L/M). */
	const registeredFigures = (text: string): string[] => {
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return [];
		}
		const out: string[] = [];
		const walk = (v: unknown, at: string) => {
			if (Array.isArray(v)) v.forEach((x, i) => walk(x, at ? `${at}.${i}` : String(i)));
			else if (v && typeof v === 'object')
				for (const [k, x] of Object.entries(v)) {
					const here = at ? `${at}.${k}` : k;
					if (/^(registered|meanRegistered)/.test(k) && typeof x === 'number' && x !== 0) out.push(here);
					walk(x, here);
				}
		};
		walk(body, '');
		return out;
	};
	const routes = [
		...new Set(
			app.routes
				.filter((r) => r.method === 'GET' && (r.path === '/projects/:id' || r.path.startsWith('/projects/:id/') || r.path === '/me/alerts/:projectId'))
				.map((r) => r.path)
		)
	];
	let ids: Record<string, string>;
	let baseRun: string;
	let scenarioRun: string;
	let sid: string;
	/** The applicant's application issued with GRANTED_CANARY and varied to VARIED_CANARY, and its run of the varied terms. */
	let licenceSid: string;
	let licensedRun: string;
	let reportJob: string;
	/** Team scenario runs of the base that cap use at, and scale demand to, the registered volumes (#523 I). */
	let capRun: string;
	let fullRun: string;

	/**
	 * The viewer GETs that refuse that viewer, each with its status and why. Any other answer below 200 or from 400 up
	 * fails the sweep: a sweep of refusals proves nothing.
	 */
	const EXPECTED: Record<string, { status: number; why: string }> = {
		// The refusals this issue added (#523 G1): the files that hold the volumes.
		'/projects/:id/packs/:packId/bundle': { status: 403, why: 'pack_volumes_withheld: the bundle holds the runs’ inputs and results' },
		'/projects/:id/reports/:jobId/pdf': { status: 403, why: 'pack_volumes_withheld: the editor’s impact report was printed with the volumes' },
		'/projects/:id/allocations/export.csv': { status: 403, why: 'each registered volume is the editors’ and owners’ (162)' },
		// The pack's § 5 prints the groundwater total of other units with its registered m³ (#523 K/L/M), refused before
		// the draft's 409 (a draft is never printed).
		'/projects/:id/packs/:packId/pdf': { status: 403, why: 'pack_volumes_withheld: § 5 prints a total of other units’ registered volume' },
		// An application's routes, on the team's scenario.
		'/projects/:id/scenarios/:sid/packs/:packId': { status: 404, why: 'an applicant’s pack view: the viewer is no party, and the scenario is the team’s' },
		'/projects/:id/scenarios/:sid/packs/:packId/pdf': { status: 404, why: 'an applicant’s copy: likewise' },
		'/projects/:id/scenarios/:sid/results': { status: 409, why: 'a team scenario is compared on the compare page' },
		'/projects/:id/scenarios/:sid/share-candidates': { status: 409, why: 'a team scenario is shared with nobody' },
		'/projects/:id/scenarios/:sid/participation-export': { status: 404, why: 'an application’s public participation only' },
		'/projects/:id/scenarios/:sid/questions': { status: 404, why: 'an application’s questions only' },
		// Above viewer (projects/role-ladder.db.test.ts pins each one's role and reason).
		'/projects/:id/applications': { status: 403, why: 'editor' },
		'/projects/:id/application-questions': { status: 403, why: 'editor' },
		'/projects/:id/registration-checks': { status: 403, why: 'editor' },
		'/projects/:id/invites': { status: 403, why: 'owner' },
		'/projects/:id/assessments': { status: 403, why: 'editor' },
		'/projects/:id/assessments/:aid': { status: 403, why: 'editor' },
		'/projects/:id/feeds/chirps/from-boundary': { status: 403, why: 'owner' },
		'/projects/:id/feeds/chirps/from-units': { status: 403, why: 'owner' },
		'/projects/:id/map/unit-map': { status: 403, why: 'editor' },
		'/projects/:id/map/channels': { status: 403, why: 'editor' },
		'/projects/:id/share-links': { status: 403, why: 'owner' },
		'/projects/:id/licence-record': { status: 403, why: 'editor' },
		'/projects/:id/api-keys': { status: 403, why: 'owner' },
		'/projects/:id/alert-rules': { status: 403, why: 'editor' },
		'/projects/:id/alert-feedback': { status: 403, why: 'editor' }
	};

	/** The refusals on the capped and full-allocation runs only (#523 I): verdicts and counts only, so every series, day and daily file is refused. */
	const EXPECTED_BOUND: Record<string, { status: number; why: string }> = {
		'/projects/:id/runs/:runId/day': { status: 403, why: 'allocation_series_withheld: the unit is bound to its registered volume' },
		'/projects/:id/runs/:runId/model-input': { status: 403, why: 'a cap or full-allocation run’s input holds the volumes (uncertainty.ts)' },
		'/projects/:id/runs/:runId/export/farms.csv': { status: 403, why: 'allocation_series_withheld: verdicts and counts only, no unit’s column' },
		// Round 5 (I): no series of any kind, the catchment's included (a gauge's inflow less a unit's share of the natural flow gave its volume).
		'/projects/:id/runs/:runId/series': { status: 403, why: 'allocation_series_withheld: no series of a cap or full-allocation run' },
		'/projects/:id/runs/:runId/series/bulk': { status: 403, why: 'allocation_series_withheld: no series of a cap or full-allocation run' },
		'/projects/:id/runs/:runId/export/daily.csv': { status: 403, why: 'allocation_series_withheld: no series of a cap or full-allocation run' }
	};

	/** The ids a route names differently from the ladder's (its :jobId a report's, its :aid an assessment's …). */
	const paramsOf = (pattern: string): Record<string, string> => ({
		...(pattern.includes('/reports/:jobId') ? { jobId: reportJob } : {}),
		...(pattern.includes('/assessments/:aid') ? { aid: ids.assessmentId! } : {}),
		// The ensemble is the base run's.
		...(pattern.includes(':uid') ? { runId: baseRun } : {})
	});

	const get = async (u: LadderCtx['viewer'], path: string) => {
		const r = await app.request(path, { headers: { cookie: u.cookie, origin: 'http://localhost:7777' }, redirect: 'manual' });
		return { status: r.status, text: await r.text() };
	};
	const pathOf = (pattern: string, over: Record<string, string>) => {
		const s = SAMPLE[`GET ${pattern}`]?.(ctx) ?? {};
		const all = { ...ids, ...over, ...s.params, ...paramsOf(pattern) };
		let path = pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => {
			// Every id a real one: a route answering 404 for an id nobody planted is a route not swept.
			if (!all[name]) throw new Error(`${pattern}: no fixture for :${name} (plant one in the canary sweep's beforeAll)`);
			return all[name]!;
		});
		// The farm view's series need a key (a farmer's route; the viewer's answer is the role check's).
		const query = s.query ?? (pattern.endsWith('/farm/:nodeId/series') ? { key: 'supplied' } : undefined);
		if (query) path += `?${new URLSearchParams(query)}`;
		return path;
	};

	afterAll(() => clearLadderJobs(ctx));
	beforeAll(async () => {
		Object.assign(ctx, await buildLadder('Canary'));
		const at = `/projects/${ctx.projectId}`;
		const post = async (path: string, body: unknown) => {
			const res = await ctx.owner.call('POST', `${at}${path}`, body);
			expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBeLessThan(300);
			return res.body;
		};
		// The ladder's own volume on Farm A goes, so each figure per unit is a canary itself, not a sum with it.
		expect((await ctx.owner.call('DELETE', `${at}/allocations/${ctx.ids.aid}`)).status).toBe(204);
		// Its maximum rate can't deliver it, so a cap run warns, quoting the volume (#523 I), and keeps what is left (allocation_left_*).
		await post('/allocations', { nodeId: ctx.farmId, holder: 'Canary Holder', registrationNo: 'REG-CANARY', authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: CANARY, maxRateM3s: 0.001 });
		// A dam's registered storage (21b): a figure of the registration too.
		await post('/allocations', { nodeId: ctx.otherFarmId, authorisation: 'registration', waterSource: 'surface', waterUse: '21b', volumeM3PerYear: 0, storageM3: STORAGE_CANARY });
		// Four more holders of surface water, in force only from 2040 (#523 G): the source has 5 holders, so the viewer's
		// totals are computed, but on every day and water year the canaries are the only volumes in force. A total gated
		// on the source's holders of every date gave the canary itself.
		for (const [i, nodeId] of [ctx.farmId, ctx.farmId, ctx.otherFarmId, ctx.otherFarmId].entries())
			await post('/allocations', { nodeId, holder: `Later Holder ${i + 1}`, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 31_111 + i * 1_111, validFrom: '2040-10-01' });
		// Five holders of groundwater in force throughout, none dominating (#523 K/L/M): the run's years and § 5's total of
		// other units are shown to the editor, so a route that hands that viewer a registered figure other than today's
		// per-source total is caught by registeredFigures below, not only by a canary's digits.
		for (const [i, nodeId] of [ctx.farmId, ctx.farmId, ctx.farmId, ctx.otherFarmId, ctx.otherFarmId].entries())
			await post('/allocations', { nodeId, holder: `Groundwater Holder ${i + 1}`, authorisation: 'licence', waterSource: 'groundwater', volumeM3PerYear: 40_001 + i });
		baseRun = (await post('/runs', { label: 'With the canary' })).run.id;
		// Published after the ladder's run: its changes since the previous publication add the canary.
		await post('/publication', { runId: baseRun });
		// An editor's "what if farm B held this" team scenario: an op that sets another farm's volume, after one that doesn't.
		sid = (
			await post('/scenarios', {
				name: 'Canary scenario',
				baseRunId: baseRun,
				ops: [
					{ op: 'node.set', nodeId: ctx.otherFarmId, field: 'damCapacityM3', value: 1000 },
					{ op: 'allocation.set', allocation: { id: crypto.randomUUID(), nodeId: ctx.otherFarmId, waterSource: 'surface', volumeM3PerYear: SCENARIO_CANARY } }
				]
			})
		).scenario.id;
		scenarioRun = (await post(`/scenarios/${sid}/runs`, {})).run.id;
		// A sweep on the base run, computed: one member sets another farm's volume. (A storage-only row with a volume, whose
		// warning used to quote it, the API refuses; the engine's own test holds the warning: allocations/mode.test.ts.)
		const sweep = (
			await post('/sweeps', {
				name: 'Canary sweep',
				baseRunId: baseRun,
				members: [
					{ name: 'As it is', ops: [] },
					{ name: 'Farm B licensed', ops: [{ op: 'allocation.set', allocation: { id: crypto.randomUUID(), nodeId: ctx.otherFarmId, waterSource: 'surface', volumeM3PerYear: SWEEP_CANARY } }] }
				]
			})
		).sweep.id as string;
		await withUser(ctx.owner.id, (db) => computeSweep(db, ctx.projectId, sweep, async () => true));
		expect((await ctx.owner.call('GET', `${at}/sweeps/${sweep}`)).body.sweep.members.map((m: { status: string }) => m.status)).toEqual(['done', 'done']);
		// An uncertainty ensemble of the base run, started (the ladder has no observed flow to run one through the route).
		const uid = await withUser(ctx.owner.id, async (db) =>
			(
				await db.query<{ id: string }>(
					`INSERT INTO run_uncertainty (project_id, run_id, runoff_model, engine_version, method, seed, members, options, created_by) VALUES ($1, $2, 'gr4j', $3, 'lhs', 0, 30, '{}', $4) RETURNING id`,
					[ctx.projectId, baseRun, ENGINE_VERSION, ctx.owner.id]
				)
			).rows[0]!.id
		);
		// A licence's terms (G3) and a variation's (G4) carry volumes too: an applicant's application, issued with granted
		// terms that set Farm B's volume, then varied on appeal to terms that set another. The applicant is linked to no
		// farm (an applicant's own units' volumes are theirs to read, and Farm A's and B's carry the other canaries), so
		// a viewer kept from volumes reads neither (viewerOps.ts): not on the scenario, its decision events, its
		// licensed-terms run, the evidence report's other applications and combined row, or the pack below.
		await actForAuthority(ctx.owner, ctx.projectId, ctx.editor.id);
		const applied = await ctx.contributor.call('POST', `${at}/scenarios`, { name: 'Canary licence', baseRunId: baseRun, ops: [] });
		expect(applied.status, JSON.stringify(applied.body)).toBe(201);
		licenceSid = applied.body.scenario.id as string;
		expect((await ctx.contributor.call('POST', `${at}/scenarios/${licenceSid}/submit`, {})).status).toBe(200);
		const farmBVolume = (n: number) => ({ op: 'allocation.set', allocation: { id: crypto.randomUUID(), nodeId: ctx.otherFarmId, waterSource: 'surface', volumeM3PerYear: n } });
		const decided = await ctx.editor.call('POST', `${at}/scenarios/${licenceSid}/decide`, {
			...DECISION,
			outcome: 'licence_issued',
			granted: { ops: [{ op: 'node.set', nodeId: ctx.otherFarmId, field: 'damCapacityM3', value: 1500 }, farmBVolume(GRANTED_CANARY)], conditions: 'Release in dry months.' }
		});
		expect(decided.status, JSON.stringify(decided.body)).toBe(200);
		const appeal = async (body: unknown) => {
			const res = await ctx.editor.call('POST', `${at}/scenarios/${licenceSid}/appeals`, body);
			expect(res.status, JSON.stringify(res.body)).toBe(201);
			return res.body.scenario;
		};
		await appeal({ kind: 'lodged', forum: 'water_tribunal', eventDate: '2026-10-02', reference: 'WT canary' });
		const varied = await appeal({ kind: 'varied', forum: 'water_tribunal', eventDate: '2026-10-05', terms: { ops: [farmBVolume(VARIED_CANARY)], conditions: 'As varied.' } });
		expect(varied.licence).toMatchObject({ inForce: true, from: 'event' });
		licensedRun = (await post(`/scenarios/${licenceSid}/runs`, { terms: 'licensed' })).run.id;
		// An evidence pack of the base run, planted as a draft (a pack of a run that isn't nominated can't be drafted through the route).
		const ev = (await ctx.owner.call('GET', `${at}/runs/${baseRun}/evidence-report`)).body.report;
		const packId = crypto.randomUUID();
		const manifest = buildPackManifest({ pack: { id: packId, version: 1, supersedes: null }, project: ev.identity.project, report: ev, engine: { version: ENGINE_VERSION, build: null } });
		await asOwner(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, manifest, manifest_sha256, report_version, engine_version, created_by)
			 VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8)`,
			[packId, ctx.projectId, baseRun, JSON.stringify(manifest), createHash('sha256').update(packManifestText(manifest), 'utf8').digest('hex'), ev.version, ENGINE_VERSION, ctx.editor.id]
		);
		// An impact report of the scenario run against the base run, asked for by the editor (so printed with the volumes).
		reportJob = (await ctx.editor.call('POST', `${at}/reports`, { runId: scenarioRun, against: `${ctx.projectId}:${baseRun}` })).body.jobId as string;
		const assessmentId = (await post('/assessments', SAMPLE['POST /projects/:id/assessments']!(ctx).body)).assessment.id as string;
		const [rid] = await asOwner(`INSERT INTO delineation_request (project_id, click_kind, click_lon, click_lat, from_window) VALUES ($1, 'outlet', 21.31, -33.69, 256) RETURNING id`, [ctx.projectId]);
		ids = { ...ctx.ids, sid, sweepId: sweep, uid, packId, assessmentId, rid: rid!.id as string };
		[capRun, fullRun] = await allocationModeRuns(post, baseRun);
	}, 300_000);

	it('positive control: an editor reads every number where it is (the base, the scenario, its run, its evidence report, the sweep)', async () => {
		const at = `/projects/${ctx.projectId}`;
		expect(seen((await get(ctx.editor, `${at}/scenarios/${sid}/base`)).text, CANARY)).toBe(true);
		expect(seen((await get(ctx.editor, `${at}/scenarios/${sid}/base`)).text, STORAGE_CANARY)).toBe(true);
		expect(seen((await get(ctx.editor, `${at}/scenarios/${sid}`)).text, SCENARIO_CANARY)).toBe(true);
		expect(seen((await get(ctx.editor, `${at}/runs/${scenarioRun}`)).text, SCENARIO_CANARY)).toBe(true);
		const report = (await get(ctx.editor, `${at}/runs/${scenarioRun}/evidence-report`)).text;
		expect(seen(report, CANARY) && seen(report, SCENARIO_CANARY)).toBe(true);
		expect(seen((await get(ctx.editor, `${at}/runs/${baseRun}/publication`)).text, CANARY)).toBe(true);
		const sweep = (await get(ctx.editor, `${at}/sweeps/${ids.sweepId}`)).text;
		expect(seen(sweep, CANARY) && seen(sweep, SWEEP_CANARY)).toBe(true);
		expect(seen((await get(ctx.editor, `${at}/sweeps`)).text, SWEEP_CANARY)).toBe(true);
		// The licence's granted terms and its variation, on the scenario (G3/G4).
		const licence = (await get(ctx.editor, `${at}/scenarios/${licenceSid}`)).text;
		expect(seen(licence, GRANTED_CANARY) && seen(licence, VARIED_CANARY)).toBe(true);
		expect(seen((await get(ctx.editor, `${at}/runs/${licensedRun}`)).text, VARIED_CANARY)).toBe(true);
		// § 5's groundwater total of other units carries its registered figures for the editor (control for registeredFigures).
		expect(registeredFigures((await get(ctx.editor, `${at}/runs/${baseRun}/evidence-report`)).text).some((p) => p.startsWith('report.allocations.units'))).toBe(true);
	});

	it('every viewer GET of the project, on the base run, the scenario run and the capped and full-allocation runs, holds none of the numbers, and answers or is an expected refusal', async () => {
		const leaks: string[] = [];
		const refused: string[] = [];
		for (const runId of [baseRun, scenarioRun, capRun, fullRun]) {
			const paths = [
				...routes.map((r) => [r, pathOf(r, { runId })] as const),
				['/compare/runs', `/compare/runs?a=${ctx.projectId}:${baseRun}&b=${ctx.projectId}:${scenarioRun}`] as const,
				['/compare/runs', `/compare/runs?a=${ctx.projectId}:${ctx.runId}&b=${ctx.projectId}:${runId}`] as const
			];
			for (const [route, path] of paths) {
				const r = await get(ctx.viewer, path);
				const expected = (runId === capRun || runId === fullRun ? EXPECTED_BOUND[route] : undefined) ?? EXPECTED[route];
				if ((r.status < 200 || r.status >= 400) && r.status !== expected?.status) refused.push(`${path} answered ${r.status}`);
				for (const n of CANARIES) for (const w of where(r.text, n)) leaks.push(`${path} (${r.status}) holds ${n} at ${w}`);
				// #523 K/L/M: the only registered m³ such a viewer reads is today's total per water source; any other
				// registered figure (a run's year, a total of other units) can be differenced against it or another.
				for (const at of registeredFigures(r.text)) if (!(route === '/projects/:id/allocations' && /^totals\.\d+\.registeredM3PerYear$/.test(at))) leaks.push(`${path} carries a registered figure at ${at}`);
				// A capped or full-allocation run: nor as the difference of two of its numbers (#523 I, round 4).
				if ((runId === capRun || runId === fullRun) && differenceOf(r.text, CANARY)) leaks.push(`${path} (${r.status}) gives ${CANARY} as a difference`);
			}
		}
		expect(leaks).toEqual([]);
		expect(refused).toEqual([]);
	}, 300_000);

	// G3/G4 (#523): the issued application's own routes and its licensed-terms run, swept as the viewer. The routes'
	// statuses differ from a team scenario's (an application's results, questions, packs …), so only what each answer
	// holds is checked here; the scenario itself must answer, with its terms and events, or the sweep proves nothing.
	it('no viewer GET of the issued application or its licensed-terms run carries its granted or varied volumes', async () => {
		const at = `/projects/${ctx.projectId}`;
		const s = (await ctx.viewer.call('GET', `${at}/scenarios/${licenceSid}`)).body.scenario;
		expect(s.grantedTerms).toMatchObject({ withheldOps: 1, ops: [{ op: 'node.set', nodeId: ctx.otherFarmId }] });
		expect(s.decisionEvents.map((e: { kind: string }) => e.kind)).toEqual(['lodged', 'varied']);
		expect(s.decisionEvents[1].terms).toMatchObject({ withheldOps: 1, ops: [] });
		const leaks: string[] = [];
		const answered: string[] = [];
		for (const route of routes.filter((r) => r.includes(':sid') || r.includes(':runId'))) {
			const path = pathOf(route, { sid: licenceSid, runId: licensedRun });
			const r = await get(ctx.viewer, path);
			if (r.status === 200) answered.push(route);
			for (const n of CANARIES) for (const w of where(r.text, n)) leaks.push(`${path} (${r.status}) holds ${n} at ${w}`);
		}
		expect(leaks).toEqual([]);
		expect(answered).toEqual(expect.arrayContaining(['/projects/:id/scenarios/:sid', '/projects/:id/runs/:runId/evidence-report']));
	}, 300_000);

	// Finding I (#523): a capped run's room on a licence's first day is the unit's volume, and a full allocation scales the
	// unit's demand to it. The sweep above asks each series route for one sample key; these ask for the unit's own.
	it('the capped and full-allocation runs’ per-unit daily series: withheld from that viewer, with the reason; the editor reads them (positive control)', async () => {
		const at = `/projects/${ctx.projectId}`;
		const unit = ctx.farmId;
		const leaks: string[] = [];
		const answers: string[] = [];
		for (const runId of [capRun, fullRun]) {
			for (const path of unitSeriesPaths(`${at}/runs/${runId}`, unit, '2021-10-01')) {
				const r = await get(ctx.viewer, path);
				for (const n of CANARIES) for (const w of where(r.text, n)) leaks.push(`${path} (${r.status}) holds ${n} at ${w}`);
				// Withheld outright (403, coded) or answered without the unit's withheld columns, never a 404 that hides why.
				if (r.status === 403 && JSON.parse(r.text).code !== 'allocation_series_withheld') answers.push(`${path}: 403 ${r.text}`);
				if (r.status !== 200 && r.status !== 403) answers.push(`${path}: ${r.status}`);
			}
		}
		expect(leaks).toEqual([]);
		expect(answers).toEqual([]);
		// The marker: the run lists the withheld series, the day and bulk name them.
		const cap = await ctx.viewer.call('GET', `${at}/runs/${capRun}`);
		expect(cap.body.series.some((s: { key: string }) => s.key.startsWith('allocation_'))).toBe(false);
		expect(cap.body.withheldSeries).toContainEqual({ nodeId: unit, key: 'allocation_room_surface' });
		// The unit's whole day is refused, with the reason; so are the outlet gauge's and the catchment's (round 5: verdicts and counts only).
		const day = await ctx.viewer.call('GET', `${at}/runs/${capRun}/day?nodeId=${unit}&date=2021-10-01`);
		expect([day.status, day.body.code]).toEqual([403, 'allocation_series_withheld']);
		expect(cap.body.series).toEqual([]);
		const outlet = (await ctx.editor.call('GET', `${at}/runs/${capRun}`)).body.series.find((s: { nodeId: string | null; key: string }) => s.nodeId && s.key === 'outflow').nodeId;
		for (const path of [`day?nodeId=${outlet}&date=2021-10-01`, 'day?date=2021-10-01']) {
			const refused = await ctx.viewer.call('GET', `${at}/runs/${capRun}/${path}`);
			expect([path, refused.status, refused.body.code]).toEqual([path, 403, 'allocation_series_withheld']);
			// Positive control: the editor's.
			expect((await ctx.editor.call('GET', `${at}/runs/${capRun}/${path}`)).status).toBe(200);
		}
		const capSummary = (await ctx.viewer.call('GET', `${at}/runs/${capRun}`)).body.run.summary;
		expect([capSummary.allocations.verdictsOnly, capSummary.farms, capSummary.waterBalance]).toEqual([true, [], undefined]);
		expect(capSummary.withheld).toContain('waterBalance');
		expect((await get(ctx.viewer, `${at}/runs/${capRun}/export/summary.csv`)).text).toMatch(/^# withheld=[^\n]*waterBalance/m);
		// No flow quantiles either (#523 I, round 6): the summary CSV prints none of the cap run's flow; the editor's has them.
		const noFdc = (txt: string) => /No catchment flow series stored for this run/.test(txt) && !/Simulated outflow/.test(txt);
		expect(noFdc((await get(ctx.viewer, `${at}/runs/${capRun}/export/summary.csv`)).text)).toBe(true);
		expect(noFdc((await get(ctx.editor, `${at}/runs/${capRun}/export/summary.csv`)).text)).toBe(false);
		const full = await ctx.viewer.call('GET', `${at}/runs/${fullRun}`);
		expect(full.body.series.some((s: { nodeId: string | null }) => s.nodeId === unit)).toBe(false);
		expect(full.body.withheldSeries).toContainEqual({ nodeId: unit, key: 'demand' });
		// Positive control: the editor reads the volume in the cap's room and the full allocation's demand.
		expect(seen((await get(ctx.editor, `${at}/runs/${capRun}/series?key=allocation_left_surface&nodeId=${unit}`)).text, CANARY)).toBe(true);
		expect(seen((await get(ctx.editor, `${at}/runs/${capRun}/day?nodeId=${unit}&date=2021-10-01`)).text, CANARY)).toBe(true);
		expect(seen((await get(ctx.editor, `${at}/runs/${capRun}`)).text, CANARY)).toBe(true);
		expect((await ctx.editor.call('GET', `${at}/runs/${fullRun}/series?key=demand&nodeId=${unit}`)).status).toBe(200);
		expect((await ctx.editor.call('GET', `${at}/runs/${capRun}`)).body.withheldSeries).toEqual([]);
		// Allowed by the owner, the viewer reads them too.
		expect((await ctx.owner.call('PUT', `${at}/allocations/viewer-units`, { on: true })).status).toBe(200);
		try {
			expect(seen((await get(ctx.viewer, `${at}/runs/${capRun}/series?key=allocation_left_surface&nodeId=${unit}`)).text, CANARY)).toBe(true);
		} finally {
			expect((await ctx.owner.call('PUT', `${at}/allocations/viewer-units`, { on: false })).status).toBe(200);
		}
	}, 120_000);

	// Round 4 (I): the catchment water balance less the units still shown gave a bound unit's volume exactly. The probe,
	// as the reviewer ran it: each water year's demand in the balance, less every other unit's demand that year.
	it('the round-4 probe: the full allocation’s water balance less the units shown doesn’t give the volume to that viewer; it does to the editor (positive control)', async () => {
		const at = `/projects/${ctx.projectId}/runs/${fullRun}`;
		const probe = async (u: LadderCtx['viewer']) => {
			const { run, series } = (await u.call('GET', at)).body as { run: { startDate: string; summary: { waterBalance?: { years: { waterYear: number; demandM3: number }[] } } }; series: { nodeId: string | null; key: string }[] };
			const others = series.filter((s) => s.nodeId && s.nodeId !== ctx.farmId && s.key === 'demand').map((s) => s.nodeId!);
			const demand = await Promise.all(others.map(async (n) => (await u.call('GET', `${at}/series?key=demand&nodeId=${n}`)).body.values as number[]));
			const yearOf = (t: number) => {
				const d = new Date(Date.parse(`${run.startDate}T00:00:00Z`) + t * 86_400_000);
				return d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
			};
			return (run.summary.waterBalance?.years ?? []).map((y) => y.demandM3 - demand.reduce((s, v) => s + v.reduce((a, x, t) => a + (yearOf(t) === y.waterYear ? x : 0), 0), 0));
		};
		// Positive control: for the editor the probe gives the bound unit's own demand each water year exactly (its volume
		// over the year's in-force days; the canary sweep's fixture also gives the unit other holders' rows, so not CANARY alone).
		const { run: edRun } = (await ctx.editor.call('GET', at)).body as { run: { startDate: string } };
		const own = (await ctx.editor.call('GET', `${at}/series?key=demand&nodeId=${ctx.farmId}`)).body.values as number[];
		const ownByYear = new Map<number, number>();
		own.forEach((x, t) => {
			const d = new Date(Date.parse(`${edRun.startDate}T00:00:00Z`) + t * 86_400_000);
			const wy = d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
			ownByYear.set(wy, (ownByYear.get(wy) ?? 0) + x);
		});
		const edProbe = await probe(ctx.editor);
		expect(edProbe.length).toBeGreaterThan(0);
		expect(edProbe.every((d, i) => Math.abs(d - [...ownByYear.values()][i]!) < 1)).toBe(true);
		expect([...ownByYear.values()].some((v) => v > 0)).toBe(true);
		expect(await probe(ctx.viewer)).toEqual([]);
		// Nor any difference of two numbers the viewer reads of the run (the derived canary, as the sweep checks it).
		expect(differenceOf((await get(ctx.viewer, at)).text, CANARY)).toBe(false);
		expect(differenceOf((await get(ctx.editor, at)).text, CANARY)).toBe(true);
	});

	it('the evidence report on the capped and full-allocation runs: no unit’s section for that viewer, the sections named; the editor’s has them', async () => {
		for (const runId of [capRun, fullRun]) {
			const at = `/projects/${ctx.projectId}/runs/${runId}/evidence-report`;
			const mine = (await ctx.viewer.call('GET', at)).body.report;
			expect(mine.users).toEqual([]);
			expect(mine.rows.map((r: { id: string }) => r.id)).not.toContain('userSupply');
			expect(mine.allocations.units).toEqual([]);
			expect(mine.servedWhileFailing.sites.every((s: { units: unknown[] }) => s.units.length === 0)).toBe(true);
			expect(mine.summaries.application.farms).toEqual([]);
			expect(mine.withheld).toContain('users');
			const theirs = (await ctx.editor.call('GET', at)).body.report;
			expect(theirs.users.length).toBeGreaterThan(0);
			expect(theirs.withheld).toBeUndefined();
		}
	});

	it('the scenario, as that viewer reads it: without the op that sets another farm’s volume, the check renumbered to the ops left', async () => {
		const read = await ctx.viewer.call('GET', `/projects/${ctx.projectId}/scenarios/${sid}`);
		expect(read.status).toBe(200);
		expect(read.body.scenario.ops.map((o: { op: string }) => o.op)).toEqual(['node.set']);
		expect(read.body.scenario.withheldOps).toBe(1);
		expect(read.body.check.classified).toHaveLength(1);
		expect(read.body.check.applied.map((a: { index: number }) => a.index)).toEqual([0]);
		// Positive control: the editor reads both, the check over both.
		const full = await ctx.editor.call('GET', `/projects/${ctx.projectId}/scenarios/${sid}`);
		expect(full.body.scenario.ops).toHaveLength(2);
		expect(full.body.scenario.withheldOps).toBeUndefined();
		expect(full.body.check.classified).toHaveLength(2);
		// Allowed by the owner, the viewer reads it whole.
		expect((await ctx.owner.call('PUT', `/projects/${ctx.projectId}/allocations/viewer-units`, { on: true })).status).toBe(200);
		try {
			expect((await ctx.viewer.call('GET', `/projects/${ctx.projectId}/scenarios/${sid}`)).body.scenario.ops).toHaveLength(2);
			expect(seen((await get(ctx.viewer, `/projects/${ctx.projectId}/scenarios/${sid}/base`)).text, CANARY)).toBe(true);
		} finally {
			expect((await ctx.owner.call('PUT', `/projects/${ctx.projectId}/allocations/viewer-units`, { on: false })).status).toBe(200);
		}
	});

	it('a report PDF printed for an editor is refused to that viewer (403), and its link isn’t emailed to them; their own PDF and the editor are positive controls (218)', async () => {
		const at = `/projects/${ctx.projectId}`;
		const asked = await ctx.editor.call('POST', `${at}/reports`, { runId: baseRun });
		expect(asked.status, JSON.stringify(asked.body)).toBe(202);
		const job = asked.body.jobId as string;
		expect((await asOwner('SELECT with_volumes FROM report WHERE job_id = $1', [job]))[0]!.with_volumes).toBe(true);
		const refused = await ctx.viewer.call('GET', `${at}/reports/${job}/pdf`);
		expect(refused.status).toBe(403);
		expect(refused.body.code).toBe('pack_volumes_withheld');
		expect((await ctx.viewer.call('GET', `${at}/reports/${job}`)).body.report.volumesWithheld).toBe(true);
		// The editor passes the check (the PDF isn't printed in this test: 409).
		expect((await ctx.editor.call('GET', `${at}/reports/${job}/pdf`)).status).toBe(409);
		expect((await ctx.editor.call('GET', `${at}/reports/${job}`)).body.report.volumesWithheld).toBe(false);
		// The viewer's own PDF is printed as them, so without the volumes.
		const own = await ctx.viewer.call('POST', `${at}/reports`, { runId: baseRun });
		expect(own.status).toBe(202);
		expect((await asOwner('SELECT with_volumes FROM report WHERE job_id = $1', [own.body.jobId]))[0]!.with_volumes).toBe(false);
		expect((await ctx.viewer.call('GET', `${at}/reports/${own.body.jobId}/pdf`)).status).toBe(409);
		// Whom the link of a report printed with them goes to: not the viewer; without them, the viewer too.
		const to = async (withVolumes: boolean) =>
			(await withUser(ctx.owner.id, (db) => membersAmong(db, ctx.projectId, [ctx.viewer.id, ctx.editor.id], { withVolumes }))).map((m) => m.id).sort();
		expect(await to(true)).toEqual([ctx.editor.id]);
		expect(await to(false)).toEqual([ctx.viewer.id, ctx.editor.id].sort());
	});

	describe('a report prints at the visibility fixed when it was queued (218: the render token’s claim)', () => {
		const at = () => `/projects/${ctx.projectId}`;
		const Q_CANARY = 432_198_765;
		/** Run the report job as its requester (REPORT_RENDERER=sqs: the request is captured), and open its render session: the cookie. */
		async function render(jobId: string): Promise<string> {
			const [row] = await asOwner('SELECT id, project_id, requested_by FROM report WHERE job_id = $1', [jobId]);
			const job = { id: jobId, projectId: row!.project_id as string, actingUserId: row!.requested_by as string, kind: 'report_render' };
			await withUser(job.actingUserId, (db) => reportRenderHandler.run({ db, job, payload: { reportId: row!.id as string }, progress: async () => true, deadline: null } as never));
			const message = sent.find((m) => m.reportId === row!.id);
			expect(message, 'the render request').toBeDefined();
			const opened = await anon('POST', '/auth/render-session', { token: message!.token });
			expect(opened.status).toBe(200);
			return opened.headers.get('set-cookie')!.split(';')[0]!;
		}
		const asSession = async (cookie: string, path: string) =>
			(await app.request(path, { headers: { cookie, origin: 'http://localhost:7777' } })).text();
		const printed = async (cookie: string) => (await asSession(cookie, `${at()}/runs/${baseRun}`)) + (await asSession(cookie, `${at()}/runs/${baseRun}/publication`));
		const role = (r: 'viewer' | 'editor') => ctx.owner.call('PATCH', `${at()}/members/${ctx.viewer.id}`, { role: r });
		const switchTo = (on: boolean) => ctx.owner.call('PUT', `${at()}/allocations/viewer-units`, { on });

		beforeAll(() => {
			vi.stubEnv('REPORT_RENDERER', 'sqs');
			vi.stubEnv('RENDER_REQUESTS_QUEUE_URL', 'http://queue.test/render-requests');
		});
		afterAll(async () => {
			vi.unstubAllEnvs();
			expect((await role('viewer')).status).toBe(200);
			expect((await switchTo(false)).status).toBe(200);
		});

		it('a viewer’s report, the viewer promoted to editor before it renders: printed without the volumes', async () => {
			const job = (await ctx.viewer.call('POST', `${at()}/reports`, { runId: baseRun })).body.jobId as string;
			expect((await role('editor')).status).toBe(200);
			try {
				const text = await printed(await render(job));
				expect(seen(text, CANARY)).toBe(false);
				// Positive control: as an editor now, their own request reads it.
				expect(seen((await get(ctx.viewer, `${at()}/runs/${baseRun}/publication`)).text, CANARY)).toBe(true);
			} finally {
				expect((await role('viewer')).status).toBe(200);
			}
		});

		it('a viewer’s report, the owner letting viewers read each volume before it renders: printed without them', async () => {
			const job = (await ctx.viewer.call('POST', `${at()}/reports`, { runId: baseRun })).body.jobId as string;
			expect((await switchTo(true)).status).toBe(200);
			try {
				expect(seen(await printed(await render(job)), CANARY)).toBe(false);
			} finally {
				expect((await switchTo(false)).status).toBe(200);
			}
		});

		it('positive control: an editor’s report is printed with them', async () => {
			const job = (await ctx.editor.call('POST', `${at()}/reports`, { runId: baseRun })).body.jobId as string;
			expect(seen(await printed(await render(job)), CANARY)).toBe(true);
		});

		it('an impact report against another project’s baseline is printed without either project’s volumes, and any reader of the report’s project may download it', async () => {
			// Project Q, the owner's own, with a registered volume on its run.
			const q = (await ctx.owner.call('POST', '/projects', { name: 'Canary baseline project' })).body.project.id as string;
			const outlet = node('Weir', null);
			const farm = node('Q farm', outlet.id, { areaKm2: 10 });
			expect((await ctx.owner.call('PUT', `/projects/${q}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
			expect((await ctx.owner.call('PATCH', `/projects/${q}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
			const rain = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 25 : 0));
			expect((await ctx.owner.call('PUT', `/projects/${q}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
			expect((await ctx.owner.call('POST', `/projects/${q}/allocations`, { nodeId: farm.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: Q_CANARY })).status).toBe(201);
			const qRun = (await ctx.owner.call('POST', `/projects/${q}/runs`, {})).body.run.id as string;
			const compare = `/compare/runs?a=${q}:${qRun}&b=${ctx.projectId}:${baseRun}`;
			// Positive control: the owner, an editor of both, reads both projects' volumes in the comparison.
			const direct = (await get(ctx.owner, compare)).text;
			expect(seen(direct, Q_CANARY) && seen(direct, CANARY)).toBe(true);
			const asked = await ctx.owner.call('POST', `${at()}/reports`, { runId: baseRun, against: `${q}:${qRun}` });
			expect(asked.status, JSON.stringify(asked.body)).toBe(202);
			expect((await asOwner('SELECT with_volumes FROM report WHERE job_id = $1', [asked.body.jobId]))[0]!.with_volumes).toBe(false);
			const text = await asSession(await render(asked.body.jobId), compare);
			expect(seen(text, Q_CANARY)).toBe(false);
			expect(seen(text, CANARY)).toBe(false);
			// Printed without them, so not withheld from the report project's viewers (409: not printed in this test).
			expect((await ctx.viewer.call('GET', `${at()}/reports/${asked.body.jobId}/pdf`)).status).toBe(409);
		});
	});
});

/**
 * Team scenario runs of `baseRun` that cap use at the registered volumes and that scale demand to them
 * (settings.set allocationMode; since #507 only a scenario does), for the canary sweep (#523 I).
 */
async function allocationModeRuns(post: (path: string, body: unknown) => Promise<any>, baseRun: string): Promise<[string, string]> { // eslint-disable-line @typescript-eslint/no-explicit-any
	const out: string[] = [];
	for (const mode of ['cap', 'fullAllocation'] as const) {
		const scenario = (await post('/scenarios', { name: `Canary ${mode}`, baseRunId: baseRun, ops: [{ op: 'settings.set', path: 'allocationMode', value: mode }] })).scenario.id as string;
		out.push((await post(`/scenarios/${scenario}/runs`, {})).run.id as string);
	}
	return out as [string, string];
}

/** Every route that serves a unit's daily figures of a run (`run`: its path), asked for that unit's own (#523 I). */
const unitSeriesPaths = (run: string, unit: string, day: string): string[] => [
	...['allocation_room_surface', 'allocation_left_surface', 'allocation_demand_factor', 'demand', 'supplied'].map((key) => `${run}/series?key=${key}&nodeId=${unit}`),
	`${run}/series/bulk?nodeId=${unit}`,
	`${run}/day?nodeId=${unit}&date=${day}`,
	`${run}/export/daily.csv?nodeId=${unit}`,
	...['allocation_room_surface', 'demand'].map((key) => `${run}/export/farms.csv?key=${key}`)
];

/**
 * Whether two numbers in a response differ by `n` in m³ a year, or by its daily mean (n ÷ 365) or megalitres (n ÷ 1000),
 * within a part in a million: a figure got by subtraction (#523 I, round 4: the water balance less the units shown).
 */
function differenceOf(text: string, n: number): boolean {
	// The figures it serves (JSON numbers, or a CSV's cells), not the digits inside ids, hashes or dates.
	const values = (v: unknown): number[] => (typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(values) : []);
	let parsed: number[];
	try {
		parsed = values(JSON.parse(text));
	} catch {
		parsed = text.split(/[,\r\n]/).map((c) => (/^\s*-?\d+(\.\d+)?(e[+-]?\d+)?\s*$/i.test(c) ? Number(c) : NaN));
	}
	const all = [...new Set(parsed.filter(Number.isFinite))].sort((a, b) => a - b);
	const has = (target: number, tol: number) => {
		let lo = 0;
		let hi = all.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (Math.abs(all[mid]! - target) <= tol) return true;
			if (all[mid]! < target) lo = mid + 1;
			else hi = mid - 1;
		}
		return false;
	};
	return [n, n / 365, n / 1000].some((d) => all.some((a) => has(a + d, d * 1e-6)));
}
