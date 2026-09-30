// How the evidence report prints its numbers (issue #71, design §5): the
// paired median with its range and the run's own difference (D-U2), "no band"
// in words (D-U1, D-U6), "worse in k of n" (D-U3), true minus signs.
import { describe, expect, it } from 'vitest';
import { bandRange, bandText, changeText, digitsFor, shortCode, signed, valueText, worseText } from './format';

const band = (p5: number | null, p50: number | null, p95: number | null) => ({ n: 77, p5, p50, p95, min: p5, max: p95 });

describe('evidence report number formats', () => {
	it('signs a change with a true minus sign, and 0 without a sign', () => {
		expect(signed(98, 0)).toBe('+98');
		expect(signed(-1.7, 1)).toBe('−1.7');
		expect(signed(0, 1)).toBe('0.0');
		expect(signed(-0.0001, 1)).toBe('0.0');
	});

	it('prints a value with its unit, and a dash for a missing one', () => {
		expect(valueText({ unit: 'days' }, 3937)).toMatch(/^3 ?937 days$|^3 937 days$|^3937 days$/);
		expect(valueText({ unit: '% of months' }, 36.66)).toBe('36.7 %');
		expect(valueText({ unit: 'Mm³/a' }, 1.3521)).toBe('1.352 Mm³/a');
		expect(valueText({ unit: 'days' }, null)).toBe('–');
		expect(digitsFor('Mm³')).toBe(2);
		// The registered-use row counts whole unit-years (§ 5): no decimals.
		expect(valueText({ unit: 'unit-years' }, 3)).toBe('3 unit-years');
	});

	it('prints the other applications’ sum without "run:", with why it has no band', () => {
		const c = changeText({ unit: 'days', id: 'otherApplications' }, { run: 14, band: null, bandNote: 'no band: a sum of other runs’ own differences', worse: null });
		expect(c).toEqual({ main: '+14 days', sub: 'no band: a sum of other runs’ own differences', banded: false });
		// Control: any other row without a band keeps "run:".
		expect(changeText({ unit: 'days', id: 'ewrDays' }, { run: 14, band: null, bandNote: 'no band', worse: null }).main).toBe('run: +14 days');
	});

	it('prints a banded change as the paired median, its range and the run (D-U2)', () => {
		const c = changeText({ unit: 'days' }, { run: 135, band: band(-9, 98, 175), bandNote: null, worse: { k: 71, n: 77 } });
		expect(c).toEqual({ main: '+98 days', sub: '−9 to +175 · run: +135 days', banded: true });
		// Percentage-point changes.
		expect(changeText({ unit: '% of months' }, { run: -1.1, band: band(-3.9, -1.7, 0), bandNote: null, worse: null }).main).toBe('−1.7 pp');
	});

	it('says "no band" and why, never an unpaired difference (D-U1, D-U6)', () => {
		const c = changeText({ unit: '% of demand' }, { run: -3, band: null, bandNote: 'no band: the ensemble doesn’t carry this measure yet', worse: null });
		expect(c).toEqual({ main: 'run: −3.0 pp', sub: 'no band: the ensemble doesn’t carry this measure yet', banded: false });
		// A gated band has no percentiles: the run's difference with the gate's note.
		const gated = changeText({ unit: 'days' }, { run: 12, band: band(null, null, null), bandNote: 'no band: not enough accepted parameter sets (12 of 301)', worse: null });
		expect(gated.banded).toBe(false);
		expect(gated.sub).toMatch(/not enough accepted/);
		expect(changeText({ unit: 'days' }, null)).toEqual({ main: '–', sub: null, banded: false });
	});

	it('counts "worse in" with the share beside it', () => {
		expect(worseText({ run: 1, band: null, bandNote: null, worse: { k: 71, n: 77 } })).toBe('71 of 77 sets (92 %)');
		expect(worseText({ run: 1, band: null, bandNote: null, worse: null })).toBe('—');
		expect(worseText(null)).toBe('—');
	});

	it('prints bands, and the short verification code', () => {
		expect(bandText(band(-9, 98, 175), 0, ' days')).toBe('median +98 days (−9 to +175)');
		expect(bandText(band(null, null, null), 0)).toBe('no band');
		expect(bandRange(band(3125, 3937, 4394), 0)).toMatch(/^3.125 – 3.937 – 4.394$/);
		expect(shortCode('b70c9949aaaa')).toBe('b70c-9949');
	});
});
