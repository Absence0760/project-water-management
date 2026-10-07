// The EWR traffic light (roadmap D11): a share of days with the EWR not met,
// read as green, amber or red. One place for the cut-offs, so the portfolio's
// status (backend portfolio/status.ts, the defaults a team may override) and
// the workspace's EWR compliance by month and the Summary's reserve strip
// (frontend ewr/heatmap.ts) band the same days the same way. Not part of a
// run: it reads a run's counts, so changing it changes no result.

/** Cut-offs in percent of days not met: green below `green`, amber below `amber`, red otherwise. */
export interface EwrTrafficLight {
	green: number;
	amber: number;
}

/** The defaults: green below 5 %, amber below 20 %. The hydrologist still has to confirm them (plan.md D11). */
export const EWR_TRAFFIC_LIGHT: Readonly<EwrTrafficLight> = Object.freeze({ green: 5, amber: 20 });

export type EwrBand = 'green' | 'amber' | 'red';

/** The band for `daysNotMet` of `days`; null for an empty or impossible count (never a false green). */
export function ewrBand(daysNotMet: number, days: number, t: EwrTrafficLight = EWR_TRAFFIC_LIGHT): EwrBand | null {
	if (!(days > 0) || !(daysNotMet >= 0) || daysNotMet > days) return null;
	// daysNotMet ÷ days < pct ÷ 100, cross-multiplied so no division rounds a
	// boundary (7 of 100 days is 7 %, not 7.000000000000001 %).
	const below = (pct: number) => daysNotMet * 100 < pct * days;
	return below(t.green) ? 'green' : below(t.amber) ? 'amber' : 'red';
}
