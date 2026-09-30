// Personal-data completeness, as sweeps over the live schema (docs/security.md
// § Personal information (POPIA)). The classifications already exist:
// catalogue.db.test.ts APP_USER_ON_DELETE says what deleting an account does
// to every foreign key to app_user, and export.ts USER_FK_COVERAGE says which
// of them the data-subject export carries. Those guard the *decision*; these
// check the *outcome* for every entry, so a classification that says
// "exported" or "deleted" can't drift from what the code does:
//
//   1. The export: for every foreign key USER_FK_COVERAGE files under an
//      export section, the section holds exactly the rows the database keys
//      to the person (the fixture must reach each one, so a new sectioned
//      key without a fixture fails too), and every APP_USER_EXPORTED column
//      comes out with the stored value.
//   2. Deletion: after the operator deletes the account, no column of any
//      table (every text, citext, varchar, json, jsonb, uuid and array
//      column in information_schema) still holds the person's email or
//      display name, and their id survives only where the table in
//      docs/security.md says it may. Foreign keys can't see these copies:
//      a name snapshot in a jsonb subject, a recipient id in an array.
//
// Positive controls: the same scan finds the person everywhere before the
// deletion, and still finds the owner (who stays) afterwards.
import { LEGAL_VERSION } from '@water-management/engine/legal';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anon, app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { issueRenderToken } from '../reports/tokens.js';
import { APP_USER_EXPORTED, USER_FK_COVERAGE } from './export.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ORIGIN = 'http://localhost:7777';
const tag = crypto.randomUUID().slice(0, 8);
/** Mixed case, so a case-sensitive match of the name never hits the (lower-cased) email. */
const SUBJECT_NAME = `PdSubject${tag}`;
const OWNER_NAME = `PdOwner${tag}`;
/** What they type when signing a run: a sign-off keeps it (docs/security.md § Liability). */
const TYPED_NAME = `Typed Signer ${tag}`;

/**
 * Where a deleted person may still appear, by needle, with why (docs/security.md
 * § Personal information, "Account deleted" column). Anything else is a leak.
 */
const RETAINED_AFTER_DELETION: Record<'id' | 'email' | 'name' | 'typedName', Record<string, string>> = {
	id: {
		// 048: events about a person keep the random id, which no longer resolves; the name goes.
		'audit_event.subject': 'pseudonymised: the event keeps a random id that resolves to no one, never the name',
		// 101: the daily cap on adding by email counts by the adder's id, not linked to the account.
		'invite_throttle.bucket': 'the daily cap on adding people by email, keyed by the adder’s id; gone when its 24-hour window ends'
	},
	email: {
		// Keyed by the typed address, not the account: a day without attempts forgets it.
		'login_throttle.email': 'sign-in attempts are keyed by the typed address, not linked to the account, gone after a day'
	},
	name: {},
	typedName: {
		'signoff.full_name': 'the signature on a run: the typed name stays, the account is cleared',
		'audit_event.subject': 'signoff.created and calibration_rules.signed_off record the signature as typed, like the sign-off itself',
		// Issue #153: the calibration rules' sign-off is a typed signature too, kept with the rules it signed (their account is only the audit event's actor).
		'project.settings': 'calibrationRules.signedOff: the signature on the calibration rules, as typed; the account is cleared from its audit event',
		'model_revision.changes': 'the settings history of that sign-off: the signature as typed',
		'model_revision.snapshot': 'the settings as they stood after it, sign-off included: the signature as typed',
		'model_run.inputs': 'a run’s settings snapshot, with the rules it ran under: the signature as typed',
		'auto_calibration.rules': 'the rules a run of them ran under, sign-off included: the signature as typed',
		'auto_calibration.plan': 'the same rules, inside the run’s plan: the signature as typed'
	}
};

let db: pg.Client;
let owner: User;
let subject: User;
let farmer: User;
let projectId: string;
let teamId: string;
let runId: string;
const outlet = node('Outlet', null);
const farm = node('Farm Pd', outlet.id);

