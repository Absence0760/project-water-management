// Monthly lake-factor presets for dam evaporation (docs/model.md §2.7a item 4,
// docs/followups.md § Dam storage). Pure data plus one fill function, shared
// by the Settings form and anything server-side that wants the same numbers.
//
// The engine's dam evaporation is `lakeEvapFactor[month] × A-pan` (A-pan is
// settings.apanMm, or the daily A-pan series). South Africa's published lake
// factors are ratios to the **Symons S-pan**, not the Class-A pan, so a WR90
// preset has to convert:
//
//   lake evaporation = f_lake[m] × S[m]                         (WR90 lake factors)
//   S[m]             = a × A[m] + c   (mm/month)                 (a monthly S-pan ← A-pan regression)
//   ⇒ factor × A-pan  = f_lake[m] × (a + c / A[m])               (c < 0, so the factor falls in winter)
//
// The conversion is affine, not a ratio, so the A-pan factor depends on the
// month's A-pan depth: the preset is computed at the project's own monthly
// A-pan and written as 12 ordinary, editable values.
//
// Sources (the WR90 volume itself, Midgley, Pitman & Middleton 1994, WRC
// Report 298/1/94, isn't online; both tables below are quoted from a thesis
// that reproduces them and tests them against station data):
// - Taljaard, C.M.L. (2023). A revision of evaporation and pan factors in use
//   in South Africa. MEng thesis, Stellenbosch University (supervisor
//   J.A. du Plessis). http://hdl.handle.net/10019.1/127336
//   - Table 2-3, "Open water pan factors – Symons Pan (redrawn from Midgley et
//     al., 1994)": Oct–Sep 0.81 0.82 0.83 0.84 0.88 0.88 0.88 0.87 0.85 0.83
//     0.81 0.81. §5.3.5: dam-balance checks at three SA reservoirs found only
//     slight differences, "the existing pan coefficients currently in use are
//     still accurate enough to be used for hydrological calculations".
//   - Equation (16) / Table 5-9, "Old general equations – monthly" (Midgley et
//     al. 1994): S = −16.2354 + 0.8793 × A. "These equations can only be used
//     as written and cannot be inverted" (§2.6.1.4).
//   - Equation (33) / Table 5-10, "New general equations – monthly" (fitted
//     to 10 SA stations' paired pans): S = −11.1745 + 0.8706 × A, which §5.2.5
//     suggests for estimating monthly pan evaporation.
// - Linsley, R.K., Kohler, M.A. & Paulhus, J.L.H. (1982). Hydrology for
//   Engineers, 3rd ed.: open water ≈ 0.7–0.8 × Class-A pan (the engine's flat
//   default, 0.75, docs/engine-audit.md N2).

import type { Monthly } from '../calendar';
import { DEFAULT_LAKE_EVAP_FACTOR, PE_SOURCE_MAX } from '../project';

/** WR90 open-water (lake) evaporation ÷ Symons S-pan, water-year order Oct–Sep (Midgley et al. 1994, via Taljaard 2023 Table 2-3). */
export const WR90_LAKE_FACTORS_SPAN: Monthly = [0.81, 0.82, 0.83, 0.84, 0.88, 0.88, 0.88, 0.87, 0.85, 0.83, 0.81, 0.81];

/** A monthly S-pan ← A-pan regression, S = slope × A + intercept (mm/month). */
export interface PanConversion {
	slope: number;
	interceptMm: number;
	/** Where the equation comes from, as a note can quote it. */
	citation: string;
}

/** The two published general monthly S-pan ← A-pan equations for South Africa. */
export const SPAN_FROM_APAN = {
	wr90: {
		slope: 0.8793,
		interceptMm: -16.2354,
		citation: 'WR90 monthly equation S = 0.8793 A − 16.2354 mm (Midgley et al. 1994, as in Taljaard 2023 Table 5-9)'
	},
	taljaard2023: {
		slope: 0.8706,
		interceptMm: -11.1745,
		citation: 'Taljaard (2023) new general monthly equation S = 0.8706 A − 11.1745 mm (Table 5-10, Eq. 33)'
	}
} as const satisfies Record<string, PanConversion>;

export type LakeFactorPresetId = 'flat-0.75' | 'wr90' | 'wr90-taljaard2023';

export interface LakeFactorPreset {
	id: LakeFactorPresetId;
	label: string;
	/** The lake factors' source (for a WR90 preset: ratios to S-pan). */
	citation: string;
	/** How the factors are put on an A-pan basis; null = they already are. */
	conversion: PanConversion | null;
	/** What a user should know before relying on it. */
	caveats: string[];
}

const WR90_CAVEATS = [
	'WR90 lake factors are national monthly values for large reservoirs; a shallow farm dam heats and cools faster, so its seasonal lag is smaller than they assume.',
	'The pan conversion is a regression fitted to paired S- and A-pans; station-specific equations differ from it (Taljaard 2023 Tables 5-8 and 5-11).',
	'The factors are computed at the monthly A-pan means: fill again after changing the A-pan. With a daily A-pan series they multiply each day’s value, so a month whose daily total differs from its mean gets a proportionally scaled loss, not the exact regression.'
];

