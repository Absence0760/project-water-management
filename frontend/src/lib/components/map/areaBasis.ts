// Which of a delineated area a unit takes into the model (195, docs/maps.md
// § Pans and the effective area): the gross area, as WR2012's quaternary
// areas are (the default), or the effective one, the gross less what drains
// into pans. The pure parts the Start and Divide sheets' area ticks and the
// Map's Use this area share; the server works the area out itself
// (backend/src/delineation/areaBasis.ts), this only shows the choice.
import type { MapAreaBasis } from '$lib/api/types';
import { fmtNum } from '$lib/format/number';

/** Whether a piece offers the choice: it has a pans figure, something drains into them, and something is left. */
export const offersEffective = (areaM2: number | null | undefined, ncM2: number | null | undefined): boolean =>
	areaM2 != null && ncM2 != null && ncM2 > 0 && areaM2 - ncM2 > 0;

/** The area (m²) a unit takes on that basis: the effective one only with a figure, else the gross. */
export const takenAreaM2 = (areaM2: number, ncM2: number | null | undefined, basis: MapAreaBasis): number =>
	basis === 'effective' && ncM2 != null ? areaM2 - Math.min(ncM2, areaM2) : areaM2;

const km2 = (m2: number, digits: number) => `${fmtNum(m2 / 1e6, digits)} km²`;

/** The choice's two options, in words: "Gross, 12.30 km² (what drains into pans included)" and "Effective, 11.10 km² (without the 1.20 km² draining into pans)". */
export function basisOptions(areaM2: number, ncM2: number, digits = 2): { value: MapAreaBasis; label: string }[] {
	return [
		{ value: 'gross', label: `Gross, ${km2(areaM2, digits)} (what drains into pans included)` },
		{ value: 'effective', label: `Effective, ${km2(areaM2 - Math.min(ncM2, areaM2), digits)} (without the ${km2(ncM2, digits)} draining into pans)` }
	];
}

/** A unit's area basis in a few words for where it is shown, or '' for a gross or typed one: "effective, without pans". */
export const basisNote = (basis: MapAreaBasis | null | undefined): string => (basis === 'effective' ? 'effective, without pans' : '');
