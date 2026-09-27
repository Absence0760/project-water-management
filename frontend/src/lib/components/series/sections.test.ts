import { describe, expect, it } from 'vitest';
import { DATA_ANCHORS, dataAnchor, dataNavGroups } from './sections';

const ids = (p: Parameters<typeof dataNavGroups>[0]) => dataNavGroups(p).flatMap((g) => g.sections.map((s) => s.id));
const ALL = { chart: true, agreement: true, doubleMass: true, checks: true, upload: true };

describe('dataNavGroups', () => {
	it('links every panel, in page order, when the page draws them all', () => {
		expect(ids(ALL)).toEqual([...DATA_ANCHORS]);
		expect(dataNavGroups(ALL).map((g) => g.label)).toEqual(['Series', 'Checks', 'Adding data']);
	});

	it('leaves out the panels the page does not draw, and a group with none left', () => {
		// A viewer on a new catchment: no chart yet, no checks, no upload form.
		const none = { chart: false, agreement: false, doubleMass: false, checks: false, upload: false };
		expect(ids(none)).toEqual(['data-series', 'data-uses']);
		expect(dataNavGroups(none).map((g) => g.label)).toEqual(['Series', 'Adding data']);
		expect(ids({ ...ALL, agreement: false, upload: false })).toEqual(['data-series', 'data-chart', 'data-double-mass', 'data-checks', 'data-uses']);
	});

	it('knows its own anchors, the older #upload-csv among them, and no others', () => {
		for (const id of DATA_ANCHORS) expect(dataAnchor(id)).toBe(true);
		for (const id of ['res-summary', 'set-ewr', 'data', '']) expect(dataAnchor(id)).toBe(false);
	});
});
