// The engine's version, stamped on every run. A change in engine behaviour
// bumps it (docs/STACK.md). A module of its own so pages that only show or
// compare the version don't load the model code (issue #9).
export const ENGINE_VERSION = '1.80.0';

/**
 * The engine that added the evidence report's measures to the uncertainty
 * ensemble's members (issue #71: no-flow days, EWR days per site, supply per
 * unit, the Reserve FDC check): members stored before it lack them. Here, not
 * in uncertainty/ensemble.ts, so the report page can name it without loading
 * the ensemble code.
 */
export const ENSEMBLE_MEASURES_SINCE = '1.33.0';
