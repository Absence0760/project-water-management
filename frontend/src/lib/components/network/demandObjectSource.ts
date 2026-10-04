// Where a demand object's number comes from, as the node form sets it
// (engine ≥ 1.56.0, issue #54 Q11, docs/model.md §2.7f). The source decides
// how the volume is given: a meter record or a strategy's AADD is m³/day by
// month, population × litres a day is a count × litres; 'other' leaves the
// choice. So picking a source switches the sizing, and a source that fixes
// one locks the sizing select. Pure, so it is unit-tested without Svelte.
import { DEMAND_NORMS, DEMAND_OBJECT_SOURCE_SIZING, type DemandMonthlyUnit, type DemandObject, type DemandObjectSource } from '@water-management/engine';
import { monthsOf } from './monthFields';

/** The form's words for each source, the rule's order (best first). */
export const SOURCE_OPTION_LABEL: Record<DemandObjectSource, string> = {
	meter: 'Meter records',
	aadd: 'Reconciliation strategy’s AADD',
	perCapita: 'Population × litres a day (a norm)',
	other: 'Other (a licence, an estimate, the workbook)'
};

/** Switch how the demand is given, filling what the new sizing needs (a norm for a new count). */
export function setSizing(o: DemandObject, sizing: DemandObject['sizing']): void {
	o.sizing = sizing;
	if (sizing === 'monthly') o.monthlyM3Day ??= monthsOf(0);
	else {
		o.count ??= 0;
		o.litresPerUnitDay ??= o.category === 'livestock' ? DEMAND_NORMS.litresPerCattleDay : DEMAND_NORMS.litresPerPersonDay;
	}
}

/** What "Demand given as" offers: m³/day, l/s or m³/s by month (engine ≥ 1.72.0), or a count × litres a day. */
export type GivenAs = 'monthly' | 'monthly:ls' | 'monthly:m3s' | 'perUnit';

/** The object's "Demand given as" choice. */
export const givenAsOf = (o: Pick<DemandObject, 'sizing' | 'monthlyUnit'>): GivenAs =>
	o.sizing === 'perUnit' ? 'perUnit' : o.monthlyUnit ? (`monthly:${o.monthlyUnit}` as GivenAs) : 'monthly';

/**
 * Give the demand that way: the sizing, and for a monthly one the unit it is
 * entered and shown in (display only: the demand stays m³/day underneath, so
 * switching between m³/day, l/s and m³/s never changes it).
 */
export function setGivenAs(o: DemandObject, given: GivenAs): void {
	const [sizing, unit] = given.split(':') as [DemandObject['sizing'], DemandMonthlyUnit | undefined];
	setSizing(o, sizing);
	if (sizing === 'monthly' && unit) o.monthlyUnit = unit;
	else delete o.monthlyUnit;
}

/** Record where the number comes from (null = not recorded), and give the demand the way that source does. */
export function setSource(o: DemandObject, source: DemandObjectSource | null): void {
	o.source = source;
	const sizing = source ? DEMAND_OBJECT_SOURCE_SIZING[source] : null;
	if (sizing && o.sizing !== sizing) setSizing(o, sizing);
}

/** The sizing the object's source fixes, or null when the modeller chooses (no source, or 'other'). */
export function sizingFixedBy(o: Pick<DemandObject, 'source'>): DemandObject['sizing'] | null {
	return o.source ? (DEMAND_OBJECT_SOURCE_SIZING[o.source] ?? null) : null;
}
