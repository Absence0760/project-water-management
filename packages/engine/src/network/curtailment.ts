// Curtailment targets per farm — the b023 [Shortfalls] sheet.
//
// Over a reporting window, each farm's average demand and supply are compared
// with an *equitable* share of the water the catchment actually supplied:
// every farm gets the same fraction of its demand (Σ supplied / Σ demand).
// The difference is how much it must reduce (−) or may gain (+). Adding the
// farm's average EWR charge (its share of the shortfall at the EWR sites below
// it, ./attribution.ts, audit Q17; engine ≥ 0.17.0, before that the Element
// sheet's incremental shortfall AB) gives the total change needed so
// irrigation is balanced *and* the EWR is met. Column letters are the
// client-catchment and blank [Shortfalls] columns; see docs/model.md §2.11 for the cell
// formulas and the quirks this mirrors. Unlike the sheet nothing is rounded
// or truncated (docs/engine-audit.md R1, Q14, Q15): the UI rounds for display.
import type { CurtailmentFarm, CurtailmentSummary, EwrSiteSummary } from '../project';

/** m³/day → l/s: 1 m³/day = 1000 l / 86 400 s. The workbook divides by 86.4. */
export const M3_PER_DAY_PER_LS = 86.4;

/**
 * Below this average demand (m³/day, ≈ 0.012 l/s, under any meter's
 * resolution) "demand left %" is not meaningful: the UI shows "—" and the CSV
 * notes it (audit Q13, engine ≥ 0.17.0). One constant for the UI and the CSV.
 */
export const DEMAND_PCT_FLOOR_M3_DAY = 1;

/** The CSV's demand_pct_note for a farm's average demand H: why "demand left %" is empty or not meaningful. */
export function demandPctNote(demandM3Day: number): 'no_demand' | 'below_floor' | '' {
	if (!(demandM3Day > 0)) return 'no_demand';
	return demandM3Day < DEMAND_PCT_FLOOR_M3_DAY ? 'below_floor' : '';
}

/** Daily farm series the report needs (engine RunSeries keys in brackets). */
export interface CurtailmentInput {
	nodeId: string;
	name: string;
	/** Net irrigation demand, m³/day [demand] — Element sheet F. */
	demand: ArrayLike<number>;
	/** Irrigation supplied, m³/day [supplied] — Element sheet G. */
	supplied: ArrayLike<number>;
	/** The farm's EWR charge, m³/day, ≤ 0 [ewr_charge] (engine ≥ 0.17.0, audit Q17). */
	ewrCharge: ArrayLike<number>;
	/** The part of the charge met by irrigating less, ≤ 0 [ewr_charge_irrigation]. Absent = all of it. */
	ewrChargeIrrigation?: ArrayLike<number>;
	/** k = 1 − β(1 − e): consumptive use per m³ supplied (audit N1). Absent = 1. */
	consumptivePerSupplied?: number;
	/** The EWR site that bound the charge over the window (./attribution.ts bindingSite); null = not charged. */
	ewrBindingSiteId?: string | null;
}

/** One EWR site's daily series (./attribution.ts), for the per-site table. */
export interface CurtailmentSiteInput {
	nodeId: string;
	name: string;
	isOutlet: boolean;
	farmCount: number;
	/** ≤ 0, the site's shortfall, charged part and natural part (charged + natural = shortfall). */
	shortfall: ArrayLike<number>;
	charged: ArrayLike<number>;
	natural: ArrayLike<number>;
}

export interface ReportWindow {
	/** First and last day index (inclusive) into the run's daily arrays. */
	from: number;
	to: number;
	reportStart: string;
	reportEnd: string;
}

/** -0 → 0, so results serialise and compare cleanly. */
const nz = (x: number) => (x === 0 ? 0 : x);

function windowMean(a: ArrayLike<number>, from: number, to: number): number {
	let s = 0;
	for (let t = from; t <= to; t++) s += a[t]!;
	return s / (to - from + 1);
}

/**
 * The [Shortfalls] table over `window`. Farms come out in the order given
 * (the workbook lists them in [Network] order).
 */
