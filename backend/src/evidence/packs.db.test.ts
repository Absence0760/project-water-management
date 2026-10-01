// Evidence packs (WP-3.14, issue #71; docs/evidence-pack.md, docs/api.md §
// Evidence packs, 112_evidence_pack.sql), end to end on a synthetic
// catchment: a nominated baseline with a declared uncertainty rule and a cited
// ensemble, a team application with a paired band. Drafting from a report
// that may be issued (and the refusal), the pack sign-off, issue and its
// preconditions, supersede, withdraw, the public verify lookup (only the
// listed fields; nothing for a draft), the guards as water_app and as the
// schema owner (immutable once issued, forward-only status, sign-off target
// rules), who reads a pack, the runs a pack keeps, an account deletion, and a
// project with an issued pack being kept. The issued pack's PDF too
// (119_pack_render): the render issuing queues, its render session, the
// renderer's answers (retry, failure, the PDF recorded once), and who
// downloads it. Each "can't" has its positive control.
//
// REPORT_RENDERER is `sqs` for the PDF tests, with the queue send captured:
// a render is the render_pack message it would send, with no Chromium.
//
// The engine's errata list (ENGINE_ERRATA) is a copy the tests may add to, so
// an erratum can be "found" after a pack was issued (132, errataFoundSince);
// only the backend's imports see it, never the engine's own.
import {
	checkPackBundle,
	declaredRuleRequest,
	ENGINE_VERSION,
	localityMapSvg,
	type Erratum,
	packManifestText,
	runEnsemble,
	runPairedEnsemble,
	type DeclaredUncertaintyRule,
	type ModelInput,
	type PackManifest
} from '@water-management/engine';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { sent, errataList } = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[], errataList: [] as Erratum[] }));
vi.mock('@water-management/engine', async (orig) => {
	const engine = await orig<typeof import('@water-management/engine')>();
	errataList.push(...engine.ENGINE_ERRATA);
	return { ...engine, ENGINE_ERRATA: errataList };
});
vi.mock('../jobs/transport.js', async (orig) => ({
	...(await orig<typeof import('../jobs/transport.js')>()),
	sendToQueue: async (_url: string | undefined, _name: string, message: Record<string, unknown>) => void sent.push(message)
}));

