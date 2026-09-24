// Contextual help and glossary (the /help page and <HelpTip>).
//
// Written for hydrologists, in our own words, following docs/model.md.
// `source` names where each idea comes from so a reader can check it.
//
// `fields` are the keys a form uses to place a HelpTip next to a field:
//   node.<NetworkNode field>        settings.<ProjectSettings field>
//   calibration.<CalibrationParams field>
//   crop.<CropDef field>            cropArea.<CropArea field>
//   transfer.<Transfer field>       series.<SeriesKind>
//   summary.<FarmSummary field>     catchment.<RunSummary.catchment field>
//   stats.<CalibrationStats field>  run.<run series key>
// A key belongs to exactly one entry (guarded by content.test.ts).

export type HelpCategory =
	| 'basics'
	| 'network'
	| 'farm'
	| 'crops'
	| 'transfers'
	| 'flow'
	| 'ewr'
	| 'data'
	| 'results'
	| 'fit';

export const CATEGORY_TITLES: Record<HelpCategory, string> = {
	basics: 'Basics',
	network: 'Network',
	farm: 'Farms and dams',
	crops: 'Crops and irrigation demand',
	transfers: 'Transfers',
	flow: 'Natural flow and calibration',
	ewr: 'Environmental water requirement',
	data: 'Input data',
	results: 'Run results',
	fit: 'Goodness of fit'
};

export interface HelpEntry {
	/** Stable anchor on /help (`/help#<id>`). Lowercase, hyphenated. */
	id: string;
	term: string;
	/** One sentence, ≤ 140 characters: what the HelpTip shows first. */
	short: string;
	/** Fuller explanation. Paragraphs separated by a blank line. */
	long: string;
	units?: string;
	category: HelpCategory;
	/** Other names people search for (abbreviations, workbook labels). */
	aliases?: string[];
	/** Form/result keys this entry explains (see the header comment). */
	fields?: string[];
	/** Ids of related entries. */
	related?: string[];
	/** Where the concept comes from: a workbook sheet or a doc. */
	source: string;
}

