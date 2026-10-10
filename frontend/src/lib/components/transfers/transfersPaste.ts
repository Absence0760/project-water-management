// Paste from a spreadsheet into the transfers' max rates by month, and their
// CSV (issue #477, the grids' pattern of issue #285; docs/ui.md § Transfers):
// a row per rule, "Transfer N" as the cards number them (or its "From → To"),
// a column per water-year month, in the unit the page shows (m³/s, l/s or
// m³/day, `scale` shown units per stored m³/s). A blank or a dash leaves a
// month as it is; 0 turns it off. The block is mapped by
// $lib/spreadsheet/paste/monthlyRows.ts.
import { transferRatesM3s, withMonthlyRates, type Transfer } from '@water-management/engine';
import type { GridFormat, PasteAnchor, PastePlan } from '$lib/spreadsheet/paste/grid';
import { applyMonthlyPaste, monthlyRowsCsv, planMonthlyPaste, type MonthlyRow } from '$lib/spreadsheet/paste/monthlyRows';

/** Headings the first column goes by. */
const NAME_HEADINGS = ['Transfer', 'Rule', 'Name'];
/** The CSV's route columns: set on each card, so a paste of the CSV leaves them out quietly. */
const INFO_HEADINGS = ['From', 'To'];

type Rule = Pick<Transfer, 'id' | 'fromNodeId' | 'toNodeId' | 'months' | 'maxRateM3s' | 'monthlyRateM3s'>;

/** Each rule as a row of the paste: "Transfer N", also matched by "From → To" (or "From -> To"). */
export function transferRows(transfers: readonly Rule[], nodeName: (id: string) => string, scale: number, unit: string): MonthlyRow[] {
	return transfers.map((t, i) => {
		const [from, to] = [nodeName(t.fromNodeId), nodeName(t.toNodeId)];
		return { id: t.id, name: `Transfer ${i + 1}`, aliases: [`${from} → ${to}`, `${from} -> ${to}`], unit, values: transferRatesM3s(t).map((r) => r * scale) };
	});
}

/** What pasting `text` would change (rates in the shown unit; below 0 stops the paste). */
export function planTransferPaste(text: string, rows: readonly MonthlyRow[], anchor?: PasteAnchor | null): PastePlan | { error: string } {
	return planMonthlyPaste(text, rows, { anchor, nameHeadings: NAME_HEADINGS, ignoreHeadings: INFO_HEADINGS });
}

/** Write a plan's rates into the rules (each back in m³/s, the rule's months and max rate kept in step). */
export function applyTransferPaste(plan: PastePlan, transfers: readonly Transfer[], scale: number): void {
	const next = new Map<string, number[]>();
	applyMonthlyPaste(plan, (id, m, v) => {
		const t = transfers.find((x) => x.id === id);
		if (!t) return;
		const rates = next.get(id) ?? transferRatesM3s(t);
		rates[m] = v / scale;
		next.set(id, rates);
	});
	for (const [id, rates] of next) Object.assign(transfers.find((x) => x.id === id)!, withMonthlyRates(rates));
}

/** The rules as a CSV to fill in and paste back: Transfer, From, To, then Oct … Sep in the shown unit (0 = off). */
export function transfersCsv(transfers: readonly Rule[], nodeName: (id: string) => string, scale: number, unit: string): string {
	const rows = transferRows(transfers, nodeName, scale, unit);
	const rule = (r: MonthlyRow) => transfers.find((t) => t.id === r.id)!;
	return monthlyRowsCsv(
		rows,
		NAME_HEADINGS[0]!,
		[
			{ heading: 'From', value: (r) => nodeName(rule(r).fromNodeId) },
			{ heading: 'To', value: (r) => nodeName(rule(r).toNodeId) }
		],
		unit
	);
}

/** The Expected format of the transfers' paste (issue #477). Its example matches two rules between Upper farm and Lower farm. */
export const TRANSFERS_FORMAT: GridFormat = {
	rules: [
		'A heading row: Transfer, then the months Oct to Sep (or October to September). From and To columns may stay; they are read from each rule’s card, not the paste.',
		'A row per rule, named as its card is (Transfer 1) or by its route (Upper farm → Lower farm, or Upper farm -> Lower farm). Add a rule with + Add transfer first.',
		'Each month’s max rate in the unit beside Rates in (m³/s unless changed; a unit in a heading’s brackets isn’t converted). 0 turns a month off; a blank or a dash leaves it as it is.'
	],
	example: 'Transfer,From,To,Oct,Nov,Dec,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep\r\nTransfer 1,Upper farm,Lower farm,0.05,0.08,0.1,0.1,0.1,0.08,0.05,0,0,0,0,0.05\r\nLower farm -> Upper farm,,,0,0,0,0,0,0,0,0.02,0.02,0.02,0,0\r\n',
	exampleName: 'transfers-example.csv'
};
