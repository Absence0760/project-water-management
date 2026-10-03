// The outlet matched to a nearby river reach's upstream area (issue #374;
// delineation/place.ts, reach.ts), end to end against Postgres and the
// committed synthetic DEM. A reach is planted about 380 m east of the
// valley's river, as a displaced river line sits:
//  - nearestReach finds it within 1 km, not past it;
//  - Delineate on that line matches the outlet to the river, not the hillside;
//  - with no reach, the same click is refused (422) naming the larger
//    channel, and keepPoint keeps the small catchment;
//  - Sub-catchments says which clicks were matched, and to which reach.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { DAM_CELL, fixtureLonLat } from './fixture.js';
import { nearestReach } from './reach.js';

type User = Awaited<ReturnType<typeof signUp>>;
const DATASET = 'snap-test';
const FIXTURE = fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url));
const before = process.env.DEM_URL;
const at = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);
// The line three cells east of the river, from below the dam to 80 cells further down.
const LINE = [at(DAM_CELL.x + 3, DAM_CELL.y + 20), at(DAM_CELL.x + 3, DAM_CELL.y + 100)];
const CLICK = at(DAM_CELL.x + 3, DAM_CELL.y + 60);
const [clon, clat] = CLICK;
let editor: User;
let projectId: string;
let riverKm2: number;

async function plantReach(km2: number) {
	await asOwner('DELETE FROM river_reference WHERE dataset = $1', [DATASET]);
	const lons = LINE.map((p) => p[0]);
	const lats = LINE.map((p) => p[1]);
	await asOwner(
		`INSERT INTO river_reference (dataset, reach_id, strahler, upstream_km2, geometry, min_lon, min_lat, max_lon, max_lat, source)
		 VALUES ($1, 99000001, 3, $2, $3, $4, $5, $6, $7, 'test reach, planted off the synthetic river')`,
		[DATASET, km2, JSON.stringify({ type: 'LineString', coordinates: LINE }), Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
	);
}

beforeAll(async () => {
	process.env.DEM_URL = FIXTURE;
	editor = await signUp('Reacheditor');
	projectId = (await editor.call('POST', '/projects', { name: 'Reach matching' })).body.project.id;
	// What drains through the river beside the click, for the planted reach's area.
	const r = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: at(DAM_CELL.x, DAM_CELL.y + 60)[0], lat: at(DAM_CELL.x, DAM_CELL.y + 60)[1], from: 'outlet' });
	expect(r.status, JSON.stringify(r.body)).toBe(201);
	riverKm2 = r.body.proposal.areaM2 / 1e6;
}, 60_000);

afterAll(async () => {
	await asOwner('DELETE FROM river_reference WHERE dataset = $1', [DATASET]);
	if (before === undefined) delete process.env.DEM_URL;
	else process.env.DEM_URL = before;
});

describe('nearestReach', () => {
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

describe('Delineate', () => {
	it('matches a click on the planted line to the river’s catchment, saying so in the method', async () => {
		await plantReach(riverKm2);
		const r = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: clon, lat: clat, from: 'outlet' });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(Math.abs(r.body.proposal.areaM2 / 1e6 / riverKm2 - 1)).toBeLessThan(0.05);
		expect(r.body.proposal.method).toMatch(/best matches reach 99000001 of snap-test/);
		expect(r.body.proposal.methodVersion).toBe('delineate-4');
	});

	it('without a reach, refuses beside the larger channel and names it; keepPoint keeps the small catchment', async () => {
		await asOwner('DELETE FROM river_reference WHERE dataset = $1', [DATASET]);
		const r = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: clon, lat: clat, from: 'outlet' });
		expect(r.status).toBe(422);
		expect(r.body.error).toMatch(/^A much larger channel runs \d+ m west of your point/);
		expect(r.body.details.reason).toBe('larger_channel');
		expect(r.body.details.larger).toMatchObject({ at: [expect.any(Number), expect.any(Number)], distanceM: expect.any(Number), km2: expect.any(Number), pointKm2: expect.any(Number) });
		const kept = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: clon, lat: clat, from: 'outlet', keepPoint: true });
		expect(kept.status, JSON.stringify(kept.body)).toBe(201);
		expect(kept.body.proposal.areaM2 / 1e6).toBeLessThan(0.05 * riverKm2);
		// Using the channel it named gives the river's catchment.
		const [lon, lat] = r.body.details.larger.at;
		const used = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon, lat, from: 'outlet' });
		expect(Math.abs(used.body.proposal.areaM2 / 1e6 / riverKm2 - 1)).toBeLessThan(0.05);
	});
});

