// The pack_reproduce handler's decisions (154_pack_reproduce;
// docs/evidence-pack.md § Reproduction), with the database and storage
// stubbed and a real bundle of the engine's synthetic pack
// (testing/packBundle.ts): what it records for a bundle that reproduces, one
// whose stored bytes aren't the recorded ones, one missing from the store, a
// pack without a bundle, and when it fails the job instead. The same against
// Postgres and MinIO: evidence/packs.db.test.ts.
import { buildPackBundle, ENGINE_VERSION, type BundleCheck } from '@water-management/engine';
import { assessmentPackFixture, packBundleFixture } from '@water-management/engine/testing';
import { createHash } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const getPackBundle = vi.fn(async (_key: string, _max: number): Promise<Uint8Array<ArrayBuffer> | null> => null);
vi.mock('../../reports/storage.js', async (orig) => ({
	...(await orig<typeof import('../../reports/storage.js')>()),
	getPackBundle: (k: string, m: number) => getPackBundle(k, m)
}));
vi.mock('../../logging/logEvent.js', () => ({ logEvent: () => {} }));

const { packReproduceHandler, reproductionOutcome, storedBundleCheck } = await import('./pack-reproduce.js');
const { JobError } = await import('../errors.js');

const hash = (d: string | Uint8Array) => createHash('sha256').update(d).digest('hex');
const P = '00000000-0000-4000-8000-000000000002';
const K = '00000000-0000-4000-8000-000000000006';

interface PackRow {
	issued: boolean;
	manifestSha256: string;
	bundleKey: string | null;
	bundleSha256: string | null;
}
interface Recorded {
	packId: string;
	outcome: string;
	engine: string;
	runEngines: string[];
	bundleSha256: string | null;
	checks: BundleCheck[];
}

/** A stand-in transaction: the pack row, whether an outcome is recorded for this engine, and what the handler records. */
function fakeDb(pack: PackRow | null, recordedAlready = false) {
	const recorded: Recorded[] = [];
	/** The fan-out (302): each part's queued job and what app_pack_reproduce_fan_out was handed. */
	const queued: { kind: string; payload: Record<string, string> }[] = [];
	const fannedOut: { checks: BundleCheck[]; parts: { id: string; jobId: string; part: { kind: string; run?: string }; label: string }[] }[] = [];
	const db = {
		async query(sql: string, params: unknown[] = []) {
			if (sql.includes('INSERT INTO job')) {
				queued.push({ kind: params[1] as string, payload: JSON.parse(params[2] as string) });
				return { rows: [{ id: `job-${queued.length}` }], rowCount: 1 };
			}
			if (sql.includes('FROM job j JOIN app_user')) return { rows: [{ id: params[0] }], rowCount: 1 };
			if (sql.includes('app_pack_reproduce_fan_out')) {
				fannedOut.push({ checks: JSON.parse(params[6] as string), parts: JSON.parse(params[7] as string) });
				return { rows: [{}], rowCount: 1 };
			}
			if (sql.includes('app_record_pack_reproduction')) {
				const [packId, outcome, engine, runEngines, bundleSha256, checks] = params as [string, string, string, string[], string | null, string];
				recorded.push({ packId, outcome, engine, runEngines, bundleSha256, checks: JSON.parse(checks) as BundleCheck[] });
				return { rows: [{ recorded: true }], rowCount: 1 };
			}
			if (sql.includes('FROM pack_reproduction')) return { rows: recordedAlready ? [{}] : [], rowCount: recordedAlready ? 1 : 0 };
			if (sql.includes('FROM evidence_pack')) return { rows: pack ? [pack] : [], rowCount: pack ? 1 : 0 };
			throw new Error(`unexpected query: ${sql}`);
		}
	};
	return { db, recorded, queued, fannedOut };
}

const run = (db: unknown, packId = K) =>
	packReproduceHandler.run({
		db: db as never,
		job: { id: 'j1', projectId: P, kind: 'pack_reproduce', actingUserId: 'u1', leaseToken: 'l', attempts: 1, maxAttempts: 3 },
		payload: { packId },
		progress: async () => true
	});

let bundle: { bytes: Uint8Array<ArrayBuffer>; sha256: string; manifestSha256: string };
beforeAll(async () => {
	const input = packBundleFixture(hash, { application: true });
	const built = await buildPackBundle(input, hash);
	bundle = { bytes: built.bytes, sha256: built.sha256, manifestSha256: built.index.pack.manifestSha256 };
});
afterEach(() => {
	getPackBundle.mockReset();
	vi.restoreAllMocks();
});

const issued = (): PackRow => ({ issued: true, manifestSha256: bundle.manifestSha256, bundleKey: `packs/${P}/${K}/${bundle.sha256}.zip`, bundleSha256: bundle.sha256 });

