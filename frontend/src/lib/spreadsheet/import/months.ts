// b023 month-list cells ("1,2,11,12"), docs/engine-audit.md M1.
//
// The workbook tests a month with ISNUMBER(FIND(m & ",", list & ",")), a
// substring search, so "11" also switches on January and "12" February. That
// is a workbook bug, not what the author wrote: the importer keeps the listed
// months only and names what the workbook would have added.
//
// The Python importer has two copies that differ at one edge, both ported:
// extract_project.py's month_list() (transfer months) finds the numbers in the
// cell text as written, while calibration.py's summer_months() first removes
// the spaces, so "1 2" is January and February for a transfer but December
// for the summer months.
import { type Cell, pyStr } from './cells';

function cellText(v: Cell): string {
	// A cell holding a single whole number: str(int(v)) for a float, str(v) for an int; the same text.
	return pyStr(v);
}

function listed(text: string): number[] {
	const months = new Set<number>();
	for (const m of text.match(/\d+/g) ?? []) {
		const n = Number(m);
		if (n >= 1 && n <= 12) months.add(n);
	}
	return [...months].sort((a, b) => a - b);
}

function substringMatched(text: string): Set<number> {
	const t = `${text},`;
	const out = new Set<number>();
	for (let m = 1; m <= 12; m++) if (t.includes(`${m},`)) out.add(m);
	return out;
}

/** extract_project.py month_list(): the months a transfer's month-list cell names. */
export function monthList(v: Cell): number[] {
	return v === null ? [] : listed(cellText(v));
}

/** extract_project.py substring_extra_months(): months the workbook's FIND matches although the transfer list doesn't name them. */
export function substringExtraMonths(v: Cell): number[] {
	if (v === null) return [];
	const named = new Set(monthList(v));
	return [...substringMatched(cellText(v).replace(/ /g, ''))].filter((m) => !named.has(m)).sort((a, b) => a - b);
}

/** calibration.py _month_text(): the cell as text, spaces removed. */
function summerText(v: Cell): string {
	return v === null ? '' : cellText(v).replace(/ /g, '');
}

/** calibration.py summer_months(): the months the summer-months cell names. */
export function summerMonths(v: Cell): number[] {
	return listed(summerText(v));
}

/** calibration.py substring_extra_months(): months the workbook's FIND makes summer although the list doesn't name them. */
export function summerExtraMonths(v: Cell): number[] {
	const named = new Set(summerMonths(v));
	return [...substringMatched(summerText(v))].filter((m) => !named.has(m)).sort((a, b) => a - b);
}
