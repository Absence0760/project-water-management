// The planted-areas drawer's land-cover rows (croplandProposals.ts): the areas on
// offer (the unit's sum first, a parcel without cropland left out, a single
// parcel standing for the unit), the crop rows against the chosen area, the
// provenance line while current and once typed over, and the confirmation's
// words, which say the crop is the modeller's call; and the crop-type grid's
// orchards and vines (issue #604 R5-D): offered after the land cover's, per
// layer, with their own confirmation, and the new plantings' line.
import { describe, expect, it } from 'vitest';
import type { CroplandProposals } from '#lib/api/index.js';
import { fmtDate } from '#lib/format/number.js';
import { areaChoices, CAUTION, confirmWords, CROP_TYPE_CAUTION, cropRows, fmtHa, newPlantingText, provenanceText } from './croplandProposals';

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
	],
	cropTypes: null
};
const typeSet = {
	dataset: 'synthetic',
	source: 'Synthetic crop-type grid',
	version: 'synthetic 2022',
	baselineVersion: 'synthetic 2018',
	method: 'Pre-summarised at import.',
	attribution: 'none',
	cellDeg: 0.005,
	orchardClasses: [32],
	vineClasses: [33],
	loadedAt: '2026-10-27T00:00:00.000Z',
	synthetic: true
};
const withTypes: CroplandProposals = {
	...base,
	cropTypes: {
		dataset: typeSet,
		parcels: [
			{ featureId: 'f1', name: 'Lower lands', areaM2: 1_000_000, orchardM2: 200_000, vineM2: 0, newOrchardM2: 50_000, newVineM2: 0 },
			{ featureId: 'f2', name: 'Top camp', areaM2: 250_000, orchardM2: 0, vineM2: 25_000, newOrchardM2: 0, newVineM2: 0 },
			{ featureId: 'f3', name: 'Veld', problem: 'the polygon has no area' }
		],
		unit: null
	}
};

