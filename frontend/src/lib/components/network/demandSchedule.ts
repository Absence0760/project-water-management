// The demand-object schedule editor's list edits (DemandScheduleFields.svelte,
// engine ≥ 1.17.0, docs/model.md §2.7f): a new window of each span with its
// starting values, ticking a weekday on or off, and moving a window, whose
// place in the list matters since the later of two windows covering a day
// wins. Pure, so the rules are tested without mounting the form.
import type { DemandScheduleSpan, DemandScheduleWindow } from '@water-management/engine';

/** The span choices, in the order the form lists them. */
export const SPAN_LABEL: Record<DemandScheduleSpan, string> = {
	always: 'Days of the week',
	yearly: 'Dates each year',
	range: 'Date range, once',
	easter: 'Around Easter'
};

/**
 * A new window of a span, off (factor 0), with a starting point a modeller
 * recognises: weekends; the Christmas break, 15 December to 10 January; a
 * date range left blank to fill in; Good Friday to Family Day.
 */
export function newWindow(span: DemandScheduleSpan): DemandScheduleWindow {
	const w: DemandScheduleWindow = { label: '', span, from: null, to: null, easterFrom: null, easterTo: null, weekdays: null, factor: 0 };
	if (span === 'always') return { ...w, label: 'Weekends', weekdays: [6, 7] };
	if (span === 'yearly') return { ...w, label: 'Christmas break', from: '12-15', to: '01-10' };
	if (span === 'range') return { ...w, from: '', to: '' };
	return { ...w, label: 'Easter weekend', easterFrom: -2, easterTo: 1 };
}

/** The window's bounds for another span (its label, weekdays and factor kept). */
export function withSpan(w: DemandScheduleWindow, span: DemandScheduleSpan): DemandScheduleWindow {
	const b = newWindow(span);
	return { ...w, span, from: b.from, to: b.to, easterFrom: b.easterFrom, easterTo: b.easterTo };
}

/** Weekdays (ISO 1–7) with day `d` ticked on or off; every day ticked is null (no filter). An empty list stays empty, which the save refuses. */
export function toggleWeekday(weekdays: readonly number[] | null, d: number, on: boolean): number[] | null {
	const days = new Set(weekdays ?? [1, 2, 3, 4, 5, 6, 7]);
	if (on) days.add(d);
	else days.delete(d);
	return days.size === 7 ? null : [...days].sort((a, b) => a - b);
}

/** The list with window `i` moved one place up (−1) or down (+1); unchanged at an end. */
export function moveWindow<T>(list: readonly T[], i: number, by: -1 | 1): T[] {
	const j = i + by;
	if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
	const next = [...list];
	[next[i], next[j]] = [next[j]!, next[i]!];
	return next;
}

/**
 * Which of a window's fields its problem (the engine's scheduleWindowProblem
 * message) is about, so the form marks those fields and points them at it.
 */
export function problemFields(problem: string | null): 'factor' | 'weekdays' | 'bounds' | null {
	if (!problem) return null;
	if (problem.startsWith('its factor')) return 'factor';
	if (problem.startsWith('its weekdays')) return 'weekdays';
	return 'bounds';
}
