// The note for a cap or full-allocation run read by a viewer kept from the volumes (issue #523 finding I).
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@water-management/engine';
import { riverOutcomesOnly, riverOutcomesText } from './withheld';

const run = (mode: 'none' | 'cap' | 'fullAllocation', river?: true) =>
	({ allocations: { mode, tolerance: 0.1, used: 1, notMatched: 0, nodes: [], ...(river ? { riverOutcomesOnly: river } : {}) } }) as Pick<RunSummary, 'allocations'>;

describe('river outcomes only', () => {
	it('says why only the river outcomes are shown, by mode', () => {
		expect(riverOutcomesText(run('cap', true))).toMatch(/^Only this run’s river outcomes are shown .* caps every unit’s use at its registered water volume/);
		expect(riverOutcomesText(run('fullAllocation', true))).toMatch(/scales every unit’s demand to its registered water volume/);
	});

	it('says nothing for an editor’s copy of the same run, a compare-only run or a run without allocations', () => {
		expect(riverOutcomesText(run('cap'))).toBeNull();
		expect(riverOutcomesText(run('none'))).toBeNull();
		expect(riverOutcomesText({ allocations: undefined })).toBeNull();
		expect(riverOutcomesOnly(null)).toBe(false);
	});
});
