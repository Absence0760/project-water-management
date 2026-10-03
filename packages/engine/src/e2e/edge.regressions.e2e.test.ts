// Regression tests for the bugs the round-2 edge tests (edge.*.e2e.test.ts)
// found, fixed in engine 1.69.0. Each states the behaviour docs/model.md and
// the engine's own contract specify. Invented values only.
import { describe, expect, it } from 'vitest';
import type { ModelInput, NetworkNode } from '../project';
import { runModel, runModelChecked } from '../run';

const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
const NODE: Omit<NetworkNode, 'id' | 'name' | 'kind' | 'downstreamNodeId'> = {
	sortOrder: 0,
	areaKm2: 0,
	areaHiKm2: 0,
	areaLoKm2: 0,
	flowShareManual: null,
	pctUpstreamToDam: 1,
	pctRunoffToDam: 1,
	damCapacityM3: 0,
	damInitialPct: 0,
	damMinPct: 0,
	divertCapacityM3Day: 0,
	irrigationEfficiency: 1,
	lossReturnFraction: 0,
	damAreaFullM2: 0,
	damAreaExponent: 0.7,
	damSeepagePerDay: 0
};

function input(settings: Record<string, unknown> = {}, nodes?: NetworkNode[]): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', apanMm: APAN as never, ewrPragmaticM3PerDay: new Array(12).fill(500) as never, ...settings } as ModelInput['settings'],
		model: {
			nodes: nodes ?? [
				{ ...NODE, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null },
				{ ...NODE, id: 'A', name: 'Unit A', kind: 'farm', downstreamNodeId: 'G', areaKm2: 4 }
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2000-01-01', values: Array.from({ length: 800 }, (_, t) => (t % 6 === 0 ? 14 : 0)) } }
	};
}

// EDGE-1. Impossible calendar dates in the run's settings. toEpochDay (calendar.ts) parses with Date.parse,
// which rolls an impossible day over (2001-02-29 → 2001-03-01, 2001-04-31 → 2001-05-01) and throws on an
// impossible month. resolveReportWindow (run.ts) means to warn and fall back on a value that "is not a date
// (YYYY-MM-DD)", and runModelCapturing already refuses such a date by a round trip; the window settings don't.
describe('fixed in 1.69.0, EDGE-1: an impossible calendar date in a window setting', () => {
	it('reportStart "2001-02-29" is not a date: the run warns and uses its own start, not 1 March 2001 (§2.11)', () => {
		const o = runModel(input({ reportStart: '2001-02-29', reportEnd: '2001-03-05' }));
		expect(o.summary.warnings).toContain(`reportStart "2001-02-29" is not a date (YYYY-MM-DD); using the run's start`);
		expect(o.summary.curtailment!.reportStart).toBe(o.startDate);
	});

	it('reportEnd "2001-04-31" is not a date: the run warns and uses its own end, not 1 May 2001', () => {
		const o = runModel(input({ reportStart: '2001-04-01', reportEnd: '2001-04-31' }));
		expect(o.summary.warnings).toContain(`reportEnd "2001-04-31" is not a date (YYYY-MM-DD); using the run's end`);
		expect(o.summary.curtailment!.reportEnd).toBe(o.endDate);
	});

	it('reportStart "2001-13-01" warns and falls back instead of throwing out of the whole run', () => {
		let o: ReturnType<typeof runModel> | undefined;
		expect(() => (o = runModel(input({ reportStart: '2001-13-01' })))).not.toThrow();
		expect(o!.summary.warnings).toContain(`reportStart "2001-13-01" is not a date (YYYY-MM-DD); using the run's start`);
	});

	it('simulationStart "2001-02-30" is refused like any other non-date, not run from 2 March', () => {
		// "abc" and "2001-13-01" already throw "not an ISO date"; a day that doesn't exist must too.
		expect(() => runModel(input({ simulationStart: '2001-02-30' }))).toThrow(/not an ISO date/);
	});
});

// EDGE-2. A network with no unit at all (one gauge) and a catchment area set: the natural flow reaches no
// unit, so the gauge sees 0 and the EWR fails every day, yet the run gives no word. §2.5: when the shares sum
// to less than 1 (here 0) "the run warns that natural flow and EWR are not fully allocated to farms"; a
// gauge with zero-area units does warn. network/shares.ts skips the warning when there are no farms.
describe('fixed in 1.69.0, EDGE-2: a gauge-only network', () => {
	it('warns that the natural flow and the EWR are not allocated to any unit (§2.5)', () => {
		const o = runModelChecked(input({ calibration: { catchmentAreaKm2: 5 } }, [{ ...NODE, id: 'G', name: 'Gauge', kind: 'gauge', downstreamNodeId: null }]));
		expect(o.summary.catchment.ewrDaysNotMet).toBe(o.days);
		expect(o.summary.warnings.some((w) => /not fully allocated/.test(w))).toBe(true);
	});
});
