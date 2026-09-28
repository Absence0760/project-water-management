import { fdcPercentileTable } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { fdcReportDays, fdcReportRows } from './fdc';

// Synthetic m³/s: 100 days, natural 0.001 … 0.1, simulated half of it, the gauge only the last 60 days.
const natural = Array.from({ length: 100 }, (_, i) => (i + 1) / 1000);
const simulated = natural.map((v) => v / 2);
const observed = natural.map((v, i) => (i < 40 ? null : v));

describe('the report’s FDC table', () => {
	it('shows the chart’s default days: every record on the observed days when the gauge misses some', () => {
		const t = fdcPercentileTable({ natural, simulated, observed });
		const rows = fdcReportRows(t);
		expect(rows.map((r) => [r[0], r[5]])).toEqual([
			['Natural', '60'],
			['Simulated outflow', '60'],
			['Observed', '60']
		]);
		// Same numbers as the table, small flows to two significant figures, never 0.000.
		expect(rows[1]![3]).toBe('0.023'); // Q90: 0.02305 (rank 54.9 of 60)
		expect(rows.flat()).not.toContain('0.000');
		expect(fdcReportDays(t)).toBe('every record on the 60 days with an observed reading');
	});

	it('ranks the whole run without a partial gauge', () => {
		const t = fdcPercentileTable({ natural, simulated });
		expect(fdcReportRows(t).map((r) => r[0])).toEqual(['Natural', 'Simulated outflow']);
		expect(fdcReportRows(t)[1]![4]).toBe('0.0025'); // Q95: 0.002525, three decimals would say 0.003
		expect(fdcReportDays(t)).toBe('all 100 days of the run');
	});
});
