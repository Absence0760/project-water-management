// The import report kept with a project (017_project_import): stored with
// POST /projects/import in the same transaction, read back by viewers through
// GET /projects/:id/import-report, and written by nothing else. Synthetic
// data only.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { app, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { IMPORT_REPORT_LIMITS, IMPORT_REPORT_MAX_ITEMS } from './importReport.js';

// Throws right after the report row is written, when set: the whole import
// (project and report) must roll back.
const failAfterReport = vi.hoisted(() => ({ on: false }));
vi.mock('./importReport.js', async (importOriginal) => {
	const mod = await importOriginal<typeof import('./importReport.js')>();
	return {
		...mod,
		insertImportReport: async (...args: Parameters<typeof mod.insertImportReport>) => {
			await mod.insertImportReport(...args);
			if (failAfterReport.on) throw new Error('simulated failure after the report');
		}
	};
});

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';

function syntheticDoc(name: string) {
	const outlet = node('Outlet gauge', null);
	const farm = node('Echo Farm', outlet.id, { damCapacityM3: 150_000 });
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	return {
		name,
		description: 'synthetic',
		settings: { apanMm: monthly(150) },
		model: { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 40_000 }], transfers: [] },
		series: [{ kind: 'rain_catchment_mm', name: '', unit: 'mm', startDate: '2022-01-01', values: [0, 12, 0, 3] }]
	};
}

const workbookReport = (over: Record<string, unknown> = {}) => ({
	source: 'b023-workbook',
	fileName: 'synthetic_b023.xlsx',
	importerVersion: 'b023 web importer 1; engine test',
	notes: [
		{ code: 'dam-area-unknown', severity: 'info', message: 'dams have no surface area in the workbook', sheet: 'Farm spec' },
		{ code: 'calibration-flow-missing', severity: 'warning', message: 'WARNING: rUseFlow picks a series with no values' }
	],
	unmapped: [
		{ code: 'transfer-inout-formula', message: 'hand-written InOut formula', sheet: 'Transfers', cell: 'T7', element: 'Echo Farm', text: '=S7*0.9-V7' }
	],
	...over
});

async function importWith(u: User, body: unknown, query = '') {
	const res = await app.request(`/projects/import${query}`, {
		method: 'POST',
		headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: u.cookie },
		body: JSON.stringify(body)
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : null };
}

const projectNames = async (u: User) => (await u.call('GET', '/projects')).body.projects.map((p: { name: string }) => p.name) as string[];
/** Every report row the user can see (RLS), whatever project it is on. */
const visibleReports = (u: User) => withUser(u.id, async (db) => (await db.query('SELECT file_name FROM project_import')).rows.map((r) => r.file_name));

let owner: User;
let importedId: string;

beforeAll(async () => {
	owner = await signUp('Importer');
	const res = await importWith(owner, { ...syntheticDoc('Imported with a report'), importReport: workbookReport() });
	expect(res.status).toBe(201);
	importedId = res.body.project.id;
});

