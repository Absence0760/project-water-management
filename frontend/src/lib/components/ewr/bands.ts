// The EWR traffic light's bands in words, for the legends of EWR compliance by
// month (EwrHeatmap) and the Summary's reserve strip. The cut-offs are the
// engine's (reserve/trafficLight.ts), the portfolio's defaults, so the three
// read a month the same way. Apart from heatmap.ts so the Summary's chunk
// doesn't carry the heat map's helpers.
import { EWR_TRAFFIC_LIGHT, type EwrBand, type EwrTrafficLight } from '@water-management/engine';
import { fmtNum } from '$lib/format/number';

export const EWR_BANDS: readonly EwrBand[] = ['green', 'amber', 'red'];

const pct = (n: number) => `${fmtNum(n)}%`;

/**
 * Each band in words: "Green: under 5% of days not met", "Amber: 5% to under 20%", "Red: 20% or more".
 * `days` names the count ("days below the pragmatic EWR" on the strip beside a rule table).
 */
export function bandLabels(t: EwrTrafficLight = EWR_TRAFFIC_LIGHT, days = 'days not met'): Record<EwrBand, string> {
	return {
		green: `Green: under ${pct(t.green)} of ${days}`,
		amber: `Amber: ${pct(t.green)} to under ${pct(t.amber)}`,
		red: `Red: ${pct(t.amber)} or more`
	};
}
