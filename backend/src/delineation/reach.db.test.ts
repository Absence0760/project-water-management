// The mapped river network never places the outlet (issue #472; place.ts,
// reach.ts), end to end against Postgres and the committed synthetic DEM. A
// reach is planted about 380 m east of the valley's river, as a displaced
// river line sits, and every click is answered exactly as it is with no
// reach loaded:
//  - nearestReach finds it within 1 km, not past it (it only words a
//    too_large refusal);
//  - Delineate on that line, or at a mapped confluence, proposes (or refuses)
//    what it does with no river network, and never asks which river;
//  - a click on the river itself goes on the river's terrain channel, the
//    method saying the network wasn't used;
//  - Sub-catchments likewise; a body naming a reach is refused (400).
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { DAM_CELL, fixtureLonLat, OUTLET_CELL } from './fixture.js';
import { nearestReach } from './reach.js';

type User = Awaited<ReturnType<typeof signUp>>;
const DATASET = 'snap-test';
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = process.env.DEM_URL;
const at = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);
// The line three cells east of the river, from below the dam to 80 cells further down.
const LINE = [at(DAM_CELL.x + 3, DAM_CELL.y + 20), at(DAM_CELL.x + 3, DAM_CELL.y + 100)];
const CLICK = at(DAM_CELL.x + 3, DAM_CELL.y + 60);
const ON_RIVER = at(DAM_CELL.x, DAM_CELL.y + 60);
const SLOPE = at(OUTLET_CELL.x - 91, OUTLET_CELL.y - 120);
let editor: User;
let projectId: string;
let riverKm2: number;

async function plantLine(id: number, km2: number, line: [number, number][]) {
	const lons = line.map((p) => p[0]);
	const lats = line.map((p) => p[1]);
	await asOwner(
		`INSERT INTO river_reference (dataset, reach_id, strahler, upstream_km2, geometry, min_lon, min_lat, max_lon, max_lat, source)
		 VALUES ($1, $2, 3, $3, $4, $5, $6, $7, $8, 'test reach, planted by the synthetic river')`,
		[DATASET, id, km2, JSON.stringify({ type: 'LineString', coordinates: line }), Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
	);
}
const clearReaches = () => asOwner('DELETE FROM river_reference WHERE dataset = $1', [DATASET]);

/** The reach along LINE, and the reach flowing into its upper end. */
async function plantReach(km2: number) {
	await clearReaches();
	await plantLine(99000001, km2, LINE);
	await plantLine(99000003, km2, [at(DAM_CELL.x + 3, DAM_CELL.y - 20), LINE[0]!]);
}

/** A junction at CLICK: the river above ending there, the river below starting there, and a tributary from the hillside. */
async function plantConfluence() {
	await clearReaches();
	await plantLine(99000011, riverKm2 * 0.9, [at(DAM_CELL.x + 3, DAM_CELL.y + 20), CLICK]);
	await plantLine(99000012, riverKm2, [CLICK, at(DAM_CELL.x + 3, DAM_CELL.y + 100)]);
	await plantLine(99000013, 3, [at(DAM_CELL.x + 25, DAM_CELL.y + 45), CLICK]);
}

/** What a delineation answer places, for comparing two of them: the refusal, or the proposal's outlet and area. */
const placed = (r: { status: number; body: { details?: { reason?: string }; proposal?: { outlet: number[]; areaM2: number } } }) =>
	r.status === 201 ? { status: 201, outlet: r.body.proposal!.outlet, areaM2: r.body.proposal!.areaM2 } : { status: r.status, reason: r.body.details?.reason };

const delineate = (p: [number, number], extra: Record<string, unknown> = {}) =>
	editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: p[0], lat: p[1], from: 'outlet', ...extra });

beforeAll(async () => {
	process.env.DEM_URL = FIXTURE;
	await clearReaches();
	editor = await signUp('Reacheditor');
	projectId = (await editor.call('POST', '/projects', { name: 'Reach matching' })).body.project.id;
	// What drains through the river beside the click, for the planted reach's area.
	const r = await delineate(ON_RIVER);
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	riverKm2 = r.body.proposal.areaM2 / 1e6;
}, 60_000);

