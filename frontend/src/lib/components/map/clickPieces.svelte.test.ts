import { describe, expect, it, vi } from 'vitest';
import type { ClickPiece, ClickPieces } from '$lib/api/types';
import { ApiError } from '$lib/api/client';
import { ClickDivider, clickShape, pieceLine, savable } from './clickPieces.svelte';

const sq = (x: number): ClickPiece['geometry'] => ({ type: 'Polygon', coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] });
const piece = (click: number, drainsInto: number | null, km2: number, totalKm2 = km2): ClickPiece => ({
	click,
	point: [click + 0.5, 0],
	snapDistanceM: 10,
	drainsInto,
	geometry: sq(click),
	areaM2: km2 * 1e6,
	totalAreaM2: totalKm2 * 1e6,
	open: false,
	placedBy: 'snapped',
	reach: null,
	larger: null,
	unmatched: null
});
/** An inflow point: its catchment ran past the routed window, so it has no piece. */
const inflow = (click: number, drainsInto: number | null): ClickPiece => ({ ...piece(click, drainsInto, 0), geometry: null, areaM2: null, totalAreaM2: null, open: true });
const answer = (pieces: ClickPiece[], lowest: number, dropped: ClickPieces['dropped'] = []): ClickPieces => ({
	pieces,
	dropped,
	lowest,
	cellSizeM: 30,
	dataset: { label: 'Synthetic DEM 1', fingerprint: '0123456789abcdef' },
	method: 'D8',
	methodVersion: 'start-2'
});

describe('clickShape', () => {
	it('numbers each piece by its click, the lowest click the outlet and every other kept click marked', () => {
		const s = clickShape(answer([piece(0, 1, 2), piece(1, null, 5, 7)], 1), '0')!;
		expect(s.pieces.map((p) => [p.key, p.label, p.name])).toEqual([
			['0', '1', 'Sub-catchment 1'],
			['1', '2', 'Sub-catchment 2']
		]);
		expect(s.outlet).toEqual([1.5, 0]);
		expect(s.outlets).toEqual([[0.5, 0]]);
		expect(s.highlight).toBe('0');
		expect(s.geometry.coordinates).toHaveLength(2);
		// Touching pieces never share a tint.
		expect(s.pieces[0]!.tint).not.toBe(s.pieces[1]!.tint);
	});

	it('keeps one id for every answer, so the map frames the first pieces only', () => {
		expect(clickShape(answer([piece(0, null, 2)], 0))!.id).toBe(clickShape(answer([piece(0, 1, 2), piece(1, null, 5)], 1))!.id);
	});

	it('draws nothing without a piece to outline', () => {
		expect(clickShape(null)).toBeNull();
		expect(clickShape(answer([], 0))).toBeNull();
		expect(clickShape(answer([{ ...piece(0, null, 2), geometry: null }], 0))).toBeNull();
	});
});

