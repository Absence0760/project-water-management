import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { pointInGeometry, type Geometry } from '../geo/geojson.js';
import { REASON_MAX } from '../history/record.js';
import {
	clickRequest,
	ClicksBody,
	CLICKS_MAX,
	firstClickNumber,
	OUTLET_CLICK,
	OUTLET_KEY,
	outsideClick,
	outsideText,
	pastOutletText,
	pieceDescription,
	pieceLabel,
	pieceName,
	savedClick,
	savedOutlet,
	saveSummary,
	subcatchmentProperty,
	toClickPieces,
	type ClickPieces,
	type SavedPiece,
	type Within
} from './clicks.js';
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
		const named = (click: number) => ({ name: pieceName(click), label: String(click + 1), feature: null });
		const r: ClickPieces = {
			pieces: [
				{ ...base, ...named(0), click: 0, point: [20.123456, -33.5], drainsInto: 2, areaM2: null, totalAreaM2: null, geometry: null, open: true },
				{ ...base, ...named(1), click: 1, point: [20.2, -33.6], drainsInto: 2, areaM2: 3e6, totalAreaM2: 3e6 },
				{ ...base, ...named(2), click: 2, point: [20.3, -33.7], drainsInto: null, areaM2: 12e6, totalAreaM2: null }
			],
			firstNumber: 1,
			dropped: [],
			lowest: 2,
			within: null,
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

	it('pieceDescription keeps the elevation model and method whole however many inflows enter, counting the rest (issue #763)', () => {
		const sq = { type: 'Polygon' as const, coordinates: [[[20, -33], [20.1, -33], [20.1, -33.1], [20, -33]]] as [number, number][][] };
		const base = { snapDistanceM: 10, geometry: sq, open: true, larger: null, nonContributingM2: 0, areaM2: null, totalAreaM2: null, feature: null };
		// 60 inflows with 100-character names (FEATURE_NAME_MAX) drain into the lowest click.
		const inflows = Array.from({ length: 60 }, (_, i) => ({ ...base, name: `Inflow ${i} ${'x'.repeat(90)}`.slice(0, 100), label: String(i + 2), click: i + 1, point: [20.2, -33.6] as [number, number], drainsInto: 0 }));
		const lowest = { ...base, open: false, name: pieceName(0), label: '1', click: 0, point: [20.3, -33.7] as [number, number], drainsInto: null, areaM2: 12e6, nonContributingM2: 1.25e6 };
		const r: ClickPieces = {
			pieces: [lowest, ...inflows],
			firstNumber: 1,
			dropped: [],
			lowest: 0,
			within: null,
			cellSizeM: 30,
			dataset: { label: 'Copernicus GLO-30', fingerprint: '0123456789abcdef' },
			method: 'D8',
			methodVersion: 'start-18'
		};
		const text = pieceDescription(r, lowest);
		expect(text.length).toBeLessThanOrEqual(REASON_MAX);
		expect(text).toMatch(/^The land draining to 20.30000° E, 33.70000° S before any other click; /);
		expect(text).toMatch(/; an inflow enters at “Inflow 0 x+” and 59 more\. 1\.25 km² of its own area drains into pans/);
		expect(text.endsWith('Delineated from Copernicus GLO-30 (start-18); check it against the map.')).toBe(true);
		expect(text).not.toContain('…');
	});

	it('names a piece by its click’s number, as the badge shows it, and the catchment outlet’s piece by the outlet', () => {
		expect(pieceName(0)).toBe('Sub-catchment 1');
		expect(pieceName(4)).toBe('Sub-catchment 5');
		expect(pieceName(OUTLET_CLICK)).toBe('Sub-catchment at the outlet');
	});
});