export function computeCurtailment(farms: CurtailmentInput[], window: ReportWindow, sites: CurtailmentSiteInput[] = []): CurtailmentSummary {
	const { from, to } = window;
	if (!(to >= from)) throw new Error(`report window is empty (${window.reportStart} … ${window.reportEnd})`);

	// H, I, R: AVERAGE over the window (the sheet then ROUNDs to 0 dp).
	const base = farms.map((f) => ({
		f,
		H: nz(windowMean(f.demand, from, to)),
		I: nz(windowMean(f.supplied, from, to)),
		R: nz(windowMean(f.ewrCharge, from, to)),
		Rirr: nz(f.ewrChargeIrrigation ? windowMean(f.ewrChargeIrrigation, from, to) : windowMean(f.ewrCharge, from, to))
	}));
	const sumH = base.reduce((s, b) => s + b.H, 0);
	const sumI = base.reduce((s, b) => s + b.I, 0);
	// K total = Σ supplied / Σ demand (the sheet divides its rounded averages, unguarded: #DIV/0! at 0).
	const equitable = sumH === 0 ? null : sumI / sumH;

	const rows: CurtailmentFarm[] = base.map(({ f, H, I, R, Rirr }) => {
		// With no demand anywhere, every H is 0 and so is every target.
		const M = equitable === null ? 0 : nz(H * equitable);
		// Target and supply agree whenever the farm already has its equitable
		// share; don't report float cancellation noise (≈1e-16 m³/day) as a cut or gain.
		const N = nz(Math.abs(M - I) <= 1e-12 * Math.max(Math.abs(M), Math.abs(I)) ? 0 : M - I);
		// The supply cut that removes R_irr of consumptive use: consumptive = G·k,
		// so ΔG = R_irr / k (k = 1 − β(1 − e) ≥ e > 0, audit N1). cut = −ΔG ≤ 0.
		const k = f.consumptivePerSupplied ?? 1;
		const cut = nz(Rirr / k);
		// Engine ≥ 0.17.0 (audit Q13): the total change and the volume left count
		// only what irrigation can deliver, the supply cut; the storage part of the
		// charge is a store-less / pass-inflow condition, shown on its own. The
		// volume left never goes below 0, and a cut beyond the equitable share is
		// flagged instead.
		const S = nz(N + cut);
		const U = nz(Math.max(M + cut, 0));
		const beyond = nz(Math.max(-cut - M, 0));
		return {
			nodeId: f.nodeId,
			name: f.name,
			demandM3Day: H,
			suppliedM3Day: I,
			deficitM3Day: nz(I - H),
			fractionSupplied: H === 0 ? null : I / H,
			targetM3Day: M,
			reduceGainM3Day: N,
			reduceGainLs: nz(N / M3_PER_DAY_PER_LS),
			targetFraction: H === 0 ? null : M / H,
			ewrShortfallM3Day: R,
			totalChangeM3Day: S,
			totalChangeLs: nz(S / M3_PER_DAY_PER_LS),
			volumeLeftM3Day: U,
			fractionOfDemandLeft: H === 0 ? null : U / H,
			ewrChargeIrrigationM3Day: Rirr,
			ewrChargeStorageM3Day: nz(R - Rirr),
			ewrSupplyCutM3Day: cut,
			ewrSupplyCutLs: nz(cut / M3_PER_DAY_PER_LS),
			ewrBindingSiteId: f.ewrBindingSiteId ?? null,
			ewrCutBeyondShareM3Day: beyond
		};
	});

	const ewrSites: EwrSiteSummary[] = sites.map((s) => {
		let notMet = 0;
		for (let t = from; t <= to; t++) if (s.shortfall[t]! < 0) notMet++;
		return {
			nodeId: s.nodeId,
			name: s.name,
			isOutlet: s.isOutlet,
			farmCount: s.farmCount,
			daysNotMet: notMet,
			shortfallM3Day: nz(windowMean(s.shortfall, from, to)),
			chargedM3Day: nz(windowMean(s.charged, from, to)),
			naturalM3Day: nz(windowMean(s.natural, from, to))
		};
	});

	const sum = (k: keyof CurtailmentFarm) => nz(rows.reduce((s, r) => s + (r[k] as number), 0));
	return {
		reportStart: window.reportStart,
		reportEnd: window.reportEnd,
		days: to - from + 1,
		equitableFraction: equitable,
		farms: rows,
		ewrAttribution: 'netImpactProRata',
		ewrSites,
		totals: {
			demandM3Day: sumH,
			suppliedM3Day: sumI,
			deficitM3Day: sum('deficitM3Day'),
			targetM3Day: sum('targetM3Day'),
			reduceGainM3Day: sum('reduceGainM3Day'),
			reduceGainLs: sum('reduceGainLs'),
			ewrShortfallM3Day: sum('ewrShortfallM3Day'),
			ewrChargeIrrigationM3Day: sum('ewrChargeIrrigationM3Day'),
			ewrChargeStorageM3Day: sum('ewrChargeStorageM3Day'),
			ewrSupplyCutM3Day: sum('ewrSupplyCutM3Day'),
			ewrCutBeyondShareM3Day: sum('ewrCutBeyondShareM3Day'),
			totalChangeM3Day: sum('totalChangeM3Day'),
			volumeLeftM3Day: sum('volumeLeftM3Day')
		}
	};
}
