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
	/** Only in runs that use the feature that makes it (other water users, boreholes, land cover): absent otherwise. */
	optional?: true;
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
	{ key: 'crop_requirement', letter: 'F', formula: 'MAX(0, gross demand) − effective rain used; × the demand factor for the month when a demand.scale scenario set one' },
	{ key: 'demand', letter: null, formula: 'D = F ÷ irrigation efficiency e: the abstraction that meets the crop requirement' },
	{ key: 'supplied', letter: 'G', formula: 'MIN(MAX(Q[t−1] + rain on dam − evaporation − seepage + M + O + K + J − release − dam capacity × minimum operating level, 0), D) (release only with a release rule, WP-3.5)' },
	{ key: 'inflow_upstream', letter: 'H', formula: 'Σ outflow U of the elements directly upstream' },
	{ key: 'runoff', letter: 'I', formula: "natural flow × this farm's share − runoff removed by land cover (only with land cover, WP-1.35)" },
	{
		key: 'landcover_reduction',
		letter: null,
		formula:
			"runoff removed by land cover (invasive plants, forestry) before it reaches the river or dam: taken from natural flow × this farm's share, so I + this = natural flow × share (WP-1.35)",
		optional: true
	},
	{ key: 'transfer', letter: 'J', formula: 'Σ transfers in − Σ transfers out (limited by the month’s rate, daily cap and minimum storage)' },
	{ key: 'upstream_to_dam', letter: 'K', formula: 'H × % upstream inflow to dam' },
	{ key: 'upstream_below_dam', letter: 'L', formula: 'H − K' },
	{ key: 'runoff_to_dam', letter: 'M', formula: 'I × % runoff to dam' },
	{ key: 'runoff_below_dam', letter: 'N', formula: 'I − M' },
	{ key: 'diverted_to_dam', letter: 'O', formula: 'MIN(diversion capacity, L + N)' },
	{ key: 'dam_area', letter: null, formula: 'A_full × (Q[t−1] ÷ dam capacity)^b; A_full as entered, or dam capacity ÷ 3 m. With a survey curve (WP-3.5): the area linear in volume between its rows at Q[t−1] (from 0 m³, 0 m² below the lowest row; the top row\'s area above it)' },
	{ key: 'rain_on_dam', letter: null, formula: 'rain (before any threshold) ÷ 1000 × dam area' },
	{ key: 'dam_evaporation', letter: null, formula: 'MIN(lake factor (the month\'s, when monthly factors are set) × A-pan ÷ days in month ÷ 1000 × dam area, Q[t−1] + rain on dam + J); for b > 1 also at most (1 − seepage per day) × Q[t−1] ÷ b (on a survey curve b = Q[t−1] × the curve\'s slope ÷ dam area)' },
	{ key: 'dam_seepage', letter: null, formula: 'MIN(seepage per day × Q[t−1], Q[t−1] + rain on dam + J − evaporation)' },
	{
		key: 'dam_seepage_lost',
		letter: null,
		formula: 'seepage × (1 − seepage return share): lost from the catchment (to deep groundwater); only when the share is below 1 (WP-3.5)',
		optional: true
	},
	{
		key: 'dam_release',
		letter: 'X',
		formula:
			'before irrigation (WP-3.5): pass inflow MIN(K + M + O, requirement − S, outlet capacity, Q[t−1] + rain on dam − evaporation − seepage + M + O + K + J), requirement = the monthly amount or, when none, Z; fixed MIN(monthly amount, outlet capacity, that storage − dead storage); never < 0',
		optional: true
	},
	{ key: 'interim_storage', letter: 'P', formula: 'Q[t−1] + rain on dam − evaporation − seepage + M + O + K + J − release − G' },
	{ key: 'dam_storage', letter: 'Q', formula: 'MIN(P, dam capacity)' },
	{ key: 'spill', letter: 'R', formula: 'MAX(P − dam capacity, 0)' },
	{ key: 'below_dam_not_diverted', letter: 'S', formula: 'L + N − O' },
	{ key: 'return_flow', letter: 'T', formula: 'loss return fraction β × (1 − e) × G: the share of the application losses that reaches the river' },
	{ key: 'outflow', letter: 'U', formula: 'R + S + T + seepage − seepage lost + release' },
	{ key: 'balance_residual', letter: 'V', formula: '(H + I + J + rain on dam + GW + GWd) − (G − T) − evaporation − (Q[t] − Q[t−1]) − U − Dep − seepage lost; 0 up to float noise (GW, GWd and Dep only with boreholes)' },
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
	{ key: 'ewr_charge_irrigation', letter: null, formula: 'charge × c ÷ (c + MAX(e − c, 0)), c = G − T the consumptive irrigation (e at the binding site); 0 when c = 0' },
	{
		key: 'ewr_binding_site',
		letter: null,
		formula:
			'the binding site of ewr_charge: the EWR site whose share is the largest (on a tie the most downstream), as its index in the run’s sites (0 = the outlet, then gauges by node id); blank on a day with no charge. Only on a farm upstream of two or more sites (engine ≥ 1.5.0)',
		optional: true
	},
	{
		key: 'groundwater_used',
		letter: 'GW',
		formula:
			'boreholes, each within MIN(capacity, annual cap − pumped since 1 October): primary MIN(room, D) first, then supplemental MIN(room, D − surface G), then emergency (drought) likewise while Q[t−1] < its level × dam capacity; part of G (WP-1.34, WP-3.9)',
		optional: true
	},
	{
		key: 'groundwater_to_dam',
		letter: 'GWd',
		formula:
			'dam-target boreholes, before the surface G, at most the dam’s room cap − (S0 + M + O + K + J − release): primary fill it, supplemental add D − primary GW − (S0 + M + O + K + J − release − dead storage), emergency fill it while Q[t−1] < its level × capacity, primary and emergency only on a day with demand left for the dam (engine ≥ 1.7.0); P = S0 + M + O + K + J − release + GWd − (G − GW) (WP-3.9)',
		optional: true
	},
	{
		key: 'river_abstraction',
		letter: 'Gr',
		formula:
			'the river pump, while the supply rule pumps from the river (river first, run of river; trigger from Q[t−1] < trigger × capacity until Q[t−1] ≥ stop × capacity): MIN(pump capacity, MAX(0, S − MAX(Zs, pass-inflow release target)), D − primary GW), before the dam (after it under run of river, where K = M = O = 0); part of G; U = R + S − Gr + T + returned seepage + release − Dep (WP-3.8)',
		optional: true
	},
	{
		key: 'offtake_out',
		letter: null,
		formula:
			'river off-takes from this unit (engine ≥ 1.14.0): Σ over its rules, by priority, of MIN(capacity, MAX(0, flow leaving it − taken by earlier rules − MAX(Zs, hands-off flow, the EWR Z when kept)), the destination’s need ÷ (1 − loss) when sized to demand), pro rata within a priority; U is the flow leaving it less this',
		optional: true
	},
	{
		key: 'offtake_in',
		letter: null,
		formula: 'Σ over the river off-takes into this unit of what each took × (1 − its conveyance loss) (engine ≥ 1.14.0)',
		optional: true
	},
	{
		key: 'offtake_used',
		letter: null,
		formula: 'MIN(off-take water in, D): used first, before the dam, the river pump and the boreholes, which supply D − this; part of G (engine ≥ 1.14.0)',
		optional: true
	},
	{
		key: 'offtake_to_dam',
		letter: null,
		formula: '(in − used) × the share of it the top-up rules brought: into the dam (S0 + M + O + K + J + this); the rest of what arrived joins U (engine ≥ 1.14.0)',
		optional: true
	},
	{
		key: 'dam_storage_set',
		letter: null,
		formula: 'the storage reset (settings.damStorageReset, the review triggers, engine ≥ 0.46.0): on its day, the storage set (clamped to 0 … capacity) − Q[t−1], and that day starts from Q[t−1] + this; 0 on every other day',
		optional: true
	},
	{ key: 'depletion_store', letter: 'Sd', formula: 'Sd[t−1] + Σ d × pumped − due; due = (1 − e^(−1/lag)) × (Sd[t−1] + Σ d × pumped), all of it when lag = 0; each borehole its own d', optional: true },
	{ key: 'baseflow_depletion', letter: 'Dep', formula: 'MIN(Dd[t−1] + due, R + S + T + returned seepage + release): taken from the flow leaving the farm, so U = R + S + T + returned seepage + release − Dep', optional: true },
	{ key: 'depletion_deficit', letter: 'Dd', formula: 'Dd[t−1] + due − Dep: depletion owed to the river while it had no flow left, carried over and taken off the first flow back (engine ≥ 1.10.0)', optional: true },
	{
		key: 'senior_requirement',
		letter: 'Zs',
		formula: "Σ Zs of the elements directly upstream + this farm's share of the senior users' demand below it (demand × share ÷ Σ shares upstream of the user); only with senior users (WP-1.33)",
		optional: true
	},
	{
		key: 'passed_for_senior',
		letter: null,
		formula: 'kept out of the dam so S ≥ MIN(Zs, H + I): O is cut first, then K and M pro rata; 0 without senior users (WP-1.33)',
		optional: true
	}
];

