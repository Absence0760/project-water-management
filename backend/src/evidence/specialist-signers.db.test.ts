// Who signs an evidence pack, and the registration check (167_signers;
// licensing positions items 9 and 16, provisional position, pre-counsel
// research, 2026-10-01; docs/evidence-pack.md § Signing, docs/security.md
// § Professional sign-off). Every "cannot" has its positive control:
//
//   - the applicant's appointed specialist: set by the owner on a member of
//     an applying party (never without a party; a party change ends it);
//     reads and signs the drafts of their party's applications as
//     `specialist`, never as `review`, never another party's;
//   - the registration check: recorded by an owner of the project (never an
//     editor, never of a non-member, never in the future), read by the
//     editors and the person themselves, insert-only; current only while the
//     latest check says `registered`; bound at issue and shown by verify;
//     forgotten with the account unless a pack rests on it;
//   - the project's requirement: the owner's to turn off, refused to an
//     editor in the API and in the database.
//
// The packs are planted past their guards (replica role), as
// applicant-packs.db.test.ts plants them: their runs carry no stamp, so a
// specialist's sign-off gets as far as `run_unverified`, the positive
// control for the route's authorisation; the database's own insert policy
// is tested directly.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { anon, asOwner, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

let owner: User;
let assessor: User; // editor
let viewer: User;
let applicantA: User; // contributor, party Kalk Trust
let specialistA: User; // contributor, party Kalk Trust, the specialist
let applicantB: User; // contributor, party B Farms
let specialistB: User; // contributor, party B Farms, the specialist
let projectId: string;
let appA: string;
let appB: string;
let draftA: string;
let draftB: string;
let issuedA: string;
let issuedSignoff: string;

