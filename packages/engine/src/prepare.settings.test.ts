// mergeSettings holds the settings a direct engine input can carry to the ranges the API and
// scenarios accept (scenario/ops.ts SETTINGS_CHECKS), so a value no form can save can't make rain
// raise demand, February NaN, or a dam gain water from evaporation (engine ≥ 1.69.0).
import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, type ModelInput } from './project';
import { mergeSettings } from './prepare';

const merge = (raw: Record<string, unknown>) => {
	const warnings: string[] = [];
	return { s: mergeSettings(raw as ModelInput['settings'], warnings), warnings };
};
const d = defaultProjectSettings();

describe('mergeSettings range guards', () => {
	it('a negative A-pan month runs as 0, with a warning', () => {
		const apan = [150, -20, 200, 210, 180, 150, 100, 60, 40, 40, 60, 100];
		const { s, warnings } = merge({ apanMm: apan });
		expect(s.apanMm).toEqual(apan.map((v) => Math.max(v, 0)));
		expect(warnings).toContain('A-pan evaporation below 0 in some months; using 0 there');
	});

	it.each([-0.5, 1.5, Number.NaN, '0.6'])('effective rain fraction %s falls back to the default', (v) => {
		const { s, warnings } = merge({ effectiveRainFraction: v });
		expect(s.effectiveRainFraction).toBe(d.effectiveRainFraction);
		expect(warnings.some((w) => w.startsWith('effective rain fraction'))).toBe(true);
	});

	it.each([0, 27, 30, Number.NaN, null])('February days %s falls back to the default', (v) => {
		const { s, warnings } = merge({ februaryDays: v });
		expect(s.februaryDays).toBe(d.februaryDays);
		expect(warnings.some((w) => w.startsWith('February days'))).toBe(true);
	});

	it.each([-1, 1001, Number.NaN])('rain threshold %s mm falls back to the default', (v) => {
		const { s, warnings } = merge({ calibration: { rainThresholdMm: v } });
		expect(s.calibration.rainThresholdMm).toBe(d.calibration.rainThresholdMm);
		expect(warnings.some((w) => w.startsWith('rain threshold'))).toBe(true);
	});

	it('values in range pass untouched and warn nothing about them (positive control)', () => {
		const { s, warnings } = merge({ effectiveRainFraction: 0, februaryDays: 29, calibration: { rainThresholdMm: 0 }, apanMm: new Array(12).fill(0) });
		expect([s.effectiveRainFraction, s.februaryDays, s.calibration.rainThresholdMm]).toEqual([0, 29, 0]);
		expect(warnings.filter((w) => /effective rain fraction|February days|rain threshold|below 0/.test(w))).toEqual([]);
	});
});
