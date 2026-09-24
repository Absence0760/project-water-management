// The farm's daily columns in the order of the b023 FarmTemplate sheet
// (docs/model.md §2.7), with the column letter and the formula the engine
// uses. The export headers, the summary CSV's column guide and the UI's
// day trace all read this list, so the three can't drift apart.

export interface FarmColumn {
	/** run_series key. */
	key: string;
	/** FarmTemplate column letter; null for the columns the workbook doesn't have (the [Irrigation Demand] inputs, abstraction demand D). */
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
	{ key: 'crop_requirement', letter: 'F', formula: 'MAX(0, gross demand) − effective rain used' },
	{ key: 'demand', letter: null, formula: 'D = F ÷ irrigation efficiency e: the abstraction that meets the crop requirement' },
	{ key: 'supplied', letter: 'G', formula: 'MIN(MAX(Q[t−1] + rain on dam − evaporation − seepage + M + O + K + J − dam capacity × minimum operating level, 0), D)' },
	{ key: 'inflow_upstream', letter: 'H', formula: 'Σ outflow U of the elements directly upstream' },
	{ key: 'runoff', letter: 'I', formula: "natural flow × this farm's share" },
	{ key: 'transfer', letter: 'J', formula: 'Σ transfers in − Σ transfers out (limited by rate, daily cap and minimum storage)' },
	{ key: 'upstream_to_dam', letter: 'K', formula: 'H × % upstream inflow to dam' },
	{ key: 'upstream_below_dam', letter: 'L', formula: 'H − K' },
	{ key: 'runoff_to_dam', letter: 'M', formula: 'I × % runoff to dam' },
	{ key: 'runoff_below_dam', letter: 'N', formula: 'I − M' },
	{ key: 'diverted_to_dam', letter: 'O', formula: 'MIN(diversion capacity, L + N)' },
	{ key: 'dam_area', letter: null, formula: 'A_full × (Q[t−1] ÷ dam capacity)^b; A_full as entered, or dam capacity ÷ 3 m' },
	{ key: 'rain_on_dam', letter: null, formula: 'rain (before any threshold) ÷ 1000 × dam area' },
	{ key: 'dam_evaporation', letter: null, formula: 'MIN(lake factor × A-pan ÷ days in month ÷ 1000 × dam area, Q[t−1] + rain on dam + J)' },
	{ key: 'dam_seepage', letter: null, formula: 'MIN(seepage per day × Q[t−1], Q[t−1] + rain on dam + J − evaporation)' },
	{ key: 'interim_storage', letter: 'P', formula: 'Q[t−1] + rain on dam − evaporation − seepage + M + O + K + J − G' },
	{ key: 'dam_storage', letter: 'Q', formula: 'MIN(P, dam capacity)' },
	{ key: 'spill', letter: 'R', formula: 'MAX(P − dam capacity, 0)' },
	{ key: 'below_dam_not_diverted', letter: 'S', formula: 'L + N − O' },
	{ key: 'return_flow', letter: 'T', formula: 'loss return fraction β × (1 − e) × G: the share of the application losses that reaches the river' },
	{ key: 'outflow', letter: 'U', formula: 'R + S + T + seepage' },
	{ key: 'balance_residual', letter: 'V', formula: '(H + I + J + rain on dam) − (G − T) − evaporation − (Q[t] − Q[t−1]) − U; 0 up to float noise' },
	{ key: 'deficit', letter: 'W', formula: 'D − G' },
	{ key: 'ewr', letter: 'Y', formula: "pragmatic EWR × this farm's share" },
	{ key: 'ewr_cumulative', letter: 'Z', formula: 'Y + Σ Z of the elements directly upstream' },
	{ key: 'ewr_shortfall', letter: 'AA', formula: 'MIN(U − Z, 0)' },
	{ key: 'ewr_shortfall_incremental', letter: 'AB', formula: 'reach shortfall, a diagnostic only (engine ≥ 0.17.0): MIN(AA − Σ AA of the elements directly upstream, 0)' },
	{
		key: 'ewr_charge',
		letter: null,
		formula:
			"−(largest over the EWR sites below it of D × MAX(e, 0) ÷ Σ MAX(e, 0)), with D = MIN(site shortfall, Σ MAX(e, 0)) and e = H + I + J − U counting only transfers with both ends upstream of the site (audit Q17)"
	},
	{ key: 'ewr_charge_irrigation', letter: null, formula: 'charge × c ÷ (c + MAX(e − c, 0)), c = G − T the consumptive irrigation (e at the binding site); 0 when c = 0' }
];

/** Gauges record only these (docs/model.md §2.7, GaugeTemplate). */
export const GAUGE_COLUMNS: readonly FarmColumn[] = [
	{ key: 'inflow_upstream', letter: 'G', formula: 'Σ outflow U of the elements directly upstream' },
	{ key: 'outflow', letter: null, formula: 'the same as the inflow: a gauge only measures' },
	{ key: 'ewr_cumulative', letter: 'H', formula: 'Σ Z of the elements directly upstream' },
	{ key: 'ewr_shortfall', letter: 'I', formula: 'MIN(flow − required EWR, 0)' },
	{ key: 'ewr_charged', letter: null, formula: '−MIN(shortfall, Σ MAX(e, 0)) over the farms upstream, e = H + I + J − U with only the transfers inside the gauge’s catchment (audit Q17)' },
	{ key: 'ewr_natural', letter: null, formula: 'shortfall − charged: the part natural flow already missed' }
];