describe('pieceLine', () => {
	it('says a piece’s area, where its water goes and all that is upstream, or why a click is not a piece', () => {
		const r = answer([piece(0, 1, 2), piece(1, null, 5, 7)], 1, [{ click: 2, reason: 'doesn’t drain to the lowest click' }]);
		expect(pieceLine(r, 0)).toBe('2.00 km² · drains into 2 · 2.00 km² upstream in all');
		expect(pieceLine(r, 1)).toBe('5.00 km² · the lowest point: the rest drains out here · 7.00 km² upstream in all');
		expect(pieceLine(r, 2)).toBe('not a piece: it doesn’t drain to the lowest click');
		expect(pieceLine(answer([piece(0, null, 3)], 0), 0)).toBe('3.00 km² · the lowest point: the rest drains out here');
	});

	it('says a click was put on the channel matching its river reach', () => {
		const r = answer([{ ...piece(0, null, 410), placedBy: 'matched', reach: { dataset: 'HydroRIVERS-v10', reachId: 11492928, upstreamKm2: 412.5 } }], 0);
		expect(pieceLine(r, 0)).toBe('410.00 km² · the lowest point: the rest drains out here · on the channel matching river reach 11492928 (412.50 km²)');
	});

	it('names a much larger channel beside a click, instead of the missed-channel warning', () => {
		const r = answer([{ ...piece(0, null, 0.02), point: [21.465, -28.389], larger: { at: [21.465, -28.3845], distanceM: 504, km2: 619.8, pointKm2: 0.02 } }], 0);
		expect(pieceLine(r, 0)).toBe(
			'0.02 km² · the lowest point: the rest drains out here · a much larger channel (620 km²) runs 504 m north: the river line may sit off the channel the elevation model sees'
		);
	});

	it('says how far a click moved to the channel, from 50 m', () => {
		expect(pieceLine(answer([{ ...piece(0, null, 3), snapDistanceM: 128 }], 0), 0)).toBe('3.00 km² · the lowest point: the rest drains out here · moved 128 m to the channel');
		expect(pieceLine(answer([{ ...piece(0, null, 3), snapDistanceM: 40 }], 0), 0)).toBe('3.00 km² · the lowest point: the rest drains out here');
	});

	it('warns when a river reach nearby matches no channel at the click', () => {
		const r = answer([{ ...piece(0, null, 3), unmatched: { dataset: 'HydroRIVERS-v10', reachId: 11492928, upstreamKm2: 412.5 } }], 0);
		expect(pieceLine(r, 0)).toBe(
			'3.00 km² · the lowest point: the rest drains out here · river reach 11492928 nearby drains 412.50 km², and no channel near the click matches it: check it is the right stream'
		);
	});

	it('warns that a click with under a square kilometre upstream probably missed the channel', () => {
		const r = answer([piece(0, 1, 0.02), piece(1, null, 5, 5.02)], 1);
		expect(pieceLine(r, 0)).toBe('0.02 km² · drains into 2 · 0.02 km² upstream in all · very little drains here: it probably missed the channel; Undo and click closer to the river (the Relief layer shows the valley)');
		expect(pieceLine(r, 1)).not.toMatch(/missed/);
	});

	it('says an inflow point has no piece, and the piece it flows into gets an inflow with no known total', () => {
		const r = answer([inflow(0, 1), { ...piece(1, null, 5), totalAreaM2: null }], 1);
		expect(pieceLine(r, 0)).toBe('an inflow point: its catchment runs past the area routed around the clicks, so no piece; the water from above it enters 2 as an inflow');
		expect(pieceLine(r, 1)).toBe('5.00 km² · the lowest point: the rest drains out here · more upstream than was routed · an inflow enters at 1');
		expect(pieceLine(answer([inflow(0, null)], 0), 0)).toMatch(/enters here as an inflow$/);
		expect(savable(r).map((p) => p.click)).toEqual([1]);
		expect(savable(null)).toEqual([]);
	});
});

