import type { UnitEwrMet } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import type { MapFeature } from '#lib/api/types.js';
import { bandColours, useMapData } from '#lib/components/allocations/useMap.js';
import { fmtNum } from '#lib/format/number.js';
import {
	ewrBand,
	ewrColours,
	ewrCounts,
	ewrLabel,
	ewrLayers,
	ewrMapMeasure,
	ewrRatio,
	ewrScheme,
	ewrSentence,
	ewrShading,
	EWR_BAND_LABEL,
	EWR_BAND_SHORT,
	EWR_BANDS
} from './ewrMap';

const unit = (nodeId: string, requiredM3: number, metM3: number, outflowM3: number, kind: 'farm' | 'user' = 'farm'): UnitEwrMet => ({
	nodeId,
	name: `Unit ${nodeId}`,
	kind,
	requiredM3,
	metM3,
	outflowM3,
	daysNotMet: 0
});

const parcel = (id: string, nodeId: string, x: number, areaM2 = 1e6): MapFeature => ({
	id,
	kind: 'farm_parcel',
	name: id,
	nodeId,
	nodeName: `Unit ${nodeId}`,
	geometry: {
		type: 'Polygon',
		coordinates: [
			[
				[x, 0],
				[x + 1, 0],
				[x + 1, 1],
				[x, 1],
				[x, 0]
			]
		]
	},
	properties: {},
	areaM2,
	nonContributingM2: null,
	damPosition: null,
	center: [x + 0.5, 0.5],
	sourceId: null,
	createdBy: null,
	createdAt: '',
	updatedAt: ''
});

describe('ewrRatio: the two measures', () => {
	it('Requirement met is Σ MIN(U, Z) ÷ Σ Z, never above 100 %', () => {
		expect(ewrRatio(unit('a', 1000, 870, 5000), 'met')).toBeCloseTo(0.87, 12);
		// Float dust above the requirement still reads as met in full.
		expect(ewrRatio(unit('a', 1000, 1000.0000001, 5000), 'met')).toBe(1);
	});

	it('Flow ÷ requirement is Σ U ÷ Σ Z and can pass 100 %', () => {
		expect(ewrRatio(unit('a', 1000, 870, 5000), 'ratio')).toBe(5);
		expect(ewrRatio(unit('a', 1000, 300, 400), 'ratio')).toBeCloseTo(0.4, 12);
	});

	it('no EWR required at the unit: no ratio, whatever the flow', () => {
		expect(ewrRatio(unit('a', 0, 0, 5000), 'met')).toBeNull();
		expect(ewrRatio(unit('a', 1e-9, 0, 5000), 'ratio')).toBeNull();
	});
});

describe('ewrBand: the client’s bands', () => {
	it('puts each edge in the band whose lower edge it is', () => {
		expect(ewrBand(1)).toBe('met');
		expect(ewrBand(3.2)).toBe('met');
		expect(ewrBand(0.9999)).toBe('within');
		expect(ewrBand(0.9)).toBe('within');
		expect(ewrBand(0.8999)).toBe('short');
		expect(ewrBand(0.5)).toBe('short');
		expect(ewrBand(0.4999)).toBe('half');
		expect(ewrBand(0)).toBe('half');
		expect(ewrBand(null)).toBe('none');
	});

	it('reads a ratio a hair under an edge, from summing and dividing, as on it', () => {
		expect(ewrBand(1 - 1e-12)).toBe('met');
		expect(ewrBand(0.9 - 1e-12)).toBe('within');
		expect(ewrBand(0.5 - 1e-12)).toBe('short');
	});

	it('every band has key words and short words', () => {
		for (const b of [...EWR_BANDS, 'none'] as const) {
			expect(EWR_BAND_LABEL[b]).toBeTruthy();
			expect(EWR_BAND_SHORT[b]).toBeTruthy();
		}
		expect(EWR_BAND_LABEL.met).toBe('Met or exceeded (100 % or more)');
		expect(EWR_BAND_LABEL.within).toBe('Within 10 % (90–100 %)');
		expect(EWR_BAND_LABEL.short).toBe('10–50 % short (50–90 %)');
		expect(EWR_BAND_LABEL.half).toBe('Half or more short (under 50 %)');
	});
});

describe('ewrLabel', () => {
	it('the whole per cent, rounded down so a label never shows the next band’s edge', () => {
		expect(ewrLabel(0.996)).toBe('99 %');
		expect(ewrLabel(0.8999)).toBe('89 %');
		expect(ewrLabel(0.9)).toBe('90 %');
		expect(ewrLabel(1)).toBe('100 %');
		expect(ewrLabel(0.29 * 1)).toBe('29 %');
		expect(ewrLabel(12.5)).toBe(`${fmtNum(1250)} %`);
		expect(ewrLabel(null)).toBe('No EWR share');
	});

	it('the label and the band never disagree at an edge', () => {
		for (let r = 0; r <= 1.2; r += 0.0007) {
			const pct = Math.floor(r * 100 + 1e-7);
			const b = ewrBand(r);
			if (pct >= 100) expect(b).toBe('met');
			else if (pct >= 90) expect(b).toBe('within');
			else if (pct >= 50) expect(b).toBe('short');
			else expect(b).toBe('half');
		}
	});
});

