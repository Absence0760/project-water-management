// The field history line (WP-2.4 UI, docs/ui.md § Field history): what it
// says and where it links. Pure: no DOM, no fetch. Kept apart from
// timeline.ts so a form's chunk doesn't pull in the History tab's sentences.
import type { FieldHistory } from '$lib/api/types';
import { fmtDay, localIsoDate } from '$lib/format/number';

/** "Changed 3× · last by Ann, 12 Aug 2026: 40% → 60%", the date in the viewer's time zone. */
export function fieldHistoryText(f: FieldHistory): string {
	const by = f.lastBy ?? 'a deleted account';
	return `Changed ${f.count}× · last by ${by}, ${fmtDay(localIsoDate(new Date(f.lastAt)))}: ${f.change}`;
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