describe('within the catchment boundary', () => {
	const ring = (x0: number, y0: number, x1: number, y1: number) => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)];
	/** A box round the valley above the outlet, as an accepted delineation leaves it (its outlet set below). */
	const box = (outlet: [number, number] | null): Within => ({ featureId: 'b', name: 'Valley', geometry: { type: 'Polygon', coordinates: [ring(OUTLET_CELL.x - 100, OUTLET_CELL.y - 250, OUTLET_CELL.x + 100, OUTLET_CELL.y + 2)] }, outlet });
	const lonLat = (x: number, y: number) => {
		const [lon, lat] = at(x, y);
		return { lon, lat };
	};

	it('finds the first click outside the boundary, and the refusal names the catchment (positive control: inside is -1)', () => {
		const w = box(null);
		expect(outsideClick(w, [lonLat(DAM_CELL.x, DAM_CELL.y + 1)])).toBe(-1);
		expect(outsideClick(w, [lonLat(DAM_CELL.x, DAM_CELL.y + 1), lonLat(OUTLET_CELL.x, OUTLET_CELL.y + 40)])).toBe(1);
		expect(outsideText(w, 1)).toBe('Click 2 is outside “Valley”, the catchment boundary: every sub-catchment lies within it. Click a terrain channel inside the boundary.');
		expect(outsideText({ name: ' ' }, 0)).toMatch(/^Click 1 is outside the catchment boundary, the catchment boundary/);
		expect(pastOutletText(w, 0)).toMatch(/^Click 1 drains more water than “Valley”’s outlet/);
	});

	it('routes no outlet of its own without a boundary, or for one drawn by hand: the lowest click is the outlet, as before', () => {
		const clicks = [lonLat(DAM_CELL.x, DAM_CELL.y + 1)];
		expect(clickRequest(clicks, null).points.map((p) => p.id)).toEqual(['0']);
		expect(clickRequest(clicks, box(null)).points.map((p) => p.id)).toEqual(['0']);
		expect(clickRequest(clicks, null)).toMatchObject({ outlet: 'lowest', boundary: null });
	});

	it('takes a delineated boundary’s outlet as the lowest point: its piece is the land between the clicks and the outlet, and the pieces tile the catchment', async () => {
		const whole = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		const w = box(whole.outlet);
		const req = clickRequest([lonLat(DAM_CELL.x, DAM_CELL.y + 1)], w);
		expect(req.points[0]).toMatchObject({ id: OUTLET_KEY, exact: true, geometry: { coordinates: whole.outlet } });
		const r = toClickPieces(await delineateUnits(dem, req), { featureId: 'b', name: 'Valley', outlet: 'delineation' });
		expect(r.lowest).toBe(OUTLET_CLICK);
		expect(r.within).toEqual({ featureId: 'b', name: 'Valley', outlet: 'delineation' });
		expect(r.pieces.map((p) => [p.click, p.drainsInto])).toEqual([
			[OUTLET_CLICK, null],
			[0, OUTLET_CLICK]
		]);
		const [out, dam] = r.pieces as [(typeof r.pieces)[0], (typeof r.pieces)[0]];
		// On its delineated cell, never moved; the two pieces never nest: together they are the delineated catchment.
		expect(out.point).toEqual(whole.outlet);
		near(out.areaM2! + dam.areaM2!, whole.areaM2, 0.02);
		near(out.totalAreaM2!, whole.areaM2, 0.02);
		expect(pointInGeometry(at(DAM_CELL.x, DAM_CELL.y + 50), out.geometry as Geometry)).toBe(true);
		expect(pointInGeometry(at(DAM_CELL.x, DAM_CELL.y + 50), dam.geometry as Geometry)).toBe(false);
		expect(r.method).toMatch(/\(the outlet: “Valley”’s delineated outlet\)/);
		expect(pieceDescription(r, out)).toMatch(/; the catchment’s delineated outlet; /);
		expect(pieceDescription(r, dam)).toMatch(/; drains into sub-catchment at the outlet; /);
	});

	it('drops a click on the outlet itself, saying it is the catchment’s outlet', async () => {
		const whole = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		const req = clickRequest([lonLat(DAM_CELL.x, DAM_CELL.y + 1), lonLat(OUTLET_CELL.x, OUTLET_CELL.y)], box(whole.outlet));
		const r = toClickPieces(await delineateUnits(dem, req), { featureId: 'b', name: 'Valley', outlet: 'delineation' });
		expect(r.pieces.map((p) => p.click)).toEqual([OUTLET_CLICK, 0]);
		expect(r.dropped).toEqual([{ click: 1, reason: expect.stringMatching(/same place on the river as the catchment’s outlet/) }]);
	});
});

