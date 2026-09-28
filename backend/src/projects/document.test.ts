import { canonicalUnit, SERIES_KINDS } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { ProjectFile } from './document.js';

const doc = (kind: string) => ({
	name: 'P',
	model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
	series: [{ kind, name: 'x', unit: canonicalUnit(kind), startDate: '2020-01-01', values: [1, null] }]
});

describe('ProjectFile.series[].kind', () => {
	it('accepts every series kind, including the reference gauge the workbook importer can emit', () => {
		for (const k of SERIES_KINDS) expect(ProjectFile.safeParse(doc(k)).success, k).toBe(true);
		expect(ProjectFile.safeParse(doc('flow_reference_m3s')).success).toBe(true);
	});

	it('rejects a kind no run or chart knows, instead of storing it silently', () => {
		for (const bad of ['flow_gauge_m3s', 'Flow_observed_m3s', '']) expect(ProjectFile.safeParse(doc(bad)).success, bad).toBe(false);
	});
});

describe('ProjectFile.series[] bounds (as PUT /projects/:id/series)', () => {
	const withSeries = (s: Record<string, unknown>) => ({ ...doc('rain_catchment_mm'), series: [{ ...doc('rain_catchment_mm').series[0], ...s }] });

	it('accepts a real calendar date, including 29 February in a leap year', () => {
		for (const d of ['2020-01-01', '2024-02-29']) expect(ProjectFile.safeParse(withSeries({ startDate: d })).success, d).toBe(true);
	});

	it('rejects a date that is not on the calendar or not ISO, which Postgres would fail on as a 500', () => {
		for (const d of ['2023-02-29', '2022-02-30', '2022-13-01', '01/02/2022', '']) {
			expect(ProjectFile.safeParse(withSeries({ startDate: d })).success, d).toBe(false);
		}
	});

	it('rejects an empty or overlong unit, an overlong name and a non-finite value', () => {
		expect(ProjectFile.safeParse(withSeries({ unit: '  ' })).success).toBe(false);
		expect(ProjectFile.safeParse(withSeries({ unit: 'x'.repeat(21) })).success).toBe(false);
		expect(ProjectFile.safeParse(withSeries({ name: 'x'.repeat(101) })).success).toBe(false);
		expect(ProjectFile.safeParse(withSeries({ values: [1, Infinity] })).success).toBe(false);
	});
});
