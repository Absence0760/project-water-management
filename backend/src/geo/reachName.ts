// The name a river reach added from the river network gets when its dataset
// names none (HydroRIVERS has no names): `Reach <id>`. Shared by the add
// (geo/rivers.ts) and the farm map (farms/view.ts), which leaves such a name
// out, since a farmer's map card would otherwise list one English word and
// an eight-digit id per reach.

/** The name a reach with no name of its own gets on the map. */
export const unnamedReachName = (reachId: number | string): string => `Reach ${reachId}`;

/** Whether a river feature still carries the name its reach was given for want of one (its ref `river-network:<dataset>:<id>`). */
export function isUnnamedReach(name: string, ref: string | null | undefined): boolean {
	const m = ref ? /^river-network:.+:([^:]+)$/.exec(ref) : null;
	return !!m && name === unnamedReachName(m[1]!);
}
