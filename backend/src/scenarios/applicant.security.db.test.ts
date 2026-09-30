// A licence applicant (the contributor role, 044/045, WP-3.3) against every
// project table and every route they may call, with a second applicant (B)
// and their consultant present (docs/security.md § Applicants). Swept from
// live inventories, not a hand-written list:
//
//  - reads: every public table with a project_id (pg_catalog). What A reads
//    of each must be a subset of what READ says an applicant may read (their
//    own farm's rows, their own applications and runs, the catchment series
//    of the published run); a table READ doesn't name must read as empty.
//  - writes: the same tables, UPDATE and DELETE of every project row, and an
//    INSERT of a copy (fresh id) of a row A can't read, each inside a
//    savepoint that is rolled back. A may change only what CHANGE lists
//    (their own applications, notes, runs, and leaving the project) and
//    insert nothing they can't read (KNOWN_INSERTS would name a known
//    exception; there is none).
//  - routes: every /projects/:id route an applicant may call (the
//    CONTRIBUTOR_ALLOWED list of applications.db.test.ts, taken here from the
//    app's routes and the role ladder) with B's application, B's farm and
//    B's note: never a 2xx, never B's names, and B's rows unchanged.
//
// Positive controls (CLAUDE.md rule 5): A reads a row of every table READ
// names; A reads, edits and runs their own application through the same
// routes; a viewer or the owner reads the rows A is refused.
// applications.db.test.ts, contributor-tables.db.test.ts and
// oracles.db.test.ts keep the finer rules (the key allowlists, submission,
// the oracles); this file is the "nothing else" sweep.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { seriesHash } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User, viewer: User, applicantA: User, applicantB: User, consultantB: User, consultantA: User, farmer: User;
let projectId: string;
let published: string;
let appA: string;
let appB: string;
let teamScenario: string;
let noteA: string;
let noteB: string;
const outlet = node('Gauge', null);
const rooikloof = node('Rooikloof', outlet.id); // A's farm
const kalkoenkrans = node('Kalkoenkrans', outlet.id); // B's farm
const bergvliet = node('Bergvliet', outlet.id); // a farmer's
const doornhoek = node('Doornhoek', outlet.id); // nobody's, until A moves to it
const crop = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
const P = () => `/projects/${projectId}`;
const levels = (key: 'name' | 'label') => [1, 0.85].map((f) => ({ [key]: `${f * 100} %`, ops: [{ op: 'demand.scale', factor: f }] }));

// Owner-side SQL fragments: $1 is the project, $2 applicant A.
const OWN_NODES = `(SELECT node_id FROM farm_link WHERE project_id = $1 AND user_id = $2)`;
const OWN_APPS = `(SELECT id FROM scenario WHERE project_id = $1 AND owner_user_id = $2 UNION SELECT scenario_id FROM scenario_member WHERE user_id = $2)`;
const OWN_RUNS = `(SELECT id FROM model_run WHERE project_id = $1 AND scenario_id IN ${OWN_APPS})`;
const PUBLISHED_RUNS = `(SELECT run_id FROM run_publication WHERE project_id = $1)`;

/** What an applicant may read of each table, as a WHERE over its rows (owner side); every other table reads empty. */
const READ: Record<string, string> = {
	alert_event: `node_id IN ${OWN_NODES}`,
	alert_rule: `node_id IN ${OWN_NODES}`,
	allocation: `node_id IN ${OWN_NODES}`,
	allocation_holder: `allocation_id IN (SELECT id FROM allocation WHERE node_id IN ${OWN_NODES})`,
	borehole: `node_id IN ${OWN_NODES}`,
	crop: `id IN (SELECT crop_id FROM crop_area WHERE node_id IN ${OWN_NODES})`,
	crop_area: `node_id IN ${OWN_NODES}`,
	farm_link: `user_id = $2`,
	land_cover: `node_id IN ${OWN_NODES}`,
	// Their own farm, and the gauges (public infrastructure, as a farmer sees them).
	node: `id IN ${OWN_NODES} OR kind = 'gauge'`,
	// Their own notes, and the farm-visible notes on their own farm.
	note: `author_id = $2 OR (visibility = 'farm' AND node_id IN ${OWN_NODES})`,
	project_member: `user_id = $2`,
	publication_farm: `node_id IN ${OWN_NODES}`,
	// Which run is published, and when (every member reads it).
	run_publication: `true`,
	// Their own applications' runs, and of a published run the catchment and
	// their own farm's series (the key allowlists: applications.db.test.ts).
	run_series: `run_id IN ${OWN_RUNS} OR (run_id IN ${PUBLISHED_RUNS} AND (node_id IS NULL OR node_id IN ${OWN_NODES}))`,
	scenario: `id IN ${OWN_APPS}`,
	scenario_member: `scenario_id IN ${OWN_APPS}`,
	transfer: `from_node_id IN ${OWN_NODES} OR to_node_id IN ${OWN_NODES}`
};