import { anon, app, asOwner, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { minioUp, S3_ENDPOINT } from '../__tests__/minio.js';
import { withUser } from '../db/tx.js';
import { enqueueJob } from '../jobs/queue.js';
import { runTick } from '../jobs/runner.js';
import { PackRenderRequestMessage, type PackRenderResult } from '../jobs/transport.js';
import { outbox } from '../mail/transport.js';
import { sendPackNotices } from './notices.js';
import { acceptPackRenderResult } from '../reports/schedule.js';
import { packBundleKey, packPdfKey, packsBucket, putPackBundle, putPackPdf, resetStorageClient } from '../reports/storage.js';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { trimRuns } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let viewer: User;
let stranger: User;
let contributor: User;
let farmer: User;
let projectId: string;
let farmId: string;
let seedRun: string;
let baseRun: string;
let appRun: string;

const DAYS = 3 * 365;
const RULE: DeclaredUncertaintyRule = { members: 30, bounds: 'typical', panOffset: 0.1, thresholds: { objective: 'kgePrime', minSkill: -10, wr2012MaxLevel: 'unusable', maxLowFlowBiasPct: null } };
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

const at = () => `/projects/${projectId}`;
const runPath = (runId: string) => `${at()}/runs/${runId}`;
const packPath = (packId: string) => `${at()}/packs/${packId}`;

async function newRun(label: string) {
	const res = await owner.call('POST', `${at()}/runs`, { label });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.run.id as string;
}
const inputOf = async (runId: string): Promise<ModelInput> => (await owner.call('GET', `${runPath(runId)}/model-input`)).body.input;

async function ensemble(runId: string, body: unknown, pairedOn?: Parameters<typeof runPairedEnsemble>[1]) {
	const started = await owner.call('POST', `${runPath(runId)}/uncertainty`, body);
	expect(started.status, JSON.stringify(started.body)).toBe(201);
	const row = started.body.ensemble;
	const input = await inputOf(runId);
	const result = pairedOn ? { members: runPairedEnsemble(input, pairedOn).members } : (({ members, coverage }) => ({ members, coverage }))(runEnsemble(input, row.options));
	const done = await owner.call('POST', `${runPath(runId)}/uncertainty/${row.id}/result`, result);
	expect(done.status, JSON.stringify(done.body)).toBe(200);
	return row.id as string;
}

/** Draft a pack as `u`. */
async function draft(u: User, runId: string, supersedesId?: string) {
	const res = await u.call('POST', `${at()}/packs`, { runId, ...(supersedesId ? { supersedesId } : {}) });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.pack as { id: string; version: number; status: string; manifestSha256: string; shortCode: string };
}

/** Sign a pack as `u`, with every confirmation and the statement shown. */
async function sign(u: User, packId: string, name = 'Dr A. Hydrologist') {
	const shown = await u.call('GET', `${packPath(packId)}/signoffs`);
	expect(shown.status).toBe(200);
	const res = await u.call('POST', `${packPath(packId)}/signoffs`, {
		fullName: name,
		registrationBody: 'sacnasp',
		registrationCategory: 'pr_sci_nat',
		registrationField: 'water_resources',
		registrationNo: '400999/20',
		scope: 'the hydrology of the evidence pack',
		confirmed: shown.body.statement.confirmations.map((k: { id: string }) => k.id),
		statementSha256: shown.body.statementSha256
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.signoff;
}

const issue = (u: User, packId: string) => u.call('POST', `${packPath(packId)}/issue`);

const PUMP_CROP = crypto.randomUUID();
/** The upper farm pumping from the river under run of river for a new crop: no capacity, nothing kept for the EWR (evidence-10). */
const PUMP = [
	{ op: 'crop.add', crop: { id: PUMP_CROP, name: 'Lucerne', cropFactor: Array.from({ length: 12 }, () => 0.8) } },
	{ op: 'cropArea.set', nodeId: '', cropId: PUMP_CROP, areaM2: 50_000 },
	{ op: 'node.set', nodeId: '', field: 'supplyRule', value: 'runOfRiver' }
];
/** A capacity and the EWR kept, so both river checks pass. */
const PROTECT = [
	{ op: 'node.set', nodeId: '', field: 'pumpCapacityM3Day', value: 2400 },
	{ op: 'node.set', nodeId: '', field: 'handsOffEwr', value: true }
];

/** An application on the baseline owning the upper farm, run, with its paired band on the cited ensemble, so only its own checks can fail. */
async function scenarioRun(name: string, ops: Record<string, unknown>[]) {
	const created = await owner.call('POST', `${at()}/scenarios`, { name, baseRunId: baseRun, ops: ops.map((o) => ('nodeId' in o ? { ...o, nodeId: farmId } : o)), ownedNodeIds: [farmId] });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	const ran = await owner.call('POST', `${at()}/scenarios/${created.body.scenario.id}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	const runId = ran.body.run.id as string;
	const cited = (await viewer.call('GET', `${runPath(appRun)}/evidence-report`)).body.report.uncertainty.cited.id as string;
	const base = (await owner.call('GET', `${runPath(baseRun)}/uncertainty/${cited}`)).body.ensemble;
	await ensemble(runId, { baselineId: cited }, { options: base.options, header: base.result.header, members: base.result.members });
	return runId;
}
const bytesSha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A synthetic boundary and the applicant's parcel on the map (§ 1's locality map, evidence-12); deleted by the caller. */
const square = (lon: number, lat: number, d: number) => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]];
async function addFeature(body: Record<string, unknown>) {
	const res = await owner.call('POST', `${at()}/map/features`, body);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.feature.id as string;
}
async function seedLocality() {
	return [
		await addFeature({ kind: 'catchment_boundary', name: 'Synthetic catchment', geometry: { type: 'Polygon', coordinates: [square(21.3, -33.7, 0.1)] } }),
		await addFeature({ kind: 'farm_parcel', name: '', nodeId: farmId, geometry: { type: 'Polygon', coordinates: [square(21.31, -33.69, 0.03)] } })
	];
}
const dropFeatures = async (ids: string[]) => {
	for (const id of ids) expect((await owner.call('DELETE', `${at()}/map/features/${id}`)).status).toBe(204);
};

/** Issuing a pack stores its reproduction bundle in MinIO (bundle.ts), so the describes that issue need it. */
const minio = await minioUp('packs.db.test.ts (issuing a pack and what follows)');

/** Download a pack's bundle as `u`, through the route's redirect to MinIO. */
async function downloadBundle(u: User, packId: string) {
	const res = await app.request(`${packPath(packId)}/bundle`, { headers: { cookie: u.cookie, origin: 'http://localhost:7777' }, redirect: 'manual' });
	expect(res.status, await res.clone().text()).toBe(302);
	expect(res.headers.get('referrer-policy')).toBe('no-referrer');
	expect(res.headers.get('cache-control')).toBe('no-store');
	const got = await fetch(res.headers.get('location')!);
	expect(got.status).toBe(200);
	return { bytes: new Uint8Array(await got.arrayBuffer()), disposition: got.headers.get('content-disposition') };
}

const S3 = S3_ENDPOINT;
/** A client straight to MinIO (DEV-ONLY docker credentials), to plant an object the renderer never stored. */
const rawS3 = () =>
	new S3Client({
		endpoint: S3,
		region: process.env.S3_REGION?.trim() || 'us-east-1',
		forcePathStyle: true,
		credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim() || 'minioadmin', secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim() || 'minioadmin' }
	});

/** The pack's notices of one event (133_pack_notices), by recipient. */
const notices = async (packId: string, event = 'issued') =>
	(await asOwner('SELECT user_id::text, event, status FROM pack_notice WHERE pack_id = $1 AND event = $2 ORDER BY user_id', [packId, event])) as { user_id: string; event: string; status: string }[];

// Whatever this file queued and left (issuing v2 queues its PDF's render, a retry waits two minutes): no later file's tick may claim it.
afterAll(async () => {
	await retirePendingJobs(projectId);
	// And the pack notices it queued, so no later file's tick sends them.
	await asOwner('DELETE FROM pack_notice WHERE project_id = $1', [projectId]);
});

beforeAll(async () => {
	[owner, editor, viewer, stranger, contributor, farmer] = (await Promise.all(
		['PkOwner', 'PkEditor', 'PkViewer', 'PkStranger', 'PkContributor', 'PkFarmer'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Pack catchment' })).body.project.id as string;
	for (const [u, role] of [
		[editor, 'editor'],
		[viewer, 'viewer'],
		[contributor, 'contributor']
	] as const)
		expect((await owner.call('POST', `${at()}/members`, { email: u.email, role })).status).toBe(201);
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id, { areaKm2: 30, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0 });
	farmId = farm.id;
	expect((await owner.call('PUT', `${at()}/model`, { nodes: [outlet, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('POST', `${at()}/farmers`, { email: farmer.email, nodeIds: [farmId] })).status).toBe(201);
	expect(
		(await owner.call('PATCH', at(), { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(5000), runoffModel: 'gr4j', evidenceUncertaintyRule: RULE } })).status
	).toBe(200);
	const rain = Array.from({ length: DAYS }, (_, i) => (i % 4 === 0 ? (Math.floor(i / 30) % 12 < 6 ? 18 : 6) : 0));
	expect((await owner.call('PUT', `${at()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2018-10-01', values: rain })).status).toBe(200);
	seedRun = await newRun('seed');
	const flow = (await owner.call('GET', `${runPath(seedRun)}/series?key=simulated_outflow`)).body.values as number[];
	expect(
		(await owner.call('PUT', `${at()}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2018-10-01', values: flow.map((q, i) => (q / 86_400) * (1 + 0.1 * Math.sin(i / 17))) }))
			.status
	).toBe(200);
	baseRun = await newRun('Baseline');
	expect((await owner.call('POST', `${at()}/evidence`, { runId: baseRun, reason: 'Calibrated baseline' })).status).toBe(201);
	const cited = await ensemble(baseRun, { request: declaredRuleRequest(RULE) });
	const dam = { op: 'node.set', nodeId: farmId, field: 'damCapacityM3', value: 500_000 };
	const created = await owner.call('POST', `${at()}/scenarios`, {
		name: 'Upper dam',
		description: 'A dam on Upper.',
		purposeAndNeed: 'Winter storage.',
		baseRunId: baseRun,
		ops: [dam],
		ownedNodeIds: [farmId]
	});
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	const ran = await owner.call('POST', `${at()}/scenarios/${created.body.scenario.id}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	appRun = ran.body.run.id;
	const base = (await owner.call('GET', `${runPath(baseRun)}/uncertainty/${cited}`)).body.ensemble;
	await ensemble(appRun, { baselineId: cited }, { options: base.options, header: base.result.header, members: base.result.members });
}, 600_000);

describe('drafting a pack', () => {
	it('drafts a baseline pack from an issuable report, and its hash survives storage (positive control)', async () => {
		const p = await draft(editor, baseRun);
		expect(p).toMatchObject({ version: 1, status: 'draft', supersedesId: null, baselineRunId: baseRun, scenarioRunId: null, mode: 'baseline' });
		expect(p.shortCode).toBe(`${p.manifestSha256.slice(0, 4)}-${p.manifestSha256.slice(4, 8)}-${p.manifestSha256.slice(8, 12)}`);
		const read = await viewer.call('GET', packPath(p.id));
		expect(read.status).toBe(200);
		const manifest = read.body.manifest as PackManifest;
		expect(sha256(packManifestText(manifest))).toBe(p.manifestSha256);
		expect(manifest.pack).toEqual({ id: p.id, version: 1, supersedes: null });
		expect(manifest.report.identity.baseline.runId).toBe(baseRun);
		expect(read.body.manifestMatches).toBe(true);
		// The issue checklist is an editor's (only editors issue); a viewer gets null.
		expect(read.body.issue).toBeNull();
		expect((await editor.call('GET', packPath(p.id))).body.issue).toEqual({ issuable: true, signed: false, runsVerified: true, errataRecorded: true });
	});

	it('freezes an application pack’s licence impact board in the manifest, and its hash still survives storage (evidence-5)', async () => {
		const p = await draft(editor, appRun);
		const read = await viewer.call('GET', packPath(p.id));
		const manifest = read.body.manifest as PackManifest;
		expect(read.body.manifestMatches).toBe(true);
		expect(manifest.report.version).toBe('evidence-12');
		// The board's floats (the waterfall's means) round-trip through jsonb and re-hash.
		expect(manifest.report.licenceImpact?.result.status).toBe('ok');
		const live = (await viewer.call('GET', `${runPath(appRun)}/evidence-report`)).body.report;
		expect(manifest.report.licenceImpact).toEqual(live.licenceImpact);
		// § 1's paired FDC change (evidence-7) freezes with it, whatever it holds for this run.
		expect(manifest.report.river.map((s) => s.fdcChange)).toEqual(live.river.map((s: { fdcChange?: unknown }) => s.fdcChange));
		// § 6 the applicant's demand objects (evidence-9) freezes with it too.
		expect(manifest.report.demandObjects).toEqual(live.demandObjects);
		expect(manifest.report.demandObjects?.notAssessed).toMatch(/^Not assessed/);
		expect((await editor.call('DELETE', packPath(p.id))).status).toBe(204);
	});

	it('still matches a pack drafted before evidence-9 to its hash: its stored manifest has no § 6, and nothing rebuilds it', async () => {
		// A draft of today's report, deleted again, lends its manifest to the evidence-8 pack stored below.
		const p = await draft(editor, appRun);
		const read0 = (await editor.call('GET', packPath(p.id))).body;
		const now = read0.manifest as PackManifest;
		expect((await editor.call('DELETE', packPath(p.id))).status).toBe(204);
		// The pack as an evidence-8 draft froze it: the same report without demandObjects, under its own id and hash.
		const id = crypto.randomUUID();
		const { demandObjects: _, ...report } = now.report;
		const old = { ...now, pack: { ...now.pack, id }, report: { ...report, version: 'evidence-8' } } as unknown as PackManifest;
		const hash = sha256(packManifestText(old));
		await asOwner(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, scenario_id, scenario_run_id, version, manifest, manifest_sha256, report_version, engine_version, created_by)
			 VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 'evidence-8', $8, $9)`,
			[id, projectId, baseRun, read0.pack.scenarioId, appRun, JSON.stringify(old), hash, now.engine.version, editor.id]
		);
		try {
			const read = (await viewer.call('GET', packPath(id))).body;
			expect(read.manifestMatches).toBe(true);
			expect(read.pack.manifestSha256).toBe(hash);
			expect(read.manifest.report.version).toBe('evidence-8');
			expect('demandObjects' in read.manifest.report).toBe(false);
			// Positive control: the live report has § 6.
			expect((await viewer.call('GET', `${runPath(appRun)}/evidence-report`)).body.report.demandObjects).not.toBeUndefined();
		} finally {
			expect((await editor.call('DELETE', packPath(id))).status).toBe(204);
		}
	});

	it('freezes § 1’s locality map with its SVG’s SHA-256; moving a feature changes the live report, not the pack (evidence-12)', async () => {
		const features = await seedLocality();
		try {
			const p = await draft(editor, appRun);
			const read = (await viewer.call('GET', packPath(p.id))).body;
			expect(read.manifestMatches).toBe(true);
			const loc = (read.manifest as PackManifest).report.localityMap!;
			expect(loc.features.map((f) => [f.layer, f.label])).toEqual([
				['boundary', null],
				['applicantParcel', 'Upper']
			]);
			expect(loc.svgSha256).toBe(sha256(localityMapSvg(loc).svg));
			// The parcel moves: the live report draws it elsewhere, the pack keeps what it froze.
			const moved = await owner.call('PATCH', `${at()}/map/features/${features[1]}`, { geometry: { type: 'Polygon', coordinates: [square(21.35, -33.69, 0.03)] } });
			expect(moved.status, JSON.stringify(moved.body)).toBe(200);
			const live = ((await viewer.call('GET', `${runPath(appRun)}/evidence-report`)).body.report as PackManifest['report']).localityMap!;
			expect(live.svgSha256).not.toBe(loc.svgSha256);
			const again = (await viewer.call('GET', packPath(p.id))).body;
			expect(again.manifestMatches).toBe(true);
			expect((again.manifest as PackManifest).report.localityMap).toEqual(loc);
			expect((await editor.call('DELETE', packPath(p.id))).status).toBe(204);
		} finally {
			await dropFeatures(features);
		}
	});

	it('still matches a pack drafted before evidence-12 to its hash: its stored manifest has no locality map, and nothing rebuilds it', async () => {
		const features = await seedLocality();
		try {
			const p = await draft(editor, appRun);
			const read0 = (await editor.call('GET', packPath(p.id))).body;
			const now = read0.manifest as PackManifest;
			expect(now.report.localityMap).toBeTruthy();
			expect((await editor.call('DELETE', packPath(p.id))).status).toBe(204);
			// The pack as an evidence-10 draft froze it: the same report without localityMap, under its own id and hash.
			const id = crypto.randomUUID();
			const { localityMap: _, ...report } = now.report;
			const old = { ...now, pack: { ...now.pack, id }, report: { ...report, version: 'evidence-10' } } as unknown as PackManifest;
			const hash = sha256(packManifestText(old));
			await asOwner(
				`INSERT INTO evidence_pack (id, project_id, baseline_run_id, scenario_id, scenario_run_id, version, manifest, manifest_sha256, report_version, engine_version, created_by)
				 VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 'evidence-10', $8, $9)`,
				[id, projectId, baseRun, read0.pack.scenarioId, appRun, JSON.stringify(old), hash, now.engine.version, editor.id]
			);
			try {
				const read = (await viewer.call('GET', packPath(id))).body;
				expect(read.manifestMatches).toBe(true);
				expect(read.pack.manifestSha256).toBe(hash);
				expect('localityMap' in read.manifest.report).toBe(false);
			} finally {
				expect((await editor.call('DELETE', packPath(id))).status).toBe(204);
			}
		} finally {
			await dropFeatures(features);
		}
	});

	it('freezes Appendix C’s fixed prompts in the manifest: a later answer changes the live report, not the pack (evidence-8)', async () => {
		const p = await draft(editor, appRun);
		const sid = (await editor.call('GET', packPath(p.id))).body.pack.scenarioId as string;
		const frozen = { purposeAndNeed: 'Winter storage.', mitigation: '', monitoring: '' };
		expect(((await viewer.call('GET', packPath(p.id))).body.manifest as PackManifest).report.applicantStatement?.prompts).toEqual(frozen);
		const changed = await owner.call('PATCH', `${at()}/scenarios/${sid}`, { mitigation: 'Release 10 % of inflow in the dry months.' });
		expect(changed.status, JSON.stringify(changed.body)).toBe(200);
		try {
			// The live report reads the new answer (positive control) …
			expect((await viewer.call('GET', `${runPath(appRun)}/evidence-report`)).body.report.applicantStatement.prompts.mitigation).toBe(
				'Release 10 % of inflow in the dry months.'
			);
			// … and the pack still holds what it froze, under the same hash.
			const read = (await viewer.call('GET', packPath(p.id))).body;
			expect((read.manifest as PackManifest).report.applicantStatement?.prompts).toEqual(frozen);
			expect(read.manifestMatches).toBe(true);
			expect(read.pack.manifestSha256).toBe(p.manifestSha256);
		} finally {
			expect((await owner.call('PATCH', `${at()}/scenarios/${sid}`, { mitigation: '' })).status).toBe(200);
			expect((await editor.call('DELETE', packPath(p.id))).status).toBe(204);
		}
	});

	it('drafts an application pack on the scenario run, naming its scenario', async () => {
		const p = await draft(editor, appRun);
		const read = (await editor.call('GET', packPath(p.id))).body;
		expect(read.pack).toMatchObject({ mode: 'application', baselineRunId: baseRun, scenarioRunId: appRun, title: 'Upper dam' });
		expect(read.pack.scenarioId).toBeTruthy();
	});

	it('refuses a report that can’t be issued (a run that isn’t the nominated one), naming the checks', async () => {
		const res = await editor.call('POST', `${at()}/packs`, { runId: seedRun });
		expect(res.status).toBe(409);
		expect(res.body.details.checks.map((k: { id: string }) => k.id)).toContain('nominated');
	});

	it('refuses an application whose own river pump has no capacity and leaves the EWR unprotected, naming exactly those checks; capped and protected, it drafts (positive control)', async () => {
		// Each run's stored model is what the checks read (issue #54, #90 Q15 and Q16, evidence-10).
		const open = await scenarioRun('Upper pump', PUMP);
		const res = await editor.call('POST', `${at()}/packs`, { runId: open });
		expect(res.status).toBe(409);
		const failing = res.body.details.checks as { id: string; detail: string; fix: string }[];
		// The paired band is there, so the river checks are all that stop it.
		expect(failing.map((k) => k.id).sort()).toEqual(['protectsEwr', 'pumpCapacity']);
		expect(failing.find((k) => k.id === 'pumpCapacity')!.detail).toMatch(/^The application: Upper’s river pump\. /);
		expect(failing.find((k) => k.id === 'protectsEwr')!.detail).toMatch(/^Upper’s river pump keeps neither the EWR nor a hands-off flow/);
		const capped = await scenarioRun('Upper pump, capped', [...PUMP, ...PROTECT]);
		const live = (await viewer.call('GET', `${runPath(capped)}/evidence-report`)).body.report;
		expect(live.checks.filter((k: { id: string }) => k.id === 'pumpCapacity' || k.id === 'protectsEwr').map((k: { passed: boolean }) => k.passed)).toEqual([true, true]);
		const ok = await draft(editor, capped);
		expect((await editor.call('DELETE', packPath(ok.id))).status).toBe(204);
	});

	it('refuses to issue a pack drafted before evidence-10 on an uncapped pump: its frozen report lacks the checks, the live report has them', async () => {
		const open = await scenarioRun('Upper pump, old draft', PUMP);
		// The pack as an evidence-9 draft froze it: the live report without the two checks, which then passed every check.
		const template = await draft(editor, await scenarioRun('Upper pump, template', [...PUMP, ...PROTECT]));
		const now = (await editor.call('GET', packPath(template.id))).body.manifest as PackManifest;
		expect((await editor.call('DELETE', packPath(template.id))).status).toBe(204);
		const live = (await viewer.call('GET', `${runPath(open)}/evidence-report`)).body.report as PackManifest['report'];
		const id = crypto.randomUUID();
		const checks = live.checks.filter((k) => k.id !== 'pumpCapacity' && k.id !== 'protectsEwr');
		const old = { ...now, pack: { ...now.pack, id }, report: { ...live, version: 'evidence-9', checks, issuable: true } } as unknown as PackManifest;
		const sid = (await asOwner('SELECT scenario_id FROM model_run WHERE id = $1', [open]))[0]!.scenario_id as string;
		await asOwner(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, scenario_id, scenario_run_id, version, manifest, manifest_sha256, report_version, engine_version, created_by)
			 VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 'evidence-9', $8, $9)`,
			[id, projectId, baseRun, sid, open, JSON.stringify(old), sha256(packManifestText(old)), now.engine.version, editor.id]
		);
		try {
			// Its frozen report may be issued (the checklist says so), and it is signed.
			expect((await editor.call('GET', packPath(id))).body.issue).toMatchObject({ issuable: true });
			await sign(editor, id);
			const res = await issue(editor, id);
			expect(res.status).toBe(409);
			expect(res.body.error).toMatch(/since its draft was made/);
			expect((res.body.details.checks as { id: string }[]).map((k) => k.id).sort()).toEqual(['protectsEwr', 'pumpCapacity']);
			expect((await asOwner('SELECT status FROM evidence_pack WHERE id = $1', [id]))[0]!.status).toBe('draft');
		} finally {
			// A signed draft is kept, never deleted: withdrawn, so nothing later meets it.
			expect((await editor.call('POST', `${packPath(id)}/withdraw`, { reason: 'test: an old draft on an uncapped pump' })).status).toBe(200);
		}
	});

	it('keeps a pack drafted before evidence-11 as it froze it: the summed row and its hash, never rebuilt with the combined run (C26)', async () => {
		const template = await draft(editor, appRun);
		const now = (await editor.call('GET', packPath(template.id))).body.manifest as PackManifest;
		expect((await editor.call('DELETE', packPath(template.id))).status).toBe(204);
		// Positive control: today's draft carries the combined run and its row.
		expect(now.report.cumulative.combined).toBeDefined();
		expect(now.report.rows.find((x) => x.id === 'otherApplications')?.label).toBe('This and the other applications on this baseline, together');
		const { combined: _combined, ...cumulative } = now.report.cumulative;
		void _combined;
		const summed = {
			...now.report.rows.find((x) => x.id === 'otherApplications')!,
			label: 'Other applications on this baseline, summed',
			basis: 'Days below the pragmatic EWR at the outlet: other applications’ own changes, added up; not one combined run (WP-3.11)'
		};
		const id = crypto.randomUUID();
		const old = {
			...now,
			pack: { ...now.pack, id },
			report: { ...now.report, version: 'evidence-10', cumulative, rows: now.report.rows.map((x) => (x.id === 'otherApplications' ? summed : x)) }
		} as unknown as PackManifest;
		const sid = (await asOwner('SELECT scenario_id FROM model_run WHERE id = $1', [appRun]))[0]!.scenario_id as string;
		const sha = sha256(packManifestText(old));
		await asOwner(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, scenario_id, scenario_run_id, version, manifest, manifest_sha256, report_version, engine_version, created_by)
			 VALUES ($1, $2, $3, $4, $5, 1, $6, $7, 'evidence-10', $8, $9)`,
			[id, projectId, baseRun, sid, appRun, JSON.stringify(old), sha, now.engine.version, editor.id]
		);
		try {
			const read = await viewer.call('GET', packPath(id));
			expect(read.status).toBe(200);
			expect(read.body.manifestMatches).toBe(true);
			expect(read.body.pack.manifestSha256).toBe(sha);
			const got = read.body.manifest as PackManifest;
			expect(got).toEqual(old);
			expect(got.report.cumulative).not.toHaveProperty('combined');
			expect(got.report.rows.find((x) => x.id === 'otherApplications')?.label).toBe('Other applications on this baseline, summed');
		} finally {
			expect((await editor.call('DELETE', packPath(id))).status).toBe(204);
		}
	});

	it('lets viewers read and not draft; contributors and farmers get 403, a stranger 404', async () => {
		expect((await viewer.call('GET', `${at()}/packs`)).status).toBe(200);
		expect((await viewer.call('POST', `${at()}/packs`, { runId: baseRun })).status).toBe(403);
		for (const u of [contributor, farmer]) {
			expect((await u.call('GET', `${at()}/packs`)).status).toBe(403);
			expect((await u.call('POST', `${at()}/packs`, { runId: baseRun })).status).toBe(403);
		}
		expect((await stranger.call('GET', `${at()}/packs`)).status).toBe(404);
	});

	it('shows RLS no pack to a contributor or a farmer as water_app, and every pack to a viewer (positive control)', async () => {
		const count = async (u: User) =>
			(await withUser(u.id, (db) => db.query<{ n: number }>('SELECT count(*)::int AS n FROM evidence_pack WHERE project_id = $1', [projectId]))).rows[0]!.n;
		expect(await count(viewer)).toBeGreaterThan(0);
		expect(await count(contributor)).toBe(0);
		expect(await count(farmer)).toBe(0);
		expect(await count(stranger)).toBe(0);
	});
});

describe.skipIf(!minio)('issuing, superseding and withdrawing', () => {
	let v1: Awaited<ReturnType<typeof draft>>;
	let v2: Awaited<ReturnType<typeof draft>>;
	/** Errata "found" once v1 is issued: one for the runs' engine, and two that don't apply to them (a fit's, with no fit; one fixed before it). */
	const LATER: Erratum[] = [
		{ id: 'ER-991', keyedOn: 'run', firstAffected: ENGINE_VERSION, fixedIn: null, severity: 'High', appliesWhen: 'Always', summary: 'A bug found after issue', source: 'test' },
		{ id: 'ER-992', keyedOn: 'fit', firstAffected: '0.0.1', fixedIn: null, severity: 'Low', appliesWhen: 'A fit', summary: 'A fit bug', source: 'test' },
		{ id: 'ER-993', keyedOn: 'run', firstAffected: '0.0.1', fixedIn: ENGINE_VERSION, severity: 'Low', appliesWhen: 'Always', summary: 'Fixed before', source: 'test' }
	];

	beforeAll(async () => {
		v1 = await draft(owner, baseRun);
	});
	/** Found after a draft was made and before its issue: the draft can't be issued (pack_errata_since_draft). */
	const SINCE_DRAFT: Erratum = { id: 'ER-994', keyedOn: 'run', firstAffected: ENGINE_VERSION, fixedIn: null, severity: 'High', appliesWhen: 'Always', summary: 'A bug found before issue', source: 'test' };
	afterAll(() => {
		errataList.splice(0, errataList.length, ...errataList.filter((e) => !LATER.includes(e) && e !== SINCE_DRAFT));
	});

	it('refuses to issue without a sign-off of the current statement', async () => {
		const res = await issue(owner, v1.id);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/no sign-off/);
		// The trigger too, whoever writes (as water_app, past the route).
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evidence_pack SET status = 'issued' WHERE id = $1`, [v1.id]))).rejects.toMatchObject({ code: '23514' });
	});

	it('refuses a pack statement signed as a run statement, and a sign-off naming both targets', async () => {
		const row = (await asOwner('SELECT project_id FROM evidence_pack WHERE id = $1', [v1.id]))[0]!;
		const insert = (runId: string | null, packId: string | null, version: string) =>
			withUser(owner.id, (db) =>
				db.query(
					`INSERT INTO signoff (project_id, run_id, pack_id, user_id, full_name, registration_body, registration_category, registration_field, registration_no, scope,
						statement_version, statement_sha256, disclaimer_version)
					 VALUES ($1, $2, $3, app_current_user_id(), 'X', 'sacnasp', 'pr_sci_nat', 'water_resources', '1', 's', $4, $5, 'd')`,
					[row.project_id, runId, packId, version, 'a'.repeat(64)]
				)
			);
		await expect(insert(baseRun, v1.id, 'pack-signoff-1')).rejects.toMatchObject({ code: '23514' });
		await expect(insert(null, v1.id, 'signoff-4')).rejects.toMatchObject({ code: '23514' });
		await expect(insert(baseRun, null, 'pack-signoff-1')).rejects.toMatchObject({ code: '23514' });
		await expect(insert(null, null, 'signoff-4')).rejects.toMatchObject({ code: '23514' });
	});

	it('shows the pack statement, binding the manifest hash; a viewer reads it and can’t sign', async () => {
		const res = await viewer.call('GET', `${packPath(v1.id)}/signoffs`);
		expect(res.status).toBe(200);
		expect(res.body.statement).toMatchObject({ version: 'pack-signoff-1', packId: v1.id, manifestSha256: v1.manifestSha256 });
		expect(res.body.cannotSign).toBe('requires editor role');
		expect((await editor.call('GET', `${packPath(v1.id)}/signoffs`)).body.cannotSign).toBeNull();
	});

	it('issues a signed draft, stamping who and when', async () => {
		const s = await sign(editor, v1.id);
		expect(s).toMatchObject({ packId: v1.id, runId: null, statementVersion: 'pack-signoff-1' });
		const res = await issue(owner, v1.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.pack).toMatchObject({ status: 'issued', issuedBy: 'PkOwner', signoffs: 1 });
		expect(res.body.pack.issuedAt).toBeTruthy();
		expect((await issue(owner, v1.id)).status).toBe(409);
		// The "pack issued" notice (133_pack_notices), queued with the issue: the other editor; not the issuer, a viewer, an applicant or a farmer.
		expect(await notices(v1.id)).toEqual([{ user_id: editor.id, event: 'issued', status: 'pending' }]);
	});

	it('stores the reproduction bundle at issue under its derived key; its hash is on the pack and on verify', async () => {
		const pack = (await viewer.call('GET', packPath(v1.id))).body.pack;
		expect(pack.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
		const row = (await asOwner('SELECT bundle_key, bundle_sha256 FROM evidence_pack WHERE id = $1', [v1.id]))[0]!;
		expect(row).toEqual({ bundle_key: `packs/${projectId}/${v1.id}/${pack.bundleSha256}.zip`, bundle_sha256: pack.bundleSha256 });
		expect((await anon('GET', `/verify/${v1.shortCode}`)).body.pack.bundleSha256).toBe(pack.bundleSha256);
		const issued = (await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'pack.issued' AND subject->>'packId' = $2`, [projectId, v1.id]))[0]!;
		expect(issued.subject.bundleSha256).toBe(pack.bundleSha256);
	});

	it('lists an erratum found after issue apart, on verify and the pack view, leaving what the manifest recorded and its hash as they were (132)', async () => {
		const before = (await anon('GET', `/verify/${v1.shortCode}`)).body.pack;
		expect(before.errataFoundSince).toEqual([]);
		// The baseline's parameters were entered, not fitted: a fit erratum can't apply to it.
		expect((await asOwner(`SELECT inputs->'settings'->'fitRecord' AS fit FROM model_run WHERE id = $1`, [baseRun]))[0]!.fit).toBeNull();
		errataList.push(...LATER);
		const res = await anon('GET', `/verify/${v1.shortCode}`);
		expect(res.status).toBe(200);
		expect(res.body.pack.errataFoundSince).toEqual([{ id: 'ER-991', summary: 'A bug found after issue' }]);
		expect(res.body.pack.errata).toEqual(before.errata);
		expect(res.body.pack.manifestSha256).toBe(v1.manifestSha256);
		// The lookup's engines stay in the API.
		expect(Object.keys(res.body.pack)).not.toContain('runs');
		const detail = (await viewer.call('GET', packPath(v1.id))).body;
		expect(detail.errataFoundSince).toEqual([{ id: 'ER-991', summary: 'A bug found after issue' }]);
		expect((detail.manifest as PackManifest).report.verification.errata.map((e) => e.id)).not.toContain('ER-991');
		expect(detail.manifestMatches).toBe(true);
		// v2 (below) is drafted with ER-991 on the list, so records it: its verify lists it once, as recorded.
	});

	it('serves the bundle to a viewer as a download whose bytes hash to bundleSha256 and reproduce the run', async () => {
		const want = (await viewer.call('GET', packPath(v1.id))).body.pack.bundleSha256 as string;
		const { bytes, disposition } = await downloadBundle(viewer, v1.id);
		expect(bytesSha256(bytes)).toBe(want);
		expect(disposition).toBe(`attachment; filename="pack-${v1.shortCode}.zip"`);
		const hash = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');
		const checked = await checkPackBundle(bytes as Uint8Array<ArrayBuffer>, { hash, expectManifestSha256: v1.manifestSha256 });
		expect(checked.checks.filter((k) => !k.ok)).toEqual([]);
		expect(checked.checks.map((k) => k.id)).toContain('reproduce:baseline');
		expect(checked.ok).toBe(true);
	});

	it('refuses the bundle of a draft (409); contributors and farmers get 403, a stranger 404', async () => {
		const d = await draft(editor, baseRun);
		const res = await viewer.call('GET', `${packPath(d.id)}/bundle`);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/draft pack has no reproduction bundle/);
		for (const u of [contributor, farmer]) expect((await u.call('GET', `${packPath(v1.id)}/bundle`)).status).toBe(403);
		expect((await stranger.call('GET', `${packPath(v1.id)}/bundle`)).status).toBe(404);
		expect((await editor.call('DELETE', packPath(d.id))).status).toBe(204);
	});

	it('records a bundle only in the transaction that issues the pack, as an editor, once', async () => {
		const record = (u: User, packId: string, sha = 'b'.repeat(64)) => withUser(u.id, (db) => db.query('SELECT app_record_pack_bundle($1, $2) AS key', [packId, sha]));
		// After the issue's transaction: refused, though the owner issued it.
		await expect(record(owner, v1.id)).rejects.toMatchObject({ code: '23514' });
		// Not an editor: not permitted, whatever the pack.
		await expect(record(viewer, v1.id)).rejects.toMatchObject({ code: '42501' });
		await expect(record(stranger, v1.id)).rejects.toMatchObject({ code: '42501' });
		// A draft has no bundle.
		const d = await draft(editor, baseRun);
		await expect(record(editor, d.id)).rejects.toMatchObject({ code: '23514' });
		await expect(record(editor, d.id, 'not-a-hash')).rejects.toMatchObject({ code: '23514' });
		expect((await editor.call('DELETE', packPath(d.id))).status).toBe(204);
		// water_app can't name the columns; the guard holds for the schema owner (recorded once).
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evidence_pack SET bundle_key = 'k', bundle_sha256 = $2 WHERE id = $1`, [v1.id, 'c'.repeat(64)]))).rejects.toMatchObject({
			code: '42501'
		});
		await expect(asOwner(`UPDATE evidence_pack SET bundle_key = 'k', bundle_sha256 = $2 WHERE id = $1`, [v1.id, 'c'.repeat(64)])).rejects.toMatchObject({ code: '23514' });
		// Positive control: the issue itself recorded one (above), and it is unchanged.
		expect((await asOwner('SELECT bundle_sha256 FROM evidence_pack WHERE id = $1', [v1.id]))[0]!.bundle_sha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it('refuses a sign-off of an issued pack, through the route and the trigger', async () => {
		const res = await editor.call('GET', `${packPath(v1.id)}/signoffs`);
		expect(res.body.cannotSign).toMatch(/only a draft pack is signed/);
		const post = await editor.call('POST', `${packPath(v1.id)}/signoffs`, {
			fullName: 'Late',
			registrationBody: 'sacnasp',
			registrationCategory: 'pr_sci_nat',
			registrationField: 'water_resources',
			registrationNo: '1',
			scope: 's',
			confirmed: res.body.statement.confirmations.map((k: { id: string }) => k.id),
			statementSha256: res.body.statementSha256
		});
		expect(post.status).toBe(409);
		await expect(
			withUser(editor.id, (db) =>
				db.query(
					`INSERT INTO signoff (project_id, pack_id, user_id, full_name, registration_body, registration_category, registration_field, registration_no, scope,
						statement_version, statement_sha256, disclaimer_version)
					 VALUES ($1, $2, app_current_user_id(), 'X', 'sacnasp', 'pr_sci_nat', 'water_resources', '1', 's', 'pack-signoff-1', $3, 'd')`,
					[projectId, v1.id, 'a'.repeat(64)]
				)
			)
		).rejects.toMatchObject({ code: '23514' });
	});

	it('keeps an issued pack: no delete (route, RLS), no change to its manifest (grant, trigger), no way back to draft', async () => {
		expect((await owner.call('DELETE', packPath(v1.id))).status).toBe(409);
		const del = await withUser(owner.id, (db) => db.query('DELETE FROM evidence_pack WHERE id = $1', [v1.id]));
		expect(del.rowCount).toBe(0);
		// water_app may not even name the manifest in an UPDATE (column grants).
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evidence_pack SET manifest = '{}'::jsonb WHERE id = $1`, [v1.id]))).rejects.toMatchObject({ code: '42501' });
		// The guard holds for the schema owner too.
		await expect(asOwner(`UPDATE evidence_pack SET manifest = manifest || '{"x":1}'::jsonb WHERE id = $1`, [v1.id])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`UPDATE evidence_pack SET baseline_run_id = $2 WHERE id = $1`, [v1.id, seedRun])).rejects.toMatchObject({ code: '23514' });
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evidence_pack SET status = 'draft' WHERE id = $1`, [v1.id]))).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner(`UPDATE evidence_pack SET issued_by = NULL WHERE id = $1`, [v1.id])).rejects.toMatchObject({ code: '23514' });
		const read = await owner.call('GET', packPath(v1.id));
		expect(read.body.pack.status).toBe('issued');
		expect(read.body.manifestMatches).toBe(true);
	});

	it('deletes an unsigned draft (positive control), and keeps a signed one', async () => {
		const d = await draft(editor, baseRun);
		expect((await editor.call('DELETE', packPath(d.id))).status).toBe(204);
		expect((await editor.call('GET', packPath(d.id))).status).toBe(404);
		const signed = await draft(editor, baseRun);
		await sign(editor, signed.id);
		const res = await editor.call('DELETE', packPath(signed.id));
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/signed draft is kept/);
		// It is withdrawn instead: a draft may be.
		const w = await editor.call('POST', `${packPath(signed.id)}/withdraw`, { reason: 'drafted in error' });
		expect(w.status).toBe(200);
		expect(w.body.pack).toMatchObject({ status: 'withdrawn', issuedAt: null, statusReason: 'drafted in error' });
		// Never public, so nobody is told.
		expect(await notices(signed.id, 'withdrawn')).toEqual([]);
		// Never issued, so never public.
		expect((await anon('GET', `/verify/${signed.shortCode}`)).status).toBe(404);
	});

	it('verifies an issued pack by its short code or full hash, with only the printed fields; a draft or an unknown code is 404', async () => {
		const res = await anon('GET', `/verify/${v1.shortCode.toUpperCase()}`);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(Object.keys(res.body.pack).sort()).toEqual(
			[
				'catchment',
				'engineVersion',
				'errata',
				'errataFoundSince',
				'issuedAt',
				'bundleSha256',
				'manifestSha256',
				'methodology',
				'pdfSha256',
				'reportVersion',
				'shortCode',
				'signers',
				'status',
				'successorSha256',
				'version',
				'withdrawnReason'
			].sort()
		);
		expect(res.body.pack).toMatchObject({ status: 'issued', version: 1, catchment: 'Pack catchment', manifestSha256: v1.manifestSha256, successorSha256: null, withdrawnReason: null });
		expect(res.body.pack.signers).toEqual([
			expect.objectContaining({ fullName: 'Dr A. Hydrologist', registrationBody: 'sacnasp', registrationCategory: 'pr_sci_nat', registrationField: 'water_resources', registrationNo: '400999/20' })
		]);
		expect(Object.keys(res.body.pack.signers[0]).sort()).toEqual(['fullName', 'registrationBody', 'registrationCategory', 'registrationField', 'registrationNo', 'signedAt']);
		const text = JSON.stringify(res.body);
		for (const secret of [projectId, baseRun, v1.id, owner.email, editor.email, 'PkOwner', 'PkEditor']) expect(text).not.toContain(secret);
		expect((await anon('GET', `/verify/${v1.manifestSha256}`)).body.pack.version).toBe(1);
		const d = await draft(editor, baseRun);
		expect((await anon('GET', `/verify/${d.shortCode}`)).status).toBe(404);
		expect((await anon('GET', `/verify/${d.manifestSha256}`)).status).toBe(404);
		expect((await anon('GET', '/verify/0000-0000-0000')).status).toBe(404);
		expect((await anon('GET', '/verify/not-a-code')).status).toBe(404);
		expect((await editor.call('DELETE', packPath(d.id))).status).toBe(204);
	});

	// The PDF of the issued v1 (119_pack_render; docs/evidence-pack.md § The PDF), as production makes it.
	// The renderer's answer is recorded only when the packs bucket holds its PDF (MinIO here): skipped
	// locally without MinIO, and under CI a missing MinIO fails the file (ci.yml db-test starts it).
	describe.skipIf(!minio)('its PDF', () => {
		const PDF_BYTES = Buffer.from('the printed pack');
		const PDF_SHA = sha256('the printed pack');
		const pdfJobs = () =>
			asOwner(
				`SELECT status, dedupe_key AS "dedupeKey", acting_user_id AS "actingUserId", payload ? 'result' AS "isResult", last_error AS error,
					round(extract(epoch FROM run_after - created_at) / 60)::int AS "delayMin"
				 FROM job WHERE project_id = $1 AND kind = 'pack_render' AND payload->>'packId' = $2 ORDER BY created_at, id`,
				[projectId, v1.id]
			);
		const tick = () => runTick({ feeds: false, reports: false, alerts: false });
		const answer = (result: PackRenderResult) => acceptPackRenderResult({ v: 1, type: 'rendered_pack', packId: v1.id, result });
		const pdfState = async () => (await viewer.call('GET', packPath(v1.id))).body.pdf;
		/** A request carrying only a cookie (the render session's), as the headless browser sends it. */
		const asCookie = async (cookie: string, path: string) => (await app.request(path, { headers: { origin: 'http://localhost:7777', cookie } })).status;

		beforeAll(() => {
			vi.stubEnv('REPORT_RENDERER', 'sqs');
			vi.stubEnv('RENDER_REQUESTS_QUEUE_URL', 'memory://render-requests');
		});
		afterAll(() => {
			vi.unstubAllEnvs();
			sent.length = 0;
		});

		it('issuing queued one render, as the issuer, one per pack; the pack says it is rendering', async () => {
			expect(await pdfJobs()).toEqual([{ status: 'queued', dedupeKey: `pack_render:${v1.id}`, actingUserId: owner.id, isResult: false, error: null, delayMin: 0 }]);
			expect(await pdfState()).toEqual({ status: 'rendering', error: null });
			// No PDF yet: nothing to download, and nothing recorded.
			expect((await viewer.call('GET', `${packPath(v1.id)}/pdf`)).status).toBe(409);
			expect((await anon('GET', `/verify/${v1.shortCode}`)).body.pack.pdfSha256).toBeNull();
		});

		it('the render sends a render_pack request whose token opens a session reading this pack and nothing else', async () => {
			await tick();
			expect((await pdfJobs())[0]!.status).toBe('done');
			const requests = sent.filter((m) => m.type === 'render_pack');
			expect(requests).toHaveLength(1);
			const request = PackRenderRequestMessage.parse(requests[0]);
			expect(request).toMatchObject({ packId: v1.id, projectId });
			// Handed to the renderer: still rendering until its answer comes back.
			expect(await pdfState()).toEqual({ status: 'rendering', error: null });

			const exchanged = await anon('POST', '/auth/render-session', { token: request.token });
			expect(exchanged.status, JSON.stringify(exchanged.body)).toBe(200);
			const cookie = exchanged.headers.get('set-cookie')!.split(';')[0]!;
			expect(await asCookie(cookie, packPath(v1.id))).toBe(200);
			expect(await asCookie(cookie, `${packPath(v1.id)}/signoffs`)).toBe(200);
			for (const path of [at(), `${at()}/packs`, `${packPath(v1.id)}/pdf`, runPath(baseRun), `${at()}/series`, '/projects']) expect(await asCookie(cookie, path), path).toBe(403);
			// Single use.
			expect((await anon('POST', '/auth/render-session', { token: request.token })).body.code).toBe('render_token_refused');
		});

		it('a retryable failure asks again after two minutes', async () => {
			expect(await answer({ ok: false, error: 'the page took too long', retry: true })).toBe('queued');
			await tick();
			const jobs = await pdfJobs();
			expect(jobs.map((j) => [j.dedupeKey, j.status, j.isResult])).toEqual([
				[`pack_render:${v1.id}`, 'done', false],
				[`pack_result:${v1.id}`, 'done', true],
				[`pack_retry:${v1.id}:1`, 'queued', false]
			]);
			expect(jobs[2]!.delayMin).toBe(2);
			expect(await pdfState()).toEqual({ status: 'rendering', error: null });
		});

		it('a final failure fails the PDF with the renderer’s reason, and an editor may ask again (positive control: 202)', async () => {
			expect(await answer({ ok: false, error: 'the render session was refused', retry: false })).toBe('queued');
			await tick();
			expect((await pdfJobs()).at(-1)).toMatchObject({ isResult: true, status: 'dead', error: 'the renderer failed: the render session was refused' });
			expect(await pdfState()).toEqual({ status: 'failed', error: 'the renderer failed: the render session was refused' });
			// A viewer can't ask; an editor can.
			expect((await viewer.call('POST', `${packPath(v1.id)}/pdf`)).status).toBe(403);
			const again = await editor.call('POST', `${packPath(v1.id)}/pdf`);
			expect(again.status, JSON.stringify(again.body)).toBe(202);
			expect(await pdfState()).toEqual({ status: 'rendering', error: null });
			await tick();
			expect(sent.filter((m) => m.type === 'render_pack' && m.packId === v1.id)).toHaveLength(2);
		});

		it('the PDF only its render job records: not a member’s call, and not a job’s after the first', async () => {
			await expect(withUser(owner.id, (db) => db.query('SELECT app_record_pack_pdf($1, $2, 3)', [v1.id, PDF_SHA]))).rejects.toMatchObject({ code: '42501' });
			const [pack] = await asOwner('SELECT pdf_key, pdf_sha256 FROM evidence_pack WHERE id = $1', [v1.id]);
			expect(pack).toEqual({ pdf_key: null, pdf_sha256: null });
		});

		it('refuses an answer whose PDF the packs bucket does not hold under that hash: none there, or another checksum; nothing is recorded', async () => {
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			const forged = sha256('a print that was never stored');
			// No object under the claimed hash's key.
			expect(await answer({ ok: true, pages: 3, bytes: 10, ms: 1, sha256: forged })).toBe('queued');
			await tick();
			expect((await pdfJobs()).at(-1)).toMatchObject({ isResult: true, status: 'dead', error: expect.stringMatching(/does not hold; nothing was recorded/) });
			// An object under that key, but of other bytes (stored with their own, valid checksum).
			const other = Buffer.from('other bytes under the forged key');
			await rawS3().send(
				new PutObjectCommand({ Bucket: packsBucket(), Key: packPdfKey(projectId, v1.id, forged), Body: other, ChecksumSHA256: createHash('sha256').update(other).digest('base64') })
			);
			expect(await answer({ ok: true, pages: 3, bytes: 10, ms: 1, sha256: forged })).toBe('queued');
			await tick();
			expect((await pdfJobs()).at(-1)).toMatchObject({ isResult: true, status: 'dead', error: expect.stringMatching(/checksum is not the hash/) });
			const [pack] = await asOwner('SELECT pdf_key, pdf_sha256, pdf_pages FROM evidence_pack WHERE id = $1', [v1.id]);
			expect(pack).toEqual({ pdf_key: null, pdf_sha256: null, pdf_pages: null });
			expect((await anon('GET', `/verify/${v1.shortCode}`)).body.pack.pdfSha256).toBeNull();
			vi.restoreAllMocks();
		});

		it('records the renderer’s PDF once: its key, hash and pages, on the pack and on verify', async () => {
			// What the renderer did before answering: stored the PDF under its hash, with that checksum (positive control for the check above).
			await putPackPdf(packPdfKey(projectId, v1.id, PDF_SHA), PDF_BYTES, PDF_SHA);
			expect(await answer({ ok: true, pages: 7, bytes: 123_456, ms: 2_000, sha256: PDF_SHA })).toBe('queued');
			await tick();
			expect((await pdfJobs()).at(-1)).toMatchObject({ isResult: true, status: 'done' });
			const [pack] = await asOwner('SELECT pdf_key, pdf_sha256, pdf_pages FROM evidence_pack WHERE id = $1', [v1.id]);
			expect(pack).toEqual({ pdf_key: `packs/${projectId}/${v1.id}/${PDF_SHA}.pdf`, pdf_sha256: PDF_SHA, pdf_pages: 7 });
			expect(await pdfState()).toEqual({ status: 'ready', error: null });
			expect((await viewer.call('GET', packPath(v1.id))).body.pack).toMatchObject({ pdfSha256: PDF_SHA, pdfPages: 7 });
			expect((await anon('GET', `/verify/${v1.shortCode}`)).body.pack.pdfSha256).toBe(PDF_SHA);

			// A second answer (a redelivery, a late render) is about a pack with its PDF: dropped.
			expect(await answer({ ok: true, pages: 8, bytes: 1, ms: 1, sha256: sha256('another print') })).toBe('unknown_pack');
			// Even from a running render job of the pack, the first PDF stands (false, nothing changes).
			const { job } = await withUser(owner.id, (db) => enqueueJob(db, { projectId, kind: 'pack_render', payload: { packId: v1.id }, maxAttempts: 1 }));
			const jobId = job.id;
			await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '1 minute', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`, [jobId]);
			const second = await withUser(owner.id, (db) => db.query<{ r: boolean }>('SELECT app_record_pack_pdf($1, $2, 8) AS r', [v1.id, sha256('another print')]));
			expect(second.rows[0]!.r).toBe(false);
			await asOwner(`UPDATE job SET status = 'done', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE id = $1`, [jobId]);
			expect((await asOwner('SELECT pdf_sha256 FROM evidence_pack WHERE id = $1', [v1.id]))[0]!.pdf_sha256).toBe(PDF_SHA);
			// Nor may anyone ask for another print.
			const again = await editor.call('POST', `${packPath(v1.id)}/pdf`);
			expect(again.status).toBe(409);
			expect(again.body.error).toMatch(/recorded already/);
		});

		it('a viewer downloads it through a short-lived signed URL of the packs bucket; a contributor is refused, a stranger 404', async () => {
			const res = await app.request(`${packPath(v1.id)}/pdf`, { headers: { origin: 'http://localhost:7777', cookie: viewer.cookie } });
			expect(res.status).toBe(302);
			expect(res.headers.get('referrer-policy')).toBe('no-referrer');
			expect(res.headers.get('cache-control')).toBe('no-store');
			const location = res.headers.get('location')!;
			expect(location).toContain(`/water-packs/packs/${projectId}/${v1.id}/${PDF_SHA}.pdf?`);
			expect(location).toContain('X-Amz-Expires=60&');
			expect(location).toMatch(/filename%3D%22pack-catchment-evidence-pack-v1-[0-9a-f-]+\.pdf%22/);
			expect((await contributor.call('GET', `${packPath(v1.id)}/pdf`)).status).toBe(403);
			expect((await farmer.call('GET', `${packPath(v1.id)}/pdf`)).status).toBe(403);
			expect((await stranger.call('GET', `${packPath(v1.id)}/pdf`)).status).toBe(404);
		});

		it('a draft has no PDF: no download, no render asked, no render token (409s, the trigger)', async () => {
			const d = await draft(editor, baseRun);
			expect((await viewer.call('GET', `${packPath(d.id)}/pdf`)).status).toBe(409);
			const ask = await editor.call('POST', `${packPath(d.id)}/pdf`);
			expect(ask.status).toBe(409);
			expect(ask.body.error).toMatch(/never issued/);
			expect((await editor.call('GET', packPath(d.id))).body.pdf).toEqual({ status: 'none', error: null });
			await expect(
				withUser(editor.id, (db) =>
					db.query(`INSERT INTO render_token (token_hash, user_id, project_id, pack_id, expires_at) VALUES ($1, app_current_user_id(), $2, $3, now())`, [
						Buffer.alloc(32, 7),
						projectId,
						d.id
					])
				)
			).rejects.toMatchObject({ code: '23514' });
			expect((await editor.call('DELETE', packPath(d.id))).status).toBe(204);
		});
	});

	// The server's re-run of v1's runs from its stored bundle (154_pack_reproduce; docs/evidence-pack.md § Reproduction).
	describe.skipIf(!minio)('its server re-run', () => {
		const reproduceJobs = () =>
			asOwner(
				`SELECT status, dedupe_key AS "dedupeKey", acting_user_id AS "actingUserId", max_attempts AS "maxAttempts", last_error AS error
				 FROM job WHERE project_id = $1 AND kind = 'pack_reproduce' AND payload->>'packId' = $2 ORDER BY created_at, id`,
				[projectId, v1.id]
			);
		// REPORT_RENDERER=sqs, so a render this tick may claim is a captured message, never a Chromium print.
		beforeAll(() => {
			vi.stubEnv('REPORT_RENDERER', 'sqs');
			vi.stubEnv('RENDER_REQUESTS_QUEUE_URL', 'memory://render-requests');
		});
		afterAll(() => {
			vi.unstubAllEnvs();
			sent.length = 0;
		});

		it('issuing queued one re-run as the issuer; the tick records it reproduced, with this engine and every check, for whoever reads the pack', async () => {
			// The PDF tests' ticks above may have run it already; one more runs it if not.
			await runTick({ feeds: false, reports: false, alerts: false });
			expect(await reproduceJobs()).toEqual([{ status: 'done', dedupeKey: `pack_reproduce:${v1.id}`, actingUserId: owner.id, maxAttempts: 3, error: null }]);
			const { reproduction } = (await viewer.call('GET', packPath(v1.id))).body;
			expect(reproduction).toMatchObject({ status: 'reproduced', engineVersion: ENGINE_VERSION, runEngines: [ENGINE_VERSION], error: null });
			expect(reproduction.checkedAt).toBeTruthy();
			expect(reproduction.checks.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining(['stored', 'files', 'manifest', 'results:baseline', 'reproduce:baseline']));
			expect(reproduction.checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
			const [row] = await asOwner('SELECT outcome, engine_version, bundle_sha256 FROM pack_reproduction WHERE pack_id = $1', [v1.id]);
			expect(row).toEqual({ outcome: 'reproduced', engine_version: ENGINE_VERSION, bundle_sha256: (await viewer.call('GET', packPath(v1.id))).body.pack.bundleSha256 });
			// Not on verify: it is the app's own claim, not something the pack's hash covers.
			expect(JSON.stringify((await anon('GET', `/verify/${v1.shortCode}`)).body)).not.toMatch(/reproduc/i);
			// Nobody outside the pack's readers sees it.
			for (const u of [contributor, farmer]) expect((await u.call('GET', packPath(v1.id))).status).toBe(403);
			expect(await withUser(stranger.id, async (db) => (await db.query('SELECT 1 FROM pack_reproduction WHERE pack_id = $1', [v1.id])).rowCount)).toBe(0);
			expect(await withUser(viewer.id, async (db) => (await db.query('SELECT 1 FROM pack_reproduction WHERE pack_id = $1', [v1.id])).rowCount)).toBe(1);
		});

		it('records an outcome only from the pack’s own running re-run job, of the bundle it records, once per engine', async () => {
			const recordAs = (u: User, bundle: string | null, outcome = 'reproduced', engine = ENGINE_VERSION) =>
				withUser(u.id, (db) =>
					db.query<{ r: boolean }>('SELECT app_record_pack_reproduction($1, $2, $3, $4, $5, $6) AS r', [v1.id, outcome, engine, [engine], bundle, '[]'])
				);
			const bundle = (await asOwner('SELECT bundle_sha256 FROM evidence_pack WHERE id = $1', [v1.id]))[0]!.bundle_sha256 as string;
			// A member's call, outside any job: refused; and water_app can't write the table at all.
			await expect(recordAs(owner, bundle, 'reproduced', 'forged-engine')).rejects.toMatchObject({ code: '42501' });
			await expect(
				withUser(owner.id, (db) =>
					db.query(`INSERT INTO pack_reproduction (project_id, pack_id, outcome, engine_version, bundle_sha256, checks) VALUES ($1, $2, 'reproduced', 'x', $3, '[]')`, [projectId, v1.id, bundle])
				)
			).rejects.toMatchObject({ code: '42501' });
			// From a running re-run job of the pack, as its acting user (positive control: past the job check).
			const { job } = await withUser(owner.id, (db) => enqueueJob(db, { projectId, kind: 'pack_reproduce', payload: { packId: v1.id }, maxAttempts: 1 }));
			await asOwner(`UPDATE job SET status = 'running', locked_until = now() + interval '1 minute', lease_token = gen_random_uuid(), started_at = now() WHERE id = $1`, [job.id]);
			try {
				// Another member, not the job's user: refused.
				await expect(recordAs(editor, bundle, 'reproduced', 'other-engine')).rejects.toMatchObject({ code: '42501' });
				// Another bundle than the pack's, or no_bundle for a pack with one: refused.
				await expect(recordAs(owner, 'c'.repeat(64), 'reproduced', 'other-engine')).rejects.toMatchObject({ code: '23514' });
				await expect(recordAs(owner, null, 'no_bundle', 'other-engine')).rejects.toMatchObject({ code: '23514' });
				// This engine's outcome stands: false, nothing changes.
				expect((await recordAs(owner, bundle, 'not_reproduced')).rows[0]!.r).toBe(false);
				expect((await asOwner('SELECT outcome FROM pack_reproduction WHERE pack_id = $1', [v1.id])).map((r) => r.outcome)).toEqual(['reproduced']);
			} finally {
				await asOwner(`UPDATE job SET status = 'done', finished_at = now(), locked_until = NULL, lease_token = NULL WHERE id = $1`, [job.id]);
			}
			// water_app can't change or remove a recorded outcome either: no UPDATE or DELETE grant.
			await expect(withUser(owner.id, (db) => db.query(`UPDATE pack_reproduction SET outcome = 'not_reproduced' WHERE pack_id = $1`, [v1.id]))).rejects.toMatchObject({ code: '42501' });
			await expect(withUser(owner.id, (db) => db.query('DELETE FROM pack_reproduction WHERE pack_id = $1', [v1.id]))).rejects.toMatchObject({ code: '42501' });
		});

		// An editor's "Re-run on the server" (POST …/reproduce): after the job gave up, or on a newer engine.
		it('re-runs again on request: refused while this engine’s outcome stands, queued once on a newer engine, recorded beside the old', async () => {
			const rerun = (u: User) => u.call('POST', `${packPath(v1.id)}/reproduce`);
			// This engine's outcome is recorded (above): it stands, so no re-run is offered or queued.
			expect((await viewer.call('GET', packPath(v1.id))).body.reproduction).toMatchObject({ status: 'reproduced', serverEngine: ENGINE_VERSION, canRerun: false });
			const refused = await rerun(editor);
			expect(refused.status).toBe(409);
			expect(refused.body.error).toMatch(/recorded already/);
			// Editor and above only (the role ladder sweeps the rest).
			expect((await viewer.call('POST', `${packPath(v1.id)}/reproduce`)).status).toBe(403);
			const pendingJobs = async () => (await reproduceJobs()).filter((j) => j.status !== 'done').map((j) => [j.status, j.actingUserId]);
			expect(await pendingJobs()).toEqual([]);
			// The server's engine moves on: the recorded outcome is now an older engine's.
			await asOwner(`UPDATE pack_reproduction SET engine_version = '0.0.1-older' WHERE pack_id = $1`, [v1.id]);
			expect((await viewer.call('GET', packPath(v1.id))).body.reproduction).toMatchObject({ status: 'reproduced', engineVersion: '0.0.1-older', canRerun: true });
			const asked = await rerun(editor);
			expect(asked.status).toBe(202);
			expect(asked.body.reproduction).toMatchObject({ status: 'checking', canRerun: false });
			// Idempotent while it is pending: the same job comes back, and nothing more is queued.
			const again = await rerun(owner);
			expect(again.status).toBe(202);
			expect(again.body.jobId).toBe(asked.body.jobId);
			expect(await pendingJobs()).toEqual([['queued', editor.id]]);
			await runTick({ feeds: false, reports: false, alerts: false });
			// Recorded beside the older engine's, not in place of it; the newest stands on the page.
			expect((await asOwner('SELECT engine_version, outcome FROM pack_reproduction WHERE pack_id = $1 ORDER BY checked_at', [v1.id])).map((r) => [r.engine_version, r.outcome])).toEqual([
				['0.0.1-older', 'reproduced'],
				[ENGINE_VERSION, 'reproduced']
			]);
			expect((await viewer.call('GET', packPath(v1.id))).body.reproduction).toMatchObject({ status: 'reproduced', engineVersion: ENGINE_VERSION, canRerun: false });
		});

		it('a re-run that gave up says so and may be asked for again (positive control: the next one records)', async () => {
			// This engine's outcome gone, and the newest job dead, as when the packs bucket was unreachable for all its attempts.
			await asOwner('DELETE FROM pack_reproduction WHERE pack_id = $1 AND engine_version = $2', [v1.id, ENGINE_VERSION]);
			await asOwner(
				`UPDATE job SET status = 'dead', last_error = 'the packs bucket was unreachable' WHERE id = (
					SELECT id FROM job WHERE project_id = $1 AND kind = 'pack_reproduce' AND payload->>'packId' = $2 ORDER BY created_at DESC, id DESC LIMIT 1)`,
				[projectId, v1.id]
			);
			expect((await viewer.call('GET', packPath(v1.id))).body.reproduction).toMatchObject({ status: 'failed', error: 'the packs bucket was unreachable', canRerun: true });
			const asked = await editor.call('POST', `${packPath(v1.id)}/reproduce`);
			expect(asked.status).toBe(202);
			await runTick({ feeds: false, reports: false, alerts: false });
			expect((await viewer.call('GET', packPath(v1.id))).body.reproduction).toMatchObject({ status: 'reproduced', engineVersion: ENGINE_VERSION, error: null, canRerun: false });
		});

		it('a draft is never re-run: no job, state none', async () => {
			const d = await draft(editor, baseRun);
			expect((await editor.call('GET', packPath(d.id))).body.reproduction).toEqual({
				status: 'none',
				engineVersion: null,
				runEngines: [],
				checkedAt: null,
				checks: [],
				error: null,
				serverEngine: ENGINE_VERSION,
				canRerun: false
			});
			// Nor asked for one: 409, and no job.
			expect((await editor.call('POST', `${packPath(d.id)}/reproduce`)).status).toBe(409);
			expect(await asOwner(`SELECT 1 FROM job WHERE kind = 'pack_reproduce' AND payload->>'packId' = $1`, [d.id])).toEqual([]);
			expect((await editor.call('DELETE', packPath(d.id))).status).toBe(204);
		});
	});

	it('refuses to issue a signed draft missing an erratum found since it was drafted (409 pack_errata_since_draft); drafted again, it issues (below)', async () => {
		const stale = await draft(editor, baseRun, v1.id);
		await sign(editor, stale.id);
		expect((await editor.call('GET', packPath(stale.id))).body.issue).toEqual({ issuable: true, signed: true, runsVerified: true, errataRecorded: true });
		errataList.push(SINCE_DRAFT);
		const detail = (await editor.call('GET', packPath(stale.id))).body;
		expect(detail.issue).toMatchObject({ signed: true, errataRecorded: false });
		expect(detail.errataFoundSince.map((e: { id: string }) => e.id)).toEqual(['ER-994']);
		const res = await issue(editor, stale.id);
		expect(res.status).toBe(409);
		expect(res.body.code).toBe('pack_errata_since_draft');
		expect(res.body.error).toMatch(/ER-994.*Draft the pack again/);
		// Nothing changed: still a draft, no bundle, v1 still the issued one.
		expect((await editor.call('GET', packPath(stale.id))).body.pack).toMatchObject({ status: 'draft', bundleSha256: null, issuedAt: null });
		expect((await editor.call('GET', packPath(v1.id))).body.pack.status).toBe('issued');
		// A signed draft is kept; it is withdrawn, and the next test drafts afresh (the positive control).
		expect((await editor.call('POST', `${packPath(stale.id)}/withdraw`, { reason: 'drafted again to record ER-994' })).status).toBe(200);
	});

	it('issues a new version, which supersedes the old one in the same step', async () => {
		v2 = await draft(editor, baseRun, v1.id);
		expect(v2).toMatchObject({ version: 2, supersedesId: v1.id });
		const manifest = (await editor.call('GET', packPath(v2.id))).body.manifest as PackManifest;
		expect(manifest.pack.supersedes).toEqual({ id: v1.id, manifestSha256: v1.manifestSha256 });
		// A version can't supersede a draft.
		expect((await editor.call('POST', `${at()}/packs`, { runId: baseRun, supersedesId: v2.id })).status).toBe(409);
		// Nor can a baseline pack be the next version of an application's.
		await sign(editor, v2.id);
		const res = await issue(editor, v2.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const old = (await owner.call('GET', packPath(v1.id))).body.pack;
		expect(old).toMatchObject({ status: 'superseded', supersededById: v2.id });
		const verified = await anon('GET', `/verify/${v1.shortCode}`);
		expect(verified.body.pack).toMatchObject({ status: 'superseded', successorSha256: v2.manifestSha256 });
		// An erratum on the list when v2 was drafted is recorded, so it isn't found since v2's issue; v1 still lists it as found since.
		const v2Verified = (await anon('GET', `/verify/${v2.shortCode}`)).body.pack;
		// Drafted afresh after ER-994 was found, it records it, so it issued (the refusal's positive control).
		expect(v2Verified.errata.map((e: { id: string }) => e.id)).toEqual(expect.arrayContaining(['ER-991', 'ER-994']));
		expect(v2Verified.errataFoundSince).toEqual([]);
		expect(verified.body.pack.errataFoundSince.map((e: { id: string }) => e.id)).toEqual(['ER-991', 'ER-994']);
		// Issued by the editor this time: the owner is told (the notice names the version it replaces); the superseded pack gets no notice of its own.
		expect(await notices(v2.id)).toEqual([{ user_id: owner.id, event: 'issued', status: 'pending' }]);
		expect((await notices(v1.id)).map((n) => n.event)).toEqual(['issued']);
	});

	it('withdraws an issued pack once, with its reason, and says so to verify', async () => {
		const res = await editor.call('POST', `${packPath(v2.id)}/withdraw`, { reason: 'the licence application lapsed' });
		expect(res.status).toBe(200);
		expect(res.body.pack).toMatchObject({ status: 'withdrawn', statusReason: 'the licence application lapsed' });
		expect((await editor.call('POST', `${packPath(v2.id)}/withdraw`, { reason: 'again' })).status).toBe(409);
		await expect(asOwner(`UPDATE evidence_pack SET status_reason = 'changed' WHERE id = $1`, [v2.id])).rejects.toMatchObject({ code: '23514' });
		expect((await anon('GET', `/verify/${v2.shortCode}`)).body.pack).toMatchObject({ status: 'withdrawn', withdrawnReason: 'the licence application lapsed' });
		expect(await notices(v2.id, 'withdrawn')).toEqual([{ user_id: owner.id, event: 'withdrawn', status: 'pending' }]);
		// The tick's send step (sendPackNotices, not the whole tick: v2's render job stays queued), as each recipient:
		// the owner's withdrawal email carries the public reason and verify link.
		await sendPackNotices();
		const mail = outbox.filter((m) => m.to === owner.email && m.kind === 'pack_notice').at(-1);
		expect(mail!.text).toContain('The reason given: “the licence application lapsed”');
		expect(mail!.text).toContain(`/verify/${v2.shortCode}`);
		expect(await notices(v2.id, 'withdrawn')).toEqual([{ user_id: owner.id, event: 'withdrawn', status: 'sent' }]);
		// A viewer can't withdraw (editor only).
		expect((await viewer.call('POST', `${packPath(v1.id)}/withdraw`, { reason: 'x' })).status).toBe(403);
	});

	it('records each step in the change history', async () => {
		const kinds = (await asOwner(`SELECT kind FROM audit_event WHERE project_id = $1 AND kind LIKE 'pack.%' ORDER BY id`, [projectId])).map((r) => r.kind);
		for (const k of ['pack.drafted', 'pack.issued', 'pack.superseded', 'pack.withdrawn', 'pack.deleted']) expect(kinds).toContain(k);
		const signed = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'signoff.created' AND subject ? 'packId' LIMIT 1`, [projectId]);
		expect(signed[0]!.subject.packId).toBeTruthy();
	});

	it('lists a pack sign-off in the signer’s data export, by pack', async () => {
		const res = await editor.call('GET', '/auth/me/export');
		expect(res.status).toBe(200);
		const s = res.body.signoffs.find((x: { packId: string | null }) => x.packId === v1.id);
		expect(s).toMatchObject({ runId: null, packId: v1.id, fullName: 'Dr A. Hydrologist' });
	});
});

