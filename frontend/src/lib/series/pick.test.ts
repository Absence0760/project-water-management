import { describe, expect, it } from 'vitest';
import { byKindThenName, firstOutletSeries } from './pick';

const s = (id: string, kind: string, name: string, siteNodeId: string | null = null) => ({ id, kind, name, siteNodeId });

describe('the series a run reads (issue #523)', () => {
	it('takes the first by the name’s bytes, as the backend’s COLLATE "C", not localeCompare', () => {
		const list = [s('g', 'rain_catchment_mm', 'average gauge'), s('l', 'rain_catchment_mm', 'RAIN-B logger')];
		// localeCompare would take the gauge: the bug this replaces.
		expect('average gauge'.localeCompare('RAIN-B logger')).toBeLessThan(0);
		expect(firstOutletSeries(list, 'rain_catchment_mm')?.id).toBe('l');
		expect(firstOutletSeries([...list].reverse(), 'rain_catchment_mm')?.id).toBe('l');
	});

	it('puts a non-ASCII name after an ASCII one', () => {
		expect(firstOutletSeries([s('a', 'rain_chirps_mm', 'Ärea'), s('z', 'rain_chirps_mm', 'Zeta')], 'rain_chirps_mm')?.id).toBe('z');
	});

	it('skips a sited series (a gauge’s record, a unit’s own rain) and other kinds', () => {
		const list = [s('u', 'rain_chirps_mm', 'A unit', 'n1'), s('c', 'rain_catchment_mm', ''), s('h', 'rain_chirps_mm', 'CHIRPS')];
		expect(firstOutletSeries(list, 'rain_chirps_mm')?.id).toBe('h');
		expect(firstOutletSeries(list, 'flow_observed_m3s')).toBeUndefined();
	});

	it('sorts by kind, then name in byte order', () => {
		const list = [s('1', 'rain_chirps_mm', 'b'), s('2', 'flow_observed_m3s', 'a'), s('3', 'rain_chirps_mm', 'B')];
		expect(byKindThenName(list).map((x) => x.id)).toEqual(['2', '3', '1']);
		expect(list.map((x) => x.id)).toEqual(['1', '2', '3']);
	});
});
