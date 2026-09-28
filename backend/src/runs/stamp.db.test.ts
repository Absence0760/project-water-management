// Run stamps (077_run_stamp.sql, runs/stamp.ts; docs/security.md § Run
// stamps). RLS lets an applicant insert their own application's run rows
// (045 model_run_insert_contributor) and an editor any run of the project, so
// a row alone doesn't say the engine made it. The backend signs every run it
// stores; a sign-off and an application's decision refuse a run whose stamp
// is missing or no longer matches, and the run answers say `verified`.
//
// Positive controls (CLAUDE.md rule 5): a run the API made verifies and is
// signed off, and the application is decided once the forged runs are gone;
// a tampered run verifies again once its rows are put back as they were.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { RUN_UNVERIFIED } from './stamp.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User; // the assessing authority's modeller
let assessor: User; // editor
let applicant: User; // contributor, linked to Rooikloof
let projectId: string;
let published: string;
let teamRun: string;
let sid: string;
let appRun: string;

const outlet = node('Gauge', null);
const rooikloof = node('Rooikloof', outlet.id, { damCapacityM3: 100_000 });
const kalkoenkrans = node('Kalkoenkrans', outlet.id);
const citrus = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };

const P = () => `/projects/${projectId}`;
const ALL = ['calibration', 'ewr', 'works', 'assurance', 'limitations'];

/** Sign `runId` off as `u`, with the statement GET …/signoffs shows. */
async function signOff(u: User, runId: string) {
	const shown = await u.call('GET', `${P()}/runs/${runId}/signoffs`);
	expect(shown.status).toBe(200);
	return u.call('POST', `${P()}/runs/${runId}/signoffs`, {
		fullName: 'Dr A. Assessor',
		registrationBody: 'SACNASP',
		registrationNo: '400123/21',
		scope: 'Hydrology of a synthetic application',
		confirmed: ALL,
		statementSha256: shown.body.statementSha256
	});
}

