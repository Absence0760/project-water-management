// The per-account cap on elevation-model work (184_dem_attempt, attempt.ts):
// counted before the work, refused and failed attempts too; at most
// DEM_ATTEMPTS.inFlight at once (parallel requests can't all pass the count);
// DEM_ATTEMPTS.perHour across every project; a dead attempt's slot frees after
// the lease; one account's count never touches another's (positive controls).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { ApiError } from '../http/errors.js';
import { beginDemAttempt, DEM_ATTEMPTS, finishDemAttempt } from './attempt.js';

type User = Awaited<ReturnType<typeof signUp>>;
const before = process.env.DEM_URL;

const begin = (u: User) =>
	withUser(u.id, (db) => beginDemAttempt(db, 'delineation')).then(
		(id) => ({ id, status: 200 }),
		(e: unknown) => {
			if (e instanceof ApiError) return { id: null, status: e.status };
			throw e;
		}
	);
const rowsOf = async (u: User) => asOwner(`SELECT kind, finished_at IS NOT NULL AS finished FROM dem_attempt WHERE user_id = $1 ORDER BY started_at`, [u.id]);

afterAll(() => {
	if (before === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before;
});

describe('the in-flight cap', () => {
	it('lets only DEM_ATTEMPTS.inFlight of many parallel attempts through, and frees a slot when one finishes', async () => {
		const u = await signUp('DAparallel');
		const results = await Promise.all(Array.from({ length: 6 }, () => begin(u)));
		expect(results.filter((r) => r.status === 200)).toHaveLength(DEM_ATTEMPTS.inFlight);
		expect(results.filter((r) => r.status === 429)).toHaveLength(6 - DEM_ATTEMPTS.inFlight);
		expect((await begin(u)).status).toBe(429);
		await finishDemAttempt(u.id, results.find((r) => r.id)!.id!);
		expect((await begin(u)).status).toBe(200);
	});

	it('frees the slot of an attempt that never finished once the lease runs out', async () => {
		const u = await signUp('DAlease');
		for (let i = 0; i < DEM_ATTEMPTS.inFlight; i++) expect((await begin(u)).status).toBe(200);
		expect((await begin(u)).status).toBe(429);
		await asOwner(`UPDATE dem_attempt SET started_at = now() - interval '3 minutes' WHERE user_id = $1`, [u.id]);
		expect((await begin(u)).status).toBe(200);
	});

	it('finishes only the caller’s own attempt', async () => {
		const [a, b] = await Promise.all([signUp('DAownA'), signUp('DAownB')]);
		const { id } = await begin(a);
		await finishDemAttempt(b.id, id!);
		expect(await rowsOf(a)).toEqual([{ kind: 'delineation', finished: false }]);
		await finishDemAttempt(a.id, id!);
		expect(await rowsOf(a)).toEqual([{ kind: 'delineation', finished: true }]);
	});
});

describe('the hourly cap', () => {
	it('refuses past DEM_ATTEMPTS.perHour in the last hour, across projects; another account is unaffected; older attempts don’t count', async () => {
		const [u, other] = await Promise.all([signUp('DAhourly'), signUp('DAother')]);
		await asOwner(
			`INSERT INTO dem_attempt (user_id, kind, started_at, finished_at) SELECT $1, 'start', now() - interval '30 minutes', now() - interval '30 minutes' FROM generate_series(1, $2)`,
			[u.id, DEM_ATTEMPTS.perHour]
		);
		expect((await begin(u)).status).toBe(429);
		expect((await begin(other)).status).toBe(200);
		await asOwner(`UPDATE dem_attempt SET started_at = now() - interval '61 minutes' WHERE user_id = $1`, [u.id]);
		expect((await begin(u)).status).toBe(200);
	});
});

describe('through the routes', () => {
	let owner: User;
	let projectId: string;
	beforeAll(async () => {
		owner = await signUp('DAroutes');
		projectId = (await owner.call('POST', '/projects', { name: 'DEM attempts' })).body.project.id;
	});

	it('a refused delineation (DEM off, 409) still counts, and is finished', async () => {
		process.env.DEM_URL = '';
		const res = await owner.call('POST', `/projects/${projectId}/map/delineation`, { lon: 20.6, lat: -33.5, from: 'outlet' });
		expect(res.status).toBe(409);
		expect(await rowsOf(owner)).toEqual([{ kind: 'delineation', finished: true }]);
	});

	it('a divide refused for want of a model (409) is refused before it counts', async () => {
		const res = await owner.call('POST', `/projects/${projectId}/map/divide`, { points: [{ featureId: crypto.randomUUID(), nodeId: null }] });
		expect(res.status).toBe(409);
		expect(await rowsOf(owner)).toHaveLength(1);
	});

	it('a failed delineation (503, a DEM that can’t be read) counts too, for an editor who isn’t the owner, and is finished', async () => {
		const editor = await signUp('DAeditor');
		expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
		const bad = join(mkdtempSync(join(tmpdir(), 'dem-')), 'corrupt.pmtiles');
		writeFileSync(bad, Buffer.alloc(4096, 7));
		process.env.DEM_URL = bad;
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			const res = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: 20.6, lat: -33.5, from: 'outlet' });
			expect(res.status).toBe(503);
		} finally {
			error.mockRestore();
		}
		// A refusal (422: the click is outside the DEM) counts as well.
		process.env.DEM_URL = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
		const outside = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: 30, lat: -25, from: 'outlet' });
		expect(outside.status).toBe(422);
		expect(await rowsOf(editor)).toEqual([
			{ kind: 'delineation', finished: true },
			{ kind: 'delineation', finished: true }
		]);
	});

	it('answers 429 from the account cap before any work, whichever project', async () => {
		await asOwner(`INSERT INTO dem_attempt (user_id, kind) SELECT $1, 'start' FROM generate_series(1, $2)`, [owner.id, DEM_ATTEMPTS.inFlight]);
		const res = await owner.call('POST', `/projects/${projectId}/map/start`, { points: [] });
		expect(res.status).toBe(429);
		expect(res.body.error).toMatch(/elevation-model requests running/);
	});
});
