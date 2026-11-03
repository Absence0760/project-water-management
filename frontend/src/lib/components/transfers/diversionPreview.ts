// A river off-take sized by a diversion curve (engine ≥ 1.113.0, docs/model.md
// §2.6a): what the curve diverts at a few example river flows, so the person
// entering it sees which limit binds (the largest share, the curve or the
// canal's capacity) and how much the unit of x matters. The engine's own
// curve (diversionShareOf), read at the river's flow as the default
// (modelled) basis does; the canal is the rule's largest daily capacity in
// any month (its rate × 86 400, within its daily cap). Pure.
import { DIVERSION_FLOW_UNIT_M3_DAY, diversionCurveOf, diversionCurveProblem, diversionShareOf, transferRatesM3s, type DiversionFlowUnit, type Transfer } from '@water-management/engine';

/** What binds on a row: nothing flows, the largest share, the curve itself, or the canal's capacity. */
export type DiversionLimit = 'dry' | 'largest' | 'curve' | 'canal';

export interface DiversionRow {
	/** The river's flow, m³/day, and in the curve's unit. */
	flowM3Day: number;
	flow: number;
	/** The share of it the curve gives, 0–1 (after the largest share). */
	share: number;
	/** What the rule diverts, m³/day and in the curve's unit (after the canal's capacity). */
	divertedM3Day: number;
	diverted: number;
	limit: DiversionLimit;
}

/** The example river flows, m³/s: a small river's range, from a trickle to a flood. */
export const PREVIEW_FLOWS_M3S = [0.005, 0.02, 0.05, 0.2, 0.5, 2, 10] as const;

/** The rule's largest capacity on any day, m³/day (its largest month's rate × 86 400, within its daily cap); 0 when it never runs. */
export function canalM3Day(t: Pick<Transfer, 'months' | 'maxRateM3s' | 'monthlyRateM3s' | 'dailyCapM3'>): number {
	const top = Math.max(0, ...transferRatesM3s(t as Transfer).filter((r) => Number.isFinite(r)));
	const cap = t.dailyCapM3 != null && Number.isFinite(t.dailyCapM3) ? t.dailyCapM3 : Infinity;
	return Math.min(top * 86_400, cap);
}

/**
 * The preview rows of a rule sized by a diversion curve, or null while its
 * curve is incomplete (diversionCurveProblem says why; the form shows that
 * instead). `flowsM3s` are the example flows.
 */
export function diversionPreview(t: Transfer, flowsM3s: readonly number[] = PREVIEW_FLOWS_M3S): { rows: DiversionRow[]; canalM3Day: number; canal: number; unit: DiversionFlowUnit } | null {
	if (diversionCurveProblem(t)) return null;
	const c = diversionCurveOf(t);
	const unit = t.diversionFlowUnit as DiversionFlowUnit;
	const per = DIVERSION_FLOW_UNIT_M3_DAY[unit];
	const canal = canalM3Day(t);
	const rows = flowsM3s.map((q): DiversionRow => {
		const x = q * 86_400;
		const share = diversionShareOf(c, x);
		const want = share * x;
		const diverted = Math.min(want, canal);
		const limit: DiversionLimit = !(x > 0) || !(share > 0) ? 'dry' : canal < want ? 'canal' : share >= c.maxShare ? 'largest' : 'curve';
		return { flowM3Day: x, flow: x / per, share, divertedM3Day: diverted, diverted: diverted / per, limit };
	});
	return { rows, canalM3Day: canal, canal: canal / per, unit };
}

/** A limit in words, for the preview's last column. */
export const LIMIT_TEXT: Record<DiversionLimit, string> = {
	dry: 'no flow',
	largest: 'the largest share',
	curve: 'the curve',
	canal: 'the canal’s capacity'
};

/** The flow unit as the form names it. */
export const UNIT_TEXT: Record<DiversionFlowUnit, string> = { 'L/s': 'L/s', 'm3/s': 'm³/s', 'm3/day': 'm³/day', 'Ml/day': 'Ml/day' };
