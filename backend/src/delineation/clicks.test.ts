import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pointInGeometry, type Geometry } from '../geo/geojson.js';
import { ClicksBody, CLICKS_MAX, pieceDescription, pieceName, saveSummary, toClickPieces, type ClickPieces } from './clicks.js';
import { openDem } from './dem.js';
import { delineate, DelineationRefused } from './delineate.js';
import { DAM_CELL, fixtureLonLat, OUTLET_CELL } from './fixture.js';
import { delineateUnits, type UnitPoint } from './subcatchments.js';

// Sub-catchments from clicks on the rivers, against the committed synthetic
// DEM (fixture.ts: one valley, its river south along the axis, a dam).

const dem = openDem(fileURLToPath(new URL('../../fixtures/dem/synthetic-dem.pmtiles', import.meta.url)));
const at = (x: number, y: number) => fixtureLonLat(x + 0.5, y + 0.5);
const click = (i: number, x: number, y: number, hints: Partial<UnitPoint> = {}): UnitPoint => ({ id: String(i), name: `click ${i + 1}`, role: 'abstraction', geometry: { type: 'Point', coordinates: at(x, y) }, ...hints });
const near = (a: number, b: number, tol: number) => expect(Math.abs(a / b - 1)).toBeLessThan(tol);

describe('delineateUnits with the lowest click as the outlet', () => {
	it('takes the click most water drains through as the outlet, whatever order the clicks came in', async () => {
		const whole = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		// The upper click first: the order of the clicks is not the order down the river.
		const r = await delineateUnits(dem, { outlet: 'lowest', boundary: null, points: [click(0, DAM_CELL.x, DAM_CELL.y + 1), click(1, OUTLET_CELL.x, OUTLET_CELL.y)] });
		expect(r.outlet).toMatchObject({ foundIn: 'lowest', id: '1' });
		expect(r.units.map((u) => u.id)).toEqual(['0']);
		near(r.catchment.areaM2, whole.areaM2, 0.01);
		near(r.units[0]!.areaM2 + r.rest.areaM2, r.catchment.areaM2, 0.01);
	});

	it('refuses with a sentence for clicks: none, or every catchment past the window', async () => {
		const none = await delineateUnits(dem, { outlet: 'lowest', boundary: null, points: [] }).catch((e: unknown) => e);
		expect(none).toBeInstanceOf(DelineationRefused);
		expect((none as Error).message).toMatch(/Click a river first/);
		const big = await delineateUnits(dem, { outlet: 'lowest', boundary: null, points: [click(0, OUTLET_CELL.x, OUTLET_CELL.y)] }, { windows: [64] }).catch((e: unknown) => e);
		expect((big as DelineationRefused).code).toBe('too_large');
		expect((big as Error).message).toMatch(/^Every click’s catchment runs past the \d+ km the app routes around the clicks, so none is whole\. .*enters as an inflow\.$/);
	});

	it('names a lower click that missed the river, rather than blame the clicks’ layout (the hydrologist’s review, finding 11)', async () => {
		// Click 1 on the river; click 2 meant below it, but on a small terrain channel of the valley's side beside the river, so it
		// drains to the river further down. The window holds that side channel (a smaller one cuts it under a square kilometre) but
		// not the river above click 1.
		const big = await delineateUnits(dem, { outlet: 'lowest', boundary: null, points: [click(0, DAM_CELL.x, DAM_CELL.y + 40), click(1, DAM_CELL.x + 3, DAM_CELL.y + 60)] }, { windows: [160] }).catch(
			(e: unknown) => e
		);
		expect((big as DelineationRefused).code).toBe('too_large');
		expect((big as Error).message).toMatch(
			/^Click 1 is the click most water drains through, and its catchment runs past the \d+ km the app routes around the clicks, so it can’t be a whole piece\. Click 2 landed on a channel draining [\d.]+ km², with a much larger channel \d+ m west of it: it doesn’t drain to click 1, so it is on another river or missed this one\. If you meant it below click 1, Undo and click on the river itself: .*enters as an inflow\.$/
		);
	});
});

