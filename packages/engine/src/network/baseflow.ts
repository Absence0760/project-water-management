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

/** A unit's base flow as the simulation runs it, m³/day: the loss at most (0 = none) and the gain (0 = none); one of them > 0. */
export interface PlanBaseflow {
	lossM3Day: number;
	gainM3Day: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A unit's base-flow loss and gain (absent = neither). Each must be a size
 * ≥ 0; anything else runs as 0, with a warning. Only units carry them: on a
 * gauge or an other water user they are ignored, with a warning (the node
 * form and the API refuse them there).
 */
export function baseflowOf(n: NetworkNode, warnings: string[]): { baseflow?: PlanBaseflow } {
	const loss = n.baseflowLossM3Day;
	const gain = n.baseflowGainM3Day;
	const set = (v: number | undefined) => v !== undefined && v !== null && v !== 0;
	if (!set(loss) && !set(gain)) return {};
	const where = `${n.kind === 'farm' ? 'unit' : n.kind} "${n.name}"`;
	if (n.kind !== 'farm') {
		warnings.push(`${where}: a base-flow loss or gain is a unit's; ignored here`);
		return {};
	}
	const size = (v: number | undefined, what: string): number => {
		if (!set(v)) return 0;
		if (finite(v) && v >= 0) return v;
		warnings.push(`${where}: base-flow ${what} ${String(v)} m³/day is not a size ≥ 0; none`);
		return 0;
	};
	const lossM3Day = size(loss, 'loss');
	const gainM3Day = size(gain, 'gain');
	if (!(lossM3Day > 0) && !(gainM3Day > 0)) return {};
	return { baseflow: { lossM3Day, gainM3Day } };
}

/** The day's base-flow loss on a runoff `i`: MIN(L, i), 0 for no runoff. */
export function baseflowLossDay(p: PlanBaseflow, i: number): number {
	if (!(i > 0) || !(p.lossM3Day > 0)) return 0;
	return i < p.lossM3Day ? i : p.lossM3Day;
}

/** The runoff after the base flow: i − MIN(L, i) + gain. */
export function baseflowRunoff(p: PlanBaseflow, i: number): number {
	return i - baseflowLossDay(p, i) + p.gainM3Day;
}

/** Does any unit of the model lose or gain base flow? baseflowOf's own test, without its warnings. */
export function hasBaseflow(nodes: readonly NetworkNode[]): boolean {
	const quiet: string[] = [];
	return nodes.some((n) => baseflowOf(n, quiet).baseflow !== undefined);
}