/** Other water users (engine ≥ 0.22.0, WP-1.33, docs/model.md §2.7c). No letters: the workbook has no such element. */
export const USER_COLUMNS: readonly FarmColumn[] = [
	{ key: 'demand', letter: null, formula: 'the monthly demand from the river (m³/day) for the day’s month, × the demand factor for the month when a demand.scale scenario set one' },
	{ key: 'inflow_upstream', letter: 'H', formula: 'Σ outflow U of the elements directly upstream' },
	{ key: 'supplied', letter: 'G', formula: 'senior: MIN(demand, H); junior: MIN(demand, MAX(0, H − Σ upstream Zs))' },
	{ key: 'return_flow', letter: 'T', formula: 'return share × G' },
	{ key: 'outflow', letter: 'U', formula: 'H − G + T' },
	{ key: 'deficit', letter: null, formula: 'demand − G' },
	{ key: 'ewr_cumulative', letter: 'Z', formula: 'Σ Z of the elements directly upstream (a user has no EWR share)' },
	{ key: 'ewr_shortfall', letter: 'AA', formula: 'MIN(U − Z, 0)' },
	{ key: 'ewr_charge', letter: null, formula: 'as a farm’s, with net impact e = H − U = G − T' },
	{ key: 'senior_requirement', letter: 'Zs', formula: 'senior: MAX(0, Σ upstream Zs − demand); junior: Σ upstream Zs; only with senior users', optional: true },
	{ key: 'groundwater_used', letter: 'GW', formula: 'boreholes: supplemental MIN(capacity, demand − river take), primary MIN(capacity, demand) first; part of G (WP-1.34)', optional: true },
	{ key: 'depletion_store', letter: 'Sd', formula: 'Sd[t−1] + Σ d × pumped − due', optional: true },
	{ key: 'baseflow_depletion', letter: 'Dep', formula: 'MIN(Dd[t−1] + due, H − river take + T); U = H − river take + T − Dep', optional: true },
	{ key: 'depletion_deficit', letter: 'Dd', formula: 'Dd[t−1] + due − Dep (engine ≥ 1.10.0)', optional: true }
];

