// An applicant reads and shares their own application's issued packs
// (roadmap WP-3.15; issue #71; 131_applicant_packs.sql; docs/evidence-pack.md
// § Applicants, docs/security.md § Evidence packs). Issuing stays with the
// editors; an application's parties read its packs that were issued, through
// a D2-anonymised projection, and its owner links them. Every "cannot" has
// its positive control (CLAUDE.md rule 5):
//
//   - who lists and reads: the application's owner and the person they shared
//     it with (control), never another applicant, an editor who isn't a party
//     (they read the pack themselves), a viewer or a farmer;
//   - which packs: issued, superseded and withdrawn after issue (with their
//     standing), never a draft or a pack withdrawn before issue, never another
//     application's or the baseline's;
//   - the projection: their own units by name, every other unit only as
//     "Farm n" with a whole-point change; no other unit's name, id or
//     figures, no holder, statement or other application; no units at all
//     when a baseline assumption changed; volumes past the k rule;
//   - the database: still no pack row for a contributor, the anonymiser not
//     callable by water_app;
//   - share links: the owner links their own issued pack (not superseded, not
//     another's, not the consultant), lists and revokes only the links they
//     made; the editors' lists and rights unchanged.
//
// The packs are planted past their guards (replica role), as
// share/pack-share.db.test.ts plants them.
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
let applicantA: User; // contributor, linked to Kalkoenkrans
let consultantA: User; // contributor, a member of A's application
let applicantB: User;
let farmer: User;
let projectId: string;
let appA: string;
let appA2: string;
let appB: string;
let v1: string; // A's, superseded by v2
let v2: string; // A's, issued
let v3: string; // A's, a draft of the next version
let neverIssued: string; // A's second application, withdrawn before issue
let assumption: string; // A's second application, issued, a baseline assumption changed
let packB: string; // B's, issued
let baselinePack: string; // the project's baseline evidence, issued

const outlet = node('Rooikloof', null);
const gauge = node('Sandspruit weir', outlet.id, { kind: 'gauge' });
const [kalk, berg, doorn, water, klip] = ['Kalkoenkrans', 'Bergvliet', 'Doornhoek', 'Waterval', 'Klipfontein'].map((n) => node(n, outlet.id)) as [
	ReturnType<typeof node>,
	ReturnType<typeof node>,
	ReturnType<typeof node>,
	ReturnType<typeof node>,
	ReturnType<typeof node>
];
const ADDED = randomUUID();
const HOLDER = 'Secret Holder Pty';
const STATEMENT = 'Our private reasons for the dam';
const OTHER_APP = 'The neighbour’s proposal';
/** What the frozen report holds that an applicant must never read. */
const LEAKS = ['Bergvliet', 'Doornhoek', 'Waterval', 'Klipfontein', 'Rooikloof', HOLDER, STATEMENT, OTHER_APP, 'modeller-only note', 'B plan'];

