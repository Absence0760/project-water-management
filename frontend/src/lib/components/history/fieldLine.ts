// The field history line (WP-2.4 UI, docs/ui.md § Field history): what it
// says and where it links. Pure: no DOM, no fetch. Kept apart from
// timeline.ts so a form's chunk doesn't pull in the History tab's sentences.
import type { FieldHistory } from '$lib/api/types';
import { fmtDay, localIsoDate } from '$lib/format/number';

/** "Changed 3× · last by Ann, 12 Aug 2026: 40% → 60%", the date in the viewer's time zone. */
export function fieldHistoryText(f: FieldHistory): string {
	const by = f.lastBy ?? 'a deleted account';
	return `Changed ${f.count}× · last by ${by}, ${fmtDay(localIsoDate(new Date(f.lastAt)))}: ${compactMonths(f.change)}`;
}

/** One side of a change that is a whole twelve-month row, as the engine words it (fmtValue: U+202F groups): "0, 0, 500, … m³/day (Oct–Sep)". */
const MONTH_ROW = /^((?:-?[\d\u202f]+(?:\.\d+)?, ){11}-?[\d\u202f]+(?:\.\d+)?)(?: (\S+))? \(Oct–Sep\)$/;

/**
 * A monthly row set or cleared (a hands-off flow, River to dam by month, a
 * dam release: the engine's diffInputs writes all twelve values, Oct–Sep)
 * reads as its range in the one-line history: "none → by month: 0–500
 * m³/day", or "300 m³/day every month". The History tab keeps the full row.
 * Any other change is left as it is.
 */
export function compactMonths(change: string): string {
	return change
		.split(' → ')
		.map((side) => {
			const m = MONTH_ROW.exec(side);
			if (!m) return side;
			const vals = m[1]!.split(', ');
			const num = (v: string) => Number(v.replaceAll('\u202f', ''));
			let lo = vals[0]!;
			let hi = vals[0]!;
			for (const v of vals) {
				if (num(v) < num(lo)) lo = v;
				if (num(v) > num(hi)) hi = v;
			}
			const unit = m[2] ? ` ${m[2]}` : '';
			return num(lo) === num(hi) ? `${lo}${unit} every month` : `by month: ${lo}–${hi}${unit}`;
		})
		.join(' → ');
}

/**
 * The History tab filtered to this field: model and settings changes only
 * (`kind=revision`), the parameter filter's words (`q=`, which the server
 * applies to every page), and the unit (`unit=`) for a unit's own fields.
 */
export function fieldHistoryHref(f: Pick<FieldHistory, 'filter'>, unit?: string | null): string {
	const q = new URLSearchParams({ tab: 'history', kind: 'revision' });
	if (unit) q.set('unit', unit);
	q.set('q', f.filter);
	return `?${q}`;
}
