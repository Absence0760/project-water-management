import type { NetworkNode } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { hasForecastRain, runBlockers } from './runReady';

const farm = (id: string, share: number | null) => ({ id, name: id, kind: 'farm', flowShareManual: share }) as unknown as NetworkNode;
const rain = [{ kind: 'rain_catchment_mm' }];

describe('runBlockers', () => {
	it('needs a network and a rainfall series', () => {
		expect(runBlockers({ nodes: [] }, {}, [])).toEqual({ missing: ['a network', 'a rainfall series'], overAllocated: null });
		expect(runBlockers({ nodes: [farm('a', 1)] }, { flowShareMethod: 'manual' }, rain)).toEqual({ missing: [], overAllocated: null });
	});

	it('does not count rain missing before the series list has loaded', () => {
		expect(runBlockers({ nodes: [] }, {}, null).missing).toEqual(['a network']);
	});

	it('refuses flow shares over 100 %, which make water from nowhere', () => {
		const r = runBlockers({ nodes: [farm('a', 0.7), farm('b', 0.6)] }, { flowShareMethod: 'manual' }, rain);
		expect(r.missing).toEqual([]);
		expect(r.overAllocated).toMatch(/^unit flow shares sum to 130\.00%/);
	});
});

describe('hasForecastRain', () => {
	it('is true only with a forecast rain series', () => {
		expect(hasForecastRain(null)).toBe(false);
		expect(hasForecastRain(rain)).toBe(false);
		expect(hasForecastRain([...rain, { kind: 'rain_forecast_mm' }])).toBe(true);
	});
});