describe('pack_reproduce', () => {
	it('checks a stored bundle without re-running it and fans the re-runs out, one part job each, recording nothing yet (302)', async () => {
		getPackBundle.mockResolvedValueOnce(bundle.bytes);
		const { db, recorded, queued, fannedOut } = fakeDb(issued());
		await run(db);
		expect(getPackBundle).toHaveBeenCalledWith(issued().bundleKey, expect.any(Number));
		expect(recorded).toEqual([]);
		expect(fannedOut).toHaveLength(1);
		const f = fannedOut[0]!;
		expect(f.checks.map((c) => c.id)).toEqual(['stored', 'archive', 'files', 'manifest', 'runs', 'inputs:baseline', 'inputs:application', 'changes', 'scenario', 'results:baseline', 'results:application', 'headline']);
		expect(f.checks.every((c) => c.ok)).toBe(true);
		expect(f.parts.map((p) => p.part.kind)).toEqual(['run:baseline', 'run:application']);
		// Each part's job is a pack_reproduce_part job naming this pack, the gathering and the part.
		expect(queued.map((q) => q.kind)).toEqual(['pack_reproduce_part', 'pack_reproduce_part']);
		expect(queued.map((q) => q.payload.partId)).toEqual(f.parts.map((p) => p.id));
		expect(new Set(queued.map((q) => q.payload.gatheringId)).size).toBe(1);
		expect(queued.every((q) => q.payload.packId === K)).toBe(true);
	});

	it('fans a pack whose combined row reads an assessment out to its assessment, background and one part per dam search', async () => {
		const good = await buildPackBundle(assessmentPackFixture(hash, { background: true }), hash);
		getPackBundle.mockResolvedValueOnce(good.bytes);
		const { db, recorded, fannedOut } = fakeDb({ issued: true, manifestSha256: good.index.pack.manifestSha256, bundleKey: `packs/${P}/${K}/${good.sha256}.zip`, bundleSha256: good.sha256 });
		await run(db);
		expect(recorded).toEqual([]);
		expect(fannedOut[0]!.parts.map((p) => (p.part.kind === 'dam' ? `dam:${p.part.run}` : p.part.kind))).toEqual([
			'run:baseline',
			'run:application',
			'combined',
			'background',
			'dam:baseline',
			'dam:single',
			'dam:single',
			'dam:combined'
		]);
		expect(fannedOut[0]!.parts.at(-1)!.label).toBe('the firm yield of "Farm one" (All together)');
	});

	it('records stored bytes that aren’t the recorded bundle as not reproduced, without re-running them (positive control above)', async () => {
		const other = new Uint8Array(bundle.bytes);
		other[other.length - 1] = other.at(-1)! ^ 1;
		getPackBundle.mockResolvedValueOnce(other);
		const { db, recorded } = fakeDb(issued());
		await run(db);
		expect(recorded).toEqual([
			expect.objectContaining({ outcome: 'not_reproduced', bundleSha256: bundle.sha256, runEngines: [], checks: [expect.objectContaining({ id: 'stored', ok: false })] })
		]);
		expect(recorded[0]!.checks[0]!.detail).toContain(`not the pack’s recorded ${bundle.sha256}`);
	});

	it('records a bundle the store doesn’t hold as not reproduced', async () => {
		getPackBundle.mockResolvedValueOnce(null);
		const { db, recorded } = fakeDb(issued());
		await run(db);
		expect(recorded.map((r) => [r.outcome, r.checks.map((c) => [c.id, c.ok])])).toEqual([['not_reproduced', [['stored', false]]]]);
	});

	it('checks the manifest against the pack’s own hash: a pack row naming another hash doesn’t reproduce', async () => {
		getPackBundle.mockResolvedValueOnce(bundle.bytes);
		const { db, recorded } = fakeDb({ ...issued(), manifestSha256: 'f'.repeat(64) });
		await run(db);
		expect(recorded[0]!.outcome).toBe('not_reproduced');
		expect(recorded[0]!.checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(['manifest']);
	});

	it('fails the job, to retry, when the store can’t be read; nothing is recorded', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		getPackBundle.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:9002'));
		const { db, recorded } = fakeDb(issued());
		const err = await run(db).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(JobError);
		expect((err as InstanceType<typeof JobError>).retry).toBe(true);
		expect((err as Error).message).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
		expect(recorded).toEqual([]);
	});

	it('records no_bundle for a pack issued without one, and reads nothing from the store', async () => {
		const { db, recorded } = fakeDb({ ...issued(), bundleKey: null, bundleSha256: null });
		await run(db);
		expect(getPackBundle).not.toHaveBeenCalled();
		expect(recorded).toEqual([expect.objectContaining({ outcome: 'no_bundle', bundleSha256: null, runEngines: [] })]);
	});

	it('does nothing when this engine’s outcome is recorded already: the first stands', async () => {
		const { db, recorded } = fakeDb(issued(), true);
		await run(db);
		expect(getPackBundle).not.toHaveBeenCalled();
		expect(recorded).toEqual([]);
	});

	it('is dead, with nothing recorded, for a pack it can’t see or one never issued', async () => {
		for (const pack of [null, { ...issued(), issued: false }]) {
			const { db, recorded } = fakeDb(pack);
			const err = await run(db).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(JobError);
			expect((err as InstanceType<typeof JobError>).retry).toBe(false);
			expect(recorded).toEqual([]);
		}
	});

	it('accepts only a pack id', () => {
		expect(packReproduceHandler.payload.safeParse({ packId: K }).success).toBe(true);
		expect(packReproduceHandler.payload.safeParse({ packId: K, extra: 1 }).success).toBe(false);
		expect(packReproduceHandler.payload.safeParse({ packId: 'nope' }).success).toBe(false);
		expect(packReproduceHandler.role).toBe('editor');
	});
});

