// The unit a stored series is in. The model reads every flow series as m³/s
// and every rain series as mm, whatever a series' unit label says, so a flow
// uploaded in l/s used to run 1 000 × too large. The series routes convert on
// the way in: the unit given is looked up here, the values are scaled to the
// kind's canonical unit, and the canonical unit is what is stored. A unit
// this table doesn't know is refused, never guessed.
import type { SeriesKind } from './project';

type Dimension = 'flow' | 'depth';

export const CANONICAL_UNIT: Record<Dimension, string> = { flow: 'm³/s', depth: 'mm' };

const dimensionOf = (kind: SeriesKind | string): Dimension | null => (kind.endsWith('_m3s') ? 'flow' : kind.endsWith('_mm') ? 'depth' : null);

/** The unit a series of this kind is stored in (and the model reads it in). */
export const canonicalUnit = (kind: SeriesKind | string): string | null => {
	const d = dimensionOf(kind);
	return d ? CANONICAL_UNIT[d] : null;
};

// Keys are normalised spellings (see key()); values scale to the canonical unit.
const FACTORS: Record<Dimension, Record<string, number>> = {
	flow: {
		'm3/s': 1,
		cumec: 1,
		cumecs: 1,
		'l/s': 1e-3,
		lps: 1e-3,
		'm3/d': 1 / 86_400,
		'm3/h': 1 / 3_600,
		// Megalitres a day (the "M" is checked upper-case before normalising: mL/day is refused).
		'Ml/d': 1_000 / 86_400
	},
	depth: { mm: 1, cm: 10, in: 25.4 }
};

/** Accepted spellings, for the refusal message. */
export const ACCEPTED_UNITS: Record<Dimension, string[]> = {
	flow: ['m³/s (m3/s, cumecs)', 'l/s', 'm³/day', 'm³/h', 'ML/day'],
	depth: ['mm', 'cm', 'in']
};

function key(unit: string): string {
	const megalitre = /^M[lL]/.test(unit.trim());
	let k = unit
		.trim()
		// Whitespace runs collapsed first: `\s+per\s+` backtracks quadratically over a long run of spaces.
		.replace(/\s+/g, ' ')
		.replace(/ per /gi, '/')
		.replace(/ /g, '')
		.replace(/³|\^3/g, '3')
		.toLowerCase()
		.replace(/\/(day|days)$/, '/d')
		.replace(/\/(hour|hr)$/, '/h')
		.replace(/\/(sec|second)$/, '/s')
		.replace(/^litres?|^liters?/, 'l')
		.replace(/^inch(es)?$/, 'in');
	if (megalitre && k.startsWith('ml')) k = `Ml${k.slice(2)}`;
	return k;
}

export type UnitResult = { ok: true; unit: string; factor: number } | { ok: false; error: string };

/** How to store a series of `kind` given in `unit`: the canonical unit and the factor to scale its values by. */
export function seriesUnit(kind: SeriesKind | string, unit: string): UnitResult {
	const d = dimensionOf(kind);
	if (!d) return { ok: false, error: `no unit table for series kind ${kind}` };
	const factor = FACTORS[d][key(unit)];
	if (factor === undefined)
		return { ok: false, error: `unit "${unit}" isn't one this series can be given in; use one of ${ACCEPTED_UNITS[d].join(', ')} (stored as ${CANONICAL_UNIT[d]})` };
	return { ok: true, unit: CANONICAL_UNIT[d], factor };
}

/** Values scaled by `factor` (nulls kept); the same array when the factor is 1. */
export function scaleValues<T extends number | null>(values: T[], factor: number): (number | null)[] {
	if (factor === 1) return values;
	return values.map((v) => (v === null ? null : v * factor));
}

/** The units an upload form offers for a kind, canonical first (each one seriesUnit accepts). */
export function unitOptions(kind: SeriesKind | string): string[] {
	const d = dimensionOf(kind);
	return d === 'flow' ? ['m³/s', 'l/s', 'm³/day', 'm³/h', 'ML/day'] : d === 'depth' ? ['mm', 'cm', 'in'] : [];
}