const P = () => `/projects/${projectId}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const rowsAs = async (u: User, sql: string, params: unknown[] = []) => withUser(u.id, async (db) => (await db.query(sql, params)).rows);
const list = (u: User, sid: string) => u.call('GET', `${P()}/scenarios/${sid}/packs`);
const read = (u: User, sid: string, pack: string) => u.call('GET', `${P()}/scenarios/${sid}/packs/${pack}`);
const link = (u: User, pack: string, label = 'Forum') => u.call('POST', `${P()}/share-links`, { label, expiresInDays: 30, targetKind: 'pack', targetId: pack });
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('t')!;

const user = (n: ReturnType<typeof node> | { id: string; name: string }, over: Record<string, unknown> = {}) => ({
	nodeId: n.id,
	name: n.name,
	kind: 'farm',
	own: false,
	suppliedA: 0.8,
	suppliedB: 0.75,
	timeReliabilityA: 0.7,
	timeReliabilityB: 0.65,
	annualReliabilityA: 0.9,
	annualReliabilityB: 0.85,
	onlyIn: null,
	change: { run: -5, band: { n: 30, p5: -7, p50: -5, p95: -3, min: -9, max: -1 }, bandNote: null, worse: { k: 28, n: 30 } },
	...over
});

/** A report as the engine freezes it, with a secret wherever an applicant must not look. */
function report(mode: 'baseline' | 'application', assumptionsChanged = false, title = 'Raise the weir dam') {
	const row = (id: string, extra: Record<string, unknown> = {}) => ({
		id,
		label: `Row ${id}`,
		basis: `Reserve rule table (${HOLDER} study)`,
		subject: null,
		unit: 'days',
		higherIsWorse: true,
		baseline: 10,
		application: mode === 'application' ? 12 : null,
		change: { run: 2, band: { n: 30, p5: 1, p50: 2, p95: 3, min: 0, max: 4 }, bandNote: null, worse: { k: 25, n: 30 } },
		notAssessed: null,
		note: null,
		...extra
	});
	return {
		version: 'evidence-8',
		mode,
		builtBy: '1.50.0',
		identity: {
			title,
			project: { id: projectId, name: 'Applicant packs' },
			baseline: { runId: randomUUID(), label: 'Baseline', engineVersion: '1.50.0', runoffModel: 'gr4j', startDate: '2000-10-01', endDate: '2020-09-30', createdAt: 'x', createdBy: 'modeller-only note', nomination: null, published: 'this', publishedAt: null },
			application: mode === 'application' ? { runId: randomUUID(), label: 'App', engineVersion: '1.50.0', createdAt: 'x', createdBy: 'x', scenarioId: 'x', scenarioName: title, scenarioStatus: 'submitted', ownerName: 'x', opsSha256: 'x', proposals: 1, assumptions: assumptionsChanged ? 1 : 0 } : null
		},
		assumptionsChanged,
		flags: [{ id: 'f', level: 'red', text: 'Bergvliet is short', effect: null }],
		questions: ['Why is Doornhoek short?'],
		rows: [
			row('reserve', { subject: 'Rooikloof', unit: '% of months', note: '10 of 12 months' }),
			row('reserve', { subject: 'Sandspruit weir', unit: '% of months', note: '11 of 12 months' }),
			row('ewrDays'),
			row('shortfall', { unit: 'Mm³' }),
			row('noFlowDays', { note: 'Longest spell 3 days' }),
			row('outflowMar', { unit: 'Mm³/a', note: '80 % of the natural MAR' }),
			row('registeredUse', { subject: HOLDER }),
			row('userSupply', { subject: 'Doornhoek' }),
			row('otherApplications', { note: `1 application: “${OTHER_APP}”` })
		],
		byMonth: [{ month: 10, run: 1, band: { n: 30, p5: 0, p50: 1, p95: 2, min: 0, max: 3 } }],
		river: [
			{ key: 'outlet', name: 'Rooikloof', isOutlet: true, category: 'C', monthsA: 12, rateA: 0.9, rateB: 0.8, longestA: 1, longestB: 2, lost: 1, gained: 0 },
			{ key: gauge.id, name: 'Sandspruit weir', isOutlet: false, category: 'B', monthsA: 12, rateA: 1, rateB: 1, longestA: 0, longestB: 0, lost: 0, gained: 0 }
		],
		users: [
			user(kalk, { own: true, suppliedB: 0.9, change: { run: 10, band: { n: 30, p5: 8, p50: 10, p95: 12 }, bandNote: null, worse: { k: 0, n: 30 } } }),
			user({ id: ADDED, name: 'My new dam' }, { own: true, onlyIn: 'application', suppliedA: null, change: null }),
			// Marked own when the draft was made; no longer A's farm link, so anonymous now.
			user(berg, { own: true, change: { run: -4.4, band: null, bandNote: 'no band', worse: null } }),
			user(doorn, { change: { run: -0.3, band: null, bandNote: null, worse: null } }),
			user(water, { kind: 'user', change: { run: 2.6, band: null, bandNote: null, worse: null } }),
			// Only in the baseline: not compared.
			user(klip, { onlyIn: 'baseline', change: null })
		],
		allocations: { rows: [{ holder: HOLDER }] },
		cumulative: { applications: [{ scenarioName: OTHER_APP }] },
		appendix: { baselineInputs: { model: { nodes: [outlet, gauge, kalk, berg, doorn, water, klip] } }, changes: [], series: [], warnings: { baseline: ['Bergvliet has no crops'], application: null } },
		verification: { methodology: { version: 'm1', sha256: 'a'.repeat(64) }, limitations: [], errata: [{ id: 'E1', summary: 'An erratum' }], disclaimerVersion: 'v3' },
		applicantStatement: mode === 'application' ? { scenarioName: title, description: STATEMENT, ownerName: 'x', notes: STATEMENT, notesUpdatedAt: null, notesUpdatedBy: 'x' } : null,
		summaries: { baseline: { farms: [{ name: 'Bergvliet' }] }, application: null }
	};
}

/** Plant past the guards, as the replica role does (triggers off; CHECKs and the one-issued exclusion stay). */
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
		`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, scenario_id) VALUES ($1, $2, '1.50.0', '2000-10-01', '2020-09-30', '{}', $3) RETURNING id::text`,
		[projectId, owner.id, scenario]
	);
	return rows[0]!.id as string;
}

async function plantScenario(q: Q, name: string, ownerId: string, base: string, owned: string[]): Promise<string> {
	const [s] = await q(
		`INSERT INTO scenario (project_id, name, base_run_id, ops_sha256, owner_user_id, origin, status, submitted_at, owned_node_ids)
		 VALUES ($1, $2, $3, repeat('a', 64), $4, 'applicant', 'submitted', now(), $5) RETURNING id::text`,
		[projectId, name, base, ownerId, owned]
	);
	return s!.id as string;
}

async function plantPack(
	q: Q,
	o: { run: string; status: 'issued' | 'draft' | 'withdrawn'; rep: unknown; scenario?: string; scenarioRun?: string; version?: number; supersedes?: string; issued?: boolean }
): Promise<string> {
	const id = randomUUID();
	const version = o.version ?? 1;
	const issued = o.issued ?? o.status !== 'draft';
	const manifest = { pack: { id, version }, project: { id: projectId, name: 'Applicant packs' }, engine: { version: '1.50.0' }, report: o.rep };
	await q(
		`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, supersedes_pack_id, scenario_id, scenario_run_id, status, status_reason, manifest, manifest_sha256,
			report_version, engine_version, created_by, issued_at, issued_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'evidence-8', '1.50.0', $12, CASE WHEN $13 THEN now() END, CASE WHEN $13 THEN $12::uuid END)`,
		[id, projectId, o.run, version, o.supersedes ?? null, o.scenario ?? null, o.scenarioRun ?? null, o.status, o.status === 'withdrawn' ? 'An error in the rule table' : null, JSON.stringify(manifest), sha(id), assessor.id, issued]
	);
	await q(
		`INSERT INTO signoff (project_id, pack_id, user_id, full_name, registration_body, registration_category, registration_field, registration_no, scope, statement_version, statement_sha256, disclaimer_version)
		 VALUES ($1, $2, $3, 'Dr A Signer', 'sacnasp', 'pr_sci_nat', 'water_resources', '400123/10', 'x', 'pack-signoff-1', repeat('a', 64), 'v3')`,
		[projectId, id, assessor.id]
	);
	return id;
}

beforeAll(async () => {
	[owner, assessor, viewer, applicantA, consultantA, applicantB, farmer] = (await Promise.all(
		['Apowner', 'Apassessor', 'Apviewer', 'Apapplicanta', 'Apconsultanta', 'Apapplicantb', 'Apfarmer'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Applicant packs' })).body.project.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet, gauge, kalk, berg, doorn, water, klip], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	for (const [u, role] of [
		[assessor, 'editor'],
		[viewer, 'viewer'],
		[applicantA, 'contributor'],
		[consultantA, 'contributor'],
		[applicantB, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantA.id}`, { nodeIds: [kalk.id] })).status).toBe(200);
	expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: [doorn.id] })).status).toBe(201);

	await arrange(async (q) => {
		const base = await plantRun(q);
		// A's application owns Kalkoenkrans (still linked) and Bergvliet (never A's link: the database keeps it out).
		appA = await plantScenario(q, 'Raise the weir dam', applicantA.id, base, [kalk.id, berg.id]);
		appA2 = await plantScenario(q, 'A second dam', applicantA.id, base, [kalk.id]);
		appB = await plantScenario(q, 'B plan', applicantB.id, base, []);
		await q('INSERT INTO scenario_member (project_id, scenario_id, user_id, added_by) VALUES ($1, $2, $3, $4)', [projectId, appA, consultantA.id, applicantA.id]);
		const runA = await plantRun(q, appA);
		const runA2 = await plantRun(q, appA2);
		const runB = await plantRun(q, appB);
		v1 = await plantPack(q, { run: base, status: 'issued', rep: report('application'), scenario: appA, scenarioRun: runA });
		v2 = await plantPack(q, { run: base, status: 'issued', rep: report('application'), scenario: appA, scenarioRun: runA, version: 2, supersedes: v1 });
		await q(`UPDATE evidence_pack SET status = 'superseded', superseded_by_pack_id = $2 WHERE id = $1`, [v1, v2]);
		v3 = await plantPack(q, { run: base, status: 'draft', rep: report('application'), scenario: appA, scenarioRun: runA, version: 3, supersedes: v2 });
		neverIssued = await plantPack(q, { run: base, status: 'withdrawn', issued: false, rep: report('application', false, 'A second dam'), scenario: appA2, scenarioRun: runA2 });
		assumption = await plantPack(q, { run: base, status: 'issued', rep: report('application', true, 'A second dam'), scenario: appA2, scenarioRun: runA2, version: 2, supersedes: neverIssued });
		packB = await plantPack(q, { run: base, status: 'issued', rep: report('application', false, 'B plan'), scenario: appB, scenarioRun: runB });
		baselinePack = await plantPack(q, { run: base, status: 'issued', rep: report('baseline', false, 'Applicant packs') });
	});
}, 120_000);

