// The settings revision an accepted evaporation proposal writes cites its
// dataset by a stable reference that fits model_revision.reason (issue #763):
// the WRC Atlas's own source (~330 characters) and method (~460) were cut off
// at REASON_MAX before. Synthetic values; the Atlas's real recorded lines.
import { PE_SOURCE_MAX } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { fitReason, REASON_MAX } from '../history/record.js';
import { evaporationCreditPath, referenceEvaporation, type EvaporationDataset } from './evaporation.js';
import { ATLAS_APAN, atlasApanMethodFor, DPET } from './evaporationGrid.js';
import { evaporationReason, peSourceFor } from './evaporationRoutes.js';

const dataset = (over: Partial<EvaporationDataset>): EvaporationDataset => ({
	dataset: 'test',
	kind: 'apan',
	source: 'Test grid',
	version: 'v1',
	method: 'Test method.',
	attribution: 'Test attribution',
	firstYear: 2000,
	lastYear: 2009,
	cellDeg: 0.1,
	originLon: 0.05,
	originLat: 0.05,
	loadedAt: '2026-11-01T00:00:00Z',
	synthetic: false,
	...over
});

const atlas = dataset({ ...ATLAS_APAN, kind: 'apan', method: atlasApanMethodFor(0.0167, null, null), firstYear: null, lastYear: null });
const summary = { monthlyMm: Array(12).fill(150), annualMm: 1800, coverage: 0.97, cells: 412 };

describe('evaporationReason (issue #763)', () => {
	it('keeps an Atlas A-pan proposal’s label, version and method whole, under REASON_MAX', () => {
		expect(atlas.source.length + atlas.method.length).toBeGreaterThan(REASON_MAX);
		const reason = evaporationReason(atlas, { name: 'Upper catchment' }, summary);
		expect(reason.length).toBeLessThanOrEqual(REASON_MAX);
		expect(reason).toBe(
			'A-pan evaporation from the map: 1800 mm a year of modelled A-pan equivalent reference potential evaporation (WRC Atlas, not a measured pan), ' +
				'area-weighted over the 412 grid cells the catchment boundary “Upper catchment” covers (97 % of it has values); ' +
				'dataset “Atlas-Apan-2007” (Atlas of Agrohydrology 2008 (monthly A-pan equivalent grids), monthly means, no period stated by the source; ' +
				'its source and method as the dataset records them, credit at /data-sources#atlas-apan).'
		);
	});

	it('shortens a long boundary name, never the dataset’s reference', () => {
		const reason = evaporationReason(atlas, { name: 'x'.repeat(400) }, summary);
		expect(reason.length).toBe(REASON_MAX);
		expect(reason).toContain('…; dataset “Atlas-Apan-2007”');
		expect(reason.endsWith(`; ${referenceEvaporation(atlas)}.`)).toBe(true);
	});

	it('cites a dated reference-ET grid with its years and dPET’s credit; the synthetic grid the page', () => {
		const dpet = dataset({ ...DPET, dataset: 'dPET-1991-2020', kind: 'et0', firstYear: 1991, lastYear: 2020 });
		expect(evaporationReason(dpet, { name: 'B' }, summary)).toMatch(
			/^GR4J’s monthly PE from the map: .*; dataset “dPET-1991-2020” \(hPET v3 \(University of Bristol data\.bris\), 1991–2020 monthly means; .* credit at \/data-sources#dpet\)\.$/
		);
		expect(evaporationCreditPath({ dataset: 'synthetic', kind: 'et0', source: 'SYNTHETIC' })).toBe('/data-sources');
		expect(evaporationCreditPath({ dataset: 'penpan', kind: 'apan', source: 'Modelled Class-A pan (PenPan): x' })).toBe('/data-sources');
	});

	it('the PE row’s source keeps the full citation when it fits, else the reference, never a cut-off citation', () => {
		const dpet = dataset({ ...DPET, dataset: 'dPET-1991-2020', kind: 'et0', firstYear: 1991, lastYear: 2020 });
		expect(peSourceFor(dpet, { name: 'B' }, summary)).toContain(DPET.source);
		const long = dataset({ kind: 'et0', source: 's'.repeat(500), dataset: 'long' });
		const s = peSourceFor(long, { name: 'B' }, summary);
		expect(s.length).toBeLessThanOrEqual(PE_SOURCE_MAX);
		expect(s).toContain('dataset “long” (v1, 2000–2009 monthly means;');
		expect(s).not.toContain('sss');
	});
});

describe('fitReason', () => {
	it('joins head and tail when they fit, and refuses a tail past the limit', () => {
		expect(fitReason('head', '; tail', 20)).toBe('head; tail');
		expect(fitReason('a long head here', '; tail', 12)).toBe('a lon…; tail');
		expect(() => fitReason('h', 'x'.repeat(21), 20)).toThrow(/more than 20/);
	});
});
