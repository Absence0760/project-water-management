// The other units in an applicant's pack (131_applicant_packs,
// evidence/applicantPacks.ts; docs/evidence-pack.md § Applicants) are the
// results view's: only the farms and water users downstream of the
// application in the application run's stored model, each under the
// anonymous name /base and GET …/results already give it
// (projectBaseForApplicant, downstreamOf; scenarios/applicantResults.ts). So
// the pack shows the applicant no unit, and no link between a name and a
// place, that they don't already have. End to end against Postgres, with a
// real published base and a real application run; the pack is planted past
// its guards (replica role) around that run, as applicant-packs.db.test.ts
// plants its packs. Positive control (CLAUDE.md rule 5): the unit below
// theirs is shown; the upstream and side units never are.
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

let owner: User; // the modeller, and the assessor
let applicant: User; // linked to Rooikloof
let projectId: string;
let published: string;
let sid: string;
let runId: string;
let pack: string;
let unnamed: string; // a pack whose application run has no stored model: the names can't be derived

// Gauge ← Waterval ← Rooikloof (the applicant's) ← Boskloof (upstream); three more farms straight to the gauge (side branches).
const outlet = node('Gauge', null);
const waterval = node('Waterval', outlet.id, { damCapacityM3: 60_000 });
const rooikloof = node('Rooikloof', waterval.id, { damCapacityM3: 20_000 });
const boskloof = node('Boskloof', rooikloof.id);
const side = ['Bergvliet', 'Doornhoek', 'Kalkoenkrans'].map((n) => node(n, outlet.id));
const P = () => `/projects/${projectId}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

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

/** § 4's users as the engine freezes them: every unit in both runs with its change in points. */
const unit = (n: { id: string; name: string }, run: number, own = false) => ({
	nodeId: n.id,
	name: n.name,
	kind: 'farm',
	own,
	suppliedA: 0.8,
	suppliedB: 0.8,
	onlyIn: null,
	change: { run, band: null, bandNote: null, worse: null }
});

function report() {
	return {
		version: 'evidence-8',
		mode: 'application',
		identity: { title: 'Raise Rooikloof' },
		assumptionsChanged: false,
		rows: [],
		byMonth: null,
		river: [],
		users: [unit(rooikloof, 10, true), unit(waterval, -3.6), unit(boskloof, 1.2), ...side.map((n, i) => unit(n, -i))],
		verification: { methodology: { version: 'm1', sha256: 'a'.repeat(64) }, limitations: [], errata: [], disclaimerVersion: 'v3' }
	};
}

async function plantPack(q: Q, scenarioRun: string, version: number, supersedes: string | null): Promise<string> {
	const id = randomUUID();
	const manifest = { pack: { id, version }, project: { id: projectId }, engine: { version: 'x' }, report: report() };
	await q(
		`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, supersedes_pack_id, scenario_id, scenario_run_id, status, manifest, manifest_sha256,
			report_version, engine_version, created_by, issued_at, issued_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, 'issued', $8, $9, 'evidence-8', 'x', $10, now(), $10)`,
		[id, projectId, published, version, supersedes, sid, scenarioRun, JSON.stringify(manifest), sha(id), owner.id]
	);
	return id;
}

beforeAll(async () => {
	[owner, applicant] = (await Promise.all(['Puowner', 'Puapplicant'].map((n) => signUp(n)))) as [User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Applicant pack units' })).body.project.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet, waterval, rooikloof, boskloof, ...side], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(180) } })).status).toBe(200);
	const days = 60;
	const rain = Array.from({ length: days }, (_, i) => (i % 9 === 0 ? 15 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	expect((await owner.call('POST', `${P()}/members`, { email: applicant.email, role: 'contributor' })).status).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
	const made = await applicant.call('POST', `${P()}/scenarios`, {
		name: 'Raise Rooikloof',
		baseRunId: published,
		ops: [{ op: 'node.set', nodeId: rooikloof.id, field: 'damCapacityM3', value: 200_000 }]
	});
	expect(made.status, JSON.stringify(made.body)).toBe(201);
	sid = made.body.scenario.id;
	const ran = await applicant.call('POST', `${P()}/scenarios/${sid}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	runId = ran.body.run.id;
	await arrange(async (q) => {
		pack = await plantPack(q, runId, 1, null);
		const [bare] = await q(
			`INSERT INTO model_run (project_id, created_by, engine_version, start_date, end_date, inputs, scenario_id) VALUES ($1, $2, 'x', '2020-01-01', '2020-02-29', '{}', $3) RETURNING id::text`,
			[projectId, owner.id, sid]
		);
		// One issued pack of a lineage at a time: supersede the first before its successor is issued.
		await q(`UPDATE evidence_pack SET status = 'superseded', superseded_by_pack_id = $2 WHERE id = $1`, [pack, randomUUID()]);
		unnamed = await plantPack(q, bare!.id as string, 2, pack);
		await q('UPDATE evidence_pack SET superseded_by_pack_id = $2 WHERE id = $1', [pack, unnamed]);
	});
}, 120_000);

afterAll(() => retirePendingJobs(projectId));

describe("the other units in an applicant's pack", () => {
	it('are the results view’s downstream units, under the same names as /base and the results view; never an upstream or side unit', async () => {
		const res = await applicant.call('GET', `${P()}/scenarios/${sid}/packs/${pack}`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const others = res.body.units.others as { kind: string; name: string; changePts: number }[];

		const results = (await applicant.call('GET', `${P()}/scenarios/${sid}/results?runId=${runId}`)).body.results;
		const base = (await applicant.call('GET', `${P()}/scenarios/${sid}/base`)).body;
		const baseName = (id: string) => base.model.nodes.find((n: { id: string }) => n.id === id).name as string;

		// Positive control: Waterval, below theirs, is shown, as the results view shows it.
		expect(results.downstream.map((d: { name: string }) => d.name)).toEqual([baseName(waterval.id)]);
		expect(others).toEqual([{ kind: 'farm', name: baseName(waterval.id), changePts: -4 }]);
		expect(others.map((o) => o.name)).toEqual(results.downstream.map((d: { name: string }) => d.name));
		// Boskloof (upstream) and the side farms: never, under any name.
		for (const n of [boskloof, ...side]) expect(others.map((o) => o.name)).not.toContain(baseName(n.id));
		// No node id, and no real name but the applicant's own, anywhere in the answer.
		const text = JSON.stringify(res.body);
		for (const n of [waterval, boskloof, ...side, outlet]) expect(text).not.toContain(n.id);
		for (const n of ['Waterval', 'Boskloof', 'Bergvliet', 'Doornhoek', 'Kalkoenkrans']) expect(text).not.toContain(n);
		expect(res.body.units.own.map((u: { name: string }) => u.name)).toEqual(['Rooikloof']);
	});

	it('are not shown when the application run can’t be read for them, and the answer says so with null (control above)', async () => {
		const res = await applicant.call('GET', `${P()}/scenarios/${sid}/packs/${unnamed}`);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.units.others).toBeNull();
		expect(res.body.units.own.map((u: { name: string }) => u.name)).toEqual(['Rooikloof']);
	});
});
