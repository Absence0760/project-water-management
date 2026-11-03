// The WR2012 evaporation panel's wording (wr2012Evaporation.ts; docs/maps.md § WR2012 evaporation by quaternary). Invented numbers.
import { describe, expect, it } from 'vitest';
import type { Wr2012EvaporationProposal, Wr2012EvaporationQuaternary } from '#lib/api/index.js';
import { agreementText, annualMm, meanText, ratioText, shareText, useMessage } from './wr2012Evaporation';

const S = [150, 180, 205, 210, 170, 150, 100, 70, 55, 55, 75, 110];
const A = S.map((v) => Math.round(v * 1.27));
const q = (code: string, share: number, apan = true): Wr2012EvaporationQuaternary => ({
	code,
	dataset: 'synthetic',
	evaporationDataset: 'synthetic',
	synthetic: true,
	share,
	areaKm2: share * 100,
	zone: 'Z1',
	maeMm: 1500,
	spanMm: S,
	apanMm: apan ? A : null,
	span: { modules: 1, agree: 1, othersMm: [] },
	apan: apan ? { modules: 1, agree: 1, othersMm: [] } : null,
	files: 2,
	disagree: false,
	why: apan ? null : 'no irrigation module gives its A-pan, only S-pan',
	source: 'SYNTHETIC'
});
type Evaporation = NonNullable<Wr2012EvaporationProposal['evaporation']>;
const ev = (quaternaries: Wr2012EvaporationQuaternary[], apanCoverage: number): Evaporation => ({ quaternaries, spanMm: S, apanMm: A, spanCoverage: 1, apanCoverage, problem: null });

describe('the WR2012 evaporation panel', () => {
	it('words a share, a year’s total and the A/S ratio', () => {
		expect(shareText(0.746)).toBe('75 %');
		expect(shareText(0.003)).toBe('< 1 %');
		expect(annualMm([100.04, 100.04, 100.04])).toBe(300);
		expect(ratioText({ spanMm: S, apanMm: A })).toBe('1.27');
		expect(ratioText({ spanMm: S, apanMm: null })).toBe('–');
	});

	it('says how the modules agree, naming the others’ totals when they don’t', () => {
		expect(agreementText(null)).toBe('–');
		expect(agreementText({ modules: 1, agree: 1, othersMm: [] })).toBe('1 module');
		expect(agreementText({ modules: 3, agree: 3, othersMm: [] })).toBe('3 modules agree');
		expect(agreementText({ modules: 3, agree: 2, othersMm: [1620] })).toMatch(/^2 of 3 agree; others 1\s?620 mm$/);
	});

	it('says whether the catchment’s row is one quaternary’s or the area-weighted mean, and what is left out', () => {
		expect(meanText(ev([q('Z01A', 1)], 1))).toBe('The catchment’s A-pan is Z01A’s row: the catchment lies in it.');
		expect(meanText(ev([q('Z01A', 0.75), q('Z01B', 0.25)], 1))).toBe('The catchment’s A-pan is the mean of the 2 quaternaries’ rows, each weighted by its share of the catchment’s area.');
		expect(meanText(ev([q('Z01C', 0.5), q('Z02C', 0.5, false)], 0.5))).toMatch(/Z01C’s row: the catchment lies in it\. 50 % of the catchment lies in quaternaries with no irrigation module \(A-pan\) loaded, or in none, and is left out of the mean\.$/);
	});

	it('confirms what Use writes, from which quaternaries, as it stands', () => {
		const one = useMessage(ev([q('Z01A', 1)], 1), []);
		expect(one).toMatch(/^The A-pan row becomes 1\s?945 mm a year, WR2012’s A-pan from quaternary Z01A’s irrigation modules, as it stands\. Irrigation demand/);
		const two = useMessage(ev([q('Z01A', 0.75), q('Z01B', 0.25)], 1), [{ name: 'DWS Z1E001', source: null, from: '2014-01-01', to: '2017-12-31' }]);
		expect(two).toMatch(/from the irrigation modules of Z01A \(75 %\), Z01B \(25 %\), area-weighted, as it stands\./);
		expect(two).toMatch(/The daily A-pan series “DWS Z1E001” still replaces the monthly row on every day it covers\.$/);
	});
});