const call = (u: User, method: string, path: string, body?: unknown) =>
	u.call(method, path, body).then((r) => {
		if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
		return r.body;
	});

/** Every text-like column of every table, from the live catalogue. */
async function scannableColumns(): Promise<{ table: string; column: string }[]> {
	const { rows } = await db.query<{ table: string; column: string }>(
		`SELECT c.table_name AS "table", c.column_name AS "column"
		 FROM information_schema.columns c
		 JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
		 WHERE c.table_schema = 'public'
		   AND (c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb', 'uuid', 'ARRAY') OR c.udt_name = 'citext')
		 ORDER BY 1, 2`
	);
	return rows;
}

/** `table.column` for every column holding `needle` (case-sensitive), across the whole schema. */
async function whereIs(needle: string): Promise<string[]> {
	const hits: string[] = [];
	for (const { table, column } of await scannableColumns()) {
		const { rows } = await db.query(`SELECT 1 FROM "${table}" WHERE position($1 in "${column}"::text) > 0 LIMIT 1`, [needle]);
		if (rows.length) hits.push(`${table}.${column}`);
	}
	return hits;
}

async function download(u: User): Promise<Doc> {
	await asOwner('UPDATE app_user SET data_exported_at = NULL WHERE id = $1', [u.id]);
	const res = await app.request('/auth/me/export', { headers: { cookie: u.cookie, origin: ORIGIN } });
	expect(res.status).toBe(200);
	return (await res.json()) as Doc;
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
const asJson = (v: unknown) => (v instanceof Date ? v.toISOString() : v);

beforeAll(async () => {
	db = new pg.Client({ connectionString: process.env.TEST_MIGRATION_DATABASE_URL });
	await db.connect();
	[owner, subject, farmer] = (await Promise.all([OWNER_NAME, SUBJECT_NAME, `PdFarmer${tag}`].map((n) => signUp(n)))) as [User, User, User];

	// The owner makes what the subject can't (a project, a team and a run are evidence: restrict).
	projectId = (await call(owner, 'POST', '/projects', { name: `Personal data ${tag}` })).project.id;
	await call(owner, 'PUT', `/projects/${projectId}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [], landCover: [] });
	await call(owner, 'PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(300) } });
	await call(owner, 'POST', `/projects/${projectId}/members`, { email: subject.email, role: 'owner' });
	teamId = (await call(owner, 'POST', '/teams', { name: `Team ${tag}` })).team.id;
	await call(owner, 'POST', `/teams/${teamId}/members`, { email: subject.email, role: 'admin' });

	// The subject, a co-owner, touches every kind of record a person can (the "Account deleted" column).
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 12 : 0));
	await call(subject, 'PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-10-01', values: rain });
	await call(subject, 'PATCH', `/projects/${projectId}`, { settings: { lakeEvapFactor: 0.9 } });
	// member.party names them in the log (pseudonymised on deletion, 048).
	await call(owner, 'PATCH', `/projects/${projectId}/members/${subject.id}`, { party: 'WUA' });
	await call(subject, 'POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farm.id] });
	runId = (await call(owner, 'POST', `/projects/${projectId}/runs`, { label: 'r' })).run.id;
	await call(subject, 'PATCH', `/projects/${projectId}/runs/${runId}`, { notes: 'checked' });
	const pub = await call(subject, 'POST', `/projects/${projectId}/publication`, { runId });
	await call(subject, 'PATCH', `/projects/${projectId}/publication/${pub.publication.id}`, { restriction: { level: 'advisory', notice: { en: 'Use water sparingly' } } });
	const key = await call(subject, 'POST', `/projects/${projectId}/api-keys`, { name: 'logger' });
	await call(subject, 'DELETE', `/projects/${projectId}/api-keys/${key.key.id}`);
	const link = await call(subject, 'POST', `/projects/${projectId}/share-links`, { label: 'WUA', expiresInDays: 7 });
	await call(subject, 'DELETE', `/projects/${projectId}/share-links/${link.link.id}`);
	await call(subject, 'POST', `/projects/${projectId}/members`, { email: `pending-${tag}@example.com`, role: 'viewer' });
	const gone = await call(subject, 'POST', `/projects/${projectId}/notes`, { body: `hidden note ${tag}`, nodeId: farm.id, visibility: 'farm' });
	await call(subject, 'DELETE', `/projects/${projectId}/notes/${gone.note.id}`);
	await call(subject, 'POST', `/projects/${projectId}/notes`, { body: `kept note ${tag}`, nodeId: farm.id, visibility: 'farm' });
	const signPath = `/projects/${projectId}/runs/${runId}/signoffs`;
	const { statement, statementSha256 } = await call(subject, 'GET', signPath);
	await call(subject, 'POST', signPath, {
		fullName: TYPED_NAME,
		registrationBody: 'sacnasp',
		registrationCategory: 'pr_sci_nat',
		registrationField: 'water_resources',
		registrationNo: `R-${tag}`,
		scope: 'water balance',
		confirmed: statement.confirmations.map((k: { id: string }) => k.id),
		statementSha256
	});
	await call(subject, 'PUT', `/projects/${projectId}/alert-rules`, { rules: [{ kind: 'dam_below', nodeId: farm.id, threshold: 0.25, enabled: false }] });
	await call(subject, 'PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'dam_below', mode: 'daily_digest' }] });
	await call(subject, 'POST', `/projects/${projectId}/feeds`, { source: 'dws', config: { station: 'X0H000' } });
	await call(subject, 'POST', `/projects/${projectId}/report-schedules`, { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients: [subject.id, owner.id] });
	// A PDF the subject asked for, and one the owner mailed to them.
	await call(subject, 'POST', `/projects/${projectId}/reports`, { email: true });
	await call(owner, 'POST', `/projects/${projectId}/reports`, { email: [subject.id] });
	// A second session, signed out (revoked_session, 102).
	const second = (await anon('POST', '/auth/login', { email: subject.email, password: 'correct horse' })).headers.get('set-cookie')!.split(';')[0]!;
	expect((await anon('POST', '/auth/logout', undefined, second)).status).toBe(204);
	// A mistyped password (login_throttle, keyed by the address).
	expect((await anon('POST', '/auth/login', { email: subject.email, password: 'wrong horse' })).status).toBe(401);
	// An alert mail sent to them, and a suppressed address (057): as the schema owner, the pipeline isn't under test.
	const [rule] = await asOwner(`SELECT id FROM alert_rule WHERE project_id = $1 LIMIT 1`, [projectId]);
	const [event] = await asOwner(`INSERT INTO alert_event (rule_id, project_id, state, value, detail) VALUES ($1, $2, 'cleared', 0.2, '{}') RETURNING id`, [rule.id, projectId]);
	await asOwner(`INSERT INTO alert_delivery (event_id, user_id, project_id, mode, status, via, sent_at) VALUES ($1, $2, $3, 'immediate', 'sent', 'immediate', now())`, [
		event.id,
		subject.id,
		projectId
	]);
	// A series replaced (a revision), a reset link, a render token, an allocation import.
	await call(subject, 'PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-10-01', values: rain.map((v) => v + 1) });
	expect((await anon('POST', '/auth/forgot-password', { email: subject.email })).status).toBe(202);
	await withUser(subject.id, (tx) => issueRenderToken(tx, projectId, runId));
	await call(subject, 'POST', `/projects/${projectId}/allocations/import/commit`, {
		kind: 'csv',
		fileName: 'pd.csv',
		text: 'registration_no,farm,authorisation,water_source,volume_m3_year\nPD-1,Farm Pd,licence,surface,500\n'
	});
	// An application, decided by the subject.
	const [applicant, consultant] = (await Promise.all([`PdApplicant${tag}`, `PdConsultant${tag}`].map((n) => signUp(n)))) as [User, User];
	for (const u of [applicant, consultant]) {
		await call(owner, 'POST', `/projects/${projectId}/members`, { email: u.email, role: 'contributor' });
		await call(owner, 'PATCH', `/projects/${projectId}/members/${u.id}`, { party: 'Pd Consulting' });
	}
	const sid = (await call(applicant, 'POST', `/projects/${projectId}/scenarios`, { name: 'Raise the weir', baseRunId: runId, ops: [] })).scenario.id;
	await call(applicant, 'POST', `/projects/${projectId}/scenarios/${sid}/submit`);
	// Only the applicant shares an application, and an application's owner blocks their deletion (restrict), so the
	// share the subject made is arranged as the schema owner: the foreign key's SET NULL is what's under test.
	await asOwner('INSERT INTO scenario_member (scenario_id, project_id, user_id) VALUES ($1, $2, $3)', [sid, projectId, consultant.id]);
	await asOwner('UPDATE scenario_member SET added_by = $2 WHERE scenario_id = $1', [sid, subject.id]);
	// A comment on the application, then edited by them (113): the text before the edit is a note_revision (edited_by).
	const comment = await call(subject, 'POST', `/projects/${projectId}/notes`, { body: `application comment ${tag}`, scenarioId: sid });
	await call(subject, 'PATCH', `/projects/${projectId}/notes/${comment.note.id}`, { body: `application comment ${tag}, edited` });
	await call(subject, 'POST', `/projects/${projectId}/scenarios/${sid}/decide`, { outcome: 'refused', note: 'Too little left in dry years.' });
	// A sweep, an outlook and a yield result they asked for; the workers aren't under test.
	// The rows as the subject makes them (their stamp triggers set created_by), without the jobs.
	await withUser(subject.id, async (tx) => {
		await tx.query(`INSERT INTO scenario_sweep (project_id, base_run_id, name) VALUES ($1, $2, 'pd sweep')`, [projectId, runId]);
		const [o] = (
			await tx.query(
				`INSERT INTO seasonal_outlook (project_id, base_run_id, name, decision_date, season_end, levels)
				 VALUES ($1, $2, 'pd outlook', '2023-01-01', '2023-06-30', '[{"id": "0", "label": "85 %", "ops": []}]') RETURNING id`,
				[projectId, runId]
			)
		).rows;
		// Completed and published to farmers, then withdrawn, by them (106): published_by and ended_by.
		await tx.query(`UPDATE seasonal_outlook SET status = 'complete', result = '{}', engine_version = 'x' WHERE id = $1`, [o.id]);
		await tx.query(`INSERT INTO outlook_publication (project_id, outlook_id, level_id, level_label, decision_date, season_end, engine_version) VALUES ($1, $2, '0', 'x', '2023-01-01', '2023-06-30', 'x')`, [projectId, o.id]);
		await tx.query(`UPDATE outlook_publication SET ended_at = now() WHERE project_id = $1`, [projectId]);
	});
	await withUser(subject.id, (tx) =>
		tx.query(
			`INSERT INTO yield_result (project_id, run_id, node_id, kind, params, points, engine_version)
			 VALUES ($1, $2, $3, 'firm', '{}', '{}', '1.0.0')`,
			[projectId, runId, farm.id]
		)
	);
	// The calibration rules signed off by them, as a typed signature (issue #153), and a run of the rules they asked for
	// and whose fit they applied (108): created_by and applied_by. Planted as they make it, without its jobs.
	const rules = (await call(subject, 'GET', `/projects/${projectId}`)).project.settings.calibrationRules;
	await call(subject, 'PATCH', `/projects/${projectId}`, { settings: { calibrationRules: { ...rules, signedOff: { by: TYPED_NAME, on: '2026-09-29' } } } });
	await withUser(subject.id, async (tx) => {
		const plan = { rules, engineVersion: 'x', flowKind: 'flow_observed_m3s', validationRecord: null, years: [], ruleExclusions: [], cases: [], notes: [], caseEvaluations: 0 };
		const [a] = (
			await tx.query(
				`INSERT INTO auto_calibration (project_id, "trigger", rules, rules_revision, input_sha256, plan, engine_version)
				 VALUES ($1, 'manual', $2, 1, $3, $4, 'x') RETURNING id`,
				[projectId, JSON.stringify(rules), '0'.repeat(64), JSON.stringify(plan)]
			)
		).rows;
		await tx.query(`UPDATE auto_calibration SET status = 'complete', report = '{"chosen": 0, "notes": [], "eligible": [], "reasons": []}', chosen = 0 WHERE id = $1`, [a.id]);
		await tx.query('UPDATE auto_calibration SET applied_at = now() WHERE id = $1', [a.id]);
	});
	// Their own display preferences (083): the sections they hid.
	await call(subject, 'PATCH', '/auth/me', { preferences: { hiddenTabs: ['crops'] } });
	await asOwner(`UPDATE app_user SET mail_suppressed_at = now(), mail_suppressed_reason = 'bounce', mail_resumed_at = now(), locale = 'af' WHERE id = $1`, [subject.id]);
}, 120_000);

afterAll(async () => {
	// The queued report, feed and alert jobs this file made: no other file's tick should pick them up.
	if (projectId) await asOwner('DELETE FROM job WHERE project_id = $1', [projectId]);
	await db?.end();
});

describe('the data-subject export carries every row USER_FK_COVERAGE files under a section', () => {
	let doc: Doc;
	beforeAll(async () => {
		doc = await download(subject);
	});

	const sectioned = Object.entries(USER_FK_COVERAGE).filter((e): e is [string, { section: string }] => 'section' in e[1]);

	it('has sections to check (the guard below must see something)', () => {
		expect(sectioned.map(([fk]) => fk)).toEqual(expect.arrayContaining(['note.author_id', 'signoff.user_id', 'project_member.user_id']));
	});

	it.each(sectioned)('%s → %o', async (fk, { section }) => {
		const [table, column] = fk.split('.') as [string, string];
		const { rows } = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = $1`, [subject.id]);
		const stored = rows[0]!.n;
		// The fixture reaches every sectioned key, so an empty section can't pass for a complete one.
		expect(stored, `the fixture writes no ${table} row for the subject: add one`).toBeGreaterThan(0);
		expect(Array.isArray(doc[section]), `export has no "${section}" array`).toBe(true);
		// The audit section also carries the events *about* them (subject.userId); a note's revisions are inside it (only its
		// author edits a note, 113); every other section is exactly their rows.
		if (fk === 'audit_event.actor_user_id') expect(doc[section].length).toBeGreaterThanOrEqual(stored);
		else if (fk === 'note_revision.edited_by') expect(doc[section].flatMap((n: { revisions: unknown[] }) => n.revisions)).toHaveLength(stored);
		else expect(doc[section]).toHaveLength(stored);
	});

	it('gives every APP_USER_EXPORTED column, with the value stored', async () => {
		const { rows } = await db.query(`SELECT ${APP_USER_EXPORTED.map((c) => `"${c}"`).join(', ')} FROM app_user WHERE id = $1`, [subject.id]);
		const stored = rows[0] as Record<string, unknown>;
		const expected = Object.fromEntries(APP_USER_EXPORTED.map((c) => [c === 'display_name' ? 'displayName' : camel(c), asJson(stored[c])]));
		// data_exported_at is stamped by the download itself.
		expect({ ...doc.account, dataExportedAt: expected.dataExportedAt }).toEqual(expected);
		// Positive control on the fixture: the columns 057, 050 and 087 added carry real values here.
		expect(doc.account).toMatchObject({ locale: 'af', mailSuppressedReason: 'bounce', termsVersion: LEGAL_VERSION, termsAcceptedAt: expect.any(String) });
	});
});

