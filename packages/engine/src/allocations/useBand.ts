// The band a unit's modelled use falls in against its registered volume, for
// the Allocations tab's map (issue #510, docs/allocations.md § The map). Pure
// arithmetic on the comparison's figures (./compare.ts), not part of runModel,
// so ENGINE_VERSION doesn't move. Here rather than in the frontend so the
// example seed (backend/scripts/examples/licenceMap.ts) is held to the same
// edges as the map.
//
// These bands are fixed for the map and separate from the comparison's
// ±tolerance status (allocationStatus), which also calls 0.9–1.0 "within".

/**
 * r = modelled use ÷ registered volume:
 * - under: r < 1.00 (using less than registered);
 * - near: 1.00 ≤ r ≤ 1.10 (the same, up to 10 % more);
 * - over: 1.10 < r ≤ 1.50;
 * - far: r > 1.50;
 * - unregistered: use with nothing registered;
 * - none: no use and nothing registered.
 */
export type UseBand = 'under' | 'near' | 'over' | 'far' | 'unregistered' | 'none';
export const USE_BANDS: readonly UseBand[] = ['under', 'near', 'over', 'far', 'unregistered', 'none'];

/** Below this many m³ a year's use or volume counts as nothing (compare.ts's float dust). */
const NOTHING_M3 = 1e-6;

/**
 * The ratio as the bands read it: rounded to 1e-6, so a volume registered as
 * exactly the modelled use (r = 1, the near band's lower edge) isn't put in
 * the under band by the comparison's own summing and dividing.
 */
const banded = (r: number) => Math.round(r * 1e6) / 1e6;

/** The band of a unit's modelled use against its registered volume (m³, same period and source). */
export function useBand(modelledM3: number, registeredM3: number): UseBand {
	if (!(registeredM3 > NOTHING_M3)) return modelledM3 > NOTHING_M3 ? 'unregistered' : 'none';
	const r = banded(modelledM3 / registeredM3);
	if (r < 1) return 'under';
	if (r <= 1.1) return 'near';
	if (r <= 1.5) return 'over';
	return 'far';
}