/** Gauges record only these (docs/model.md §2.7, GaugeTemplate). */
export const GAUGE_COLUMNS: readonly FarmColumn[] = [
	{ key: 'inflow_upstream', letter: 'G', formula: 'Σ outflow U of the elements directly upstream' },
	{ key: 'outflow', letter: null, formula: 'the same as the inflow: a gauge only measures' },
	{ key: 'ewr_cumulative', letter: 'H', formula: 'Σ Z of the elements directly upstream' },
	{ key: 'ewr_shortfall', letter: 'I', formula: 'MIN(flow − required EWR, 0)' },
	{ key: 'ewr_charged', letter: null, formula: '−MIN(shortfall, Σ MAX(e, 0)) over the farms upstream, e = H + I + J − U with only the transfers inside the gauge’s catchment (audit Q17)' },
	{ key: 'ewr_natural', letter: null, formula: 'shortfall − charged: the part natural flow already missed' },
	{ key: 'senior_requirement', letter: 'Zs', formula: 'Σ Zs of the elements directly upstream; only with senior users (WP-1.33)', optional: true }
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

/**
 * The legacy [Flow data] port's columns, with their workbook letters: for
 * reading runs saved before engine 1.0.0 removed that model (issue #16). No
 * run stores them now. No stores to balance.
 */
export const LEGACY_RUNOFF_COLUMNS: readonly FarmColumn[] = [
	{ key: 'rain_used', letter: 'R', formula: 'catchment rain, else CHIRPS, else forecast rain; 0 at or below the rain threshold' },
	{ key: 'is_summer', letter: 'N', formula: '1 in a summer month; in winter stays 0 until a summer month, and turns 0 on enough rain today or yesterday' },
	{ key: 'rain_flow', letter: 'V', formula: 'a × P^b × catchment area (km²) × 1000 × (summer or winter factor)' },
	{ key: 'base_flow', letter: 'S', formula: 'S[t−1] receded one day, or V when V ÷ that > the base-flow reset ratio' },
	{ key: 'response_flow', letter: 'X', formula: 'Y[t−1] receded one day + V on a rainy day, else X[t−1] receded along its own index' },
	{ key: 'resultant_flow', letter: 'Y', formula: 'MAX(X, S)' },
	{ key: 'natural_flow', letter: 'AB', formula: 'MAX(Y, 0)' }
];
