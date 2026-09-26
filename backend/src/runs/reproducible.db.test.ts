// Reproducible runs (roadmap WP-3.1, 021_series_blob.sql): executeRun stores
// each input series once per project (series_blob, by SHA-256) and the run's
// references to them (run_input_series); loadRunInput rebuilds the run's exact
// ModelInput. Checked here: the round trip is byte-identical on the example
// catchments, re-uploading a series doesn't change an old run's input, blobs
// are readable only through a run the user can see (with positive controls),
// trimmed runs' blobs are garbage-collected while kept runs' stay, a run from
// before stored inputs says so. (Cited runs: scenarios/scenarios.db.test.ts.)
import { canonicalJson, runModelChecked, type SeriesKind } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildExamples, inputOf } from '../../scripts/examples/catchments.js';
import { importProjectData } from '../../scripts/import-project.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadModelInput, loadRunInput, RunInputError, seriesHash, trimRuns } from './execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

const examples = buildExamples({ fit: false });

const newRun = async (u: User, projectId: string, label = 'run') => {
	const res = await u.call('POST', `/projects/${projectId}/runs`, { label });
	expect(res.status).toBe(201);
	return res.body.run.id as string;
};

/** The error loadRunInput throws for `runId` as `userId`. */
const loadError = async (userId: string, runId: string) =>
	withUser(userId, (db) => loadRunInput(db, runId)).then(
		() => {
			throw new Error('expected loadRunInput to refuse');
		},
		(err: unknown) => err as RunInputError
	);

/** Normalise as JSON storage does (NaN → null, undefined dropped), then canonicalise. */
const canon = (v: unknown) => canonicalJson(JSON.parse(JSON.stringify(v)));

describe('runModel(loadRunInput(run)) reproduces the stored run', () => {
	it.each(examples.map((ex, i) => [ex.name, i] as const))('byte-identical summary and daily outputs: %s', async (_name, i) => {
		const ex = examples[i]!;
		const u = await signUp('Repro');
		const pid = await importProjectData(ex, u.email);
		const runId = await newRun(u, pid, 'reproduce me');

		const { input, stored, series } = await withUser(u.id, async (db) => ({
			input: await loadRunInput(db, runId),
			stored: (await db.query<{ summary: unknown }>('SELECT summary FROM model_run WHERE id = $1', [runId])).rows[0]!.summary,
			series: (
				await db.query<{ node_id: string | null; key: string; values: (number | null)[] }>(
					'SELECT node_id, key, "values" FROM run_series WHERE run_id = $1',
					[runId]
				)
			).rows
		}));
		// The rebuilt input's series are the example's, value for value.
		const original = inputOf(ex);
		expect(Object.keys(input.series).sort()).toEqual(Object.keys(original.series).sort());
		// Each carries the product/version the run recorded (031; the examples record none).
		for (const [kind, s] of Object.entries(original.series)) expect(input.series[kind as SeriesKind]).toEqual({ ...s, provenance: null });

		const again = runModelChecked(input);
		expect(canon(again.summary)).toBe(canon(stored));
		// Every daily output too, as run_series stored it (non-finite → null).
		expect(series.length).toBe(again.series.length);
		const byKey = new Map(series.map((s) => [`${s.node_id}|${s.key}`, s.values]));
		for (const s of again.series) {
			expect(byKey.get(`${s.nodeId}|${s.key}`), s.key).toEqual(s.values.map((v) => (Number.isFinite(v) ? v : null)));
		}
	});
});

