// Curtailment targets per farm — the b023 [Shortfalls] sheet.
//
// Over a reporting window, each farm's average demand and supply are compared
// with an *equitable* share of the water the catchment actually supplied:
// every farm gets the same fraction of its demand (Σ supplied / Σ demand).
// The difference is how much it must reduce (−) or may gain (+). Adding the
// farm's average incremental EWR shortfall gives the total change needed so
// irrigation is balanced *and* the EWR is met. Column letters are the
// client-catchment and blank [Shortfalls] columns; see docs/model.md §2.11 for the cell
// formulas and the quirks this mirrors. Unlike the sheet nothing is rounded
// or truncated (docs/engine-audit.md R1, Q14, Q15): the UI rounds for display.
import type { CurtailmentFarm, CurtailmentSummary } from '../project';

/** m³/day → l/s: 1 m³/day = 1000 l / 86 400 s. The workbook divides by 86.4. */
export const M3_PER_DAY_PER_LS = 86.4;

/** Daily farm series the report needs (engine RunSeries keys in brackets). */
export interface CurtailmentInput {
	nodeId: string;
	name: string;
	/** Net irrigation demand, m³/day [demand] — Element sheet F. */
	demand: ArrayLike<number>;
	/** Irrigation supplied, m³/day [supplied] — Element sheet G. */
	supplied: ArrayLike<number>;
	/** Incremental EWR shortfall, m³/day, ≤ 0 [ewr_shortfall_incremental] — Element sheet AB. */
	ewrShortfallIncremental: ArrayLike<number>;
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
export function computeCurtailment(farms: CurtailmentInput[], window: ReportWindow): CurtailmentSummary {
	const { from, to } = window;
	if (!(to >= from)) throw new Error(`report window is empty (${window.reportStart} … ${window.reportEnd})`);

	// H, I, R: AVERAGE over the window (the sheet then ROUNDs to 0 dp).
	const base = farms.map((f) => ({
		f,
		H: nz(windowMean(f.demand, from, to)),
		I: nz(windowMean(f.supplied, from, to)),
		R: nz(windowMean(f.ewrShortfallIncremental, from, to))
	}));
	const sumH = base.reduce((s, b) => s + b.H, 0);
	const sumI = base.reduce((s, b) => s + b.I, 0);
	// K total = Σ supplied / Σ demand (the sheet divides its rounded averages, unguarded: #DIV/0! at 0).
	const equitable = sumH === 0 ? null : sumI / sumH;

	const rows: CurtailmentFarm[] = base.map(({ f, H, I, R }) => {
		// With no demand anywhere, every H is 0 and so is every target.
		const M = equitable === null ? 0 : nz(H * equitable);
		// Target and supply agree whenever the farm already has its equitable
		// share; don't report float cancellation noise (≈1e-16 m³/day) as a cut or gain.
		const N = nz(Math.abs(M - I) <= 1e-12 * Math.max(Math.abs(M), Math.abs(I)) ? 0 : M - I);
		const S = nz(N + R);
		const U = nz(M + R);
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
			fractionOfDemandLeft: H === 0 ? null : U / H
		};
	});

	const sum = (k: keyof CurtailmentFarm) => nz(rows.reduce((s, r) => s + (r[k] as number), 0));
	return {
		reportStart: window.reportStart,
		reportEnd: window.reportEnd,
		days: to - from + 1,
		equitableFraction: equitable,
		farms: rows,
		totals: {
			demandM3Day: sumH,
			suppliedM3Day: sumI,
			deficitM3Day: sum('deficitM3Day'),
			targetM3Day: sum('targetM3Day'),
			reduceGainM3Day: sum('reduceGainM3Day'),
			reduceGainLs: sum('reduceGainLs'),
			ewrShortfallM3Day: sum('ewrShortfallM3Day'),
			totalChangeM3Day: sum('totalChangeM3Day'),
			volumeLeftM3Day: sum('volumeLeftM3Day')
		}
	};
}
