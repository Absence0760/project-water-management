// A unit's supply order, as the node form sets it (engine ≥ 1.64.0, issue
// #343, docs/model.md §2.7f). With one demand object the form keeps the
// priority dropdown (before, with or after the crops); with two or more it
// shows the numbered order instead: the crops and every object, 1 supplied
// first, equal numbers sharing pro rata. The order is stored as each
// object's priority class and its rank within it (the engine's
// supplyOrder / fromSupplyOrder), so an order of classes alone stores what
// an object saved before ranks had. Pure, so it is unit-tested without Svelte.
import { fromSupplyOrder, supplyOrder, type DemandObject, type DemandObjectPriority } from '@water-management/engine';

/** The priority dropdown's words: short enough for the edit panel's narrow column. */
export const PRIORITY_OPTION_LABEL: Record<DemandObjectPriority, string> = {
	first: 'Before the crops',
	shared: 'With the crops, pro rata',
	last: 'After the crops'
};

/** Whether the form shows the numbered order (two or more objects) rather than each object's dropdown. */
export const showsSupplyOrder = (objects: readonly unknown[]): boolean => objects.length >= 2;

/** The dropdown: a class on its own, with no rank (the form a unit with one object has). */
export function setPriority(o: DemandObject, priority: DemandObjectPriority): void {
	o.priority = priority;
	if (o.rank !== null && o.rank !== undefined) o.rank = null;
}

/**
 * Put the crops (`which` = 'crops') or object `which` (its index in
 * `objects`) at `position` in the unit's numbered order, and store the
 * order back on every object as a class and a rank. A whole number shares
 * that place; a half (1.5, or 0.5 before the first) makes a new place
 * between two, so one choice inserts a demand anywhere (positionChoices).
 * The numbers are renumbered from 1 without gaps on the next read. A
 * position that isn't a number > 0 changes nothing.
 */
export function setSupplyPosition(objects: DemandObject[], which: number | 'crops', position: number | null): void {
	if (position === null || !Number.isFinite(position) || position <= 0) return;
	const { positions, crops } = supplyOrder(objects);
	if (which !== 'crops') positions[which] = position;
	store(objects, positions, which === 'crops' ? position : crops);
}

function store(objects: DemandObject[], positions: number[], crops: number): void {
	fromSupplyOrder(positions, crops).forEach((x, k) => {
		const o = objects[k]!;
		if (o.priority !== x.priority) o.priority = x.priority;
		if ((o.rank ?? null) !== x.rank) o.rank = x.rank;
	});
}

/**
 * Store a unit's order again after a demand is removed (`objects` = what is
 * left on the unit): the ranks close up, and a lone object keeps no rank,
 * so the dropdown it falls back to shows everything that orders it.
 */
export function renumberSupplyOrder(objects: DemandObject[]): void {
	const { positions, crops } = supplyOrder(objects);
	store(objects, positions, crops);
}

/**
 * The places a row's select offers in a unit with `levels` places: before
 * 1, each place (shared with what is there), between each two, and after
 * the last; value as setSupplyPosition takes it.
 */
export function positionChoices(levels: number): { value: number; label: string }[] {
	const out = [{ value: 0.5, label: 'Before 1' }];
	for (let p = 1; p <= levels; p++) {
		out.push({ value: p, label: String(p) });
		out.push(p < levels ? { value: p + 0.5, label: `Between ${p} and ${p + 1}` } : { value: p + 0.5, label: `After ${p}` });
	}
	return out;
}

/** The rows of the order box in supply order (the crops among them, at their place); equal places keep the list's order. */
export function orderRows(objects: readonly DemandObject[]): { which: number | 'crops'; position: number }[] {
	const { positions, crops } = supplyOrder(objects);
	const rows: { which: number | 'crops'; position: number }[] = [{ which: 'crops', position: crops }, ...positions.map((position, k) => ({ which: k, position }))];
	return rows.sort((a, b) => a.position - b.position);
}

/** The order in words for a screen reader and the hint under the list, e.g. "Town, then Village and the crops pro rata, then Export". */
export function supplyOrderText(objects: readonly DemandObject[]): string {
	const { positions, crops } = supplyOrder(objects);
	const levels = [...new Set([...positions, crops])].sort((a, b) => a - b);
	const names = (p: number) => {
		const at = objects.filter((_, k) => positions[k] === p).map((o) => o.name || 'Unnamed demand');
		if (p === crops) at.push('the crops');
		return at.length > 1 ? `${at.slice(0, -1).join(', ')} and ${at.at(-1)} pro rata` : at[0]!;
	};
	return levels.map(names).join(', then ');
}
