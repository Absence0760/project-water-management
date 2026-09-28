import { describe, expect, it } from 'vitest';
import type { Run } from '$lib/api/types';
import { FORECAST_RAIN_NOTE } from '@water-management/engine';
import { forecastNote, isReportReady, reportCharts, reportSections } from './sections';

type R = Pick<Run, 'summary' | 'model' | 'notes'>;
const run = (over: { curtailment?: boolean; nodes?: number; notes?: string } = {}): R =>
	({
		summary: { farms: [], warnings: [], calibration: null, ...(over.curtailment ? { curtailment: {} } : {}) },
		model: { nodes: Array.from({ length: over.nodes ?? 0 }, (_, i) => ({ id: `n${i}`, name: `Node ${i}` })) },
		notes: over.notes ?? ''
	}) as unknown as R;

describe('reportSections', () => {
	it('lists every section in the report order when the run has the data for all of them', () => {
		expect(reportSections(run({ curtailment: true, nodes: 3, notes: 'Baseline for the licence.' })).map((s) => s.id)).toEqual([
			'cover',
			'network',
			'inputs',
			'calibration',
			'curtailment',
			'ewr',
			'farms',
			'notes',
			'validation',
			'signoff',
			'disclaimer'
		]);
	});

	it('leaves out a section whose data the run lacks, with no placeholder', () => {
		const ids = reportSections(run()).map((s) => s.id);
		expect(ids).toEqual(['cover', 'inputs', 'calibration', 'ewr', 'farms', 'validation', 'signoff', 'disclaimer']);
	});

	it('always closes with the validation statement, the sign-off and the disclaimer (WP-3.13), even when unsigned', () => {
		expect(reportSections(run()).slice(-3).map((s) => s.title)).toEqual(['Validation statement', 'Professional sign-off', 'Disclaimer']);
	});

	it('opened from Compare runs (against a baseline) is an impact report, the impact first after the cover', () => {
		const s = reportSections(run({ nodes: 3 }), { impact: true });
		expect(s.slice(0, 3).map((x) => [x.id, x.title])).toEqual([
			['cover', 'Impact report'],
			['impact', 'Impact against the baseline'],
			['network', 'Network']
		]);
		expect(reportSections(run()).some((x) => x.id === 'impact')).toBe(false);
		expect(reportSections(run())[0]!.title).toBe('Catchment report');
	});

	it('treats whitespace-only notes as no notes', () => {
		expect(reportSections(run({ notes: '  \n ' })).some((s) => s.id === 'notes')).toBe(false);
	});

	it('copes with a run from an older API that has no model snapshot', () => {
		const r = { ...run(), model: undefined } as R;
		expect(reportSections(r).some((s) => s.id === 'network')).toBe(false);
	});
});

describe('reportCharts', () => {
	it('draws the hydrograph with the calibration and the EWR chart with the EWR section', () => {
		expect(reportCharts(reportSections(run()))).toEqual(['hydrograph', 'ewr']);
		expect(reportCharts([{ id: 'cover', title: '' }])).toEqual([]);
	});
});

describe('isReportReady', () => {
	it('waits for the data and for every chart to draw', () => {
		expect(isReportReady(false, ['hydrograph'], { hydrograph: true })).toBe(false);
		expect(isReportReady(true, ['hydrograph', 'ewr'], { hydrograph: true })).toBe(false);
		expect(isReportReady(true, ['hydrograph', 'ewr'], { hydrograph: true, ewr: false })).toBe(false);
		expect(isReportReady(true, ['hydrograph', 'ewr'], { hydrograph: true, ewr: true })).toBe(true);
	});

	it('is ready at once when the data is in and there is nothing to draw', () => {
		expect(isReportReady(true, [], {})).toBe(true);
	});
});

describe('forecastNote', () => {
	it('gives a forecast run the forecast-rain line from its first forecast day', () => {
		const summary = { forecast: { from: '2022-01-29', to: '2022-02-11' } } as unknown as Pick<Run['summary'], 'forecast'>;
		expect(forecastNote(summary)).toBe(FORECAST_RAIN_NOTE('2022-01-29'));
		expect(forecastNote(summary)).toMatch(/^From 2022-01-29, this run uses forecast rain \(CHIRPS-GEFS/);
	});

	it('gives any other run none', () => {
		expect(forecastNote({} as Pick<Run['summary'], 'forecast'>)).toBeNull();
	});
});
