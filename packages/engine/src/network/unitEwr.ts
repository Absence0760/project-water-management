// Each hydrological unit's EWR met over the run (engine ≥ 1.116.0, docs/model.md
// §2.11c): the volume of the EWR required at the unit that the flow passing it
// covered. The EWR page's "On the map" card shades each unit's area by it
// (docs/ui.md § EWR). Pure; unit-tested in unitEwr.test.ts.
//
// Z is the unit's cumulative EWR (its own share plus the shares above it,
// §2.5 and §2.7, the `ewr_cumulative` series), U its outflow (`outflow`) and
// AA = MIN(U − Z, 0) its shortfall (`ewr_shortfall`, with the float-noise
// tolerance of simulate.ts shortfall). The part of the requirement that passed
// on a day is Z + AA = MIN(U, Z), as the water account's EWR required vs met
// at the sites (§2.11b), so the two can't disagree where a unit is a site.

/** One unit's daily series the figures are summed from. */
export interface UnitEwrInput {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	outflow: ArrayLike<number>;
	/** Z: the EWR required at the unit (its share + the shares above it), m³/day. */
	required: ArrayLike<number>;
	/** AA ≤ 0: the day's shortfall against Z. */
	shortfall: ArrayLike<number>;
}

/** RunSummary.unitEwr: one unit's EWR required, met and its outflow over the run, m³. */
export interface UnitEwrMet {
	nodeId: string;
	name: string;
	kind: 'farm' | 'user';
	/** Σ Z: the EWR required at the unit; 0 for a unit with no EWR share at or above it. */
	requiredM3: number;
	/** Σ MIN(U, Z): the part of the requirement the flow passing the unit covered (≤ requiredM3). */
	metM3: number;
	/** Σ U: the unit's outflow. */
	outflowM3: number;
	/** Days the outflow was below Z (AA < 0). */
	daysNotMet: number;
}

/** -0 → 0. */
const nz = (x: number) => (x === 0 ? 0 : x);

/** Each unit's figures over days 0 … days − 1, in the order given. */
export function unitEwrMet(units: readonly UnitEwrInput[], days: number): UnitEwrMet[] {
	return units.map((u) => {
		let req = 0;
		let met = 0;
		let out = 0;
		let notMet = 0;
		for (let t = 0; t < days; t++) {
			const z = u.required[t]!;
			const aa = u.shortfall[t]!;
			req += z;
			met += Math.max(0, z + Math.min(aa, 0));
			out += u.outflow[t]!;
			if (aa < 0) notMet++;
		}
		return { nodeId: u.nodeId, name: u.name, kind: u.kind, requiredM3: nz(req), metM3: nz(Math.min(met, req)), outflowM3: nz(out), daysNotMet: notMet };
	});
}
