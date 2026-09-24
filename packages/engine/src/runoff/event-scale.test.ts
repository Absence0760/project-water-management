// The event-scale invariant (issue #4 §4.4, the audit H1 regression) over
// every runoff model the engine offers. A model in EVENT_SCALE_EXEMPT must
// still fail it, so the exemption can't outlive the problem it names.
import { describe, expect, it } from 'vitest';
import { checkEventScale, EVENT_SCALE_EXEMPT, legacyRunner, modelRunner, type EventRunner } from '../testing/runoff';
import { defaultGr4jParams, gr4j } from './gr4j';
import { RUNOFF_MODELS, type RunoffModelId } from './types';

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
});
