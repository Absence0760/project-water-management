// GET /projects/:id/runs/:runId/reproduce and RunMeta.reproducible (roadmap
// WP-3.1): a stored run re-run from its stored inputs with today's engine.
// Checked: identical on an unchanged run, also after the live series is
// re-uploaded; a changed stored output is reported as a difference; a run from
// before stored inputs says it is not reproducible; a tampered input is
// inconsistent, never "identical"; a stranger can't reproduce (a viewer can).
import { ENGINE_VERSION } from '@water-management/engine';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildExamples } from '../../scripts/examples/catchments.js';
import { importProjectData } from '../../scripts/import-project.js';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { seriesHash } from './execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

const small = buildExamples({ fit: false })[1]!;

let owner: User;
let viewer: User;
let stranger: User;
let pid: string;
let runId: string;

const reproduce = (u: User, run = runId, p = pid) => u.call('GET', `/projects/${p}/runs/${run}/reproduce`);
const newRun = async (u: User, p: string, label: string) => {
	const res = await u.call('POST', `/projects/${p}/runs`, { label });
	expect(res.status).toBe(201);
	return res.body.run.id as string;
};

beforeAll(async () => {
	[owner, viewer, stranger] = await Promise.all([signUp('ReproOwner'), signUp('ReproViewer'), signUp('ReproStranger')]);
	pid = await importProjectData(small, owner.email);
	expect((await owner.call('POST', `/projects/${pid}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
	runId = await newRun(owner, pid, 'reproduce me');
});

describe('GET …/runs/:runId/reproduce', () => {
	it('answers identical for a viewer (positive control), and 404 for a stranger or an unknown run', async () => {
		const res = await reproduce(viewer);
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ status: 'identical', identical: true, engineVersionThen: ENGINE_VERSION, engineVersionNow: ENGINE_VERSION, differences: [], truncated: 0 });
		expect((await reproduce(stranger)).status).toBe(404);
		expect((await reproduce(viewer, crypto.randomUUID())).status).toBe(404);
		expect((await reproduce(viewer, 'nope')).status).toBe(404);
		const runs = (await viewer.call('GET', `/projects/${pid}/runs`)).body.runs as { id: string; reproducible: boolean }[];
		expect(runs.find((r) => r.id === runId)?.reproducible).toBe(true);
	});

	it('stays identical after the live series is re-uploaded with other values', async () => {
		const rain = small.series.find((s) => s.kind === 'rain_catchment_mm')!;
		const changed = rain.values.map((v, i) => (i === 10 ? (v ?? 0) + 5 : v));
		expect((await owner.call('PUT', `/projects/${pid}/series`, { kind: rain.kind, name: rain.name, unit: rain.unit, startDate: rain.startDate, values: changed })).status).toBe(200);
		expect((await reproduce(viewer)).body.status).toBe('identical');
	});

	it('lists a stored output that no longer matches, by series, days and first date', async () => {
		const r = await newRun(owner, pid, 'altered');
		// Arranged as the schema owner: water_app can't change a run's outputs.
		const [s] = await asOwner(
			`UPDATE run_series SET "values"[3] = coalesce("values"[3], 0) + 1 WHERE run_id = $1 AND node_id IS NULL AND key = (SELECT min(key) FROM run_series WHERE run_id = $1 AND node_id IS NULL) RETURNING key`,
			[r]
		);
		const res = await reproduce(viewer, r);
		expect(res.body).toMatchObject({ status: 'differs', identical: false, truncated: 0 });
		expect(res.body.differences).toEqual([expect.objectContaining({ kind: 'series', key: (s as { key: string }).key, nodeId: null, days: 1, maxAbsDiff: 1 })]);
		expect(res.body.differences[0].firstDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it('says a run from before stored inputs is not reproducible, in the list and the check', async () => {
		const legacy = await withUser(owner.id, async (db) => {
			const { rows } = await db.query<{ id: string }>(
				`INSERT INTO model_run (project_id, created_by, label, engine_version, start_date, end_date, inputs, summary)
				 SELECT project_id, created_by, 'before 021', engine_version, start_date, end_date, inputs, summary FROM model_run WHERE id = $1
				 RETURNING id`,
				[runId]
			);
			return rows[0]!.id;
		});
		const res = await reproduce(viewer, legacy);
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ status: 'not_reproducible', identical: false, differences: [] });
		expect(res.body.message).toMatch(/^this run is not reproducible from stored inputs/);
		const runs = (await viewer.call('GET', `/projects/${pid}/runs`)).body.runs as { id: string; reproducible: boolean }[];
		expect(runs.find((r) => r.id === legacy)?.reproducible).toBe(false);
	});

	it('refuses a tampered stored input as inconsistent, never identical', async () => {
		const u = await signUp('ReproTamper');
		const p = await importProjectData(small, u.email);
		const r = await newRun(u, p, 'tampered');
		await asOwner(`UPDATE series_blob SET "values"[1] = coalesce("values"[1], 0) + 1 WHERE project_id = $1 AND sha256 = $2`, [p, seriesHash(small.series[0]!.values)]);
		const res = await reproduce(u, r, p);
		expect(res.body).toMatchObject({ status: 'inconsistent', identical: false });
		expect(res.body.message).toMatch(/fails its SHA-256 check/);
	});
});
