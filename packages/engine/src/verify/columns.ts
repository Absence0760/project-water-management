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
	{ key: 'dam_evaporation', letter: null, formula: 'MIN(lake factor × A-pan ÷ days in month ÷ 1000 × dam area, Q[t−1] + rain on dam + J); for b > 1 also at most (1 − seepage per day) × Q[t−1] ÷ b' },
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

// The catchment's runoff-model columns (node_id NULL in run_series), in the
// order the model computes them, for the catchment day trace (docs/ui.md §
// Self-checks). `letter` is the symbol docs/model.md § "Rain to flow: GR4J"
// uses. Depths are mm over the catchment; stores are end-of-day contents.

/** GR4J (engine ≥ 0.5.0): the runoff/gr4j.ts step, one day. */
export const GR4J_COLUMNS: readonly FarmColumn[] = [
	{ key: 'rain_used', letter: 'P', formula: 'catchment rain, else CHIRPS, else forecast rain (no threshold); a day with none counts as dry' },
	{ key: 'pet', letter: 'E', formula: 'pan coefficient × A-pan for the month ÷ calendar days in the month' },
	{
		key: 'aet',
		letter: 'AET',
		formula: 'MIN(P, E) + Es; Es = S·(2 − S/X1)·tanh(En/X1) ÷ (1 + (1 − S/X1)·tanh(En/X1)), En = MAX(E − P, 0), S = S[t−1]'
	},
	{
		key: 'production_store',
		letter: 'S',
		formula:
			'S[t−1] + Ps − Es − Perc; Ps = X1·(1 − (S/X1)²)·tanh(Pn/X1) ÷ (1 + S/X1·tanh(Pn/X1)), Pn = MAX(P − E, 0); Perc = S′·(1 − (1 + (4S′ ÷ 9X1)⁴)^−¼), S′ = S[t−1] + Ps − Es'
	},
	{
		key: 'uh_store',
		letter: 'UH',
		formula: 'UH[t−1] + Pr − Q9 − Q1; Pr = Perc + Pn − Ps, 90 % spread over UH1 (base X4, Q9 released today), 10 % over UH2 (base 2·X4, Q1)'
	},
	{
		key: 'exchange',
		letter: 'F',
		formula: 'X2 × (R[t−1] ÷ X3)^3.5, added to the routing store and to the direct flow, clipped so neither goes below 0 (+ gained, − lost); not stored, so 0, when X2 = 0'
	},
	{ key: 'routing_store', letter: 'R', formula: 'R′ − Qr; R′ = MAX(0, R[t−1] + Q9 + F), Qr = R′·(1 − (1 + (R′ ÷ X3)⁴)^−¼)' },
	{ key: 'natural_flow', letter: 'Q', formula: '(Qr + Qd) × catchment area (km²) × 1000; Qd = MAX(0, Q1 + F)' }
];

/** The legacy [Flow data] port (runoff/legacy.ts, flow.ts), with its workbook column letters. No stores to balance. */
export const LEGACY_RUNOFF_COLUMNS: readonly FarmColumn[] = [
	{ key: 'rain_used', letter: 'R', formula: 'catchment rain, else CHIRPS, else forecast rain; 0 at or below the rain threshold' },
	{ key: 'is_summer', letter: 'N', formula: '1 in a summer month; in winter stays 0 until a summer month, and turns 0 on enough rain today or yesterday' },
	{ key: 'rain_flow', letter: 'V', formula: 'a × P^b × catchment area (km²) × 1000 × (summer or winter factor)' },
	{ key: 'base_flow', letter: 'S', formula: 'S[t−1] receded one day, or V when V ÷ that > the base-flow reset ratio' },
	{ key: 'response_flow', letter: 'X', formula: 'Y[t−1] receded one day + V on a rainy day, else X[t−1] receded along its own index' },
	{ key: 'resultant_flow', letter: 'Y', formula: 'MAX(X, S)' },
	{ key: 'natural_flow', letter: 'AB', formula: 'MAX(Y, 0)' }
];
