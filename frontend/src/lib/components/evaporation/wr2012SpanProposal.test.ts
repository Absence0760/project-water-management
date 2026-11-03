// The WR2012 S-pan panel's wording and choices (wr2012SpanProposal.ts; docs/maps.md § WR2012 S-pan). Invented numbers.
import { describe, expect, it } from 'vitest';
import type { Wr2012SpanProposal, Wr2012SpanQuaternary } from '#lib/api/index.js';
import { annualMm, chosenApan, meanText, shareText, useMessage, withSpan } from './wr2012SpanProposal';

const PCT = [10.2, 11.8, 13.0, 13.2, 11.0, 9.6, 6.6, 4.8, 3.6, 3.8, 5.2, 7.2];
const q = (code: string, share: number, maeMm: number | null): Wr2012SpanQuaternary => ({
	code,
	dataset: 'synthetic',
	synthetic: true,
	share,
	areaKm2: share * 100,
	zone: maeMm ? 'Z1' : null,
	maeMm,
	pct: maeMm ? PCT : null,
	spanMm: maeMm ? PCT.map((p) => Math.round(maeMm * p) / 100) : null,
	source: 'SYNTHETIC'
});
type Span = NonNullable<Wr2012SpanProposal['span']>;
const span = (quaternaries: Wr2012SpanQuaternary[], coverage: number): Span => ({
	quaternaries,
	coverage,
	spanMm: new Array(12).fill(120),
	problem: null,
	conversions: [
		{ id: 'taljaard2023', label: 'Taljaard (2023) general monthly equation, inverted', result: { ok: true, values: new Array(12).fill(150.7), note: 'n' } },
		{ id: 'wr90', label: 'WR90 general monthly equation, inverted', result: { ok: false, reason: 'the S-pan in Jul is below 32.5 mm' } }
	]
});

describe('the WR2012 S-pan panel', () => {
	it('words a share, a sliver included, and a year’s total', () => {
		expect(shareText(0.746)).toBe('75 %');
		expect(shareText(0.003)).toBe('< 1 %');
		expect(shareText(1)).toBe('100 %');
		expect(annualMm([100.04, 100.04, 100.04])).toBe(300);
	});

	it('says whether the catchment’s row is one quaternary’s or the area-weighted mean, and what is left out', () => {
		expect(meanText(span([q('Z01A', 1, 1500)], 1))).toBe('The catchment’s S-pan is Z01A’s row: the catchment lies in it.');
		expect(meanText(span([q('Z01A', 0.75, 1500), q('Z01B', 0.25, 1560)], 1))).toBe('The catchment’s S-pan is the mean of the 2 quaternaries’ rows, each weighted by its share of the catchment’s area.');
		expect(meanText(span([q('Z01C', 0.5, 1620)], 0.5))).toMatch(/Z01C’s row: the catchment lies in it\. 50 % of the catchment lies in quaternaries with no WR2012 evaporation loaded, or in none, and is left out of the mean\.$/);
		expect(withSpan(span([q('Z01A', 0.8, 1500), q('Y01B', 0.2, null)], 0.8)).map((x) => x.code)).toEqual(['Z01A']);
	});

	it('proposes no A-pan until an equation is picked, and none from one that refuses', () => {
		const s = span([q('Z01A', 1, 1500)], 1);
		expect(chosenApan(s, null)).toBeNull();
		expect(chosenApan(s, 'wr90')).toBeNull();
		expect(chosenApan(s, 'taljaard2023')).toEqual(new Array(12).fill(150.7));
	});

	it('confirms what Use writes, from which quaternaries and by which equation', () => {
		const one = useMessage(span([q('Z01A', 1, 1500)], 1), new Array(12).fill(150), 'Taljaard (2023) general monthly equation, inverted', []);
		expect(one).toMatch(/^The A-pan row becomes 1[\s ]800 mm a year, from quaternary Z01A’s WR2012 S-pan \(zone Z1, MAE 1[\s ]500 mm\), converted by the Taljaard \(2023\) general monthly equation, inverted\. Irrigation demand/);
		const two = useMessage(span([q('Z01A', 0.75, 1500), q('Z01B', 0.25, 1560)], 1), new Array(12).fill(150), 'WR90 general monthly equation, inverted', [{ name: 'DWS Z1E001', source: null, from: '2014-01-01', to: '2017-12-31' }]);
		expect(two).toMatch(/from the area-weighted WR2012 S-pan of Z01A \(75 %\), Z01B \(25 %\), converted by the WR90/);
		expect(two).toMatch(/The daily A-pan series “DWS Z1E001” still replaces the monthly row on every day it covers\.$/);
	});
});
