import { SERIES_KINDS } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { ProjectFile } from './document.js';

const doc = (kind: string) => ({
	name: 'P',
	model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
	series: [{ kind, name: 'x', unit: 'm³/s', startDate: '2020-01-01', values: [1, null] }]
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
