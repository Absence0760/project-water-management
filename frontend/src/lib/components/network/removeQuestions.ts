// The one-node form's sub-items (demand objects, individual boreholes,
// land-cover patches, schedule windows, the dam's survey curve): whether
// removing one should ask first, what the question says, and where the focus
// goes after (docs/ui.md § Confirmation questions: a list asks only when
// something typed goes with the item, and names the button after the action).
// Until the model is saved, the save bar's Discard brings any of them back,
// but it also throws away every other unsaved edit, so the question says so.
import type { Borehole, DemandObject, DemandScheduleWindow, LandCoverPatch } from '@water-management/engine';
import { newWindow } from './demandSchedule';

const UNDO = 'Until you save, Discard brings it back, with every other unsaved change.';

export interface RemoveQuestion {
	title: string;
	message: string;
	confirmLabel: string;
	danger: true;
}

/** "Town A", or "demand object 2" for one with no name. */
export const itemName = (name: string | null | undefined, word: string, i: number) => name?.trim() || `${word} ${i + 1}`;

/** A demand object with anything typed into it besides its name and category: a demand, a count, a note, a schedule, a source. */
export function demandObjectHasData(o: DemandObject): boolean {
	return (
		(o.monthlyM3Day ?? []).some((v) => v > 0) ||
		(o.count ?? 0) > 0 ||
		!!o.note?.trim() ||
		!!o.schedule?.length ||
		(o.population ?? null) !== null ||
		(o.source ?? null) !== null ||
		(o.waterSource ?? null) !== null ||
		o.monthlyFactor != null
	);
}

export function demandObjectQuestion(o: DemandObject, i: number): RemoveQuestion | null {
	if (!demandObjectHasData(o)) return null;
	const windows = o.schedule?.length ?? 0;
	const parts = [o.sizing === 'monthly' ? 'its monthly demand' : 'its count and litres a day', ...(windows ? [`${windows} schedule window${windows === 1 ? '' : 's'}`] : []), ...(o.note?.trim() ? ['its source details'] : [])];
	return {
		title: `Remove “${itemName(o.name, 'demand object', i)}”?`,
		message: `${cap(listAnd(parts))} ${parts.length === 1 && o.sizing === 'monthly' ? 'goes' : 'go'} with it. ${UNDO}`,
		confirmLabel: 'Remove demand object',
		danger: true
	};
}

/** A borehole with a capacity, an annual cap or a stream-depletion share entered. */
export const boreholeHasData = (b: Borehole) => b.capacityM3Day > 0 || b.annualCapM3 !== null || b.depletionFactor > 0;

export function boreholeQuestion(b: Borehole, i: number): RemoveQuestion | null {
	if (!boreholeHasData(b)) return null;
	return {
		title: `Remove “${itemName(b.name, 'borehole', i)}”?`,
		message: `Its capacity, annual cap and stream depletion go with it. ${UNDO}`,
		confirmLabel: 'Remove borehole',
		danger: true
	};
}

/** A land-cover patch with an area, or its own reductions. */
export const patchHasData = (p: LandCoverPatch) => p.areaKm2 > 0 || p.factors !== null;

export function patchQuestion(p: LandCoverPatch, i: number, classLabel: string): RemoveQuestion | null {
	if (!patchHasData(p)) return null;
	return {
		title: `Remove land-cover patch ${i + 1} (${classLabel})?`,
		message: `Its area and cover${p.factors ? ', with its own reductions,' : ''} go with it. ${UNDO}`,
		confirmLabel: 'Remove patch',
		danger: true
	};
}

/** A schedule window changed from how + Add window made it. */
export const windowHasData = (w: DemandScheduleWindow) => JSON.stringify({ ...newWindow(w.span), ...w }) !== JSON.stringify(newWindow(w.span));

export function windowQuestion(w: DemandScheduleWindow, i: number): RemoveQuestion | null {
	if (!windowHasData(w)) return null;
	return {
		title: `Remove window ${i + 1}${w.label.trim() ? ` (${w.label.trim()})` : ''}?`,
		message: `Its days and factor go with it. ${UNDO}`,
		confirmLabel: 'Remove window',
		danger: true
	};
}

/** The survey curve always holds pasted rows. */
export function curveQuestion(rows: number, name: string): RemoveQuestion {
	return {
		title: `Remove the survey curve of “${name}”?`,
		message: `Its ${rows} survey row${rows === 1 ? ' goes' : 's go'} with it; the dam's area goes back to the area when full and exponent. ${UNDO}`,
		confirmLabel: 'Remove the curve',
		danger: true
	};
}

/** After removing item `i` of `count`: the index to focus (the next item, else the one before), or null when none is left. */
export function focusAfter(i: number, count: number): number | null {
	const left = count - 1;
	if (left <= 0) return null;
	return Math.min(i, left - 1);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function listAnd(parts: string[]): string {
	return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? '');
}
