// The planted-areas drawer's land-cover rows (croplandProposals.ts): the areas on
// offer (the unit's sum first, a parcel without cropland left out, a single
// parcel standing for the unit), the crop rows against the chosen area, the
// provenance line while current and once typed over, and the confirmation's
// words, which say the crop is the modeller's call.
import { describe, expect, it } from 'vitest';
import type { CroplandProposals } from '$lib/api';
import { fmtDate } from '$lib/format/number';
import { areaChoices, confirmWords, cropRows, fmtHa, provenanceText } from './croplandProposals';

const dataset = {
	dataset: 'synthetic',
	source: 'SYNTHETIC test data',
	version: 'synthetic 1',
	method: 'Pre-summarised at import.',
	attribution: 'none',
	cellDeg: 0.005,
	classes: [40],
	loadedAt: '2026-10-01T00:00:00.000Z',
	synthetic: true
};
const base: CroplandProposals = {
	nodeId: 'n1',
	nodeName: 'Farm A',
	dataset,
	datasets: [{ dataset: 'synthetic', version: 'synthetic 1', synthetic: true }],
	parcels: [
		{ featureId: 'f1', name: 'Lower lands', areaM2: 1_000_000, cultivatedM2: 500_000 },
		{ featureId: 'f2', name: 'Top camp', areaM2: 250_000, cultivatedM2: 125_000 },
		{ featureId: 'f3', name: 'Veld', areaM2: 300_000, cultivatedM2: 0 }
	],
	unit: { areaM2: 1_550_000, cultivatedM2: 625_000 },
	catchment: null,
	crops: [
		{ cropId: 'c1', name: 'Citrus', areaM2: 625_000, accepted: null },
		{ cropId: 'c2', name: 'Lucerne', areaM2: 0, accepted: null }
	]
};

describe('areaChoices', () => {
	it('offers the parcels’ sum first, then each parcel with cropland', () => {
		expect(areaChoices(base)).toEqual([
			{ key: 'unit', featureId: null, label: 'All 3 parcels: 62.5 ha', areaM2: 625_000 },
			{ key: 'f1', featureId: 'f1', label: 'Lower lands: 50 ha', areaM2: 500_000 },
			{ key: 'f2', featureId: 'f2', label: 'Top camp: 12.5 ha', areaM2: 125_000 }
		]);
	});

	it('lets a single parcel stand for the unit, and offers nothing without a dataset', () => {
		const one = { ...base, parcels: [base.parcels[0]!], unit: { areaM2: 1_000_000, cultivatedM2: 500_000 } };
		expect(areaChoices(one)).toEqual([{ key: 'unit', featureId: null, label: 'Lower lands: 50 ha', areaM2: 500_000 }]);
		expect(areaChoices({ ...base, dataset: null })).toEqual([]);
	});
});

describe('cropRows and the words', () => {
	it('marks the crop that already holds the chosen area as saved', () => {
		const [unit] = areaChoices(base);
		expect(cropRows(base, unit!)).toEqual([
			{ cropId: 'c1', name: 'Citrus', now: '62.5 ha', same: true, provenance: null },
			{ cropId: 'c2', name: 'Lucerne', now: 'None', same: false, provenance: null }
		]);
	});

	it('says where an accepted area came from, and when it has been typed over', () => {
		const a = { areaM2: 125_000, dataset: 'synthetic', source: 's', version: 'synthetic 1', method: 'm', basis: 'parcel' as const, featureName: 'Top camp', acceptedAt: '2026-10-01T12:00:00.000Z', current: true };
		// The day it was used, in the viewer's own time zone (fmtDate): the 1st or 2nd of October by where they are.
		const day = fmtDate(a.acceptedAt);
		expect(day).toMatch(/^2026-10-0[12]$/);
		expect(provenanceText(a)).toBe(`12.5 ha from land cover (the parcel “Top camp”; synthetic, synthetic 1), used ${day}`);
		expect(provenanceText({ ...a, basis: 'unit', featureName: null, current: false })).toBe(
			`Typed over since: 12.5 ha came from land cover (the unit’s parcels; synthetic, synthetic 1) on ${day}`
		);
	});

	it('confirms with the crop, the area, the dataset and the warning that the crop is the modeller’s call', () => {
		const choices = areaChoices(base);
		const [, lucerne] = cropRows(base, choices[2]!);
		const w = confirmWords(base, lucerne!, choices[2]!);
		expect(w.title).toBe('Set Lucerne’s planted area on Farm A from land cover?');
		expect(w.message).toMatch(/^Lucerne on Farm A changes from no planted area to 12\.5 ha, the cultivated area the land cover \(synthetic, synthetic 1\) shows in the parcel Top camp\. /);
		expect(w.message).toContain('doesn’t say what grows there or whether it is irrigated');
		expect(fmtHa(12_345)).toBe('1.23 ha');
	});
});
