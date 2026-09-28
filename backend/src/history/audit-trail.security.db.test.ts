// The audit trail's integrity (docs/security.md § Change history): the rows
// that say who did what (the change history, sign-offs, evidence
// nominations) can be added but never changed or removed by the app, whoever
// it acts as; nothing water_app can call rewrites them behind the grants; and
// a signed-off run stays the run that was signed. The write routes that must
// record a row are guarded by write-routes.db.test.ts; the grants, table by
// table, by db/catalogue.db.test.ts (APPEND_ONLY). Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { type Db, withApiKey, withoutUser, withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** The audit trail: who changed what (030_history), who signed a run (036_signoff), which run was the evidence and why (010_run_nomination). */
const AUDIT_TRAIL = ['audit_event', 'model_revision', 'series_revision', 'signoff', 'run_nomination'] as const;

/**
 * The only functions whose body rewrites or removes an audit-trail row, and
 * why. Each is a trigger function (never callable by water_app), attached
 * only where listed.
 */
const REWRITERS: Record<string, { on: string; why: string }> = {
	app_user_pseudonymise: {
		on: 'app_user',
		why: 'an account deleted on a POPIA request: its name in audit_event becomes "Deleted user", the event stays (048_account_deletion)'
	},
	series_revision_trim: {
		on: 'series_revision',
		why: 'the retention of kept series values: the newest 5 per series, none older than 180 days (030_history)'
	}
};

let owner: User;
let editor: User;
let viewer: User;
let contributor: User;
let farmer: User;
let stranger: User;
let teamAdmin: User;
let projectId: string;
let apiKeyId: string;
let runId: string;
let scenarioId: string;
let scenarioRunId: string;

const at = () => `/projects/${projectId}`;

