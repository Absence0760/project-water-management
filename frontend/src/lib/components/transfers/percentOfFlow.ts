// A river off-take that takes a percentage of the available flow, month by month (Transfers → Takes → "Percentage
// of available flow", TakesPercentByMonth.svelte; docs/ui.md § Transfers). No new model field: each month is the
// engine's curve by month (docs/model.md §2.6a) with b = 0, so the share is a · x⁰ ÷ 100 = a % of the river leaving
// the source after its own use (U₀), whatever the flow's unit, never above the month's rate (the canal), and the
// hands-off flow, the EWR when kept, and the rules of its priority still apply after it. The rest stays in the
// river. A rule whose every formula month has b = 0 and no largest share shows in this mode; any other curve keeps
// "A formula by month". Pure helpers.
import { diversionMonthsOf, transferRatesM3s, withMonthlyRates, type MonthDiversion, type Transfer } from '@water-management/engine';

type Fields = Pick<Transfer, 'sizing' | 'monthlyDiversion' | 'diversionCoefficient' | 'diversionExponent' | 'diversionMaxPct' | 'diversionFlowUnit' | 'monthlyRateM3s' | 'maxRateM3s' | 'months'>;

/** A month's curve that is a plain percentage: b = 0 and no largest share below 100 %. */
const plainPct = (m: MonthDiversion | null): m is MonthDiversion => !!m && m.exponent === 0 && (m.maxPct === null || m.maxPct === 1);

/**
 * Whether the rule is a percentage of the flow: sized by a curve, and every month it runs in (rate > 0) takes a
 * plain percentage (a month off may keep any curve or none).
 */
export function isPercentOfFlow(t: Fields): boolean {
	if (t.sizing !== 'diversionCurve') return false;
	const curves = diversionMonthsOf(t);
	const rates = transferRatesM3s(t);
	if (!curves.some(plainPct)) return false;
	return curves.every((c, k) => (rates[k]! > 0 ? plainPct(c) : c === null || plainPct(c)));
}

/** Each month's percentage (a), or null for a month without one. */
export const percentsOf = (t: Fields): (number | null)[] => diversionMonthsOf(t).map((c) => (plainPct(c) ? c.coefficient : null));

/** The fields that make every month a percentage: `pcts[k]` (null: 100 %, so the month takes up to its rate as before). */
export function withPercents(pcts: readonly (number | null)[]): Pick<Transfer, 'sizing' | 'monthlyDiversion' | 'diversionCoefficient' | 'diversionExponent' | 'diversionMaxPct'> {
	if (pcts.length !== 12) throw new Error('a percentage by month needs twelve entries, Oct–Sep');
	return {
		sizing: 'diversionCurve',
		monthlyDiversion: pcts.map((p) => ({ coefficient: p ?? 100, exponent: 0, maxPct: null })),
		diversionCoefficient: null,
		diversionExponent: null,
		diversionMaxPct: null
	};
}

/**
 * Switch a rule to a percentage of the flow. Months keep a plain percentage they already have; the rest start at
 * 100 % (up to the rate, which a rule up to a maximum already took). The curve's unit doesn't matter at b = 0 but
 * the model asks for one, so a rule without one gets m³/s.
 */
export function toPercentOfFlow(t: Fields): Pick<Transfer, 'sizing' | 'monthlyDiversion' | 'diversionCoefficient' | 'diversionExponent' | 'diversionMaxPct' | 'diversionFlowUnit'> {
	return { ...withPercents(percentsOf(t)), diversionFlowUnit: t.diversionFlowUnit ?? 'm3/s' };
}

/** Set one month's percentage. 0 or blank turns the month off (its rate 0), since a share of 0 % isn't a curve the model takes. */
export function setPercent(t: Fields, k: number, pct: number | null): Partial<Transfer> {
	const pcts = percentsOf(t);
	if (pct === null || !(pct > 0)) {
		const rates = transferRatesM3s(t);
		rates[k] = 0;
		return { ...withMonthlyRates(rates), ...withPercents(pcts) };
	}
	pcts[k] = Math.min(pct, 100);
	return withPercents(pcts);
}
