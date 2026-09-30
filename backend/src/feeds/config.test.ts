import { describe, expect, it } from 'vitest';
import { CHIRPS_V3_RNL, CHIRPS_V3_SAT } from '@water-management/engine';
import { bboxCellCount, bboxCells, BBOX_MAX_CELLS, BBOX_MAX_ROWS, CHIRPS_FIRST_DAY, FeedInput, FeedPatch, feedProvenance, gridCells, SOURCES } from './config.js';

const cells = [{ lat: -20.12, lon: 25.17 }];

describe('FeedInput', () => {
	it('defaults the target to the source’s first kind, the name to "", daily, enabled; cell weight 1', () => {
		expect(FeedInput.parse({ source: 'chirps', config: { cells } })).toEqual({
			source: 'chirps',
			config: { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] },
			targetKind: 'rain_chirps_mm',
			targetName: '',
			schedule: 'daily',
			enabled: true,
			replaceSeries: false
		});
		expect(FeedInput.parse({ source: 'chirps_gefs', config: { cells } }).targetKind).toBe('rain_forecast_mm');
		expect(FeedInput.parse({ source: 'dws', config: { station: ' x0h000 ' } })).toMatchObject({ targetKind: 'flow_observed_m3s', config: { station: 'X0H000' } });
	});

	it('lets a source write only its own kinds', () => {
		expect(FeedInput.parse({ source: 'dws', config: { station: 'X0H000' }, targetKind: 'flow_reference_m3s' }).targetKind).toBe('flow_reference_m3s');
		const bad = FeedInput.safeParse({ source: 'dws', config: { station: 'X0H000' }, targetKind: 'rain_chirps_mm' });
		expect(bad.success).toBe(false);
		expect(bad.error!.issues[0]).toMatchObject({ path: ['targetKind'] });
		expect(FeedInput.safeParse({ source: 'chirps', config: { cells }, targetKind: 'flow_observed_m3s' }).success).toBe(false);
	});

	it.each([
		['no cells', { source: 'chirps', config: { cells: [] } }],
		['26 cells', { source: 'chirps', config: { cells: Array.from({ length: 26 }, () => cells[0]) } }],
		['a latitude beyond the grid', { source: 'chirps', config: { cells: [{ lat: 61, lon: 25 }] } }],
		['a negative weight', { source: 'chirps', config: { cells: [{ ...cells[0], weight: -1 }] } }],
		['a station on a grid source', { source: 'chirps', config: { station: 'X0H000' } }],
		['cells on DWS', { source: 'dws', config: { cells } }],
		['a malformed station', { source: 'dws', config: { station: 'X0H0001; DROP' } }],
		['an unknown config key', { source: 'dws', config: { station: 'X0H000', url: 'http://evil' } }],
		['an unknown source', { source: 'saws', config: {} }],
		['an unknown field', { source: 'dws', config: { station: 'X0H000' }, actingUserId: 'x' }],
		['a start date that isn’t one', { source: 'dws', config: { station: 'X0H000', startDate: '2021-02-30' } }],
		// Every day before CHIRPS begins is a 404: the first window would find
		// nothing, and with no newest day the next fetch would read it again, forever.
		['a CHIRPS start date before the record begins', { source: 'chirps', config: { cells, startDate: '1980-12-31' } }]
	])('refuses %s', (_, body) => {
		expect(FeedInput.safeParse(body).success).toBe(false);
	});

	it('takes a CHIRPS start date from the first day of the record', () => {
		expect(FeedInput.parse({ source: 'chirps', config: { cells, startDate: CHIRPS_FIRST_DAY, product: 'rnl' } }).config).toMatchObject({ startDate: '1981-01-01' });
		const r = FeedInput.safeParse({ source: 'chirps', config: { cells, startDate: '1970-01-01', product: 'rnl' } });
		expect(r.error!.issues[0]).toMatchObject({ path: ['config', 'startDate'], message: 'CHIRPS begins on 1981-01-01' });
	});

	// Issue #40 part c: v3's sat product starts in 1998. An earlier start is
	// the rnl product end to end, never rnl spliced onto sat.
	it('takes a CHIRPS sat start date from 1998 only, and points an earlier one at the rnl product', () => {
		expect(FeedInput.parse({ source: 'chirps', config: { cells, startDate: '1998-01-01' } }).config).toMatchObject({ startDate: '1998-01-01' });
		const r = FeedInput.safeParse({ source: 'chirps', config: { cells, startDate: '1997-12-31' } });
		expect(r.error!.issues[0]).toMatchObject({ path: ['config', 'startDate'], message: expect.stringMatching(/sat daily product begins on 1998-01-01; for earlier days use the rnl product for the whole record/) });
		expect(FeedInput.parse({ source: 'chirps', config: { cells, startDate: '1985-01-01', product: 'rnl' } }).config).toMatchObject({ product: 'rnl' });
	});

	it('gives a daily product to CHIRPS only, and says what each feed writes', () => {
		const r = FeedInput.safeParse({ source: 'chirps_gefs', config: { cells, product: 'rnl' } });
		expect(r.error!.issues[0]).toMatchObject({ path: ['config', 'product'] });
		expect(FeedInput.safeParse({ source: 'chirps', config: { cells, product: 'imerg' } }).success).toBe(false);
		expect(feedProvenance('chirps', { cells: [] })).toEqual(CHIRPS_V3_SAT);
		expect(feedProvenance('chirps', { cells: [], product: 'rnl' })).toEqual(CHIRPS_V3_RNL);
		expect(feedProvenance('chirps_gefs', { cells: [] })).toBeNull();
		expect(feedProvenance('dws', { station: 'X0H000' })).toBeNull();
	});

	// Only river gauges (H codes) are requested correctly and write a river
	// flow: a reservoir's (R) daily table is its spillway discharge, and the
	// other letters (E, N, T…) are weather, rainfall or tidal stations.
	it.each(['X0R000', 'X0E000', 'X0N000', 'X0T000', 'X0L000'])('refuses the non-river-gauge station %s, saying why', (station) => {
		const r = FeedInput.safeParse({ source: 'dws', config: { station } });
		expect(r.success).toBe(false);
		expect(r.error!.issues[0]).toMatchObject({ path: ['config', 'station'], message: expect.stringMatching(/river gauge.*H code/) });
	});

	it('accepts a river gauge in any drainage region, upper-casing it', () => {
		expect(FeedInput.parse({ source: 'dws', config: { station: 'a2h012' } }).config).toMatchObject({ station: 'A2H012' });
	});

	it('points a config issue at config.<field>', () => {
		const r = FeedInput.safeParse({ source: 'dws', config: { station: 'nope' } });
		expect(r.error!.issues[0]!.path).toEqual(['config', 'station']);
	});

	it('every source has a unit and at least one kind', () => {
		for (const s of Object.values(SOURCES)) {
			expect(s.kinds.length).toBeGreaterThan(0);
			expect(s.unit).toMatch(/^(mm|m³\/s)$/);
		}
	});
});

