// The History reasons a Start or a Divide from the map records (model_revision.reason, at most REASON_MAX). Each ends
// with the elevation model and method version it came from, which an assessor relies on, so only the part that grows
// with the model (the names of the areas taken effective) is shortened, never the citation (issue #763).
import { fitReason, REASON_MAX } from '../history/record.js';
import { areaBasisNote } from './areaBasis.js';

const from = (dataset: string | null, methodVersion: string) => ` from ${dataset ? `${dataset}, ${methodVersion}` : 'the points as placed'}`;
const s = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A reason `head + note + rest + tail`, the note (areaBasisNote) given what room the rest leaves. */
function withNote(head: string, areas: number, effective: readonly string[], rest: string, tail: string): string {
	const room = REASON_MAX - head.length - rest.length - tail.length;
	return fitReason(`${head}${areaBasisNote(areas, effective, room)}${rest}`, tail);
}

export interface DivideReasonInput {
	areas: number;
	/** The names of the areas taken effective (without what drains into pans). */
	effective: readonly string[];
	orders: number;
	gauges: number;
	newUnits: number;
	restAdded: boolean;
	/** The elevation model's label (a division always has one; null only by the row's type). */
	dataset: string | null;
	methodVersion: string;
}

/** "Divided from the map: 3 areas (gross), 2 drains-into, 1 gauge added from <DEM>, <method>". Pure. */
export function divideReason(r: DivideReasonInput): string {
	const rest =
		`, ${s(r.orders, 'drains-into', 'drains-into')}` +
		`${r.gauges ? `, ${s(r.gauges, 'gauge')} added` : ''}${r.newUnits ? `, ${s(r.newUnits, 'unit')} added` : ''}` +
		`${r.restAdded ? ', the rest of the catchment added' : ''}`;
	return withNote(`Divided from the map: ${s(r.areas, 'area')}`, r.areas, r.effective, rest, from(r.dataset, r.methodVersion));
}

export interface StartReasonInput {
	units: number;
	areas: number;
	effective: readonly string[];
	orders: number;
	/** The elevation model's label; null when the units came from the points as placed. */
	dataset: string | null;
	methodVersion: string;
}

/** "Started from the map: 4 hydrological units; 2 areas (gross) and 1 drains-into from <DEM>, <method>". Pure. */
export function startReason(r: StartReasonInput): string {
	return withNote(
		`Started from the map: ${r.units} hydrological units; ${s(r.areas, 'area')}`,
		r.areas,
		r.effective,
		` and ${r.orders} drains-into`,
		from(r.dataset, r.methodVersion)
	);
}