describe('toClickPieces', () => {
	it('gives each click its incremental catchment, in click order: they tile the catchment and each drains into the next click down', async () => {
		const above = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 1));
		const top = await delineate(dem, at(DAM_CELL.x, DAM_CELL.y - 60));
		// Middle, outlet, top: the lowest is click 1.
		const r = toClickPieces(
			await delineateUnits(dem, {
				outlet: 'lowest',
				boundary: null,
				points: [click(0, DAM_CELL.x, DAM_CELL.y + 1), click(1, OUTLET_CELL.x, OUTLET_CELL.y), click(2, DAM_CELL.x, DAM_CELL.y - 60)]
			})
		);
		expect(r.lowest).toBe(1);
		expect(r.pieces.map((p) => [p.click, p.drainsInto])).toEqual([
			[0, 1],
			[1, null],
			[2, 0]
		]);
		const [mid, low, upper] = r.pieces as [(typeof r.pieces)[0], (typeof r.pieces)[0], (typeof r.pieces)[0]];
		// The top click's piece is all above it; the middle's is what lies between it and the top.
		near(upper.areaM2!, top.areaM2, 0.03);
		near(mid.areaM2! + upper.areaM2!, above.areaM2, 0.02);
		near(mid.totalAreaM2!, above.areaM2, 0.02);
		near(low.totalAreaM2!, low.areaM2! + mid.areaM2! + upper.areaM2!, 0.01);
		expect(r.pieces.some((p) => p.open)).toBe(false);
		// Each piece is where it should be.
		expect(pointInGeometry(at(DAM_CELL.x, DAM_CELL.y - 90), upper.geometry as Geometry)).toBe(true);
		expect(pointInGeometry(at(DAM_CELL.x, DAM_CELL.y - 30), mid.geometry as Geometry)).toBe(true);
		expect(pointInGeometry(at(DAM_CELL.x, DAM_CELL.y - 30), upper.geometry as Geometry)).toBe(false);
		expect(pointInGeometry(at(DAM_CELL.x, DAM_CELL.y + 50), low.geometry as Geometry)).toBe(true);
		expect(r.dropped).toEqual([]);
		expect(r.dataset.fingerprint).toMatch(/^[0-9a-f]{16}$/);
	});

	it('drops a click on another river or on the same spot, saying why, by its index', async () => {
		const r = toClickPieces(
			await delineateUnits(dem, {
				outlet: 'lowest',
				boundary: null,
				points: [click(0, OUTLET_CELL.x, OUTLET_CELL.y), click(1, OUTLET_CELL.x + 150, OUTLET_CELL.y - 100), click(2, OUTLET_CELL.x, OUTLET_CELL.y), click(3, DAM_CELL.x, DAM_CELL.y + 1)]
			})
		);
		expect(r.pieces.map((p) => p.click)).toEqual([0, 3]);
		expect(r.dropped).toEqual([
			{ click: 1, reason: expect.stringMatching(/doesn’t drain to the lowest click/) },
			{ click: 2, reason: expect.stringMatching(/same place on the river as the lowest click/) }
		]);
	});
});

describe('a click whose catchment runs past the window (an inflow point)', () => {
	it('is open, with no piece; the piece below it is whole, and the totals above the cut are unknown', async () => {
		// A 256-cell window around the dam and the outlet: the valley's head (above the dam) runs past it, the land between them doesn't.
		const between = (await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y))).areaM2 - (await delineate(dem, at(DAM_CELL.x, DAM_CELL.y + 1))).areaM2;
		const r = toClickPieces(
			await delineateUnits(dem, { outlet: 'lowest', boundary: null, points: [click(0, DAM_CELL.x, DAM_CELL.y + 1), click(1, OUTLET_CELL.x, OUTLET_CELL.y)] }, { windows: [256] })
		);
		const [dam, low] = r.pieces as [(typeof r.pieces)[0], (typeof r.pieces)[0]];
		expect(dam).toMatchObject({ click: 0, open: true, geometry: null, areaM2: null, totalAreaM2: null, drainsInto: 1 });
		expect(low).toMatchObject({ click: 1, open: false, totalAreaM2: null, drainsInto: null });
		near(low.areaM2!, between, 0.03);
		expect(pointInGeometry(at(DAM_CELL.x, DAM_CELL.y + 50), low.geometry as Geometry)).toBe(true);
	});
});