const verified = async (u: User, runId: string) => {
	const res = await u.call('GET', `${P()}/runs/${runId}`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.run.verified as boolean;
};

beforeAll(async () => {
	[owner, assessor, applicant] = await Promise.all([signUp('StampOwner'), signUp('StampAssessor'), signUp('StampApplicant')]);
	projectId = (await owner.call('POST', '/projects', { name: 'Run stamps' })).body.project.id;
	const model = {
		nodes: [outlet, rooikloof, kalkoenkrans],
		crops: [citrus],
		cropAreas: [{ nodeId: rooikloof.id, cropId: citrus.id, areaM2: 50_000 }],
		transfers: []
	};
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	published = (await owner.call('POST', `${P()}/runs`, { label: 'Baseline' })).body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	teamRun = (await owner.call('POST', `${P()}/runs`, { label: 'Team run' })).body.run.id;
	for (const [u, role] of [
		[assessor, 'editor'],
		[applicant, 'contributor']
	] as const) {
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	}
	expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
	const made = await applicant.call('POST', `${P()}/scenarios`, {
		name: 'Raise Rooikloof',
		baseRunId: published,
		ops: [{ op: 'node.set', nodeId: rooikloof.id, field: 'damCapacityM3', value: 120_000 }]
	});
	expect(made.status, JSON.stringify(made.body)).toBe(201);
	sid = made.body.scenario.id;
	const ran = await applicant.call('POST', `${P()}/scenarios/${sid}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	appRun = ran.body.run.id;
	expect((await applicant.call('POST', `${P()}/scenarios/${sid}/submit`)).status).toBe(200);
});

describe('a run the model run stored', () => {
	it('is stamped, verifies, and is signed off (positive control)', async () => {
		const [row] = await asOwner('SELECT octet_length(stamp) AS n FROM model_run WHERE id = $1', [appRun]);
		expect(row.n).toBe(32);
		expect(await verified(assessor, appRun)).toBe(true);
		expect(await verified(owner, teamRun)).toBe(true);
		expect((await assessor.call('GET', `${P()}/runs/${appRun}/signoffs`)).body.cannotSign).toBeNull();
		const signed = await signOff(assessor, appRun);
		expect(signed.status, JSON.stringify(signed.body)).toBe(201);
		const s = await assessor.call('GET', `${P()}/scenarios/${sid}`);
		expect(s.body.unverifiedRunIds).toEqual([]);
		// Below editor (the applicant) the list isn't computed at all.
		expect((await applicant.call('GET', `${P()}/scenarios/${sid}`)).body.unverifiedRunIds).toBeNull();
	});
});

describe('a run written past the API', () => {
	let forged: string;
	let replayed: string;

	it('is refused at sign-off and shows unverified, whatever stamp it carries', async () => {
		// The bypass: SQL as water_app, as the applicant, which RLS admits (045).
		// Their application's real inputs (read here as the owner, test state
		// only), with a summary the engine never produced; one run with a made-up
		// stamp, one with the stamp of the application's genuine run.
		const [real] = await asOwner('SELECT inputs, summary, engine_version, start_date, end_date, stamp FROM model_run WHERE id = $1', [appRun]);
		forged = crypto.randomUUID();
		replayed = crypto.randomUUID();
		await withUser(applicant.id, async (db) => {
			for (const [id, stamp] of [
				[forged, Buffer.alloc(32, 7)],
				[replayed, real.stamp as Buffer]
			] as const) {
				await db.query(
					`INSERT INTO model_run (id, project_id, created_by, label, engine_version, start_date, end_date, inputs, summary, scenario_id, stamp)
					 VALUES ($1, $2, app_current_user_id(), 'Raise Rooikloof', $3, $4, $5, $6, $7, $8, $9)`,
					[id, projectId, real.engine_version, real.start_date, real.end_date, real.inputs, { ...real.summary, forged: true }, sid, stamp]
				);
				await db.query(
					`INSERT INTO run_series (run_id, project_id, node_id, key, meta, "values") VALUES ($1, $2, NULL, 'natural_flow', '{}', $3::float8[])`,
					[id, projectId, [1, 2, 3]]
				);
			}
		});
		for (const id of [forged, replayed]) {
			expect(await verified(assessor, id), id).toBe(false);
			expect((await assessor.call('GET', `${P()}/runs/${id}/signoffs`)).body.cannotSign).toBe(RUN_UNVERIFIED);
			const res = await signOff(assessor, id);
			expect(res.status, JSON.stringify(res.body)).toBe(409);
			expect(res.body.code).toBe('run_unverified');
		}
		expect((await asOwner('SELECT count(*)::int AS n FROM signoff WHERE run_id = ANY($1::uuid[])', [[forged, replayed]]))[0].n).toBe(0);
		// The genuine run still verifies beside them (positive control).
		expect(await verified(assessor, appRun)).toBe(true);
	});

	it("keeps the application from being decided until they're gone (then it is)", async () => {
		const s = await assessor.call('GET', `${P()}/scenarios/${sid}`);
		expect([...s.body.unverifiedRunIds].sort()).toEqual([forged, replayed].sort());
		const refused = await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { outcome: 'approved' });
		expect(refused.status, JSON.stringify(refused.body)).toBe(409);
		expect(refused.body.code).toBe('run_unverified');
		expect((await assessor.call('GET', `${P()}/scenarios/${sid}`)).body.scenario.status).toBe('submitted');
		// The assessor deletes them; the application is then decided on its genuine run.
		for (const id of [forged, replayed]) expect((await assessor.call('DELETE', `${P()}/runs/${id}`)).status).toBe(204);
		const decided = await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, { outcome: 'approved' });
		expect(decided.status, JSON.stringify(decided.body)).toBe(200);
		expect(decided.body.unverifiedRunIds).toEqual([]);
	});
});

describe('a stamped run changed after it was stored', () => {
	it('is unverified while its summary differs, and verifies again once put back', async () => {
		const [before] = await asOwner('SELECT summary::text AS s FROM model_run WHERE id = $1', [teamRun]);
		await asOwner(`UPDATE model_run SET summary = summary || '{"tampered": true}' WHERE id = $1`, [teamRun]);
		expect(await verified(owner, teamRun)).toBe(false);
		const refused = await signOff(owner, teamRun);
		expect(refused.status).toBe(409);
		expect(refused.body.code).toBe('run_unverified');
		await asOwner('UPDATE model_run SET summary = $2::jsonb WHERE id = $1', [teamRun, before.s]);
		expect(await verified(owner, teamRun)).toBe(true);
	});

	it('is unverified while one output value differs (an editor may UPDATE run_series), and verifies again once put back', async () => {
		const [s] = await asOwner(`SELECT key, "values" FROM run_series WHERE run_id = $1 AND node_id IS NULL AND key = 'natural_flow'`, [teamRun]);
		const values = s.values as number[];
		// As an editor, through RLS (run_series_update, 001): a second layer the stamp now covers.
		await withUser(owner.id, (db) =>
			db.query(`UPDATE run_series SET "values"[1] = $2 WHERE run_id = $1 AND node_id IS NULL AND key = 'natural_flow'`, [teamRun, (values[0] ?? 0) + 1])
		);
		expect(await verified(owner, teamRun)).toBe(false);
		await asOwner(`UPDATE run_series SET "values" = $2::float8[] WHERE run_id = $1 AND node_id IS NULL AND key = 'natural_flow'`, [teamRun, values]);
		expect(await verified(owner, teamRun)).toBe(true);
	});

	it('is unverified once its stored input series point at another blob', async () => {
		const [i] = await asOwner(`SELECT kind, start_date::text AS d FROM run_input_series WHERE run_id = $1 LIMIT 1`, [teamRun]);
		await asOwner(`UPDATE run_input_series SET start_date = start_date + 1 WHERE run_id = $1 AND kind = $2`, [teamRun, i.kind]);
		expect(await verified(owner, teamRun)).toBe(false);
		await asOwner(`UPDATE run_input_series SET start_date = $3::date WHERE run_id = $1 AND kind = $2`, [teamRun, i.kind, i.d]);
		expect(await verified(owner, teamRun)).toBe(true);
	});
});

describe('the stamp functions', () => {
	it('give no digest of a run the caller cannot read, and take no stamp for a run they did not just store', async () => {
		// The applicant reads no run row (046): no digest of the published run; the owner gets one (control).
		const as = (u: User, sql: string, p: unknown[]) => withUser(u.id, async (db) => (await db.query(sql, p)).rows[0]);
		expect((await as(applicant, 'SELECT app_run_digest($1) AS d', [published])).d).toBeNull();
		expect(((await as(owner, 'SELECT app_run_digest($1) AS d', [published])).d as Buffer).length).toBe(32);
		// A run stored in an earlier transaction takes no stamp, even from its maker.
		expect((await as(owner, 'SELECT app_set_run_stamp($1, $2) AS ok', [teamRun, Buffer.alloc(32)])).ok).toBe(false);
		expect(await verified(owner, teamRun)).toBe(true);
		// water_app can't write the column directly either (column grants: notes, pinned).
		await expect(withUser(owner.id, (db) => db.query('UPDATE model_run SET stamp = NULL WHERE id = $1', [teamRun]))).rejects.toMatchObject({ code: '42501' });
	});
});