/** Sign a run off as `u`, with the statement the route shows. */
async function signOff(u: User, run: string, pid = projectId) {
	const path = `/projects/${pid}/runs/${run}/signoffs`;
	const { statement, statementSha256 } = (await u.call('GET', path)).body;
	const res = await u.call('POST', path, {
		fullName: 'Trail Signer',
		registrationBody: 'sacnasp',
		registrationCategory: 'pr_sci_nat',
		registrationField: 'water_resources',
		registrationNo: '1',
		scope: 'the trail',
		confirmed: statement.confirmations.map((k: { id: string }) => k.id),
		statementSha256
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.signoff.id as string;
}

/** Give a project a model, settings and rain a run can use; returns its farm. */
async function runnable(u: User, pid: string) {
	const outlet = node('Weir', null);
	const farm = node('Farm A', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 100_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${pid}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	const rain = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await u.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	return farm;
}

/** A fingerprint of every audit-trail row of the project, read as the schema owner (no RLS). */
async function fingerprint() {
	const out: Record<string, { n: number; md5: string | null }> = {};
	for (const t of AUDIT_TRAIL) {
		const [r] = await asOwner(`SELECT count(*)::int AS n, md5(string_agg(x::text, '|' ORDER BY x::text)) AS md5 FROM ${t} x WHERE project_id = $1`, [projectId]);
		out[t] = { n: r!.n, md5: r!.md5 };
	}
	return out;
}

beforeAll(async () => {
	[owner, editor, viewer, contributor, farmer, stranger, teamAdmin] = (await Promise.all(
		['Aowner', 'Aeditor', 'Aviewer', 'Acontributor', 'Afarmer', 'Astranger', 'Ateamadmin'].map((n) => signUp(n))
	)) as User[] as [User, User, User, User, User, User, User];
	// A team project, so a team admin (owner here through the team) is one of the actors.
	const teamId = (await owner.call('POST', '/teams', { name: 'Trail WUA' })).body.team.id;
	expect((await owner.call('POST', `/teams/${teamId}/members`, { email: teamAdmin.email, role: 'admin' })).status).toBe(201);
	projectId = (await owner.call('POST', '/projects', { name: 'Trail', teamId })).body.project.id;
	const farm = await runnable(owner, projectId);
	// A second save replaces the series, keeping the first in series_revision.
	const rain = Array.from({ length: 400 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${at()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer'],
		[contributor, 'contributor']
	] as const) {
		expect((await owner.call('POST', `${at()}/members`, { email: u.email, role })).status).toBe(201);
	}
	expect((await owner.call('POST', `${at()}/farmers`, { email: farmer.email, nodeIds: [farm.id] })).status).toBe(201);
	runId = (await owner.call('POST', `${at()}/runs`, { label: 'Trail run' })).body.run.id;
	await signOff(editor, runId);
	expect((await owner.call('POST', `${at()}/evidence`, { runId, reason: 'the calibrated run' })).status).toBe(201);
	scenarioId = (await owner.call('POST', `${at()}/scenarios`, { name: 'Trail dam', baseRunId: runId, ops: [{ op: 'node.set', nodeId: farm.id, field: 'damCapacityM3', value: 150_000 }] })).body
		.scenario.id;
	scenarioRunId = (await owner.call('POST', `${at()}/scenarios/${scenarioId}/runs`, {})).body.run.id;
	await signOff(editor, scenarioRunId);
	apiKeyId = (await owner.call('POST', `${at()}/api-keys`, { name: 'Trail logger' })).body.key.id;
}, 60_000);

describe('the audit trail is append-only for water_app, whoever it acts as', () => {
	it('keeps every audit-trail table among the live append-only tables (INSERT, but no UPDATE or DELETE)', async () => {
		const live = (
			await asOwner(
				`SELECT c.relname FROM pg_class c
				 WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
				   AND has_table_privilege('water_app', c.oid, 'INSERT')
				   AND NOT has_table_privilege('water_app', c.oid, 'UPDATE')
				   AND NOT has_table_privilege('water_app', c.oid, 'DELETE')
				   AND NOT has_table_privilege('water_app', c.oid, 'TRUNCATE')
				   AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
				                   AND has_column_privilege('water_app', c.oid, a.attnum, 'UPDATE'))`
			)
		).map((r) => r.relname);
		expect(live).toEqual(expect.arrayContaining([...AUDIT_TRAIL]));
	});

	it('has rows in every audit-trail table, and the owner and a viewer read them (positive control)', async () => {
		const fp = await fingerprint();
		for (const t of AUDIT_TRAIL) expect(fp[t]!.n, t).toBeGreaterThan(0);
		for (const u of [owner, viewer]) {
			for (const t of AUDIT_TRAIL) {
				const rows = await withUser(u.id, async (db) => (await db.query(`SELECT 1 FROM ${t} WHERE project_id = $1`, [projectId])).rows);
				expect(rows.length, `${t} as ${u.email}`).toBe(fp[t]!.n);
			}
		}
		const history = await owner.call('GET', `${at()}/history`);
		expect(history.status).toBe(200);
		expect(history.body.items.length).toBeGreaterThan(5);
	});

	it('refuses UPDATE, DELETE and TRUNCATE on every audit-trail table to every actor, and leaves every row as it was', async () => {
		const before = await fingerprint();
		const actors: [string, (fn: (db: Db) => Promise<unknown>) => Promise<unknown>][] = [
			...([
				['owner', owner],
				['team admin', teamAdmin],
				['editor', editor],
				['viewer', viewer],
				['contributor', contributor],
				['farmer', farmer],
				['stranger', stranger]
			] as const).map(([n, u]) => [n, (fn: (db: Db) => Promise<unknown>) => withUser(u.id, fn)] as [string, (fn: (db: Db) => Promise<unknown>) => Promise<unknown>]),
			['API key', (fn) => withApiKey(apiKeyId, fn)],
			['no user', (fn) => withoutUser(fn)]
		];
		const allowed: string[] = [];
		for (const [who, as] of actors) {
			for (const t of AUDIT_TRAIL) {
				for (const sql of [`UPDATE ${t} SET project_id = project_id WHERE project_id = $1`, `DELETE FROM ${t} WHERE project_id = $1`, `TRUNCATE ${t}`]) {
					const params = sql.startsWith('TRUNCATE') ? [] : [projectId];
					const err = await as((db) => db.query(sql, params)).then(
						() => null,
						(e: { code?: string }) => e.code
					);
					if (err !== '42501') allowed.push(`${who}: ${sql.split(' WHERE')[0]} → ${err ?? 'ran'}`);
				}
			}
		}
		expect(allowed).toEqual([]);
		expect(await fingerprint()).toEqual(before);
	});

	it('lets an actor add a history row only as themselves (the INSERT side, positive control)', async () => {
		const add = (u: User, actor: string) =>
			withUser(u.id, (db) => db.query(`INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind) VALUES ($1, $2, 'x', 'member.added')`, [projectId, actor]));
		await expect(add(editor, owner.id)).rejects.toMatchObject({ code: '42501' });
		await expect(add(stranger, stranger.id)).rejects.toMatchObject({ code: '42501' });
		await expect(add(editor, editor.id)).resolves.toMatchObject({ rowCount: 1 });
	});
});

describe('nothing water_app can reach rewrites the trail behind the grants', () => {
	it('leaves water_app owning no audit-trail table, and puts no rule on one', async () => {
		const rows = await asOwner(
			`SELECT c.relname, pg_get_userbyid(c.relowner) AS owner,
				EXISTS (SELECT 1 FROM pg_rewrite r WHERE r.ev_class = c.oid AND r.rulename <> '_RETURN') AS ruled
			 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)`,
			[[...AUDIT_TRAIL]]
		);
		expect(rows).toHaveLength(AUDIT_TRAIL.length);
		for (const r of rows) {
			expect(r.owner, r.relname).not.toBe('water_app');
			expect(r.ruled, r.relname).toBe(false);
		}
	});

	it('lists every function that updates or deletes an audit-trail row, and each is a trigger attached only where listed', async () => {
		const found = await asOwner(
			`SELECT p.proname, p.prorettype = 'trigger'::regtype AS is_trigger,
				coalesce((SELECT array_agg(DISTINCT t.tgrelid::regclass::text) FROM pg_trigger t WHERE t.tgfoid = p.oid), '{}') AS attached
			 FROM pg_proc p
			 WHERE p.pronamespace = 'public'::regnamespace
			   AND p.prosrc ~* ('(UPDATE(\\s+ONLY)?|DELETE\\s+FROM(\\s+ONLY)?|TRUNCATE(\\s+TABLE)?(\\s+ONLY)?|MERGE\\s+INTO)\\s+(public\\.)?(' || array_to_string($1::text[], '|') || ')\\M')`,
			[[...AUDIT_TRAIL]]
		);
		expect(found.map((f) => f.proname).sort()).toEqual(Object.keys(REWRITERS).sort());
		for (const f of found) {
			expect(f.is_trigger, `${f.proname} must be a trigger function, which no one can call`).toBe(true);
			expect(f.attached, f.proname).toEqual([REWRITERS[f.proname]!.on]);
		}
		for (const [name, r] of Object.entries(REWRITERS)) expect(r.why.length, name).toBeGreaterThan(20);
	});
});

describe('a signed-off run stays the run that was signed', () => {
	const runRow = (id: string) =>
		asOwner(`SELECT md5(row(r.project_id, r.created_by, r.created_at, r.label, r.engine_version, r.start_date, r.end_date, r.inputs, r.summary, r.scenario_id, r.trigger)::text) AS md5 FROM model_run r WHERE r.id = $1`, [id]);

	it('can’t be deleted, by the route or in SQL, and its stored inputs and results can’t be rewritten', async () => {
		const before = await runRow(runId);
		const del = await owner.call('DELETE', `${at()}/runs/${runId}`);
		expect(del.status).toBe(409);
		for (const u of [owner, editor]) {
			await expect(withUser(u.id, (db) => db.query('DELETE FROM model_run WHERE id = $1', [runId]))).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|42501)$/) });
			for (const col of ['inputs', 'summary', 'label', 'scenario_id', 'engine_version']) {
				await expect(withUser(u.id, (db) => db.query(`UPDATE model_run SET ${col} = ${col} WHERE id = $1`, [runId])), col).rejects.toMatchObject({ code: '42501' });
			}
		}
		// Positive control: what a run may change (its pin and notes) still changes, and nothing signed moves.
		expect((await owner.call('PATCH', `${at()}/runs/${runId}`, { pinned: true })).status).toBe(200);
		expect(await runRow(runId)).toEqual(before);
	});

	it('keeps a signed scenario run a scenario run: the scenario it came from can’t be deleted', async () => {
		const before = await runRow(scenarioRunId);
		const res = await owner.call('DELETE', `${at()}/scenarios/${scenarioId}`);
		expect(res.status, JSON.stringify(res.body)).toBe(409);
		expect(res.body.error).toMatch(/signed-off run/);
		// And in SQL, past the route: the trigger (072), for the owner and for the editor who signed.
		for (const u of [owner, editor]) {
			await expect(withUser(u.id, (db) => db.query('DELETE FROM scenario WHERE id = $1', [scenarioId]))).rejects.toMatchObject({ code: '23001' });
		}
		expect(await runRow(scenarioRunId)).toEqual(before);
		expect((await owner.call('GET', `${at()}/runs/${scenarioRunId}`)).body.run.scenarioId).toBe(scenarioId);
		// Positive control: a scenario with no signed run is deleted as before.
		const other = (await owner.call('POST', `${at()}/scenarios`, { name: 'Trail unsigned', baseRunId: runId, ops: [] })).body.scenario.id;
		expect((await owner.call('POST', `${at()}/scenarios/${other}/runs`, {})).status).toBe(201);
		expect((await owner.call('DELETE', `${at()}/scenarios/${other}`)).status).toBe(204);
	});

	it('keeps an application whose run an assessor signed off, though its applicant can’t see the sign-off', async () => {
		// Its own project, so the fingerprints above stay the main project's.
		const pid = (await owner.call('POST', '/projects', { name: 'Trail application' })).body.project.id;
		const farm = await runnable(owner, pid);
		const P = `/projects/${pid}`;
		for (const [u, role] of [
			[editor, 'editor'],
			[contributor, 'contributor']
		] as const) {
			expect((await owner.call('POST', `${P}/members`, { email: u.email, role })).status).toBe(201);
		}
		expect((await owner.call('PUT', `${P}/farmers/${contributor.id}`, { nodeIds: [farm.id] })).status).toBe(200);
		const base = (await owner.call('POST', `${P}/runs`, { label: 'Published' })).body.run.id;
		expect((await owner.call('POST', `${P}/publication`, { runId: base })).status).toBe(201);
		const apply = async (name: string) => {
			const res = await contributor.call('POST', `${P}/scenarios`, { name, baseRunId: base, ops: [{ op: 'node.set', nodeId: farm.id, field: 'damCapacityM3', value: 150_000 }] });
			expect(res.status, JSON.stringify(res.body)).toBe(201);
			expect(res.body.scenario.origin).toBe('applicant');
			const run = await contributor.call('POST', `${P}/scenarios/${res.body.scenario.id}/runs`, {});
			expect(run.status, JSON.stringify(run.body)).toBe(201);
			return { sid: res.body.scenario.id as string, run: run.body.run.id as string };
		};
		const signed = await apply('Signed application');
		expect((await contributor.call('POST', `${P}/scenarios/${signed.sid}/submit`)).status).toBe(200);
		// The assessor signs the submitted application's run; the applicant reads no sign-off of it.
		await signOff(editor, signed.run, pid);
		expect(await withUser(contributor.id, async (db) => (await db.query('SELECT 1 FROM signoff WHERE run_id = $1', [signed.run])).rows)).toEqual([]);
		const before = await runRow(signed.run);
		// Withdrawn, then reopened: a delete is tried from each status the route allows.
		expect((await contributor.call('POST', `${P}/scenarios/${signed.sid}/withdraw`)).body.scenario.status).toBe('withdrawn');
		const whileWithdrawn = await contributor.call('DELETE', `${P}/scenarios/${signed.sid}`);
		expect(whileWithdrawn.status, JSON.stringify(whileWithdrawn.body)).toBe(409);
		expect(whileWithdrawn.body.error).toMatch(/signed-off run/);
		expect((await contributor.call('POST', `${P}/scenarios/${signed.sid}/reopen`)).body.scenario.status).toBe('draft');
		const whileDraft = await contributor.call('DELETE', `${P}/scenarios/${signed.sid}`);
		expect(whileDraft.status, JSON.stringify(whileDraft.body)).toBe(409);
		expect(whileDraft.body.error).toMatch(/signed-off run/);
		// The scenario, its run and the run's link to it are all as they were.
		expect(await asOwner('SELECT status FROM scenario WHERE id = $1', [signed.sid])).toEqual([{ status: 'draft' }]);
		expect(await asOwner('SELECT scenario_id FROM model_run WHERE id = $1', [signed.run])).toEqual([{ scenario_id: signed.sid }]);
		expect(await runRow(signed.run)).toEqual(before);
		expect(await asOwner("SELECT 1 FROM audit_event WHERE project_id = $1 AND kind = 'scenario.deleted'", [pid])).toEqual([]);
		// Positive control: an unsigned application is deleted by its applicant, its run with it.
		const unsigned = await apply('Unsigned application');
		expect((await contributor.call('DELETE', `${P}/scenarios/${unsigned.sid}`)).status).toBe(204);
		expect(await asOwner('SELECT 1 FROM scenario WHERE id = $1 UNION ALL SELECT 1 FROM model_run WHERE id = $2', [unsigned.sid, unsigned.run])).toEqual([]);
	});

	it('still lets the owner delete a whole project with a signed scenario run (its sign-offs go with it, 036)', async () => {
		const pid = (await owner.call('POST', '/projects', { name: 'Trail whole' })).body.project.id;
		await runnable(owner, pid);
		const base = (await owner.call('POST', `/projects/${pid}/runs`, { label: 'Base' })).body.run.id;
		const sid = (await owner.call('POST', `/projects/${pid}/scenarios`, { name: 'Whole', baseRunId: base, ops: [] })).body.scenario.id;
		const run = (await owner.call('POST', `/projects/${pid}/scenarios/${sid}/runs`, {})).body.run.id;
		await signOff(owner, run, pid);
		expect((await owner.call('DELETE', `/projects/${pid}`)).status).toBe(204);
		expect(await asOwner('SELECT 1 FROM scenario WHERE project_id = $1 UNION ALL SELECT 1 FROM signoff WHERE project_id = $1', [pid])).toEqual([]);
	});
});
