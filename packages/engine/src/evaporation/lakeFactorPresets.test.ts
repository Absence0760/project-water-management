import { describe, expect, it } from 'vitest';
import { defaultProjectSettings, DEFAULT_LAKE_EVAP_FACTOR, PE_SOURCE_MAX, type ModelInput, type NetworkNode } from '../project';
import { runModelWith } from '../run';
import { prepareRun } from '../prepare';
import { sameOutput } from '../testing/invariants';
import { diffInputs } from '../compare';
import {
	LAKE_FACTOR_PRESETS,
	lakeFactorPresetFill,
	lakeFactorPresetNamed,
	lakeFactorPresetStale,
	panConversionFloorMm,
	SPAN_FROM_APAN,
	WR90_LAKE_FACTORS_SPAN
} from './lakeFactorPresets';

// A Western Cape-like A-pan, Oct–Sep (mm/month), as network/dam.test.ts uses.
const APAN = [180, 230, 270, 285, 245, 210, 140, 90, 60, 65, 90, 130];

describe('WR90 lake factors and pan conversions (the transcribed tables)', () => {
	it('keeps Taljaard (2023) Table 2-3 as printed, Oct–Sep', () => {
		// "Open water pan factors – Symons Pan (redrawn from Midgley et al., 1994)".
		expect([...WR90_LAKE_FACTORS_SPAN]).toEqual([0.81, 0.82, 0.83, 0.84, 0.88, 0.88, 0.88, 0.87, 0.85, 0.83, 0.81, 0.81]);
	});

	it('keeps the two general monthly A-pan → S-pan equations as printed (Tables 5-9 and 5-10)', () => {
		expect(SPAN_FROM_APAN.wr90).toMatchObject({ slope: 0.8793, interceptMm: -16.2354 });
		expect(SPAN_FROM_APAN.taljaard2023).toMatchObject({ slope: 0.8706, interceptMm: -11.1745 });
	});
});