describe('POST /projects/import with an import report', () => {
	it('stores the report with the project, and GET /projects/:id/import-report returns it', async () => {
		const res = await owner.call('GET', `/projects/${importedId}/import-report`);
		expect(res.status).toBe(200);
		const { report } = res.body;
		expect(report).toEqual({
			importedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
			importedBy: 'Importer',
			source: 'b023-workbook',
			fileName: 'synthetic_b023.xlsx',
			importerVersion: 'b023 web importer 1; engine test',
			notes: workbookReport().notes,
			unmapped: workbookReport().unmapped,
			notesOmitted: 0,
			unmappedOmitted: 0
		});
		// The project's own shape is unchanged: the report isn't on GET /projects/:id.
		expect((await owner.call('GET', `/projects/${importedId}`)).body.project).not.toHaveProperty('importReport');
	});

	it('keeps the existing contract: a plain document imports with no report, and the report route 404s', async () => {
		const res = await importWith(owner, syntheticDoc('No report'));
		expect(res.status).toBe(201);
		const none = await owner.call('GET', `/projects/${res.body.project.id}/import-report`);
		expect(none.status).toBe(404);
		expect(none.body).toEqual({ error: 'no import report' });
		// A project made by hand has none either.
		const made = (await owner.call('POST', '/projects', { name: 'By hand' })).body.project.id;
		expect((await owner.call('GET', `/projects/${made}/import-report`)).status).toBe(404);
	});

	it('records a project-file import with its notes', async () => {
		const res = await importWith(owner, {
			...syntheticDoc('From a project file'),
			importReport: {
				source: 'project-file',
				fileName: 'catchment.json',
				importerVersion: 'project file',
				notes: [{ code: 'project-file-note', severity: 'info', message: 'The file has no time series.' }]
			}
		});
		expect(res.status).toBe(201);
		const { report } = (await owner.call('GET', `/projects/${res.body.project.id}/import-report`)).body;
		expect(report).toMatchObject({ source: 'project-file', fileName: 'catchment.json', unmapped: [] });
		expect(report.notes).toHaveLength(1);
	});

	it('stores the report for an import into a team, which the team admin then reads', async () => {
		const admin = await signUp('Teamadmin');
		const member = await signUp('Teammember');
		const teamId = (await admin.call('POST', '/teams', { name: 'Report Team' })).body.team.id;
		expect((await admin.call('POST', `/teams/${teamId}/members`, { email: member.email, role: 'member' })).status).toBe(201);
		const res = await importWith(member, { ...syntheticDoc('Team import'), importReport: workbookReport({ fileName: 'team.xlsx' }) }, `?teamId=${teamId}`);
		expect(res.status).toBe(201);
		const seen = await admin.call('GET', `/projects/${res.body.project.id}/import-report`);
		expect(seen.body.report).toMatchObject({ fileName: 'team.xlsx', importedBy: 'Teammember' });
	});

	it('stores neither the project nor the report when the import fails after the report is written', async () => {
		const u = await signUp('Atomic');
		failAfterReport.on = true;
		try {
			const res = await importWith(u, { ...syntheticDoc('Half imported'), importReport: workbookReport({ fileName: 'half.xlsx' }) });
			expect(res.status).toBe(500);
			expect(res.body).toEqual({ error: 'Internal server error' });
		} finally {
			failAfterReport.on = false;
		}
		expect(await projectNames(u)).toEqual([]);
		expect(await visibleReports(u)).toEqual([]);
		// Positive control: the same request stores both once nothing fails.
		expect((await importWith(u, { ...syntheticDoc('Whole import'), importReport: workbookReport({ fileName: 'whole.xlsx' }) })).status).toBe(201);
		expect(await projectNames(u)).toEqual(['Whole import']);
		expect(await visibleReports(u)).toEqual(['whole.xlsx']);
	});

	it('refuses an oversize or malformed report with 400 and creates nothing', async () => {
		const u = await signUp('Oversize');
		const tooMany = Array.from({ length: IMPORT_REPORT_MAX_ITEMS + 1 }, () => workbookReport().unmapped[0]);
		const r1 = await importWith(u, { ...syntheticDoc('Too many items'), importReport: workbookReport({ unmapped: tooMany }) });
		expect(r1.status).toBe(400);
		expect(r1.body.error).toBe('invalid request');
		expect(r1.body.details[0].path).toEqual(['importReport', 'unmapped']);

		// Within the item cap, over the size cap: 500 × 2000-character messages ≈ 1 MB.
		const huge = Array.from({ length: IMPORT_REPORT_MAX_ITEMS }, () => ({ code: 'non-numeric-value', message: 'x'.repeat(IMPORT_REPORT_LIMITS.message) }));
		const r2 = await importWith(u, { ...syntheticDoc('Too big'), importReport: workbookReport({ unmapped: huge }) });
		expect(r2.status).toBe(400);

		const r3 = await importWith(u, { ...syntheticDoc('Long text'), importReport: workbookReport({ unmapped: [{ code: 'x', message: 'm', text: 't'.repeat(IMPORT_REPORT_LIMITS.text + 1) }] }) });
		expect(r3.status).toBe(400);
		const r4 = await importWith(u, { ...syntheticDoc('Bad source'), importReport: { ...workbookReport(), source: 'csv' } });
		expect(r4.status).toBe(400);

		expect(await projectNames(u)).toEqual([]);
		expect(await visibleReports(u)).toEqual([]);
	});
});

