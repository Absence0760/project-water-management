// Land cover (WP-1.35) in the Network tab: a class's default reductions and
// how much of a farm its patches cover.
import { LAND_COVER_CLASSES, type LandCoverClass, type LandCoverPatch, type NetworkNode } from '@water-management/engine';

/** The class's reductions at full cover (the 'other' class's zeros for an unknown one). */
export function classDefaults(cls: LandCoverClass): { mar: number; lowFlow: number } {
	const c = LAND_COVER_CLASSES.find((x) => x.id === cls) ?? LAND_COVER_CLASSES.find((x) => x.id === 'other')!;
	return { mar: c.mar, lowFlow: c.lowFlow };
}

/** Σ area × condensed cover of the patches ÷ the farm's area (0 without an area). */
export function coverShare(node: Pick<NetworkNode, 'areaKm2'>, patches: readonly LandCoverPatch[]): number {
	if (!(node.areaKm2 > 0)) return 0;
	return patches.reduce((s, p) => s + (p.areaKm2 || 0) * (p.densityPct || 0), 0) / node.areaKm2;
}