describe('reproductionOutcome', () => {
	const ok = (id: string): BundleCheck => ({ id, ok: true, detail: '' });
	const bad = (id: string): BundleCheck => ({ id, ok: false, detail: '' });
	const here = ENGINE_VERSION;

	it('reproduced when every check passed', () => {
		expect(reproductionOutcome({ ok: true, checks: [ok('files'), ok('reproduce:baseline')], engine: { here, runs: [here] } })).toBe('reproduced');
	});

	it('other_engine only when the re-runs alone differ and a run was made with another engine', () => {
		const rerunOnly = [ok('files'), ok('results:baseline'), bad('reproduce:baseline')];
		expect(reproductionOutcome({ ok: false, checks: rerunOnly, engine: { here, runs: ['0.0.1'] } })).toBe('other_engine');
		// The same engine: the re-run differing is a real failure.
		expect(reproductionOutcome({ ok: false, checks: rerunOnly, engine: { here, runs: [here] } })).toBe('not_reproduced');
		// Another engine, but a file failed as well: not explained by the engine.
		expect(reproductionOutcome({ ok: false, checks: [bad('files'), bad('reproduce:baseline')], engine: { here, runs: ['0.0.1'] } })).toBe('not_reproduced');
	});

	it('counts § 8’s pairs run again (climate:delta) and the headline pair as re-runs', () => {
		// On another engine, a pack with § 8 and a headline board differs in every re-run: another engine, not a fault.
		const reruns = [ok('files'), bad('reproduce:baseline'), bad('reproduce:application'), bad('reproduce:headline'), bad('climate:delta')];
		expect(reproductionOutcome({ ok: false, checks: reruns, engine: { here, runs: ['0.0.1'] } })).toBe('other_engine');
		// On the runs' own engine, § 8 differing is a real failure.
		expect(reproductionOutcome({ ok: false, checks: [ok('reproduce:baseline'), bad('climate:delta')], engine: { here, runs: [here] } })).toBe('not_reproduced');
		// Another engine, but the manifest failed as well: not explained by the engine.
		expect(reproductionOutcome({ ok: false, checks: [bad('manifest'), bad('climate:delta')], engine: { here, runs: ['0.0.1'] } })).toBe('not_reproduced');
	});

	it('counts the combined row’s re-runs (reproduce:combined, :dams, :background) as re-runs, and its assessment check not', () => {
		const reruns = [ok('assessment'), bad('reproduce:combined'), bad('reproduce:dams'), bad('reproduce:background')];
		expect(reproductionOutcome({ ok: false, checks: reruns, engine: { here, runs: [here, '0.0.1'] } })).toBe('other_engine');
		expect(reproductionOutcome({ ok: false, checks: [bad('assessment'), bad('reproduce:combined')], engine: { here, runs: ['0.0.1'] } })).toBe('not_reproduced');
		expect(reproductionOutcome({ ok: false, checks: [bad('inputs:background'), ok('reproduce:combined')], engine: { here, runs: ['0.0.1'] } })).toBe('not_reproduced');
	});

	it('not_reproduced for a failure with no checks to explain it', () => {
		expect(reproductionOutcome({ ok: false, checks: [], engine: { here, runs: ['0.0.1'] } })).toBe('not_reproduced');
	});
});

describe('storedBundleCheck', () => {
	it('passes only bytes that hash to the recorded SHA-256', () => {
		const sha = 'a'.repeat(64);
		expect(storedBundleCheck({ sha256: sha }, sha).ok).toBe(true);
		expect(storedBundleCheck({ sha256: 'b'.repeat(64) }, sha).ok).toBe(false);
		expect(storedBundleCheck(null, sha)).toMatchObject({ ok: false, detail: expect.stringMatching(/holds no object/) });
	});
});
