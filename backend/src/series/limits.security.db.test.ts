// The series limits (series/limits.ts) on every path that writes a series:
// a value that overflows once converted to its canonical unit, and the cap on
// how many series one project holds (PUT, merge, the project file import).
import { describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { MAX_SERIES_ABS_VALUE, SERIES_PER_PROJECT_MAX } from './limits.js';

const EMPTY_MODEL = { nodes: [], crops: [], cropAreas: [], transfers: [] };

async function project() {
	const u = await signUp('SeriesLimits');
	const { body } = await u.call('POST', '/projects', { name: 'Series limits' });
	return { u, id: body.project.id as string };
}

const rain = (unit: string, values: (number | null)[], name = '') => ({ kind: 'rain_catchment_mm', name, unit, startDate: '2020-01-01', values });

describe('series values', () => {
	it.each([
		['PUT', '/series'],
		['POST', '/series/merge']
	])('%s %s refuses a value that overflows in its canonical unit, and stores one that fits (positive control)', async (method, path) => {
		const { u, id } = await project();
		// 1e308 in is finite as sent, Infinity in mm.
		const over = await u.call(method, `/projects/${id}${path}`, rain('in', [1, 1e308]));
		expect(over.status).toBe(400);
		expect(over.body.details[0].path).toEqual(['values', 1]);
		const big = await u.call(method, `/projects/${id}${path}`, rain('mm', [MAX_SERIES_ABS_VALUE]));
		expect(big.status).toBe(400);
		const ok = await u.call(method, `/projects/${id}${path}`, rain('in', [1, null]));
		expect(ok.status).toBe(200);
		const got = await u.call('GET', `/projects/${id}/series/${ok.body.id}`);
		expect(got.body.values).toEqual([25.4, null]);
	});

	it('the project file import refuses the same value', async () => {
		const u = await signUp('SeriesLimitsImport');
		const r = await u.call('POST', '/projects/import', { name: 'x', model: EMPTY_MODEL, series: [rain('in', [1e308])] });
		expect(r.status).toBe(400);
		const ok = await u.call('POST', '/projects/import', { name: 'x', model: EMPTY_MODEL, series: [rain('in', [1])] });
		expect(ok.status).toBe(201);
	});
});

describe('series per project', () => {
	it('a new series past the cap is refused (409) on PUT and merge; writing an existing one still works', async () => {
		const { u, id } = await project();
		// Arrange a project one short of the cap (thousands of API calls otherwise).
		await asOwner(
			`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
			 SELECT $1, 'rain_catchment_mm', 'filler ' || g, 'mm', '2020-01-01', '{1}' FROM generate_series(1, $2::int) g`,
			[id, SERIES_PER_PROJECT_MAX - 1]
		);
		// Positive control: the last free slot is taken.
		expect((await u.call('PUT', `/projects/${id}/series`, rain('mm', [1], 'last'))).status).toBe(200);
		const put = await u.call('PUT', `/projects/${id}/series`, rain('mm', [1], 'one more'));
		expect(put.status).toBe(409);
		expect(put.body.error).toContain(`${SERIES_PER_PROJECT_MAX} series`);
		expect((await u.call('POST', `/projects/${id}/series/merge`, rain('mm', [1], 'one more'))).status).toBe(409);
		// A series the project already has isn't a new one.
		expect((await u.call('PUT', `/projects/${id}/series`, rain('mm', [2], 'last'))).status).toBe(200);
		expect((await u.call('POST', `/projects/${id}/series/merge`, rain('mm', [3], 'filler 1'))).status).toBe(200);
	});

	it('a project file with more series than the cap is refused before anything is written', async () => {
		const u = await signUp('SeriesCapImport');
		const series = (n: number) => Array.from({ length: n }, (_, i) => rain('mm', [], `s${i}`));
		const over = await u.call('POST', '/projects/import', { name: 'Too many series', model: EMPTY_MODEL, series: series(SERIES_PER_PROJECT_MAX + 1) });
		expect(over.status).toBe(400);
		expect((await u.call('GET', '/projects')).body.projects).toEqual([]);
		// Positive control: at the cap it imports.
		const ok = await u.call('POST', '/projects/import', { name: 'At the cap', model: EMPTY_MODEL, series: series(SERIES_PER_PROJECT_MAX) });
		expect(ok.status).toBe(201);
	}, 60_000);
});