/** What an applicant may UPDATE or DELETE, by table (owner side). */
const CHANGE: Record<string, { update?: string; delete?: string }> = {
	// Their own application (the route adds the status rules).
	scenario: { update: `owner_user_id = $2`, delete: `owner_user_id = $2` },
	scenario_member: { delete: `scenario_id IN (SELECT id FROM scenario WHERE owner_user_id = $2) OR user_id = $2` },
	// Their own notes (note_guard keeps the body to its author).
	note: { update: `author_id = $2`, delete: `author_id = $2` },
	// Leaving the project.
	project_member: { delete: `user_id = $2` }
};

/**
 * Inserts RLS lets an applicant make that aren't theirs to read. Each is a
 * known gap with its follow-up; a new one fails the sweep.
 */
const KNOWN_INSERTS: Record<string, string> = {
	// None. series_blob was one (045's series_blob_insert_contributor admitted
	// any blob, its hash unchecked) until 074_series_blob_digest made the
	// database key each blob itself.
};

/**
 * A copied row the database turned into the applicant's own (scenario_guard
 * sets owner and origin; 071 keeps its own nodes to their farm links): what
 * the insert sweep accepts, checked on the row as written.
 */
const INSERT_OWN: Record<string, (row: Record<string, unknown>) => boolean> = {
	scenario: (r) => r.owner_user_id === applicantA.id && r.origin === 'applicant' && (r.owned_node_ids as string[]).every((n) => n === rooikloof.id)
};

type Row = { k: string };
const code = (e: unknown) => (e as { code?: string }).code ?? '?';

let tables: { t: string; key: string }[] = [];

/** The primary-key columns of `t` as a jsonb expression (run_series has none: its natural key). */
async function keyExpr(t: string) {
	const cols = (
		await asOwner(
			`SELECT a.attname AS c FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
			 WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY a.attnum`,
			[t]
		)
	).map((r: { c: string }) => r.c as string);
	const key = cols.length ? cols : ['run_id', 'node_id', 'key'];
	return `jsonb_build_array(${key.map((c) => `x."${c}"`).join(', ')})::text`;
}

async function ownerKeys(t: string, key: string, where: string) {
	const sql = `SELECT ${key} AS k FROM "${t}" x WHERE x.project_id = $1 AND $2::uuid IS NOT NULL AND (${where})`;
	return new Set((await asOwner(sql, [projectId, applicantA.id])).map((r: Row) => r.k));
}

// The sweep, outlook, yield and alert jobs the write probes queued: no later file's tick should claim them (db-setup.ts).
afterAll(() => retirePendingJobs(projectId));

