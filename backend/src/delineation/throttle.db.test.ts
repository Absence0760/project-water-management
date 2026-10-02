// The hourly cap on tracing a dam, counted before the work
// (186_map_compute_throttle.sql, delineation/throttle.ts):
//  - every attempt counts, a refused one too (tracing off here: 409);
//  - saving a traced outline counts as a trace, an untraced outline doesn't;
//  - past the project cap: 429 with Retry-After; another project of the
//    same user still has its own (positive control);
//  - parallel attempts are counted one by one under the row lock, so no more
//    than the cap get through;
//  - the cap is per user across projects too;
//  - an hour on, the window starts again;
//  - the table is closed to the app role, and the function refuses a viewer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { MAP_COMPUTE_CAPS } from './throttle.js';

type User = Awaited<ReturnType<typeof signUp>>;
let owner: User;
let viewer: User;
let projectId: string;
let otherId: string;
const before = process.env.WATER_URL;
const at = (p: string, pid = projectId) => `/projects/${pid}${p}`;
const CLICK = { lon: 20.7, lat: -33.5 };
const CAP = MAP_COMPUTE_CAPS.trace;
const RING = [
	[20.6, -33.5],
	[20.61, -33.5],
	[20.61, -33.49],
	[20.6, -33.49],
	[20.6, -33.5]
];

const bucket = (b: string) => asOwner('SELECT attempts FROM map_compute_throttle WHERE bucket = $1', [b]).then((r) => (r[0]?.attempts as number | undefined) ?? 0);
const plant = (b: string, n: number, age = '0 seconds') =>
	asOwner(
		`INSERT INTO map_compute_throttle (bucket, attempts, window_start) VALUES ($1, $2, now() - $3::interval)
		 ON CONFLICT (bucket) DO UPDATE SET attempts = $2, window_start = now() - $3::interval`,
		[b, n, age]
	);
const newProject = async (u: User, name: string) => (await u.call('POST', '/projects', { name })).body.project.id as string;

beforeAll(async () => {
	[owner, viewer] = (await Promise.all(['Towner', 'Tviewer'].map((n) => signUp(n)))) as [User, User];
	projectId = await newProject(owner, 'Throttle');
	otherId = await newProject(owner, 'Throttle, other');
	expect((await owner.call('POST', at('/members'), { email: viewer.email, role: 'viewer' })).status).toBe(201);
	// Tracing off: every attempt is refused after the gate (409), with no raster to read.
	process.env.WATER_URL = '';
}, 60_000);

afterAll(() => {
	if (before === undefined) delete process.env.WATER_URL;
	else process.env.WATER_URL = before;
});

describe('the dam-trace throttle', () => {
	it('counts every attempt and a traced save, not an untraced one; past the project cap 429 with Retry-After', async () => {
		expect((await owner.call('POST', at('/map/dam-trace'), CLICK)).status).toBe(409);
		expect(await bucket(`project:${projectId}:trace`)).toBe(1);
		const traced = { kind: 'dam', geometry: { type: 'Polygon', coordinates: [RING] }, traced: { ...CLICK, minOccurrence: 25, edited: true } };
		expect((await owner.call('POST', at('/map/features'), traced)).status).toBe(409);
		expect(await bucket(`project:${projectId}:trace`)).toBe(2);
		expect((await owner.call('POST', at('/map/features'), { kind: 'dam', geometry: { type: 'Polygon', coordinates: [RING] } })).status).toBe(201);
		expect(await bucket(`project:${projectId}:trace`)).toBe(2);

		await plant(`project:${projectId}:trace`, CAP.perProject);
		const res = await app.request(at('/map/dam-trace'), {
			method: 'POST',
			headers: { cookie: owner.cookie, origin: 'http://localhost:7777', 'content-type': 'application/json' },
			body: JSON.stringify(CLICK)
		});
		expect(res.status).toBe(429);
		const wait = Number(res.headers.get('retry-after'));
		expect(wait).toBeGreaterThan(3500);
		expect(wait).toBeLessThanOrEqual(3600);
		expect((await owner.call('POST', at('/map/features'), traced)).status).toBe(429);
		// Positive control: another project of the same user still has its own.
		expect((await owner.call('POST', at('/map/dam-trace', otherId), CLICK)).status).toBe(409);
	});

	it('lets no more than the cap through when attempts arrive together', async () => {
		const q = await newProject(owner, 'Throttle, parallel');
		await plant(`project:${q}:trace`, CAP.perProject - 3);
		const statuses = await Promise.all(Array.from({ length: 8 }, () => owner.call('POST', at('/map/dam-trace', q), CLICK).then((r) => r.status)));
		expect(statuses.filter((s) => s !== 429)).toHaveLength(3);
		expect(await bucket(`project:${q}:trace`)).toBe(CAP.perProject);
	});

	it('caps a user across projects, counting nothing in the project then', async () => {
		const u = await signUp('Tmany');
		const p = await newProject(u, 'Throttle, user');
		await plant(`user:${u.id}:trace`, CAP.perUser);
		expect((await u.call('POST', at('/map/dam-trace', p), CLICK)).status).toBe(429);
		expect(await bucket(`project:${p}:trace`)).toBe(0);
	});

	it('starts the window again an hour on, and says how long is left of a part-used one', async () => {
		const q = await newProject(owner, 'Throttle, window');
		await plant(`project:${q}:trace`, CAP.perProject, '61 minutes');
		expect((await owner.call('POST', at('/map/dam-trace', q), CLICK)).status).toBe(409);
		expect(await bucket(`project:${q}:trace`)).toBe(1);
		await plant(`project:${q}:trace`, CAP.perProject, '50 minutes');
		const { rows } = await withUser(owner.id, (db) => db.query<{ wait: number }>(`SELECT app_map_compute_attempt($1, 'trace', $2, $3) AS wait`, [q, CAP.perUser, CAP.perProject]));
		expect(rows[0]!.wait).toBeGreaterThan(9 * 60);
		expect(rows[0]!.wait).toBeLessThanOrEqual(10 * 60);
	});

	it('is closed to the app role, and the function refuses a viewer and an unknown kind (an editor may: positive control)', async () => {
		expect((await withUser(owner.id, (db) => db.query('SELECT * FROM map_compute_throttle'))).rowCount).toBe(0);
		await expect(withUser(viewer.id, (db) => db.query(`SELECT app_map_compute_attempt($1, 'trace', 10, 10)`, [projectId]))).rejects.toMatchObject({ code: '42501' });
		await expect(withUser(owner.id, (db) => db.query(`SELECT app_map_compute_attempt($1, 'dem', 10, 10)`, [otherId]))).rejects.toMatchObject({ code: '42501' });
		const { rows } = await withUser(owner.id, (db) => db.query<{ wait: number }>(`SELECT app_map_compute_attempt($1, 'trace', 1000, 1000) AS wait`, [otherId]));
		expect(rows[0]!.wait).toBe(0);
	});
});
