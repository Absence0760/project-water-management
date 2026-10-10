// Licence data never drives the baseline (issue #507, docs/model.md §2.12a,
// docs/allocations.md § Allocation modes): with allocationMode 'none', the
// mode every project's baseline runs in, a run is bit-identical with and
// without registered volumes. They only add the comparison
// (summary.allocations) and the warnings about the rows themselves; every
// series, every value and the rest of the summary are the same, whatever the
// volumes, their months of use, maximum rates or storage-only rows say.
// The engine's 'cap' and 'fullAllocation' stay for scenarios (positive
// control below: they do change the run).
import { describe, expect, it } from 'vitest';
import { testCatchment } from '../outlook/testCatchment';
import type { ModelInput, ModelOutput } from '../project';
import { runModelWithoutChecks } from '../run';
import { randomInput } from '../testing/fuzz';
import type { AllocationEntry } from './compare';

/** The output minus what the allocations are allowed to add: the comparison, and the warnings that name an allocation. */
function withoutComparison(out: ModelOutput) {
	const { allocations: _allocations, warnings, ...summary } = out.summary;
	return { series: out.series, summary: { ...summary, warnings: warnings.filter((w) => !/allocation/i.test(w)) } };
}

/** Every number compared with Object.is, so −0 against 0 or a NaN in a different place fails too. */
function expectBitIdentical(a: ModelOutput, b: ModelOutput, what: string) {
	expect(a.series.map((s) => [s.nodeId, s.key]), what).toEqual(b.series.map((s) => [s.nodeId, s.key]));
	a.series.forEach((s, i) => {
		const other = b.series[i]!.values;
		expect(s.values.length, `${what} ${s.nodeId}/${s.key}`).toBe(other.length);
		const first = s.values.findIndex((v, t) => !Object.is(v, other[t]));
		expect(first, `${what} ${s.nodeId}/${s.key} differs from day ${first}`).toBe(-1);
	});
	expect(withoutComparison(a), what).toEqual(withoutComparison(b));
}

const run = (x: ModelInput, allocations: AllocationEntry[] | undefined) => {
	const input = structuredClone(x);
	input.settings.allocationMode = 'none';
	input.model.allocations = allocations;
	return runModelWithoutChecks(input);
};

describe("a compare-only baseline ignores the registered volumes (issue #507)", () => {
	// Volumes far below and far above use, both sources, licence conditions that would bind under a cap, a storage-only row.
	const allocations: AllocationEntry[] = [
		{ id: 'a-s', nodeId: 'a', waterSource: 'surface', volumeM3PerYear: 1, months: [1], maxRateM3s: 1e-6 },
		{ id: 'a-g', nodeId: 'a', waterSource: 'groundwater', volumeM3PerYear: 0 },
		{ id: 'b-s', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: 1e10, validFrom: '2015-10-01', validTo: '2016-09-30' },
		{ id: 'b-dam', nodeId: 'b', waterSource: 'surface', volumeM3PerYear: 0, waterUse: '21b', storageM3: 1 }
	];

	it('the invented outlook catchment: same series and summary with and without them, only the comparison added', () => {
		const without = run(testCatchment(), undefined);
		const withThem = run(testCatchment(), allocations);
		expectBitIdentical(withThem, without, 'outlook catchment');
		expect(without.summary.allocations).toBeUndefined();
		expect(withThem.summary.allocations!.mode).toBe('none');
		expect(run(testCatchment(), []).series).toEqual(without.series);
	});

	it('random networks with allocations (the engine fuzz): bit-identical without them', () => {
		let tried = 0;
		for (let seed = 1; tried < 25 && seed < 2000; seed++) {
			const input = randomInput(seed, { maxDays: 800 });
			if (!input.model.allocations?.length) continue;
			tried++;
			expectBitIdentical(run(input, input.model.allocations), run(input, undefined), `seed ${seed}`);
		}
		expect(tried).toBe(25);
	});

	it('positive control: a cap or a full allocation (a scenario’s modes) does change the run', () => {
		for (const mode of ['cap', 'fullAllocation'] as const) {
			const x = testCatchment();
			x.model.allocations = allocations;
			x.settings.allocationMode = mode;
			const out = runModelWithoutChecks(x);
			const supplied = (o: ModelOutput) => o.series.find((s) => s.nodeId === 'a' && s.key === 'supplied')!.values;
			expect(supplied(out), mode).not.toEqual(supplied(run(testCatchment(), undefined)));
		}
	});
});
