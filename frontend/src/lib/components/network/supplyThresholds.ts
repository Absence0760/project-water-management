// The supply bands' thresholds, as a module of their own with no imports, so
// the landing page's what-if (landing/WhatIf.svelte) can read them without
// pulling in supplyColour.ts's freshness and date helpers, and through them
// ~43 KB gzip of engine chunks, in front of its hero (issue #92).
// supplyColour.ts and runs/results.ts re-export them for everyone else.

/** A farm is supplied when it gets at least this share of its demand (the farm table's flag threshold). */
export const SUPPLY_TARGET = 0.95;

/** Below this share of demand supplied a farm is in the lowest band. */
export const LOW_SUPPLY = 0.7;
