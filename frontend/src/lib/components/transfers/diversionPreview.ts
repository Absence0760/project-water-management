// A river off-take sized by a diversion curve (engine ≥ 1.113.0; a curve per
// month, 1.114.0, docs/model.md §2.6a): what each curve diverts at a few
// example river flows, so the person entering it sees which limit binds (the
// largest share, the curve or the canal's capacity), how much the unit of x
// matters, and, split between destinations (engine ≥ 1.114.0, §2.6), what each
// destination gets after the losses. The engine's own curve (diversionShareOf),
// read at the river's flow as the default (modelled) basis does; the canal is
// the rule's largest daily capacity in the months that curve runs (its rate ×
// 86 400, within its daily cap). Pure.
import {
	DIVERSION_FLOW_UNIT_M3_DAY,
	diversionCurveOf,
	diversionCurveProblem,
	diversionMonthsOf,
	diversionShareOf,
	transferDestinations,
	transferRatesM3s,
	type DiversionFlowUnit,
	type MonthDiversion,
	type Transfer
} from '@water-management/engine';

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
	/** What each destination gets, in the curve's unit, after the losses (the rule's destinations' order). */
	delivered: number[];
	limit: DiversionLimit;
}

/** One curve's preview: the water-year months (0 = Oct) it runs in, its rows, its canal. */
export interface CurvePreview {
	months: number[];
	rows: DiversionRow[];
	canalM3Day: number;
	canal: number;
	unit: DiversionFlowUnit;
}

/** The example river flows, m³/s: a small river's range, from a trickle to a flood. */
export const PREVIEW_FLOWS_M3S = [0.005, 0.02, 0.05, 0.2, 0.5, 2, 10] as const;

const capOf = (t: Pick<Transfer, 'dailyCapM3'>) => (t.dailyCapM3 != null && Number.isFinite(t.dailyCapM3) ? t.dailyCapM3 : Infinity);

/** The rule's largest capacity on any day, m³/day (its largest month's rate × 86 400, within its daily cap); 0 when it never runs. */
export function canalM3Day(t: Pick<Transfer, 'months' | 'maxRateM3s' | 'monthlyRateM3s' | 'dailyCapM3'>): number {
	const top = Math.max(0, ...transferRatesM3s(t as Transfer).filter((r) => Number.isFinite(r)));
	return Math.min(top * 86_400, capOf(t));
}

const same = (a: MonthDiversion, b: MonthDiversion) => a.coefficient === b.coefficient && a.exponent === b.exponent && (a.maxPct ?? 1) === (b.maxPct ?? 1);

/**
 * Each complete curve of a rule sized by one, with the months it runs in and
 * its rows at `flowsM3s`; months with the same curve share one preview. A
 * month's curve that is incomplete (the form shows why) and a month up to its
 * maximum have none; no unit of x, none at all.
 */
export function diversionPreviews(t: Transfer, flowsM3s: readonly number[] = PREVIEW_FLOWS_M3S): CurvePreview[] {
	const unit = t.diversionFlowUnit;
	if (!unit || !(unit in DIVERSION_FLOW_UNIT_M3_DAY)) return [];
	const per = DIVERSION_FLOW_UNIT_M3_DAY[unit];
	const rates = transferRatesM3s(t);
	const groups: { curve: MonthDiversion; months: number[] }[] = [];
	diversionMonthsOf(t).forEach((m, k) => {
		if (!m || diversionCurveProblem({ diversionCoefficient: m.coefficient, diversionExponent: m.exponent, diversionMaxPct: m.maxPct, diversionFlowUnit: unit, diversionFlowBasis: t.diversionFlowBasis })) return;
		const g = groups.find((x) => same(x.curve, m));
		if (g) g.months.push(k);
		else groups.push({ curve: m, months: [k] });
	});
	const loss = Number.isFinite(t.lossPct) && (t.lossPct ?? 0) >= 0 && (t.lossPct ?? 0) < 1 ? (t.lossPct ?? 0) : 0;
	const shares = transferDestinations(t).map((d) => d.pct);
	return groups.map(({ curve, months }) => {
		const c = diversionCurveOf({ diversionCoefficient: curve.coefficient, diversionExponent: curve.exponent, diversionMaxPct: curve.maxPct, diversionFlowUnit: unit, diversionFlowBasis: t.diversionFlowBasis });
		const canal = Math.min(Math.max(0, ...months.map((k) => (Number.isFinite(rates[k]) ? rates[k]! : 0))) * 86_400, capOf(t));
		const rows = flowsM3s.map((q): DiversionRow => {
			const x = q * 86_400;
			const share = diversionShareOf(c, x);
			const want = share * x;
			const diverted = Math.min(want, canal);
			const limit: DiversionLimit = !(x > 0) || !(share > 0) ? 'dry' : canal < want ? 'canal' : share >= c.maxShare ? 'largest' : 'curve';
			return { flowM3Day: x, flow: x / per, share, divertedM3Day: diverted, diverted: diverted / per, delivered: shares.map((p) => (diverted * (1 - loss) * p) / per), limit };
		});
		return { months, rows, canalM3Day: canal, canal: canal / per, unit };
	});
}

/**
 * The preview rows of a rule sized by one curve in every month (engine
 * 1.113.0's rule), or null while its curve is incomplete (diversionCurveProblem
 * says why; the form shows that instead). `flowsM3s` are the example flows.
 */
export function diversionPreview(t: Transfer, flowsM3s: readonly number[] = PREVIEW_FLOWS_M3S): CurvePreview | null {
	if (diversionCurveProblem(t)) return null;
	return diversionPreviews(t, flowsM3s)[0] ?? null;
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