export const HELP: HelpEntry[] = [
	// ---- Basics -------------------------------------------------------------
	{
		id: 'water-balance',
		term: 'Water balance',
		short: 'A day-by-day account of where the catchment’s water goes: runoff, dams, irrigation, transfers and what reaches the outlet.',
		long: 'The model tracks every cubic metre each day. Rain becomes natural flow, natural flow is shared out to the farms, each farm fills its dam, irrigates, spills and passes water downstream, and the outlet gauge receives what is left.\n\nEach farm’s daily balance closes to the cubic metre: inflow minus irrigation use minus the change in storage equals outflow. A catchment answers three questions: how much water is there, can each farm’s irrigation be met, and is enough left in the river for the environment?',
		category: 'basics',
		related: ['natural-flow', 'network', 'ewr'],
		source: 'b023 Help (workbook purpose); docs/model.md §1'
	},
	{
		id: 'project',
		term: 'Project (catchment)',
		short: 'One catchment model: its network, crops, settings, input series and runs. One b023 workbook becomes one project.',
		long: 'A project holds everything for one river catchment. Copy a project to try a what-if without touching the original; runs inside a project record exactly which inputs they used.',
		category: 'basics',
		aliases: ['catchment', 'workbook'],
		related: ['run'],
		source: 'docs/model.md §1'
	},
	{
		id: 'run',
		term: 'Run',
		short: 'One execution of the model on the project as it was at that moment. Results are kept, with a snapshot of the inputs used.',
		long: 'Pressing Run computes every day of the simulation window and stores the daily series and the summary. Later edits to the model don’t change an existing run, so results can always be explained. Each run records the engine version it was computed with.',
		category: 'basics',
		aliases: ['model run', 'engine version'],
		related: ['simulation-window', 'project'],
		source: 'docs/model.md §6'
	},
	{
		id: 'water-year',
		term: 'Water year',
		short: 'October to September, the South African hydrological year. Monthly tables in this app run Oct … Sep.',
		long: 'Monthly inputs (A-pan evaporation, crop factors, pragmatic EWR) are entered in water-year order, starting with October. Transfer months and summer months use calendar month numbers (1 = January).',
		category: 'basics',
		aliases: ['hydrological year'],
		source: 'docs/model.md §2.1'
	},
	{
		id: 'units',
		term: 'Units: m³/day, m³/s, M.m³',
		short: 'Flows and volumes are m³/day inside the model. 1 m³/s = 86 400 m³/day; 1 M.m³ = one million m³.',
		long: 'Gauge and Pitman flow series are usually supplied in m³/s and converted to m³/day on the way in. Dam capacities and storage are in m³. Mean annual runoff is often quoted in M.m³ per year.\n\nA quick check: 1 l/s ≈ 86 m³/day, and 1 000 m³/day ≈ 11.6 l/s.',
		units: 'm³/day, m³/s, m³, M.m³',
		category: 'basics',
		aliases: ['m3/day', 'm3/s', 'cumecs', 'l/s', 'million cubic metres', 'Mm3'],
		source: 'docs/model.md §2.1, §7'
	},
	{
		id: 'february-days',
		term: 'Days in February',
		short: 'Days used for February when a monthly volume is turned into a daily rate. 28.25 gives a 365.25-day year.',
		long: 'Monthly crop requirements are divided by the days in the month to get a daily demand. Use 28.25 to average over leap years (the b023 default) or 28 for a strict 365-day year.',
		units: 'days',
		category: 'basics',
		fields: ['settings.februaryDays'],
		related: ['irrigation-demand'],
		source: 'b023 Help (AppSettings, month and day labels)'
	},
	{
		id: 'simulation-window',
		term: 'Simulation window',
		short: 'Optional first and last day to simulate. Leave empty to run over the whole period covered by the input series.',
		long: 'Narrow the window to study a drought or to match a calibration period. Dams start from their initial storage on the first simulated day, so allow a warm-up period before the dates you care about.',
		category: 'basics',
		aliases: ['start date', 'end date', 'period'],
		fields: ['settings.simulationStart', 'settings.simulationEnd'],
		related: ['dam-initial', 'calibration'],
		source: 'b023 Help (Calc. Model date window)'
	},
	{
		id: 'calibration-window',
		term: 'Calibration window',
		short: 'The period, and the observed flow record, used to score the model fit. Leave empty to score every day with an observation.',
		long: 'Hydrologists usually calibrate on a period with reliable observations rather than the whole record — the client catchment workbook uses Oct 2010 to Sep 2018 against the A1 logger. Choose which observed series to compare against (gauge, logger or Pitman). The fit statistics and the annual volume table only count days inside this window.',
		category: 'fit',
		aliases: ['calibration period', 'observed flow record'],
		fields: ['settings.calibrationStart', 'settings.calibrationEnd', 'settings.calibrationFlowKind'],
		related: ['calibration', 'nse'],
		source: 'b023 [Flow Calibration Cfg] date range and flow choice; docs/model.md §2.10'
	},
	{
		id: 'gauge-logger-agreement',
		term: 'Gauge vs logger agreement',
		short: 'Flags water years where the observed gauge and the logger disagree by more than the set ratio, on enough shared days.',
		long: 'Two instruments on the same river should roughly agree. Each water year, the gauge volume is compared with the logger volume on the days both have a reading. A year is flagged when the ratio is below the lowest ratio or above the highest ratio (defaults 67 % and 150 %), and only when the year has at least the minimum number of shared days (default 90). A flagged year usually means a problem at one instrument, so choose the record you trust as the calibration flow series. The thresholds only change which years are flagged, never the model results. The Time series tab also lists negative values, outliers and flat stretches in each series, and catchment rain that reads 0 where it looks missing (a zero blocks the CHIRPS fallback a blank day gets).',
		category: 'fit',
		aliases: ['data quality', 'observed flow agreement', 'logger check'],
		fields: ['settings.dataQuality'],
		related: ['calibration-window'],
		source: 'Not in the workbook; docs/model.md §2.10a'
	},
	{
		id: 'report-window',
		term: 'Reporting window',
		short: 'The period the curtailment report (targets and reduce/gain per farm) averages over. Empty = the whole run.',
		long: 'Pick a critical period — a dry season or a drought year — to see how much each farm would need to reduce for irrigation to balance and the EWR to be met in that period. A window partly outside the run is clipped to it.',
		category: 'basics',
		aliases: ['reporting period', 'shortfall period'],
		fields: ['settings.reportStart', 'settings.reportEnd'],
		related: ['ewr'],
		source: 'b023 [Shortfalls] "Set reporting period"; docs/model.md §2.11'
	},

	// ---- Network ------------------------------------------------------------
	{
		id: 'network',
		term: 'Network',
		short: 'How the farms and gauges connect: each element drains into exactly one element downstream, ending at the outflow gauge.',
		long: 'The network is a tree. An element can receive water from several upstream elements but sends all of its outflow to one downstream element; a river that splits (bifurcation) is not modelled directly — use a transfer, or merge the farms.\n\nThe model works out the calculation order itself, upstream first, so each element sees its upstream neighbours’ outflow on the same day.',
		category: 'network',
		aliases: ['tree', 'topology', 'calculation order', 'bifurcation'],
		fields: ['node.downstreamNodeId'],
		related: ['element-farm', 'element-gauge', 'outflow-gauge', 'transfer'],
		source: 'b023 Help (Network sheet)'
	},
	{
		id: 'element-farm',
		term: 'Farm element',
		short: 'A piece of the catchment with its own runoff share, optional dam and irrigation. Can also stand for a stand-alone dam or natural area.',
		long: 'Model each farm as the land it occupies. The same element type covers three cases, set by its parameters:\n\n• Farm — crops, a dam if it has one, return flow.\n• Stand-alone dam — no crop areas, all of its runoff (and upstream inflow, if the dam sits on the main stem) captured by the dam, no return flow or diversion.\n• Natural (unused) area — no crops, no dam capture, no diversion, no return flow: it simply passes its runoff downstream.',
		category: 'network',
		aliases: ['farm', 'node', 'stand-alone dam', 'natural area', 'element'],
		fields: ['node.kind', 'node.name'],
		related: ['network', 'dam-capacity', 'flow-share'],
		source: 'b023 Models sheet'
	},
	{
		id: 'element-gauge',
		term: 'Gauge element',
		short: 'A measuring point that only passes flow through and reports it, with its EWR check. It has no runoff, dam or demand.',
		long: 'Use gauges where you want to read the simulated flow, for example at a weir with a record. The last gauge in the network is the outflow gauge.',
		category: 'network',
		aliases: ['gauge', 'weir'],
		related: ['outflow-gauge'],
		source: 'b023 Network sheet'
	},
	{
		id: 'outflow-gauge',
		term: 'Outflow gauge',
		short: 'The single element at the bottom of the network. Its simulated flow is compared with the EWR and with observed flow.',
		long: 'Exactly one element has nothing downstream of it. Its flow is the catchment’s simulated outflow: the series checked against the pragmatic EWR and, when an observed record exists, used for the calibration statistics.',
		category: 'network',
		aliases: ['outlet', 'catchment outlet'],
		fields: ['run.simulated_outflow', 'catchment.meanSimulatedOutflowM3Day'],
		related: ['ewr', 'nse'],
		source: 'b023 Network sheet (Network Outflow Gauge)'
	},

	// ---- Farms and dams -----------------------------------------------------
	{
		id: 'farm-area',
		term: 'Farm area',
		short: 'Land area of the farm element, in km². Drives its share of catchment runoff under the Area method.',
		long: 'The total area is used by the Area flow-share method and, summed over all farms, as the default catchment area that rain falls on. Hi/Lo areas split the same land by rainfall zone.',
		units: 'km²',
		category: 'farm',
		aliases: ['total area', 'catchment area of farm'],
		fields: ['node.areaKm2'],
		related: ['flow-share', 'catchment-area'],
		source: 'b023 Farm spec'
	},
	{
		id: 'hi-lo-map-area',
		term: 'High-MAP and low-MAP area',
		short: 'The farm’s land in the wetter (high mean annual precipitation) and drier parts of the catchment, in km².',
		long: 'Used by the Hi/Lo flow-share method: wetter land produces more runoff per km², so the farm’s share is weighted by where its land lies rather than by area alone.',
		units: 'km²',
		category: 'farm',
		aliases: ['area hi', 'area lo', 'high MAP', 'low MAP'],
		fields: ['node.areaHiKm2', 'node.areaLoKm2'],
		related: ['flow-share', 'hi-lo-split', 'map'],
		source: 'b023 Farm spec'
	},
	{
		id: 'flow-share',
		term: 'Flow share (fragmentation)',
		short: 'The fixed fraction of catchment natural flow (and EWR) assigned to each farm. Shares should add up to 100 %.',
		long: 'Catchment natural flow is split into per-farm runoff by a fixed share per farm. Three methods:\n\n• Area — the farm’s area over the total area.\n• Hi/Lo — area-weighted separately in the high- and low-rainfall zones, then combined with the Hi/Lo split.\n• Manual — a share you enter per farm, typically computed in a separate study.\n\nThe same shares divide the pragmatic EWR into per-farm EWR shares. A warning appears when the shares don’t sum to 1 (tolerance 0.0002).',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		aliases: ['fragmentation', 'fragmented flow', 'share'],
		fields: ['settings.flowShareMethod', 'node.flowShareManual'],
		related: ['hi-lo-split', 'farm-area', 'natural-flow'],
		source: 'b023 Farm spec; docs/model.md §2.5'
	},
	{
		id: 'hi-lo-split',
		term: 'Hi/Lo split',
		short: 'How much of the runoff comes from the high-rainfall zone versus the low one (b023 default 81 % / 19 %). Used by the Hi/Lo method.',
		long: 'Typically taken from a Pitman study of the catchment. The two numbers should add up to 1.',
		units: 'fraction 0–1',
		category: 'farm',
		aliases: ['Pitman split', 'hi MAP flow %', 'lo MAP flow %'],
		fields: ['settings.hiLoSplit'],
		related: ['flow-share', 'pitman'],
		source: 'b023 Farm spec'
	},
	{
		id: 'upstream-to-dam',
		term: 'Upstream inflow share (dam)',
		short: 'Fraction of the water arriving from upstream that is routed past the farm dam, per the workbook formula. Awaiting confirmation.',
		long: 'The b023 column is labelled “upstream inflow above dam”, but its formula sends this fraction of upstream inflow below the dam and only the remainder into it. The app reproduces the formula so results match the workbook.\n\nThis is open question Q1 for the hydrologist: under the label’s meaning, 100 % would put all upstream water into the dam; under the formula, 100 % keeps it all out (except what the diversion capacity brings back).',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		aliases: ['upstream inflow above dam', 'upstream to dam'],
		fields: ['node.pctUpstreamToDam'],
		related: ['runoff-to-dam', 'diversion'],
		source: 'b023 Farm spec; docs/model.md §3 Q1'
	},
	{
		id: 'runoff-to-dam',
		term: 'Own runoff into dam',
		short: 'Fraction of the farm’s own runoff that drains into its dam. The rest joins the river below the dam.',
		long: 'Set 100 % for a dam that captures the farm’s whole area, 0 % for a natural area or a farm whose dam doesn’t intercept its land.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		aliases: ['farm runoff above dam', 'runoff to dam'],
		fields: ['node.pctRunoffToDam'],
		related: ['upstream-to-dam', 'dam-capacity'],
		source: 'b023 Farm spec'
	},
	{
		id: 'dam-capacity',
		term: 'Dam capacity',
		short: 'Combined full-supply volume of the farm’s dams, in m³. 0 means no storage: water not used the same day flows on.',
		long: 'b023 treats a farm’s dams as one composite dam. Water above capacity spills downstream the same day. Dam evaporation and seepage are not modelled.',
		units: 'm³',
		category: 'farm',
		aliases: ['composite dam', 'storage capacity', 'full supply'],
		fields: ['node.damCapacityM3'],
		related: ['dam-initial', 'dam-min', 'spill', 'dam-storage'],
		source: 'b023 Farm spec'
	},
	{
		id: 'dam-initial',
		term: 'Initial dam storage',
		short: 'How full the dam is on the first simulated day, as a fraction of capacity.',
		long: 'The first weeks of a run depend on this guess. Starting half full (the b023 default) is usual; begin the simulation before the period you study so the dams settle.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		fields: ['node.damInitialPct'],
		related: ['dam-capacity', 'simulation-window'],
		source: 'b023 Farm spec'
	},
	{
		id: 'dam-min',
		term: 'Minimum dam storage',
		short: 'A reserve level recorded with the dam, as a fraction of capacity. The model does not use it yet: neither irrigation nor transfers read it.',
		long: 'Irrigation can empty the dam completely. A transfer keeps its own minimum storage in the source dam (set on the transfer, not here). Whether this dam-level reserve should limit irrigation or transfers is open question Q5 for the hydrologist; until then changing it does not change results.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		aliases: ['min dam volume'],
		fields: ['node.damMinPct'],
		related: ['transfer', 'transfer-min-storage'],
		source: 'b023 Farm spec; docs/model.md §3 Q5'
	},
	{
		id: 'diversion',
		term: 'Diversion back to dam',
		short: 'Daily capacity to pump or channel water from the river below the dam back into it, in m³/day.',
		long: 'Each day up to this volume is taken from the water passing below the dam (upstream inflow and runoff that bypass it) and put into storage. b023 enters it in m³/s; the app stores m³/day.',
		units: 'm³/day',
		category: 'farm',
		aliases: ['downstream diversion', 'divert capacity', 'pump back'],
		fields: ['node.divertCapacityM3Day'],
		related: ['upstream-to-dam', 'runoff-to-dam'],
		source: 'b023 Farm spec'
	},
	{
		id: 'return-flow',
		term: 'Irrigation return flow',
		short: 'Fraction of the water used for irrigation that runs back into the river the same day.',
		long: 'Over-irrigation, leaks and drainage return part of the applied water. It adds to the farm’s outflow. Set 0 % for a stand-alone dam or natural area.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		fields: ['node.returnFlowPct'],
		related: ['irrigation-supplied'],
		source: 'b023 Farm spec'
	},
	{
		id: 'spill',
		term: 'Spill',
		short: 'Water that overflows a full dam and continues downstream, in m³/day.',
		long: 'Anything left above capacity after the day’s inflow, transfers and irrigation. It is part of the farm’s outflow.',
		units: 'm³/day',
		category: 'farm',
		fields: ['run.spill'],
		related: ['dam-capacity'],
		source: 'b023 farm element sheet'
	},
	{
		id: 'dam-storage',
		term: 'Dam storage',
		short: 'Volume in the dam at the end of each day, in m³.',
		long: 'Yesterday’s storage plus today’s captured runoff, captured upstream inflow, diversion and transfers, minus irrigation, capped at capacity.',
		units: 'm³',
		category: 'farm',
		fields: ['run.dam_storage'],
		related: ['dam-capacity', 'spill'],
		source: 'b023 farm element sheet'
	},

	// ---- Crops and irrigation demand -----------------------------------------
	{
		id: 'apan',
		term: 'A-pan evaporation',
		short: 'Monthly evaporation from a Class-A pan, in mm (WR90). Times a crop factor it estimates the crop’s water need.',
		long: 'Enter the 12 monthly values for the catchment, Oct … Sep, usually from the WR90 or WR2012 quaternary data.',
		units: 'mm per month',
		category: 'crops',
		aliases: ['A pan', 'Apan', 'evaporation', 'WR90'],
		fields: ['settings.apanMm'],
		related: ['crop-factor', 'irrigation-demand', 'wr90'],
		source: 'b023 Crop demand; docs/model.md §7'
	},
	{
		id: 'crop-factor',
		term: 'Crop factor (Kc)',
		short: 'Monthly multiplier from A-pan evaporation to a crop’s water use. 12 values, Oct … Sep.',
		long: 'Gross requirement (mm) = A-pan × crop factor for that month. Factors vary with the growth stage; deciduous fruit, for example, needs little in winter.',
		units: 'dimensionless',
		category: 'crops',
		aliases: ['Kc', 'crop coefficient'],
		fields: ['crop.cropFactor', 'crop.name'],
		related: ['apan', 'crop-area'],
		source: 'b023 Crop demand'
	},
	{
		id: 'crop-area',
		term: 'Crop area',
		short: 'Area of each crop on each farm, in m². Leave a crop at 0 on farms that don’t grow it.',
		long: 'The farm’s demand is the sum over its crops of area × requirement. Stand-alone dams and natural areas have no crop area.',
		units: 'm² (10 000 m² = 1 ha)',
		category: 'crops',
		aliases: ['cropped area', 'hectares', 'farm demand'],
		fields: ['cropArea.areaM2'],
		related: ['crop-factor', 'irrigation-demand'],
		source: 'b023 Farm demand'
	},
	{
		id: 'effective-rainfall',
		term: 'Effective rainfall fraction',
		short: 'Share of rain on cropped land that counts towards the crop’s need and so reduces irrigation (b023 default 0.65).',
		long: 'Rain above the rain threshold reduces the day’s net demand by cropped area × rain × this fraction. Light rain at or below the threshold never reduces demand.',
		units: 'fraction 0–1',
		category: 'crops',
		aliases: ['effective rain'],
		fields: ['settings.effectiveRainFraction'],
		related: ['irrigation-demand', 'rain-threshold'],
		source: 'b023 Crop demand; docs/model.md §2.3'
	},
	{
		id: 'irrigation-demand',
		term: 'Irrigation demand (net)',
		short: 'Water the farm’s crops need from irrigation on a given day, after effective rain, in m³/day.',
		long: 'Gross demand comes from crop areas × A-pan × crop factor, spread over the days of the month. Net demand subtracts the effective rain on cropped land, and never goes below zero.',
		units: 'm³/day',
		category: 'crops',
		aliases: ['demand', 'crop water requirement'],
		fields: ['run.demand', 'summary.avgDemandM3Day'],
		related: ['irrigation-supplied', 'irrigation-deficit', 'effective-rainfall'],
		source: 'b023 Irrigation Demand; docs/model.md §2.3'
	},
	{
		id: 'irrigation-supplied',
		term: 'Irrigation supplied',
		short: 'Water actually delivered to the crops that day: the demand, or less when the dam and inflows run short.',
		long: 'Irrigation draws on yesterday’s storage plus today’s captured inflows and transfers. Average supplied ÷ average demand is the fraction of demand supplied.',
		units: 'm³/day',
		category: 'crops',
		aliases: ['supply'],
		fields: ['run.supplied', 'summary.avgSuppliedM3Day'],
		related: ['irrigation-demand', 'irrigation-deficit'],
		source: 'b023 farm element sheet; Shortfalls sheet'
	},
	{
		id: 'irrigation-deficit',
		term: 'Irrigation deficit',
		short: 'Demand that could not be met: demand minus supplied, in m³/day.',
		long: 'A farm with a persistent deficit is over-allocated for the water it can capture. The b023 Shortfalls sheet reports it per farm over a reporting window.',
		units: 'm³/day',
		category: 'crops',
		aliases: ['shortfall', 'unmet demand'],
		fields: ['run.deficit', 'summary.avgDeficitM3Day'],
		related: ['irrigation-demand'],
		source: 'b023 Shortfalls sheet'
	},

	// ---- Transfers ------------------------------------------------------------
	{
		id: 'transfer',
		term: 'Transfer',
		short: 'Water moved from one farm’s dam to another farm (pipeline or canal), in chosen months and up to a maximum rate.',
		long: 'Each day in an active month the transfer takes what the source dam held at the end of yesterday above its minimum level, up to the maximum rate (and daily cap, if set). The same volume leaves the source and enters the destination, so it always balances.\n\nb023 writes transfers as free-form formulas; the app uses these structured rules instead. Anything a workbook does that doesn’t fit them needs discussing with the hydrologist.',
		category: 'transfers',
		aliases: ['pipeline', 'canal', 'from', 'to'],
		fields: ['transfer.fromNodeId', 'transfer.toNodeId', 'transfer.enabled', 'run.transfer'],
		related: ['transfer-months', 'transfer-rate', 'transfer-min-storage'],
		source: 'b023 Help (Transfers sheet); docs/model.md §2.6'
	},
	{
		id: 'transfer-months',
		term: 'Transfer months',
		short: 'Calendar months (1 = January) in which the transfer runs. Outside them nothing moves.',
		long: 'Often a winter-filling scheme: move water while the source dam spills, not in the irrigation season.',
		category: 'transfers',
		fields: ['transfer.months'],
		related: ['transfer'],
		source: 'b023 Transfers configuration'
	},
	{
		id: 'transfer-rate',
		term: 'Maximum transfer rate',
		short: 'The pipe or canal capacity, in m³/s (× 86 400 per day). An optional daily cap in m³ can limit it further.',
		long: 'The day’s transfer is the smaller of the available water in the source dam, the rate × 86 400 s, and the daily cap when one is set.',
		units: 'm³/s; daily cap in m³',
		category: 'transfers',
		aliases: ['max rate', 'daily cap'],
		fields: ['transfer.maxRateM3s', 'transfer.dailyCapM3'],
		related: ['transfer'],
		source: 'b023 Transfers configuration'
	},
	{
		id: 'transfer-min-storage',
		term: 'Transfer minimum storage',
		short: 'The source dam is not drawn below this fraction of its capacity by this transfer.',
		long: 'Checked against yesterday’s end-of-day storage. The receiving dam’s free space is not checked: water that doesn’t fit spills (open question Q3).',
		units: 'fraction 0–1 (shown as %)',
		category: 'transfers',
		fields: ['transfer.minStoragePct'],
		related: ['dam-min', 'transfer'],
		source: 'b023 Transfers configuration; docs/model.md §3 Q3'
	},

	// ---- Natural flow and calibration -----------------------------------------
	{
		id: 'natural-flow',
		term: 'Natural flow',
		short: 'The flow the catchment would produce with no farms, dams or abstraction, in m³/day. Generated from rain.',
		long: 'b023 turns daily rain into flow with a calibrated rain → peak → recession routine and a slowly receding base flow. On days the rain model gives nothing, it falls back to the Pitman series if one is loaded (quirk Q7).\n\nNatural flow is then split into farm runoff by the flow shares.',
		units: 'm³/day',
		category: 'flow',
		aliases: ['naturalised flow', 'virgin flow'],
		fields: ['run.natural_flow', 'catchment.meanNaturalFlowM3Day', 'run.resultant_flow'],
		related: ['calibration', 'flow-share', 'pitman', 'base-flow'],
		source: 'b023 Flow data sheet; docs/model.md §2.4'
	},
	{
		id: 'farm-runoff',
		term: 'Farm runoff',
		short: 'The farm’s share of catchment natural flow on the day, in m³/day.',
		long: 'Natural flow × the farm’s flow share.',
		units: 'm³/day',
		category: 'flow',
		fields: ['run.runoff'],
		related: ['natural-flow', 'flow-share'],
		source: 'b023 Fragmented flow'
	},
	{
		id: 'upstream-inflow',
		term: 'Inflow from upstream',
		short: 'The same-day outflow of the elements that drain into this one, in m³/day.',
		long: 'Upstream elements are always computed first, so a farm sees today’s outflow of its upstream neighbours.',
		units: 'm³/day',
		category: 'flow',
		fields: ['run.inflow_upstream'],
		related: ['network', 'farm-outflow'],
		source: 'b023 farm element sheet'
	},
	{
		id: 'farm-outflow',
		term: 'Outflow',
		short: 'What leaves the element downstream each day: spill, water bypassing the dam, and irrigation return flow, in m³/day.',
		long: 'It becomes the next element’s upstream inflow. At the outflow gauge it is the catchment’s simulated outflow.',
		units: 'm³/day',
		category: 'flow',
		fields: ['run.outflow'],
		related: ['upstream-inflow', 'spill', 'return-flow'],
		source: 'b023 farm element sheet'
	},
	{
		id: 'calibration',
		term: 'Calibration',
		short: 'Tuning the rain-to-flow parameters so simulated outflow matches the observed record at the outlet.',
		long: 'Tune by hand (change a parameter, run, and compare simulated with observed flow: hydrograph and statistics such as NSE and PBIAS), or let Fit automatically search for the parameters. Calibrate over a period with a good observed record; the workbook uses its own calibration date window, separate from the main run.',
		category: 'flow',
		aliases: ['flow calibration', 'tuning'],
		related: ['peak-coefficient', 'nse', 'pbias', 'observed-flow'],
		source: 'b023 Help (Calibration function; Flow Calibration Cfg)'
	},
	{
		id: 'runoff-model',
		term: 'Runoff model',
		short: 'Which model turns rain into natural flow. Legacy is the b023 recession model; it stays the default until it is replaced.',
		long: 'Legacy is the workbook’s empirical recession model, ported unchanged. The engine audit found that it does not conserve water: one small storm can return several times its own volume as flow (docs/engine-audit.md H1).\n\nThe setting only changes how rain becomes natural flow. Flow shares, farms, dams, transfers and the EWR are the same whichever model made the flow, so two runs that differ only in the runoff model compare directly.',
		category: 'flow',
		aliases: ['rain-runoff model', 'rainfall-runoff', 'legacy model'],
		fields: ['settings.runoffModel'],
		related: ['calibration', 'natural-flow', 'gr4j'],
		source: 'docs/model.md §2.4; issue #4'
	},
	{
		id: 'gr4j',
		term: 'GR4J',
		short: 'A published daily rain-to-flow model with four parameters. It conserves water: rain leaves as evaporation or flow, or stays stored.',
		long: 'GR4J (Perrin, Michel & Andréassian 2003) is used worldwide. Rain first meets evaporation; what is left partly fills a soil-moisture (production) store of capacity X1. The rest, plus what percolates out of that store, is spread in time by two unit hydrographs of time base X4 days. 90 % goes through a routing store (reference capacity X3), and 10 % goes straight to the outlet.\n\nX2 exchanges water with groundwater outside the catchment. It is fixed at 0 by default, so the catchment is closed and the balance rain − evaporation − flow = change in storage holds every day. The model first runs a warm-up (a year by default) over the start of the record, so the stores begin at a realistic level; warm-up days are never shown or scored.\n\nTypical values: X1 100–1 200 mm, X3 20–300 mm, X4 1.1–2.9 days.',
		units: 'X1, X3 mm; X2 mm/day; X4 days',
		category: 'flow',
		aliases: ['X1', 'X2', 'X3', 'X4', 'production store', 'routing store', 'unit hydrograph', 'warm-up', 'Perrin'],
		fields: ['settings.gr4j', 'run.production_store', 'run.routing_store', 'run.uh_store', 'run.exchange'],
		related: ['runoff-model', 'pan-coefficient', 'actual-evaporation'],
		source: 'Perrin et al. (2003), J. Hydrol. 279; docs/model.md § Rain to flow: GR4J'
	},
	{
		id: 'pan-coefficient',
		term: 'Pan coefficient',
		short: 'Potential evaporation = pan coefficient × A-pan evaporation, per month. Drives GR4J; default 0.7.',
		long: 'A Class-A pan evaporates more than a catchment’s soils and plants could, so conceptual runoff models scale it down. 0.7 is a common flat value. Monthly values (for example the WR90 or Midgley factors) can be entered instead. The coefficient does not affect irrigation demand, which uses crop factors on the A-pan directly.',
		category: 'flow',
		aliases: ['PET', 'potential evaporation', 'k pan'],
		fields: ['settings.panCoefficient', 'run.pet'],
		related: ['gr4j', 'apan'],
		source: 'Issue #4 §1 (forcing); docs/model.md § Rain to flow: GR4J'
	},
	{
		id: 'actual-evaporation',
		term: 'Actual evaporation (AET)',
		short: 'Water the catchment actually evaporates each day in GR4J, in mm: never more than the potential evaporation.',
		long: 'The part of potential evaporation that rain meets directly, plus what the soil-moisture store can give up. On dry days with a dry store it falls well below PET.',
		units: 'mm',
		category: 'flow',
		fields: ['run.aet'],
		related: ['gr4j', 'pan-coefficient'],
		source: 'Perrin et al. (2003)'
	},
	{
		id: 'auto-calibration',
		term: 'Automatic calibration (Fit automatically)',
		short: 'Searches the runoff model’s parameters for the best fit to the observed record, then tests the fit on days it never saw.',
		long: 'The search is DDS (Tolson & Shoemaker 2007): it tries a set number of model runs, perturbing all parameters at first and fewer as it homes in, and never leaves each parameter’s allowed range. Every run scores the whole model, farms and dams included, against the observed record over the calibration window.\n\nPick what to optimise: KGE′ (the default), a year-balanced KGE′ that stops a few wet years dominating, a non-parametric KGE, or NSE on √Q or log Q for medium and low flows.\n\nThe fit alone says little. Validation fits again on the first half of the record and scores the second half, then fits on the driest water years and scores the wettest (listed by water year, since they interleave). With both a gauge and a logger record you can also score the fit against the record it wasn’t fitted to, a second instrument. Those columns are the honest measure. With a short record that is mostly drought, the result says so: wet-year behaviour is then weakly constrained. Nothing is saved until you apply the result and save the form.',
		category: 'fit',
		aliases: ['auto-calibration', 'optimiser', 'DDS', 'split-sample', 'differential split-sample', 'validation', 'KGE′'],
		related: ['calibration', 'gr4j', 'nse'],
		source: 'Tolson & Shoemaker (2007); Klemeš (1986); Kling et al. (2012); docs/model.md §2.10b'
	},
	{
		id: 'calibration-bounds',
		term: 'Bounds (automatic calibration)',
		short: 'How far the search may roam per parameter: wide (each parameter’s full calibration range) or typical (Perrin et al.’s published 80 % range).',
		long: 'A short or drought-heavy record often can’t pin down X1 (production store) and X3 (routing store): the fit lands outside where GR4J parameters usually sit, because too little of the record constrains them. "Typical" restricts the search to Perrin et al.’s (2003) 80 % range over 429 catchments (X1 100–1200 mm, X3 20–300 mm, X4 1.1–2.9 days), which can make an under-constrained fit land somewhere plausible instead of at an extreme of the wide range. It is a constraint on the search, not evidence the catchment truly falls inside it: read the fit and validation scores either way, and prefer the wide range when the record constrains the parameters well. Recorded with the fit record.',
		category: 'fit',
		aliases: ['typical range', 'Perrin range', 'wide bounds', 'X1 range', 'X3 range'],
		related: ['auto-calibration', 'gr4j', 'fit-record'],
		source: 'Perrin, Michel & Andréassian (2003); issue #4 phase 6'
	},
	{
		id: 'wr2012-check',
		term: 'WR2012 check',
		short: 'Compares simulated natural flow with the naturalised flow WR2012 publishes for the quaternary, scaled to the modelled catchment.',
		long: 'WR2012 (Water Resources of South Africa 2012) gives each quaternary catchment a naturalised mean annual runoff (MAR) and mean monthly flows: the river as it would be with no farms, dams or abstraction. Enter them from the study for the quaternary this project lies in, with the period they cover and where they come from. The app doesn’t ship WR2012 data.\n\nEach run then compares its simulated natural flow, never the outflow, with the reference. The reference is scaled to the modelled catchment by the area ratio, or by the area and the rainfall ratio (the run’s mean annual rain ÷ the quaternary MAP) when both are known. Runoff doesn’t scale in proportion to rain, so treat the rainfall scaling as a first estimate.\n\nThe report gives the MAR ratio over the complete water years both cover and over the whole run, the 12 monthly ratios with the dry-season months marked, and the correlation of the monthly pattern. A MAR that differs by 10 % is noted, by 25 % (or 15 % wetter) is queried, and by 50 % makes the run unusable for EWR findings until it is explained. The thresholds are editable.\n\nMonthly means are in million m³ per month (not m³/s) and should add up to the MAR within 5 %. A MAR larger than the rain on the quaternary (MAP × area) is rejected.',
		units: 'MAR Mm³/a; monthly means Mm³ per month; area km²; MAP mm',
		category: 'flow',
		aliases: ['WR2012', 'naturalised flow', 'naturalized flow', 'MAR', 'quaternary', 'Water Resources of South Africa'],
		fields: ['settings.wr2012'],
		related: ['natural-flow', 'wr2012-penalty', 'gr4j'],
		source: 'Bailey & Pitman, Water Resources of South Africa 2012 Study (WRC); docs/model.md § WR2012 check'
	},
	{
		id: 'wr2012-penalty',
		term: 'WR2012 MAR penalty (calibration)',
		short: 'Optional: automatic calibration also pulls the simulated natural MAR towards the scaled WR2012 MAR. Off by default.',
		long: 'When it is on, Fit automatically adds weight × |ln(simulated natural MAR ÷ scaled WR2012 MAR)| to the loss it minimises, so a wetter and a drier MAR by the same factor cost the same. It only touches the annual volume, not the daily pattern.\n\nThe result shows the fit with the penalty and the same fit without it, with the weight, so you can see what matching WR2012 costs the fit to the observed record. A short or impacted observed record can disagree with WR2012 for good reasons; the penalty is a nudge, not a constraint.',
		category: 'fit',
		aliases: ['soft penalty', 'MAR penalty', 'regularisation'],
		related: ['wr2012-check', 'auto-calibration'],
		source: 'docs/model.md § WR2012 check; issue #4 phase 8'
	},
	{
		id: 'calibration-exclusions',
		term: 'Calibration exclusions',
		short: 'Water years or date ranges left out of every calibration score, each with a reason that runs keep on record.',
		long: 'Use one for a period whose data you can’t trust: a suspect rain year, the gauge after a known break, an outage. Excluded days are left out of Fit automatically and of the run’s calibration statistics alike; the model still simulates them. A water year runs from 1 October to 30 September. A reason is required, every run stores the exclusions it applied, and comparing two runs lists any exclusion added, removed or re-reasoned, so dropping an awkward period always leaves a record.',
		category: 'fit',
		aliases: ['excluded periods', 'exclude water year', 'bad years'],
		fields: ['settings.calibrationExclusions', 'stats.exclusions', 'stats.excludedDays'],
		related: ['calibration-window', 'auto-calibration'],
		source: 'Not in the workbook; docs/model.md §2.10'
	},
	{
		id: 'fit-record',
		term: 'Fit record',
		short: 'What “Apply to form” stores with fitted parameters: how the fit was made and how it scored on days it never saw.',
		long: 'The record keeps the runoff model, objective, seed, model runs per fit, calibration window, exclusions, the record fitted to, the engine version and the time, with every score: the in-sample fit and the split-sample, dry → wet and independent-record validation. The same inputs, engine version and seed give the same fit, so anyone can reproduce it. Each run keeps the record in effect, so its results show which fit produced their parameters. Change a fitted parameter by hand and the record is marked “parameters edited since fit”: it no longer describes them. The in-sample score is the fit to the calibration period; judge the parameters by the validation scores.',
		category: 'fit',
		aliases: ['fit provenance', 'seed', 'parameters edited since fit'],
		fields: ['settings.fitRecord'],
		related: ['auto-calibration', 'calibration-exclusions'],
		source: 'docs/model.md §2.10b'
	},
	{
		id: 'catchment-area',
		term: 'Catchment area (rain)',
		short: 'Area, in km², that rain falls on when converting mm to m³. Empty = the sum of the farm areas.',
		long: 'Set it only when the modelled farms don’t cover the whole catchment and you want rain over the full area. 1 mm over 1 km² = 1 000 m³.',
		units: 'km²',
		category: 'flow',
		fields: ['calibration.catchmentAreaKm2'],
		related: ['farm-area', 'peak-coefficient'],
		source: 'b023 Farm spec (total area)'
	},
	{
		id: 'peak-coefficient',
		term: 'Peak coefficient a and exponent b',
		short: 'Rain-driven flow = a · rain^b × catchment area × season factor. Larger a or b gives bigger flood peaks.',
		long: 'The core of the rain → flow routine. a scales every event; b > 1 makes big storms produce disproportionately more flow than small ones. b023 defaults: a = 0.09, b = 1.2.',
		category: 'flow',
		aliases: ['a', 'b', 'peak flow'],
		fields: ['calibration.a', 'calibration.b'],
		related: ['season-factors', 'rain-threshold', 'calibration'],
		source: 'b023 Flow Calibration Cfg'
	},
	{
		id: 'rain-threshold',
		term: 'Rain threshold',
		short: 'Daily rain at or below this (mm) produces no flow and doesn’t reduce irrigation demand. b023 default 2 mm.',
		long: 'Filters out drizzle that the soil absorbs. The same thresholded rain drives both runoff and the effective-rain offset (quirk Q6).',
		units: 'mm',
		category: 'flow',
		fields: ['calibration.rainThresholdMm', 'run.rain_used'],
		related: ['peak-coefficient', 'effective-rainfall'],
		source: 'b023 Flow Calibration Cfg; docs/model.md §3 Q6'
	},
	{
		id: 'season-factors',
		term: 'Summer and winter factors',
		short: 'Multipliers on rain-driven flow by season. Dry summer soils absorb more, so the summer factor is usually much lower.',
		long: 'Summer months always use the summer factor. In other months the catchment responds as in summer until a large storm (today’s or yesterday’s rain above the winter thresholds) switches it to winter response, which then persists.',
		category: 'flow',
		aliases: ['summer factor', 'winter factor', 'seasonal response'],
		fields: ['calibration.summerFactor', 'calibration.winterFactor', 'run.is_summer'],
		related: ['summer-months', 'winter-thresholds'],
		source: 'b023 Flow Calibration Cfg; docs/model.md §2.4'
	},
	{
		id: 'summer-months',
		term: 'Summer months',
		short: 'Calendar months (1 = January) that always use the summer response. Set them for the catchment’s dry season.',
		long: 'For a winter-rainfall catchment in the Western Cape these are roughly November to May. Check them per project: the defaults differ between workbooks (quirk Q9).',
		category: 'flow',
		fields: ['calibration.summerMonths'],
		related: ['season-factors'],
		source: 'b023 Flow Calibration Cfg; docs/model.md §3 Q9'
	},
	{
		id: 'winter-thresholds',
		term: 'Winter switch thresholds',
		short: 'Outside summer months, rain today ≥ one threshold or yesterday ≥ the other (mm) switches the catchment to winter response.',
		long: 'Models the wetting-up of the catchment at the start of the rainy season: one big storm, or a moderate one yesterday, and runoff from then on behaves like winter. b023 defaults: 35 mm today, 9 mm yesterday.',
		units: 'mm',
		category: 'flow',
		fields: ['calibration.winterTodayRainMm', 'calibration.winterNextDayRainMm'],
		related: ['season-factors'],
		source: 'b023 Flow Calibration Cfg'
	},
	{
		id: 'base-flow',
		term: 'Base flow',
		short: 'The slow, groundwater-fed part of river flow that recedes gradually between storms, in m³/day.',
		long: 'In b023 base flow recedes day by day along the recession curve. A big enough rain pulse (above the reset ratio) resets it to the pulse size; otherwise it keeps receding. The initial value sets the first day.',
		units: 'm³/day',
		category: 'flow',
		aliases: ['baseflow', 'low flow', 'quickflow'],
		fields: ['calibration.baseFlowInitial', 'calibration.baseResetRatio', 'run.base_flow'],
		related: ['recession-curve'],
		source: 'b023 Flow data; docs/model.md §2.4'
	},
	{
		id: 'recession-curve',
		term: 'Recession curve',
		short: 'How flow decays day by day without rain: a table from flow level to a daily recession factor.',
		long: 'Each flow is placed on the curve by its size (its recession index) and multiplied by the factor for that index each day, so high flows fall fast and low flows slowly. The curve, factors and maximum index are usually derived from the observed record and are rarely changed.',
		category: 'flow',
		aliases: ['recession', 'decay', 'recession factors', 'recession index'],
		fields: [
			'calibration.recessionFactors',
			'calibration.recessionCurveM3Day',
			'calibration.recessionDaysMax',
			'run.response_flow'
		],
		related: ['base-flow', 'pulse-index'],
		source: 'b023 Flow Calibration Cfg'
	},
	{
		id: 'pulse-index',
		term: 'Pulse start index and amplitude',
		short: 'Where on the recession curve a new rain pulse starts. Big pulses start near the low index and recede fast.',
		long: 'A pulse of the amplitude size starts at the low index; a vanishingly small pulse starts at the high index; sizes in between are interpolated. Together they shape how peaky the hydrograph is. b023 defaults: 0.9 and 3.5.',
		category: 'flow',
		aliases: ['shift peak index', 'amplitude'],
		fields: ['calibration.shiftPeakIndexLo', 'calibration.shiftPeakIndexHi', 'calibration.amplitudeM3Day', 'run.rain_flow'],
		related: ['recession-curve'],
		source: 'b023 Flow Calibration Cfg'
	},

	// ---- EWR ----------------------------------------------------------------
	{
		id: 'ewr',
		term: 'EWR (Environmental Water Requirement)',
		short: 'The flow that must stay in the river to keep the ecosystem in its target condition.',
		long: 'In South Africa the legal term is the ecological Reserve (or IFR, instream flow requirement). It is derived per river for an ecological category, typically with the Desktop Reserve Model. This model checks every day whether the simulated flow meets it.',
		units: 'm³/day',
		category: 'ewr',
		aliases: ['Reserve', 'ecological reserve', 'IFR', 'instream flow requirement', 'environmental flow'],
		related: ['pragmatic-ewr', 'ewr-shortfall', 'ecological-category', 'desktop-reserve-model'],
		source: 'b023 EWR Cfg; docs/model.md §7'
	},
	{
		id: 'pragmatic-ewr',
		term: 'Pragmatic EWR',
		short: 'b023’s simplification: one fixed m³/day per month at the outlet, instead of a requirement that varies with wetness.',
		long: 'Reserve tables vary the requirement with how wet the month is, which is hard to plan for on a farm. b023 instead picks one value per month — typically a percentile of the Reserve flows without high flows, converted to m³/day — so farmers know in advance how much to leave in the river.\n\nEnter the 12 monthly values, Oct … Sep. The catchment value is checked at the outflow gauge and split into per-farm shares by the flow shares.',
		units: 'm³/day per month',
		category: 'ewr',
		fields: ['settings.ewrPragmaticM3PerDay', 'run.ewr'],
		related: ['ewr', 'desktop-reserve-model', 'flow-share'],
		source: 'b023 Help (EWR configuration); EWR Cfg; docs/model.md §3 Q10'
	},
	{
		id: 'ewr-share',
		term: 'Farm EWR share',
		short: 'The farm’s part of the pragmatic EWR (EWR × its flow share), and whether its outflow meets it.',
		long: 'b023 compares each farm’s whole outflow with its own share only, not with the sum of the shares upstream (quirk Q4). The catchment check at the outflow gauge uses the full EWR and is unaffected.',
		units: 'm³/day',
		category: 'ewr',
		fields: ['run.ewr_cumulative'],
		related: ['pragmatic-ewr', 'ewr-shortfall'],
		source: 'b023 Fragmented EWR; docs/model.md §3 Q4'
	},
	{
		id: 'ewr-shortfall',
		term: 'EWR shortfall',
		short: 'How far flow falls below the EWR on a day (negative = not met), in m³/day. Zero when the EWR is met.',
		long: 'At the outflow gauge it is simulated outflow minus the pragmatic EWR on days it falls short. Per farm, the incremental shortfall is the part caused at that farm.',
		units: 'm³/day',
		category: 'ewr',
		aliases: ['EWR not met', 'deficit to the river'],
		fields: ['run.ewr_shortfall', 'run.ewr_shortfall_incremental', 'summary.avgEwrShortfallM3Day'],
		related: ['ewr-days-not-met', 'pragmatic-ewr'],
		source: 'b023 EWR shortfalls sheet'
	},
	{
		id: 'ewr-days-not-met',
		term: 'Days EWR not met',
		short: 'Number (or share) of simulated days on which flow was below the EWR.',
		long: 'The headline measure of how often the river fails. Look at when the failures happen, too: a few summer weeks every year differ from a multi-year drought.',
		units: 'days; fraction 0–1',
		category: 'ewr',
		fields: ['summary.daysEwrNotMet', 'catchment.ewrDaysNotMet', 'catchment.ewrFractionDaysNotMet'],
		related: ['ewr-shortfall'],
		source: 'b023 EWR analysis'
	},
	{
		id: 'ewr-agreement',
		term: 'EWR test against observed flow',
		short: "Does the model fall below the EWR on the days the observed river did? A 2×2 table of observed days, with scores.",
		long: 'A gauge or logger measures the same river the outlet EWR test uses, so on each observed day the observed flow takes the test too. Hit rate: share of the river’s failures the model also has (1 ideal). False-alarm ratio: share of the model’s failures the river didn’t have (0 ideal). Frequency bias: the model’s share of days below the EWR ÷ the observed share (1 ideal). Use it to judge which runoff model’s EWR count to trust.',
		units: 'days; ratios',
		category: 'ewr',
		aliases: ['EWR agreement', 'frequency bias', 'hit rate', 'false-alarm ratio', 'contingency table'],
		fields: ['catchment.ewrAgreement'],
		related: ['ewr-days-not-met'],
		source: 'docs/model.md §2.9b'
	},
	{
		id: 'desktop-reserve-model',
		term: 'Desktop Reserve Model',
		short: 'Software (“Desktop Version 2”) that produces monthly Reserve flow tables by percentile for a river’s ecological category.',
		long: 'Its tables — with and without high flows, in M.m³ per month at the 10 %–99 % points — are the usual starting point for the pragmatic EWR.',
		category: 'ewr',
		aliases: ['Desktop Version 2', 'DRM', 'Reserve tables'],
		related: ['pragmatic-ewr', 'ecological-category'],
		source: 'b023 EWR Cfg'
	},
	{
		id: 'ecological-category',
		term: 'Ecological category',
		short: 'The A–F class of river condition that the Reserve is set to maintain (A = natural, F = critically modified).',
		long: 'The higher the target category, the more flow the Reserve keeps in the river.',
		category: 'ewr',
		aliases: ['EC', 'present ecological state', 'category B'],
		related: ['ewr'],
		source: 'docs/model.md §7'
	},

	// ---- Input data -----------------------------------------------------------
	{
		id: 'rain-catchment',
		term: 'Catchment rainfall',
		short: 'Daily catchment-average rainfall in mm. The first choice for driving natural flow and effective rain.',
		long: 'Each day the model uses the first available of catchment, CHIRPS and forecast rainfall. Missing days are left empty, not zero.',
		units: 'mm/day',
		category: 'data',
		aliases: ['rain', 'rainfall', 'precipitation'],
		fields: ['series.rain_catchment_mm'],
		related: ['chirps', 'rain-threshold'],
		source: 'b023 Flow data'
	},
	{
		id: 'chirps',
		term: 'CHIRPS rainfall',
		short: 'Satellite-and-station daily rainfall (Climate Hazards Group). Used on days without catchment rainfall.',
		long: 'Useful to fill gaps or extend a short gauge record. At catchment scale CHIRPS can read well below (or above) a local gauge, so by default the model scales it by a factor per calendar month, fitted where both records have a reading, on the days it fills in (see CHIRPS bias correction).',
		units: 'mm/day',
		category: 'data',
		aliases: ['satellite rainfall'],
		fields: ['series.rain_chirps_mm'],
		related: ['rain-catchment', 'chirps-bias'],
		source: 'b023 Flow data; docs/model.md §7'
	},
	{
		id: 'chirps-bias',
		term: 'CHIRPS bias correction',
		short: 'Scales CHIRPS rain, on days it fills in for blank catchment rain, by a catchment ÷ CHIRPS factor for the calendar month.',
		long: 'For each calendar month the factor is the catchment rain divided by the CHIRPS rain, summed over the days both have a reading. Water years the rain checks flag (long zero runs, far below CHIRPS) are left out, because their catchment rain is suspect. A month with fewer than 90 shared days, or less than 50 mm of CHIRPS on them, uses the factor pooled over all months; with too little overlap for even that, CHIRPS is used as it is and the run says so. Factors are kept between 0.25 and 4.\n\nOnly CHIRPS that is actually used is scaled. Catchment rain and forecast rain are never changed. Each run lists the factors and the number of days corrected in its warnings.\n\nChoose "Raw CHIRPS" only if the CHIRPS series you loaded is already corrected to the catchment; otherwise it would be corrected twice. Not in the workbook, which used raw CHIRPS (docs/engine-audit.md B1).',
		category: 'data',
		aliases: ['bias correction', 'CHIRPS factor', 'rain scaling'],
		fields: ['settings.chirpsBiasCorrection'],
		related: ['chirps', 'rain-catchment'],
		source: 'Not in the workbook; docs/model.md §2.4b; engine-audit.md B1'
	},
	{
		id: 'rain-forecast',
		term: 'Forecast rainfall',
		short: 'Forecast daily rain in mm, used after the other rain series run out, to look ahead a few days.',
		units: 'mm/day',
		long: 'Treat results on forecast days as indicative only.',
		category: 'data',
		fields: ['series.rain_forecast_mm'],
		related: ['rain-catchment'],
		source: 'b023 Flow data'
	},
	{
		id: 'pitman',
		term: 'Pitman flow',
		short: 'Naturalised flow from the Pitman monthly rainfall-runoff model (WR90/WR2012), in m³/s. A fallback natural-flow source.',
		long: 'On days where the rain model produces no flow, b023 uses the Pitman flow instead (quirk Q7), so one natural-flow series can mix two sources.',
		units: 'm³/s',
		category: 'data',
		aliases: ['WR2012 flow', 'naturalised flow'],
		fields: ['series.flow_pitman_m3s'],
		related: ['natural-flow', 'wr90'],
		source: 'b023 Flow data; docs/model.md §3 Q7'
	},
	{
		id: 'observed-flow',
		term: 'Observed flow',
		short: 'Measured flow at the outlet (gauge record, or a logger), in m³/s. Used only to score the calibration.',
		long: 'Converted to m³/day and compared with the simulated outflow on days both exist. The gauge record is preferred; the logger series is used when there is no gauge series.',
		units: 'm³/s',
		category: 'data',
		aliases: ['gauge flow', 'logger flow', 'measured flow', 'DWS gauge'],
		fields: ['series.flow_observed_m3s', 'series.flow_logger_m3s', 'run.observed_flow'],
		related: ['calibration', 'nse'],
		source: 'b023 Flow data'
	},
	{
		id: 'reference-gauge',
		term: 'Reference gauge (other catchment)',
		short: 'A gauge on a different river, such as a neighbouring sub-catchment. A regional wet/dry index only; the model never reads it.',
		long: 'Some workbooks hold a gauge column measured on a neighbouring river, sometimes scaled by catchment area for part of the record. That record is not observed flow for the modelled river, so it is kept as its own series kind: runs never calibrate or validate against it, never compare it with the logger and never use it in the EWR comparison. Use it to rank wet and dry years. The importer stores it this way with --gauge-as-reference.',
		units: 'm³/s',
		category: 'data',
		aliases: ['regional gauge', 'neighbouring gauge', 'proxy gauge'],
		fields: ['series.flow_reference_m3s'],
		related: ['observed-flow', 'calibration'],
		source: 'docs/model.md §2.10'
	},
	{
		id: 'wr90',
		term: 'WR90 / WR2012',
		short: 'The Water Resources of South Africa studies (1990, 2012): A-pan, MAP and naturalised flow per quaternary catchment.',
		long: 'The standard national source for the monthly evaporation and naturalised-flow inputs.',
		category: 'data',
		aliases: ['WR2012', 'Water Resources of South Africa'],
		related: ['apan', 'pitman', 'quaternary'],
		source: 'docs/model.md §7'
	},
	{
		id: 'quaternary',
		term: 'Quaternary catchment',
		short: 'The smallest standard South African catchment unit (e.g. A21A), used to look up WR90/WR2012 data.',
		long: 'A model catchment usually lies within one quaternary or spans a few.',
		category: 'data',
		related: ['wr90'],
		source: 'docs/model.md §7'
	},
	{
		id: 'map',
		term: 'MAP and MAR',
		short: 'Mean annual precipitation (mm/yr) and mean annual runoff (M.m³/yr): the long-term averages of rain and river flow.',
		long: 'MAP varies across a catchment, which is why b023 can split farm areas into high- and low-MAP zones.',
		units: 'mm/yr; M.m³/yr',
		category: 'data',
		aliases: ['MAP', 'MAR', 'mean annual precipitation', 'mean annual runoff'],
		related: ['hi-lo-map-area'],
		source: 'docs/model.md §7'
	},

	// ---- Run results ------------------------------------------------------------
	{
		id: 'fraction-supplied',
		term: 'Fraction of demand supplied',
		short: 'Average supplied ÷ average demand over the run (1 = every drop of demand met).',
		long: 'A quick reliability measure per farm. It averages over wet and dry years; check the daily deficit to see when the shortfalls happen.',
		units: 'fraction 0–1',
		category: 'results',
		aliases: ['assurance', '% supplied'],
		fields: ['summary.fractionSupplied'],
		related: ['irrigation-supplied', 'irrigation-deficit'],
		source: 'b023 Shortfalls sheet'
	},

	// ---- Goodness of fit ---------------------------------------------------------
	{
		id: 'nse',
		term: 'NSE (Nash–Sutcliffe efficiency)',
		short: '1 − Σ(obs − sim)² / Σ(obs − mean obs)². 1 is a perfect fit; 0 or below is no better than the observed mean.',
		long: 'Squared errors make NSE dominated by flood peaks, so a good NSE can hide poor low flows. Look at it alongside PBIAS and the hydrograph.',
		units: 'dimensionless, −∞ … 1',
		category: 'fit',
		aliases: ['Nash-Sutcliffe', 'efficiency'],
		fields: ['stats.nse'],
		related: ['pbias', 'rmse', 'kge', 'calibration'],
		source: 'docs/model.md §7'
	},
	{
		id: 'pbias',
		term: 'PBIAS (percent bias)',
		short: '100 × Σ(sim − obs) / Σobs. Negative means the model under-predicts the total volume; 0 is unbiased.',
		long: 'Measures volume error regardless of timing — the fit that matters most for allocation questions.',
		units: '%',
		category: 'fit',
		aliases: ['bias', 'volume error'],
		fields: ['stats.pbias'],
		related: ['nse'],
		source: 'docs/model.md §7'
	},
	{
		id: 'rmse',
		term: 'RMSE',
		short: 'Root-mean-square error between simulated and observed daily flow, in m³/s. Smaller is better.',
		long: 'Has the units of flow, so compare it with the mean observed flow to judge its size.',
		units: 'm³/s',
		category: 'fit',
		aliases: ['root mean square error'],
		fields: ['stats.rmseM3s', 'stats.meanObservedM3s', 'stats.meanSimulatedM3s', 'stats.days'],
		related: ['nse'],
		source: 'docs/model.md §7'
	},
	{
		id: 'kge',
		term: 'KGE (Kling–Gupta efficiency)',
		short: 'Combines correlation, bias and variability into one score; 1 is perfect. Less peak-dominated than NSE.',
		long: 'Often preferred to NSE because it separates timing, volume and variability errors.',
		units: 'dimensionless, −∞ … 1',
		category: 'fit',
		aliases: ['Kling-Gupta'],
		fields: ['stats.kge', 'stats.kgeR', 'stats.kgeAlpha', 'stats.kgeBeta'],
		related: ['nse'],
		source: 'docs/model.md §7'
	},
	{
		id: 'r-squared',
		term: 'R² (coefficient of determination)',
		short: 'Share of the day-to-day variation in observed flow that the simulation follows (0–1). Ignores volume errors.',
		long: 'R² is the square of the correlation between simulated and observed flow. A high R² with a poor NSE usually means the timing is right but the volumes are off — check PBIAS.',
		units: 'dimensionless, 0 … 1',
		category: 'fit',
		aliases: ['R2', 'correlation'],
		fields: ['stats.r2'],
		related: ['nse', 'pbias'],
		source: 'docs/model.md §2.10'
	},
	{
		id: 'log-nse',
		term: 'log-NSE (low-flow fit)',
		short: 'NSE computed on the logarithm of flow, so it rewards a good fit in low flows rather than in floods.',
		long: 'Ordinary NSE is dominated by a few big floods. For irrigation and EWR questions the dry-season low flows matter most; log-NSE weights them evenly. A small constant (1 % of mean observed flow) is added before taking logs so zero flows are allowed.',
		units: 'dimensionless, −∞ … 1',
		category: 'fit',
		aliases: ['logNSE', 'low flow'],
		fields: ['stats.logNse'],
		related: ['nse'],
		source: 'docs/model.md §2.10'
	},
	{
		id: 'volume-error',
		term: 'Volume error',
		short: 'How much more (+) or less (−) water the model produces than was observed over the calibration window, in %.',
		long: 'The same information as PBIAS with the opposite sign: +10 % means the simulation is 10 % too wet. The annual volume table shows it per water year, which reveals whether an error comes from a few years or is systematic.',
		units: '%',
		category: 'fit',
		aliases: ['volume bias', 'water balance error'],
		fields: ['stats.volumeErrorPct'],
		related: ['pbias'],
		source: 'docs/model.md §2.10'
	}
];

