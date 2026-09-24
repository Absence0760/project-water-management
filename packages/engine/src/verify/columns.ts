// The farm's daily columns in the order of the b023 FarmTemplate sheet
// (docs/model.md §2.7), with the column letter and the formula the engine
// uses. The export headers, the summary CSV's column guide and the UI's
// day trace all read this list, so the three can't drift apart.

export interface FarmColumn {
	/** run_series key. */
	key: string;
	/** FarmTemplate column letter; null for the demand columns that come from [Irrigation Demand]. */
	letter: string | null;
	/** How the engine computes it, in the column letters. */
	formula: string;
}

export const FARM_COLUMNS: readonly FarmColumn[] = [
	{ key: 'gross_demand', letter: null, formula: 'Σ crop area × A-pan × crop factor ÷ 1000 ÷ days in month' },
	{
		key: 'effective_rain',
		letter: null,
		formula:
			"MIN(soil store[t−1] + Pe, MAX(0, gross demand)), in m³ (Pe = cropped area × effective rain fraction ÷ 1000 × rain; rain ≤ threshold counts as 0; the store in m³ = mm × cropped area ÷ 1000)"
	},
	{ key: 'soil_water', letter: null, formula: 'MIN(store size, soil store[t−1] + Pe − effective rain used), in mm over the cropped area; starts empty' },
	{ key: 'demand', letter: 'F', formula: 'MAX(0, gross demand) − effective rain used' },
	{ key: 'supplied', letter: 'G', formula: 'MIN(Q[t−1] + M + O + K + J, F)' },
	{ key: 'inflow_upstream', letter: 'H', formula: 'Σ outflow U of the elements directly upstream' },
	{ key: 'runoff', letter: 'I', formula: "natural flow × this farm's share" },
	{ key: 'transfer', letter: 'J', formula: 'Σ transfers in − Σ transfers out (limited by rate, daily cap and minimum storage)' },
	{ key: 'upstream_to_dam', letter: 'K', formula: 'H × % upstream inflow to dam' },
	{ key: 'upstream_below_dam', letter: 'L', formula: 'H − K' },
	{ key: 'runoff_to_dam', letter: 'M', formula: 'I × % runoff to dam' },
	{ key: 'runoff_below_dam', letter: 'N', formula: 'I − M' },
	{ key: 'diverted_to_dam', letter: 'O', formula: 'MIN(diversion capacity, L + N)' },
	{ key: 'interim_storage', letter: 'P', formula: 'Q[t−1] + M + O + K + J − G' },
	{ key: 'dam_storage', letter: 'Q', formula: 'MIN(P, dam capacity)' },
	{ key: 'spill', letter: 'R', formula: 'MAX(P − dam capacity, 0)' },
	{ key: 'below_dam_not_diverted', letter: 'S', formula: 'L + N − O' },
	{ key: 'return_flow', letter: 'T', formula: 'G × return flow %' },
	{ key: 'outflow', letter: 'U', formula: 'R + S + T' },
	{ key: 'balance_residual', letter: 'V', formula: '(H + I + J) − (G − T) − (Q[t] − Q[t−1]) − U; 0 up to float noise' },
	{ key: 'deficit', letter: 'W', formula: 'F − G' },
	{ key: 'ewr', letter: 'Y', formula: "pragmatic EWR × this farm's share" },
	{ key: 'ewr_cumulative', letter: 'Z', formula: 'Y + Σ Z of the elements directly upstream' },
	{ key: 'ewr_shortfall', letter: 'AA', formula: 'MIN(U − Z, 0)' },
	{ key: 'ewr_shortfall_incremental', letter: 'AB', formula: 'MIN(AA − Σ AA of the elements directly upstream, 0)' }
];

/** Gauges record only these (docs/model.md §2.7, GaugeTemplate). */
export const GAUGE_COLUMNS: readonly FarmColumn[] = [
	{ key: 'inflow_upstream', letter: 'G', formula: 'Σ outflow U of the elements directly upstream' },
	{ key: 'outflow', letter: null, formula: 'the same as the inflow: a gauge only measures' },
	{ key: 'ewr_cumulative', letter: 'H', formula: 'Σ Z of the elements directly upstream' },
	{ key: 'ewr_shortfall', letter: 'I', formula: 'MIN(flow − required EWR, 0)' }
];
