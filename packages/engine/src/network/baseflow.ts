// A unit's base-flow loss and gain (engine 1.86.0, issue #523 B1, #90 R4 (a),
// docs/model.md §2.6b): a fixed daily volume of the unit's own runoff lost to
// groundwater, and a fixed daily volume gained from it, before the runoff
// reaches the river or the unit's dam:
//
//   loss_t = MIN(L, I_t),   I'_t = I_t − loss_t + gain
//
// with I_t the unit's runoff (natural flow × share, less land cover). The
// lost water leaves the catchment, as a reach's bed losses do (./reachLoss.ts);
// none of it comes back unless a gain is set somewhere. The gain comes from
// outside the modelled catchment (a regional aquifer, a spring fed from beyond
// the divide). Both are properties of the land, not of the development, so
// the natural flow a Reserve rule table's site and the WR2012 check read is
// net of them too (routeNatural). 0, the default, is neither: no plan entry,
// no series, so every model without them runs to the bit as before. Pure;
// the plan (../run.ts), the simulation (./simulate.ts) and the self-checks
// (../verify/checks.ts) read a unit through these functions.
import type { NetworkNode } from '../project';
import { waterYearIndex } from '../calendar';

/** The run series a unit with a base-flow loss leaves: what it lost each day. */
export const BASEFLOW_LOSS_SERIES = {
	key: 'baseflow_loss',
	label: 'Base-flow loss (leaves the catchment)',
	unit: 'm³/day'
} as const;

/** The run series a unit with a base-flow gain leaves: what joined its runoff each day. */
export const BASEFLOW_GAIN_SERIES = {
	key: 'baseflow_gain',
	label: 'Base-flow gain (from outside the catchment)',
	unit: 'm³/day'
} as const;

/**
 * A unit's base flow as the simulation runs it, m³/day by calendar month
 * (index 1–12; 0 unused): the loss at most (0 = none) and the gain (0 =
 * none). Set by month (engine 1.116.0) or the one value copied into every
 * month; `loses` / `gains` say whether any month has one, which decides the
 * run's series.
 */
export interface PlanBaseflow {
	lossM3Day: Float64Array;
	gainM3Day: Float64Array;
	loses: boolean;
	gains: boolean;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Water-year month names (Oct–Sep), for the warnings. */
const MONTH_NAMES = ['Oct', 'Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'] as const;

/**
 * A unit's base-flow loss and gain (absent = neither): each by month when its
 * monthly row is set (`baseflowLossMonthlyM3Day`, `baseflowGainMonthlyM3Day`,
 * water-year order), else the one value all year. Each must be a size ≥ 0;
 * anything else runs as 0, with a warning. Only units carry them: on a gauge
 * or an other water user they are ignored, with a warning (the node form and
 * the API refuse them there).
 */
export function baseflowOf(n: NetworkNode, warnings: string[]): { baseflow?: PlanBaseflow } {
	const lossRow = Array.isArray(n.baseflowLossMonthlyM3Day) ? n.baseflowLossMonthlyM3Day : null;
	const gainRow = Array.isArray(n.baseflowGainMonthlyM3Day) ? n.baseflowGainMonthlyM3Day : null;
	const set = (v: number | null | undefined) => v !== undefined && v !== null && v !== 0;
	const anySet = (row: readonly (number | null)[] | null, one: number | undefined) => (row ? row.some(set) : set(one));
	if (!anySet(lossRow, n.baseflowLossM3Day) && !anySet(gainRow, n.baseflowGainM3Day)) return {};
	const where = `${n.kind === 'farm' ? 'unit' : n.kind} "${n.name}"`;
	if (n.kind !== 'farm') {
		warnings.push(`${where}: a base-flow loss or gain is a unit's; ignored here`);
		return {};
	}
	const size = (v: number | null | undefined, what: string): number => {
		if (!set(v)) return 0;
		if (finite(v) && v >= 0) return v;
		warnings.push(`${where}: base-flow ${what} ${String(v)} m³/day is not a size ≥ 0; none`);
		return 0;
	};
	const row = (r: readonly (number | null)[] | null, one: number | undefined, what: string): Float64Array => {
		const out = new Float64Array(13);
		if (r && r.length !== 12) warnings.push(`${where}: base-flow ${what} by month should have 12 monthly values, has ${r.length}; missing months are 0`);
		const all = r ? 0 : size(one, what);
		for (let m = 1; m <= 12; m++) {
			const wy = waterYearIndex(m);
			out[m] = r ? size(r[wy], `${what} in ${MONTH_NAMES[wy]}`) : all;
		}
		return out;
	};
	const lossM3Day = row(lossRow, n.baseflowLossM3Day, 'loss');
	const gainM3Day = row(gainRow, n.baseflowGainM3Day, 'gain');
	const loses = lossM3Day.some((v) => v > 0);
	const gains = gainM3Day.some((v) => v > 0);
	if (!loses && !gains) return {};
	return { baseflow: { lossM3Day, gainM3Day, loses, gains } };
}

/** The day's base-flow loss on a runoff `i` in calendar month `m` (1–12): MIN(L, i), 0 for no runoff. */
export function baseflowLossDay(p: PlanBaseflow, i: number, m: number): number {
	const l = p.lossM3Day[m]!;
	if (!(i > 0) || !(l > 0)) return 0;
	return i < l ? i : l;
}

/** The runoff after the base flow in calendar month `m`: i − MIN(L, i) + gain. */
export function baseflowRunoff(p: PlanBaseflow, i: number, m: number): number {
	return i - baseflowLossDay(p, i, m) + p.gainM3Day[m]!;
}

/** Does any unit of the model lose or gain base flow? baseflowOf's own test, without its warnings. */
export function hasBaseflow(nodes: readonly NetworkNode[]): boolean {
	const quiet: string[] = [];
	return nodes.some((n) => baseflowOf(n, quiet).baseflow !== undefined);
}