beforeAll(async () => {
	let editor: User;
	[owner, editor, viewer, applicantA, applicantB, consultantB, consultantA, farmer] = (await Promise.all(
		['Sowner', 'Seditor', 'Sviewer', 'Sapplicanta', 'Sapplicantb', 'Sconsultantb', 'Sconsultanta', 'Sfarmer'].map((n) => signUp(n))
	)) as User[] as [User, User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Applicant sweep' })).body.project.id;
	const farms = [rooikloof, kalkoenkrans, bergvliet];
	const transfer = (from: string, to: string) => ({ id: crypto.randomUUID(), fromNodeId: from, toNodeId: to, months: [1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 });
	const model = {
		nodes: [outlet, ...farms, doornhoek],
		crops: [crop],
		cropAreas: farms.map((f) => ({ nodeId: f.id, cropId: crop.id, areaM2: 40_000 })),
		transfers: [transfer(kalkoenkrans.id, bergvliet.id), transfer(rooikloof.id, bergvliet.id)],
		landCover: farms.map((f) => ({ id: crypto.randomUUID(), nodeId: f.id, coverClass: 'pine', areaKm2: 1, densityPct: 0.5, factors: null })),
		boreholes: farms.map((f) => ({ id: crypto.randomUUID(), nodeId: f.id, name: `BH ${f.name}`, capacityM3Day: 100, annualCapM3: null }))
	};
	const put = await owner.call('PUT', `${P()}/model`, model);
	expect(put.status, JSON.stringify(put.body)).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	for (const values of [rain, rain.map((v) => v + 1)])
		expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values })).status).toBe(200);
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2021-10-01', values: rain.map((v) => 0.1 + v / 100) })).status).toBe(200);
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	expect((await owner.call('POST', `${P()}/runs`, { label: 'Unpublished' })).status).toBe(201);
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer'],
		[applicantA, 'contributor'],
		[applicantB, 'contributor'],
		[consultantB, 'contributor'],
		[consultantA, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
	expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: [bergvliet.id] })).status).toBe(201);
	// A farmer invite still pending (invite, invite_node).
	expect((await owner.call('POST', `${P()}/farmers`, { email: `pending-${crypto.randomUUID()}@example.com`, nodeIds: [kalkoenkrans.id] })).status).toBeLessThan(300);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantA.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantB.id}`, { nodeIds: [kalkoenkrans.id] })).status).toBe(200);
	for (const u of [applicantB, consultantB]) expect((await owner.call('PATCH', `${P()}/members/${u.id}`, { party: 'Kalkoenkrans Boerdery' })).status).toBe(200);
	for (const u of [applicantA, consultantA]) expect((await owner.call('PATCH', `${P()}/members/${u.id}`, { party: 'Rooikloof Trust' })).status).toBe(200);
	for (const n of farms)
		expect((await owner.call('POST', `${P()}/allocations`, { nodeId: n.id, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: 1000, holder: `${n.name} holder` })).status).toBe(201);
	const csv = 'registration_no,farm,authorisation,water_source,volume_m3_year\nS-1,Kalkoenkrans,licence,surface,500\n';
	expect((await owner.call('POST', `${P()}/allocations/import/commit`, { kind: 'csv', fileName: 's.csv', text: csv })).status).toBe(201);
	const made = async (path: string, body: unknown) => {
		const r = await owner.call('POST', `${P()}${path}`, body);
		expect(r.status, `${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
		return r.body;
	};
	await made('/feeds', { source: 'dws', config: { station: 'X0H000' } });
	await made('/report-schedules', { frequency: 'weekly', weekday: 1, hour: 7, timezone: 'UTC', recipients: [owner.id] });
	await made('/share-links', { label: 'Link', expiresInDays: 7 });
	await made('/api-keys', { name: 'Key' });
	await made('/members', { email: `invitee-${crypto.randomUUID()}@example.com`, role: 'viewer' });
	await made('/notes', { body: 'Team note' });
	await made('/notes', { body: 'Run note', runId: published });
	for (const n of farms) await made('/notes', { body: `Farm note ${n.name}`, nodeId: n.id, visibility: 'farm' });
	await made('/yield', { nodeId: rooikloof.id, runId: published, kind: 'firm' });
	await made('/evidence', { runId: published, reason: 'the calibrated run' });
	await made('/sweeps', { name: 'Sweep', baseRunId: published, members: levels('name') });
	await made('/outlooks', { name: 'Outlook', baseRunId: published, levels: levels('label') });
	teamScenario = (await made('/scenarios', { name: 'Team idea', baseRunId: published, ops: [] })).scenario.id;
	await made(`/runs/${published}/uncertainty`, { request: { members: 30, thresholds: { minSkill: -10, maxLowFlowBiasPct: null, wr2012MaxLevel: 'unusable' } } });
	// Rows no API call here makes without a worker: a sign-off, a yield result, alert events.
	await asOwner(
		`INSERT INTO signoff (project_id, run_id, user_id, full_name, registration_body, registration_no, scope, statement_version, statement_sha256, disclaimer_version)
		 VALUES ($1, $2, $3, 'S Signer', 'SACNASP', '1', 'the hydrology', 'signoff-1', $4, 'd-1')`,
		[projectId, published, owner.id, 'a'.repeat(64)]
	);
	for (const n of farms)
		await asOwner(
			`INSERT INTO yield_result (project_id, run_id, node_id, kind, params, points, engine_version) VALUES ($1, $2, $3, 'firm', '{}', '{}', '0.36.0')`,
			[projectId, published, n.id]
		);
	const rules = await owner.call('PUT', `${P()}/alert-rules`, { rules: farms.map((f) => ({ kind: 'dam_below', nodeId: f.id, threshold: 0.25, enabled: true })) });
	expect(rules.status, JSON.stringify(rules.body)).toBe(200);
	for (const r of await asOwner('SELECT id, node_id FROM alert_rule WHERE project_id = $1', [projectId]))
		await asOwner(`INSERT INTO alert_event (project_id, rule_id, kind, node_id, state, value, detail) VALUES ($1, $2, 'dam_below', $3, 'firing', 0.1, '{}')`, [projectId, r.id, r.node_id]);
	expect((await viewer.call('PUT', `/me/alerts/${projectId}`, { items: [{ kind: 'all', mode: 'immediate' }] })).status).toBe(200);
	// B's application: run, shared with B's consultant, and a note on B's farm.
	const b = await applicantB.call('POST', `${P()}/scenarios`, { name: 'B plan', baseRunId: published, ops: [] });
	expect(b.status, JSON.stringify(b.body)).toBe(201);
	appB = b.body.scenario.id;
	expect((await applicantB.call('POST', `${P()}/scenarios/${appB}/runs`, {})).status).toBe(201);
	expect((await applicantB.call('POST', `${P()}/scenarios/${appB}/members`, { userId: consultantB.id })).status).toBe(201);
	noteB = (await applicantB.call('POST', `${P()}/notes`, { body: 'B note', nodeId: kalkoenkrans.id })).body.note.id;
	// A's own.
	const a = await applicantA.call('POST', `${P()}/scenarios`, { name: 'A plan', baseRunId: published, ops: [] });
	expect(a.status, JSON.stringify(a.body)).toBe(201);
	appA = a.body.scenario.id;
	expect((await applicantA.call('POST', `${P()}/scenarios/${appA}/members`, { userId: consultantA.id })).status).toBe(201);
	expect((await applicantA.call('POST', `${P()}/scenarios/${appA}/runs`, {})).status).toBe(201);
	noteA = (await applicantA.call('POST', `${P()}/notes`, { body: 'A note', nodeId: rooikloof.id })).body.note.id;

	const scoped = await asOwner(
		`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
		   AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'project_id' AND NOT a.attisdropped)
		 ORDER BY 1`
	);
	tables = await Promise.all(scoped.map(async ({ t }: { t: string }) => ({ t, key: await keyExpr(t) })));
}, 180_000);

