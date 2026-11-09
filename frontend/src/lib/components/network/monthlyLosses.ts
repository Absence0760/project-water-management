// Bed losses and a unit's base-flow loss and gain by water-year month (engine
// 1.116.0, docs/model.md §2.6b) in the one-node form: which monthly row stands
// in for each one-value field, what the "Vary by month" switches write, and the
// section summary's words. Pure: no Svelte (./MonthlyLossFields.svelte draws it).
import { MONTHLY_ROW_OF, replacedByMonth, type NetworkNode } from '@water-management/engine';
import { fmtNum } from '#lib/format/number.js';
import { monthsOf } from './monthFields';


type LossNode = Partial<Pick<NetworkNode, keyof typeof MONTHLY_ROW_OF | (typeof MONTHLY_ROW_OF)[keyof typeof MONTHLY_ROW_OF]>>;

const isRow = (v: unknown): v is number[] => Array.isArray(v);

/** Is this one-value field replaced by its monthly row on node `n` (the engine's MONTHLY_ROW_OF)? */
export const setByMonth = (key: string, n: LossNode): boolean => replacedByMonth(n, key);

/** The row the form shows for a one value (MONTHLY_ROW_OF): the stored row, else the one value in every month, which the run reads. */
export function shownRow(n: LossNode, key: keyof typeof MONTHLY_ROW_OF): number[] {
	const row = n[MONTHLY_ROW_OF[key]];
	return isRow(row) ? row : monthsOf((n[key] as number | null | undefined) ?? 0);
}

/** Does the node carry a base-flow loss or gain, one value or by month? A node that isn't a unit shows the section while it does, so they can be cleared (the save refuses them there). */
export function hasBaseflowSettings(n: LossNode): boolean {
	return (n.baseflowLossM3Day ?? 0) !== 0 || (n.baseflowGainM3Day ?? 0) !== 0 || isRow(n.baseflowLossMonthlyM3Day) || isRow(n.baseflowGainMonthlyM3Day);
}

/** Does the reach lose anything in any month (by its monthly share when set, else its one share)? */
export function reachLoses(n: LossNode): boolean {
	return isRow(n.reachLossFracMonthly) ? n.reachLossFracMonthly.some((v) => v > 0) : (n.reachLossFrac ?? 0) > 0;
}

/** Is the section set by month (either of its rows)? */
export function sectionByMonth(group: 'reach' | 'baseflow', n: LossNode): boolean {
	return group === 'reach' ? isRow(n.reachLossFracMonthly) || isRow(n.reachLossMaxMonthlyM3Day) : isRow(n.baseflowLossMonthlyM3Day) || isRow(n.baseflowGainMonthlyM3Day);
}

/**
 * "Vary by month" ticked or cleared. Ticked: each row starts as its one value
 * in every month, so nothing changes until a month is edited (the bed losses'
 * cap only when there is one: with none, the months stay uncapped until "A
 * daily cap by month" is ticked). Cleared: the rows go and the one values,
 * kept all along, count again.
 */
export function varyByMonth(n: LossNode, group: 'reach' | 'baseflow', on: boolean): void {
	if (group === 'reach') {
		n.reachLossFracMonthly = on ? monthsOf(n.reachLossFrac ?? 0) : null;
		n.reachLossMaxMonthlyM3Day = on && n.reachLossMaxM3Day != null ? monthsOf(n.reachLossMaxM3Day) : null;
	} else {
		n.baseflowLossMonthlyM3Day = on ? monthsOf(n.baseflowLossM3Day ?? 0) : null;
		n.baseflowGainMonthlyM3Day = on ? monthsOf(n.baseflowGainM3Day ?? 0) : null;
	}
}

/** "A daily cap by month" ticked (every month starts at the one cap, else 0: no loss until a cap is entered) or cleared (no cap). */
export function capByMonth(n: LossNode, on: boolean): void {
	n.reachLossMaxMonthlyM3Day = on ? monthsOf(n.reachLossMaxM3Day ?? 0) : null;
}

/** A monthly row in a few words: its range, "5–30 %" or "0–2 000 m³/day", or the one value when every month has it. */
function rowRange(row: readonly number[], fmt: (v: number) => string): string {
	const lo = Math.min(...row);
	const hi = Math.max(...row);
	return lo === hi ? fmt(lo) : `${fmt(lo).replace(/ .*$/, '')}–${fmt(hi)}`;
}

const pctText = (v: number) => `${fmtNum(v * 100, 1, true)} %`;
const flowText = (v: number) => `${fmtNum(v)} m³/day`;

/** The bed losses' section summary when set by month: "5–30 % lost by month, at most 300–40 000 m³/day". */
export function reachMonthlySummary(n: LossNode): string {
	const share = isRow(n.reachLossFracMonthly) ? `${rowRange(n.reachLossFracMonthly, pctText)} lost by month` : `${pctText(n.reachLossFrac ?? 0)} lost`;
	const cap = isRow(n.reachLossMaxMonthlyM3Day) ? `, at most ${rowRange(n.reachLossMaxMonthlyM3Day, flowText)} by month` : n.reachLossMaxM3Day == null ? '' : `, at most ${flowText(n.reachLossMaxM3Day)}`;
	return share + cap;
}

/** The base flow's section summary when set by month: "loses 0–2 000, gains 0–300 m³/day by month". */
export function baseflowMonthlySummary(n: LossNode): string {
	const loss = isRow(n.baseflowLossMonthlyM3Day) ? n.baseflowLossMonthlyM3Day : monthsOf(n.baseflowLossM3Day ?? 0);
	const gain = isRow(n.baseflowGainMonthlyM3Day) ? n.baseflowGainMonthlyM3Day : monthsOf(n.baseflowGainM3Day ?? 0);
	const parts = [];
	if (loss.some((v) => v > 0)) parts.push(`loses ${rowRange(loss, flowText)}`);
	if (gain.some((v) => v > 0)) parts.push(`gains ${rowRange(gain, flowText)}`);
	return parts.length ? `${parts.join(', ')} by month` : 'None (by month, all 0)';
}
