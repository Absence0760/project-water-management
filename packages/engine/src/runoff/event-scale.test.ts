// The event-scale invariant (issue #4 §4.4, the audit H1 regression) over
// every runoff model the engine offers. The legacy b023 model, which failed
// it, was removed in engine 1.0.0 (issue #16); every model now has to pass.
import { describe, expect, it } from 'vitest';
import { checkEventScale, modelRunner, type EventRunner } from '../testing/runoff';
import { gr4j } from './gr4j';
import { defaultGr4jParams } from './params';
import { RUNOFF_MODELS, type RunoffModelId } from './types';

const RUNNERS: Record<RunoffModelId, EventRunner> = {
	gr4j: modelRunner(gr4j, defaultGr4jParams())
};

describe('event scale, every runoff model', () => {
	for (const id of RUNOFF_MODELS) {
		it(`${id} conserves a storm's water`, () => {
			expect(checkEventScale(RUNNERS[id])).toBeNull();
		});
	}
});