describe('the inventory', () => {
	it('sweeps every project table, most of them holding rows of this project (not vacuous)', async () => {
		expect(tables.length).toBeGreaterThan(40);
		const filled = [];
		for (const { t } of tables) if ((await asOwner(`SELECT 1 FROM "${t}" WHERE project_id = $1 LIMIT 1`, [projectId])).length) filled.push(t);
		expect(filled.length).toBeGreaterThan(38);
		// Everything READ, CHANGE and KNOWN_INSERTS name still exists.
		for (const t of [...Object.keys(READ), ...Object.keys(CHANGE), ...Object.keys(KNOWN_INSERTS)]) expect(tables.map((x) => x.t), t).toContain(t);
	});
});

describe('what an applicant reads, table by table', () => {
	it('reads nothing outside READ, and something of every table READ names (positive control)', async () => {
		const wrong: string[] = [];
		for (const { t, key } of tables) {
			const seen = await withUser(applicantA.id, async (db) => (await db.query<Row>(`SELECT ${key} AS k FROM "${t}" x WHERE x.project_id = $1`, [projectId])).rows.map((r) => r.k));
			const allowed = await ownerKeys(t, key, READ[t] ?? 'false');
			const extra = seen.filter((k) => !allowed.has(k));
			if (extra.length) wrong.push(`${t}: ${extra.length} row(s) outside READ, e.g. ${extra[0]}`);
			if (READ[t] && seen.length === 0) wrong.push(`${t}: reads none of their own rows (positive control)`);
		}
		expect(wrong).toEqual([]);
	});

	it("reads none of B's application, its run, its members or B's note; B and B's consultant do (positive control)", async () => {
		const probe = async (u: User) =>
			withUser(u.id, async (db) => ({
				scenario: (await db.query('SELECT 1 FROM scenario WHERE id = $1', [appB])).rowCount,
				member: (await db.query('SELECT 1 FROM scenario_member WHERE scenario_id = $1', [appB])).rowCount,
				runSeries: (await db.query('SELECT 1 FROM run_series WHERE run_id IN (SELECT id FROM app_scenario_run_meta($1, $2))', [projectId, appB])).rowCount,
				runMeta: (await db.query('SELECT 1 FROM app_scenario_run_meta($1, $2)', [projectId, appB])).rowCount,
				note: (await db.query('SELECT 1 FROM note WHERE id = $1', [noteB])).rowCount
			}));
		expect(await probe(applicantA)).toEqual({ scenario: 0, member: 0, runSeries: 0, runMeta: 0, note: 0 });
		const b = await probe(applicantB);
		expect(b).toMatchObject({ scenario: 1, member: 1, runMeta: 1, note: 1 });
		expect(b.runSeries).toBeGreaterThan(0);
		expect((await probe(consultantB)).scenario).toBe(1);
	});

	it('is refused what a viewer reads: every table outside READ with rows here reads non-empty to a viewer or the owner', async () => {
		// The control for the "reads empty" half: those tables do hold rows a
		// member can read, so an applicant's empty answer is RLS, not an empty table.
		const empty: string[] = [];
		for (const { t } of tables.filter(({ t }) => !READ[t])) {
			const total = (await asOwner(`SELECT count(*)::int AS n FROM "${t}" WHERE project_id = $1`, [projectId]))[0].n as number;
			if (total === 0) continue;
			let n = 0;
			for (const u of [viewer, owner]) n = Math.max(n, await withUser(u.id, async (db) => (await db.query(`SELECT 1 FROM "${t}" WHERE project_id = $1`, [projectId])).rowCount ?? 0));
			if (n === 0) empty.push(t);
		}
		expect(empty).toEqual([]);
	});
});

