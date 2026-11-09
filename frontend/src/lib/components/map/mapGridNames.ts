// The short names people know the MAP grids by (docs/maps.md § MAP for each
// unit): the dataset label a grid is loaded under (`pnpm import:map-grid
// --dataset`) → the name the unit form shows. The full citation stays where a
// source is cited (unitMapProposal.ts gridCitation, the Map's Layers box).
// The one place these names live: anything that names one of these grids
// reads it here.

/** Each named grid's dataset label → its short name, in the order a choice lists them. */
export const MAP_GRID_NAMES: Readonly<Record<string, string>> = {
	'WAAS-SWCape-2007': 'WAAS 2007 MAP',
	'Lynch-2004': 'CCWR MAP'
};

/** A grid's short name, else its dataset label (a grid loaded under another label, such as the synthetic one). */
export const mapGridName = (label: string): string => MAP_GRID_NAMES[label] ?? label;
