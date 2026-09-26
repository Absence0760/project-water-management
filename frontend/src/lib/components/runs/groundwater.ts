// Groundwater abstraction per farm or user across the water years of a run
// (engine ≥ 0.32.0, WP-3.9, RunSummary.groundwaterAnnualUse): what the
// results table shows beside the annual caps and the GN 538 ceiling. The app
// shows modelled use against them; it never decides legality.
import type { GroundwaterAnnualUse } from '@water-management/engine';

export interface GroundwaterNode {
	nodeId: string;
	name: string;
	/** Its water years, as the run reports them (ascending). */
	years: GroundwaterAnnualUse[];
	/** Pumped per year on average: Σ pumped ÷ Σ days × 365.25 (m³/a), so partial first and last years count by their length. */
	meanM3Year: number;
	/** The year it pumped most, and how much. */
	maxYear: GroundwaterAnnualUse;
	/** Water years in which it pumped more than the GN 538 ceiling. */
	yearsAboveGa: number;
	/** Water years in which at least one borehole reached its annual cap. */
	yearsCapReached: number;
}

/** The run's annual rows grouped by node, in the order the run lists them. */
export function groundwaterByNode(rows: readonly GroundwaterAnnualUse[] | undefined): GroundwaterNode[] {
	const by = new Map<string, GroundwaterAnnualUse[]>();
	for (const r of rows ?? []) by.set(r.nodeId, [...(by.get(r.nodeId) ?? []), r]);
	return [...by].map(([nodeId, years]) => {
		const pumped = years.reduce((s, y) => s + y.abstractionM3, 0);
		const days = years.reduce((s, y) => s + y.days, 0);
		return {
			nodeId,
			name: years[0]!.name,
			years,
			meanM3Year: days > 0 ? (pumped / days) * 365.25 : 0,
			maxYear: years.reduce((m, y) => (y.abstractionM3 > m.abstractionM3 ? y : m)),
			yearsAboveGa: years.filter((y) => y.abstractionM3 > y.gaLimitM3).length,
			yearsCapReached: years.filter((y) => y.boreholes.some((b) => b.capReached)).length
		};
	});
}