describe('the river-network check', () => {
	it('warns when a reach nearby matches no channel’s area, on the proposal and on the click’s piece', async () => {
		// The planted reach says 5 000 km²: no channel within 1 km drains within half of that.
		await plantReach(5000);
		const onRiver = at(DAM_CELL.x, DAM_CELL.y + 60);
		const r = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: onRiver[0], lat: onRiver[1], from: 'outlet' });
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		expect(r.body.check).toMatch(/^The river network has reach 99000001 of snap-test near this point, draining about 5\s?000 km², but no channel within 1 km drains within half of that: this catchment \([\d.]+ km²\) may be on another stream\./);
		const clicks = await editor.call('POST', `/projects/${projectId}/map/subcatchments`, { clicks: [{ lon: onRiver[0], lat: onRiver[1] }] });
		expect(clicks.body.pieces[0]).toMatchObject({ placedBy: 'snapped', reach: null, unmatched: { reachId: 99000001, upstreamKm2: 5000 } });
		// A matching reach: no check.
		await plantReach(riverKm2);
		const ok = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: onRiver[0], lat: onRiver[1], from: 'outlet' });
		expect(ok.body.check).toBeNull();
	});
});

describe('at a confluence (issue #374’s follow-up)', () => {
	/** A small tributary reach ending at the click, from the hillside east of it: with the river's reach, the click is at a junction. */
	async function plantTributary(km2: number) {
		const line = [at(DAM_CELL.x + 25, DAM_CELL.y + 45), at(DAM_CELL.x + 4, DAM_CELL.y + 60)];
		const lons = line.map((p) => p[0]);
		const lats = line.map((p) => p[1]);
		await asOwner(
			`INSERT INTO river_reference (dataset, reach_id, strahler, upstream_km2, geometry, min_lon, min_lat, max_lon, max_lat, source)
			 VALUES ($1, 99000002, 1, $2, $3, $4, $5, $6, $7, 'test tributary')`,
			[DATASET, km2, JSON.stringify({ type: 'LineString', coordinates: line }), Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
		);
	}

	it('asks which river at a junction of different rivers, and matches the one chosen', async () => {
		await plantReach(riverKm2);
		await plantTributary(3);
		const r = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: clon, lat: clat, from: 'outlet' });
		expect(r.status).toBe(422);
		expect(r.body.details.reason).toBe('confluence');
		expect(r.body.error).toMatch(/^This point is at a confluence: .*Pick the river you mean\.$/);
		const ids = r.body.details.choices.map((c: { reachId: number }) => c.reachId).sort();
		expect(ids).toEqual([99000001, 99000002]);
		expect(r.body.details.choices.find((c: { reachId: number }) => c.reachId === 99000002)).toMatchObject({ role: 'above', upstreamKm2: 3 });
		// The river: matched to its area, the click moved onto it.
		const river = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: clon, lat: clat, from: 'outlet', reach: { dataset: DATASET, reachId: 99000001 } });
		expect(river.status, JSON.stringify(river.body)).toBe(201);
		expect(Math.abs(river.body.proposal.areaM2 / 1e6 / riverKm2 - 1)).toBeLessThan(0.05);
		expect(river.body.proposal.method).toMatch(/best matches reach 99000001 of snap-test/);
		// A reach id from elsewhere: refused, never trusted.
		const far = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: clon, lat: clat, from: 'outlet', reach: { dataset: DATASET, reachId: 12345 } });
		expect(far.status).toBe(400);
		expect(far.body.error).toMatch(/isn’t within 1 km of the point/);
	});

	it('at a real junction (a river above ending there, one below starting there, a tributary), puts the river below at the DEM’s junction', async () => {
		await asOwner('DELETE FROM river_reference WHERE dataset = $1', [DATASET]);
		const line = (id: number, km2: number, coords: [number, number][]) => {
			const lons = coords.map((p) => p[0]);
			const lats = coords.map((p) => p[1]);
			return asOwner(
				`INSERT INTO river_reference (dataset, reach_id, strahler, upstream_km2, geometry, min_lon, min_lat, max_lon, max_lat, source)
				 VALUES ($1, $2, 2, $3, $4, $5, $6, $7, $8, 'test junction')`,
				[DATASET, id, km2, JSON.stringify({ type: 'LineString', coordinates: coords }), Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
			);
		};
		await line(99000011, riverKm2 * 0.9, [at(DAM_CELL.x + 3, DAM_CELL.y + 20), CLICK]);
		await line(99000012, riverKm2, [CLICK, at(DAM_CELL.x + 3, DAM_CELL.y + 100)]);
		// The synthetic valley's side streams are its hillside rows, about 1.4 km² each where they reach the river.
		await plantTributary(1.2);
		const r = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: clon, lat: clat, from: 'outlet' });
		expect(r.status).toBe(422);
		expect(r.body.details.choices.map((c: { role: string }) => c.role)).toEqual(['below', 'above', 'above']);
		const below = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: clon, lat: clat, from: 'outlet', reach: { dataset: DATASET, reachId: 99000012 } });
		expect(below.status, JSON.stringify(below.body)).toBe(201);
		expect(below.body.proposal.method).toMatch(/outlet placed at the DEM's own junction for reach 99000012 of snap-test, picked at a confluence/);
		// Below the junction it holds the tributary's water too: more than the main river above it.
		const main = await editor.call('POST', `/projects/${projectId}/map/delineation`, { lon: clon, lat: clat, from: 'outlet', reach: { dataset: DATASET, reachId: 99000011 } });
		expect(main.status, JSON.stringify(main.body)).toBe(201);
		expect(main.body.proposal.method).toMatch(/DEM's own junction for reach 99000011/);
		expect(below.body.proposal.areaM2).toBeGreaterThan(main.body.proposal.areaM2);
	});

	it('names the ambiguous click in Sub-catchments, and takes its chosen reach', async () => {
		await plantReach(riverKm2);
		await plantTributary(3);
		const below = at(DAM_CELL.x, DAM_CELL.y + 120);
		const ask = await editor.call('POST', `/projects/${projectId}/map/subcatchments`, { clicks: [{ lon: below[0], lat: below[1] }, { lon: clon, lat: clat }] });
		expect(ask.status).toBe(422);
		expect(ask.body).toMatchObject({ error: expect.stringMatching(/^Click 2: This point is at a confluence/), details: { reason: 'confluence', click: 1 } });
		const ok = await editor.call('POST', `/projects/${projectId}/map/subcatchments`, {
			clicks: [
				{ lon: below[0], lat: below[1] },
				{ lon: clon, lat: clat, reach: { dataset: DATASET, reachId: 99000001 } }
			]
		});
		expect(ok.status, JSON.stringify(ok.body)).toBe(200);
		expect(ok.body.pieces.find((p: { click: number }) => p.click === 1)).toMatchObject({ placedBy: 'matched', reach: { reachId: 99000001 } });
	});
});

describe('Sub-catchments', () => {
	it('matches a click to its reach and says which; an unmatched click beside the river names the larger channel', async () => {
		await plantReach(riverKm2);
		const below = at(DAM_CELL.x, DAM_CELL.y + 120);
		const r = await editor.call('POST', `/projects/${projectId}/map/subcatchments`, {
			clicks: [
				{ lon: clon, lat: clat },
				{ lon: below[0], lat: below[1] }
			]
		});
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		const [matched] = r.body.pieces;
		expect(matched).toMatchObject({ click: 0, placedBy: 'matched', reach: { dataset: DATASET, reachId: 99000001 }, larger: null });
		expect(r.body.methodVersion).toBe('start-7');
		await asOwner('DELETE FROM river_reference WHERE dataset = $1', [DATASET]);
		const plain = await editor.call('POST', `/projects/${projectId}/map/subcatchments`, {
			clicks: [
				{ lon: clon, lat: clat },
				{ lon: below[0], lat: below[1] }
			]
		});
		const off = plain.body.pieces.find((p: { click: number }) => p.click === 0);
		expect(off).toMatchObject({ placedBy: 'snapped', reach: null, larger: { distanceM: expect.any(Number) } });
	});
});
