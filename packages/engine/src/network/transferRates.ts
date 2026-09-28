// A transfer rule's maximum rate month by month (engine ≥ 1.14.0,
// docs/model.md §2.6). A rule either has one maximum rate (`maxRateM3s`) in
// the calendar months it lists (`months`), as b023 has it, or its own rate for
// each water-year month (`monthlyRateM3s`, Oct–Sep, m³/s), where a month with
// rate 0 is a month the rule is off. The monthly list, when set, is what runs;
// the model keeps `months` (the months with a rate above 0) and `maxRateM3s`
// (the largest monthly rate) in step with it, so every reader of the old pair
// still sees what the rule does (modelRuleIssues refuses a model where they
// disagree). Pure; the plan (../run.ts), the self-checks (../verify/checks.ts),
// the per-rule series (./transferSeries.ts) and the editors read a rule through
// these functions, so a stored rule means the same thing to each.
import type { Transfer } from '../project';

const SEC_PER_DAY = 86_400;

/** The calendar month (1–12) of each water-year month index 0–11 (Oct … Sep). */
export const WATER_YEAR_MONTHS = [10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

type RateFields = { months: readonly number[]; maxRateM3s: number; monthlyRateM3s?: readonly number[] | null };

/** A monthly list the engine can use: twelve finite numbers ≥ 0. */
export function validMonthlyRates(v: unknown): v is number[] {
	return Array.isArray(v) && v.length === 12 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);
}

/** Whether the rule runs on its own monthly rates (a valid `monthlyRateM3s`). */
export const hasMonthlyRates = (tr: RateFields): boolean => validMonthlyRates(tr.monthlyRateM3s);

/**
 * The rule's maximum rate per water-year month (Oct–Sep, m³/s): its monthly
 * list when it has one, else `maxRateM3s` in the months it lists and 0 in the
 * others.
 */
export function transferRatesM3s(tr: RateFields): number[] {
	if (validMonthlyRates(tr.monthlyRateM3s)) return [...tr.monthlyRateM3s];
	const on = new Set(tr.months);
	return WATER_YEAR_MONTHS.map((m) => (on.has(m) ? tr.maxRateM3s : 0));
}

/**
 * Whether the rule runs in each calendar month (index 1–12): with monthly
 * rates, a month whose rate is above 0; else the months it lists (a listed
 * month with a max rate of 0 still runs and moves nothing, as it always did).
 */
export function transferActiveMonths(tr: RateFields): Uint8Array {
	const on = new Uint8Array(13);
	if (validMonthlyRates(tr.monthlyRateM3s)) {
		for (let k = 0; k < 12; k++) if (tr.monthlyRateM3s[k]! > 0) on[WATER_YEAR_MONTHS[k]!] = 1;
	} else for (const m of tr.months) if (m >= 1 && m <= 12) on[m] = 1;
	return on;
}

/**
 * The most the rule may move in a day, per calendar month (index 1–12, m³):
 * the month's rate × 86 400, capped by the daily cap; 0 in a month it doesn't
 * run. Without monthly rates this is b023's "Transfer capacity max" in every
 * listed month, exactly as engines before 1.14.0 computed it.
 */
export function transferDailyLimit(tr: RateFields & Pick<Transfer, 'dailyCapM3'>): Float64Array {
	const on = transferActiveMonths(tr);
	const out = new Float64Array(13);
	if (validMonthlyRates(tr.monthlyRateM3s)) {
		for (let k = 0; k < 12; k++) {
			const m = WATER_YEAR_MONTHS[k]!;
			if (!on[m]) continue;
			let v = tr.monthlyRateM3s[k]! * SEC_PER_DAY;
			if (tr.dailyCapM3 !== null && tr.dailyCapM3 !== undefined) v = Math.min(v, tr.dailyCapM3);
			out[m] = Math.max(0, v);
		}
		return out;
	}
	let v = tr.maxRateM3s * SEC_PER_DAY;
	if (tr.dailyCapM3 !== null && tr.dailyCapM3 !== undefined) v = Math.min(v, tr.dailyCapM3);
	for (let m = 1; m <= 12; m++) if (on[m]) out[m] = Math.max(0, v);
	return out;
}

/**
 * The fields a rule with these monthly rates stores (Oct–Sep, m³/s): the list,
 * the calendar months with a rate above 0 (ascending) and the largest rate.
 * What the Transfers tab, the importers and the scenario op write.
 */
export function withMonthlyRates(rates: readonly number[]): { monthlyRateM3s: number[]; months: number[]; maxRateM3s: number } {
	if (rates.length !== 12) throw new Error('monthly rates need twelve values, Oct–Sep');
	const monthlyRateM3s = rates.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
	const months = WATER_YEAR_MONTHS.filter((_, k) => monthlyRateM3s[k]! > 0).sort((a, b) => a - b);
	return { monthlyRateM3s, months, maxRateM3s: Math.max(0, ...monthlyRateM3s) };
}

/**
 * Why a rule's `months` and `maxRateM3s` don't match its monthly rates, or
 * null when they do (or it has none): months must be exactly those with a
 * rate above 0, the max rate the largest of them.
 */
export function monthlyRatesMismatch(tr: RateFields): string | null {
	if (tr.monthlyRateM3s === null || tr.monthlyRateM3s === undefined) return null;
	if (!validMonthlyRates(tr.monthlyRateM3s)) return 'its monthly rates must be twelve numbers ≥ 0 (m³/s, Oct–Sep)';
	const want = withMonthlyRates(tr.monthlyRateM3s);
	const have = [...new Set(tr.months)].sort((a, b) => a - b);
	if (have.length !== want.months.length || have.some((m, k) => m !== want.months[k])) return 'its months must be the months with a monthly rate above 0';
	if (tr.maxRateM3s !== want.maxRateM3s) return 'its max rate must be the largest monthly rate';
	return null;
}