// 066 lets the foreign key's SET NULL through three guards; nobody else gets to clear who made a row.
describe('while the account exists, only its deletion clears who made a row (066)', () => {
	it('keeps an alert rule’s creator when an editor tries to clear it', async () => {
		await withUser(owner.id, (tx) => tx.query('UPDATE alert_rule SET created_by = NULL WHERE project_id = $1', [projectId]));
		expect(await asOwner('SELECT created_by FROM alert_rule WHERE project_id = $1', [projectId])).toEqual([{ created_by: subject.id }]);
	});

	it('refuses water_app a change to who asked for a sweep or an outlook', async () => {
		for (const table of ['scenario_sweep', 'seasonal_outlook']) {
			await expect(withUser(owner.id, (tx) => tx.query(`UPDATE ${table} SET created_by = NULL WHERE project_id = $1`, [projectId]))).rejects.toMatchObject({
				code: '42501'
			});
			expect(await asOwner(`SELECT created_by FROM ${table} WHERE project_id = $1`, [projectId])).toEqual([{ created_by: subject.id }]);
		}
	});

	it('refuses the schema owner any other change to a sweep in the same update', async () => {
		await expect(asOwner(`UPDATE scenario_sweep SET created_by = NULL, name = 'renamed' WHERE project_id = $1`, [projectId])).rejects.toMatchObject({
			code: '42501'
		});
	});
});