describe.skipIf(!minio)('an application pack’s bundle', () => {
	let first: Awaited<ReturnType<typeof draft>>;

	it('carries the scenario and both runs, and reproduces both with the input changes the manifest lists, and the locality map draws again to its hash', async () => {
		// The map features are read at drafting: deleted after, the pack keeps its figure.
		const features = await seedLocality();
		const p = (first = await draft(editor, appRun));
		await dropFeatures(features);
		await sign(editor, p.id);
		const res = await issue(editor, p.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const { bytes } = await downloadBundle(viewer, p.id);
		expect(bytesSha256(bytes)).toBe(res.body.pack.bundleSha256);
		const hash = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');
		const checked = await checkPackBundle(bytes as Uint8Array<ArrayBuffer>, { hash, expectManifestSha256: p.manifestSha256 });
		expect(checked.checks.filter((k) => !k.ok)).toEqual([]);
		expect(checked.checks.map((k) => k.id)).toEqual(
			expect.arrayContaining(['figure:locality', 'changes', 'scenario', 'reproduce:baseline', 'reproduce:application'])
		);
		expect(checked.ok).toBe(true);
	});

	it('the server re-run records a stored bundle that isn’t the recorded bytes as not reproduced (the clean pack above reproduced)', async () => {
		vi.stubEnv('REPORT_RENDERER', 'sqs');
		vi.stubEnv('RENDER_REQUESTS_QUEUE_URL', 'memory://render-requests');
		const [row] = await asOwner('SELECT bundle_key, bundle_sha256 FROM evidence_pack WHERE id = $1', [first.id]);
		const { bytes: original } = await downloadBundle(viewer, first.id);
		// The stored object replaced by other bytes (MinIO has no Object Lock; production's bucket refuses this).
		const other = new TextEncoder().encode('not the bundle that was issued');
		const put = (body: Uint8Array) =>
			rawS3().send(new PutObjectCommand({ Bucket: packsBucket(), Key: row!.bundle_key, Body: body, ChecksumSHA256: createHash('sha256').update(body).digest('base64') }));
		try {
			await put(other);
			await runTick({ feeds: false, reports: false, alerts: false });
			const { reproduction } = (await editor.call('GET', packPath(first.id))).body;
			expect(reproduction).toMatchObject({ status: 'not_reproduced', engineVersion: ENGINE_VERSION, error: null });
			expect(reproduction.checks).toEqual([{ id: 'stored', ok: false, detail: `the stored bundle hashes to ${bytesSha256(other)}, not the pack’s recorded ${row!.bundle_sha256}` }]);
			expect((await asOwner(`SELECT status FROM job WHERE kind = 'pack_reproduce' AND payload->>'packId' = $1`, [first.id])).map((j) => j.status)).toEqual(['done']);
		} finally {
			await put(original);
			vi.unstubAllEnvs();
			sent.length = 0;
		}
	});

	it('issues nothing when the bundle can’t be stored; issued again with the store back, it is (positive control)', async () => {
		const v2 = await draft(editor, appRun, first.id);
		await sign(editor, v2.id);
		const state = async () => {
			const [row] = await asOwner('SELECT status, bundle_key, bundle_sha256, issued_at FROM evidence_pack WHERE id = $1', [v2.id]);
			const [pred] = await asOwner('SELECT status, superseded_by_pack_id FROM evidence_pack WHERE id = $1', [first.id]);
			const audit = await asOwner(`SELECT kind FROM audit_event WHERE project_id = $1 AND kind IN ('pack.issued', 'pack.superseded') AND subject->>'packId' IN ($2, $3)`, [projectId, v2.id, first.id]);
			const jobs = await asOwner(`SELECT kind FROM job WHERE project_id = $1 AND payload->>'packId' = $2`, [projectId, v2.id]);
			return { row, pred, audit: audit.map((a) => a.kind), jobs: jobs.map((j) => j.kind) };
		};
		const issuedBefore = (await asOwner(`SELECT count(*)::int AS n FROM audit_event WHERE project_id = $1 AND kind = 'pack.issued' AND subject->>'packId' = $2`, [projectId, first.id]))[0]!.n;
		// A store that answers nothing (a closed port), so the put fails inside the issue's transaction.
		vi.stubEnv('S3_ENDPOINT', 'http://127.0.0.1:9');
		resetStorageClient();
		try {
			const res = await issue(editor, v2.id);
			expect(res.status).toBeGreaterThanOrEqual(500);
			expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|water-packs/);
		} finally {
			vi.unstubAllEnvs();
			resetStorageClient();
		}
		const after = await state();
		expect(after.row).toEqual({ status: 'draft', bundle_key: null, bundle_sha256: null, issued_at: null });
		expect(after.pred).toEqual({ status: 'issued', superseded_by_pack_id: null });
		expect(after.audit.filter((k) => k === 'pack.issued')).toHaveLength(issuedBefore);
		expect(after.audit).not.toContain('pack.superseded');
		expect(after.jobs).toEqual([]);

		// The store back: the same draft issues, supersedes the first, and records its bundle.
		const res = await issue(editor, v2.id);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		const done = await state();
		expect(done.row).toMatchObject({ status: 'issued', bundle_sha256: res.body.pack.bundleSha256 });
		expect(done.pred).toEqual({ status: 'superseded', superseded_by_pack_id: v2.id });
		expect(done.audit).toEqual(expect.arrayContaining(['pack.issued', 'pack.superseded']));
		// Withdrawn again, so the tests below find only baseline packs issued.
		expect((await editor.call('POST', `${packPath(v2.id)}/withdraw`, { reason: 'test application pack' })).status).toBe(200);
	});

	it('stores a key once: a second put of the same bytes (an issue that rolled back after its put) is taken as stored', async () => {
		const bytes = new TextEncoder().encode(`bundle ${crypto.randomUUID()}`);
		const sha = bytesSha256(bytes);
		const key = packBundleKey(projectId, crypto.randomUUID(), sha);
		await putPackBundle(key, bytes, sha);
		// If-None-Match: '*' refuses the overwrite (412), which putPackBundle takes as stored.
		await expect(putPackBundle(key, bytes, sha)).resolves.toBeUndefined();
		// Positive control: bytes that aren't the hash are refused by the store, conditional write or not.
		const other = packBundleKey(projectId, crypto.randomUUID(), sha);
		await expect(putPackBundle(other, new TextEncoder().encode('not those bytes'), sha)).rejects.toThrow();
	});
});