describe('what an applicant writes, table by table', () => {
	/** Run `sql` as A inside a savepoint and roll it back: the keys it touched, or the error code. */
	async function attempt(sql: string, params: unknown[]) {
		return withUser(applicantA.id, async (db) => {
			await db.query('SAVEPOINT s');
			try {
				return { keys: (await db.query<Row>(sql, params)).rows.map((r) => r.k), error: null as string | null };
			} catch (e) {
				return { keys: [] as string[], error: code(e) };
			} finally {
				await db.query('ROLLBACK TO SAVEPOINT s');
			}
		});
	}

	it('updates and deletes only what CHANGE lists (their own application, notes and runs, and leaving)', async () => {
		const wrong: string[] = [];
		const changed: string[] = [];
		for (const { t, key } of tables) {
			for (const verb of ['update', 'delete'] as const) {
				const sql =
					verb === 'update'
						? `UPDATE "${t}" x SET project_id = x.project_id WHERE x.project_id = $1 RETURNING ${key} AS k`
						: `DELETE FROM "${t}" x WHERE x.project_id = $1 RETURNING ${key} AS k`;
				const { keys } = await attempt(sql, [projectId]);
				const allowed = await ownerKeys(t, key, CHANGE[t]?.[verb] ?? 'false');
				const extra = keys.filter((k) => !allowed.has(k));
				if (extra.length) wrong.push(`${verb} ${t}: ${extra.length} row(s) not theirs, e.g. ${extra[0]}`);
				if (keys.length) changed.push(`${verb} ${t}`);
			}
		}
		expect(wrong).toEqual([]);
		// Positive control: the sweep does reach what they may change.
		expect(changed).toEqual(expect.arrayContaining(['update scenario', 'delete scenario', 'delete project_member', 'delete scenario_member']));
	});

	it('inserts no copy of a row they cannot read, in any table but KNOWN_INSERTS', async () => {
		const wrong: string[] = [];
		const refused: string[] = [];
		for (const { t, key } of tables) {
			// A row of this project A can't read (else any row: A must still not copy it).
			const visible = await withUser(applicantA.id, async (db) => (await db.query<Row>(`SELECT ${key} AS k FROM "${t}" x WHERE x.project_id = $1`, [projectId])).rows.map((r) => r.k));
			const rows = await asOwner(`SELECT ${key} AS k, to_jsonb(x) AS j FROM "${t}" x WHERE x.project_id = $1`, [projectId]);
			// Someone else's row first (A may make runs of their own application,
			// which they can't read either), and B's application for scenario: its
			// copy claims B's farm as A's own.
			const rank = (r: { j: { id?: string } }) => (r.j.id === appB ? 0 : JSON.stringify(r.j).includes(applicantA.id) ? 2 : 1);
			const hidden = rows.filter((r: { k: string }) => !visible.includes(r.k)).sort((x: { j: { id?: string } }, y: { j: { id?: string } }) => rank(x) - rank(y));
			const sample = hidden[0] ?? (READ[t] || CHANGE[t] ? undefined : rows[0]);
			if (!sample) continue;
			const cols = await asOwner(
				`SELECT column_name AS c, data_type AS dt, column_default AS d, is_identity AS i, is_generated AS g
				 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
				[t]
			);
			const j = sample.j as Record<string, unknown>;
			const keep = cols.filter((c: { i: string; g: string; d: string | null }) => c.i !== 'YES' && c.g !== 'ALWAYS' && !(c.d ?? '').startsWith('nextval')).map((c: { c: string }) => c.c);
			if (keep.includes('id') && cols.find((c: { c: string }) => c.c === 'id')!.dt === 'uuid') j.id = crypto.randomUUID();
			// A fresh content key too, so the copy can't just collide with the original.
			if (t === 'series_blob') j.sha256 = crypto.randomUUID().replace(/-/g, '').padEnd(64, '0');
			const list = keep.map((c: string) => `"${c}"`).join(', ');
			// No RETURNING: it would need the new row to pass a SELECT policy too,
			// and so answer 42501 for an insert RLS let through into a row A can't read.
			const r = await withUser(applicantA.id, async (db) => {
				await db.query('SAVEPOINT s');
				try {
					const n = (await db.query(`INSERT INTO "${t}" (${list}) SELECT ${list} FROM jsonb_populate_record(null::"${t}", $1)`, [j])).rowCount ?? 0;
					// The row as written (the triggers may have made it theirs), if A reads it.
					const back = n && typeof j.id === 'string' ? (await db.query<Row>(`SELECT to_jsonb(x)::text AS k FROM "${t}" x WHERE x.id = $1`, [j.id])).rows[0]?.k : undefined;
					return { n, back, error: null as string | null };
				} catch (e) {
					return { n: 0, back: undefined, error: code(e) };
				} finally {
					await db.query('ROLLBACK TO SAVEPOINT s');
				}
			});
			const theirs = r.back !== undefined && INSERT_OWN[t]?.(JSON.parse(r.back) as Record<string, unknown>);
			if (r.n && !KNOWN_INSERTS[t] && !theirs) wrong.push(`${t}: inserted a copy of a row they can't read: ${(r.back ?? JSON.stringify(j)).slice(0, 200)}`);
			// Refused by RLS (42501), or by a trigger or constraint *before* the
			// row is written; anything else (a unique violation) means RLS let it through.
			if (!r.n && r.error === '23505') wrong.push(`${t}: RLS let the copy through to a unique violation`);
			if (!r.n) refused.push(t);
		}
		expect(wrong).toEqual([]);
		expect(refused.length).toBeGreaterThan(30);
	});

	it("can't plant a stored input under a hash of their choosing, and their application's run still stores its inputs", async () => {
		const sha = seriesHash([2]);
		// Directly: refused, as for everyone since 074 (no insert policy or grant).
		await expect(
			withUser(applicantA.id, (db) => db.query(`INSERT INTO series_blob (project_id, sha256, "values") VALUES ($1, $2, '{1}')`, [projectId, sha]))
		).rejects.toMatchObject({ code: '42501' });
		// Through the store function: the key is the text's own hash, never the one wanted.
		const got = await withUser(applicantA.id, async (db) => {
			await db.query('SAVEPOINT s');
			try {
				return (await db.query<{ sha: string }>('SELECT app_store_series_blob($1, $2) AS sha', [projectId, '[1]'])).rows[0]!.sha;
			} finally {
				await db.query('ROLLBACK TO SAVEPOINT s');
			}
		});
		expect(got).toBe(seriesHash([1]));
		// A viewer can't store one at all.
		await expect(withUser(viewer.id, (db) => db.query('SELECT app_store_series_blob($1, $2)', [projectId, '[1]']))).rejects.toMatchObject({ code: '42501' });
		// Positive control: A's application run (beforeAll, through the API)
		// stored its inputs, each under the hash its snapshot names and its
		// values hash to (a draft's run is A's alone to read, and A reads no
		// run row, so checked as the schema owner: what loadRunInput checks).
		const refs = await asOwner(
			`SELECT i.kind, i.sha256, b."values", m.inputs -> 'series' -> i.kind ->> 'valuesSha256' AS want
			 FROM model_run m JOIN run_input_series i ON i.run_id = m.id JOIN series_blob b ON b.project_id = i.project_id AND b.sha256 = i.sha256
			 WHERE m.project_id = $1 AND m.scenario_id = $2`,
			[projectId, appA]
		);
		expect(refs.map((r: { kind: string }) => r.kind).sort()).toEqual(['flow_observed_m3s', 'rain_catchment_mm']);
		for (const r of refs) {
			expect(r.sha256).toBe(r.want);
			expect(seriesHash(r.values)).toBe(r.sha256);
		}
	});
});

/** The routes a contributor may call (applications.db.test.ts CONTRIBUTOR_ALLOWED) that take an id of someone else's row. */
const ALLOWED_WITH_IDS = [
	'GET /projects/:id/farm/:nodeId',
	'GET /projects/:id/farm/:nodeId/export.csv',
	'GET /projects/:id/farm/:nodeId/access',
	'GET /projects/:id/scenarios/:sid',
	'PATCH /projects/:id/scenarios/:sid',
	'DELETE /projects/:id/scenarios/:sid',
	'GET /projects/:id/scenarios/:sid/base',
	'POST /projects/:id/scenarios/:sid/runs',
	'POST /projects/:id/scenarios/:sid/rebase',
	'POST /projects/:id/scenarios/:sid/submit',
	'POST /projects/:id/scenarios/:sid/withdraw',
	'POST /projects/:id/scenarios/:sid/reopen',
	'GET /projects/:id/scenarios/:sid/share-candidates',
	'POST /projects/:id/scenarios/:sid/members',
	'DELETE /projects/:id/scenarios/:sid/members/:userId',
	'PATCH /projects/:id/notes/:noteId',
	'DELETE /projects/:id/notes/:noteId'
];

const BODY: Record<string, (ids: Record<string, string>) => unknown> = {
	'PATCH /projects/:id/scenarios/:sid': () => ({ description: 'changed by A' }),
	'POST /projects/:id/scenarios/:sid/runs': () => ({}),
	'POST /projects/:id/scenarios/:sid/rebase': () => ({ baseRunId: published }),
	'POST /projects/:id/scenarios/:sid/submit': () => ({}),
	'POST /projects/:id/scenarios/:sid/withdraw': () => ({}),
	'POST /projects/:id/scenarios/:sid/reopen': () => ({}),
	'POST /projects/:id/scenarios/:sid/members': (ids) => ({ userId: ids.userId }),
	'PATCH /projects/:id/notes/:noteId': () => ({ body: 'changed by A' })
};

async function callAs(u: User, route: string, ids: Record<string, string>) {
	const [method, pattern] = route.split(' ') as [string, string];
	const path = pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => ids[name] ?? '');
	const body = method === 'GET' || method === 'DELETE' ? undefined : (BODY[route]?.(ids) ?? {});
	const r = await app.request(path, {
		method,
		headers: { cookie: u.cookie, origin: 'http://localhost:7777', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	return { status: r.status, text: await r.text() };
}

/** B's rows, as the schema owner reads them: what A's calls must leave alone. */
const snapshotB = async () => ({
	scenario: await asOwner('SELECT to_jsonb(s) - $2 AS s FROM scenario s WHERE id = $1', [appB, 'updated_at']),
	members: await asOwner('SELECT user_id FROM scenario_member WHERE scenario_id = $1 ORDER BY 1', [appB]),
	runs: await asOwner('SELECT id FROM model_run WHERE scenario_id = $1 ORDER BY 1', [appB]),
	note: await asOwner('SELECT to_jsonb(n) AS n FROM note n WHERE id = $1', [noteB]),
	team: await asOwner('SELECT to_jsonb(s) AS s FROM scenario s WHERE id = $1', [teamScenario]),
	links: await asOwner('SELECT user_id, node_id FROM farm_link WHERE project_id = $1 ORDER BY 1, 2', [projectId])
});

describe("the applicant's routes, with B's ids", () => {
	it('lists every allowed route that takes an id (the app still has them)', () => {
		const live = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
		for (const r of ALLOWED_WITH_IDS) expect(live, r).toContain(r);
	});

	it("reads A's own application, farm and note through them (positive control)", async () => {
		const own = { id: projectId, sid: appA, nodeId: rooikloof.id, noteId: noteA, userId: applicantA.id };
		for (const route of ALLOWED_WITH_IDS.filter((r) => r.startsWith('GET '))) {
			const r = await callAs(applicantA, route, own);
			// share-candidates is 200 with nobody for an applicant without a party.
			expect(r.status, `${route}: ${r.text.slice(0, 200)}`).toBe(200);
		}
		const edit = await callAs(applicantA, 'PATCH /projects/:id/scenarios/:sid', own);
		expect(edit.status, edit.text).toBe(200);
		expect(JSON.parse(edit.text).scenario.description).toBe('changed by A');
		expect((await callAs(applicantA, 'PATCH /projects/:id/notes/:noteId', own)).status).toBe(200);
	});

	it.each([
		["B's application, farm, note and consultant", () => ({ id: projectId, sid: appB, nodeId: kalkoenkrans.id, noteId: noteB, userId: consultantB.id })],
		["the team's scenario, a farmer's farm and the owner", () => ({ id: projectId, sid: teamScenario, nodeId: bergvliet.id, noteId: noteB, userId: owner.id })]
	])('refuses every one with %s, and leaves them as they were', async (_what, ids) => {
		const before = await snapshotB();
		const wrong: string[] = [];
		for (const route of ALLOWED_WITH_IDS) {
			const r = await callAs(applicantA, route, ids());
			if (r.status < 400 || ![403, 404].includes(r.status)) wrong.push(`${route} → ${r.status} ${r.text.slice(0, 120)}`);
			for (const name of ['B plan', 'Kalkoenkrans', 'Bergvliet', 'Team idea', 'B note', 'Sconsultantb', 'Sapplicantb']) if (r.text.includes(name)) wrong.push(`${route} named ${name}`);
		}
		expect(wrong).toEqual([]);
		expect(await snapshotB()).toEqual(before);
	});

	it("lists only A's own application and notes on the list routes (positive control: B lists theirs)", async () => {
		const scenarios = (await applicantA.call('GET', `${P()}/scenarios`)).body.scenarios.map((s: { id: string }) => s.id);
		expect(scenarios).toEqual([appA]);
		expect((await applicantB.call('GET', `${P()}/scenarios`)).body.scenarios.map((s: { id: string }) => s.id)).toEqual([appB]);
		const listed = (await applicantA.call('GET', `${P()}/notes`)).body.notes as { id: string }[];
		expect(listed.map((n) => n.id)).toContain(noteA);
		const notes = JSON.stringify(listed);
		for (const name of ['B note', 'Team note', 'Run note', 'Farm note Kalkoenkrans', 'Farm note Bergvliet']) expect(notes, name).not.toContain(name);
		expect((await applicantA.call('GET', `${P()}/farm`)).body.farms).toEqual([{ nodeId: rooikloof.id, name: 'Rooikloof' }]);
		const project = JSON.stringify((await applicantA.call('GET', '/projects')).body);
		for (const name of ['Kalkoenkrans', 'Bergvliet', 'B plan', 'Team idea']) expect(project, name).not.toContain(name);
	});
});

describe("an application's own farm is its owner's farm link, now", () => {
	/** Insert an application (or a team scenario, as the owner) claiming `owned` as its own farms, rolled back. */
	const ownedAs = async (u: User, owned: string[]) =>
		withUser(u.id, async (db) => {
			await db.query('SAVEPOINT s');
			try {
				await db.query(`INSERT INTO scenario (project_id, name, base_run_id, ops, ops_sha256, owned_node_ids) VALUES ($1, $2, $3, '[]', $4, $5)`, [
					projectId,
					`Claim ${crypto.randomUUID()}`,
					published,
					'0'.repeat(64),
					owned
				]);
				return 'inserted';
			} catch (e) {
				return code(e);
			} finally {
				await db.query('ROLLBACK TO SAVEPOINT s');
			}
		});

	it("refuses an application claiming a farm that isn't the applicant's (positive control: their own)", async () => {
		expect(await ownedAs(applicantA, [kalkoenkrans.id])).toBe('42501');
		expect(await ownedAs(applicantA, [rooikloof.id, kalkoenkrans.id])).toBe('42501');
		expect(await ownedAs(applicantA, [rooikloof.id])).toBe('inserted');
		expect(await ownedAs(applicantA, [])).toBe('inserted');
		// …nor changes a draft's own farms to one (the route recomputes them from the links, 045).
		const changed = await withUser(applicantA.id, async (db) => {
			await db.query('SAVEPOINT s');
			try {
				await db.query('UPDATE scenario SET owned_node_ids = $2 WHERE id = $1', [appA, [kalkoenkrans.id]]);
				return 'updated';
			} catch (e) {
				return code(e);
			} finally {
				await db.query('ROLLBACK TO SAVEPOINT s');
			}
		});
		expect(changed).toBe('42501');
		// A team scenario names whichever farms the modeller says (control: the rule is the application's).
		expect(await ownedAs(owner, [kalkoenkrans.id])).toBe('inserted');
	});

	it('stops showing a farm in full once the owner unlinks it, even through an application made while linked', async () => {
		const series = async (u: User) =>
			(
				await withUser(u.id, (db) =>
					db.query<{ node_id: string }>(
						'SELECT DISTINCT node_id FROM run_series WHERE run_id IN (SELECT id FROM app_scenario_run_meta($1, $2)) AND node_id IS NOT NULL',
						[projectId, appA]
					)
				)
			).rows.map((r) => r.node_id);
		// Positive control: while linked, A reads Rooikloof in full in the base and in their run's series.
		const before = await applicantA.call('GET', `${P()}/scenarios/${appA}/base`);
		expect(before.body.anonymisedNodeIds).not.toContain(rooikloof.id);
		expect(before.body.model.nodes.find((n: { id: string }) => n.id === rooikloof.id).name).toBe('Rooikloof');
		expect(await series(applicantA)).toEqual([rooikloof.id]);
		// Rooikloof changes hands: the owner links it to B instead.
		expect((await owner.call('PUT', `${P()}/farmers/${applicantA.id}`, { nodeIds: [doornhoek.id] })).status).toBe(200);
		expect((await owner.call('PUT', `${P()}/farmers/${applicantB.id}`, { nodeIds: [kalkoenkrans.id, rooikloof.id] })).status).toBe(200);
		const after = await applicantA.call('GET', `${P()}/scenarios/${appA}/base`);
		expect(after.status).toBe(200);
		expect(after.body.anonymisedNodeIds).toContain(rooikloof.id);
		const r = after.body.model.nodes.find((n: { id: string }) => n.id === rooikloof.id);
		expect(r.name).not.toBe('Rooikloof');
		expect(r.damCapacityM3).toBe(0);
		expect(after.body.model.boreholes).toEqual([]);
		expect(await series(applicantA)).toEqual([]);
		expect((await applicantA.call('GET', `${P()}/scenarios/${appA}`)).body.scenario.ownedNodeIds).toEqual([]);
		// The stored record keeps what the application said (the assessors' copy), untouched.
		expect((await asOwner('SELECT owned_node_ids FROM scenario WHERE id = $1', [appA]))[0].owned_node_ids).toEqual([rooikloof.id]);
	});
});
