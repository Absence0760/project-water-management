import type { NetworkNode } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { hasForecastRain, runBlockers } from './runReady';

const farm = (id: string, extra: object = {}) => ({ id, name: id, kind: 'farm', ...extra }) as unknown as NetworkNode;
const rain = [{ kind: 'rain_catchment_mm' }];

describe('runBlockers', () => {
	it('needs a network and a rainfall series', () => {
		expect(runBlockers({ nodes: [] }, [])).toEqual({ missing: ['a network', 'a rainfall series'] });
		expect(runBlockers({ nodes: [farm('a')] }, rain)).toEqual({ missing: [] });
	});

	it('does not count rain missing before the series list has loaded', () => {
		expect(runBlockers({ nodes: [] }, null).missing).toEqual(['a network']);
	});

	it('no longer refuses manual flow shares over 100 %: the method is gone and the shares add up (issue #616)', () => {
		// A model revision from before engine 1.105.0 may still carry them; the run ignores them.
		const r = runBlockers({ nodes: [farm('a', { flowShareManual: 0.7 }), farm('b', { flowShareManual: 0.6 })] }, rain);
		expect(r).toEqual({ missing: [] });
	});
});

describe('hasForecastRain', () => {
	it('is true only with a forecast rain series', () => {
		expect(hasForecastRain(null)).toBe(false);
		expect(hasForecastRain(rain)).toBe(false);
		expect(hasForecastRain([...rain, { kind: 'rain_forecast_mm' }])).toBe(true);
	});
});