afterAll(async () => {
	await clearReaches();
	if (before === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before;
});

describe('nearestReach (wording only)', () => {
	it('finds the reach within 1 km, with its area and distance, and nothing past it', async () => {
		await plantReach(riverKm2);
		const near = await withUser(editor.id, (db) => nearestReach(db, CLICK));
		expect(near).toMatchObject({ dataset: DATASET, reachId: 99000001 });
		expect(near!.distanceM).toBeLessThan(5);
		expect(near!.upstreamKm2).toBeCloseTo(riverKm2, 6);
		const far = await withUser(editor.id, (db) => nearestReach(db, at(DAM_CELL.x + 20, DAM_CELL.y + 60)));
		expect(far).toBeNull();
	});
});

describe('Delineate: the mapped river never places the outlet (issue #472)', () => {
	it('puts a click on the river on its terrain channel, and says the network wasn’t used', async () => {
		await plantReach(riverKm2);
		const r = await delineate(ON_RIVER);
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.proposal.snapDistanceM).toBeLessThanOrEqual(150);
		expect(r.body.proposal.method).toMatch(/outlet placed on the terrain channel \(at least 1 km² draining through it\) nearest the point, within 150 m; the mapped river network not used to place it/);
		expect(r.body.proposal.methodVersion).toBe('delineate-13');
		expect(r.body).not.toHaveProperty('check');
	});

	it('answers a click on a displaced river line exactly as with no river network: never moved onto the reach’s river', async () => {
		await clearReaches();
		const without = placed(await delineate(CLICK));
		await plantReach(riverKm2);
		const withReach = placed(await delineate(CLICK));
		expect(withReach).toEqual(without);
		// Not matched to the reach's area: the river's catchment is only where the river's own channel is clicked.
		if (withReach.status === 201) expect(withReach.areaM2! / 1e6).toBeLessThan(0.5 * riverKm2);
	});

	it('never asks which river at a mapped confluence, and answers as with no network', async () => {
		await clearReaches();
		const without = placed(await delineate(CLICK));
		await plantConfluence();
		const r = await delineate(CLICK);
		expect(r.body.details?.reason).not.toBe('confluence');
		expect(placed(r)).toEqual(without);
	});

	it('refuses a body naming a river reach (the confluence pick is gone)', async () => {
		const r = await delineate(CLICK, { reach: { dataset: DATASET, reachId: 99000001 } });
		expect(r.status).toBe(400);
	});

	it('refuses a point with no terrain channel within 150 m, naming the terrain channels', async () => {
		await plantReach(riverKm2);
		// Just past the ridge, where nothing drains a square kilometre.
		const slope = SLOPE;
		const r = await delineate(slope);
		expect(r.status, JSON.stringify(r.body)).toBe(422);
		expect(r.body.details.reason).toBe('off_channel');
		expect(r.body.error).toMatch(/^No terrain channel runs within 150 m of that point\. Zoom in until the terrain channels \(the red lines\) show, and click on one/);
	});
});

describe('Sub-catchments: the mapped river never places a click (issue #472)', () => {
	it('answers the same clicks the same with and without a reach or a confluence, with no reach on any piece', async () => {
		const below = at(DAM_CELL.x, DAM_CELL.y + 120);
		const clicks = [
			{ lon: ON_RIVER[0], lat: ON_RIVER[1] },
			{ lon: below[0], lat: below[1] }
		];
		const shape = (r: { status: number; body: { pieces?: { click: number; point: number[]; areaM2: number | null }[]; details?: { reason?: string } } }) =>
			r.status === 200 ? r.body.pieces!.map((p) => ({ click: p.click, point: p.point, areaM2: p.areaM2 })) : { status: r.status, reason: r.body.details?.reason };
		await clearReaches();
		const without = await editor.call('POST', `/projects/${projectId}/map/subcatchments`, { clicks });
		expect(without.status, JSON.stringify(without.body)).toBe(200);
		expect(without.body.methodVersion).toBe('start-15');
		for (const p of without.body.pieces) {
			expect(p).not.toHaveProperty('reach');
			expect(p).not.toHaveProperty('unmatched');
		}
		await plantReach(riverKm2);
		expect(shape(await editor.call('POST', `/projects/${projectId}/map/subcatchments`, { clicks }))).toEqual(shape(without));
		await plantConfluence();
		expect(shape(await editor.call('POST', `/projects/${projectId}/map/subcatchments`, { clicks }))).toEqual(shape(without));
	});

	it('refuses a click with no terrain channel near it, naming the click', async () => {
		const slope = SLOPE;
		const r = await editor.call('POST', `/projects/${projectId}/map/subcatchments`, {
			clicks: [
				{ lon: ON_RIVER[0], lat: ON_RIVER[1] },
				{ lon: slope[0], lat: slope[1] }
			]
		});
		expect(r.status, JSON.stringify(r.body)).toBe(422);
		expect(r.body).toMatchObject({ error: expect.stringMatching(/^No terrain channel runs within 150 m of click 2\./), details: { reason: 'off_channel' } });
	});
});
