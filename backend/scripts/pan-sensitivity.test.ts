import { defaultProjectSettings, PAN_COEFFICIENT_PRESETS, panCoefficientOutOfRange, type ModelInput, type ProjectSettings } from '@water-management/engine';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultCases, intOption, loadModelInput, meanAnnualMm3, panSensitivityRefusal, quantile, runCase, toMarkdown, type CaseResult } from './pan-sensitivity';

describe('quantile', () => {
	it('is the ascending value at the given fraction, clamped to the array', () => {
		const v = [5, 1, 4, 2, 3]; // sorted: 1 2 3 4 5
		expect(quantile(v, 0)).toBe(1);
		expect(quantile(v, 0.5)).toBe(3);
		expect(quantile(v, 1)).toBe(5);
		expect(quantile([], 0.5)).toBeNaN();
	});

	it('Q95 exceedance is quantile(values, 0.05): the value only 5 % of days fall below', () => {
		const v = Array.from({ length: 100 }, (_, i) => i); // 0..99
		expect(quantile(v, 0.05)).toBe(5);
	});
});

describe('meanAnnualMm3', () => {
	it('converts a daily m³/day series over a run to Mm³/year', () => {
		// 1 000 000 m³/day for exactly one year (365.25 days) = 1 Mm³/year x 365.25... check the arithmetic directly.
		const days = 365.25;
		const daily = new Array(Math.round(days)).fill(1_000_000);
		const mar = meanAnnualMm3(daily, Math.round(days));
		expect(mar).toBeCloseTo((1_000_000 * Math.round(days)) / (Math.round(days) / 365.25) / 1e6, 6);
	});

	it('is 0 for an all-zero record and scales linearly with the daily rate', () => {
		expect(meanAnnualMm3(new Array(365).fill(0), 365)).toBe(0);
		const a = meanAnnualMm3(new Array(365).fill(1000), 365);
		const b = meanAnnualMm3(new Array(365).fill(2000), 365);
		expect(b).toBeCloseTo(a * 2, 9);
	});
});

describe('defaultCases', () => {
	it('is flat 0.60, 0.70, 0.85 and the winter preset, every value inside the FAO-56 typical range', () => {
		const cases = defaultCases();
		expect(cases.map((c) => c.label)).toEqual(['flat 0.60', 'flat 0.70', 'flat 0.85', 'winter preset']);
		for (const c of cases) {
			expect(c.panCoefficient, c.label).toHaveLength(12);
			expect(panCoefficientOutOfRange(c.panCoefficient), c.label).toEqual([]);
		}
		const winter = PAN_COEFFICIENT_PRESETS.find((p) => p.id === 'winter-rainfall')!;
		expect(cases[3]!.panCoefficient).toEqual(winter.values);
		// flat 0.70 matches the engine default: refitting at it should show the smallest movement, a useful baseline.
		expect(cases[1]!.panCoefficient.every((v) => v === 0.7)).toBe(true);
	});
});