describe('stored run inputs', () => {
	let owner: User;
	let viewer: User;
	let stranger: User;
	let pid: string;
	let otherPid: string;
	let runId: string;
	const small = examples[1]!;

	beforeAll(async () => {
		[owner, viewer, stranger] = await Promise.all([signUp('BlobOwner'), signUp('BlobViewer'), signUp('BlobStranger')]);
		pid = await importProjectData(small, owner.email);
		expect((await owner.call('POST', `/projects/${pid}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		otherPid = await importProjectData(small, stranger.email);
		runId = await newRun(owner, pid, 'first');
	});

	const blobCount = (userId: string, projectId: string) =>
		withUser(userId, async (db) => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM series_blob WHERE project_id = $1', [projectId])).rows[0]!.n);

	it('stores each distinct series once per project, however many runs use it', async () => {
		const kinds = small.series.length;
		expect(await blobCount(owner.id, pid)).toBe(kinds);
		await newRun(owner, pid, 'second');
		expect(await blobCount(owner.id, pid)).toBe(kinds);
		const refs = await withUser(owner.id, async (db) => (await db.query('SELECT kind, sha256 FROM run_input_series WHERE run_id = $1', [runId])).rows);
		expect(refs).toHaveLength(kinds);
		// The key is the snapshot's own valuesSha256, the hash runs have always carried.
		for (const s of small.series) expect(refs).toContainEqual({ kind: s.kind, sha256: seriesHash(s.values) });
	});

	it("keeps a run's input when the live series is re-uploaded", async () => {
		const u = await signUp('Reupload');
		const p = await importProjectData(small, u.email);
		const before = await newRun(u, p, 'before');
		const rain = small.series.find((s) => s.kind === 'rain_catchment_mm')!;
		const changed = rain.values.map((v, i) => (i === 100 ? (v ?? 0) + 7 : v));
		expect((await u.call('PUT', `/projects/${p}/series`, { kind: rain.kind, name: rain.name, unit: rain.unit, startDate: rain.startDate, values: changed })).status).toBe(200);
		const after = await newRun(u, p, 'after');
		await withUser(u.id, async (db) => {
			const live = await loadModelInput(db, p);
			expect(live.series.rain_catchment_mm!.values).toEqual(changed);
			expect((await loadRunInput(db, before)).series.rain_catchment_mm!.values).toEqual(rain.values);
			expect((await loadRunInput(db, after)).series.rain_catchment_mm!.values).toEqual(changed);
			// One new blob for the changed series; the unchanged ones are shared.
			const n = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM series_blob WHERE project_id = $1', [p])).rows[0]!.n;
			expect(n).toBe(small.series.length + 1);
		});
	});

	it("reads a blob only through a run the user can see: a viewer can, another project's member can't", async () => {
		const sha = seriesHash(small.series[0]!.values);
		const read = (userId: string) =>
			withUser(userId, async (db) => (await db.query('SELECT sha256 FROM series_blob WHERE project_id = $1 AND sha256 = $2', [pid, sha])).rowCount);
		// Positive controls: the owner and a viewer read it, and rebuild the run.
		expect(await read(owner.id)).toBe(1);
		expect(await read(viewer.id)).toBe(1);
		expect(Object.keys((await withUser(viewer.id, (db) => loadRunInput(db, runId))).series)).toHaveLength(small.series.length);
		// Another project's member can't, by hash or at all, nor its references or run.
		expect(await read(stranger.id)).toBe(0);
		expect(await blobCount(stranger.id, pid)).toBe(0);
		expect(await withUser(stranger.id, async (db) => (await db.query('SELECT 1 FROM run_input_series WHERE run_id = $1', [runId])).rowCount)).toBe(0);
		expect((await loadError(stranger.id, runId)).problem).toBe('not_found');
	});

	it("refuses writes that would plant or borrow a blob: viewers, another project's run, an older run", async () => {
		const sha = '0'.repeat(64);
		const sha256Here = seriesHash(small.series[0]!.values);
		// Positive control: an editor may insert, and executeRun's ON CONFLICT DO
		// NOTHING on content the project already holds is a no-op under RLS,
		// leaving the stored values alone.
		await withUser(owner.id, (db) =>
			db.query(`INSERT INTO series_blob (project_id, sha256, "values") VALUES ($1, $2, '{1}') ON CONFLICT DO NOTHING`, [pid, sha256Here])
		);
		expect(Object.keys((await withUser(owner.id, (db) => loadRunInput(db, runId))).series)).toHaveLength(small.series.length);
		// A viewer can't store a blob.
		await expect(
			withUser(viewer.id, (db) => db.query(`INSERT INTO series_blob (project_id, sha256, "values") VALUES ($1, $2, '{1}')`, [pid, sha]))
		).rejects.toMatchObject({ code: '42501' });
		// A stranger can't store one in this project.
		await expect(
			withUser(stranger.id, (db) => db.query(`INSERT INTO series_blob (project_id, sha256, "values") VALUES ($1, $2, '{1}')`, [pid, sha]))
		).rejects.toMatchObject({ code: '42501' });
		// A reference can only be written in the transaction that saved its run:
		// the owner can't give an existing run new references afterwards.
		await expect(
			withUser(owner.id, async (db) => {
				const { rows } = await db.query<{ sha256: string }>('SELECT sha256 FROM run_input_series WHERE run_id = $1 LIMIT 1', [runId]);
				await db.query(`INSERT INTO run_input_series (run_id, project_id, kind, start_date, sha256) VALUES ($1, $2, 'extra', '2020-01-01', $3)`, [
					runId,
					pid,
					rows[0]!.sha256
				]);
			})
		).rejects.toMatchObject({ code: '42501' });
		// Content held only by another project can't be borrowed by hash: the
		// foreign key is per project, and the stranger's project stores nothing
		// yet (it has no run), so pointing a run of theirs at this project's
		// hash fails.
		await expect(
			withUser(stranger.id, async (db) => {
				const { rows } = await db.query<{ id: string }>(
					`INSERT INTO model_run (project_id, created_by, label, engine_version, start_date, end_date, inputs)
					 VALUES ($1, app_current_user_id(), 'borrow', 'x', '2020-01-01', '2020-01-02', '{}') RETURNING id`,
					[otherPid]
				);
				await db.query(`INSERT INTO run_input_series (run_id, project_id, kind, start_date, sha256) VALUES ($1, $2, 'rain_catchment_mm', '2020-01-01', $3)`, [
					rows[0]!.id,
					otherPid,
					sha256Here
				]);
			})
		).rejects.toMatchObject({ code: '23503' });
	});

	it('says a run from before stored inputs is not reproducible, and why', async () => {
		// A run saved the way executeRun did before 021: snapshot hashes, no references.
		const legacy = await withUser(owner.id, async (db) => {
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO model_run (project_id, created_by, label, engine_version, start_date, end_date, inputs, summary)
				 SELECT project_id, created_by, 'legacy', engine_version, start_date, end_date, inputs, summary FROM model_run WHERE id = $1
				 RETURNING id`,
				[runId]
			);
			return rows[0]!.id;
		});
		const err = await loadError(viewer.id, legacy);
		expect(err).toBeInstanceOf(RunInputError);
		expect(err.problem).toBe('not_reproducible');
		expect(err.message).toMatch(/^this run is not reproducible from stored inputs: it was made on \d{4}-\d{2}-\d{2}, before runs stored their input series/);
		// Positive control: the run it copied is reproducible.
		await expect(withUser(viewer.id, (db) => loadRunInput(db, runId))).resolves.toBeTruthy();
	});

	it('refuses a stored series that fails its hash check rather than presenting it as the run', async () => {
		const u = await signUp('Tamper');
		const p = await importProjectData(small, u.email);
		const r = await newRun(u, p);
		const sha = seriesHash(small.series[0]!.values);
		// Arranged as the owner: water_app can't UPDATE a blob (catalogue APPEND_ONLY).
		await asOwner(`UPDATE series_blob SET "values"[1] = coalesce("values"[1], 0) + 1 WHERE project_id = $1 AND sha256 = $2`, [p, sha]);
		const err = await loadError(u.id, r);
		expect(err.problem).toBe('inconsistent');
		expect(err.message).toMatch(/fails its SHA-256 check/);
	});
});

