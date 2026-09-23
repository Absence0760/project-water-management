// Contextual help and glossary (the /help page and <HelpTip>).
//
// Written for hydrologists, in our own words. The concepts follow the WBT b023
// workbook's Help, Models and configuration sheets and docs/model.md; the
// workbook's text is SmartMatix's and is deliberately not copied. `source`
// names where the idea comes from so a reader can check it against the
// workbook.
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
		term: 'Minimum dam storage (transfers)',
		short: 'Storage a transfer may not draw the dam below, as a fraction of capacity. Irrigation is not limited by it.',
		long: 'Transfers out of this dam only take water above this level. Irrigation can still empty the dam completely — whether farmers keep a reserve is open question Q5 for the hydrologist.',
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
		long: 'Natural flow × the farm’s flow share, rounded to whole cubic metres.',
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
		long: 'The b023 routine is tuned by hand: change a parameter, run, and compare simulated with observed flow (hydrograph and statistics such as NSE and PBIAS). Calibrate over a period with a good observed record; the workbook uses its own calibration date window, separate from the main run.',
		category: 'flow',
		aliases: ['flow calibration', 'tuning'],
		related: ['peak-coefficient', 'nse', 'pbias', 'observed-flow'],
		source: 'b023 Help (Calibration function; Flow Calibration Cfg)'
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
		long: 'Useful to fill gaps or extend a short gauge record. Check its bias against a local gauge before relying on it.',
		units: 'mm/day',
		category: 'data',
		aliases: ['satellite rainfall'],
		fields: ['series.rain_chirps_mm'],
		related: ['rain-catchment'],
		source: 'b023 Flow data; docs/model.md §7'
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
		fields: ['stats.kge'],
		related: ['nse'],
		source: 'docs/model.md §7'
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