describe('panSensitivityRefusal (settings.pe, issue #39)', () => {
	it('runs on pan PE, and on a project saved before settings.pe existed', () => {
		expect(panSensitivityRefusal({})).toBeNull();
		expect(panSensitivityRefusal({ pe: { kind: 'pan' } })).toBeNull();
	});

	it('refuses a monthly PE row, saying why, and runCase refuses it before running anything', () => {
		const settings = { ...defaultProjectSettings(), pe: { kind: 'monthly' as const, mm: new Array(12).fill(100) as unknown as ProjectSettings['apanMm'], source: 'ET₀' } };
		expect(panSensitivityRefusal(settings)).toMatch(/monthly PE row.*pan coefficient doesn't reach GR4J/);
		const base = { settings, model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series: {} } as unknown as ModelInput;
		expect(() => runCase(base, defaultCases()[0]!, { seed: 1, starts: 1, budget: 10 })).toThrow(/monthly PE row/);
	});
});

describe('toMarkdown', () => {
	const result = (over: Partial<CaseResult> = {}): CaseResult => ({
		label: 'flat 0.70',
		fixed: { marMm3: 12.3, q95M3s: 0.45, ewrDaysNotMet: 100, ewrFractionDaysNotMet: 0.1, nse: 0.6, kge: 0.55 },
		refit: { marMm3: 12.5, q95M3s: 0.46, ewrDaysNotMet: 90, ewrFractionDaysNotMet: 0.09, nse: 0.7, kge: 0.65, params: { x1: 512.3, x2: 0, x3: 61.5, x4: 2.25 } },
		...over
	});

	it('writes one fixed row and one refit row per case, with the refit parameters and no client data baked in', () => {
		const md = toMarkdown([result()], { file: '<file>', seed: 1, starts: 5, generatedAt: '2026-01-01T00:00:00.000Z' });
		expect(md).toContain('| flat 0.70 | fixed | 12.30 | 0.45 | 100 | 10.0 % | 0.60 | 0.55 | – | – | – | – |');
		expect(md).toContain('| flat 0.70 | refit | 12.50 | 0.46 | 90 | 9.0 % | 0.70 | 0.65 | 512.3 | 0.00 | 61.5 | 2.25 |');
		expect(md).toContain('seed 1, 5 starts');
		expect(md).toContain('gitignored');
	});

	it('shows "–" for a missing NSE/KGE (no calibration flow record)', () => {
		const md = toMarkdown([result({ fixed: { ...result().fixed, nse: null, kge: null } })], { file: '<file>', seed: 1, starts: 1, generatedAt: 'x' });
		expect(md).toContain('| flat 0.70 | fixed | 12.30 | 0.45 | 100 | 10.0 % | – | – | – | – | – | – |');
	});
});

// Smoke test against the real client catchment, when present locally (never
// in CI — the data is gitignored and never committed). Structural only: it
// must never assert the catchment's actual figures, per the public-repo rule.
// WBT_CLIENT_CATCHMENT_DIR overrides the path, as in the engine's client-catchment-fixture.ts (docs/run-locally.md);
// that one tests startsWith('/') since it keeps node: imports out of its static graph, here isAbsolute is free.
const cwd = process.cwd();
const override = process.env.WBT_CLIENT_CATCHMENT_DIR;
const dataDir = (override ? [isAbsolute(override) ? override : `${cwd}/${override}`] : ['data/client-catchment', '../data/client-catchment', '../../data/client-catchment'].map((p) => `${cwd}/${p}`))
	.find((p) => existsSync(`${p}/project.json`));

describe.skipIf(!dataDir)('runCase (needs data/client-catchment, local only)', () => {
	if (!dataDir) {
		it('needs data/client-catchment', () => {});
		return;
	}
	it('runs end to end and produces finite, plausible metrics — never asserting the catchment’s actual figures', async () => {
		const base = await loadModelInput(`${dataDir}/project.json`);
		const flat70 = { label: 'flat 0.70', panCoefficient: new Array(12).fill(0.7) };
		// Tiny budget: this only checks the pipeline runs and shapes its output, not the fit quality.
		const r = runCase(base, flat70, { seed: 1, starts: 1, budget: 20 });
		for (const m of [r.fixed, r.refit]) {
			expect(m.marMm3).toBeGreaterThan(0);
			expect(Number.isFinite(m.marMm3)).toBe(true);
			expect(m.q95M3s).toBeGreaterThanOrEqual(0);
			expect(m.ewrDaysNotMet).toBeGreaterThanOrEqual(0);
			expect(m.ewrFractionDaysNotMet).toBeGreaterThanOrEqual(0);
			expect(m.ewrFractionDaysNotMet).toBeLessThanOrEqual(1);
		}
		for (const key of ['x1', 'x2', 'x3', 'x4']) expect(Number.isFinite(r.refit.params[key])).toBe(true);
		// Reading against the logger, as asked: some scored days, and metric type is a plausible R²-like scale.
		if (r.fixed.nse !== null) expect(r.fixed.nse).toBeLessThanOrEqual(1);
		if (r.fixed.kge !== null) expect(r.fixed.kge).toBeLessThanOrEqual(1);
	}, 120_000);
});

describe('intOption (the --seed, --starts and --budget of pan-sensitivity and fit-sweep)', () => {
	it('takes a whole number in range, 0 included, and the fallback only when the option is absent', () => {
		expect(intOption('seed', '0', 1, 0, 10)).toBe(0);
		expect(intOption('starts', '3', 5, 1, 10)).toBe(3);
		expect(intOption('seed', undefined, 1, 0, 10)).toBe(1);
		expect(intOption('budget', undefined, undefined, 1, 10)).toBeUndefined();
	});

	it('refuses a typo, an empty value, a fraction and an out-of-range number instead of fitting with NaN', () => {
		for (const raw of ['abc', '', ' ', '2.5', '0', '11', '1e9'])
			expect(() => intOption('starts', raw, 5, 1, 10), raw).toThrow(/^--starts must be a whole number from 1 to 10/);
	});
});