// ---------------------------------------------------------------------------
// Lookup and search
// ---------------------------------------------------------------------------

const byId = new Map(HELP.map((e) => [e.id, e]));
const byField = new Map(HELP.flatMap((e) => (e.fields ?? []).map((f) => [f, e] as const)));

/** Entry for a field key (`node.damCapacityM3`) or an entry id (`ewr`). */
export function helpFor(key: string): HelpEntry | undefined {
	return byField.get(key) ?? byId.get(key);
}

/** Every field key that has help, sorted — the list to place HelpTips from. */
export function helpFieldKeys(): string[] {
	return [...byField.keys()].sort();
}

const norm = (s: string) =>
	s
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase();

/**
 * Entries matching every word of `query`, best first: term/alias matches
 * before text matches. Empty query → all entries in glossary order.
 */
export function searchHelp(query: string, entries: readonly HelpEntry[] = HELP): HelpEntry[] {
	const words = norm(query).split(/\s+/).filter(Boolean);
	if (!words.length) return [...entries];
	const scored: { e: HelpEntry; score: number; i: number }[] = [];
	entries.forEach((e, i) => {
		const title = norm([e.term, ...(e.aliases ?? [])].join(' '));
		const body = norm([e.short, e.long, e.units ?? ''].join(' '));
		let score = 0;
		for (const w of words) {
			if (title.includes(w)) score += 3;
			else if (body.includes(w)) score += 1;
			else return;
		}
		if (norm(e.term).startsWith(words.join(' '))) score += 5;
		scored.push({ e, score, i });
	});
	return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.e);
}
