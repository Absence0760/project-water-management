// The reproduction bundle carries § 4's combined row (bundle-3,
// docs/evidence-pack.md § Reproduction, docs/followups.md § Cumulative
// impact): an evidence report whose combined row reads a cumulative
// assessment (two applicants' applications, a dam raised, a background at
// full allocation) builds a bundle that holds the assessment's members, its
// stored report and its background run's input, and checkPackBundle re-runs
// the job's own assessment offline to every row it stored: the outlet rows,
// the dam rows, the background's. A tampered member op or background input
// fails its check (beside the positive control); the pack_reproduce job's
// outcome reads the same checks; and an assessment gone before issue refuses
// the bundle. Synthetic catchment: invented names and values.
import { randomUUID } from 'node:crypto';
import { buildPackBundle, buildPackManifest, canonicalJson, checkPackBundle, ENGINE_VERSION, type PackBundleIndex, type PackManifest } from '@water-management/engine';
import { ZipArchive, zip } from '@water-management/engine/zip';
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { reproductionOutcome } from '../jobs/handlers/pack-reproduce.js';
import { runTick } from '../jobs/runner.js';
import { bundleHash, loadPackBundleInput } from './bundle.js';
import { buildEvidenceReport } from './report.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User;
let applicantA: User;
let applicantB: User;
let projectId: string;
let published: string;
let fullRun: string;
let appA: string;
let appB: string;
let appRun: string;
let assessmentId: string;
let manifest: PackManifest;
let bytes: Uint8Array<ArrayBuffer>;