describe('the runs a pack cites', () => {
	it('keeps them through the storage cap, and the run DELETE names the pack', async () => {
		const cited = await asOwner('SELECT model_run_cited($1) AS b, model_run_cited($2) AS a, model_run_cited($3) AS s', [baseRun, appRun, seedRun]);
		expect(cited[0]).toMatchObject({ b: true, a: true });
		const removed = await withUser(owner.id, (db) => trimRuns(db, projectId, 0));
		expect(removed).not.toContain(baseRun);
		expect(removed).not.toContain(appRun);
		const res = await owner.call('DELETE', runPath(appRun));
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/evidence pack version/);
	});

	it('keeps the application’s scenario while a pack cites it', async () => {
		const sid = (await asOwner('SELECT scenario_id FROM evidence_pack WHERE scenario_run_id = $1 LIMIT 1', [appRun]))[0]!.scenario_id;
		const res = await owner.call('DELETE', `${at()}/scenarios/${sid}`);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/evidence pack/);
	});
});

describe.skipIf(!minio)('an account deletion', () => {
	it('clears who drafted and issued a pack, and nothing else', async () => {
		const issuer = await signUp('PkIssuer');
		expect((await owner.call('POST', `${at()}/members`, { email: issuer.email, role: 'editor' })).status).toBe(201);
		const p = await draft(issuer, baseRun);
		await sign(owner, p.id);
		expect((await issue(issuer, p.id)).status).toBe(200);
		const before = (await asOwner('SELECT * FROM evidence_pack WHERE id = $1', [p.id]))[0]!;
		expect(before).toMatchObject({ created_by: issuer.id, issued_by: issuer.id, status: 'issued' });
		await asOwner('DELETE FROM app_user WHERE id = $1', [issuer.id]);
		const after = (await asOwner('SELECT * FROM evidence_pack WHERE id = $1', [p.id]))[0]!;
		expect(after).toEqual({ ...before, created_by: null, issued_by: null });
	});

	it('refuses a manifest that names another pack, and a new version of another subject (the guard)', async () => {
		const issued = (await asOwner(`SELECT id, version FROM evidence_pack WHERE project_id = $1 AND status = 'issued' AND scenario_id IS NULL LIMIT 1`, [projectId]))[0]!;
		const sid = (await asOwner('SELECT scenario_id FROM model_run WHERE id = $1', [appRun]))[0]!.scenario_id as string;
		const plant = (o: { manifestId?: string; version: number; supersedes: string | null; scenario: boolean }) => {
			const id = crypto.randomUUID();
			const manifest = { pack: { id: o.manifestId ?? id, version: o.version }, project: { id: projectId }, engine: { version: 'x' }, report: { version: 'evidence-1' } };
			return withUser(owner.id, (db) =>
				db.query(
					`INSERT INTO evidence_pack (id, project_id, baseline_run_id, scenario_id, scenario_run_id, version, supersedes_pack_id, manifest, manifest_sha256, report_version, engine_version, created_by)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, md5(random()::text) || md5(random()::text), 'evidence-1', 'x', app_current_user_id())`,
					[id, projectId, baseRun, o.scenario ? sid : null, o.scenario ? appRun : null, o.version, o.supersedes, JSON.stringify(manifest)]
				)
			);
		};
		await expect(plant({ manifestId: crypto.randomUUID(), version: 1, supersedes: null, scenario: false })).rejects.toMatchObject({ code: '23514' });
		await expect(plant({ version: issued.version + 1, supersedes: issued.id, scenario: true })).rejects.toMatchObject({ code: '23514' });
		// Positive control: a well-formed baseline draft goes in (deleted again below).
		const ok = await plant({ version: issued.version + 1, supersedes: issued.id, scenario: false });
		expect(ok.rowCount).toBe(1);
		await asOwner(`DELETE FROM evidence_pack WHERE supersedes_pack_id = $1 AND status = 'draft' AND engine_version = 'x'`, [issued.id]);
		// Nor may an editor record a PDF hash (verify prints it): no grant.
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evidence_pack SET pdf_key = 'k', pdf_sha256 = $2 WHERE id = $1`, [issued.id, 'a'.repeat(64)]))).rejects.toMatchObject({ code: '42501' });
	});

	it('allows one issued pack per application or baseline: a second is refused, a new version is the way (positive control)', async () => {
		const second = await draft(owner, baseRun);
		await sign(owner, second.id);
		const res = await issue(owner, second.id);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/is issued; draft a new version/);
		// The database holds it too, whoever writes (checked at commit).
		await expect(withUser(owner.id, (db) => db.query(`UPDATE evidence_pack SET status = 'issued' WHERE id = $1`, [second.id]))).rejects.toMatchObject({ code: '23P01' });
		expect((await owner.call('POST', `${packPath(second.id)}/withdraw`, { reason: 'a second pack in error' })).status).toBe(200);
	});
});

describe.skipIf(!minio)('deleting a project with packs', () => {
	/** A small project of its own, with a run and no nomination, so only the pack decides whether it goes. */
	async function smallProject(name: string) {
		const id = (await owner.call('POST', '/projects', { name })).body.project.id as string;
		const o = node('Weir', null);
		const f = node('Farm', o.id, { areaKm2: 5 });
		expect((await owner.call('PUT', `/projects/${id}/model`, { nodes: [o, f], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
		expect((await owner.call('PUT', `/projects/${id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: [1, 0, 3, 0, 2] })).status).toBe(200);
		const run = await owner.call('POST', `/projects/${id}/runs`, { label: 'r' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const packId = crypto.randomUUID();
		const hash = sha256(packId);
		await asOwner(
			`INSERT INTO evidence_pack (id, project_id, baseline_run_id, version, manifest, manifest_sha256, report_version, engine_version, created_by)
			 VALUES ($1::uuid, $2::uuid, $3, 1, jsonb_build_object('pack', jsonb_build_object('id', $1::text, 'version', 1), 'project', jsonb_build_object('id', $2::text), 'engine', jsonb_build_object('version', '0.0.0'), 'report', jsonb_build_object('version', 'evidence-1')), $4, 'evidence-1', '0.0.0', $5)`,
			[packId, id, run.body.run.id, hash, owner.id]
		);
		return { id, packId, runId: run.body.run.id as string };
	}

	it('refuses another project’s run or pack by the same owner (404), never the database’s words', async () => {
		const other = await smallProject('Other');
		const byRun = await owner.call('POST', `${at()}/packs`, { runId: other.runId });
		expect(byRun.status).toBe(404);
		const issued = (await asOwner(`SELECT id FROM evidence_pack WHERE project_id = $1 AND status = 'issued' LIMIT 1`, [projectId]))[0]!.id as string;
		await asOwner(`UPDATE evidence_pack SET status = 'withdrawn', status_reason = 'x' WHERE id = $1`, [other.packId]);
		const byPack = await owner.call('POST', `${at()}/packs`, { runId: baseRun, supersedesId: other.packId });
		expect(byPack.status).toBe(404);
		expect(JSON.stringify(byPack.body)).not.toMatch(/belongs to a different project|violates|foreign key/i);
		// Positive control: the project's own issued pack is found, and a new version drafted.
		const own = await owner.call('POST', `${at()}/packs`, { runId: baseRun, supersedesId: issued });
		expect(own.status, JSON.stringify(own.body)).toBe(201);
	});

	it('deletes a project whose only pack is a draft (positive control)', async () => {
		const { id } = await smallProject('Draft only');
		expect((await owner.call('DELETE', `/projects/${id}`)).status).toBe(204);
	});

	it('refuses a project with a pack past draft: the route (409) and the trigger', async () => {
		const { id, packId } = await smallProject('Kept');
		await asOwner(`UPDATE evidence_pack SET status = 'withdrawn', status_reason = 'test' WHERE id = $1`, [packId]);
		const res = await owner.call('DELETE', `/projects/${id}`);
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/evidence pack past draft/);
		await expect(asOwner('DELETE FROM project WHERE id = $1', [id])).rejects.toMatchObject({ code: '23001' });
	});

	it('refuses the pack catchment itself, with its issued packs', async () => {
		const res = await owner.call('DELETE', at());
		expect(res.status).toBe(409);
		expect(res.body.error).toMatch(/evidence pack/);
	});
});
