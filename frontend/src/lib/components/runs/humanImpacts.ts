// Land cover, groundwater, demand objects and other users' tables: a separate chunk
// (HumanImpactTables.svelte), drawn on Hydrological units (issue #137) and in the printable
// report. A plain module rather than a `<script module>`, so the printable report can
// load it before it says it is ready: Vite's dependency scan can't see a .svelte file's
// named exports, and failed on the import.
import type { RunSummary } from '@water-management/engine';

export const loadHumanImpacts = () => import('./HumanImpactTables.svelte');

/** Which of the tables the run has (engine ≥ 0.22.0 and later; demand objects ≥ 1.7.0). */
function parts(summary: Pick<RunSummary, 'landCover' | 'users' | 'farms'>) {
	const farms = summary.farms ?? [];
	const others = summary.users ?? [];
	return {
		landCover: !!summary.landCover,
		groundwater: [...farms, ...others].some((f) => f.avgGroundwaterM3Day !== undefined),
		demandObjects: farms.some((f) => !!f.demandObjects?.length),
		// A unit's river abstractions (engine ≥ 1.65.0, docs/model.md §2.7j), with their pumps' limits from 1.66.0.
		riverTakes: farms.some((f) => !!f.riverTakes?.length),
		users: others.length > 0,
		// Other water users with a pump capacity (engine ≥ 1.58.0): their own table, drawn beside the curtailment table too.
		userPumps: others.some((u) => u.avgPumpLimitedM3Day !== undefined)
	};
}

/**
 * The run has any of the tables: land cover, boreholes (units or users), a
 * unit's demand objects, its river abstractions (engine ≥ 1.65.0), other
 * water users' pumps (engine ≥ 1.58.0), or, with `users`, other water users.
 */
export function hasHumanImpacts(summary: Pick<RunSummary, 'landCover' | 'users' | 'farms'>, users = true): boolean {
	const p = parts(summary);
	return p.landCover || p.groundwater || p.demandObjects || p.riverTakes || p.userPumps || (users && p.users);
}

/**
 * Whether Hydrological units draws the Other water users table with the others:
 * only when the curtailment table doesn't list them already (a run without
 * curtailment targets, engine < 0.22.0), so the page has one copy (issue #137).
 */
export const usersTableOnSupply = (summary: Pick<RunSummary, 'curtailment'>): boolean => !summary.curtailment?.otherUsers?.length;

/**
 * The run Summary's line pointing at these tables on Hydrological units (issue
 * #137): what the run has, and the panel it is in there. Other uses when it
 * draws any of them; the curtailment targets when the run's only ones are
 * other users and the curtailment table lists them. null with none.
 */
export function otherUsesLink(summary: Pick<RunSummary, 'landCover' | 'users' | 'farms' | 'curtailment'>): { hash: 'res-other-uses' | 'res-curtailment'; what: string; where: string } | null {
	const p = parts(summary);
	const usersHere = usersTableOnSupply(summary);
	const names = [p.landCover && 'land cover', p.groundwater && 'groundwater', p.demandObjects && 'demand objects', p.riverTakes && 'river abstractions', p.users && usersHere && 'other water users', p.userPumps && 'other water users’ pumps'].filter(
		(x): x is string => !!x
	);
	if (names.length) {
		const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
		return { hash: 'res-other-uses', what: list[0]!.toUpperCase() + list.slice(1), where: 'Other uses on Hydrological units' };
	}
	if (p.users) return { hash: 'res-curtailment', what: 'Other water users', where: 'the curtailment targets on Hydrological units' };
	return null;
}