describe('what is already on the map (sub-catchments saved inside the boundary)', () => {
	const ring = (x0: number, y0: number, x1: number, y1: number) => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1), at(x0, y0)];
	const box = (outlet: [number, number]): Within => ({ featureId: 'b', name: 'Valley', geometry: { type: 'Polygon', coordinates: [ring(OUTLET_CELL.x - 100, OUTLET_CELL.y - 250, OUTLET_CELL.x + 100, OUTLET_CELL.y + 2)] }, outlet });
	const lonLat = (x: number, y: number) => {
		const [lon, lat] = at(x, y);
		return { lon, lat };
	};
	const answer = { featureId: 'b', name: 'Valley', outlet: 'delineation' as const };
	/** Just below the dam wall (upstream), and on the river halfway from the dam to the outlet (downstream). */
	const UP = lonLat(DAM_CELL.x, DAM_CELL.y + 1);
	const DOWN = lonLat(OUTLET_CELL.x, OUTLET_CELL.y - 50);
	/** Land only the upstream piece drains (the river above the reservoir), and land only the downstream one does (the flank between the dam and DOWN). */
	const ABOVE = at(DAM_CELL.x, DAM_CELL.y - 60);
	const BETWEEN = at(DAM_CELL.x + 30, DAM_CELL.y + 30);
	const OUTLET_PIECE: SavedPiece = { featureId: 'o', name: 'Sub-catchment at the outlet', outlet: 'catchment' };

	it('divides the land the same whichever is clicked first: a later click upstream carves its piece out of a saved one, a later click downstream stops at it', async () => {
		const whole = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		const w = box(whole.outlet);
		const run = async (clicks: { lon: number; lat: number }[], saved: SavedPiece[] = []) => toClickPieces(await delineateUnits(dem, clickRequest(clicks, w, saved)), answer, saved);
		const area = (r: ClickPieces, click: number) => r.pieces.find((p) => p.click === click)!.areaM2!;

		// The reference: both clicked in one go.
		const both = await run([DOWN, UP]);
		const [refDown, refUp] = [area(both, 0), area(both, 1)];
		expect(both.pieces.find((p) => p.click === 1)!.drainsInto).toBe(0);

		// Downstream first and saved: its piece holds the upstream land too, as nothing above it was clicked yet.
		const downFirst = await run([DOWN]);
		const down1 = downFirst.pieces.find((p) => p.click === 0)!;
		near(down1.areaM2!, refDown + refUp, 0.01);
		expect(pointInGeometry(ABOVE, down1.geometry as Geometry)).toBe(true);
		// Then upstream: the saved downstream piece is split, its upstream land the new piece's, as if both were clicked at once.
		const savedDown: SavedPiece[] = [OUTLET_PIECE, { featureId: 'd', name: 'Sub-catchment 1', outlet: down1.point }];
		const upSecond = await run([UP], savedDown);
		const down2 = upSecond.pieces.find((p) => p.feature?.id === 'd')!;
		const up2 = upSecond.pieces.find((p) => p.click === 0)!;
		expect(down2.click).toBe(savedClick(1));
		near(down2.areaM2!, refDown, 0.01);
		near(up2.areaM2!, refUp, 0.01);
		expect(up2.drainsInto).toBe(down2.click);
		expect(pointInGeometry(ABOVE, up2.geometry as Geometry)).toBe(true);
		expect(pointInGeometry(ABOVE, down2.geometry as Geometry)).toBe(false);
		expect(pointInGeometry(BETWEEN, down2.geometry as Geometry)).toBe(true);
		// Named after what is on the map, the outlet's piece is the saved one, and nothing is dropped.
		expect([up2.name, up2.label, upSecond.firstNumber]).toEqual(['Sub-catchment 2', '2', 2]);
		expect([down2.name, down2.label]).toEqual(['Sub-catchment 1', '1']);
		expect(upSecond.pieces.find((p) => p.click === OUTLET_CLICK)!.feature).toEqual({ id: 'o', name: 'Sub-catchment at the outlet' });
		expect(upSecond.dropped).toEqual([]);

		// Upstream first and saved, then downstream: the new downstream piece stops at the saved one, which keeps its land.
		const upFirst = await run([UP]);
		const up1 = upFirst.pieces.find((p) => p.click === 0)!;
		near(up1.areaM2!, refUp, 0.01);
		const downSecond = await run([DOWN], [OUTLET_PIECE, { featureId: 'u', name: 'Sub-catchment 1', outlet: up1.point }]);
		const down3 = downSecond.pieces.find((p) => p.click === 0)!;
		const up3 = downSecond.pieces.find((p) => p.feature?.id === 'u')!;
		near(down3.areaM2!, refDown, 0.01);
		near(up3.areaM2!, up1.areaM2!, 0.001);
		expect(up3.drainsInto).toBe(down3.click);
		expect(pointInGeometry(ABOVE, down3.geometry as Geometry)).toBe(false);
		expect(pointInGeometry(BETWEEN, down3.geometry as Geometry)).toBe(true);

		// Either way the pieces tile the delineated catchment once: no land counted twice.
		for (const r of [upSecond, downSecond]) near(r.pieces.reduce((s, p) => s + p.areaM2!, 0), whole.areaM2, 0.02);
	});

	it('gives way to a saved piece when a click lands on its outlet, saying so', async () => {
		const whole = await delineate(dem, at(OUTLET_CELL.x, OUTLET_CELL.y));
		const first = toClickPieces(await delineateUnits(dem, clickRequest([UP], box(whole.outlet))), answer);
		const saved: SavedPiece[] = [{ featureId: 'u', name: 'Sub-catchment 1', outlet: first.pieces.find((p) => p.click === 0)!.point }];
		const r = toClickPieces(await delineateUnits(dem, clickRequest([UP], box(whole.outlet), saved)), answer, saved);
		expect(r.pieces.map((p) => p.click)).toEqual([savedClick(0), OUTLET_CLICK]);
		expect(r.dropped).toEqual([{ click: 0, reason: expect.stringMatching(/as another click or a sub-catchment already on the map/) }]);
	});

	it('reads a saved piece’s outlet from its property, or from the description an older save wrote; anything else is no saved piece', () => {
		expect(savedOutlet({ subcatchment: { outlet: [19.1, -33.2] } })).toEqual([19.1, -33.2]);
		expect(savedOutlet({ subcatchment: { outlet: 'catchment' } })).toBe('catchment');
		expect(savedOutlet({ description: 'The land draining to 19.12345° E, 33.54321° S before any other click; drains into sub-catchment 2; 3.00 km² upstream in all.' })).toEqual([19.12345, -33.54321]);
		expect(savedOutlet({ description: 'The land draining to 19.12345° E, 33.54321° S before any other click; the catchment’s delineated outlet; 9.00 km² upstream in all.' })).toBe('catchment');
		expect(savedOutlet({ description: 'Hand-drawn farm' })).toBeNull();
		expect(savedOutlet({ subcatchment: { outlet: ['x', 1] } })).toBeNull();
		expect(savedOutlet(null)).toBeNull();
		expect(subcatchmentProperty({ click: OUTLET_CLICK, point: [1, 2] })).toEqual({ outlet: 'catchment' });
		expect(subcatchmentProperty({ click: 3, point: [1, 2] })).toEqual({ outlet: [1, 2] });
	});

	it('numbers new pieces after those on the map, and badges a piece by the number in its name', () => {
		expect(firstClickNumber([])).toBe(1);
		expect(firstClickNumber([{ name: 'Sub-catchment 3' }, { name: 'Sub-catchment at the outlet' }, { name: 'Upper Twee' }])).toBe(4);
		expect(pieceName(0, 4)).toBe('Sub-catchment 4');
		expect([pieceLabel('Sub-catchment 12'), pieceLabel('Sub-catchment at the outlet'), pieceLabel('upper Twee')]).toEqual(['12', 'O', 'U']);
	});
});

