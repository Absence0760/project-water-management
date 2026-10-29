// § 7 Observed wet days' printed rows (evidence-24, issue #624 step 7): per
// dam the dates together, then each satellite; an older pack's WOfS-only
// table as it printed. Invented dams and dates.
import { describe, expect, it } from 'vitest';
import { damObservationsSection, damObservationsSectionV1, type EvidenceDamObservationInput } from '@water-management/engine';
import { fmtDate } from '#lib/format/number.js';
import { damObservationCreditLine, damObservationRows, ruleText, SOURCE_ROW_LABEL } from './damObservations';

const DAMS: EvidenceDamObservationInput[] = [
	{
		featureId: 'd1',
		name: 'Upper dam',
		nodeId: 'F1',
		rows: [
			{ source: 'wofs', date: '2020-01-05', wetAreaM2: 1800, pctObserved: 100 },
			{ source: 'wofs', date: '2020-01-13', wetAreaM2: 900, pctObserved: 100 },
			{ source: 's2', date: '2020-01-13', wetAreaM2: 0, pctObserved: 100 },
			{ source: 's2', date: '2021-03-02', wetAreaM2: 1200, pctObserved: 40 }
		]
	},
	{ featureId: 'd2', name: '', nodeId: 'F1', rows: [] }
];
const CTX = { applicant: true, ownNodeIds: ['F1'], startDate: '2019-10-01', endDate: '2021-09-30', models: [] };

describe('damObservationRows', () => {
	it('prints each dam’s dates together, then Sentinel-2’s and WOfS’s', () => {
		const rows = damObservationRows(damObservationsSection(DAMS, CTX)!);
		expect(rows.map((r) => [r.dam, r.damRows, r.source, r.together, ...r.cells])).toEqual([
			['Unnamed dam', 3, 'Either satellite', true, '0', '0', '0', '0'],
			[null, 0, 'Sentinel-2 (10 m)', false, '0', '0', '0', '0'],
			[null, 0, 'WOfS (Landsat, 30 m)', false, '0', '0', '0', '0'],
			// Together: 01-05 wet (WOfS), 01-13 dry (Sentinel-2 over WOfS's one pixel), 2021-03-02 wet (Sentinel-2).
			['Upper dam', 3, 'Either satellite', true, '3', '2', '1', '0'],
			[null, 0, 'Sentinel-2 (10 m)', false, '2', '1', '1', '0'],
			[null, 0, 'WOfS (Landsat, 30 m)', false, '2', '1', '0', '1']
		]);
		expect(rows[0]!.span).toBe('–');
		expect(rows[3]!.span).toBe(`${fmtDate('2020-01-05')} to ${fmtDate('2021-03-02')}`);
		expect(rows[4]!.span).toBe(`${fmtDate('2020-01-13')} to ${fmtDate('2021-03-02')}`);
	});

	it('prints a pack drafted from evidence-21 to evidence-23 as one WOfS row a dam, with no satellite column', () => {
		const rows = damObservationRows(damObservationsSectionV1(DAMS, CTX)!);
		expect(rows.map((r) => [r.dam, r.source, ...r.cells, r.span])).toEqual([
			['Unnamed dam', null, '0', '0', '0', '0', '–'],
			['Upper dam', null, '2', '1', '0', '1', `${fmtDate('2020-01-05')} to ${fmtDate('2020-01-13')}`]
		]);
	});
});

describe('damObservationCreditLine', () => {
	it('credits WOfS and Sentinel-2, with Copernicus’s credit verbatim and its years; an older pack WOfS alone, as it printed', () => {
		expect(damObservationCreditLine(damObservationsSection(DAMS, CTX)!)).toBe(
			'Sources: Digital Earth Africa WOfS, CC BY 4.0, and Sentinel-2, each summed inside the dams’ traced outlines by this app. Contains modified Copernicus Sentinel data 2020–2021, processed by Digital Earth Africa.'
		);
		expect(damObservationCreditLine(damObservationsSectionV1(DAMS, CTX)!)).toBe('Source: Digital Earth Africa WOfS, CC BY 4.0, summed inside the dams’ traced outlines by this app.');
	});

	it('leaves Sentinel’s credit out when no Sentinel-2 value shows', () => {
		expect(damObservationCreditLine(damObservationsSection([DAMS[1]!], CTX)!)).toBe('Source: Digital Earth Africa WOfS, CC BY 4.0, summed inside the dams’ traced outlines by this app.');
	});
});

describe('ruleText', () => {
	it('words a source’s wet rule with its area', () => {
		expect(ruleText(SOURCE_ROW_LABEL.s2, { wetMinPixels: 8, pixelAreaM2: 100 })).toBe('Sentinel-2 (10 m): at least 8 pixels (about 800 m²)');
	});
});