const outlet = node('Rooikloof', null);
const P = () => `/projects/${projectId}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const STATEMENT = 'a'.repeat(64);

async function arrange<T>(fn: (q: Q) => Promise<T>): Promise<T> {
	const client = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await client.connect();
	try {
		await client.query('BEGIN');
		await client.query('SET LOCAL session_replication_role = replica');
		const result = await fn(async (sql, params = []) => (await client.query(sql, params)).rows);
		await client.query('COMMIT');
		return result;
	} catch (err) {
		await client.query('ROLLBACK');
		throw err;
	} finally {
		await client.end();
	}
}

async function plantRun(q: Q, scenario: string | null = null): Promise<string> {
	const rows = await q(
		`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, scenario_id) VALUES ($1, $2, '1.50.0', '2000-10-01', '2020-09-30', '{"settings":{"runoffModel":"gr4j"}}', $3) RETURNING id::text`,
		[projectId, owner.id, scenario]
	);
	return rows[0]!.id as string;
}

async function plantPack(q: Q, o: { run: string; scenario: string; scenarioRun: string; status: 'draft' | 'issued'; title: string }): Promise<string> {
	const id = randomUUID();
	const manifest = { pack: { id, version: 1 }, project: { id: projectId, name: 'Signers' }, engine: { version: '1.50.0' }, report: { identity: { title: o.title } } };
	await q(
		`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, scenario_id, scenario_run_id, status, manifest, manifest_sha256,
			report_version, engine_version, created_by, issued_at, issued_by)
		 VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, 'evidence-8', '1.50.0', $9, CASE WHEN $6 = 'issued' THEN now() END, CASE WHEN $6 = 'issued' THEN $9::uuid END)`,
		[id, projectId, o.run, o.scenario, o.scenarioRun, o.status, JSON.stringify(manifest), sha(id), assessor.id]
	);
	return id;
}

async function plantSignoff(q: Q, pack: string, signer: User, kind: 'specialist' | 'review' = 'specialist', no = '400123/10'): Promise<string> {
	const [r] = await q(
		`INSERT INTO signoff (project_id, pack_id, user_id, full_name, registration_body, registration_category, registration_field, registration_no, scope, statement_version, statement_sha256, disclaimer_version, kind)
		 VALUES ($1, $2, $3, $4, 'sacnasp', 'pr_sci_nat', 'water_resources', $5, 'x', 'pack-signoff-1', $6, 'v3', $7) RETURNING id::text`,
		[projectId, pack, signer.id, `Dr ${signer.email.split('@')[0]}`, no, STATEMENT, kind]
	);
	return r!.id as string;
}

const CHECK = {
	registrationBody: 'sacnasp',
	registrationCategory: 'pr_sci_nat',
	registrationNo: '400123 / 10',
	registerName: 'Dr Specialist',
	outcome: 'registered',
	checkedByOrg: 'Rooikloof WUA',
	checkedAt: new Date(Date.now() - 86_400_000).toISOString()
};
const record = (as: User, u: User, body: Record<string, unknown> = CHECK) => as.call('POST', `${P()}/members/${u.id}/registration-checks`, body);
const bind = (as: User, pack: string, doBind = false) =>
	withUser(as.id, async (db) => (await db.query<{ m: string[] }>('SELECT app_pack_bind_registration_checks($1, $2, $3, $4) AS m', [projectId, pack, STATEMENT, doBind])).rows[0]!.m);

beforeAll(async () => {
	[owner, assessor, viewer, applicantA, specialistA, applicantB, specialistB] = (await Promise.all(
		['Sgowner', 'Sgassessor', 'Sgviewer', 'Sgapplicanta', 'Sgspecialista', 'Sgapplicantb', 'Sgspecialistb'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Signers' })).body.project.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	for (const [u, role, party] of [
		[assessor, 'editor', null],
		[viewer, 'viewer', null],
		[applicantA, 'contributor', 'Kalk Trust'],
		[specialistA, 'contributor', 'kalk trust'],
		[applicantB, 'contributor', 'B Farms'],
		[specialistB, 'contributor', 'B Farms']
	] as const) {
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
		if (party) expect((await owner.call('PATCH', `${P()}/members/${u.id}`, { party })).status).toBe(200);
	}
	await arrange(async (q) => {
		const base = await plantRun(q);
		const plant = async (name: string, by: User) =>
			(
				await q(
					`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin, status, submitted_at, owned_node_ids)
					 VALUES ($1, $2, $3, repeat('a', 64), $4, 'applicant', 'submitted', now(), '{}') RETURNING id::text`,
					[projectId, name, base, by.id]
				)
			)[0]!.id as string;
		appA = await plant('Raise the weir dam', applicantA);
		appB = await plant('B plan', applicantB);
		const runA = await plantRun(q, appA);
		const runB = await plantRun(q, appB);
		// The applicant shares the application with their specialist, as with any consultant of their party (049).
		await q('INSERT INTO scenario_member (project_id, scenario_id, user_id, added_by) VALUES ($1, $2, $3, $4)', [projectId, appA, specialistA.id, applicantA.id]);
		await q('INSERT INTO scenario_member (project_id, scenario_id, user_id, added_by) VALUES ($1, $2, $3, $4)', [projectId, appB, specialistB.id, applicantB.id]);
		draftA = await plantPack(q, { run: base, scenario: appA, scenarioRun: runA, status: 'draft', title: 'Raise the weir dam' });
		draftB = await plantPack(q, { run: base, scenario: appB, scenarioRun: runB, status: 'draft', title: 'B plan' });
		issuedA = await plantPack(q, { run: base, scenario: appA, scenarioRun: runA, status: 'issued', title: 'Raise the weir dam' });
		issuedSignoff = await plantSignoff(q, issuedA, specialistA);
	});
}, 120_000);

describe('the applicant’s appointed specialist', () => {
	it('is set by an owner on a member of an applying party, never without one, and never by an editor', async () => {
		expect((await owner.call('PATCH', `${P()}/members/${assessor.id}`, { specialist: true })).status).toBe(409);
		expect((await assessor.call('PATCH', `${P()}/members/${specialistA.id}`, { specialist: true })).status).toBe(403);
		const r = await owner.call('PATCH', `${P()}/members/${specialistA.id}`, { specialist: true });
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body.member).toMatchObject({ specialist: true, party: 'kalk trust' });
		expect((await owner.call('PATCH', `${P()}/members/${specialistB.id}`, { specialist: true })).status).toBe(200);
		const audit = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'member.specialist'`, [projectId]);
		expect(audit.map((a) => (a.subject as { specialist: boolean }).specialist)).toEqual([true, true]);
		// The members list says who is.
		const members = (await owner.call('GET', `${P()}/members`)).body.members as { userId: string; specialist: boolean }[];
		expect(members.find((m) => m.userId === specialistA.id)?.specialist).toBe(true);
		expect(members.find((m) => m.userId === applicantA.id)?.specialist).toBe(false);
	});

	it('lists their party’s drafts to sign, and nobody else’s (control: B’s specialist lists B’s)', async () => {
		const a = await specialistA.call('GET', `${P()}/scenarios/${appA}/packs`);
		expect(a.status, JSON.stringify(a.body)).toBe(200);
		expect(a.body.toSign.map((p: { id: string }) => p.id)).toEqual([draftA]);
		expect((await specialistB.call('GET', `${P()}/scenarios/${appB}/packs`)).body.toSign.map((p: { id: string }) => p.id)).toEqual([draftB]);
		// The applicant themselves isn't the specialist.
		expect((await applicantA.call('GET', `${P()}/scenarios/${appA}/packs`)).body.toSign).toEqual([]);
	});

	it('reads the statement of their party’s draft; another party’s specialist and the applicant get 403', async () => {
		const r = await specialistA.call('GET', `${P()}/packs/${draftA}/signoffs`);
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body.statement).toMatchObject({ packId: draftA });
		expect(r.body.kinds).toEqual(['specialist']);
		// Planted runs carry no stamp: the dialog says so before anything is typed.
		expect(r.body.cannotSign).toMatch(/stamp|verif/i);
		expect((await specialistB.call('GET', `${P()}/packs/${draftA}/signoffs`)).status).toBe(403);
		expect((await applicantA.call('GET', `${P()}/packs/${draftA}/signoffs`)).status).toBe(403);
		// Editors are offered both kinds.
		expect((await assessor.call('GET', `${P()}/packs/${draftA}/signoffs`)).body.kinds).toEqual(['specialist', 'review']);
	});

	it('signs as the specialist only, and only their party’s pack (control: past the checks to run_unverified)', async () => {
		const shown = (await specialistA.call('GET', `${P()}/packs/${draftA}/signoffs`)).body;
		const body = (kind: string) => ({
			fullName: 'Dr Specialist',
			registrationBody: 'sacnasp',
			registrationCategory: 'pr_sci_nat',
			registrationField: 'water_resources',
			registrationNo: '400123/10',
			scope: 'the hydrology',
			confirmed: shown.statement.confirmations.map((k: { id: string }) => k.id),
			statementSha256: shown.statementSha256,
			kind
		});
		expect((await specialistA.call('POST', `${P()}/packs/${draftA}/signoffs`, body('review'))).status).toBe(403);
		expect((await specialistB.call('POST', `${P()}/packs/${draftA}/signoffs`, body('specialist'))).status).toBe(403);
		expect(await specialistA.call('POST', `${P()}/packs/${draftA}/signoffs`, body('specialist'))).toMatchObject({ status: 409, body: { code: 'run_unverified' } });
	});

	it('the database: inserts their own specialist sign-off of their party’s draft, never another’s, never a review', async () => {
		const insert = (u: User, pack: string, kind: string) =>
			withUser(u.id, (db) =>
				db.query(
					`INSERT INTO signoff (project_id, pack_id, user_id, full_name, registration_body, registration_category, registration_field, registration_no, scope, statement_version, statement_sha256, disclaimer_version, kind)
					 VALUES ($1, $2, app_current_user_id(), 'Dr S', 'sacnasp', 'pr_sci_nat', 'water_resources', '400123/10', 'x', 'pack-signoff-1', $3, 'v3', $4)`,
					[projectId, pack, STATEMENT, kind]
				)
			);
		await expect(insert(specialistA, draftB, 'specialist')).rejects.toMatchObject({ code: '42501' });
		await expect(insert(specialistA, draftA, 'review')).rejects.toMatchObject({ code: '42501' });
		await expect(insert(applicantA, draftA, 'specialist')).rejects.toMatchObject({ code: '42501' });
		await expect(insert(specialistA, draftA, 'specialist')).resolves.toBeTruthy();
		// And reads that pack's sign-offs (the dialog lists who signed); not B's.
		expect((await specialistA.call('GET', `${P()}/packs/${draftA}/signoffs`)).body.signoffs).toHaveLength(1);
	});

	it('a party change ends the appointment (control: the same update may make it again)', async () => {
		expect((await owner.call('PATCH', `${P()}/members/${specialistB.id}`, { party: 'Other Farms' })).body.member).toMatchObject({ specialist: false });
		expect((await specialistB.call('GET', `${P()}/scenarios/${appB}/packs`)).status).toBe(404);
		expect((await owner.call('PATCH', `${P()}/members/${specialistB.id}`, { party: 'B Farms', specialist: true })).body.member).toMatchObject({ specialist: true });
	});
});

