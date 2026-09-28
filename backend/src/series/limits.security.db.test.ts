// The series limits (series/limits.ts) on every path that writes a series:
// a value that overflows once converted to its canonical unit, and the cap on
// how many series one project holds (PUT, merge, the project file import).
// The cap is hard (075_series_cap.sql): a concurrent burst at the limit gets
// exactly the room left, and an API key limited to some series counts every
// series of the project, not only the ones it can see.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { withApiKey, withUser } from '../db/tx.js';
import { MAX_SERIES_ABS_VALUE, SERIES_PER_PROJECT_MAX } from './limits.js';

const EMPTY_MODEL = { nodes: [], crops: [], cropAreas: [], transfers: [] };

/**
 * Fill the project with `n` series straight in the table (thousands of API calls otherwise). CHIRPS, so a key
 * may still add a catchment rain series (it can't add a second of a kind, series/merge.ts assertKeyMayCreate).
 */
const fill = (id: string, n: number) =>
	asOwner(
		`INSERT INTO time_series (project_id, kind, name, unit, start_date, "values")
		 SELECT $1, 'rain_chirps_mm', 'filler ' || g, 'mm', '2020-01-01', '{1}' FROM generate_series(1, $2::int) g`,
		[id, n]
	);
const seriesIn = async (id: string) => (await asOwner('SELECT count(*)::int AS n FROM time_series WHERE project_id = $1', [id]))[0].n as number;

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

describe('the series cap is hard (075_series_cap.sql)', () => {
	const BURST = 8;

	it('a concurrent burst of new series at the limit gets exactly the room left', async () => {
		const { u, id } = await project();
		await fill(id, SERIES_PER_PROJECT_MAX - 2);
		// Open a connection per request first, so the burst isn't staggered by connecting and really overlaps (jobs/costCaps.security.db.test.ts).
		await Promise.all(Array.from({ length: BURST }, () => withUser(randomUUID(), (db) => db.query('SELECT pg_sleep(0.05)'))));
		const res = await Promise.all(Array.from({ length: BURST }, (_, i) => u.call('PUT', `/projects/${id}/series`, rain('mm', [1], `burst ${i}`))));
		const statuses = res.map((r) => r.status);
		// Positive control: the two free slots are taken.
		expect(statuses.filter((s) => s === 200), JSON.stringify(statuses)).toHaveLength(2);
		expect(statuses.filter((s) => s === 409), JSON.stringify(statuses)).toHaveLength(BURST - 2);
		expect(await seriesIn(id)).toBe(SERIES_PER_PROJECT_MAX);
	});

	it('an API key limited to one series is refused a new one in a full project, though it sees none of the others', async () => {
		const { u, id } = await project();
		// Each key its own kind the project lacks, so the only rule that can refuse the second is the cap.
		const key = async (name: string, kind: string) => {
			const r = await u.call('POST', `/projects/${id}/api-keys`, { name: `Logger ${name}`, allowedSeries: [{ kind, name }] });
			expect(r.status, JSON.stringify(r.body)).toBe(201);
			return r.body as { key: { id: string }; secret: string };
		};
		const push = async (secret: string, name: string, kind: string) =>
			(
				await app.request('/ingest/v1/series/merge', {
					method: 'POST',
					headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
					body: JSON.stringify({ ...rain('mm', [1], name), kind })
				})
			).status;
		await fill(id, SERIES_PER_PROJECT_MAX - 1);
		// Positive control: with a slot left, a limited key creates its series.
		expect(await push((await key('logger a', 'rain_catchment_mm')).secret, 'logger a', 'rain_catchment_mm')).toBe(200);
		const b = await key('logger b', 'rain_reanalysis_mm');
		// The key sees only its own (so far absent) series; the cap counts all of them.
		expect((await withApiKey(b.key.id, (db) => db.query('SELECT count(*)::int AS n FROM time_series'))).rows[0].n).toBe(0);
		expect(await push(b.secret, 'logger b', 'rain_reanalysis_mm')).toBe(409);
		expect(await seriesIn(id)).toBe(SERIES_PER_PROJECT_MAX);
	});

	it('app_project_series_count answers only a caller who may write the project', async () => {
		const { u, id } = await project();
		await fill(id, 3);
		const viewer = await signUp('SeriesCapViewer');
		expect((await u.call('POST', `/projects/${id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const stranger = await signUp('SeriesCapStranger');
		const count = (userId: string) => withUser(userId, async (db) => (await db.query('SELECT app_project_series_count($1) AS n', [id])).rows[0].n);
		// Positive control: the owner (an editor and more) gets every series.
		expect(await count(u.id)).toBe(3);
		expect(await count(viewer.id)).toBeNull();
		expect(await count(stranger.id)).toBeNull();
	});
});
