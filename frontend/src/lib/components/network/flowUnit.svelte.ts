// The unit a flow rate is shown and entered in: m³/s, l/s or m³/day, picked
// beside the field. One choice per kind of rate (River to dam, pumps,
// transfers…), each starting at the unit it always showed, and every field of
// that kind follows it. The model keeps each value in its stored unit
// whichever is picked, so this is a viewer's convenience, kept in this
// browser (localStorage, read and written defensively: a private window or
// blocked storage just starts at the default).
export const FLOW_UNITS = [
	{ id: 'm3s', label: 'm³/s', scale: 1 / 86_400 },
	{ id: 'ls', label: 'l/s', scale: 1000 / 86_400 },
	{ id: 'm3day', label: 'm³/day', scale: 1 }
] as const;
export type FlowUnitId = (typeof FLOW_UNITS)[number]['id'];
export type FlowUnitLabel = (typeof FLOW_UNITS)[number]['label'];

function stored(key: string, fallback: FlowUnitId): FlowUnitId {
	try {
		const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
		return FLOW_UNITS.some((u) => u.id === v) ? (v as FlowUnitId) : fallback;
	} catch {
		return fallback;
	}
}

export class FlowUnit {
	readonly key: string;
	id = $state<FlowUnitId>('m3s');
	constructor(key: string, fallback: FlowUnitId) {
		this.key = key;
		this.id = stored(key, fallback);
	}
	#of = $derived(FLOW_UNITS.find((u) => u.id === this.id) ?? FLOW_UNITS[0]);
	/** Shown = stored m³/day × this. */
	get scale(): number {
		return this.#of.scale;
	}
	get label(): FlowUnitLabel {
		return this.#of.label;
	}
	/** Shown = a value stored in m³/s × this (a transfer's rate). */
	get scaleFromM3s(): number {
		return this.#of.scale * 86_400;
	}
	set(id: FlowUnitId) {
		this.id = id;
		try {
			localStorage.setItem(this.key, id);
		} catch {
			// Storage blocked: the choice lasts until the page reloads.
		}
	}
}

/** River to dam (stored m³/day, shown m³/s until changed). */
export const riverToDamUnit = new FlowUnit('wm.unit.riverToDam', 'm3s');
/** Pump and borehole capacities (stored m³/day, shown m³/day until changed). */
export const pumpUnit = new FlowUnit('wm.unit.pump', 'm3day');
/** A transfer's rate (stored m³/s, shown m³/s until changed). */
export const transferUnit = new FlowUnit('wm.unit.transfer', 'm3s');
