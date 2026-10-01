// A daily A-pan evaporation series (engine ≥ 0.38.0, issue #45,
// docs/model.md §2.3a): stored like any input series (kind evap_apan_mm, in
// mm whatever depth unit it was given in), read into the model input, and
// kept with a run's inputs (run_input_series), so re-running the run
// reproduces the days it covered. Synthetic example catchment only.
import { canonicalJson, runModelChecked, type ModelOutput } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { buildExamples, type ExampleProject } from '../../scripts/examples/catchments.js';
import { importProjectData } from '../../scripts/import-project.js';
import { signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { loadModelInput, loadRunInput } from '../runs/execute.js';

type User = Awaited<ReturnType<typeof signUp>>;

/**
 * Kleinberg's first two years, rain and gauge records only: the series under
 * test covers 60 days, and on the 15-year record the test's two runs and a
 * re-run took ~2.8 s on a CI runner, within a slow one of vitest's 5 s
 * (docs/testing.md § Big or repeated fixtures in db tests).
 */
const full: ExampleProject = buildExamples({ fit: false })[0]!;
const start = full.series.find((s) => s.kind === 'rain_catchment_mm')!.startDate;
const example: ExampleProject = { ...full, series: full.series.filter((s) => s.startDate === start).map((s) => ({ ...s, values: s.values.slice(0, 731) })) };
const canon = (v: unknown) => canonicalJson(JSON.parse(JSON.stringify(v)));

const newRun = async (u: User, projectId: string) => {
	const res = await u.call('POST', `/projects/${projectId}/runs`, { label: 'daily A-pan' });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.run.id as string;
};

const runRow = (u: User, runId: string) =>
	withUser(u.id, async (db) => ({
		kinds: (await db.query<{ kind: string }>('SELECT kind FROM run_input_series WHERE run_id = $1 ORDER BY kind', [runId])).rows.map((r) => r.kind),
		summary: (await db.query<{ summary: ModelOutput['summary'] }>('SELECT summary FROM model_run WHERE id = $1', [runId])).rows[0]!.summary
	}));

describe('daily A-pan evaporation series', () => {
	it('is stored in mm, read into the model input, and kept with a run that reproduces it', async () => {
		const u = await signUp('Apan');
		const pid = await importProjectData(example, u.email);
		const rain = example.series.find((s) => s.kind === 'rain_catchment_mm')!;

		// Positive control first: without the series a run stores no such input and no summary.apanDaily.
		const before = await runRow(u, await newRun(u, pid));
		expect(before.kinds).not.toContain('evap_apan_mm');
		expect(before.summary.apanDaily).toBeUndefined();

		// 60 days in cm (0.6 cm = 6 mm), one missing: stored as mm.
		const values = Array.from({ length: 60 }, (_, i) => (i === 5 ? null : 0.6));
		const put = await u.call('PUT', `/projects/${pid}/series`, { kind: 'evap_apan_mm', name: 'Station pan', unit: 'cm', startDate: rain.startDate, values });
		expect(put.status, JSON.stringify(put.body)).toBe(200);
		expect(put.body.unit).toBe('mm');
		const list = (await u.call('GET', `/projects/${pid}/series`)).body.series as { id: string; kind: string; unit: string; length: number }[];
		const meta = list.find((s) => s.kind === 'evap_apan_mm')!;
		expect(meta).toMatchObject({ unit: 'mm', length: 60 });
		const got = (await u.call('GET', `/projects/${pid}/series/${meta.id}`)).body.values as (number | null)[];
		expect(got[0]).toBeCloseTo(6, 12);
		expect(got[5]).toBeNull();

		const live = await withUser(u.id, (db) => loadModelInput(db, pid));
		expect(live.series.evap_apan_mm?.startDate).toBe(rain.startDate);
		expect(live.series.evap_apan_mm?.values).toHaveLength(60);

		const runId = await newRun(u, pid);
		const after = await runRow(u, runId);
		expect(after.kinds).toContain('evap_apan_mm');
		expect(after.summary.apanDaily).toMatchObject({ dailyDays: 59, invalidDays: 0, first: rain.startDate });
		expect(after.summary.warnings.some((w) => w.includes('daily A-pan evaporation covers 59 of'))).toBe(true);

		// The run's stored input carries the series; re-running it reproduces the stored summary.
		const input = await withUser(u.id, (db) => loadRunInput(db, runId));
		expect(input.series.evap_apan_mm?.values).toEqual(got);
		expect(canon(runModelChecked(input).summary)).toBe(canon(after.summary));
		// And the series moved the results (the positive control above ran on the same project).
		expect(canon(after.summary.farms)).not.toBe(canon(before.summary.farms));
	});
});