describe('the registration check', () => {
	it('is recorded by an owner, of a member, on a date that has passed; never by an editor or a viewer', async () => {
		expect((await record(assessor, specialistA)).status).toBe(403);
		expect((await record(viewer, specialistA)).status).toBe(403);
		expect((await owner.call('POST', `${P()}/members/${randomUUID()}/registration-checks`, CHECK)).status).toBe(404);
		expect((await record(owner, specialistA, { ...CHECK, checkedAt: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(400);
		const r = await record(owner, specialistA);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.check).toMatchObject({ userId: specialistA.id, outcome: 'registered', checkedByOrg: 'Rooikloof WUA', recordedBy: 'Sgowner' });
		const audit = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'registration.checked'`, [projectId]);
		expect(audit).toHaveLength(1);
	});

	it('is recorded by an editor once an owner marks them as acting for the responsible authority (163; control: unmarked, 403 above)', async () => {
		expect((await owner.call('PATCH', `${P()}/members/${assessor.id}`, { actsForAuthority: true })).status).toBe(200);
		try {
			const r = await record(assessor, specialistB);
			expect(r.status, JSON.stringify(r.body)).toBe(201);
			expect(r.body.check).toMatchObject({ userId: specialistB.id, recordedBy: 'Sgassessor' });
		} finally {
			expect((await owner.call('PATCH', `${P()}/members/${assessor.id}`, { actsForAuthority: false })).status).toBe(200);
		}
		// Unmarked again: refused again, in the API and the database.
		expect((await record(assessor, specialistB)).status).toBe(403);
		await expect(
			withUser(assessor.id, (db) =>
				db.query("SELECT app_record_registration_check($1, $2, 'sacnasp', 'pr_sci_nat', '1', 'x', 'registered', 'x', now(), '')", [projectId, specialistB.id])
			)
		).rejects.toMatchObject({ code: '42501' });
	});

	it('is read by the editors and the person, never by a viewer or another member', async () => {
		const listed = (await assessor.call('GET', `${P()}/registration-checks`)).body;
		expect(listed.checks).toHaveLength(2);
		// The owner's setting as chosen (on by default), whatever the tests' switch.
		expect(listed.required).toBe(true);
		expect((await viewer.call('GET', `${P()}/registration-checks`)).status).toBe(403);
		const own = (u: User) => withUser(u.id, async (db) => (await db.query('SELECT id FROM registration_check WHERE project_id = $1', [projectId])).rows);
		expect(await own(specialistA)).toHaveLength(1);
		expect(await own(applicantA)).toHaveLength(0);
		// The person's data export carries it.
		expect((await specialistA.call('GET', '/auth/me/export')).body.registrationChecks).toEqual([expect.objectContaining({ checkedByOrg: 'Rooikloof WUA' })]);
	});

	it('is insert-only, even for the schema owner, and water_app writes it only through the function', async () => {
		await expect(asOwner(`UPDATE registration_check SET outcome = 'not_registered' WHERE project_id = $1`, [projectId])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner('DELETE FROM registration_check WHERE project_id = $1', [projectId])).rejects.toMatchObject({ code: '23514' });
		await expect(
			withUser(owner.id, (db) =>
				db.query(
					`INSERT INTO registration_check (project_id, user_id, registration_body, registration_category, registration_no, register_name, outcome, checked_by_org, checked_at)
					 VALUES ($1, $2, 'sacnasp', 'pr_sci_nat', '1', 'x', 'registered', 'x', now())`,
					[projectId, owner.id]
				)
			)
		).rejects.toMatchObject({ code: '42501' });
	});

	it('stands behind the matching sign-off, unbound until issue; names the specialist signers without one', async () => {
		const listed = (await assessor.call('GET', `${P()}/packs/${draftA}/signoffs`)).body.signoffs as { kind: string; registrationCheck: unknown }[];
		expect(listed[0]).toMatchObject({ kind: 'specialist', registrationCheck: { checkedByOrg: 'Rooikloof WUA', bound: false } });
		expect(await bind(assessor, draftA)).toEqual([]);
		// A sign-off whose registration has no check: named (control: A's is not). B's check above is of 400123/10.
		await arrange((q) => plantSignoff(q, draftB, specialistB, 'specialist', '400999/99'));
		expect(await bind(assessor, draftB)).toEqual([expect.stringMatching(/sgspecialistb/i)]);
		// A review sign-off without a check doesn't hold an issue up.
		await arrange((q) => plantSignoff(q, draftA, assessor, 'review'));
		expect(await bind(assessor, draftA)).toEqual([]);
		// Only editors call it.
		await expect(bind(specialistA, draftA)).rejects.toMatchObject({ code: '42501' });
	});

	it('a later check that says "not registered" ends it (control: a new "registered" one brings it back)', async () => {
		expect((await record(owner, specialistA, { ...CHECK, outcome: 'not_registered', checkedAt: new Date().toISOString() })).status).toBe(201);
		expect(await bind(assessor, draftA)).toEqual(['Dr S']);
		expect((await record(owner, specialistA, { ...CHECK, checkedAt: new Date(Date.now() + 30_000).toISOString() })).status).toBe(201);
		expect(await bind(assessor, draftA)).toEqual([]);
	});

	it('verify shows the check bound at issue, and "self-declared" (null) for a sign-off without one', async () => {
		const [check] = await asOwner(`SELECT id FROM registration_check WHERE project_id = $1 AND outcome = 'registered' ORDER BY id LIMIT 1`, [projectId]);
		const verify = async () => (await anon('GET', `/verify/${sha(issuedA)}`)).body.pack.signers as { kind: string; registrationCheck: unknown }[];
		expect((await verify())[0]).toMatchObject({ kind: 'specialist', registrationCheck: null });
		await arrange((q) => q('INSERT INTO signoff_registration_check (signoff_id, check_id) VALUES ($1, $2)', [issuedSignoff, check!.id]));
		expect((await verify())[0]).toMatchObject({ kind: 'specialist', registrationCheck: { checkedByOrg: 'Rooikloof WUA', checkedAt: expect.any(String) } });
	});

	it('goes with the account unless an issued pack rests on it', async () => {
		const leaver = await signUp('Sgleaver');
		expect((await owner.call('POST', `${P()}/members`, { email: leaver.email, role: 'editor' })).status).toBe(201);
		expect((await record(owner, leaver)).status).toBe(201);
		await asOwner('DELETE FROM app_user WHERE id = $1', [leaver.id]);
		expect(await asOwner('SELECT 1 FROM registration_check WHERE project_id = $1 AND user_id IS NULL', [projectId])).toEqual([]);
		// The bound one stays without its account.
		await asOwner('DELETE FROM app_user WHERE id = $1', [specialistA.id]);
		expect(await asOwner('SELECT 1 FROM registration_check WHERE project_id = $1 AND user_id IS NULL', [projectId])).toHaveLength(1);
	});
});

describe('the project’s requirement', () => {
	it('is the owner’s to turn off, in the API and in the database; an editor is refused', async () => {
		expect((await assessor.call('PUT', `${P()}/registration-check-required`, { required: false })).status).toBe(403);
		await expect(withUser(assessor.id, (db) => db.query('UPDATE project SET require_registration_check = false WHERE id = $1', [projectId]))).rejects.toMatchObject({
			code: '42501'
		});
		// Control: an editor's other changes to the project still go through.
		expect((await assessor.call('PATCH', P(), { description: 'still editable' })).status).toBe(200);
		const r = await owner.call('PUT', `${P()}/registration-check-required`, { required: false });
		expect(r.status).toBe(200);
		expect((await asOwner('SELECT require_registration_check AS r FROM project WHERE id = $1', [projectId]))[0]).toEqual({ r: false });
		expect((await assessor.call('GET', `${P()}/registration-checks`)).body.required).toBe(false);
		expect(await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'registration.requirement'`, [projectId])).toEqual([{ subject: { required: false } }]);
	});
});
