// Which node a series may belong to (series/site.ts): a flow record's gauge
// above the outlet, a land unit's own rain (issue #482), nothing else.
import { describe, expect, it } from 'vitest';
import { isFlowSiteKind, isUnitRainKind, siteProblem, type SiteNode } from './site.js';

const gauge: SiteNode = { kind: 'gauge', downstreamNodeId: 'outlet', areaKm2: 0 };
const outlet: SiteNode = { kind: 'gauge', downstreamNodeId: null, areaKm2: 0 };
const farm: SiteNode = { kind: 'farm', downstreamNodeId: 'outlet', areaKm2: 12.5 };
const bare: SiteNode = { kind: 'farm', downstreamNodeId: 'outlet', areaKm2: 0 };
const user: SiteNode = { kind: 'user', downstreamNodeId: 'outlet', areaKm2: 0 };

describe('siteProblem', () => {
	it('puts a flow record at a gauge above the outlet, and nowhere else', () => {
		for (const kind of ['flow_observed_m3s', 'flow_logger_m3s']) {
			expect(isFlowSiteKind(kind)).toBe(true);
			expect(siteProblem(kind, gauge)).toBeNull();
			expect(siteProblem(kind, outlet)).toMatch(/is the outlet/);
			expect(siteProblem(kind, farm)).toMatch(/a flow record’s site is a gauge/);
			expect(siteProblem(kind, undefined)).toMatch(/no such hydrological unit/);
		}
	});

	it('puts a rain series at a land unit: a farm with an area, never a gauge or a water user', () => {
		for (const kind of ['rain_catchment_mm', 'rain_chirps_mm']) {
			expect(isUnitRainKind(kind)).toBe(true);
			expect(siteProblem(kind, farm)).toBeNull();
			expect(siteProblem(kind, gauge)).toMatch(/belongs to a land unit/);
			expect(siteProblem(kind, outlet)).toMatch(/belongs to a land unit/);
			expect(siteProblem(kind, user)).toMatch(/belongs to a land unit/);
			expect(siteProblem(kind, bare)).toMatch(/no area/);
			// A restore takes it back to a unit whose area has since been typed to 0.
			expect(siteProblem(kind, bare, { anyArea: true })).toBeNull();
			expect(siteProblem(kind, undefined)).toMatch(/no such hydrological unit/);
		}
	});

	it('gives nothing else a site', () => {
		for (const kind of ['evap_apan_mm', 'rain_forecast_mm', 'flow_reference_m3s']) {
			expect(isFlowSiteKind(kind) || isUnitRainKind(kind)).toBe(false);
			expect(siteProblem(kind, farm)).toMatch(/only a flow record or a land unit’s rain has a site/);
		}
	});
});