const outlet = node('Outlet', null);
const welgemoed = node('Welgemoed', outlet.id, { damCapacityM3: 100_000, pctRunoffToDam: 1 });
const rietvallei = node('Rietvallei', outlet.id);
const lucerne = { id: randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

const P = () => `/projects/${projectId}`;
const tick = () => runTick({ feeds: false, reports: false, alerts: false });
const failing = (r: Awaited<ReturnType<typeof checkPackBundle>>) => r.checks.filter((c) => !c.ok).map((c) => c.id);

async function application(u: User, name: string, ops: unknown[]) {
	const res = await u.call('POST', `${P()}/scenarios`, { name, baseRunId: published, ops });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	const sid = res.body.scenario.id as string;
	expect((await u.call('POST', `${P()}/scenarios/${sid}/submit`)).status).toBe(200);
	return sid;
}

/** Open a bundle, rewrite one JSON entry, fix bundle.json's hashes, and zip it again: the check reached is the entry's own. */
async function rewrite(b: Uint8Array<ArrayBuffer>, name: string, edit: (v: any) => void): Promise<Uint8Array<ArrayBuffer>> {
	const archive = await ZipArchive.open(b);
	const files = new Map<string, string>();
	for (const n of archive.names) files.set(n, new TextDecoder().decode(await archive.read(n)));
	const v = JSON.parse(files.get(name)!);
	edit(v);
	files.set(name, canonicalJson(v));
	const index = JSON.parse(files.get('bundle.json')!) as PackBundleIndex;
	index.files = {};
	for (const n of [...files.keys()].sort()) if (n !== 'bundle.json') index.files[n] = bundleHash(files.get(n)!);
	files.set('bundle.json', canonicalJson(index));
	return zip([...files.keys()].sort().map((n) => ({ name: n, data: new TextEncoder().encode(files.get(n)!) })));
}

beforeAll(async () => {
	[owner, assessor, applicantA, applicantB] = (await Promise.all(['Baowner', 'Baassessor', 'Baapplicanta', 'Baapplicantb'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Bundle of the combined row' })).body.project.id;
	const model = {
		nodes: [outlet, welgemoed, rietvallei],
		crops: [lucerne],
		cropAreas: [
			{ nodeId: welgemoed.id, cropId: lucerne.id, areaM2: 80_000 },
			{ nodeId: rietvallei.id, cropId: lucerne.id, areaM2: 60_000 }
		],
		transfers: []
	};
	expect((await owner.call('PUT', `${P()}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(2000) } })).status).toBe(200);
	const rain = Array.from({ length: 730 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2018-10-01', values: rain })).status).toBe(200);
	for (const [u, role] of [
		[assessor, 'editor'],
		[applicantA, 'contributor'],
		[applicantB, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	for (const [n, v] of [
		[welgemoed, 300_000],
		[rietvallei, 250_000]
	] as const) {
		const res = await assessor.call('POST', `${P()}/allocations`, { nodeId: n.id, holder: `Holder ${n.name}`, authorisation: 'licence', waterSource: 'surface', volumeM3PerYear: v });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
	}
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantA.id}`, { nodeIds: [welgemoed.id] })).status).toBe(200);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantB.id}`, { nodeIds: [rietvallei.id] })).status).toBe(200);
	appA = await application(applicantA, 'Raise Welgemoed', [{ op: 'node.set', nodeId: welgemoed.id, field: 'damCapacityM3', value: 200_000 }]);
	appB = await application(applicantB, 'More lucerne on Rietvallei', [{ op: 'cropArea.set', nodeId: rietvallei.id, cropId: lucerne.id, areaM2: 180_000 }]);
	// The background: an editor's scenario run of the baseline at full allocation.
	const sc = await assessor.call('POST', `${P()}/scenarios`, { name: 'Existing authorised use', baseRunId: published, ops: [{ op: 'settings.set', path: 'allocationMode', value: 'fullAllocation' }] });
	expect(sc.status, JSON.stringify(sc.body)).toBe(201);
	const bg = await assessor.call('POST', `${P()}/scenarios/${sc.body.scenario.id}/runs`, {});
	expect(bg.status, JSON.stringify(bg.body)).toBe(201);
	fullRun = bg.body.run.id;
	const ran = await assessor.call('POST', `${P()}/scenarios/${appA}/runs`, {});
	expect(ran.status, JSON.stringify(ran.body)).toBe(201);
	appRun = ran.body.run.id;
	const res = await assessor.call('POST', `${P()}/assessments`, { name: 'Both, against authorised use', scenarioIds: [appB, appA], backgroundRunId: fullRun });
	expect(res.status, JSON.stringify(res.body)).toBe(202);
	assessmentId = res.body.assessment.id;
	await tick();
	expect((await assessor.call('GET', `${P()}/assessments/${assessmentId}`)).body.assessment.status).toBe('complete');
	// The pack's manifest as a draft freezes it, and its bundle as the issue builds it.
	bytes = await withUser(assessor.id, async (db) => {
		const r = await buildEvidenceReport(db, projectId, appRun);
		manifest = JSON.parse(JSON.stringify(buildPackManifest({ pack: { id: randomUUID(), version: 1, supersedes: null }, project: r.identity.project, report: r, engine: { version: ENGINE_VERSION, build: null } })));
		return (await buildPackBundle(await loadPackBundleInput(db, { baselineRunId: published, scenarioRunId: appRun }, manifest), bundleHash)).bytes;
	});
}, 240_000);

describe('the reproduction bundle of a pack whose combined row reads an assessment (bundle-3)', () => {
	it('cites the assessment in the manifest, with the dam the applications touch and the background beside the baseline', () => {
		const c = manifest.report.cumulative.combined!;
		expect(c.notAssessed).toBeNull();
		expect(c.assessment).toMatchObject({ id: assessmentId, engineVersion: ENGINE_VERSION });
		expect(c.dams!.map((d) => d.nodeId)).toContain(welgemoed.id);
		expect(c.background).toMatchObject({ runLabel: expect.any(String) });
	});

	it('re-runs the job’s own assessment offline to every row it stored: the outlet, the dam and the background (positive control)', async () => {
		const r = await checkPackBundle(bytes, { hash: bundleHash, expectManifestSha256: bundleHash(canonicalJson(manifest)) });
		expect(failing(r)).toEqual([]);
		expect(r.combined).toBe('checked');
		expect(r.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['assessment', 'inputs:background', 'reproduce:combined', 'reproduce:dams', 'reproduce:background']));
		expect(reproductionOutcome(r)).toBe('reproduced');
		const index = JSON.parse(new TextDecoder().decode(await (await ZipArchive.open(bytes)).read('bundle.json'))) as PackBundleIndex;
		expect(index.assessment).toEqual({ id: assessmentId, engineVersion: ENGINE_VERSION, backgroundRunId: fullRun });
	});

	it('fails a member op tampered with (its hash left as it was), and, its hash fixed too, the re-run: not reproduced', async () => {
		const tamper = (v: any) => {
			const m = v.members.find((x: { scenarioId: string }) => x.scenarioId === appB);
			m.ops[0].areaM2 = 400_000;
			return m;
		};
		const r = await checkPackBundle(await rewrite(bytes, 'assessment/assessment.json', tamper), { hash: bundleHash, rerun: false });
		expect(failing(r)).toEqual(['assessment']);
		expect(r.checks.find((c) => c.id === 'assessment')!.detail).toContain(`"More lucerne on Rietvallei"'s ops hash to`);
		const rehashed = await rewrite(bytes, 'assessment/assessment.json', (v) => {
			const m = tamper(v);
			m.opsSha256 = bundleHash(canonicalJson(m.ops));
		});
		const again = await checkPackBundle(rehashed, { hash: bundleHash });
		expect(failing(again)).toEqual(expect.arrayContaining(['reproduce:combined', 'reproduce:background']));
		expect(failing(again)).not.toContain('assessment');
		expect(reproductionOutcome(again)).toBe('not_reproduced');
	});

	it('fails a background input that isn’t the baseline at full allocation', async () => {
		const r = await checkPackBundle(
			await rewrite(bytes, 'assessment/background/input.json', (v) => (v.settings.allocationMode = 'cap')),
			{ hash: bundleHash }
		);
		expect(failing(r)).toEqual(['inputs:background', 'reproduce:background']);
		expect(r.checks.find((c) => c.id === 'inputs:background')!.detail).toContain("it didn't run at full allocation");
	});

	it('refuses the bundle (409) once the assessment it cites is gone: the pack is drafted again', async () => {
		await asOwner('DELETE FROM assessment WHERE id = $1', [assessmentId]);
		await expect(withUser(assessor.id, (db) => loadPackBundleInput(db, { baselineRunId: published, scenarioRunId: appRun }, manifest))).rejects.toMatchObject({
			status: 409,
			message: expect.stringMatching(/assessment this pack’s combined row reads is gone/)
		});
	});
});