describe('ewrShading', () => {
	const units = [unit('A', 1000, 1000, 4000), unit('B', 1000, 920, 950), unit('C', 1000, 600, 2000), unit('D', 1000, 100, 120), unit('E', 0, 0, 800, 'user'), unit('F', 1000, 300, 2500)];
	const features = [parcel('pa', 'A', 0), parcel('pb', 'B', 1), parcel('pc', 'C', 2), parcel('pd', 'D', 3), parcel('pe', 'E', 4), parcel('px', 'X', 5)];

	it('bands each unit by the measure, and lists the units with no area worst first', () => {
		const met = ewrShading(units, features, 'met');
		expect(met.drawn.map((u) => [u.nodeId, u.band, u.label])).toEqual([
			['A', 'met', '100 %'],
			['B', 'within', '92 %'],
			['C', 'short', '60 %'],
			['D', 'half', '10 %'],
			['E', 'none', 'No EWR share']
		]);
		expect(met.unplaced.map((u) => [u.nodeId, u.band])).toEqual([['F', 'half']]);
		// A polygon of a unit the run doesn't have: an outline, named from the feature.
		expect(met.notInRun.map((u) => u.name)).toEqual(['Unit X']);

		const ratio = ewrShading(units, features, 'ratio');
		expect(ratio.drawn.map((u) => [u.nodeId, u.band, u.label])).toEqual([
			['A', 'met', '400 %'],
			['B', 'within', '95 %'],
			['C', 'met', '200 %'],
			['D', 'half', '12 %'],
			['E', 'none', 'No EWR share']
		]);
		expect(ratio.unplaced.map((u) => [u.nodeId, u.band])).toEqual([['F', 'met']]);
	});

	it('the key counts units on the map per band, and those with no area, adding up to every unit', () => {
		const c = ewrCounts(ewrShading(units, features, 'met'));
		expect(c).toEqual({ met: 1, within: 1, short: 1, half: 1, none: 1, unplaced: 1 });
		expect(Object.values(c).reduce((a, b) => a + b, 0)).toBe(units.length);
	});

	it('the map data carries each drawn unit’s band, and a unit not in the run as notinrun', () => {
		const data = useMapData(ewrShading(units, features, 'met'));
		expect(data.features.map((f) => [f.properties.nodeId, f.properties.band])).toEqual([
			['A', 'met'],
			['B', 'within'],
			['C', 'short'],
			['D', 'half'],
			['E', 'none'],
			['X', 'notinrun']
		]);
	});
});

describe('ewrSentence', () => {
	it('starts with the label’s words (WCAG 2.5.3) and says the figures behind them', () => {
		const [b] = ewrShading([unit('B', 1000, 920, 950)], [], 'met').unplaced;
		expect(ewrSentence(b!, 'met')).toBe(`Unit B: 92 % of the EWR required met, ${fmtNum(920)} m³ of ${fmtNum(1000)} m³ over the run. Within 10 %.`);
		const [r] = ewrShading([unit('B', 1000, 920, 950)], [], 'ratio').unplaced;
		expect(ewrSentence(r!, 'ratio')).toBe(`Unit B: 95 %, flow of ${fmtNum(950)} m³ against ${fmtNum(1000)} m³ of EWR required over the run. Within 10 %.`);
		const [e] = ewrShading([unit('E', 0, 0, 5)], [], 'met').unplaced;
		expect(ewrSentence(e!, 'met')).toBe('Unit E: No EWR share, no EWR is required at this unit.');
	});
});

describe('colours and layers', () => {
	it('are the Allocations map’s: green met, orange within, light red and red short', () => {
		for (const dark of [false, true]) {
			const a = bandColours(dark);
			expect(ewrColours(dark)).toEqual({ met: a.under, within: a.near, short: a.over, half: a.far, none: a.none });
		}
	});

	it('fill every band with a ratio, none for no EWR share, and dash a unit not in the run', () => {
		const layers = ewrLayers(false);
		const fill = layers.find((l) => l.id === 'ewr-fill')!;
		expect(fill.filter).toEqual(['in', ['get', 'band'], ['literal', ['met', 'within', 'short', 'half']]]);
		expect(layers.find((l) => l.id === 'ewr-line-dashed')!.filter).toEqual(['in', ['get', 'band'], ['literal', ['notinrun', 'nodata']]]);
		expect(ewrScheme('met').id).toBe('ewr');
		expect(ewrScheme('ratio').ariaLabel).toMatch(/flow passing each/);
	});
});

describe('ewrMapMeasure', () => {
	it('reads the URL value, anything else as Requirement met', () => {
		expect(ewrMapMeasure('ratio')).toBe('ratio');
		expect(ewrMapMeasure('met')).toBe('met');
		expect(ewrMapMeasure(null)).toBe('met');
		expect(ewrMapMeasure('bogus')).toBe('met');
	});
});
