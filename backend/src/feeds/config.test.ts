import { describe, expect, it } from 'vitest';
import { CHIRPS_FIRST_DAY, FeedInput, FeedPatch, SOURCES } from './config.js';

const cells = [{ lat: -20.12, lon: 25.17 }];

describe('FeedInput', () => {
	it('defaults the target to the source’s first kind, the name to "", daily, enabled; cell weight 1', () => {
		expect(FeedInput.parse({ source: 'chirps', config: { cells } })).toEqual({
			source: 'chirps',
			config: { cells: [{ lat: -20.12, lon: 25.17, weight: 1 }] },
			targetKind: 'rain_chirps_mm',
			targetName: '',
			schedule: 'daily',
			enabled: true
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
		expect(FeedInput.parse({ source: 'chirps', config: { cells, startDate: CHIRPS_FIRST_DAY } }).config).toMatchObject({ startDate: '1981-01-01' });
		const r = FeedInput.safeParse({ source: 'chirps', config: { cells, startDate: '1970-01-01' } });
		expect(r.error!.issues[0]).toMatchObject({ path: ['config', 'startDate'], message: 'CHIRPS begins on 1981-01-01' });
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
