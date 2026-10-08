import { describe, expect, it } from 'vitest';
import type { CalibrationStats } from '@water-management/engine';
import { describeWindow, isLegacyStats, isPartYear, kgeComponents, metricRows, volumeBiasText, waterYearLabel, windowError } from './metrics';
import { tipFor } from '$lib/help/tips';

const base: CalibrationStats = {
	days: 100,
	nse: 0.7,
	pbias: -12.34,
	rmseM3s: 1.2345,
	meanObservedM3s: 1,
	meanSimulatedM3s: 1.1,
	kge: 0.62,
	kgeR: 0.741,
	kgeAlpha: 1.062,
	kgeBeta: 1.183,
	r2: 0.55,
	logNse: 0.58,
	volumeErrorPct: 12.34,
	annualVolumes: []
};

describe('metricRows', () => {
	it('gives every tile a help tip under its stats field key (CalibrationPanel places it)', () => {
		for (const r of metricRows(base)) expect(tipFor(`stats.${r.key}`), r.key).toBeDefined();
	});

	it('formats values with a plain explanation and no pass mark (calibration research CR-6)', () => {
		const rows = Object.fromEntries(metricRows(base).map((r) => [r.key, r]));
		expect(rows.nse!.value).toBe('0.70');
		// PBIAS −12.34 (Moriasi sign) is 12.3 % too much water, the volume error +12.34: one reading, in words (issue #51).
		expect(rows.pbias!.value).toBe('12.3% too wet');
		expect(rows.pbias!.label).toBe('Volume bias (PBIAS)');
		// One tile for the volume bias: the signed volume error isn't shown beside it.
		expect(Object.keys(rows)).not.toContain('volumeErrorPct');
		expect(rows.rmseM3s!.unit).toBe('m³/s');
		expect(metricRows(base).every((r) => r.help.length > 10)).toBe(true);
		// Moriasi's thresholds were set for monthly flows: no daily score is rated.
		for (const r of metricRows(base)) {
			expect(Object.keys(r)).not.toContain('rating');
			expect(r.help).not.toMatch(/very good|satisfactory/i);
		}
	});

	it('shows dashes for metrics an old run does not have', () => {
		const old = { days: 10, nse: 0.2, pbias: 30, rmseM3s: 1, meanObservedM3s: 1, meanSimulatedM3s: 1 };
		expect(isLegacyStats(old)).toBe(true);
		expect(isLegacyStats(base)).toBe(false);
		const rows = Object.fromEntries(metricRows(old).map((r) => [r.key, r]));
		expect(rows.kge!.value).toBe('–');
		expect(rows.pbias!.value).toBe('30.0% too dry');
		expect(kgeComponents(old)).toBeNull();
	});
});

describe('volumeBiasText (issue #51)', () => {
	it('reads the volume error in words, never a sign', () => {
		expect(volumeBiasText(-57.594)).toBe('57.6% too dry');
		expect(volumeBiasText(12.34)).toBe('12.3% too wet');
		expect(volumeBiasText(0.01)).toBe('0.0%');
		expect(volumeBiasText(null)).toBe('–');
		expect(volumeBiasText(Number.NaN)).toBe('–');
	});
});

describe('formatting helpers', () => {
	it('labels water years as start/end', () => {
		expect(waterYearLabel(2010)).toBe('2010/11');
		expect(waterYearLabel(1999)).toBe('1999/00');
	});

	it('summarises KGE components', () => {
		expect(kgeComponents(base)).toBe('r 0.74 · α 1.06 · β 1.18');
	});

	it('flags part years', () => {
		const y = { waterYear: 2012, days: 169, daysInWindow: 365, observedMm3: 1, simulatedMm3: 1, diffPct: 0 };
		expect(isPartYear(y)).toBe(true);
		expect(isPartYear({ ...y, days: 365 })).toBe(false);
	});

	it('describes and validates the window', () => {
		expect(describeWindow('2005-10-01', '2012-09-30')).toBe('2005-10-01 – 2012-09-30');
		expect(describeWindow(null, null)).toBe('whole record');
		expect(describeWindow('2005-10-01', null)).toBe('from 2005-10-01');
		expect(windowError(null, null)).toBeNull();
		expect(windowError('2005-10-01', '2012-09-30')).toBeNull();
		expect(windowError('2012-10-01', '2005-09-30')).toMatch(/before the end/);
		expect(windowError('2005-13-45', null)).toMatch(/must be a date/);
	});
});
