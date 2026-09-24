// The event-scale invariant (issue #4 §4.4, the audit H1 regression) over
// every runoff model the engine offers. A model in EVENT_SCALE_EXEMPT must
// still fail it, so the exemption can't outlive the problem it names.
import { describe, expect, it } from 'vitest';
import { LEGACY_NOT_EVIDENCE_WARNING, runModel } from '../run';
import { checkEventScale, EVENT_SCALE_EXEMPT, legacyRunner, modelRunner, type EventRunner } from '../testing/runoff';
import { defaultGr4jParams, gr4j } from './gr4j';
import { RUNOFF_MODELS, type RunoffModelId } from './types';

const APAN = [150, 180, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100]; // Oct … Sep — GR4J needs evaporation to run
const RAIN = Array.from({ length: 400 }, (_, i) => (i % 17 === 0 ? 30 : i % 5 === 0 ? 2 : 0));

/** One farm draining to a gauge, for every runoff model, to read summary.warnings from a real run. */
function catchment(model: RunoffModelId) {
	return runModel({
		settings: { runoffModel: model, apanMm: APAN as never },
		model: {
			nodes: [
				{
					id: 'F',
					name: 'Farm',
					kind: 'farm',
					downstreamNodeId: null,
					sortOrder: 0,
					areaKm2: 10,
					areaHiKm2: 0,
					areaLoKm2: 0,
					flowShareManual: null,
					pctUpstreamToDam: 0,
					pctRunoffToDam: 0,
					damCapacityM3: 0,
					damInitialPct: 0,
					damMinPct: 0,
					divertCapacityM3Day: 0,
					irrigationEfficiency: 1,
					lossReturnFraction: 0
				}
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2020-10-01', values: RAIN } }
	});
}

const RUNNERS: Record<RunoffModelId, EventRunner> = {
	legacy: legacyRunner,
	gr4j: modelRunner(gr4j, defaultGr4jParams())
};

describe('event scale, every runoff model', () => {
	for (const id of RUNOFF_MODELS) {
		const exempt = EVENT_SCALE_EXEMPT[id];
		if (exempt) {
			it(`${id} is exempt (${exempt}) and still fails`, () => {
				expect(checkEventScale(RUNNERS[id])).toMatch(/returns [\d.]+× its rain|falls as the storm grows/);
			});
		} else {
			it(`${id} conserves a storm's water`, () => {
				expect(checkEventScale(RUNNERS[id])).toBeNull();
			});
		}
	}

	it('the legacy model returns more water than a storm brought (audit H1)', () => {
		// June start (winter response): 20 mm returns 1.05×, 200 mm 16.6× its rain.
		expect(checkEventScale(legacyRunner)).toBe('a 20 mm storm on a dry catchment returns 1.054× its rain');
	});

	it('the event-scale exemption applies only to runs that carry LEGACY_NOT_EVIDENCE (audit H1)', () => {
		// A model isn't allowed to be quietly exempted from the event-scale check
		// (or quietly un-exempted) without the warning that tells a user why —
		// so a future model can't lose the disclosure just by staying off the list.
		for (const id of RUNOFF_MODELS) {
			const out = catchment(id);
			const carriesWarning = out.summary.warnings.includes(LEGACY_NOT_EVIDENCE_WARNING);
			expect(carriesWarning, id).toBe(!!EVENT_SCALE_EXEMPT[id]);
		}
	});
});