describe('FeedPatch', () => {
	it('takes any subset, and nothing unknown', () => {
		expect(FeedPatch.parse({ enabled: false })).toEqual({ enabled: false });
		expect(FeedPatch.safeParse({ lastSuccessAt: '2026-01-01' }).success).toBe(false);
	});
});

describe('bounding box → grid cells (bboxCells, gridCells)', () => {
	const cos = (lat: number) => Math.cos((lat * Math.PI) / 180);

	it('a box drawn on grid lines covers whole cells only: no sliver from float error at its edges', () => {
		// −20.1 / 0.05 is −402.00000000000006 in floating point; the edge must still be on the line.
		const cells = bboxCells({ south: -20.2, west: 25.1, north: -20.1, east: 25.2 });
		expect(cells.map((c) => [c.lat, c.lon])).toEqual([
			[-20.175, 25.125],
			[-20.175, 25.175],
			[-20.125, 25.125],
			[-20.125, 25.175]
		]);
		for (const c of cells) expect(c.weight).toBeCloseTo(cos(c.lat), 9);
		expect(bboxCellCount({ south: -20.3, west: 25, north: -20, east: 25.4 })).toEqual({ rows: 6, cells: 48 });
	});

	it('a box inside one cell is that cell (its centre, so the reader picks it)', () => {
		expect(bboxCells({ south: -20.14, west: 25.16, north: -20.11, east: 25.19 })).toEqual([{ lat: -20.125, lon: 25.175, weight: expect.any(Number) }]);
	});

	it('weights a partial cell by the share of it inside the box', () => {
		// Rows: −20.05…−20.10 whole, −20.10…−20.13 is 0.6 of its cell; columns: 25.12…25.15 is 0.6, 25.15…25.20 whole.
		const cells = bboxCells({ south: -20.13, west: 25.12, north: -20.05, east: 25.2 });
		const w = Object.fromEntries(cells.map((c) => [`${c.lat},${c.lon}`, c.weight]));
		expect(Object.keys(w)).toHaveLength(4);
		expect(w['-20.075,25.175']).toBeCloseTo(cos(-20.075), 8);
		expect(w['-20.075,25.125']).toBeCloseTo(0.6 * cos(-20.075), 8);
		expect(w['-20.125,25.175']).toBeCloseTo(0.6 * cos(-20.125), 8);
		expect(w['-20.125,25.125']).toBeCloseTo(0.36 * cos(-20.125), 8);
	});

	it('weights by area: a cell further from the equator counts for less (cos latitude)', () => {
		const [low, high] = [bboxCells({ south: 0, west: 10, north: 0.05, east: 10.05 })[0]!, bboxCells({ south: 59.95, west: 10, north: 60, east: 10.05 })[0]!];
		expect(low.weight).toBeCloseTo(cos(0.025), 9);
		expect(high.weight).toBeCloseTo(cos(59.975), 9);
		expect(high.weight / low.weight).toBeCloseTo(0.5, 3);
	});

	it('is the same for a box in the western and northern hemispheres (floor, not truncation)', () => {
		expect(bboxCells({ south: 10.01, west: -30.04, north: 10.04, east: -30.01 }).map((c) => [c.lat, c.lon])).toEqual([[10.025, -30.025]]);
	});

	it('gridCells passes a cells feed through unchanged', () => {
		const g = FeedInput.parse({ source: 'chirps', config: { cells } }).config as Parameters<typeof gridCells>[0];
		expect(gridCells(g)).toEqual([{ lat: -20.12, lon: 25.17, weight: 1 }]);
	});
});

