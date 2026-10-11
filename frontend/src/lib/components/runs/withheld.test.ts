// The note for a run whose bound units are withheld from this reader (issue #523 finding I).
import { describe, expect, it } from 'vitest';
import type { RunSummary } from '@water-management/engine';
import { withheldUnits, withheldUnitsText } from './withheld';

const run = (mode: 'none' | 'cap' | 'fullAllocation', withheld?: string[]) =>
	({ allocations: { mode, tolerance: 0.1, used: 1, notMatched: 0, nodes: [], ...(withheld ? { withheldUnits: withheld } : {}) } }) as Pick<RunSummary, 'allocations'>;

describe('withheld units', () => {
	it('says how many units a cap or a full allocation left out, and why', () => {
		expect(withheldUnitsText(run('cap', ['a']))).toBe(
			'1 hydrological unit is left out of these results and their daily series: this run caps each one’s use at its registered water volume, and this project shows those volumes to its editors and owners only.'
		);
		expect(withheldUnitsText(run('fullAllocation', ['a', 'b']))).toMatch(/^2 hydrological units are left out .* scales each one’s demand to its registered water volume/);
	});

	it('says nothing when nothing is withheld: an editor, a compare-only run, a run without allocations', () => {
		expect(withheldUnitsText(run('cap'))).toBeNull();
		expect(withheldUnitsText(run('cap', []))).toBeNull();
		expect(withheldUnitsText({ allocations: undefined })).toBeNull();
		expect(withheldUnits(null)).toEqual([]);
	});
});