describe("listing an application's packs", () => {
	it('lists the issued and superseded packs to the owner and their consultant, newest first; never the draft', async () => {
		for (const u of [applicantA, consultantA]) {
			const r = await list(u, appA);
			expect(r.status, JSON.stringify(r.body)).toBe(200);
			expect(r.body.packs.map((p: { id: string; status: string; version: number }) => [p.id, p.status, p.version])).toEqual([
				[v2, 'issued', 2],
				[v1, 'superseded', 1]
			]);
		}
		const [latest] = (await list(applicantA, appA)).body.packs;
		expect(latest).toMatchObject({ scenarioId: appA, title: 'Raise the weir dam', mode: 'application', supersedesId: v1, supersededById: null, canShare: true });
		expect(latest.shortCode).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
		expect(latest.verifyPath).toBe(`/verify/${latest.shortCode}`);
		// Only the owner may link it.
		expect((await list(consultantA, appA)).body.packs[0].canShare).toBe(false);
	});

	it('leaves out a pack withdrawn before it was issued', async () => {
		expect((await list(applicantA, appA2)).body.packs.map((p: { id: string }) => p.id)).toEqual([assumption]);
	});

	it("refuses another applicant's application; lists nothing to an editor who isn't a party (control: B lists theirs)", async () => {
		expect((await list(applicantB, appA)).status).toBe(404);
		expect((await list(applicantA, appB)).status).toBe(404);
		expect((await list(applicantB, appB)).body.packs.map((p: { id: string }) => p.id)).toEqual([packB]);
		const editor = await list(assessor, appA);
		expect(editor.status).toBe(200);
		expect(editor.body.packs).toEqual([]);
		// The editor reads the packs themselves, as before.
		expect((await assessor.call('GET', `${P()}/packs/${v2}`)).status).toBe(200);
		expect((await list(farmer, appA)).status).toBe(403);
		expect((await list(viewer, appA)).status).toBe(404);
	});
});

