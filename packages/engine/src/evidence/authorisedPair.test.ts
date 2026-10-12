// The headline board's pair, re-derived (issue #523 G2): the baseline at full
// allocation with the application's ops on it, the kinds as at the baseline,
// and the full mix again from them. The bundle's own check is bundle.test.ts.
import { describe, expect, it } from 'vitest';
import { HEADLINE_ALLOCATIONS, HEADLINE_KINDS, packFixtureInput } from '../testing/packBundle';
import type { ModelInput } from '../project';
import { authorisedPairInputs, authorisedTakes, mixFromRecord, pairKinds, sameModelInput } from './authorisedPair';

const base = (): ModelInput => ({ ...packFixtureInput(), model: { ...packFixtureInput().model, allocations: structuredClone(HEADLINE_ALLOCATIONS) } });

describe('authorisedPairInputs', () => {
	it('holds every holder at their registered volume on both sides, the ops on the application only, and leaves the base alone', () => {
		const b = base();
		const pair = authorisedPairInputs(b, [{ op: 'cropArea.set', nodeId: 'F1', cropId: 'c', areaM2: 600_000 }]);
		expect(pair.problems).toEqual([]);
		expect(pair.baseline.settings.allocationMode).toBe('fullAllocation');
		expect(pair.application.settings.allocationMode).toBe('fullAllocation');
		expect(pair.application.model.cropAreas[0]!.areaM2).toBe(600_000);
		expect(pair.baseline.model.cropAreas[0]!.areaM2).toBe(300_000);
		expect(b.settings.allocationMode).toBeUndefined();
	});

	it('lists an op that doesn’t apply', () => {
		const pair = authorisedPairInputs(base(), [{ op: 'cropArea.set', nodeId: 'nowhere', cropId: 'c', areaM2: 1 }]);
		expect(pair.problems.length).toBe(1);
	});
});

describe('pairKinds / mixFromRecord', () => {
	it('records one kind per take (not the s21b row), sorted by id; a row with no kind then is null', () => {
		const kinds = pairKinds(base(), (id) => (id.endsWith('e1') ? 'licence' : undefined));
		expect(kinds.map((k) => k.allocationId)).toEqual(authorisedTakes(base()).map((a) => a.id).sort());
		expect(kinds).toEqual([
			{ allocationId: HEADLINE_ALLOCATIONS[0]!.id, authorisation: 'licence' },
			{ allocationId: HEADLINE_ALLOCATIONS[1]!.id, authorisation: null }
		]);
	});

	it('gives the full mix from the baseline volumes and the kinds as at the baseline', () => {
		const mix = mixFromRecord(base(), pairKinds(base(), (id) => HEADLINE_KINDS[id]));
		expect(mix).toEqual({
			rows: [
				{ authorisation: 'licence', volumeM3PerYear: 40_000, entitlement: true },
				{ authorisation: 'registration', volumeM3PerYear: 25_000, entitlement: false }
			],
			entitlementM3PerYear: 40_000,
			totalM3PerYear: 65_000
		});
	});

	it('refuses kinds that aren’t the input’s takes, one each', () => {
		const kinds = pairKinds(base(), (id) => HEADLINE_KINDS[id]);
		expect(mixFromRecord(base(), kinds.slice(1))).toBe('mismatch');
		expect(mixFromRecord(base(), [...kinds, kinds[0]!])).toBe('mismatch');
		expect(mixFromRecord(base(), [{ ...kinds[0]!, allocationId: 'other' }, kinds[1]!])).toBe('mismatch');
	});
});

describe('sameModelInput', () => {
	it('ignores key order and treats NaN as NaN; a changed value differs', () => {
		const a = base();
		const b: ModelInput = { series: a.series, model: { ...a.model }, settings: Object.fromEntries(Object.entries(a.settings).reverse()) as ModelInput['settings'] };
		expect(sameModelInput(a, b)).toBe(true);
		expect(sameModelInput({ ...a, settings: { ...a.settings, apanMm: [Number.NaN] as never } }, { ...a, settings: { ...a.settings, apanMm: [Number.NaN] as never } })).toBe(true);
		expect(sameModelInput(a, { ...a, model: { ...a.model, cropAreas: [{ ...a.model.cropAreas[0]!, areaM2: 1 }] } })).toBe(false);
	});
});
