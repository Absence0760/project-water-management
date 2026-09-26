import { describe, expect, it } from 'vitest';
import { CHIRPS_V3_RNL, CHIRPS_V3_SAT } from '@water-management/engine';
import { CHIRPS_FIRST_DAY, FeedInput, FeedPatch, feedProvenance, SOURCES } from './config.js';

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