describe('reading a pack as its applicant', () => {
	it("shows verify's fields, a link's figures and the D2 units: their own by name, the rest anonymous", async () => {
		const r = await read(applicantA, appA, v2);
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		const v = r.body;
		expect(v.pack).toMatchObject({ id: v2, status: 'issued', version: 2, canShare: true });
		const verify = await anon('GET', `/verify/${v.pack.shortCode}`);
		expect(v.verify).toEqual(verify.body.pack);
		expect(v.figures.volumes).toBe(true);
		expect(v.figures.rows.map((x: { id: string; subject: string | null }) => [x.id, x.subject])).toEqual([
			['reserve', null],
			['reserve', 'Sandspruit weir'],
			['ewrDays', null],
			['shortfall', null],
			['noFlowDays', null],
			['outflowMar', null]
		]);
		expect(v.units.own.map((u: { name: string; onlyIn: string | null }) => [u.name, u.onlyIn])).toEqual([
			['Kalkoenkrans', null],
			['My new dam', 'application']
		]);
		expect(v.units.own[0]).toMatchObject({ kind: 'farm', suppliedA: 0.8, suppliedB: 0.9, change: { run: 10, band: { n: 30, p5: 8, p50: 10, p95: 12 }, worse: { k: 0, n: 30 } } });
		// Every other unit in both runs, anonymous, whole points; Klipfontein (baseline only) isn't compared.
		expect(v.units.others.map((o: { kind: string; n: number }) => `${o.kind} ${o.n}`).sort()).toEqual(['farm 1', 'farm 2', 'user 1']);
		expect(v.units.others.map((o: { changePts: number }) => o.changePts).sort((a: number, b: number) => a - b)).toEqual([-4, 0, 3]);
		for (const o of v.units.others) expect(Object.keys(o).sort()).toEqual(['changePts', 'kind', 'n']);
		const text = JSON.stringify(v);
		for (const leak of LEAKS) expect(text, leak).not.toContain(leak);
		for (const id of [berg.id, doorn.id, water.id, klip.id, outlet.id, gauge.id, kalk.id, ADDED, assessor.id, applicantB.id]) expect(text).not.toContain(id);
		expect(text).not.toMatch(/@example\.com/);
	});

	it('numbers the anonymous units the same in every version', async () => {
		const a = (await read(applicantA, appA, v1)).body.units.others;
		const b = (await read(applicantA, appA, v2)).body.units.others;
		expect(a).toEqual(b);
	});

	it('shows the consultant the same, without the share right', async () => {
		const r = await read(consultantA, appA, v2);
		expect(r.status).toBe(200);
		expect(r.body.pack.canShare).toBe(false);
		expect(r.body.units.own.map((u: { name: string }) => u.name)).toEqual(['Kalkoenkrans', 'My new dam']);
	});

	it('reads a superseded pack with its standing and figures', async () => {
		const r = await read(applicantA, appA, v1);
		expect(r.status).toBe(200);
		expect(r.body.pack).toMatchObject({ status: 'superseded', supersededById: v2, canShare: false });
		expect(r.body.verify.status).toBe('superseded');
		expect(r.body.figures.rows.length).toBeGreaterThan(0);
	});

	it('withholds every unit when the report changed a baseline assumption, and the volumes with it', async () => {
		const r = await read(applicantA, appA2, assumption);
		expect(r.status).toBe(200);
		expect(r.body.units).toBeNull();
		expect(r.body.figures.volumes).toBe(false);
		expect(r.body.figures.rows.map((x: { id: string }) => x.id)).toEqual(['reserve', 'reserve', 'ewrDays', 'noFlowDays']);
	});

	it("is 404 for a draft, a pack never issued, another application's, the baseline's, or through another application's address", async () => {
		expect((await read(applicantA, appA, v3)).status).toBe(404);
		expect((await read(applicantA, appA2, neverIssued)).status).toBe(404);
		expect((await read(applicantA, appA, packB)).status).toBe(404);
		expect((await read(applicantA, appB, packB)).status).toBe(404);
		expect((await read(applicantA, appA, baselinePack)).status).toBe(404);
		expect((await read(applicantA, appA, assumption)).status).toBe(404);
		expect((await read(applicantB, appA, v2)).status).toBe(404);
		// Control: B reads their own.
		expect((await read(applicantB, appB, packB)).status).toBe(200);
		// An editor who isn't a party: 404 here, the full pack on its own route.
		expect((await read(assessor, appA, v2)).status).toBe(404);
		expect((await read(farmer, appA, v2)).status).toBe(403);
	});

	it('keeps the pack rows, the manifest and the PDF from a contributor in the database (control: the editor)', async () => {
		expect(await rowsAs(applicantA, 'SELECT id FROM evidence_pack')).toEqual([]);
		expect((await rowsAs(assessor, 'SELECT id FROM evidence_pack WHERE id = $1', [v2])).length).toBe(1);
		expect((await applicantA.call('GET', `${P()}/packs/${v2}`)).status).toBe(403);
		expect((await applicantA.call('GET', `${P()}/packs/${v2}/pdf`)).status).toBe(403);
		expect((await applicantA.call('GET', `${P()}/packs/${v2}/bundle`)).status).toBe(403);
		// The definer read answers only its parties.
		expect(await rowsAs(applicantB, 'SELECT * FROM app_applicant_pack($1, $2)', [projectId, v2])).toEqual([]);
		expect((await rowsAs(applicantA, 'SELECT * FROM app_applicant_pack($1, $2)', [projectId, v2])).length).toBe(1);
		// The anonymiser and the link projection aren't water_app's to call.
		await expect(rowsAs(applicantA, `SELECT app_applicant_pack_units('{}'::jsonb, '{}')`)).rejects.toThrow(/permission denied/);
		await expect(rowsAs(applicantA, `SELECT app_share_pack_projection('{}'::jsonb, true)`)).rejects.toThrow(/permission denied/);
	});
});