describe('LAKE_FACTOR_PRESETS', () => {
	it('offers the flat default and the two WR90 conversions, each with a citation and caveats', () => {
		expect(LAKE_FACTOR_PRESETS.map((p) => p.id)).toEqual(['flat-0.75', 'wr90', 'wr90-taljaard2023']);
		for (const p of LAKE_FACTOR_PRESETS) {
			expect(p.label.trim(), p.id).not.toBe('');
			expect(p.citation, p.id).toMatch(/\d{4}/);
			expect(p.caveats.length, p.id).toBeGreaterThan(0);
			if (p.conversion) expect(p.conversion.citation, p.id).toMatch(/S = .* A/);
		}
		// Labels are unique: a source note names its preset by label.
		expect(new Set(LAKE_FACTOR_PRESETS.map((p) => p.label)).size).toBe(LAKE_FACTOR_PRESETS.length);
	});

	it('fills 12 values within physical bounds and a source note under the length cap, for every preset', () => {
		for (const apan of [APAN, new Array(12).fill(56), new Array(12).fill(400)]) {
			for (const p of LAKE_FACTOR_PRESETS) {
				const f = lakeFactorPresetFill(p.id, apan);
				expect(f.ok, p.id).toBe(true);
				if (!f.ok) continue;
				expect(f.values, p.id).toHaveLength(12);
				// The API's range is 0–2; open water never evaporates more than the A-pan beside it here.
				for (const v of f.values) {
					expect(v, p.id).toBeGreaterThanOrEqual(0);
					expect(v, p.id).toBeLessThanOrEqual(1);
				}
				expect(f.note.startsWith(`${p.label} preset:`), p.id).toBe(true);
				expect(f.note.length, p.id).toBeLessThanOrEqual(PE_SOURCE_MAX);
			}
		}
	});

	it('the flat preset is the default factor in every month, whatever the A-pan', () => {
		const f = lakeFactorPresetFill('flat-0.75', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		expect(f).toMatchObject({ ok: true, values: new Array(12).fill(DEFAULT_LAKE_EVAP_FACTOR) });
		expect(defaultProjectSettings().lakeEvapFactor).toBe(DEFAULT_LAKE_EVAP_FACTOR);
	});

	it('converts the WR90 S-pan factors at each month’s A-pan: f_lake × (0.8793 A − 16.2354) ÷ A, to 3 decimals', () => {
		const f = lakeFactorPresetFill('wr90', APAN);
		if (!f.ok) throw new Error(f.reason);
		// January (index 3): 0.84 × (0.8793 × 285 − 16.2354) ÷ 285 = 0.84 × 0.82234 = 0.6908.
		expect(f.values[3]).toBe(0.691);
		// June (index 8): 0.85 × (0.8793 × 60 − 16.2354) ÷ 60 = 0.85 × 0.60871 = 0.5174.
		expect(f.values[8]).toBe(0.517);
		for (let m = 0; m < 12; m++) {
			const exact = (WR90_LAKE_FACTORS_SPAN[m]! * (0.8793 * APAN[m]! - 16.2354)) / APAN[m]!;
			expect(Math.abs(f.values[m]! - exact)).toBeLessThanOrEqual(0.0005);
		}
		// The winter factor sits well below the summer one: the regression's negative intercept (issue #46's 0.5–0.6 in winter).
		expect(f.values[8]!).toBeLessThan(f.values[3]!);
		// The annual A-pan-weighted factor (evaporation ÷ A-pan over the year) lands near issue #46's ~0.67.
		const annual = f.values.reduce((t, k, m) => t + k * APAN[m]!, 0) / APAN.reduce((t, a) => t + a, 0);
		expect(annual).toBeGreaterThan(0.63);
		expect(annual).toBeLessThan(0.7);
		expect(f.note).toContain('0.8793');
		expect(f.note).toContain('180 230 270 285');
	});

	it('the Taljaard (2023) conversion uses its own equation', () => {
		const f = lakeFactorPresetFill('wr90-taljaard2023', APAN);
		if (!f.ok) throw new Error(f.reason);
		expect(f.values[3]).toBe(Math.round(((0.84 * (0.8706 * 285 - 11.1745)) / 285) * 1000) / 1000);
		expect(f.note).toContain('0.8706');
	});

	it('refuses a month below the conversion’s floor (intercept over a third of slope × A), naming it, and a month without A-pan', () => {
		expect(panConversionFloorMm(SPAN_FROM_APAN.wr90)).toBeCloseTo(55.39, 2);
		expect(panConversionFloorMm(SPAN_FROM_APAN.taljaard2023)).toBeCloseTo(38.51, 2);
		const low = [...APAN];
		low[8] = 50; // Jun: under WR90's 55.4 mm floor, over Taljaard's 38.5 mm
		expect(lakeFactorPresetFill('wr90', low)).toMatchObject({ ok: false, reason: /A-pan in Jun is below 55\.4 mm/ });
		expect(lakeFactorPresetFill('wr90-taljaard2023', low).ok).toBe(true);
		// The flat preset needs no conversion, so no floor.
		expect(lakeFactorPresetFill('flat-0.75', low).ok).toBe(true);
		// At the floor the factor is f_lake × ⅔ × slope, well above 0.
		const atFloor = lakeFactorPresetFill('wr90', new Array(12).fill(panConversionFloorMm(SPAN_FROM_APAN.wr90)));
		expect(atFloor.ok && Math.min(...atFloor.values)).toBeGreaterThan(0.45);
		expect(lakeFactorPresetFill('wr90', new Array(12).fill(0))).toMatchObject({ ok: false, reason: /A-pan first/ });
		const gap = [...APAN];
		gap[5] = Number.NaN;
		expect(lakeFactorPresetFill('wr90', gap).ok).toBe(false);
		expect(lakeFactorPresetFill('wr90', APAN.slice(0, 11)).ok).toBe(false);
		expect(lakeFactorPresetFill('nope', APAN)).toMatchObject({ ok: false, reason: /unknown/ });
	});
});

describe('lakeFactorPresetNamed / lakeFactorPresetStale', () => {
	const filled = (id: string) => {
		const f = lakeFactorPresetFill(id, APAN);
		if (!f.ok) throw new Error(f.reason);
		return { lakeEvapFactor: 0.75, lakeEvapFactorMonthly: f.values, lakeEvapFactorSource: f.note, apanMm: APAN };
	};

	it('names the preset a note starts with, and nothing for a hand-written note', () => {
		expect(lakeFactorPresetNamed(filled('wr90').lakeEvapFactorSource)?.id).toBe('wr90');
		expect(lakeFactorPresetNamed('site study, 2019')).toBeNull();
		expect(lakeFactorPresetNamed('')).toBeNull();
		expect(lakeFactorPresetNamed(undefined)).toBeNull();
	});

	it('is fresh straight after a fill, stale after the A-pan or a value changes', () => {
		for (const p of LAKE_FACTOR_PRESETS) expect(lakeFactorPresetStale(filled(p.id)), p.id).toBe(false);
		const s = filled('wr90');
		expect(lakeFactorPresetStale({ ...s, apanMm: APAN.map((a) => a + 10) })).toBe(true);
		expect(lakeFactorPresetStale({ ...s, lakeEvapFactorMonthly: s.lakeEvapFactorMonthly.map((v, m) => (m === 0 ? v + 0.01 : v)) })).toBe(true);
		expect(lakeFactorPresetStale({ ...s, lakeEvapFactorSource: 'my own values' })).toBe(false);
		// The flat preset against a single factor of 0.75 (monthly unticked) still matches.
		expect(lakeFactorPresetStale({ ...filled('flat-0.75'), lakeEvapFactorMonthly: null })).toBe(false);
		expect(lakeFactorPresetStale({ ...filled('flat-0.75'), lakeEvapFactorMonthly: null, lakeEvapFactor: 0.7 })).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// No default changes: a run is bit-identical with or without the new setting,
// and a preset's values run exactly as typed-in factors.
// ---------------------------------------------------------------------------

function node(id: string, kind: NetworkNode['kind'], down: string | null, over: Partial<NetworkNode> = {}): NetworkNode {
	return {
		id,
		name: id,
		kind,
		downstreamNodeId: down,
		sortOrder: 0,
		areaKm2: kind === 'farm' ? 1 : 0,
		areaHiKm2: 0,
		areaLoKm2: 0,
		flowShareManual: null,
		pctUpstreamToDam: 1,
		pctRunoffToDam: 1,
		damCapacityM3: 0,
		damInitialPct: 0,
		damMinPct: 0,
		divertCapacityM3Day: 0,
		irrigationEfficiency: 1,
		returnFlowFraction: 0,
		damAreaFullM2: 0,
		damAreaExponent: 0.7,
		damSeepagePerDay: 0,
		...over
	};
}

function input(settings: ModelInput['settings'] = {}, days = 400): ModelInput {
	return {
		settings: { apanMm: APAN as never, ...settings },
		model: {
			nodes: [node('G', 'gauge', null), node('A', 'farm', 'G', { damCapacityM3: 100_000, damInitialPct: 0.8, damAreaFullM2: 30_000 })],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: '2021-01-01', values: Array.from({ length: days }, (_, i) => (i % 9 === 0 ? 6 : 0)) } }
	};
}

const run = (i: ModelInput) => runModelWith(i, () => ({ naturalFlowM3Day: new Array(400).fill(500) }));
const evap = (o: ReturnType<typeof run>) => o.series.find((s) => s.nodeId === 'A' && s.key === 'dam_evaporation')!.values;

describe('runs (no default changes)', () => {
	it('a source note changes no result: the run is bit-identical to one without it', () => {
		const base = run(input());
		const noted = run(input({ lakeEvapFactorSource: 'WR90 lake factors, WR90 pan conversion preset: …' }));
		expect(sameOutput(base, noted)).toBe(true);
		expect(evap(base).some((v) => v > 0)).toBe(true);
	});

	it('the note is kept as text, capped at the source limit, and anything else reads as none, with no warning', () => {
		const prep = (v: unknown) => prepareRun(input({ lakeEvapFactorSource: v as never }));
		expect(prep('site study').settings.lakeEvapFactorSource).toBe('site study');
		expect(prep('x'.repeat(PE_SOURCE_MAX + 50)).settings.lakeEvapFactorSource).toBe('x'.repeat(PE_SOURCE_MAX));
		expect(prep(42).settings.lakeEvapFactorSource).toBe('');
		expect(prep(undefined).settings.lakeEvapFactorSource).toBe('');
		expect(prep(42).warnings).toEqual(prep(undefined).warnings);
		// A long note still changes no result.
		expect(sameOutput(run(input()), run(input({ lakeEvapFactorSource: 'x'.repeat(PE_SOURCE_MAX + 50) })))).toBe(true);
	});

	it('the default settings keep one factor of 0.75 and no monthly row or note', () => {
		const d = defaultProjectSettings();
		expect(d.lakeEvapFactorMonthly).toBeNull();
		expect(d.lakeEvapFactorSource).toBe('');
	});

	it('the flat preset runs exactly as the single default factor', () => {
		const f = lakeFactorPresetFill('flat-0.75', APAN);
		if (!f.ok) throw new Error(f.reason);
		expect(sameOutput(run(input()), run(input({ lakeEvapFactorMonthly: f.values as never, lakeEvapFactorSource: f.note })))).toBe(true);
	});

	it('a WR90 preset evaporates each month’s f_lake × S-pan ÷ days, to the rounding of the factor', () => {
		const f = lakeFactorPresetFill('wr90', APAN);
		if (!f.ok) throw new Error(f.reason);
		const o = run(input({ lakeEvapFactorMonthly: f.values as never, lakeEvapFactorSource: f.note }));
		const base = run(input());
		// Less than the flat 0.75 in every month (every converted factor is below it).
		expect(evap(o).reduce((t, v) => t + v, 0)).toBeLessThan(evap(base).reduce((t, v) => t + v, 0));
		// 1 January 2021, the first day: the same dam 80 % full in both runs, so the same surface; the depth is 0.691 × 285 ÷ 31 mm against 0.75 × 285 ÷ 31.
		expect(evap(o)[0]! / evap(base)[0]!).toBeCloseTo(0.691 / 0.75, 6);
		// The source note is recorded in the run's inputs and shows as its own line in a comparison.
		const model = input().model;
		const series = { rain_catchment_mm: { startDate: '2021-01-01', length: 400 } };
		const snap = (s: Record<string, unknown>) => ({ settings: { ...defaultProjectSettings(), ...s }, model, series }) as never;
		expect(diffInputs(snap({}), snap({ lakeEvapFactorSource: f.note })).map((c) => c.subject)).toEqual(['Dam evaporation factor source']);
		// A run saved before the setting (no key) compares as having none.
		const old = { ...defaultProjectSettings() } as Record<string, unknown>;
		delete old.lakeEvapFactorSource;
		expect(diffInputs({ settings: old, model, series } as never, snap({}))).toEqual([]);
	});
});