describe('GET /projects/:id/import-report access', () => {
	it('a viewer reads it (positive control); a non-member gets 404 and RLS shows them no row', async () => {
		const viewer = await signUp('Viewer');
		const outsider = await signUp('Outsider');
		expect((await owner.call('POST', `/projects/${importedId}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);

		const seen = await viewer.call('GET', `/projects/${importedId}/import-report`);
		expect(seen.status).toBe(200);
		expect(seen.body.report.fileName).toBe('synthetic_b023.xlsx');
		expect(await visibleReports(viewer)).toEqual(['synthetic_b023.xlsx']);

		const hidden = await outsider.call('GET', `/projects/${importedId}/import-report`);
		expect(hidden.status).toBe(404);
		expect(hidden.body).toEqual({ error: 'not found' });
		// Below the route: the table itself shows the outsider nothing.
		expect(await visibleReports(outsider)).toEqual([]);
		expect((await outsider.call('GET', '/projects/not-a-uuid/import-report')).status).toBe(404);
	});
});

describe('project_import is written only by the import that created the project', () => {
	const insert = (u: User, projectId: string) =>
		withUser(u.id, (db) =>
			db.query(`INSERT INTO project_import (project_id, imported_by, source, file_name, importer_version) VALUES ($1, $2, 'b023-workbook', 'forged.xlsx', 'x')`, [
				projectId,
				u.id
			])
		);

	it('refuses a report added to an existing project afterwards, even by its owner', async () => {
		await expect(insert(owner, importedId)).rejects.toMatchObject({ code: '42501' });
		const made = (await owner.call('POST', '/projects', { name: 'Existing' })).body.project.id;
		await expect(insert(owner, made)).rejects.toMatchObject({ code: '42501' });
	});

	it('lets no one change or delete a report (no grant), and the owner still sees the original', async () => {
		await expect(withUser(owner.id, (db) => db.query(`UPDATE project_import SET file_name = 'edited.xlsx' WHERE project_id = $1`, [importedId]))).rejects.toMatchObject({
			code: '42501'
		});
		await expect(withUser(owner.id, (db) => db.query('DELETE FROM project_import WHERE project_id = $1', [importedId]))).rejects.toMatchObject({ code: '42501' });
		expect((await owner.call('GET', `/projects/${importedId}/import-report`)).body.report.fileName).toBe('synthetic_b023.xlsx');
	});

	it('stamps the importer and the time itself, whatever the insert says', async () => {
		const other = await signUp('Other');
		// Inside one transaction as `other`: create a project, then insert a report naming the owner as importer.
		const stamped = await withUser(other.id, async (db) => {
			const id = crypto.randomUUID();
			await db.query(`INSERT INTO project (id, name, created_by) VALUES ($1, 'Same transaction', app_current_user_id())`, [id]);
			await db.query(
				`INSERT INTO project_import (project_id, imported_by, imported_at, source, file_name, importer_version)
				 VALUES ($1, $2, '2000-01-01', 'project-file', 'p.json', 'x')`,
				[id, owner.id]
			);
			return (await db.query(`SELECT imported_by, imported_at > now() - interval '1 hour' AS fresh FROM project_import WHERE project_id = $1`, [id])).rows[0];
		});
		expect(stamped).toEqual({ imported_by: other.id, fresh: true });
	});
});
