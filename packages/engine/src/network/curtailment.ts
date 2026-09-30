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
// From engine 1.38.0 (issue #123) a unit's basic-needs floor bounds the volume
// left from below (docs/model.md §2.7f, §2.11).
import type { CurtailmentFarm, CurtailmentSummary, CurtailmentUser, EwrSiteSummary } from '../project';

/** m³/day → l/s: 1 m³/day = 1000 l / 86 400 s. The workbook divides by 86.4. */
export const M3_PER_DAY_PER_LS = 86.4;

/**
 * The fixed footnote of the curtailment table, in the UI and the summary CSV
 * (audit Q11, engine ≥ 0.17.0): the equitable share is a fairness benchmark,
 * never an allocation. A network-aware allocation based on authorisations is
 * future work (docs/model.md §2.11).
 */
export const EQUITABLE_SHARE_FOOTNOTE =
	'Fairness benchmark only: assumes water can move freely between farms, and ignores network position, storage, licensed or registered volumes and existing lawful use. Not an allocation or licence condition.';

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
	/** Irrigation abstraction demand, m³/day [demand] — D = F / e (engine ≥ 0.16.0; the workbook uses F). */
	demand: ArrayLike<number>;
	/** Irrigation supplied, m³/day [supplied] — Element sheet G. */
	supplied: ArrayLike<number>;
	/** The farm's EWR charge, m³/day, ≤ 0 [ewr_charge] (engine ≥ 0.17.0, audit Q17). */
	ewrCharge: ArrayLike<number>;
	/** The part of the charge met by irrigating less, ≤ 0 [ewr_charge_irrigation]. Absent = all of it. */
	ewrChargeIrrigation?: ArrayLike<number>;
	/** k = 1 − β(1 − e): consumptive use per m³ supplied (audit N1). Absent = 1. */
	consumptivePerSupplied?: number;
	/**
	 * What the unit returned below it each day, m³/day [return_flow], for a
	 * unit with demand objects (engine ≥ 1.7.0), whose k varies with how its
	 * supply splits between crops and objects: k is then the window's
	 * (Σ supplied − Σ returned) ÷ Σ supplied, or consumptivePerSupplied when
	 * nothing was supplied. Absent = consumptivePerSupplied.
	 */
	returned?: ArrayLike<number>;
	/** The EWR site that bound the charge over the window (./attribution.ts bindingSite); null = not charged. */
	ewrBindingSiteId?: string | null;
	/**
	 * The unit's basic-needs floor each day, m³/day [basic_needs] (engine ≥
	 * 1.38.0, issue #123): the volume left never goes below its window mean.
	 * Absent = no floor (a unit without a domestic or municipal object with people).
	 */
	basicNeeds?: ArrayLike<number>;
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
	/** 'ruleTable' when the site's shortfall follows its Reserve rule table (engine ≥ 1.3.0, settings.ewrChargeSource); absent = the pragmatic EWR. */
	ewrSource?: 'ruleTable';
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
 * A farm's consumptive use per m³ supplied over the window: its constant k,
 * or with a daily `returned` (a unit with demand objects) the window's
 * 1 − Σ returned ÷ Σ supplied, clamped to (0, 1]. Exported for the checks.
 */
export function windowConsumptiveShare(f: Pick<CurtailmentInput, 'consumptivePerSupplied' | 'returned' | 'supplied'>, from: number, to: number): number {
	const k0 = f.consumptivePerSupplied ?? 1;
	if (!f.returned) return k0;
	let g = 0;
	let r = 0;
	for (let t = from; t <= to; t++) {
		g += f.supplied[t]!;
		r += f.returned[t]!;
	}
	if (!(g > 0)) return k0;
	const k = 1 - r / g;
	// Every return share is ≤ 1, so k ≥ 0; one that returns everything consumes nothing and can't be cut for the EWR.
	return k > 0 ? Math.min(k, 1) : k0;
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
		const k = windowConsumptiveShare(f, from, to);
		const cut = nz(Rirr / k);
		// Engine ≥ 0.17.0 (audit Q13): the total change and the volume left count
		// only what irrigation can deliver, the supply cut; the storage part of the
		// charge is a store-less / pass-inflow condition, shown on its own. The
		// volume left never goes below 0, and a cut beyond the equitable share is
		// flagged instead.
		// Engine ≥ 1.38.0 (issue #123): a restriction never cuts the unit's domestic
		// and municipal objects below their basic-needs floor B, so the volume left
		// is at least B and the total change no deeper than B − I; what the floor
		// holds back of the cut is reported, not dropped.
		const B = f.basicNeeds ? nz(windowMean(f.basicNeeds, from, to)) : null;
		const U0 = Math.max(M + cut, 0);
		const S = nz(B === null ? N + cut : Math.max(N + cut, B - I));
		const U = nz(B === null ? U0 : Math.max(U0, B));
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
			ewrCutBeyondShareM3Day: beyond,
			...(B === null ? {} : { basicNeedsM3Day: B, basicNeedsHeldM3Day: nz(U - U0) })
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
			naturalM3Day: nz(windowMean(s.natural, from, to)),
			...(s.ewrSource ? { ewrSource: s.ewrSource } : {})
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
			volumeLeftM3Day: sum('volumeLeftM3Day'),
			...(rows.some((r) => r.basicNeedsM3Day !== undefined)
				? { basicNeedsM3Day: nz(rows.reduce((s, r) => s + (r.basicNeedsM3Day ?? 0), 0)), basicNeedsHeldM3Day: nz(rows.reduce((s, r) => s + (r.basicNeedsHeldM3Day ?? 0), 0)) }
				: {})
		}
	};
}

/** An other water user's daily series (WP-1.33). */
export interface CurtailmentUserInput {
	nodeId: string;
	name: string;
	senior: boolean;
	demand: ArrayLike<number>;
	supplied: ArrayLike<number>;
	returned: ArrayLike<number>;
	/** ≤ 0. */
	ewrCharge: ArrayLike<number>;
	/** k = 1 − return share. */
	consumptivePerSupplied: number;
}

/**
 * The other water users' rows (engine ≥ 0.22.0, WP-1.33, docs/model.md §2.11):
 * window means; a junior user's supply cut −ΔG = MAX(charge ÷ k, −supplied)
 * (k = 1 − return share: cutting ΔG removes k·ΔG of use), what the cut can't
 * remove left standing; a senior user is not curtailed, so all of its charge
 * stands.
 */
export function otherUserCurtailment(users: CurtailmentUserInput[], window: ReportWindow): CurtailmentUser[] {
	const { from, to } = window;
	return users.map((u) => {
		const H = nz(windowMean(u.demand, from, to));
		const I = nz(windowMean(u.supplied, from, to));
		const R = nz(windowMean(u.ewrCharge, from, to));
		const k = u.consumptivePerSupplied;
		const cut = u.senior || !(k > 0) ? 0 : nz(Math.max(R / k, -I));
		return {
			nodeId: u.nodeId,
			name: u.name,
			priority: u.senior ? 'senior' : 'junior',
			demandM3Day: H,
			suppliedM3Day: I,
			deficitM3Day: nz(I - H),
			fractionSupplied: H === 0 ? null : I / H,
			returnedM3Day: nz(windowMean(u.returned, from, to)),
			ewrChargeM3Day: R,
			curtailed: !u.senior,
			supplyCutM3Day: cut,
			supplyCutLs: nz(cut / M3_PER_DAY_PER_LS),
			uncurtailedChargeM3Day: nz(Math.min(0, R - cut * k))
		};
	});
}