describe('the request and the names', () => {
	it('takes 1 to CLICKS_MAX clicks of degrees and nothing else', () => {
		const c = { lon: 20.74, lat: -33.54 };
		expect(ClicksBody.safeParse({ clicks: [c] }).success).toBe(true);
		expect(ClicksBody.safeParse({ clicks: [] }).success).toBe(false);
		expect(ClicksBody.safeParse({ clicks: Array.from({ length: CLICKS_MAX + 1 }, () => c) }).success).toBe(false);
		expect(ClicksBody.safeParse({ clicks: [{ ...c, geometry: {} }] }).success).toBe(false);
		expect(ClicksBody.safeParse({ clicks: [{ lon: 200, lat: 0 }] }).success).toBe(false);
		expect(ClicksBody.safeParse({ clicks: [c], pieces: [] }).success).toBe(false);
	});

	it('describes a saved piece and sums up a save, naming the inflow points it leaves out', () => {
		const sq = { type: 'Polygon' as const, coordinates: [[[20, -33], [20.1, -33], [20.1, -33.1], [20, -33]]] as [number, number][][] };
		const base = { snapDistanceM: 10, geometry: sq, open: false, larger: null, nonContributingM2: 0 };
		const r: ClickPieces = {
			pieces: [
				{ ...base, click: 0, point: [20.123456, -33.5], drainsInto: 2, areaM2: null, totalAreaM2: null, geometry: null, open: true },
				{ ...base, click: 1, point: [20.2, -33.6], drainsInto: 2, areaM2: 3e6, totalAreaM2: 3e6 },
				{ ...base, click: 2, point: [20.3, -33.7], drainsInto: null, areaM2: 12e6, totalAreaM2: null }
			],
			dropped: [],
			lowest: 2,
			cellSizeM: 30,
			dataset: { label: 'Copernicus GLO-30', fingerprint: '0123456789abcdef' },
			method: 'D8',
			methodVersion: 'start-2'
		};
		expect(pieceDescription(r, r.pieces[1]!)).toBe(
			'The land draining to 20.20000° E, 33.60000° S before any other click; drains into sub-catchment 3; 3.00 km² upstream in all. Delineated from Copernicus GLO-30 (start-2); check it against the map.'
		);
		expect(pieceDescription(r, r.pieces[2]!)).toBe(
			'The land draining to 20.30000° E, 33.70000° S before any other click; the lowest click; more upstream than was routed; an inflow enters at sub-catchment 1. Delineated from Copernicus GLO-30 (start-2); check it against the map.'
		);
		// A piece part of which drains into pans says how much (start-11); one with none says nothing of it.
		expect(pieceDescription(r, { ...r.pieces[1]!, nonContributingM2: 1.25e6 })).toBe(
			'The land draining to 20.20000° E, 33.60000° S before any other click; drains into sub-catchment 3; 3.00 km² upstream in all. 1.25 km² of its own area drains into pans (non-contributing in WR2012’s sense; still in its area). Delineated from Copernicus GLO-30 (start-2); check it against the map.'
		);
		expect(saveSummary(r, [r.pieces[1]!, r.pieces[2]!])).toBe('2 sub-catchments, 15.00 km² in all; 1 inflow point not saved (Sub-catchment 1)');
		expect(saveSummary(r, [r.pieces[2]!])).toBe('1 sub-catchment, 12.00 km² in all; 1 inflow point not saved (Sub-catchment 1); 1 couldn’t be outlined and weren’t saved');
	});

	it('names a piece by its click’s number, as the badge shows it', () => {
		expect(pieceName(0)).toBe('Sub-catchment 1');
		expect(pieceName(4)).toBe('Sub-catchment 5');
	});
});
