import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, GR4J_PARAMS, RETIRED_CALIBRATION_KEYS, RUNOFF_MODELS } from '@water-management/engine';
import type { FitRecord } from '@water-management/engine';
import { fitSummary, GR4J_FIELDS, KNOWN_CAL_KEYS, RUNOFF_MODEL_HELP, typicalRange } from './calibration';

describe('known calibration parameters', () => {
	it('cover every engine default key, and none of the legacy model’s', () => {
		expect([...KNOWN_CAL_KEYS].sort()).toEqual(Object.keys(defaultProjectSettings().calibration).sort());
		for (const k of RETIRED_CALIBRATION_KEYS) expect(KNOWN_CAL_KEYS.has(k)).toBe(false);
	});
});

describe('GR4J fields', () => {
	it('cover every engine GR4J parameter, with its bounds and help', () => {
		expect(GR4J_FIELDS.map((f) => f.key)).toEqual(GR4J_PARAMS.map((p) => p.key));
		for (const f of GR4J_FIELDS) expect(f.help.length, f.key).toBeGreaterThan(20);
		expect(typicalRange(GR4J_FIELDS[0]!)).toBe('Typical 100–1200 mm; allowed 10–3000.');
	});

	it('GR4J is the only runoff model, and the help says the legacy one is gone', () => {
		expect([...RUNOFF_MODELS]).toEqual(['gr4j']);
		expect(RUNOFF_MODEL_HELP).toMatch(/removed in engine 1\.0\.0/);
	});
});

describe('fitSummary (the section header line)', () => {
	const record = (objective: string, score: number | null) =>
		({ fittedAt: '2025-01-15T09:00:00Z', objective, fit: { scores: { [objective]: score } } }) as unknown as FitRecord;

	it('names the fit day and its in-sample score on its own objective', () => {
		expect(fitSummary(record('kgePrime', 0.9312), false)).toBe('GR4J · fitted 15 Jan 2025 · KGE′ 0.93 in calibration');
		expect(fitSummary(record('kgeYearly', 0.8), false)).toBe('GR4J · fitted 15 Jan 2025 · Year-balanced KGE′ 0.80 in calibration');
	});

	it('says when something the fit depends on changed since, and leaves out a missing score', () => {
		expect(fitSummary(record('nseLog', null), true)).toBe('GR4J · fitted 15 Jan 2025 · changed since the fit');
	});

	it('says there is no fit record', () => {
		expect(fitSummary(null, false)).toBe('GR4J · no fit record: the parameters were set by hand or imported');
	});
});