/** The presets, in the order a form offers them. */
export const LAKE_FACTOR_PRESETS: readonly LakeFactorPreset[] = [
	{
		id: 'flat-0.75',
		label: 'Flat 0.75 × A-pan (the default)',
		citation: 'open water ≈ 0.7–0.8 × Class-A pan (Linsley, Kohler & Paulhus 1982)',
		conversion: null,
		caveats: ['One factor all year: no seasonal lag of open water behind the pan. Twelve equal values run exactly as the single factor.']
	},
	{
		id: 'wr90',
		label: 'WR90 lake factors, WR90 pan conversion',
		citation: 'WR90 monthly lake factors ÷ S-pan (Midgley, Pitman & Middleton 1994, WRC 298/1/94, as in Taljaard 2023 Table 2-3)',
		conversion: SPAN_FROM_APAN.wr90,
		caveats: WR90_CAVEATS
	},
	{
		id: 'wr90-taljaard2023',
		label: 'WR90 lake factors, Taljaard (2023) pan conversion',
		citation: 'WR90 monthly lake factors ÷ S-pan (Midgley, Pitman & Middleton 1994, WRC 298/1/94, as in Taljaard 2023 Table 2-3)',
		conversion: SPAN_FROM_APAN.taljaard2023,
		caveats: WR90_CAVEATS
	}
];

/** Factors are written rounded to this many decimals (what the form shows). */
export const LAKE_FACTOR_PRESET_DECIMALS = 3;

export type LakeFactorPresetFill = { ok: true; values: number[]; note: string } | { ok: false; reason: string };

const round = (x: number) => {
	const p = 10 ** LAKE_FACTOR_PRESET_DECIMALS;
	return Math.round(x * p) / p;
};

/** The A-pan factor for one month: f_lake × S(A) ÷ A, 0 where the regression gives no S-pan. */
function convertedFactor(fLake: number, apan: number, c: PanConversion): number {
	const s = c.slope * apan + c.interceptMm;
	return s > 0 ? round((fLake * s) / apan) : 0;
}

/**
 * The 12 monthly factors (× A-pan, water-year order) and the source note a
 * preset fills, at the project's monthly A-pan (mm/month, Oct–Sep). A WR90
 * preset needs every month's A-pan above 0: the conversion depends on it, and
 * a project whose A-pan isn't entered yet (all 0) would get meaningless values.
 */
export function lakeFactorPresetFill(id: string, apanMm: readonly number[]): LakeFactorPresetFill {
	const preset = LAKE_FACTOR_PRESETS.find((p) => p.id === id);
	if (!preset) return { ok: false, reason: `unknown lake-factor preset "${id}"` };
	const c = preset.conversion;
	if (!c) {
		return { ok: true, values: new Array(12).fill(DEFAULT_LAKE_EVAP_FACTOR), note: `${preset.label} preset: ${preset.citation}.`.slice(0, PE_SOURCE_MAX) };
	}
	const bad = Array.from({ length: 12 }, (_, m) => m).filter((m) => !(Number.isFinite(apanMm[m]) && apanMm[m]! > 0));
	if (apanMm.length !== 12 || bad.length) {
		return { ok: false, reason: 'enter the monthly A-pan first: the WR90 factors are converted to an A-pan basis at each month’s A-pan' };
	}
	const values = WR90_LAKE_FACTORS_SPAN.map((f, m) => convertedFactor(f, apanMm[m]!, c));
	const apanText = apanMm.map((a) => String(Math.round(a * 10) / 10)).join(' ');
	const note = `${preset.label} preset: ${preset.citation} × ${c.citation}, at this project's A-pan (Oct–Sep, mm: ${apanText}).`;
	return { ok: true, values, note: note.slice(0, PE_SOURCE_MAX) };
}

/**
 * The preset a source note names (it starts with `<label> preset:`), or null.
 * Lets a form say when the values no longer match what that preset gives at
 * the current A-pan (the A-pan or a value changed after the fill).
 */
export function lakeFactorPresetNamed(source: string | null | undefined): LakeFactorPreset | null {
	if (!source) return null;
	return LAKE_FACTOR_PRESETS.find((p) => source.startsWith(`${p.label} preset:`)) ?? null;
}

/**
 * True when the source note names a preset but the monthly factors are not
 * what that preset gives at `apanMm` now (none set counts as not matching,
 * except for the flat preset against a single factor of 0.75).
 */
export function lakeFactorPresetStale(s: {
	lakeEvapFactor: number;
	lakeEvapFactorMonthly?: readonly number[] | null;
	lakeEvapFactorSource?: string | null;
	apanMm: readonly number[];
}): boolean {
	const preset = lakeFactorPresetNamed(s.lakeEvapFactorSource);
	if (!preset) return false;
	const fill = lakeFactorPresetFill(preset.id, s.apanMm);
	if (!fill.ok) return true;
	const k = s.lakeEvapFactorMonthly ?? new Array(12).fill(s.lakeEvapFactor);
	return fill.values.some((v, m) => Math.abs(v - (k[m] ?? Number.NaN)) > 1e-9);
}
