// "Propose from the double-mass breaks" reads the catchment rain and CHIRPS a run reads (issue #523): the outlet's,
// first by the name's bytes, never a unit's own series. Synthetic names only.
import type { SeriesMeta } from '@water-management/engine';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/api', () => ({ api: {} }));
const { fitRangeSeries } = await import('./proposeFitRanges');

const s = (id: string, kind: string, name: string, siteNodeId: string | null = null) => ({ id, kind, name, siteNodeId }) as unknown as SeriesMeta;

describe('fitRangeSeries', () => {
	it('takes the outlet’s first series of each kind by byte order, skipping a unit’s own', () => {
		const list = [
			s('unit', 'rain_chirps_mm', 'A unit’s CHIRPS', 'node-1'),
			s('gauge', 'rain_catchment_mm', 'average gauge'),
			s('logger', 'rain_catchment_mm', 'RAIN-B logger'),
			s('chirps', 'rain_chirps_mm', 'CHIRPS')
		];
		expect(fitRangeSeries(list)).toEqual({ catchment: list[2], chirps: list[3] });
	});
	it('gives null for a kind the project lacks', () => {
		expect(fitRangeSeries([s('chirps', 'rain_chirps_mm', 'CHIRPS')]).catchment).toBeNull();
	});
});
