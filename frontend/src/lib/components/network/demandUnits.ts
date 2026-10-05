// The Demands grid's display unit (docs/ui.md § Demands grid): the month
// cells, the mean and the catchment row read and take m³/day (the default),
// l/s or m³/s, from the engine's own scale (DEMAND_MONTHLY_UNIT_SCALE); the
// model keeps m³/day. Chosen in the URL (`unit=ls|m3s`), so Back and a reload
// keep it; the annual column stays Mm³/a.
import { DEMAND_MONTHLY_UNIT_LABEL, DEMAND_MONTHLY_UNIT_SCALE, DEMAND_MONTHLY_UNITS, type DemandMonthlyUnit } from '@water-management/engine';

/** null = m³/day. */
export type DemandsUnit = DemandMonthlyUnit | null;

export const UNIT_PARAM = 'unit';

/** The unit a `unit=` value names; anything else (absent, unknown) is m³/day. */
export function parseDemandsUnit(v: string | null): DemandsUnit {
	return v !== null && (DEMAND_MONTHLY_UNITS as readonly string[]).includes(v) ? (v as DemandMonthlyUnit) : null;
}

export interface DemandsUnitView {
	label: string;
	/** Shown = stored m³/day × scale. */
	scale: number;
	/** Decimals a value shows with (m³/s is small). */
	decimals: number;
}

export function demandsUnitView(u: DemandsUnit): DemandsUnitView {
	if (!u) return { label: 'm³/day', scale: 1, decimals: 0 };
	return { label: DEMAND_MONTHLY_UNIT_LABEL[u], scale: DEMAND_MONTHLY_UNIT_SCALE[u], decimals: u === 'm3s' ? 4 : 2 };
}

/** The picker's choices, m³/day first. */
export const DEMANDS_UNIT_CHOICES: { value: DemandsUnit; label: string }[] = [
	{ value: null, label: 'm³/day' },
	...DEMAND_MONTHLY_UNITS.map((u) => ({ value: u, label: DEMAND_MONTHLY_UNIT_LABEL[u] }))
];
