// Which of a delineated area a unit takes into the model (195): the gross
// area, as WR2012's quaternary areas are, or the effective area, the gross
// less what drains into pans (pans.ts; docs/design/delineation.md § Pans,
// docs/design/pans-research.md). Shared by every path that writes a unit's
// area from a delineation: Use this area (geo/routes.ts area-from-map, on an
// accepted proposal's feature or a saved sub-catchment), Start's and
// Divide's area ticks. The gross area is the default everywhere; the
// effective one is only ever taken when asked for.
import { z } from 'zod';
import { ApiError } from '../http/errors.js';

export const AreaBasis = z.enum(['gross', 'effective']);
export type AreaBasis = z.infer<typeof AreaBasis>;

/**
 * The area (m²) a unit takes from a piece of `areaM2` with `nonContributingM2`
 * draining into pans (null: not known). 400, naming `what`, when the
 * effective area is asked for and there's no pans figure, or nothing is left.
 */
export function takenAreaM2(what: string, areaM2: number, nonContributingM2: number | null | undefined, basis: AreaBasis): number {
	if (basis === 'gross') return areaM2;
	if (nonContributingM2 === null || nonContributingM2 === undefined) {
		throw new ApiError(400, `${what} has no figure for what drains into pans, so it has no effective area to take: take the gross area.`);
	}
	const m2 = areaM2 - Math.min(nonContributingM2, areaM2);
	if (!(m2 > 0)) throw new ApiError(400, `All of ${what} drains into pans, so its effective area is nothing: take the gross area, or type one.`);
	return m2;
}

const km2 = (m2: number) => `${(m2 / 1e6).toFixed(3)} km²`;

/**
 * Which area was taken, in words for a revision reason: "the effective area, without the 1.200 km² draining into pans",
 * "the gross area, the 1.200 km² draining into pans included", "the gross area" (none drains into pans); null for a
 * feature with no pans figure (drawn, imported), whose area is simply its own. Pure.
 */
export function basisText(basis: AreaBasis, nonContributingM2: number | null | undefined): string | null {
	if (basis === 'effective') return `the effective area, without the ${km2(nonContributingM2 ?? 0)} draining into pans`;
	if (nonContributingM2 === null || nonContributingM2 === undefined) return null;
	return nonContributingM2 > 0 ? `the gross area, the ${km2(nonContributingM2)} draining into pans included` : 'the gross area';
}

/**
 * Which of `areas` taken areas were gross and which effective, for a Start or Divide revision reason: " (gross)",
 * " (effective, without what drains into pans)", or " (gross; effective, without what drains into pans: A, B)". Empty with no area. Pure.
 */
export function areaBasisNote(areas: number, effective: readonly string[]): string {
	if (areas === 0) return '';
	if (effective.length === 0) return ' (gross)';
	if (effective.length >= areas) return ' (effective, without what drains into pans)';
	return ` (gross; effective, without what drains into pans: ${effective.join(', ')})`;
}
