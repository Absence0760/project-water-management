// The read-only tools' list (issue #610): one per name in the contract, each
// spec a JSON Schema object.
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../types.js';
import { READ_TOOLS } from './readTools.js';

describe('READ_TOOLS', () => {
	it('has every read tool the contract names, once, with an object schema and a label', () => {
		const { proposeSettings: _p, ...read } = TOOL_NAMES;
		expect(READ_TOOLS.map((t) => t.spec.name).sort()).toEqual(Object.values(read).sort());
		for (const t of READ_TOOLS) {
			expect(t.spec.parameters.type, t.spec.name).toBe('object');
			expect(t.spec.description.length).toBeGreaterThan(40);
			expect(t.label).toBeTruthy();
		}
	});
});