describe('deleting the account leaves no copy of the person outside the documented places', () => {
	const needles = () => ({ id: subject.id, email: subject.email, name: SUBJECT_NAME, typedName: TYPED_NAME });
	let before: Record<string, string[]>;

	let unreached: string[];

	beforeAll(async () => {
		// Every key deletion acts on (restrict keys block it, so the subject holds none: evidence stays with its maker).
		const { rows: keys } = await db.query<{ tbl: string; col: string }>(
			`SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
			 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
			 WHERE c.contype = 'f' AND c.confrelid = 'app_user'::regclass AND c.confdeltype IN ('c', 'n') ORDER BY 1, 2`
		);
		unreached = [];
		for (const { tbl, col } of keys) {
			const { rows } = await db.query(`SELECT 1 FROM ${tbl} WHERE "${col}" = $1 LIMIT 1`, [subject.id]);
			if (!rows.length) unreached.push(`${tbl}.${col}`);
		}
		before = {};
		for (const [k, v] of Object.entries(needles())) before[k] = await whereIs(v);
		await asOwner('DELETE FROM app_user WHERE id = $1', [subject.id]);
	});

	it('had a row behind every cascade and set-null key to app_user before the deletion (the fixture reaches each)', () => {
		expect(unreached).toEqual([]);
	});

	it('finds the person across the schema before the deletion (positive control on the scan)', () => {
		expect(before.id).toEqual(expect.arrayContaining(['app_user.id', 'audit_event.subject', 'report.email_to', 'job.acting_user_id']));
		expect(before.email).toEqual(expect.arrayContaining(['app_user.email', 'login_throttle.email']));
		expect(before.name).toEqual(expect.arrayContaining(['app_user.display_name', 'audit_event.actor_label', 'audit_event.subject']));
		expect(before.typedName).toEqual(expect.arrayContaining(['signoff.full_name']));
	});

	it.each(Object.keys(RETAINED_AFTER_DELETION) as (keyof typeof RETAINED_AFTER_DELETION)[])('the %s survives only where docs/security.md keeps it', async (k) => {
		const left = await whereIs(needles()[k]);
		expect(left.filter((col) => !(col in RETAINED_AFTER_DELETION[k]))).toEqual([]);
	});

	it('still finds the owner, who stays (positive control)', async () => {
		expect(await whereIs(OWNER_NAME)).toEqual(expect.arrayContaining(['app_user.display_name', 'audit_event.actor_label']));
		expect(await whereIs(owner.id)).toEqual(expect.arrayContaining(['app_user.id', 'project_member.user_id', 'report_schedule_recipient.user_id']));
	});
});