describe('areaChoices', () => {
	it('offers the parcels’ sum first, then each parcel with cropland', () => {
		expect(areaChoices(base)).toEqual([
			{ key: 'unit', featureId: null, label: 'All 3 parcels: 62.5 ha', areaM2: 625_000, layer: null, dataset: 'synthetic' },
			{ key: 'f1', featureId: 'f1', label: 'Lower lands: 50 ha', areaM2: 500_000, layer: null, dataset: 'synthetic' },
			{ key: 'f2', featureId: 'f2', label: 'Top camp: 12.5 ha', areaM2: 125_000, layer: null, dataset: 'synthetic' }
		]);
	});

	it('lets a single parcel stand for the unit, and offers nothing without a dataset', () => {
		const one = { ...base, parcels: [base.parcels[0]!], unit: { areaM2: 1_000_000, cultivatedM2: 500_000 } };
		expect(areaChoices(one)).toEqual([{ key: 'unit', featureId: null, label: 'Lower lands: 50 ha', areaM2: 500_000, layer: null, dataset: 'synthetic' }]);
		expect(areaChoices({ ...base, dataset: null })).toEqual([]);
	});

	it('offers each parcel’s orchards and vines after the land cover’s, with no unit sum when a parcel couldn’t be read', () => {
		expect(areaChoices(withTypes).slice(3)).toEqual([
			{ key: 'orchard:f1', featureId: 'f1', label: 'Orchards, Lower lands: 20 ha', areaM2: 200_000, layer: 'orchard', dataset: 'synthetic' },
			{ key: 'vine:f2', featureId: 'f2', label: 'Vines, Top camp: 2.5 ha', areaM2: 25_000, layer: 'vine', dataset: 'synthetic' }
		]);
		const unit = { areaM2: 1_250_000, orchardM2: 200_000, vineM2: 25_000, newOrchardM2: 50_000, newVineM2: 0 };
		const summed = { ...withTypes, cropTypes: { ...withTypes.cropTypes!, unit } };
		expect(areaChoices(summed).slice(3).map((c) => c.label)).toEqual(['Orchards, all 3 parcels: 20 ha', 'Orchards, Lower lands: 20 ha', 'Vines, all 3 parcels: 2.5 ha', 'Vines, Top camp: 2.5 ha']);
	});

	it('lets a single parcel’s orchards stand for the unit', () => {
		const one = { ...withTypes, cropTypes: { ...withTypes.cropTypes!, parcels: [withTypes.cropTypes!.parcels[0]!] } };
		expect(areaChoices(one).filter((c) => c.layer)).toEqual([{ key: 'orchard:unit', featureId: null, label: 'Orchards, Lower lands: 20 ha', areaM2: 200_000, layer: 'orchard', dataset: 'synthetic' }]);
	});

	it('says what is new since the earlier edition, and nothing without one', () => {
		const a = { areaM2: 1, orchardM2: 200_000, vineM2: 25_000, newOrchardM2: 50_000, newVineM2: 10_000 };
		expect(newPlantingText(a, 'synthetic 2018')).toBe('6 ha');
		expect(newPlantingText({ ...a, newOrchardM2: 0, newVineM2: 0 }, '2018')).toBe('None');
		expect(newPlantingText(a, null)).toBeNull();
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
		const a = { areaM2: 125_000, dataset: 'synthetic', source: 's', version: 'synthetic 1', method: 'm', basis: 'parcel' as const, layer: null, featureName: 'Top camp', acceptedAt: '2026-10-01T12:00:00.000Z', current: true };
		// The day it was used, in the viewer's own time zone (fmtDate): the 1st or 2nd of October by where they are.
		const day = fmtDate(a.acceptedAt);
		expect(day).toMatch(/^[12] Oct 2026$/);
		expect(provenanceText(a)).toBe(`12.5 ha from land cover (the parcel “Top camp”; synthetic, synthetic 1), used ${day}`);
		expect(provenanceText({ ...a, basis: 'unit', featureName: null, current: false })).toBe(
			`Typed over since: 12.5 ha came from land cover (the unit’s parcels; synthetic, synthetic 1) on ${day}`
		);
		// An orchard area says it came from the crop types, and which layer.
		expect(provenanceText({ ...a, layer: 'orchard', basis: 'unit', featureName: null, version: 'synthetic 2022' })).toBe(
			`12.5 ha from crop types (orchards; the unit’s parcels; synthetic, synthetic 2022), used ${day}`
		);
	});

	it('confirms with the crop, the area, the dataset and the warning that the crop is the modeller’s call', () => {
		const choices = areaChoices(base);
		const [, lucerne] = cropRows(base, choices[2]!);
		const w = confirmWords(base, lucerne!, choices[2]!);
		expect(w.title).toBe('Set Lucerne’s planted area on Farm A from land cover?');
		expect(w.message).toMatch(/^Lucerne on Farm A changes from no planted area to 12\.5 ha, the cultivated area the land cover \(synthetic, synthetic 1\) shows in the parcel Top camp\. /);
		// #90 Land-cover proposals: satellite cropland (dryland and fallow included), not irrigated area; used as it stands.
		expect(w.message).toContain(CAUTION);
		expect(CAUTION).toMatch(/satellite.*dryland and fallow.*not the irrigated area: check it before you use it/);
		expect(w.message).toContain('doesn’t say what grows there');
		expect(w.message).toContain('used as it stands, with no discount');
		expect(w.confirmLabel).toBe('Use this area');
		expect(fmtHa(12_345)).toBe('1.23 ha');
	});

	it('confirms an orchard area with the crop types’ dataset and their own warning', () => {
		const choice = areaChoices(withTypes).find((c) => c.key === 'orchard:f1')!;
		const [, lucerne] = cropRows(withTypes, choice);
		const w = confirmWords(withTypes, lucerne!, choice);
		expect(w.title).toBe('Set Lucerne’s planted area on Farm A from crop types?');
		expect(w.message).toMatch(/^Lucerne on Farm A changes from no planted area to 20 ha, the permanent orchards the crop types \(synthetic, synthetic 2022\) show in the parcel Lower lands\. /);
		expect(w.message).toContain(CROP_TYPE_CAUTION);
		expect(CROP_TYPE_CAUTION).toMatch(/not the irrigated area.*which fruit or cultivar: check it before you use it/);
		expect(w.message).not.toContain(CAUTION);
	});
});
