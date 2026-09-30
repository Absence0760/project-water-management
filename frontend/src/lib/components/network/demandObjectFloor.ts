// The basic-needs floor as the node form states it (engine ≥ 1.41.0, issue
// #123, docs/model.md §2.7f): which number of people it counts, and the
// floor, never shown as more than the object asks for (the engine's day floor
// is MIN(floor, the day's demand)). Pure, so it is unit-tested without Svelte.
import { basicNeedsM3Day, basicNeedsPopulation, BASIC_NEEDS_CATEGORIES, DEMAND_NORMS, objectMonthlyM3Day, type DemandObject } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

const LPD = DEMAND_NORMS.basicLitresPerPersonDay;

/** The line under a domestic or municipal object; null for any other category. */
export function floorLine(o: DemandObject): string | null {
	if (!BASIC_NEEDS_CATEGORIES.includes(o.category)) return null;
	const floor = basicNeedsM3Day(o);
	if (floor === null) return `No basic-needs floor: enter the people it serves to keep a restriction from cutting it below ${LPD} litres a person a day.`;
	const people = fmtNum(basicNeedsPopulation(o), 0);
	const from = o.population === null || o.population === undefined ? ` (its number of people, ${people})` : ` (${people} people served)`;
	const monthly = objectMonthlyM3Day(o, []);
	const most = Math.max(...monthly);
	if (floor >= most)
		return `Basic-needs floor ${fmtNum(floor, 1, true)} m³/day${from}, at least its whole demand: a restriction never cuts it.`;
	return `Basic-needs floor ${fmtNum(floor, 1, true)} m³/day${from}, ${LPD} litres a person a day: a restriction never cuts it below that, or below its demand when that is less.`;
}

/** The hint under People served: which number the floor uses when the field is blank. */
export function peopleHint(o: DemandObject): string {
	if (o.sizing === 'perUnit') return `Blank: the floor counts its number of people (${fmtNum(o.count ?? 0, 0)}). A number here counts instead.`;
	return 'Blank: no basic-needs floor. Given as m³/day, it has no count of people of its own.';
}
