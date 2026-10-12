// The note for a cap or full-allocation run read by a viewer kept from the volumes (issue #523 finding I).
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@water-management/engine';
import { verdictsOnly, verdictsOnlyText } from './withheld';

const run = (mode: 'none' | 'cap' | 'fullAllocation', only?: true) =>
	({ allocations: { mode, tolerance: 0.1, used: 1, notMatched: 0, nodes: [], ...(only ? { verdictsOnly: only } : {}) } }) as Pick<RunSummary, 'allocations'>;

describe('verdicts and counts only', () => {
	it('says why only the EWR verdicts and counts are shown, by mode', () => {
		expect(verdictsOnlyText(run('cap', true))).toMatch(/^Only this run’s EWR verdicts and counts are shown .* caps every unit’s use at its registered water volume/);
		expect(verdictsOnlyText(run('fullAllocation', true))).toMatch(/scales every unit’s demand to its registered water volume/);
	});

	it('says nothing for an editor’s copy of the same run, a compare-only run or a run without allocations', () => {
		expect(verdictsOnlyText(run('cap'))).toBeNull();
		expect(verdictsOnlyText(run('none'))).toBeNull();
		expect(verdictsOnlyText({ allocations: undefined })).toBeNull();
		expect(verdictsOnly(null)).toBe(false);
	});
});