describe('garbage collection of stored inputs', () => {
	it("removes the blobs only trimmed runs used, and keeps those a kept run or a newer run still uses", async () => {
		const u = await signUp('BlobGc');
		const ex = examples[1]!;
		const p = await importProjectData(ex, u.email);
		const rain = ex.series.find((s) => s.kind === 'rain_catchment_mm')!;
		const put = (values: (number | null)[]) =>
			u.call('PUT', `/projects/${p}/series`, { kind: rain.kind, name: rain.name, unit: rain.unit, startDate: rain.startDate, values });
		const v2 = rain.values.map((v, i) => (i === 5 ? (v ?? 0) + 1 : v));
		const v3 = rain.values.map((v, i) => (i === 6 ? (v ?? 0) + 1 : v));
		const hashes = async () =>
			withUser(u.id, async (db) => new Set((await db.query<{ sha256: string }>('SELECT sha256 FROM series_blob WHERE project_id = $1', [p])).rows.map((r) => r.sha256)));

		const pinnedRun = await newRun(u, p, 'v1, pinned');
		expect((await u.call('PATCH', `/projects/${p}/runs/${pinnedRun}`, { pinned: true })).status).toBe(200);
		expect((await put(v2)).status).toBe(200);
		const v2Run = await newRun(u, p, 'v2');
		expect((await put(v3)).status).toBe(200);
		await newRun(u, p, 'v3');
		expect(await hashes()).toEqual(new Set([...ex.series.map((s) => seriesHash(s.values)), seriesHash(v2), seriesHash(v3)]));

		// Keep one: the v2 run is trimmed (the pinned v1 run is exempt), so v2's blob goes...
		const removed = await withUser(u.id, (db) => trimRuns(db, p, 1));
		expect(removed).toEqual([v2Run]);
		const after = await hashes();
		expect(after.has(seriesHash(v2))).toBe(false);
		// ...while the pinned run's v1 blob and the newest run's v3 blob stay (the positive controls),
		expect(after.has(seriesHash(rain.values))).toBe(true);
		expect(after.has(seriesHash(v3))).toBe(true);
		// and the pinned run is still reproducible.
		expect((await withUser(u.id, (db) => loadRunInput(db, pinnedRun))).series.rain_catchment_mm!.values).toEqual(rain.values);

		// Unpinned and deleted, its now-unused v1 rain blob goes too; the series it shared with v3 stay.
		expect((await u.call('PATCH', `/projects/${p}/runs/${pinnedRun}`, { pinned: false })).status).toBe(200);
		expect((await u.call('DELETE', `/projects/${p}/runs/${pinnedRun}`)).status).toBe(204);
		const last = await hashes();
		expect(last.has(seriesHash(rain.values))).toBe(false);
		expect(last).toEqual(new Set([...ex.series.filter((s) => s !== rain).map((s) => seriesHash(s.values)), seriesHash(v3)]));
	});
});

describe('deleting a project with stored run inputs', () => {
	it('cascades through series_blob and run_input_series (the NO ACTION key is checked at the end of the statement)', async () => {
		const u = await signUp('BlobProjectDelete');
		const p = await importProjectData(examples[1]!, u.email);
		await newRun(u, p, 'one');
		await newRun(u, p, 'two');
		const left = () =>
			asOwner(
				`SELECT (SELECT count(*) FROM series_blob WHERE project_id = $1)::int AS blobs, (SELECT count(*) FROM run_input_series WHERE project_id = $1)::int AS refs`,
				[p]
			);
		// Positive control: there is something to delete.
		expect((await left())[0]).toEqual({ blobs: examples[1]!.series.length, refs: 2 * examples[1]!.series.length });
		expect((await u.call('DELETE', `/projects/${p}`)).status).toBe(204);
		expect((await left())[0]).toEqual({ blobs: 0, refs: 0 });
	});
});

// Cited runs (model_run_cited) are tested with the real citation, a scenario's
// base run, in scenarios/scenarios.db.test.ts ("a cited base run").
