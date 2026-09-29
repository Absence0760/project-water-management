// Groundwater abstraction per farm or user across the water years of a run
// (engine ≥ 0.36.0, WP-3.9, RunSummary.groundwaterAnnualUse): what the
// results table shows beside the annual caps and the GN 538 volume (the
// property's own from engine 1.12.0, else the 40 000 m³/a ceiling). The app
// shows modelled use against them; it never decides legality.
import type { GroundwaterAnnualUse } from '@water-management/engine';

export interface GroundwaterNode {
	nodeId: string;
	name: string;
	/** Its water years, as the run reports them (ascending). */
	years: GroundwaterAnnualUse[];
	/** Pumped per year on average: Σ pumped ÷ Σ days × 365.25 (m³/a), so partial first and last years count by their length. */
	meanM3Year: number;
	/** The stream depletion that pumping caused, per year on average, weighed the same way (m³/a). */
	depletionM3Year: number;
	/** The year it pumped most, and how much. */
	maxYear: GroundwaterAnnualUse;
	/** The GN 538 volume the run gave it, m³/a (the same every year). */
	gaLimitM3: number;
	/** 'property' = area × Table 2 rate; 'ceiling' = unknown, or a run before engine 1.12.0. */
	gaBasis: 'property' | 'ceiling';
	/** The most pumped in any 12 consecutive months (GN 538's year), m³; null on runs before engine 1.12.0 or shorter than 12 months. */
	max12M3: number | null;
	/**
	 * Water years in which it pumped more than the GN 538 volume, either over
	 * the water year or over some 12 consecutive months ending in it.
	 */
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
		const depleted = years.reduce((s, y) => s + y.streamDepletionM3, 0);
		const days = years.reduce((s, y) => s + y.days, 0);
		const rolling = years.map((y) => y.rolling12MaxM3).filter((v): v is number => typeof v === 'number');
		return {
			nodeId,
			name: years[0]!.name,
			years,
			meanM3Year: days > 0 ? (pumped / days) * 365.25 : 0,
			depletionM3Year: days > 0 ? (depleted / days) * 365.25 : 0,
			maxYear: years.reduce((m, y) => (y.abstractionM3 > m.abstractionM3 ? y : m)),
			gaLimitM3: years[0]!.gaLimitM3,
			gaBasis: years[0]!.gaBasis ?? 'ceiling',
			max12M3: rolling.length ? Math.max(...rolling) : null,
			yearsAboveGa: years.filter((y) => aboveGa(y)).length,
			yearsCapReached: years.filter((y) => y.boreholes.some((b) => b.capReached)).length
		};
	});
}

/** A water year above the GN 538 volume: over the year, or over any 12 consecutive months ending in it. */
export const aboveGa = (y: Pick<GroundwaterAnnualUse, 'abstractionM3' | 'rolling12MaxM3' | 'gaLimitM3'>): boolean =>
	Math.max(y.abstractionM3, y.rolling12MaxM3 ?? 0) > y.gaLimitM3;
