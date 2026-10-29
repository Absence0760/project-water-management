// § 8 Future yield's printed rows (issue #621 slice 4): the record, then the
// median and range across models per SSP and horizon.
import { describe, expect, it } from 'vitest';
import type { EvidenceFutureYield } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';
import { factorText, futureRows, rangeText } from './future';

const m = (v: number) => `${fmtNum(v)} m³/a`;

const r = (median: number | null, min: number | null, max: number | null, n = 3) => ({ n, median, min, max });
const section = {
	status: 'ok',
	historical: { firmYieldM3Year: 120_000, yieldAtAssuranceM3Year: 130_000, applicantAssurance: 0.9, ewrDaysBaseline: 10, ewrDaysApplication: 14, ewrDaysChange: 4 },
	groups: [
		{
			ssp: 'ssp585',
			horizon: 'late',
			window: { from: 2066, to: 2095 },
			models: ['SYN-A', 'SYN-B', 'SYN-C'],
			firmYieldM3Year: r(90_000, 80_000, 100_000),
			yieldAtAssuranceM3Year: r(95_000, 95_000, 95_000),
			applicantAssurance: r(0.8, 0.7, 0.85),
			ewrDaysChange: r(6, 5, 9)
		}
	]
} as unknown as Extract<EvidenceFutureYield, { status: 'ok' }>;

describe('futureRows', () => {
	it('prints the record, then each SSP and horizon as its median and its range across the models', () => {
		expect(futureRows(section)).toEqual([
			{ label: 'Historical record', models: 0, cells: [m(120_000), m(130_000), '90 %', '+4 days'] },
			{ label: 'SSP5-8.5, 2066–2095', models: 3, cells: [`${m(90_000)} (${m(80_000)} to ${m(100_000)})`, m(95_000), '80 % (70 % to 85 %)', '+6 days (+5 days to +9 days)'] }
		]);
	});

	it('says nothing for a measure no model gives, and prints factors to two places', () => {
		expect(rangeText(r(null, null, null, 0), String)).toBe('–');
		expect(factorText([0.951, 1.2])).toBe('0.95 1.20');
	});
});