describe('GridConfig with a bounding box', () => {
	const bbox = { south: -20.2, west: 25.1, north: -20.1, east: 25.2 };

	it('takes skipNoData with a box', () => {
		expect(FeedInput.parse({ source: 'chirps', config: { bbox, skipNoData: true } }).config).toEqual({ bbox, skipNoData: true });
		expect(FeedInput.safeParse({ source: 'chirps', config: { cells, skipNoData: true } }).error!.issues[0]).toMatchObject({ path: ['config', 'skipNoData'] });
	});

	it('takes a box for CHIRPS and CHIRPS-GEFS', () => {
		expect(FeedInput.parse({ source: 'chirps', config: { bbox } }).config).toEqual({ bbox });
		expect(FeedInput.parse({ source: 'chirps_gefs', config: { bbox } }).config).toEqual({ bbox });
	});

	it('takes the largest box: 100 cells, and 25 rows', () => {
		expect(FeedInput.safeParse({ source: 'chirps', config: { bbox: { south: -20.5, west: 25, north: -20, east: 25.5 } } }).success).toBe(true);
		expect(FeedInput.safeParse({ source: 'chirps', config: { bbox: { south: -21.25, west: 25, north: -20, east: 25.2 } } }).success).toBe(true);
		expect([BBOX_MAX_CELLS, BBOX_MAX_ROWS]).toEqual([100, 25]);
	});

	it.each([
		['both cells and a box', { cells, bbox }],
		['neither cells nor a box', {}],
		['a box of 110 cells (10 rows × 11)', { bbox: { south: -20.5, west: 25, north: -20.01, east: 25.51 } }],
		['a box of 26 rows', { bbox: { south: -21.3, west: 25, north: -20, east: 25.05 } }],
		['south above north', { bbox: { ...bbox, south: -20, north: -20.2 } }],
		['a zero-height box', { bbox: { ...bbox, north: -20.2 } }],
		['a box across 180°', { bbox: { south: -20.2, west: 179.9, north: -20.1, east: -179.9 } }],
		['a box beyond the grid', { bbox: { south: -60.1, west: 25, north: -59.9, east: 25.1 } }],
		['a box with an unknown key', { bbox: { ...bbox, crs: 'EPSG:4326' } }],
		['a box missing an edge', { bbox: { south: -20.2, west: 25.1, north: -20.1 } }],
		['skipNoData with listed cells (they stay strict)', { cells, skipNoData: true }],
		['skipNoData that isn’t a boolean', { bbox, skipNoData: 'yes' }],
		['skipNoData inside the box', { bbox: { ...bbox, skipNoData: true } }]
	])('refuses %s', (_, config) => {
		expect(FeedInput.safeParse({ source: 'chirps', config }).success).toBe(false);
	});

	it('says the limit, in degrees, for a box too big', () => {
		const r = FeedInput.safeParse({ source: 'chirps', config: { bbox: { south: -21, west: 25, north: -20, east: 26 } } });
		expect(r.error!.issues[0]).toMatchObject({
			path: ['config', 'bbox'],
			message: expect.stringMatching(/at most 100 of the 0\.05° grid cells in at most 25 rows \(about 0\.5° × 0\.5°.*this one covers 400 cells in 20 rows/)
		});
	});
});
