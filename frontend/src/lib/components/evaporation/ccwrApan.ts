// The CCWR A-pan grid (docs/maps.md § Evaporation from the map, § The
// evaporation grid): the WRC Atlas's monthly A-pan equivalent grids (Schulze
// and Maharaj 2007, from the CCWR's Atlas of Agrohydrology distribution),
// loaded as evaporation dataset `Atlas-Apan-2007` (backend geo/evaporationGrid.ts
// ATLAS_APAN). Model settings → Demand offers it by name as an A-pan source,
// averaged over the catchment boundary into the one A-pan row; every grid
// picker shows it under the same name.

/** The dataset label the CCWR A-pan grid loads under (production loads it under this label only). */
export const CCWR_APAN_DATASET = 'Atlas-Apan-2007';
/** Its name wherever a grid is picked or cited in the app. */
export const CCWR_APAN_NAME = 'CCWR A-pan';

/** An evaporation grid's name as the app shows it: "CCWR A-pan" for the Atlas A-pan grid, else its label. */
export const evaporationGridName = (dataset: string): string => (dataset === CCWR_APAN_DATASET ? CCWR_APAN_NAME : dataset);
