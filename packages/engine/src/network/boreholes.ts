// Boreholes on a farm or other water user (WP-1.34, docs/model.md §2.7d):
// the node's fields resolved into the plan's pumping and stream-depletion
// parameters. runModel and the self-checks (../verify/checks.ts) both read a
// node's boreholes through this, so they agree on what a stored value means.
import type { NetworkNode } from '../project';
import type { PlanNode } from './simulate';

export type PlanBorehole = NonNullable<PlanNode['borehole']>;

/**
 * A farm's or other user's boreholes (WP-1.34, docs/model.md §2.7d), for the
 * plan; {} when it has none (capacity null or 0). Out-of-range values run
 * clamped, with a warning; 'drought' on a node without a dam never triggers,
 * so it runs as supplemental, with a warning.
 */
export function boreholeOf(n: NetworkNode, warnings: string[]): { borehole?: PlanBorehole } {
	const cap = n.boreholeCapacityM3Day;
	if (n.kind === 'gauge' || cap === null || cap === undefined || !(cap > 0)) return {};
	const what = n.kind === 'user' ? 'user' : 'farm';
	const clamp = (v: number | undefined, lo: number, hi: number, fallback: number, name: string) => {
		const x = Number.isFinite(v) ? Math.min(Math.max(v!, lo), hi) : fallback;
		if (v !== undefined && x !== v) warnings.push(`${what} "${n.name}": ${name} ${String(v)} is outside [${lo}, ${hi}]; using ${x}`);
		return x;
	};
	let rule: 0 | 1 | 2 = n.boreholeRule === 'primary' ? 1 : n.boreholeRule === 'drought' ? 2 : 0;
	const damCap = n.kind === 'farm' ? n.damCapacityM3 : 0;
	if (rule === 2 && !(damCap > 0)) {
		warnings.push(`${what} "${n.name}": the drought borehole rule needs a dam to trigger on; its boreholes run as supplemental`);
		rule = 0;
	}
	const trigger = clamp(n.boreholeTriggerPct, 0, 1, 0.3, 'borehole trigger');
	const d = clamp(n.streamDepletionFrac, 0, 1, 0, 'stream depletion fraction');
	const k = clamp(n.streamDepletionLagDays, 0, 36_500, 0, 'stream depletion lag (days)');
	return {
		borehole: { capacityM3Day: cap, rule, triggerM3: trigger * damCap, depletionFrac: d, depletionAlpha: k > 0 ? 1 - Math.exp(-1 / k) : 1 }
	};
}
