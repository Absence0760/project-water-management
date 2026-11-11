// The settings revision an accepted evaporation proposal writes cites its
// dataset by a stable reference that fits model_revision.reason (issue #763):
// the WRC Atlas's own source (~330 characters) and method (~460) were cut off
// at REASON_MAX before. Synthetic values; the Atlas's real recorded lines.
import { PE_SOURCE_MAX } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { fitCitedReason, fitReason, REASON_MAX } from '../history/record.js';
import { evaporationCreditPath, referenceEvaporation, type EvaporationDataset } from './evaporation.js';
import { ATLAS_APAN, atlasApanMethodFor, DPET } from './evaporationGrid.js';
import { evaporationReason, peSourceFor, spanReason, stationReason, wr2012Reason } from './evaporationRoutes.js';

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

describe('the station, WR2012 and typed S-pan reasons (issue #763)', () => {
	const longNote = `; ${'a long conversion note '.repeat(25)}`;

	it('a DWS station’s reason keeps its source and dataset whole after a long head', () => {
		const st = { source: 'DWS Hydrological Services, evaporation records (invented), reply of 2026-11-01', dataset: 'synthetic' };
		const reason = stationReason(`A-pan evaporation from DWS evaporation station Z1E001${longNote}`, st);
		expect(reason.length).toBeLessThanOrEqual(REASON_MAX);
		expect(reason.endsWith(`…. ${st.source} (dataset “synthetic”).`)).toBe(true);
	});

	it('a DWS station with a long source cites the dataset by its reference', () => {
		const reason = stationReason(`A-pan evaporation from DWS evaporation station Z1E001${longNote}`, { source: 'S'.repeat(400), dataset: 'dws-2026' });
		expect(reason.length).toBeLessThanOrEqual(REASON_MAX);
		expect(reason).toMatch(/\. Dataset “dws-2026”: its source as the dataset records it, credit at \/data-sources\.$/);
		expect(reason).toMatch(/^A-pan evaporation from DWS evaporation station Z1E001/);
	});

	it('WR2012’s reason keeps its source whole after a long quaternary list', () => {
		const list = Array.from({ length: 60 }, (_, i) => `Z${String(i).padStart(2, '0')}A 1 % (2 of 3 irrigation modules agree)`).join(', ');
		const head = `A-pan evaporation from WR2012’s WRSM2000 irrigation modules (dataset “WR2012-evap”): 1650 mm a year, the area-weighted A-pan of the quaternaries under the catchment boundary “B”: ${list}`;
		const source = 'WR2012 (WRC 2015), WRSM2000 network configurations, WMAs 16–19: monthly S-pan (runoff modules) and A-pan (irrigation modules).';
		const reason = wr2012Reason(head, '“WR2012-evap”', source);
		expect(reason.length).toBe(REASON_MAX);
		expect(reason).toMatch(/^A-pan evaporation from WR2012’s WRSM2000 irrigation modules \(dataset “WR2012-evap”\)/);
		expect(reason.endsWith(`…. ${source}`)).toBe(true);
		const long = wr2012Reason(head, '“WR2012-evap”', 'W'.repeat(450));
		expect(long.length).toBeLessThanOrEqual(REASON_MAX);
		expect(long).toMatch(/\. Source as dataset “WR2012-evap” records it, credit at \/data-sources#wrc-water-resources\.$/);
		expect(wr2012Reason('short', '“x”', null)).toBe('short.');
	});

	it('a typed S-pan’s reason keeps the months and the conversion after a 200-character note', () => {
		const span = [150, 170, 190, 195, 160, 140, 95, 70, 55, 57, 78, 105];
		const label = 'Taljaard (2023) general monthly equation, inverted';
		const conv = 'S-pan converted to A-pan by A = (S + 11.1745) ÷ 0.8706, the inverse of the Taljaard (2023) general monthly equation (Taljaard 2023, WRC Report)';
		const reason = spanReason('n'.repeat(200), span.map((x) => x * 1.2), span, label, conv);
		expect(reason.length).toBe(REASON_MAX);
		expect(reason.endsWith(` (Oct–Sep, mm: ${span.join(' ')}), converted by the ${label}; ${conv}.`)).toBe(true);
		expect(spanReason(undefined, span, span, label, 'c')).toBe(`A-pan evaporation from S-pan typed or pasted: 1465 mm a year from 1465 mm of S-pan (Oct–Sep, mm: ${span.join(' ')}), converted by the ${label}; c.`);
	});
});

describe('fitReason', () => {
	it('joins head and tail when they fit, and refuses a tail past the limit', () => {
		expect(fitReason('head', '; tail', 20)).toBe('head; tail');
		expect(fitReason('a long head here', '; tail', 16)).toBe('a long…; tail');
		expect(() => fitReason('h', 'x'.repeat(21), 20)).toThrow(/more than 20/);
	});

	it('fitCitedReason keeps a citation up to half the reason, else the reference', () => {
		expect(fitCitedReason('head', '; cite', '; ref', 20)).toBe('head; cite');
		expect(fitCitedReason('h'.repeat(20), '; cite', '; ref', 20)).toBe(`${'h'.repeat(13)}…; cite`);
		expect(fitCitedReason('h'.repeat(20), `; ${'c'.repeat(10)}`, '; ref', 20)).toBe(`${'h'.repeat(14)}…; ref`);
	});
});
