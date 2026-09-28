import { describe, expect, it } from 'vitest';
import { NATURAL_FLOW, naturalFlowFor, type RunoffModelId } from './index';

describe('naturalFlowFor', () => {
	it("returns the model's generator", () => {
		expect(naturalFlowFor('gr4j')).toBe(NATURAL_FLOW.gr4j);
	});
	// Settings come from stored JSON: a bare NATURAL_FLOW[id] would call an inherited method for these.
	it('refuses a model the engine does not have, including names on the object prototype', () => {
		for (const id of ['legacy', 'toString', 'constructor', '__proto__']) expect(() => naturalFlowFor(id as RunoffModelId), id).toThrow(`unknown runoff model "${id}"`);
	});
});
