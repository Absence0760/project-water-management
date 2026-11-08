// The A-pan and S-pan grid layers' words (docs/maps.md § A-pan and S-pan
// grids): each layer's id in `layers=` and its toggle, what a grid's values
// are, and the months the picker offers. Apart from mapLayers.ts so it loads
// with the layers' own chunk (EvaporationGridToggles.svelte), not the tab's.
// Pure (evaporationGrid.test.ts).
import type { EvaporationGridKind } from '#lib/api/types.js';
import type { MapLayer } from './mapLayers';

/** Each evaporation grid layer's id in `layers=`, by kind. */
export const EVAPORATION_GRID_LAYER: Readonly<Record<EvaporationGridKind, MapLayer>> = { apan: 'apangrid', span: 'spangrid' };

/** Each evaporation grid layer's toggle. */
export const EVAPORATION_GRID_LABEL: Readonly<Record<EvaporationGridKind, string>> = { apan: 'A-pan grid', span: 'S-pan grid' };

/**
 * What a drawn grid's values are, in words, from the server's label of them
 * (evaporationLabel: "modelled … not a measured pan" for the WRC Atlas's A-pan
 * grid and a PenPan one); an S-pan grid adds that it is a cross-check the
 * model never uses.
 */
export function evaporationGridWhat(d: { kind: EvaporationGridKind; label: string }): string {
	const words = d.label.charAt(0).toUpperCase() + d.label.slice(1);
	return d.kind === 'span' ? `${words}: a cross-check only, never used by the model.` : `${words}.`;
}

/** The months the layers' picker offers, in the water-year order the app shows months in: null (the year's total) first, then October … September. */
export const EVAPORATION_GRID_MONTHS: readonly (number | null)[] = [null, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9];

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A picker choice in words: "Year (total)" or the month's name. */
export const evaporationMonthLabel = (month: number | null) => (month === null ? 'Year (total)' : (MONTH_LONG[month - 1] ?? String(month)));

/** What the values drawn are, in words: "mm a year" or "mm in March (mean)". */
export const evaporationValueWords = (month: number | null) => (month === null ? 'mm a year' : `mm in ${evaporationMonthLabel(month)} (mean)`);