describe("share links to an applicant's pack", () => {
	let mine: string;
	let assessors: string;

	it('lets the owner link their own issued pack; not the consultant, a superseded one, or another’s', async () => {
		const made = await link(applicantA, v2, 'Our forum');
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		expect(made.body.link).toMatchObject({ targetKind: 'pack', targetId: v2, mine: true, target: { name: 'Raise the weir dam', status: 'issued', version: 2 } });
		mine = made.body.link.id;
		// The link opens the pack's public projection, which names no unit, the applicant's own included.
		const opened = await anon('POST', '/share/pack', { token: tokenOf(made.body.link.url) });
		expect(opened.status).toBe(200);
		expect(JSON.stringify(opened.body)).not.toContain('Kalkoenkrans');
		expect((await link(consultantA, v2)).status).toBe(403);
		expect((await link(applicantA, v1)).status).toBe(409);
		expect((await link(applicantA, packB)).status).toBe(403);
		expect((await link(applicantA, baselinePack)).status).toBe(403);
		expect((await link(applicantA, v3)).status).toBe(403);
		expect((await link(applicantB, v2)).status).toBe(403);
		expect((await link(viewer, v2)).status).toBe(403);
		// The editors, unchanged.
		const byAssessor = await link(assessor, v2, 'Assessors');
		expect(byAssessor.status).toBe(201);
		assessors = byAssessor.body.link.id;
	});

	it('holds the same in the database (share_link_insert): a superseded pack refused, their issued one allowed', async () => {
		const insert = `INSERT INTO share_link (project_id, label, token_hash, created_by, expires_at, target_kind, target_id) VALUES ($1, 'x', $2, $3, now() + interval '1 day', 'pack', $4)`;
		await expect(rowsAs(applicantA, insert, [projectId, Buffer.alloc(32, 41), applicantA.id, v1])).rejects.toThrow(/row-level security/);
		await expect(rowsAs(consultantA, insert, [projectId, Buffer.alloc(32, 42), consultantA.id, v2])).rejects.toThrow(/row-level security/);
		expect(await rowsAs(applicantA, `${insert} RETURNING 1 AS ok`, [projectId, Buffer.alloc(32, 43), applicantA.id, v2])).toEqual([{ ok: 1 }]);
	});

	it('lists to the applicant only the links they made; the editors every one', async () => {
		const byA = await applicantA.call('GET', `${P()}/share-links?packId=${v2}`);
		expect(byA.status, JSON.stringify(byA.body)).toBe(200);
		expect(byA.body.links.map((l: { label: string }) => l.label).sort()).toEqual(['Our forum', 'x']);
		expect(byA.body.links.find((l: { label: string }) => l.label === 'Our forum').target).toEqual({ name: 'Raise the weir dam', status: 'issued', version: 2 });
		const byAssessor = await assessor.call('GET', `${P()}/share-links?packId=${v2}`);
		expect(byAssessor.body.links.map((l: { label: string }) => l.label).sort()).toEqual(['Assessors', 'Our forum', 'x']);
		// The consultant made none, and B isn't a party.
		expect((await consultantA.call('GET', `${P()}/share-links?packId=${v2}`)).body.links).toEqual([]);
		expect((await applicantB.call('GET', `${P()}/share-links?packId=${v2}`)).status).toBe(403);
		expect((await applicantA.call('GET', `${P()}/share-links?packId=${baselinePack}`)).status).toBe(403);
	});

	it("revokes the applicant's own link, never the assessors'", async () => {
		expect((await applicantA.call('DELETE', `${P()}/share-links/${assessors}`)).status).toBe(403);
		expect((await applicantA.call('DELETE', `${P()}/share-links/${mine}`)).status).toBe(204);
		const [row] = await asOwner('SELECT revoked_at IS NOT NULL AS revoked, revoked_by::text FROM share_link WHERE id = $1', [mine]);
		expect(row).toEqual({ revoked: true, revoked_by: applicantA.id });
		const [theirs] = await asOwner('SELECT revoked_at FROM share_link WHERE id = $1', [assessors]);
		expect(theirs.revoked_at).toBeNull();
		expect((await assessor.call('DELETE', `${P()}/share-links/${assessors}`)).status).toBe(204);
	});
});