describe('ClickDivider', () => {
	const make = () => {
		const fetch = vi.fn(async (clicks: { lon: number; lat: number }[]) => answer(clicks.map((_, i) => piece(i, i === 0 ? null : i - 1, 1)), 0));
		const save = vi.fn(async () => ({ features: [], summary: '2 sub-catchments' }));
		return { d: new ClickDivider(fetch, save), fetch, save };
	};

	it('routes every click with the ones before it', async () => {
		const { d, fetch } = make();
		await d.add([20, -33]);
		await d.add([20.1, -33.1]);
		expect(fetch).toHaveBeenLastCalledWith([
			{ lon: 20, lat: -33 },
			{ lon: 20.1, lat: -33.1 }
		]);
		expect(d.result!.pieces).toHaveLength(2);
		expect(d.said).toBe('2 sub-catchments.');
	});

	it('undoes to the answer it had, without asking the server again', async () => {
		const { d, fetch } = make();
		await d.add([20, -33]);
		await d.add([20.1, -33.1]);
		d.undo();
		expect(d.clicks).toEqual([{ lon: 20, lat: -33 }]);
		expect(d.result!.pieces).toHaveLength(1);
		expect(fetch).toHaveBeenCalledTimes(2);
		d.undo();
		expect(d.clicks).toEqual([]);
		expect(d.result).toBeNull();
		expect(d.canUndo).toBe(false);
	});

	it('takes back a click the server refuses, with the reason, keeping the clicks before it', async () => {
		const { d, fetch } = make();
		await d.add([20, -33]);
		fetch.mockRejectedValueOnce(new Error('The catchment above the lowest click reaches beyond the 98 km the app delineates around it.'));
		await d.add([22, -28]);
		expect(d.clicks).toEqual([{ lon: 20, lat: -33 }]);
		expect(d.result!.pieces).toHaveLength(1);
		expect(d.error).toMatch(/^Click not added: The catchment above the lowest click/);
		expect(d.busy).toBeNull();
	});

	it('says when the newest click is not a piece', async () => {
		const fetch = vi.fn(async () => answer([piece(0, null, 1)], 0, [{ click: 1, reason: 'doesn’t drain to the lowest click' }]));
		const d = new ClickDivider(fetch, vi.fn());
		await d.add([20, -33]);
		await d.add([21, -33]);
		expect(d.said).toBe('Click 2 is not a piece: it doesn’t drain to the lowest click.');
	});

	it('counts the inflow points apart from the pieces, and saves nothing when there are only inflows', async () => {
		const fetch = vi.fn(async () => answer([inflow(0, 1), { ...piece(1, null, 5), totalAreaM2: null }], 1));
		const save = vi.fn();
		const d = new ClickDivider(fetch, save);
		await d.add([20, -33]);
		expect(d.said).toBe('1 sub-catchment, 1 inflow point.');
		const only = new ClickDivider(async () => answer([inflow(0, null)], 0), save);
		await only.add([20, -33]);
		expect(await only.save()).toBeNull();
		expect(save).not.toHaveBeenCalled();
	});

	it('says at once when the newest click probably missed the channel', async () => {
		const d = new ClickDivider(async () => answer([piece(0, null, 0.01)], 0), vi.fn());
		await d.add([20, -33]);
		expect(d.said).toMatch(/^Click 1: very little drains here: it probably missed the channel; /);
	});

	it('moves a click to the larger channel and routes again; Undo moves it back without asking', async () => {
		const { d, fetch } = make();
		await d.add([20, -33]);
		await d.add([20.1, -33.1]);
		await d.replace(0, [20.005, -33]);
		expect(fetch).toHaveBeenLastCalledWith([
			{ lon: 20.005, lat: -33 },
			{ lon: 20.1, lat: -33.1 }
		]);
		expect(d.clicks).toHaveLength(2);
		d.undo();
		expect(d.clicks[0]).toEqual({ lon: 20, lat: -33 });
		expect(d.said).toBe('Moved the click back.');
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it('says when a refused move leaves the click where it was', async () => {
		const { d, fetch } = make();
		await d.add([20, -33]);
		fetch.mockRejectedValueOnce(new Error('The clicks are outside the elevation model.'));
		await d.replace(0, [25, -30]);
		expect(d.clicks).toEqual([{ lon: 20, lat: -33 }]);
		expect(d.error).toBe('Click 1 not moved: The clicks are outside the elevation model.');
	});

	it('holds a click at a confluence until the river is picked, then routes it with that reach', async () => {
		const { d, fetch } = make();
		await d.add([20, -33]);
		const choices = [{ dataset: 'H', reachId: 7, upstreamKm2: 420, distanceM: 90, role: 'below' as const, label: 'the river below the junction' }];
		fetch.mockRejectedValueOnce(new ApiError(422, 'Click 2: This point is at a confluence', { reason: 'confluence', click: 1, choices }));
		await d.add([20.1, -33.1]);
		expect(d.clicks).toHaveLength(1);
		expect(d.error).toBeNull();
		expect(d.pendingChoice).toMatchObject({ click: 1, choices });
		expect(d.said).toBe('Click 2 is at a confluence: pick the river you mean.');
		await d.chooseReach(choices[0]!);
		expect(fetch).toHaveBeenLastCalledWith([
			{ lon: 20, lat: -33 },
			{ lon: 20.1, lat: -33.1, reach: { dataset: 'H', reachId: 7 } }
		]);
		expect(d.pendingChoice).toBeNull();
		expect(d.clicks).toHaveLength(2);
	});

	it('drops a click held at a confluence on request', async () => {
		const { d, fetch } = make();
		fetch.mockRejectedValueOnce(new ApiError(422, 'Click 1: …', { reason: 'confluence', click: 0, choices: [{ dataset: 'H', reachId: 7, upstreamKm2: 420, distanceM: 90, role: 'below', label: 'the river below the junction' }] }));
		await d.add([20, -33]);
		d.cancelChoice();
		expect(d.pendingChoice).toBeNull();
		expect(d.clicks).toEqual([]);
		expect(d.said).toBe('Dropped the click at the confluence.');
	});

	it('keeps only the newest answer when clicks overlap', async () => {
		let release: (r: ClickPieces) => void = () => {};
		const fetch = vi.fn((clicks: { lon: number; lat: number }[]) =>
			clicks.length === 1 ? new Promise<ClickPieces>((r) => (release = r)) : Promise.resolve(answer([piece(0, null, 1), piece(1, 0, 1)], 0))
		);
		const d = new ClickDivider(fetch, vi.fn());
		const first = d.add([20, -33]);
		await d.add([20.1, -33.1]);
		release(answer([piece(0, null, 9)], 0));
		await first;
		expect(d.result!.pieces).toHaveLength(2);
		expect(d.busy).toBeNull();
	});

	it('saves the clicks it has and clears them; a failed save keeps them with the error', async () => {
		const { d, save } = make();
		expect(await d.save()).toBeNull();
		await d.add([20, -33]);
		save.mockRejectedValueOnce(new Error('Too many'));
		expect(await d.save()).toBeNull();
		expect(d.error).toBe('Too many');
		expect(d.clicks).toHaveLength(1);
		expect(await d.save()).toEqual({ features: [], summary: '2 sub-catchments' });
		expect(save).toHaveBeenLastCalledWith([{ lon: 20, lat: -33 }]);
		expect(d.clicks).toEqual([]);
		expect(d.result).toBeNull();
	});
});
