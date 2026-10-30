// get_run_readiness's view (issue #610, the 2026-10-30 production test): the
// Run model button's own blockers (the engine's runReady.ts), its notes, and
// what a run does not need. Against Postgres and RLS: assistant-tools.db.test.ts.
import type { NetworkNode } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { MAX_NAMED_UNITS, NOT_REQUIRED, readinessView } from './readiness.js';

const farm = (id: string, extra: Partial<NetworkNode> = {}) => ({ id, name: `Unit ${id}`, kind: 'farm', areaKm2: 5, downstreamNodeId: null, ...extra }) as unknown as NetworkNode;
const opts = { canRun: true, hasRun: false };

describe('readinessView', () => {
	it('an empty project: a network and a rainfall series block the run, in the button’s words', () => {
		const v = readinessView({ nodes: [] }, {}, [], opts);
		expect(v.canStart).toBe(false);
		expect(v.blockers).toEqual(['A run needs a network.', 'A run needs a rainfall series.']);
		expect(v.notRequired).toBe(NOT_REQUIRED);
	});

	it('a network and rain: nothing blocks, and the optional parts are said to be optional', () => {
		const v = readinessView({ nodes: [farm('a')] }, {}, [{ kind: 'rain_catchment_mm', siteNodeId: null, station: null }], opts);
		expect(v).toMatchObject({ canStart: true, blockers: [] });
		expect(v.notRequired).toMatch(/calibration site/);
		expect(v.notRequired).toMatch(/EWR/);
		// The unit has no rain of its own: a note, never a blocker.
		expect(v.notes).toHaveLength(1);
		expect(v.notes[0]).toMatch(/^1 unit has no rain of its own, .*Unit a\. .*A note, not a blocker\.$/);
	});

	it('names at most MAX_NAMED_UNITS units on the catchment rain and counts the rest', () => {
		const nodes = Array.from({ length: MAX_NAMED_UNITS + 3 }, (_, i) => farm(String(i)));
		const [note] = readinessView({ nodes }, {}, [{ kind: 'rain_catchment_mm', siteNodeId: null, station: null }], opts).notes;
		expect(note).toMatch(new RegExp(`^${MAX_NAMED_UNITS + 3} units have no rain of their own`));
		expect(note).toContain('and 3 more');
	});

	it('a unit with its own rain gauge gets no note', () => {
		const series = [
			{ kind: 'rain_catchment_mm', siteNodeId: null, station: null },
			{ kind: 'rain_catchment_mm', siteNodeId: 'a', station: null }
		];
		expect(readinessView({ nodes: [farm('a')] }, {}, series, opts).notes).toEqual([]);
	});

	it('says whether a forecast run is available and whether the person asking may start a run', () => {
		const rain = [{ kind: 'rain_catchment_mm', siteNodeId: null, station: null }];
		expect(readinessView({ nodes: [farm('a')] }, {}, rain, opts).forecastRun).toMatch(/^not available/);
		expect(readinessView({ nodes: [farm('a')] }, {}, [...rain, { kind: 'rain_forecast_mm', siteNodeId: null, station: null }], opts).forecastRun).toMatch(/^available/);
		expect(readinessView({ nodes: [] }, {}, [], { canRun: false, hasRun: true }).youCanStartIt).toMatch(/^no: .*editor/);
	});
});
