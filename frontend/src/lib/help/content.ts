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
//   preview.<column>                the Data tab's daily preview (series/preview.ts):
//                                   date, flowM3Day, rainUsed, chirpsFactor,
//                                   chirpsCorrected, excluded. Its raw series
//                                   columns use series.<SeriesKind>.
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
	| 'fit'
	| 'farmer';

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
	fit: 'Goodness of fit',
	farmer: 'Words on your farm page'
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
		related: ['run', 'roles'],
		source: 'docs/model.md §1'
	},
	{
		id: 'run',
		term: 'Run',
		short: 'One execution of the model on the project as it was at that moment. Results are kept, with a snapshot of the inputs used.',
		long: 'Pressing Run model computes every day of the simulation window and stores the daily series and the summary. Later edits to the model don’t change an existing run, so results can always be explained. Each run records the engine version it was computed with.',
		category: 'basics',
		aliases: ['model run', 'engine version'],
		related: ['simulation-window', 'project', 'evidence-run'],
		source: 'docs/model.md §6'
	},
	{
		id: 'evidence-run',
		term: 'Evidence run (nomination)',
		short: 'The one run a project stands behind, nominated by an editor with a reason. Nominations are never edited or removed.',
		long: 'On Runs & results, Notes & evidence, an editor can nominate the run shown with Nominate as evidence and a required reason. Nominating another run later replaces it; both stay in the nomination history, with who nominated each, when and why. In the runs list the current one carries an Evidence badge and a replaced one Former evidence, and comparing runs says when either side is or was the evidence.\n\nA run of the legacy runoff model can’t be nominated: it is workbook comparison only. When a run made after the nominated one uses a different runoff model, the results say so: the nomination still stands until another run is nominated, with a reason.',
		category: 'basics',
		aliases: ['nominate', 'nominated run', 'nomination history', 'former evidence'],
		related: ['run', 'runoff-model', 'roles'],
		source: 'docs/ui.md § Evidence nomination; docs/data-model.md'
	},
	{
		id: 'roles',
		term: 'Roles: owner, editor, viewer',
		short: 'Viewers read everything; editors also change the model, upload data and run it; owners also manage members.',
		long: 'Each person has a role on each project. A viewer sees every input and result, can fit the runoff model to explore and download results, but can’t save or run; the workspace says “View only”. An editor changes settings and model data, uploads series, runs the model, writes run notes and nominates the evidence run. An owner also adds and removes members, changes roles and deletes the project.\n\nA project can belong to a team. Team admins are owners of every team project, team members editors and team viewers viewers. Someone who is both a direct member and a team member gets the higher of the two roles.',
		category: 'basics',
		aliases: ['permissions', 'members', 'team', 'view only', 'owner', 'editor', 'viewer', 'team admin'],
		related: ['project', 'evidence-run'],
		source: 'docs/data-model.md § Access control; docs/security.md'
	},
	{
		id: 'water-year',
		term: 'Water year',
		short: 'October to September, the South African hydrological year. Monthly tables in this app run Oct … Sep.',
		long: 'Monthly inputs (A-pan evaporation, crop factors, pragmatic EWR) are entered in water-year order, starting with October. Month pickers (transfer months, summer months, dry-season months) show one toggle per month in the same Oct … Sep order.',
		category: 'basics',
		aliases: ['hydrological year'],
		source: 'docs/model.md §2.1'
	},
	{
		id: 'units',
		term: 'Units: m³/day, m³/s, M.m³',
		short: 'Flows and volumes are m³/day inside the model. 1 m³/s = 86 400 m³/day; 1 M.m³ = one million m³.',
		long: 'Gauge and logger flow series are usually supplied in m³/s and converted to m³/day on the way in. Dam capacities and storage are in m³. Mean annual runoff is often quoted in M.m³ per year.\n\nA quick check: 1 l/s ≈ 86 m³/day, and 1 000 m³/day ≈ 11.6 l/s.',
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
		short: 'Optional first and last day to simulate. Leave empty to run over the whole period covered by the rainfall series.',
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
		long: 'Hydrologists usually calibrate on a period with reliable observations rather than the whole record; a b023 workbook has its own calibration date range and flow choice. Choose which observed series to compare against (gauge or logger); left empty, the gauge record is used if there is one, else the logger. The fit statistics and the annual volume table only count days inside this window.',
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
		long: 'Two instruments on the same river should roughly agree. Each water year, the gauge volume is compared with the logger volume on the days both have a reading. A year is flagged when the ratio is below the lowest ratio or above the highest ratio (defaults 67 % and 150 %), and only when the year has at least the minimum number of shared days (default 90). A flagged year usually means a problem at one instrument, so choose the record you trust as the calibration flow series. The thresholds only change which years are flagged, never the model results. The Data tab’s Data checks also list negative values, outliers and flat stretches in each series, catchment rain that reads 0 where it looks missing (a zero blocks the CHIRPS fallback a blank day gets), and water years whose catchment rain reads far below CHIRPS.',
		category: 'fit',
		aliases: ['data quality', 'observed flow agreement', 'logger check'],
		fields: ['settings.dataQuality'],
		related: ['calibration-window'],
		source: 'Not in the workbook; docs/model.md §2.10a'
	},
	{
		id: 'report-window',
		term: 'Reporting window',
		short: 'The period the curtailment report (equitable shares and EWR cuts per farm) averages over. Empty = the whole run.',
		long: 'Pick a critical period — a dry season or a drought year — to see how much each farm would need to reduce for irrigation to balance and the EWR to be met in that period. A window partly outside the run is clipped to it.\n\nOn Runs & results, the Reporting window picker above the curtailment table shows the same tables over another period (the last 7, 14 or 30 days, the whole record or a custom range) without changing this setting or re-running: anyone who can see the run can use it.',
		category: 'basics',
		aliases: ['reporting period', 'shortfall period'],
		fields: ['settings.reportStart', 'settings.reportEnd'],
		related: ['ewr'],
		source: 'b023 [Shortfalls] "Set reporting period"; docs/model.md §2.11'
	},

	{
		id: 'assurance-of-supply',
		term: 'Assurance of supply',
		short: 'How reliably each farm’s irrigation demand was met over the reporting window: by days, by volume and by water years.',
		long: 'Three measures per farm and other water user (engine 0.32.0). Days met: the share of days with demand when the whole demand was supplied (days without demand don’t count). Volume supplied: Σ supplied ÷ Σ demand, the same figure as the curtailment table. Water years met: the share of water years whose supply reached the annual threshold (Settings, default 90 %, a project choice rather than a standard).\n\nAfter Hashimoto et al. (1982), a failure is a run of consecutive demand days not fully met: the table gives the number of failures, their mean and longest length (resilience) and the mean and largest deficit per failure (vulnerability).\n\nThe definitions are pending review by the project hydrologist.',
		units: '% ; days; m³',
		category: 'results',
		aliases: ['reliability', 'assurance', 'resilience', 'vulnerability', 'Hashimoto'],
		fields: ['settings.assuranceAnnualThreshold'],
		related: ['report-window', 'stress-class', 'water-account'],
		source: 'docs/model.md §2.11a; Hashimoto, Stedinger & Loucks 1982'
	},
	{
		id: 'stress-class',
		term: 'Stress class',
		short: 'A month’s supply as a class: Low (≥ 95 % of demand supplied), Moderate (≥ 85 %), High (≥ 70 %), Severe (≥ 50 %) or Critical.',
		long: 'The classes and thresholds come from the client’s experimental node-based workbook (v004 DEV), which reported them per farm and per month. The app grids them per farm, per other water user and for all of them together, water year by month, over the whole run. A month without demand has no class.',
		category: 'results',
		aliases: ['stress', 'supply ratio', 'Low', 'Moderate', 'High', 'Severe', 'Critical'],
		related: ['assurance-of-supply'],
		source: 'docs/model.md §4 and §2.11a'
	},
	{
		id: 'water-account',
		term: 'Water account',
		short: 'Per water year: what entered the river network, where it went, what the dams kept, and a residual that should be 0.',
		long: 'In: natural flow, rain on the dams, groundwater pumped and net transfers. Out: runoff removed by land cover, natural flow no farm received (flow shares not summing to 1), consumptive irrigation (supplied − return flow), other users’ net take, dam evaporation, stream depletion from boreholes and the outflow at the outlet. In − out − change in dam storage is the residual, float noise. Dam seepage is shown as a memo: it rejoins the river below the dam. The EWR required and met at each site close the account.',
		units: 'm³',
		category: 'results',
		aliases: ['water balance', 'account', 'closure'],
		related: ['assurance-of-supply', 'dam-evaporation', 'dam-seepage'],
		source: 'docs/model.md §2.11b'
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
		long: 'Model each farm as the land it occupies. The same element type covers three cases, set by its parameters:\n\n• Farm — crops, a dam if it has one, return flow.\n• Stand-alone dam — no crop areas (so no irrigation or return flow), all of its runoff (and upstream inflow, if the dam sits on the main stem) captured by the dam, no diversion.\n• Natural (unused) area — no crops, no dam capture, no diversion: it simply passes its runoff downstream.',
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
		long: 'Use gauges where you want to read the simulated flow, for example at a weir with a record. Every gauge is also an EWR site: its flow is checked against the EWR of everything upstream of it, and a shortfall there is charged to the farms above it. Add gauges at the Reserve determination’s EWR sites to protect upstream reaches. The last gauge in the network is the outflow gauge.',
		category: 'network',
		aliases: ['gauge', 'weir'],
		related: ['outflow-gauge'],
		source: 'b023 Network sheet'
	},
	{
		id: 'element-user',
		term: 'Other water user',
		short: 'A town, industry or unlisted irrigator that takes water from the river at its place in the network, with no land or dam of its own.',
		long: 'Water taken by users that are not modelled farms would otherwise be handed to the farms and the EWR, over-stating both. An other user has a monthly demand (m³/day), a share of what it takes that comes back below it the same day (treated wastewater) and a priority.\n\nIt takes only from the river where it sits: what reaches it from upstream, after anything upstream has taken its share. It is charged for EWR shortfalls below it like a farm, by its net impact (what it takes less what it returns).\n\nOther users are outside the irrigation equitable-share benchmark. A senior user is not curtailed for the EWR; a junior one is (Curtailment tab, "Other water users").',
		category: 'network',
		aliases: ['town', 'municipal', 'industry', 'unlisted user', 'abstraction'],
		fields: ['node.userDemandM3Day', 'run.senior_requirement'],
		related: ['user-priority', 'user-return', 'element-farm', 'ewr'],
		source: 'docs/model.md §2.7c; roadmap WP-1.33'
	},
	{
		id: 'user-priority',
		term: 'User priority (senior / junior)',
		short: 'Senior: farms and junior users upstream must pass its demand first. Junior: it takes what reaches it after them.',
		long: 'A senior user’s demand is a requirement every farm upstream of it passes before it fills its dam or irrigates, shared between those farms by flow share the way the EWR is (the farm diverts less, then lets inflow and its own runoff pass below the dam). A junior user upstream of a senior one leaves the senior demand in the river too.\n\nA junior user takes only what reaches it. Farms have no protected claim, so a junior user upstream of a farm still takes first: position in the river decides.\n\nA municipal allocation is usually senior, which is the default. Senior users are not curtailed for the EWR; their charge is reported and left standing.',
		category: 'network',
		aliases: ['seniority', 'senior', 'junior', 'priority'],
		fields: ['node.userPriority', 'run.passed_for_senior'],
		related: ['element-user'],
		source: 'docs/model.md §2.7c'
	},
	{
		id: 'user-return',
		term: 'Share returned (other user)',
		short: 'Share of what an other water user takes that comes back to the river below it the same day, such as treated wastewater.',
		long: 'A town returns part of what it abstracts through its wastewater works. That share joins the river directly below the user on the same day; the rest is consumed. 0 % means nothing comes back.',
		units: '%',
		category: 'network',
		aliases: ['wastewater', 'return flow', 'effluent'],
		fields: ['node.userReturnPct'],
		related: ['element-user', 'return-flow'],
		source: 'docs/model.md §2.7c'
	},
	{
		id: 'borehole',
		term: 'Boreholes (groundwater)',
		short: 'Groundwater a farm or other user pumps, up to a daily capacity, by a rule: supplemental, primary or drought.',
		long: 'Groundwater is a separate resource with its own licences, so it counts as supply without coming out of the dam or river.\n\n• Supplemental — only for the demand the dam and river leave unmet.\n• Primary — pumped first; the dam and river cover the rest.\n• Drought — supplemental, but only while the dam holds less than its trigger share of capacity at the start of the day (a farm with a dam only).\n\nPart of the pumped water that is lost in irrigation returns to the river like any other return flow.',
		units: 'm³/day',
		category: 'network',
		aliases: ['groundwater', 'borehole', 'well', 'aquifer', 'pumping'],
		fields: ['node.boreholeCapacityM3Day', 'node.boreholeRule', 'node.boreholeTriggerPct', 'run.groundwater_used', 'summary.avgGroundwaterM3Day'],
		related: ['stream-depletion', 'element-farm', 'element-user'],
		source: 'docs/model.md §2.7d; roadmap WP-1.34'
	},
	{
		id: 'stream-depletion',
		term: 'Stream depletion',
		short: 'The river flow a borehole’s pumping captures: a share of the pumped volume, taken from the river below after a lag.',
		long: 'Pumping near a river lowers the dry-season base flow the EWR depends on. The model takes a share d of each day’s pumping from the flow leaving the node, delayed through a single linear store with time constant k days, so the river keeps losing water for a while after the pumps stop and, over a long run, loses d × the pumped volume in all.\n\nThe river never goes below 0: depletion due on a day with nothing left to take is reported as unmet (drawn from aquifer storage instead). A first estimate of k is the stream depletion factor, distance² × storativity ÷ transmissivity (Jenkins 1968).\n\nA gauge or logger record measured while the boreholes pumped already carries their depletion: keep them in the model when calibrating, so the fitted natural flow isn’t reduced twice.',
		category: 'network',
		aliases: ['base flow reduction', 'baseflow depletion', 'Glover', 'Jenkins', 'SDF'],
		fields: ['node.streamDepletionFrac', 'node.streamDepletionLagDays', 'run.baseflow_depletion', 'run.depletion_unmet', 'run.depletion_store', 'summary.avgBaseflowDepletionM3Day'],
		related: ['borehole', 'ewr'],
		source: 'docs/model.md §2.7d; Jenkins (1968); Glover & Balmer (1954)'
	},
	{
		id: 'land-cover',
		term: 'Land cover (invasive plants, forestry)',
		short: 'Invasive alien trees and plantations on a farm use more water than natural vegetation, so the farm passes on less runoff.',
		long: 'Each patch has a cover class, an area and a condensed (canopy) cover: its share of the farm is area × cover ÷ the farm’s area. Each class removes a share of the runoff at full cover: one share of the low flows (the part of each day’s flow up to the flow exceeded 75 % of the days) and another of the rest, because trees take proportionally more of the dry-season flow.\n\nThe class values are indicative (after the South African afforestation reduction curves of Scott & Smith 1997, and Le Maitre et al. 2016 for invasive plants, who put the national loss to invasives at about 2.9 % of the mean annual runoff); confirm them for the catchment or enter a patch’s own.\n\nThe reduction is its own run series, never hidden in the calibration. To see what clearing a class gives back, copy the project, remove the patches and compare the two runs.',
		category: 'network',
		aliases: ['invasive alien plants', 'IAP', 'forestry', 'afforestation', 'plantation', 'streamflow reduction activity', 'wattle', 'eucalyptus', 'pine'],
		fields: ['run.landcover_reduction'],
		related: ['element-farm', 'natural-flow'],
		source: 'docs/model.md §2.5a; Scott & Smith (1997); Le Maitre et al. (2016); roadmap WP-1.35'
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
		fields: ['settings.flowShareMethod', 'node.flowShareManual', 'summary.flowShare'],
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
		related: ['flow-share'],
		source: 'b023 Farm spec'
	},
	{
		id: 'upstream-to-dam',
		term: 'Upstream inflow share (dam)',
		short: 'Fraction of the water arriving from upstream that enters the farm dam; the rest passes below it.',
		long: 'The b023 column is labelled “upstream inflow above dam”: the share of the upstream inflow that enters the dam, above the dam wall. The rest passes below the dam, where the diversion capacity can still take some back. 100 % suits a dam on the river; 0 % an off-channel dam filled only by the diversion.\n\nThe workbook’s formula applied the fraction the other way round (to the water passing below), against its own label and its [Models] sheet. The client confirmed the label’s meaning, and the app follows it from engine 0.9.0. This is also the South African convention: the Pitman/WRSM model describes farm dams by the share of the catchment that drains into them.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		aliases: ['upstream inflow above dam', 'upstream to dam'],
		fields: ['node.pctUpstreamToDam'],
		related: ['runoff-to-dam', 'diversion'],
		source: 'b023 Farm spec; docs/model.md §3 Q1 (resolved)'
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
		long: 'b023 treats a farm’s dams as one composite dam. Water above capacity spills downstream the same day. The dam also loses open-water evaporation and any seepage, and catches the rain on its surface (see dam evaporation).',
		units: 'm³',
		category: 'farm',
		aliases: ['composite dam', 'storage capacity', 'full supply'],
		fields: ['node.damCapacityM3'],
		related: ['dam-initial', 'dam-min', 'spill', 'dam-storage', 'dam-evaporation', 'dam-seepage'],
		source: 'b023 Farm spec'
	},
	{
		id: 'dam-initial',
		term: 'Initial dam storage',
		short: 'How full the dam is on the first simulated day, as a fraction of capacity.',
		long: 'The first weeks of a run depend on this guess. New farms start at 0 % (empty); an imported workbook keeps its own values. Whatever you choose, begin the simulation before the period you study so the dams settle.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		fields: ['node.damInitialPct'],
		related: ['dam-capacity', 'simulation-window'],
		source: 'b023 Farm spec'
	},
	{
		id: 'dam-min',
		term: 'Minimum operating level',
		short: 'Dead storage, as a fraction of capacity: irrigation draws only the water above it, and transfers leave at least this much.',
		long: 'The level below which a farmer stops irrigating from the dam (a pump intake, a reserve for stock water or the dam wall). Each day irrigation can take only yesterday’s storage plus today’s inflows above capacity × this level. A transfer out of the dam keeps the higher of its own minimum storage and this level.\n\n0 % means irrigation may empty the dam, which is how the b023 workbook works; the network editor flags such dams as a hint. The workbook’s “min %” column was the minimum for transfers, which each transfer rule carries, so imported dams start at 0 %.\n\nDecided on the recommendation of a simulated hydrologist review (engine 0.16.0), pending confirmation by the project hydrologist.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		aliases: ['min dam volume', 'dead storage', 'minimum storage'],
		fields: ['node.damMinPct'],
		related: ['transfer', 'transfer-min-storage', 'irrigation-supplied'],
		source: 'docs/engine-audit.md Q5; docs/model.md §2.7'
	},
	{
		id: 'dam-evaporation',
		term: 'Dam evaporation and rain on the dam',
		short: 'A dam loses open-water evaporation from its surface and catches the rain falling on it, every day before irrigation, in m³/day.',
		long: 'The surface shrinks as the dam empties: area = area when full × (yesterday’s storage ÷ capacity)^exponent, with exponent 0.7 for small reservoirs (Liebe et al. 2005). Evaporation = dam evaporation factor × the month’s A-pan ÷ days in the month × area; the factor (Settings, default 0.75) is an A-pan factor: the WR90 / WR2012 lake factors are ratios to S-pan evaporation and must not be entered unchanged. Rain on the dam = the day’s rain (before the rain threshold) × area. Evaporation never takes more than the dam holds.\n\nWhen a dam’s area isn’t known the run estimates it as capacity ÷ 3 m (about the median mean depth of South African farm dams, Mantel & Hughes 2023) and its warnings say how many dams used the estimate. A 100 000 m³ dam of 3 ha loses about 180 m³/day at 6 mm/day of evaporation.\n\nDecided on the recommendation of a simulated hydrologist review (engine 0.16.0), pending confirmation by the project hydrologist.',
		units: 'm³/day; area m²; factor × A-pan',
		category: 'farm',
		aliases: ['evaporation', 'lake evaporation', 'open-water evaporation', 'surface area', 'area–volume', 'lake factor'],
		fields: ['settings.lakeEvapFactor', 'node.damAreaFullM2', 'node.damAreaExponent', 'run.dam_area', 'run.dam_evaporation', 'run.rain_on_dam'],
		related: ['dam-capacity', 'dam-seepage', 'dam-storage'],
		source: 'docs/engine-audit.md N2; Linsley et al. 1982; Liebe et al. 2005; Mantel & Hughes 2023'
	},
	{
		id: 'dam-seepage',
		term: 'Dam seepage',
		short: 'The share of a dam’s storage that seeps out each day; it reaches the river below the dam the same day.',
		long: 'Seepage = seepage per day × yesterday’s storage, taken after evaporation and never more than is left. It is part of the farm’s outflow, so it stays in the catchment. 0 % (the default) for a sealed dam.',
		units: 'fraction of storage per day (shown as %)',
		category: 'farm',
		aliases: ['leakage', 'leak'],
		fields: ['node.damSeepagePerDay', 'run.dam_seepage'],
		related: ['dam-evaporation', 'dam-storage'],
		source: 'docs/engine-audit.md N2'
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
		id: 'irrigation-efficiency',
		term: 'Irrigation efficiency',
		short: 'Share of the water abstracted for irrigation that reaches the crop. The farm abstracts crop requirement ÷ efficiency.',
		long: 'Application losses (evaporation from sprays, wind drift, runoff at the end of the field, deep percolation and leaks) mean a farm has to abstract more than its crops use. With efficiency e, abstraction demand = crop requirement ÷ e, and a fully supplied crop gets exactly its requirement. Indicative values by system: drip 90 %, micro-sprinkler 85 %, centre pivot 85 %, sprinkler 75 %, flood or furrow 65 %; a scheme’s own measurement is better. The one-node form offers these as a helper.\n\nSet 100 % for a stand-alone dam or natural area (no irrigation), or to leave losses out. New farms start at 80 %. Farms from before engine 0.16.0 were converted from their return flow % r as e = 1 − r with every loss returning, so their water balance per unit supplied is unchanged.\n\nDecided on the recommendation of a simulated hydrologist review (engine 0.16.0), pending confirmation by the project hydrologist.',
		units: 'fraction 0–1 (shown as %), above 0',
		category: 'farm',
		aliases: ['application efficiency', 'irrigation system', 'drip', 'pivot', 'sprinkler', 'flood'],
		fields: ['node.irrigationEfficiency'],
		related: ['return-flow', 'irrigation-demand', 'crop-requirement'],
		source: 'docs/engine-audit.md N1; Allen et al. 1998 (FAO-56); Keller & Bliesner 1990'
	},
	{
		id: 'return-flow',
		term: 'Irrigation return flow',
		short: 'The part of the irrigation losses that runs back into the river the same day: loss return fraction × (1 − efficiency) × supplied.',
		long: 'Of the water lost in application, some drains back to the river below the farm (tail-water, shallow drainage, leaks) and some leaves the catchment (evaporation, deep percolation). The loss return fraction is the share that returns; it adds to the farm’s outflow the same day. Consumptive use (what leaves the river) is supplied − return flow.\n\nNew farms start at 50 %. A farm upstream of a starved neighbour can pass it some water this way: that is real (the return is bounded by what the upstream farm abstracts) and attribution by net consumptive use accounts for it.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		aliases: ['loss return', 'return flow %', 'drainage return'],
		fields: ['node.lossReturnFraction'],
		related: ['irrigation-efficiency', 'irrigation-supplied'],
		source: 'docs/engine-audit.md N1; docs/model.md §2.7'
	},
	{
		id: 'spill',
		term: 'Spill',
		short: 'Water that overflows a full dam and continues downstream, in m³/day.',
		long: 'Anything left above capacity after the day’s inflow, transfers, rain on the dam, evaporation, seepage and irrigation. It is part of the farm’s outflow.',
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
		long: 'Yesterday’s storage plus rain on the dam, today’s captured runoff, captured upstream inflow, diversion and transfers, minus dam evaporation, seepage and irrigation, capped at capacity.',
		units: 'm³',
		category: 'farm',
		fields: ['run.dam_storage'],
		related: ['dam-capacity', 'spill'],
		source: 'b023 farm element sheet'
	},
	{
		id: 'working-columns',
		term: 'Working columns',
		short: "A farm's intermediate daily numbers (K … T), so any day can be redone by hand from the daily CSV.",
		long: 'Next to demand, supply, storage and outflow, each farm records the steps in between, in the order of the workbook’s farm sheet: gross demand, the effective rain used against it and the soil-water store left at the end of the day (mm, engine 0.14.0); upstream inflow into the dam (K) and below it (L); farm runoff into the dam (M) and below it (N); water diverted back to the dam (O); interim storage before spill (P); below-dam flow not diverted (S); and irrigation return flow (T).\n\nThe farm’s daily CSV has them in letter order, each header carrying its letter, and the run summary CSV lists every letter’s formula. The results’ “Trace a day” shows them worked out for one farm and one day. Runs made before engine 0.12.0 don’t have them.',
		units: 'm³/day (interim storage m³)',
		category: 'results',
		aliases: ['intermediate columns', 'workings', 'FarmTemplate columns'],
		fields: [
			'run.gross_demand',
			'run.effective_rain',
			'run.upstream_to_dam',
			'run.upstream_below_dam',
			'run.runoff_to_dam',
			'run.runoff_below_dam',
			'run.diverted_to_dam',
			'run.interim_storage',
			'run.below_dam_not_diverted',
			'run.return_flow'
		],
		related: ['balance-check', 'dam-storage', 'return-flow'],
		source: 'b023 FarmTemplate columns F–AB; docs/model.md §2.7'
	},
	{
		id: 'balance-check',
		term: 'Self-checks and the balance check',
		short: 'Every run checks its own output: each farm’s day must balance, and the reports must add up to the daily series.',
		long: 'The balance check (column V) is, for each farm and day: water in (upstream inflow + runoff + transfers + rain on the dam) − water used (supplied − return flow) − dam evaporation − the change in dam storage − outflow (which includes dam seepage). It must be 0; in practice it is float noise, many orders of magnitude below the flows.\n\nEvery run also runs the checks the test suite runs on thousands of random networks: storage stays between 0 and the dam capacity, supply never exceeds demand, transfers keep to their months, rates, caps and minimum storage, the runoff model’s stores balance, and the EWR grid, farm summaries and curtailment report add up to the daily series. The results show which passed and, for a failure, the first farm and date where it broke. A failed check means a bug in the model, not in your data: report it.\n\nThe water balance per water year shows where the water went: start storage + farm runoff + transfers + rain on dams = consumptive use (supplied − return flow) + dam evaporation + outflow + end storage, with a residual that should be 0.',
		units: 'm³/day',
		category: 'results',
		aliases: ['verification', 'invariants', 'mass balance', 'water balance', 'residual'],
		fields: ['run.balance_residual'],
		related: ['working-columns', 'dam-storage'],
		source: 'docs/model.md §6 Verification'
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
		term: 'Crop factor (× A-pan)',
		short: 'Monthly multiplier from A-pan evaporation to a crop’s water use. 12 values, Oct … Sep. Not an FAO Kc.',
		long: 'Gross requirement (mm) = A-pan × crop factor for that month. Factors vary with the growth stage; deciduous fruit, for example, needs little in winter.\n\nThe factor multiplies Class-A pan evaporation, not FAO reference evapotranspiration (ET₀). ET₀ is about 0.7–0.85 × pan, so a published FAO-56 Kc entered here overstates demand by roughly a quarter: multiply it by the pan coefficient first. A factor above 1.0 is possible but unusual against a pan, so the Crops tab points it out.',
		units: 'dimensionless',
		category: 'crops',
		aliases: ['Kc', 'crop coefficient', 'pan factor'],
		fields: ['crop.cropFactor', 'crop.name'],
		related: ['apan', 'crop-area'],
		source: 'b023 Crop demand'
	},
	{
		id: 'crop-area',
		term: 'Crop area',
		short: 'Area of each crop on each farm, entered in hectares. Leave a crop blank on farms that don’t grow it.',
		long: 'The farm’s demand is the sum over its crops of area × requirement. Stand-alone dams and natural areas have no crop area.',
		units: 'ha (stored as m²; 1 ha = 10 000 m²)',
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
		long: 'Rain above the rain threshold gives cropped area × rain × this fraction of effective rain. It covers the day’s demand first; what the crop can’t use that day goes into the soil-water store and covers the following days. Light rain at or below the threshold never counts.',
		units: 'fraction 0–1',
		category: 'crops',
		aliases: ['effective rain'],
		fields: ['settings.effectiveRainFraction'],
		related: ['irrigation-demand', 'rain-threshold', 'soil-water-store'],
		source: 'b023 Crop demand; docs/model.md §2.3'
	},
	{
		id: 'soil-water-store',
		term: 'Soil-water store',
		short: 'Effective rain the crop can’t use on the day it falls is kept in the soil, up to this depth (mm), for the next days.',
		long: 'Each farm has one store over its cropped area, a one-bucket form of the FAO-56 root-zone balance. Each day: effective rain is added; the day’s gross demand is met from the store plus that rain first; what is left stays, up to this depth, and the excess drains or runs off (the runoff model already counts it). The store starts empty.\n\nThe default 25 mm is the readily available water of 0.5 m of roots in a soil holding 100 mm/m, half of which the crop can take without stress (FAO-56 Tables 19 and 22). Deeper roots or a heavier soil hold more. 0 mm turns carry-over off: each day’s rain then only offsets that day, as the b023 workbook does.\n\nThis was decided on a simulated hydrologist’s recommendation and is pending the real hydrologist’s review. The daily farm CSV and “Trace a day” show the store at the end of each day.',
		units: 'mm over the cropped area',
		category: 'crops',
		aliases: ['soil moisture', 'carry-over', 'root zone', 'readily available water', 'RAW'],
		fields: ['settings.effectiveRainStoreMm', 'run.soil_water'],
		related: ['effective-rainfall', 'irrigation-demand', 'working-columns'],
		source: 'Allen et al. 1998 (FAO-56) ch. 8; docs/engine-audit.md N3; docs/model.md §2.3'
	},
	{
		id: 'crop-requirement',
		term: 'Crop water requirement',
		short: 'Water the farm’s crops need from irrigation on a given day, after effective rain, in m³/day (the workbook’s net irrigation demand).',
		long: 'Gross demand comes from crop areas × A-pan × crop factor, spread over the days of the month. The requirement subtracts the effective rain used that day, from the day’s rain or from the soil-water store it filled on earlier days, and never goes below zero. The farm abstracts more than this to cover application losses: see irrigation demand.',
		units: 'm³/day',
		category: 'crops',
		aliases: ['crop water requirement', 'net irrigation need', 'net demand'],
		fields: ['run.crop_requirement', 'summary.avgCropRequirementM3Day'],
		related: ['irrigation-demand', 'irrigation-efficiency', 'effective-rainfall'],
		source: 'b023 Irrigation Demand; docs/model.md §2.3'
	},
	{
		id: 'irrigation-demand',
		term: 'Irrigation demand (abstraction)',
		short: 'Water the farm has to abstract to meet its crop water requirement: requirement ÷ irrigation efficiency, in m³/day.',
		long: 'Supply, deficit, the fraction supplied and the curtailment report are all measured against this abstraction demand, so 100 % supplied means the crop got its full requirement. With 100 % efficiency it equals the crop water requirement, as in the b023 workbook.',
		units: 'm³/day',
		category: 'crops',
		aliases: ['demand', 'abstraction', 'gross irrigation requirement'],
		fields: ['run.demand', 'summary.avgDemandM3Day'],
		related: ['crop-requirement', 'irrigation-efficiency', 'irrigation-supplied', 'irrigation-deficit'],
		source: 'docs/engine-audit.md N1; docs/model.md §2.7'
	},
	{
		id: 'irrigation-supplied',
		term: 'Irrigation supplied',
		short: 'Water actually delivered to the crops that day: the demand, or less when the dam and inflows run short.',
		long: 'Irrigation draws on yesterday’s storage above the dam’s minimum operating level plus today’s captured inflows and transfers, up to the abstraction demand. Average supplied ÷ average demand is the fraction of demand supplied; the crop gets efficiency × supplied, so the same fraction of its requirement.',
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
		short: 'Abstraction demand that could not be met: demand minus supplied, in m³/day.',
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
		long: 'Each day in an active month the transfer takes what the source dam held at the end of yesterday above its minimum level, up to the room at the destination (its free space plus that day’s irrigation demand) and the maximum rate (and daily cap, if set). Transfers move before any farm irrigates. The same volume leaves the source and enters the destination, so it always balances.\n\nb023 writes transfers as free-form formulas; the app uses these structured rules instead. Anything a workbook does that doesn’t fit them needs discussing with the hydrologist.',
		category: 'transfers',
		aliases: ['pipeline', 'canal', 'from', 'to'],
		fields: ['transfer.fromNodeId', 'transfer.toNodeId', 'transfer.enabled', 'run.transfer'],
		related: ['transfer-months', 'transfer-rate', 'transfer-min-storage'],
		source: 'b023 Help (Transfers sheet); docs/model.md §2.6'
	},
	{
		id: 'transfer-months',
		term: 'Transfer months',
		short: 'The months in which the transfer runs, ticked on a row of month toggles (Oct … Sep). Outside them nothing moves.',
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
		long: 'The day’s transfer is the smallest of the available water in the source dam, the room at the destination, the rate × 86 400 s, and the daily cap when one is set.',
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
		short: 'The source dam is not drawn below this fraction of its capacity by this transfer, nor below the dam’s own minimum operating level.',
		long: 'Checked against yesterday’s end-of-day storage. The reserve kept is the higher of this value and the source dam’s minimum operating level.',
		units: 'fraction 0–1 (shown as %)',
		category: 'transfers',
		fields: ['transfer.minStoragePct'],
		related: ['dam-min', 'transfer'],
		source: 'b023 Transfers configuration; docs/model.md §3 Q3'
	},
	{
		id: 'transfer-priority',
		term: 'Transfer priority and the receiver’s room',
		short: 'Rules with a lower priority move first; rules of equal priority from one dam share it in proportion to their limits.',
		long: 'Each day, before any farm irrigates, each rule moves the smallest of: what its source dam holds above its minimum (yesterday’s storage, less what earlier rules took), the room at its destination (free space in the destination’s dam once that day’s rain on it, evaporation and seepage are counted, plus that day’s irrigation demand, less what other rules already sent it), and its rate or daily cap. A transfer to a farm with no dam still serves the farm’s demand; water is never pumped into a full dam only to spill.\n\nRules run by priority, lowest first. Rules with the same priority share: two rules from one dam split its water in proportion to their own limits, and two rules into one farm split its room the same way, so the order of the list never changes a result. New rules start after the existing ones. The source’s own irrigation comes after the day’s transfers (the source doesn’t irrigate first).\n\nDecided on the recommendation of simulated hydrologist and licensing reviews (engine 0.16.0), pending confirmation by the project hydrologist.',
		units: 'whole number',
		category: 'transfers',
		aliases: ['priority', 'order', 'pro rata', 'free space', 'receiving dam'],
		fields: ['transfer.priority'],
		related: ['transfer', 'transfer-min-storage', 'transfer-rate'],
		source: 'docs/engine-audit.md N4, Q18; docs/model.md §2.6'
	},

	// ---- Natural flow and calibration -----------------------------------------
	{
		id: 'natural-flow',
		term: 'Natural flow',
		short: 'The flow the catchment would produce with no farms, dams or abstraction, in m³/day. Generated from rain.',
		long: 'The runoff model turns daily rain into natural flow: GR4J by default, or the legacy b023 routine (a calibrated rain → peak → recession routine and a slowly receding base flow). The workbook fell back to a Pitman flow column on days the rain model gave nothing (quirk Q7); the app does not, so natural flow always comes from the runoff model.\n\nNatural flow is then split into farm runoff by the flow shares.',
		units: 'm³/day',
		category: 'flow',
		aliases: ['naturalised flow', 'virgin flow'],
		fields: ['run.natural_flow', 'catchment.meanNaturalFlowM3Day', 'run.resultant_flow'],
		related: ['calibration', 'flow-share', 'base-flow'],
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
		short: 'What leaves the element downstream each day: spill, water bypassing the dam, dam seepage and irrigation return flow, in m³/day.',
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
		short: 'Which model turns rain into natural flow. GR4J is the default; legacy is the b023 model, kept for workbook comparison only, not evidence.',
		long: 'Legacy is the workbook’s empirical recession model, ported unchanged. The engine audit found that it does not conserve water: one small storm can return several times its own volume as flow (docs/engine-audit.md H1). Decided (persona recommendation, 2026-09-24; pending the hydrologist): legacy stays unchanged and is kept for workbook comparison only — not evidence for a licence, Reserve or compliance assessment. A legacy run carries this warning, an amber “Workbook comparison” badge, and a leading comment on its CSV exports.\n\nThe setting only changes how rain becomes natural flow. Flow shares, farms, dams, transfers and the EWR are the same whichever model made the flow, so two runs that differ only in the runoff model compare directly.',
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
		long: 'A Class-A pan evaporates more than a catchment’s soils and plants could, so conceptual runoff models scale it down. 0.7 is a common flat value. Monthly values (for example the WR90 or Midgley factors) can be entered instead. The coefficient does not affect irrigation demand, which uses crop factors on the A-pan directly. It is used only while GR4J’s potential evaporation is set to pan coefficient × A-pan; with a monthly PE row entered directly GR4J ignores it.\n\nThree presets fill the row as a starting point (still editable; picking one writes its name into the optional “Pan coefficient source” note): Generic (flat 0.70), Winter rainfall (e.g. Western Cape) and Summer rainfall. They are indicative, from FAO-56 Table 5 climate classes (Allen et al. 1998) — confirm against local humidity and wind. A run warns, and Settings hints, when a month sits outside FAO-56’s usual 0.6–0.85 range for a Class A pan; that is a plausibility check, not a hard limit, so a value further out still saves and runs.\n\nThe FAO-56 Table 5 helper fills the row from monthly humidity and wind, the pan’s siting and its fetch, and writes the table cells and your note on where the humidity and wind came from into the same source note. The note is provenance only: fits and runs record it, and editing it never marks a fit’s forcing as changed.\n\nBecause GR4J’s parameters trade off against evaporation, the coefficient is held fixed and never calibrated: a fit records the coefficient it ran under, and changing it afterwards marks the fit record “Forcing changed since fit”.',
		category: 'flow',
		aliases: ['PET', 'potential evaporation', 'k pan', 'pan coefficient preset', 'FAO-56'],
		fields: ['settings.panCoefficient', 'settings.panCoefficientSource', 'run.pet'],
		related: ['gr4j', 'apan', 'auto-calibration'],
		source: 'Issue #4 §1 (forcing); FAO-56 Table 5 (Allen et al. 1998); docs/model.md §2.4a'
	},
	{
		id: 'gr4j-pe',
		term: 'GR4J potential evaporation (source)',
		short: 'Where GR4J’s potential evaporation comes from: pan coefficient × A-pan (default), or a monthly PE row entered directly.',
		long: 'One A-pan row drives three things: GR4J’s potential evaporation (× the pan coefficient), irrigation demand (× the crop factors) and dam evaporation (× the dam evaporation factor). With **Pan coefficient × A-pan**, the default and what every earlier run did, changing the A-pan row moves all three.\n\n**Monthly PE, entered directly** gives GR4J its own 12 values in mm (Oct … Sep), for example a station’s FAO-56 reference evapotranspiration (ET₀) × a stated factor, with a required note of the source. GR4J then runs on that row alone; the pan coefficient is not used, and irrigation demand and dam evaporation still read the A-pan row, so a PE change moves the runoff model and nothing else. A row of zeros is refused, as a zero A-pan row is.\n\nSettings shows the annual PE GR4J runs on under either choice. A fit records the PE input it ran under, so changing it marks the fit record “Forcing changed since fit”.',
		units: 'mm per month',
		category: 'flow',
		aliases: ['PE', 'PET', 'ET0', 'ET₀', 'reference evapotranspiration', 'monthly PE', 'evaporation source'],
		fields: ['settings.pe'],
		related: ['pan-coefficient', 'apan', 'gr4j'],
		source: 'Issue #39; FAO-56 (Allen et al. 1998); docs/model.md §2.4a'
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
		long: 'The search is DDS (Tolson & Shoemaker 2007): it tries a set number of model runs, perturbing all parameters at first and fewer as it homes in, and never leaves each parameter’s allowed range. It runs several separate searches (Starts, default 5), each from its own seed, and keeps the best; nearly equal scores with scattered parameters mean the record can’t pin them down. Every run scores the whole model, farms and dams included, against the observed record over the calibration window.\n\nPick what to optimise: KGE′ (the default), a year-balanced KGE′ that stops a few wet years dominating, a non-parametric KGE, or NSE on √Q or log Q for medium and low flows.\n\nThe fit alone says little. Validation fits again on the first half of the record and scores the second half, then fits on the driest water years and scores the wettest (listed by water year, since they interleave). With both a gauge and a logger record you can also score the fit against the record it wasn’t fitted to, a second instrument. Those columns are the honest measure. With a short record that is mostly drought, the result says so: wet-year behaviour is then weakly constrained. Nothing is saved until you apply the result and save the form.',
		category: 'fit',
		aliases: ['auto-calibration', 'optimiser', 'DDS', 'split-sample', 'differential split-sample', 'validation', 'KGE′'],
		related: ['calibration', 'gr4j', 'nse'],
		source: 'Tolson & Shoemaker (2007); Klemeš (1986); Kling et al. (2012); docs/model.md §2.10b'
	},
	{
		id: 'uncertainty-bands',
		term: 'Uncertainty bands (behavioural ensemble)',
		short: 'How far a run’s results move across every parameter set and forcing the data can’t rule out: 5–95 % bands, never below 30 kept sets.',
		long: 'One calibrated run gives one number for EWR days not met, curtailment and the annual volumes, but many parameter sets fit the record nearly as well, and the pan coefficient, the rain and the observed record are uncertain too. The ensemble samples them all: a Latin hypercube across the parameter bounds (never the optimiser’s own path), a shift of the pan coefficient (GR4J), station rain with CHIRPS infill or CHIRPS alone, and the gauge or the logger to judge against, where the project has both.\n\nA set is kept only if it passes the rule printed next to the bands: a skill score (KGE′ by default) on the first half of its record, the WR2012 flag on its natural flow, and the low-flow bias. The bands are the 5th to 95th percentiles of the kept sets; with fewer than 30 kept none are shown. The second half of the record is held out: the share of its observations inside the daily band is the coverage, and below 70 % the band is too narrow to trust.\n\nThe server fixes the rule and draws the seed before anything runs, keeps every ensemble started, and re-runs members to check a result before storing it, so a band can’t be picked after the fact. Run comparison bands the difference between two runs member by member: the extra impact of an application, with its own uncertainty.',
		category: 'fit',
		aliases: ['GLUE', 'uncertainty', 'ensemble', 'Latin hypercube', 'behavioural', 'confidence band', 'coverage'],
		related: ['auto-calibration', 'wr2012-check', 'calibration-bounds'],
		source: 'Beven & Binley (1992); McKay et al. (1979); docs/model.md §2.10e; issue #4 phase 9'
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
		long: 'When it is on, Fit automatically adds weight × |ln(simulated natural MAR ÷ scaled WR2012 MAR)| to the loss it minimises, so a wetter and a drier MAR by the same factor cost the same. It only touches the annual volume, not the daily pattern. When two published natural-MAR estimates disagree, tick “Use a MAR band instead of one target”: the penalty is then 0 inside the band (already at the modelled catchment’s scale) and weight × |ln(simulated MAR ÷ the nearer bound)| outside it.\n\nThe result shows the fit with the penalty and the same fit without it, with the weight, so you can see what matching WR2012 costs the fit to the observed record. A short or impacted observed record can disagree with WR2012 for good reasons; the penalty is a nudge, not a constraint.',
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
		long: 'The record keeps the runoff model, objective, bounds, seed, starts, model runs per fit, calibration window, exclusions, the record fitted to, the forcing (pan coefficient, A-pan, CHIRPS bias correction and the rain-gap settings), the engine version and the time, with every score: the in-sample fit and the split-sample, dry → wet and independent-record validation. The same inputs, engine version and seed give the same fit, so anyone can reproduce it. Each run keeps the record in effect, so its results show which fit produced their parameters. Change a fitted parameter by hand and the record is marked “Parameters edited since fit”: it no longer describes them. Change the forcing and it is marked “Forcing changed since fit”: GR4J’s parameters are only valid for the evaporation and rain they were fitted under. The in-sample score is the fit to the calibration period; judge the parameters by the validation scores.',
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
		short: 'Daily rain at or below this (mm) doesn’t reduce irrigation demand, and in the legacy model produces no flow. b023 default 2 mm.',
		long: 'Filters out drizzle that the soil absorbs. In the legacy model the same thresholded rain drives both runoff and the effective-rain offset (quirk Q6). GR4J uses all the rain; with GR4J the setting only applies to demand (“Rain threshold for demand”).',
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
		short: 'Months that always use the summer response (legacy model), ticked Oct … Sep. Set them for the catchment’s dry season.',
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
		long: 'Reserve tables vary the requirement with how wet the month is, which is hard to plan for on a farm. b023 instead picks one value per month — typically a percentile of the Reserve flows without high flows, converted to m³/day — so farmers know in advance how much to leave in the river.\n\nEnter the 12 monthly values, Oct … Sep. The catchment value is checked at the outflow gauge and split into per-farm shares by the flow shares; each gauge is checked against the shares of everything upstream of it.',
		units: 'm³/day per month',
		category: 'ewr',
		fields: ['settings.ewrPragmaticM3PerDay', 'run.ewr'],
		related: ['ewr', 'desktop-reserve-model', 'flow-share'],
		source: 'b023 Help (EWR configuration); EWR Cfg; docs/model.md §3 Q10'
	},
	{
		id: 'ewr-share',
		term: 'Farm EWR share',
		short: 'The farm’s part of the pragmatic EWR (EWR × its flow share), added up down the river to give the EWR each point must pass.',
		long: 'The daily series is the cumulative EWR: the farm’s own share plus the cumulative EWR of the elements directly upstream, as the b023 Element sheets compute it (quirk Q4). A gauge is checked against the same sum, and the outflow gauge against the full EWR. Who is charged for a shortfall is the EWR charge, not a farm’s own share.',
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
		long: 'At the outflow gauge it is simulated outflow minus the pragmatic EWR on days it falls short; at a gauge, the flow there minus the EWR of everything upstream. Who is charged for it is the EWR charge.',
		units: 'm³/day',
		category: 'ewr',
		aliases: ['EWR not met', 'deficit to the river'],
		fields: ['run.ewr_shortfall'],
		related: ['ewr-days-not-met', 'pragmatic-ewr', 'ewr-charge'],
		source: 'b023 EWR shortfalls sheet'
	},
	{
		id: 'ewr-charge',
		term: 'EWR charge',
		short: 'A farm’s share of the EWR shortfall at the EWR sites below it, pro rata to its net impact that day.',
		long: 'The EWR is assessed at EWR sites: the outlet and every gauge. On a day a site is short by D, each farm upstream of it has a net impact e = inflow + runoff + transfers − outflow (its consumptive use, storage gain and exports; a transfer counts only when it leaves the site’s catchment). The farms are charged D in proportion to the positive impacts, but never more than the sum of those impacts: the rest is natural, because natural flow was already below the EWR. A farm that added water that day (a dam release, return flow) is neither charged nor credited. A farm above several sites carries the largest of its charges, not the sum, because a cut upstream raises the flow at every site below it; the site that sets it is its binding site.\n\nA farm short on its own reach is not charged while every EWR site is met. Add gauges at the Reserve determination’s EWR sites to protect upstream reaches. A cut can be taken up by a dam between two nested sites; only a re-run with the cuts applied shows that.\n\nThe curtailment report uses the charge (engine 0.17.0). Before, it used the reach shortfall, which could charge a farm more than it took or for low flow nobody caused. Decided on a simulated CMA-assessor recommendation (2026-09-24), pending the real assessor and hydrologist.',
		units: 'm³/day (negative in the daily series)',
		category: 'ewr',
		aliases: ['EWR attribution', 'charged to farms', 'natural shortfall', 'binding site', 'net impact'],
		fields: ['run.ewr_charge', 'run.ewr_charged', 'run.ewr_natural', 'summary.avgEwrShortfallM3Day'],
		related: ['ewr-shortfall', 'ewr-charge-split', 'reach-shortfall'],
		source: 'docs/model.md §2.7b; docs/engine-audit.md Q17'
	},
	{
		id: 'ewr-charge-split',
		term: 'Irrigate less / store less',
		short: 'The EWR charge split by what the farm can change: its irrigation, or its storage and pass-through.',
		long: 'For a farm charged A on a day, c = supplied − return flow is its consumptive irrigation and o = e − c the rest of its impact (storage gain and net export). The irrigation part is A × c ÷ (c + max(o, 0)); the rest is “store less / pass inflow”. A farm with no irrigation therefore gets no irrigation cut: its charge is a storage or release condition.\n\nThe supply cut that removes the irrigation part is irrigation part ÷ (1 − β(1 − e)), with e the irrigation efficiency and β the loss return fraction: cutting supply by ΔG removes ΔG × (1 − β(1 − e)) of consumptive use, since the returned losses come back to the river.',
		units: 'm³/day; l/s',
		category: 'ewr',
		aliases: ['supply cut', 'pass inflow', 'store less'],
		fields: ['run.ewr_charge_irrigation'],
		related: ['ewr-charge', 'irrigation-efficiency'],
		source: 'docs/model.md §2.7b and §2.11; docs/engine-audit.md Q13, Q17'
	},
	{
		id: 'equitable-share',
		term: 'Equitable share of supply (fairness benchmark)',
		short: 'Σ supplied ÷ Σ demand: the share of its demand each farm would get if supply were shared in proportion. Not an allocation.',
		long: 'Over the reporting window, the catchment supplied this share of the total demand. A farm’s equitable share volume is that same share of its own demand, and “above (−) / below (+) equitable share” is that volume minus what it was supplied. The differences cancel across the farms.\n\nIt is a fairness benchmark only: it assumes water can move freely between farms, and ignores where a farm sits in the network, its storage, licensed or registered volumes and existing lawful use. A positive value is not water the farm can get: a surplus downstream can’t reach a farm upstream. Not an allocation or licence condition.\n\nUnder the National Water Act, sharing in a shortage runs through authorisations (s43 compulsory licensing; Schedule 3 item 6 restrictions, which DWS gazettes as % limits on authorised use per sector). A network-aware allocation based on licensed or registered volumes is future work; model demand is not an entitlement, and raising crop factors or areas raises a farm’s benchmark.',
		units: '% of demand; m³/day',
		category: 'results',
		aliases: ['equitable supply fraction', 'target volume', 'fair share', 'reduce / gain'],
		related: ['demand-left', 'ewr-charge', 'report-window'],
		source: 'b023 Shortfalls columns K total, M, N; docs/model.md §2.11; docs/engine-audit.md Q11'
	},
	{
		id: 'demand-left',
		term: 'Demand left',
		short: 'Share of a farm’s demand left to irrigate once supply is shared fairly and the EWR supply cut is made.',
		long: 'Volume left ÷ demand, where the volume left is the equitable share minus the EWR supply cut, and never below 0. Shown as a whole %: “no demand” for a farm without demand, “—” when demand is under 1 m³/day (a % of almost nothing isn’t meaningful), and “<1%” or “>99%” at the ends so neither rounds to 0 or 100. The summary CSV keeps the exact value and a demand_pct_note column.\n\nWhen the EWR supply cut is larger than the farm’s equitable share, the volume left is 0 and the table flags “EWR cut exceeds this farm’s equitable share”. The workbook labels this column “reduction of demand required”, but it is the share left.',
		units: '% of demand',
		category: 'results',
		aliases: ['volume left', 'reduction of demand required', 'demand_pct_note'],
		related: ['ewr-charge-split', 'report-window'],
		source: 'b023 Shortfalls columns U, V; docs/model.md §2.11; docs/engine-audit.md Q12, Q13'
	},
	{
		id: 'reach-shortfall',
		term: 'Reach shortfall (workbook AB)',
		short: 'The workbook’s incremental shortfall: a farm’s shortfall minus those directly upstream. A diagnostic only.',
		long: 'MIN(AA − Σ AA of the elements directly upstream, 0), as the b023 Element sheets compute it. It shows where along the river the flow falls below the accumulated EWR, but it does not add up to the outlet shortfall, never credits a farm that adds water, and can charge a farm for a reach the next farm makes good. From engine 0.17.0 it no longer drives curtailment: the EWR charge does.',
		units: 'm³/day',
		category: 'ewr',
		aliases: ['incremental shortfall', 'AB'],
		fields: ['run.ewr_shortfall_incremental'],
		related: ['ewr-charge'],
		source: 'b023 Element sheets column AB; docs/model.md §3 Q17'
	},
	{
		id: 'ewr-days-not-met',
		term: 'Days EWR not met',
		short: 'Number (or share) of simulated days on which flow was below the EWR.',
		long: 'The headline measure of how often the river fails. Look at when the failures happen, too: a few summer weeks every year differ from a multi-year drought.\n\nFor a farm it counts the days the farm was charged for a shortfall at an EWR site below it (engine 0.17.0; before, the days its reach shortfall was below 0).',
		units: 'days; fraction 0–1',
		category: 'ewr',
		fields: ['summary.daysEwrNotMet', 'catchment.ewrDaysNotMet', 'catchment.ewrFractionDaysNotMet'],
		related: ['ewr-shortfall'],
		source: 'b023 EWR analysis'
	},
	{
		id: 'reserve-rules',
		term: 'EWR rule table (the Reserve’s assurance rules)',
		short: 'The Reserve’s EWR as a table: per month, the flow required at each assurance level, read at the natural flow’s percentile.',
		long: 'A South African Reserve determination (the Desktop Reserve Model and its revised form) gives the ecological water requirement as a table: for each month, the flow required at each assurance level, or “% point” (10 %, 20 % … 90 %, 99 %). Assurance is the share of time the flow should be equalled or exceeded, so 10 % is the requirement in wet conditions and 99 % the drought flow. The gazette pairs it with the natural flow at the same points.\n\nEnter one table per EWR site: the outlet, or a gauge placed at the determination’s EWR site. Say where it comes from, the unit (Mm³ per month, or the month’s mean m³/s), whether it is the total flow or low flows only, and where the natural-flow percentile comes from: the run’s own natural flow at the site (ranked among the same month in every year of the run), or the table’s natural flows. The scale multiplies every value, for a table given for a larger or smaller catchment than the site.\n\nPaste the 12 month rows from a spreadsheet or a PDF, with the heading row of % points if you have it; month names in the first column put rows in order. The table adds a monthly compliance report. The pragmatic EWR still drives the daily EWR charge and curtailment.',
		units: 'Mm³ per month or m³/s; % points 0–100',
		category: 'ewr',
		aliases: ['assurance rules', 'assurance table', 'rule curve', 'Reserve rule table', 'Reserve determination', 'maintenance low flows', 'drought flows'],
		fields: ['settings.ewrRules'],
		related: ['reserve-compliance', 'ewr', 'desktop-reserve-model', 'ewr-days-not-met'],
		source: 'Hughes & Hannart (2003); Hughes et al. (2014); Pollard et al. (2011) WRC K8/881/2; docs/model.md §2.9c'
	},
	{
		id: 'reserve-compliance',
		term: 'Monthly compliance with the Reserve rules',
		short: 'Share of months whose simulated flow met the Reserve rule table’s requirement for that month’s natural condition.',
		long: 'For each complete calendar month, the month’s natural flow at the EWR site (the upstream farms’ runoff, before any dam or abstraction) is placed on that month’s natural flow duration curve. The EWR is read from the rule table at the same % point, interpolated between points, and the month is met when the simulated flow at the site is at least that. A naturally dry month is held to the drought flow; a wet one to more. The requirement depends only on natural flow, so more abstraction can only lose months.\n\nThe report gives the share of months met (the headline), per month of the year, the deficit volume, the longest run of consecutive months not met and the FDC check: whether the simulated flow duration curve of each month lies on or above the EWR curve at each % point. Days below the pragmatic EWR stay alongside as a second measure. With fewer than 10 years of a month the percentiles are coarse, and the run says so. The daily series ewr_rule is each month’s requirement per day.',
		units: 'share of months; Mm³; months',
		category: 'ewr',
		aliases: ['Reserve compliance', 'assurance compliance', 'months met', 'contiguity', 'FDC check'],
		fields: ['run.ewr_rule'],
		related: ['reserve-rules', 'ewr-days-not-met', 'ewr-agreement'],
		source: 'Hughes & Münster (2000); Sawunyama & Hughes (2010); Pollard et al. (2011); Riddell et al. (2014); docs/model.md §2.9c'
	},
	{
		id: 'plausibility-checks',
		term: 'Plausibility checks',
		short: 'Four checks a reviewing hydrologist makes on a run: they only warn, and never change a result.',
		long: 'Every run makes four checks and shows them in the Plausibility checks panel on Runs & results, in its warnings and in the summary CSV:\n\n1. natural flow is at least the observed flow plus the modelled net abstraction, in every water year;\n2. EWR days not met, split between good-rain years (rain mostly from the catchment station) and fallback-rain years (mostly CHIRPS, forecast, spread or blank days);\n3. the double-mass curve of observed flow against rain, to tell new use upstream from a failing gauge;\n4. dry-season low-flow duration curves of the gauge, the logger and the model, overlaid with the latest run of each other runoff model.\n\nThe dry season is the six calendar months in a row with the lowest mean flow: from the calibration record, else the other observed record, else the simulated natural flow. The thresholds are engine constants, each with its reason in docs/model.md §2.10d, for the hydrologist to confirm.',
		category: 'results',
		aliases: ['sanity checks', 'hydrologist checks', 'dry season', 'plausibility'],
		related: ['plausibility-naturalised', 'plausibility-rain-source', 'plausibility-flow-double-mass', 'plausibility-low-flow'],
		source: 'Not in the workbook; issue #4 phase 6 review; docs/model.md §2.10d'
	},
	{
		id: 'plausibility-naturalised',
		term: 'Natural flow ≥ observed + abstraction',
		short: 'Observed flow plus what the network took out upstream is the natural flow the record implies; it can’t exceed the simulated natural flow.',
		long: 'On each water year of the calibration record (300 or more observed days, calibration exclusions left out), the observed volume O plus the modelled net abstraction A rebuilds the natural flow the record implies. A is natural flow less the simulated outflow, from the network’s own water balance, split into use net of return flows (irrigation, other users, boreholes), dams (storage gained plus evaporation less rain on the dam) and land cover.\n\nA year fails when O + A exceeds the simulated natural flow by more than 10 % of the observed volume, the annual error of a well-rated gauging weir (at least 1 % of the record’s mean volume, so a near-dry year doesn’t fail on noise). Since A is natural less simulated outflow, that is the same as the simulated outflow falling short of the observed by that much. A failing year points to natural flow simulated too low (rain, parameters), abstraction over-estimated, or a problem in the record that year.',
		units: 'Mm³ per water year',
		category: 'results',
		aliases: ['naturalised flow', 'naturalisation check', 'observed plus abstraction'],
		related: ['plausibility-checks'],
		source: 'Not in the workbook; Wessels & Rooseboom (2009); McMillan, Krueger & Freer (2012); docs/model.md §2.10d'
	},
	{
		id: 'plausibility-rain-source',
		term: 'Good-rain and fallback-rain years',
		short: 'EWR days not met, split by whether the water year’s rain came mostly from the catchment station or from fallback rain.',
		long: 'A day’s rain is a station reading when the catchment rain series has a value the run used as recorded. It is fallback rain when bias-corrected CHIRPS or forecast rain filled it (a blank day, a zero run treated as missing, a listed missing period), when a multi-day accumulation was spread onto it, or when nothing filled it and it ran dry.\n\nA water year is a fallback-rain year when more than half its rain, or more than half its days, were fallback; every other year is a good-rain year. The panel gives the share of days the outlet EWR was not met in each group and, with a Reserve rule table, the share of months met. The run warns when the groups differ by 10 percentage points or more: part of the EWR result may then come from the rain source rather than the river. It can also be real climate, such as a station out of action through a drought.',
		category: 'results',
		aliases: ['fallback years', 'CHIRPS years', 'rain source', 'infilled rainfall years'],
		related: ['plausibility-checks', 'zero-rain-runs', 'rain-accumulations', 'chirps-bias', 'reserve-compliance'],
		source: 'Not in the workbook; docs/model.md §2.10d'
	},
	{
		id: 'plausibility-flow-double-mass',
		term: 'Double mass: observed flow vs rain',
		short: 'Cumulative observed flow against cumulative rain: a kink means the catchment’s use or the gauge changed.',
		long: 'While the catchment, its development and the gauge stay the same, cumulative observed flow plotted against cumulative catchment rain is a straight line; its slope is the runoff ratio. The check uses the calibration record’s water years with 300 or more days having both flow and rain and at least 100 mm of rain (10 such years or no result), and finds breaks as the rain-vs-CHIRPS double-mass check does.\n\nThe runoff ratio falls in a run of dry years on its own, so each break is compared with the simulated outflow over the same days, which has the same rain and fixed development. A change the model shows too is the rain’s. A fall the dry season takes more of points to new use upstream (abstraction and filling dams take a larger share of low flows); a fall the wet season takes more of, or a rise, points to the gauge (a rating change, or floods bypassing or drowning the weir). It is a hint: check the gauge’s records and the development history.',
		category: 'results',
		aliases: ['double mass curve flow', 'runoff ratio break', 'gauge failure', 'new upstream use', 'homogeneity of flow'],
		related: ['plausibility-checks', 'double-mass'],
		source: 'Not in the workbook; Searcy & Hardison 1960; docs/model.md §2.10d'
	},
	{
		id: 'plausibility-low-flow',
		term: 'Dry-season low-flow duration curve',
		short: 'The flow duration curve of dry-season days only, for the gauge, the logger and each model’s simulated flow.',
		long: 'Each curve gives the flow equalled or exceeded on a share of the dry-season days (Q90: 90 % of them). The gauge and the logger are drawn dashed, each on its own days; the simulated outflow and natural flow cover every dry-season day of the run, and the latest run of each other runoff model is drawn beside them when it used the same dry season. "Simulated outflow over" switches the model’s curve to one record’s days only, for a like-for-like comparison.\n\nThe run warns when, on the calibration record’s dry-season days, the simulated Q90 is more than twice or less than half the observed. Low flows are where a gauge is least certain (±50–100 %), so a factor of 2 is beyond gauging error. Flows under 0.001 m³/s count as 0.001.',
		units: 'm³/s',
		category: 'results',
		aliases: ['low flow FDC', 'dry season FDC', 'Q90', 'Q95', 'low-flow duration'],
		related: ['plausibility-checks'],
		source: 'Not in the workbook; McMillan, Krueger & Freer (2012); calibration-research.md CR-16; docs/model.md §2.10d'
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
		related: ['chirps', 'rain-threshold', 'rain-final'],
		source: 'b023 Flow data'
	},
	{
		id: 'rain-final',
		term: 'Final catchment rainfall',
		short: 'The daily rainfall a run works from after filling gaps: catchment rain, else bias-corrected CHIRPS, else forecast rain, in mm.',
		long: 'One value per day from the first source that has one. CHIRPS is the corrected value when the CHIRPS bias correction is on. This is before any rain threshold: the legacy model then treats rain at or below the threshold as 0 (see Rain used). A day with no value from any source is left empty; the model treats it as dry.\n\nIn the daily CSV export it sits beside CHIRPS as uploaded and bias-corrected CHIRPS, so the filled days can be checked against both.',
		units: 'mm/day',
		category: 'data',
		aliases: ['rain after gap filling', 'patched rainfall', 'infilled rainfall'],
		fields: ['run.rain_final'],
		related: ['rain-catchment', 'chirps', 'chirps-bias', 'rain-threshold'],
		source: 'docs/model.md §2.4, §2.4b'
	},
	{
		id: 'chirps',
		term: 'CHIRPS rainfall',
		short: 'Satellite-and-station daily rainfall (Climate Hazards Group). Used on days without catchment rainfall.',
		long: 'Useful to fill gaps or extend a short gauge record. At catchment scale CHIRPS can read well below (or above) a local gauge, so by default the model scales it by a factor per calendar month, fitted where both records have a reading, on the days it fills in (see CHIRPS bias correction).',
		units: 'mm/day',
		category: 'data',
		aliases: ['satellite rainfall'],
		fields: ['series.rain_chirps_mm', 'run.rain_chirps'],
		related: ['rain-catchment', 'chirps-bias'],
		source: 'b023 Flow data; docs/model.md §7'
	},
	{
		id: 'chirps-bias',
		term: 'CHIRPS bias correction',
		short: 'Scales CHIRPS rain, on days it fills in for blank catchment rain, by a catchment ÷ CHIRPS factor for the calendar month.',
		long: 'For each calendar month the factor is the catchment rain divided by the CHIRPS rain, summed over the days both have a reading. Suspect catchment rain is left out: a water year far below CHIRPS as a whole, and one by one the days of flagged zero runs, of periods listed as missing (see Zero-rain runs) and of multi-day accumulation windows (see Multi-day rain accumulations). Zero runs you keep dry stay in, as confirmed readings, unless CHIRPS reads a lot of rain over them; then that water year stays out and the run warns. A month with fewer than 90 shared days, or less than 50 mm of CHIRPS on them, uses the factor pooled over all months; with too little overlap for even that, CHIRPS is used as it is and the run says so. Factors are kept between 0.25 and 4.\n\nOnly CHIRPS that is actually used is scaled. Catchment rain and forecast rain are never changed. Each run lists the factors and the number of days corrected in its warnings, and outputs the corrected CHIRPS (CHIRPS × its month\'s factor, on every day, not only the days it filled in) as a daily series beside CHIRPS as uploaded, with the day\'s monthly factor in the next column, in the series explorer and the daily CSV export. The run\'s summary CSV lists the 12 factors with their source (own month, pooled, or none) and the shared days behind each, then the water years and days left out of the fit and why. Comparing runs notes when the factors differ. Rain used shows which value the model took each day.\n\nChoose "Raw CHIRPS" only if the CHIRPS series you loaded is already corrected to the catchment; otherwise it would be corrected twice. Not in the workbook, which used raw CHIRPS (docs/engine-audit.md B1).',
		category: 'data',
		aliases: ['bias correction', 'CHIRPS factor', 'rain scaling'],
		fields: ['settings.chirpsBiasCorrection', 'run.rain_chirps_corrected', 'run.chirps_factor'],
		related: ['chirps', 'rain-catchment', 'chirps-fit-period'],
		source: 'Not in the workbook; docs/model.md §2.4b; engine-audit.md B1'
	},
	{
		id: 'chirps-fit-period',
		term: 'CHIRPS fit period',
		short: 'Which years the CHIRPS factors are fitted on: the whole record, or water-year ranges you list, each with a reason.',
		long: 'When the double-mass check finds that the catchment / CHIRPS ratio changed part-way through the record, one set of factors fitted over every year is a blend of the eras, so a gap in one era is filled at the wrong ratio. The fit period decides which years the factors come from.\n\n**Whole record** (the default) fits one set over every year, as before. **Listed water years** fits one set per range you list, each only on its own years and each with a reason; years outside every range are left out of every fit, and a gap there takes the nearest range (the later one on a tie). Put each break where the station records or the CHIRPS version say it is.\n\n**Propose from the double-mass breaks** fills the list with one range per segment the check finds. It is only a proposal: the check\'s break years are estimates that can be a year or two off (the five-year minimum segment and dry years move them), and a break that is partly CHIRPS\'s (a product change, or drift against other products) moves them too. Check each range against the station history and rewrite its reason before saving. Split only when the step is large against the standard error of each era\'s ratio (its year-to-year scatter over the square root of the number of years), or a Pettitt or Buishand test calls it, not merely against the year-to-year scatter.\n\nWithin each range the usual rules hold: a month needs 90 shared days and 50 mm of CHIRPS, else it takes its range\'s pooled factor, else the factor over all the listed ranges together; factors stay between 0.25 and 4. Periods listed as missing under Zero-rain runs, and flagged zero runs that CHIRPS fills, stay out of every fit. Each run names the range whose factors filled each gap and the years each set was fitted on; the summary CSV lists every range\'s factors; comparing runs notes a changed fit period, range or reference window; and a fit record flags "Forcing changed since fit" when the fit period changes. Not in the workbook.',
		category: 'data',
		aliases: ['per-segment factors', 'fit period', 'CHIRPS fit ranges', 'rain homogenisation'],
		fields: ['settings.chirpsFitPeriod'],
		related: ['chirps-bias', 'double-mass'],
		source: 'Not in the workbook; docs/model.md §2.4b, §2.10a; calibration-research.md § Rain forcing; issue #40'
	},
	{
		id: 'double-mass',
		term: 'Double mass: catchment rain vs CHIRPS',
		short: 'Cumulative catchment rain against cumulative CHIRPS: a kink means one record changed, e.g. a station opened, closed or moved.',
		long: 'Two records of the same rain should keep a steady ratio, so cumulative catchment rain plotted against cumulative CHIRPS is a straight line. A kink means one of them changed: a rain gauge opened, closed or moved, the catchment average was built differently, or CHIRPS changed. The check adds up each water year on the days both have a reading (leaving out zero runs treated as missing and periods listed as missing), and needs 10 years with at least 300 such days and 100 mm of CHIRPS. It fits up to two breaks, each segment at least 5 years long, and reports a break only when the slope changes by 20 % or more and a statistical test (Pettitt, or the gain in fit) says it is more than one odd year.\n\nThe chart shows the curve, the whole-record line (dashed) and the segments (solid), with each segment\'s slope, and below it how far the curve departs from the whole-record line each year. The check alone changes nothing: a break doesn\'t say which record is wrong, so the CHIRPS factors are fitted over the whole record unless Settings → CHIRPS fit period lists water-year ranges to fit them on (it can propose ranges from these breaks for you to check). A run warns when CHIRPS fills gaps in a segment whose ratio differs by 20 % or more from the ratio of the factors that filled them, because those days may then run too wet or too dry; with listed ranges it names the range whose factors filled each gap. The run\'s summary CSV has the table.',
		category: 'data',
		aliases: ['double mass curve', 'homogeneity', 'rain gauge change', 'station change', 'CHIRPS ratio drift'],
		related: ['chirps-bias', 'chirps', 'rain-catchment', 'chirps-fit-period'],
		source: 'Not in the workbook; Searcy & Hardison 1960; docs/model.md §2.10a; calibration-research.md CR-20'
	},
	{
		id: 'zero-rain-runs',
		term: 'Zero-rain runs treated as missing',
		short: 'Long wet-season runs of zero catchment rain count as missing, so bias-corrected CHIRPS fills them instead of running them dry.',
		long: 'A zero is a reading, so a gap in the rain record exported as zeros stops CHIRPS filling it, and the catchment runs dry for weeks in its wettest months. The Data tab flags these runs: 60 or more zero days in the series\' six wettest months. By default a run treats the days of every flagged run as blank, so bias-corrected CHIRPS, then forecast rain, stand in, exactly as on any blank day. The rain series you uploaded is never changed.\n\nIf the hydrologist confirms a flagged run was a real dry spell, add it under **Keep dry**: its days stay 0 mm, and they count in the CHIRPS factor fit as readings (a flagged run that is filled is left out of the fit day by day). If bias-corrected CHIRPS reads more than the larger of 50 mm and a quarter of the catchment\'s usual annual rain over a kept-dry run, the keep-dry looks doubtful: each run warns and leaves that water year out of the fit. **Run as recorded** keeps every flagged run dry, as the workbook does. **Also treat as missing** covers other bad periods whatever they read, such as the gap days inside a year that reads far below CHIRPS. Those days are also left out of the CHIRPS factor fit.\n\nEach run lists every period it filled, the rain that replaced it and any days with nothing to fill them, in its warnings and in the summary CSV. The daily column "Catchment rain treated as missing" is 1 on each day filled. Comparing runs lists any change to these settings. Not in the workbook (docs/engine-audit.md B2).',
		category: 'data',
		aliases: ['missing rainfall', 'zero rain', 'rain gaps', 'keep dry', 'infilled rainfall days'],
		fields: ['settings.zeroRainRuns', 'run.rain_catchment_missing'],
		related: ['rain-catchment', 'chirps-bias', 'rain-final', 'rain-accumulations'],
		source: 'Not in the workbook; docs/model.md §2.4c; engine-audit.md B2'
	},
	{
		id: 'rain-accumulations',
		term: 'Multi-day rain accumulations',
		short: 'Several days of rain read on one day after days entered as 0: the total is spread back over those days in proportion to CHIRPS.',
		long: 'When nobody reads the rain gauge for a few days, the unread days are often entered as 0 (or left blank) and the whole total on the day it was read. The total is right; the days are wrong: a dry spell, then one day far wetter than it was. Viney & Bates (2004) found these untagged accumulations throughout long daily records.\n\nA run flags a reading as an accumulation when it is at least 20 mm, follows at least 3 days of 0 or blank catchment rain, bias-corrected CHIRPS reads less than a quarter of it on that day and the days either side (CHIRPS can be a day early or late), and CHIRPS over the days before (leaving out the day just before) reads at least half of it. The window is those days, at most the last 92, plus the reading day. A storm after a real dry spell is left alone: CHIRPS is dry over the days before it.\n\nBy default the run keeps the recorded total and spreads it over the window in proportion to bias-corrected CHIRPS. Those days are not also filled from CHIRPS as a zero run (which would count the rain twice), and they are left out of the CHIRPS factor fit. If CHIRPS reads no rain over a window at all, its total stays on the reading day. The rain series you uploaded is never changed.\n\nIn Settings → Rain gaps and CHIRPS, **Accumulated readings** chooses between spreading (the default) and **Run as recorded (one day)**, as the workbook does. **Keep as recorded** lists readings you know were one day\'s rain (a thunderstorm CHIRPS missed): a detection whose reading day falls in one stays as recorded, and counts in the CHIRPS fit. **Also spread** lists windows by hand, ending on the reading day. A period listed as missing, or a keep-dry period, wins over a detection. Each run lists every window in its warnings and its summary CSV, and the daily column "Catchment rain from a multi-day accumulation" is 1 on each day spread. Comparing runs lists any change to these settings. Not in the workbook (docs/engine-audit.md B4).',
		category: 'data',
		aliases: ['accumulated rainfall', 'untagged accumulation', 'multi-day total', 'weekend rain', 'gauge not read', 'disaggregation'],
		fields: ['run.rain_catchment_spread'],
		related: ['zero-rain-runs', 'chirps-bias', 'rain-catchment', 'rain-final'],
		source: 'Not in the workbook; Viney & Bates 2004; docs/model.md §2.4d; engine-audit.md B4'
	},
	{
		id: 'rain-source',
		term: 'Rain source periods',
		short: 'Dates when catchment rain comes from another gauge × monthly factors instead of the catchment series; its gaps take a named fallback.',
		long: 'Use a rain-source period when the catchment series stops describing the catchment for a stretch of years (a gauge moved or closed, the average was rebuilt) and another gauge covers it, such as an in-catchment automatic station. Within the period, each day\'s rain is that gauge\'s reading × its month\'s factor; the catchment series is not used there and stays out of every factor fit.\n\n**Factors.** Normally 12 fixed values (Oct … Sep, 0.25–4) with where they came from: who fitted them, over which dates, and how. Or **Fit**: the gauge is scaled to the catchment series\' level in a reference era you name, measured against a reference series that doesn\'t contain the gauge: factor = (catchment ÷ reference in the reference era) ÷ (gauge ÷ reference in the period). Use a gauge-free reanalysis such as ERA5 as the reference. CHIRPS is refused once you tick "CHIRPS ingests this gauge", because the fit would then be circular.\n\n**Gaps.** A day the gauge has no reading takes CHIRPS × the CHIRPS factors by default, or a named reanalysis × factors fitted on the catchment series over its own era; then forecast rain. With "CHIRPS ingests this gauge" ticked, name a reanalysis fallback.\n\nEach run warns once per period with the day counts and factors, adds a daily "Rain source" column (0 catchment, 1 alternative gauge, 2 CHIRPS, 3 reanalysis, 4 forecast) and a block in its summary CSV, and comparing runs sets the periods side by side. A saved calibration is flagged "forcing changed since fit" when the periods change. Not in the workbook (docs/model.md §2.4e, issue #40).',
		category: 'data',
		aliases: ['rainSource', 'replacement gauge', 'alternative gauge', 'automatic station', 'splice rain records', 'era replacement'],
		fields: ['settings.rainSource', 'run.rain_source'],
		related: ['rain-catchment-alt', 'rain-reanalysis', 'chirps-bias', 'zero-rain-runs'],
		source: 'Not in the workbook; docs/model.md §2.4e; docs/calibration-research.md § Rain forcing'
	},
	{
		id: 'rain-catchment-alt',
		term: 'Alternative catchment gauge',
		short: 'A second catchment rain record (mm/day), e.g. an in-catchment automatic station. Read only inside a rain-source period.',
		units: 'mm/day',
		long: 'Upload it as its own series kind. Outside every rain-source period (Settings → Rain source) the model never reads it. An automatic station often logs hourly: upload the hourly file and pick how to add it up into days. Manual gauges are read at 08:00 and the reading booked to the day before, so choose 08:00 to 08:00 to line it up with a manual record; the series records the choice. Its product and version (e.g. the station network) can be recorded with it.',
		category: 'data',
		aliases: ['automatic weather station', 'AWS', 'replacement gauge', 'second gauge'],
		fields: ['series.rain_catchment_alt_mm'],
		related: ['rain-source', 'rain-catchment'],
		source: 'docs/model.md §2.4e'
	},
	{
		id: 'rain-reanalysis',
		term: 'Reanalysis rainfall',
		short: 'A gauge-free gridded rain product such as ERA5 (mm/day): a reference for a rain-source fit, or the fallback for its gaps.',
		units: 'mm/day',
		long: 'ERA5\'s precipitation is a model forecast that assimilates no rain gauges outside the United States, so a local gauge change can\'t enter it: a good yardstick for scaling a replacement gauge to the catchment record\'s level. The model reads it only when a rain-source period names it. Free without an account from the Open-Meteo archive API (docs/calibration-research.md § Rain forcing).',
		category: 'data',
		aliases: ['ERA5', 'reanalysis', 'gauge-free reference'],
		fields: ['series.rain_reanalysis_mm'],
		related: ['rain-source', 'chirps-bias'],
		source: 'docs/calibration-research.md § Rain forcing'
	},
	{
		id: 'rain-forecast',
		term: 'Forecast rainfall',
		short: 'Forecast daily rain in mm, used after the other rain series run out, to look ahead a few days.',
		units: 'mm/day',
		long: 'Used on days neither catchment rain nor CHIRPS has a value, usually the days after the other records end. Treat results on forecast days as indicative only.',
		category: 'data',
		fields: ['series.rain_forecast_mm'],
		related: ['rain-catchment'],
		source: 'b023 Flow data'
	},
	{
		id: 'observed-flow',
		term: 'Observed flow',
		short: 'Measured flow at the outlet (gauge record, or a logger), in m³/s. Scores the calibration and the EWR test; it never drives the model.',
		long: 'Converted to m³/day and compared with the simulated outflow on days both exist. The calibration record (Settings & calibration, “Compare with”) picks which one; left on the default, the gauge record is used, else the logger, and a run with both says so in its warnings.',
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
	// The Data tab's daily preview ("Input time series — daily preview"): one
	// entry per column it derives. Its raw series columns use series.<kind>.
	{
		id: 'preview-date',
		term: 'Date (daily preview)',
		short: 'One row per day, from the first day of the earliest loaded series to the last day of the latest. A blank cell means no reading.',
		long: 'The rows come from the input series themselves, not from the simulation period: the table starts on the first day any loaded series has and ends on the last. Each series column shows its value for that day exactly as uploaded; a blank means that series has no reading that day, or the day is outside its period. A shaded value carries a data-check flag (negative, outlier or flat-line), found with the same rules as the Data checks, and screen readers read the flag with the value.\n\nThe search box narrows the rows by date prefix (2015, 2015-03) or by a value in the visible series (> 20, = 0); Missing only and Flagged only keep the days where a visible series is blank or flagged. Lining every input up by day is the quickest way to see a gap in one record that another fills, or a spike only one instrument recorded.',
		category: 'data',
		aliases: ['daily preview', 'preview data', 'series preview'],
		fields: ['preview.date'],
		related: ['gauge-logger-agreement', 'rain-catchment', 'observed-flow'],
		source: 'Not in the workbook; docs/ui.md § Data tab (Preview)'
	},
	{
		id: 'preview-flow-m3day',
		term: 'Flow in m³/day (daily preview)',
		short: 'The flow series’ m³/s value × 86 400: the unit the model works in, so the day reads directly against simulated flows.',
		long: 'Flow records are uploaded in m³/s. The model converts them to m³/day (1 m³/s = 86 400 m³/day) before comparing them with the simulated outflow, which is in m³/day like every flow and volume inside the model. This column is that conversion, day by day, blank where the record has no reading. Use it to read an observed day against the daily results or the daily CSV export without converting by hand.\n\nFor gauge or logger flow this is the value calibration and the EWR comparison score against, when that record is the one chosen under “Compare with”. A reference gauge on another river is converted the same way, but the model never reads it.',
		units: 'm³/day',
		category: 'data',
		fields: ['preview.flowM3Day'],
		related: ['observed-flow', 'units', 'reference-gauge'],
		source: 'docs/model.md §2.1, §7'
	},
	{
		id: 'preview-rain-used',
		term: 'Rain used (daily preview)',
		short: 'The rain the model runs on each day: catchment rain if it has a reading, else bias-corrected CHIRPS, else forecast rain.',
		long: 'It is worked out with the same code a run uses, so it is the rain that drives runoff and reduces irrigation demand. Catchment rain comes first, after the rain-gap settings: days of a zero run treated as missing count as blank, so CHIRPS fills them, and a multi-day accumulation is spread back over the days it covers. That is why this column can differ from the catchment rain column on a day that has a reading. Where catchment rain is blank, CHIRPS stands in (scaled by its month’s factor when the bias correction is on), then forecast rain.\n\nIt is blank outside the simulation period (Settings, simulation start and end) and on days no source has a value, which the model treats as dry. It is the rain before the legacy model’s rain threshold. Compare it with the uploaded columns to see which days were filled and from where; screen readers also read the source with each value.',
		units: 'mm/day',
		category: 'data',
		aliases: ['rain used', 'gap-filled rain'],
		fields: ['preview.rainUsed'],
		related: ['rain-final', 'chirps-bias', 'zero-rain-runs', 'rain-accumulations'],
		source: 'docs/model.md §2.4, §2.4b–d'
	},
	{
		id: 'preview-chirps-factor',
		term: 'CHIRPS bias factor (daily preview)',
		short: 'The catchment ÷ CHIRPS rain factor for the day’s calendar month: what CHIRPS is multiplied by on days it fills a catchment gap.',
		long: 'Fitted from the loaded records for each calendar month: catchment rain divided by CHIRPS rain, summed over the days both have a reading, leaving out suspect catchment rain (see CHIRPS bias correction). A month with fewer than 90 shared days, or less than 50 mm of CHIRPS on them, takes the factor pooled over all months, and factors are kept between 0.25 and 4. A dash means no factor could be fitted, so CHIRPS is used as it is.\n\nThe same factor shows on every day of that month in the simulation period, but it only changes a day where CHIRPS fills in for blank catchment rain, and not at all when Settings → CHIRPS bias correction is set to Raw CHIRPS (it is then shown for reference only). A factor well away from 1 says CHIRPS reads consistently wetter or drier than the catchment record in that month.',
		units: '× (ratio)',
		category: 'data',
		fields: ['preview.chirpsFactor'],
		related: ['chirps-bias', 'chirps', 'double-mass'],
		source: 'Not in the workbook; docs/model.md §2.4b; engine-audit.md B1'
	},
	{
		id: 'preview-chirps-corrected',
		term: 'CHIRPS corrected (daily preview)',
		short: 'CHIRPS as the model reads it: × the month’s bias factor on days it fills blank catchment rain, as uploaded on every other day.',
		long: 'Only CHIRPS the model actually uses is corrected. On a day with no catchment rain value (including the days of a zero run treated as missing) it is CHIRPS × that month’s factor; on a day catchment rain has a reading CHIRPS isn’t used, so it shows as uploaded. With Raw CHIRPS chosen, or no factor fitted, it is the uploaded value every day. Blank outside the simulation period.\n\nBeside the uploaded CHIRPS column it shows how much rain the correction added or took away on the filled days. It differs from a run’s corrected-CHIRPS output column, which applies the factor on every day.',
		units: 'mm/day',
		category: 'data',
		fields: ['preview.chirpsCorrected'],
		related: ['chirps-bias', 'preview-chirps-factor', 'preview-rain-used'],
		source: 'Not in the workbook; docs/model.md §2.4b; engine-audit.md B1'
	},
	{
		id: 'preview-excluded',
		term: 'Excluded from calibration (daily preview)',
		short: 'Marks days inside a calibration exclusion from Settings: they don’t count in Fit automatically or in a run’s calibration scores.',
		long: 'Comes from Settings & calibration → Calibration exclusions: whole water years (1 October to 30 September) or date ranges, each with a reason. A day inside one reads Excluded, and screen readers also read the reason; every other day shows a dash. The model still simulates excluded days; only the scores leave them out, so Fit automatically and the run’s calibration statistics compare observed and simulated flow on the remaining days of the calibration window.\n\nUse it to check that an exclusion covers the days you meant, such as a gauge outage or a suspect rain year, and no more.',
		category: 'data',
		fields: ['preview.excluded'],
		related: ['calibration-exclusions', 'calibration-window'],
		source: 'Not in the workbook; docs/model.md §2.10'
	},
	{
		id: 'wr90',
		term: 'WR90 / WR2012',
		short: 'The Water Resources of South Africa studies (1990, 2012): A-pan, MAP and naturalised flow per quaternary catchment.',
		long: 'The standard national source for the monthly evaporation and naturalised-flow inputs.',
		category: 'data',
		aliases: ['WR2012', 'Water Resources of South Africa'],
		related: ['apan', 'quaternary'],
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
		short: '100 × Σ(obs − sim) / Σobs. Positive means the model under-predicts the total volume; 0 is unbiased.',
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
	},
	// ---- Words on your farm page (the farmer view, WP-2.6) -------------------
	// Written for farmers, not hydrologists (docs/design/farmer-view.md §5.1):
	// the farm pages link here from "What do these words mean?".
	{
		id: 'farm-even-share',
		term: 'Even share',
		short: 'The share of what they needed that farms across the catchment received. A fairness check, not water you are owed.',
		long: 'Add up what every farm in the catchment needed, and what they all received. The even share is the second as a part of the first: if it is 89 %, farms together received 89 % of what they needed.\n\nYour farm page puts your own figure next to it, so you can see whether you did a little better or worse than the catchment as a whole. It is a fairness check, not extra water for you: whether more water can reach your farm depends on where you are on the river and what is in your dam.\n\nIt is only shown when there are enough farms in the catchment that it can’t reveal a neighbour’s figures.',
		category: 'farmer',
		aliases: ['gelyke deel', 'fair share'],
		related: ['farm-pump-less', 'farm-reserve'],
		source: 'docs/design/farmer-view.md §5.3; docs/model.md §2.11'
	},
	{
		id: 'farm-reserve',
		term: 'The river’s reserve',
		short: 'Water the law keeps in the river so it stays healthy for everyone downstream.',
		long: 'South African law sets aside some water in every river: the Ecological Reserve. The model checks, day by day, whether the river kept that much water at the outlet and at the gauges below your farm.\n\nOn days it didn’t, the farms upstream are asked to make it up, each in proportion to the water it used up or stored. Water that flows back to the river doesn’t count against you. On some days the river was low only because of low rain; those days ask nothing of anyone.',
		category: 'farmer',
		aliases: ['die rivier se reserwe', 'ecological reserve'],
		related: ['farm-pump-less', 'ewr'],
		source: 'National Water Act (Act 36 of 1998) s16–18; docs/design/farmer-view.md §5.1'
	},
	{
		id: 'farm-pump-less',
		term: 'Pump less (for the river)',
		short: 'How much less you would have pumped on the days the river needed water, so it kept its reserve.',
		long: 'Your farm page gives this per day the river needed it, not averaged over the whole season: cutting a little every day does little on the days that matter.\n\nIf your dam also held back water the river needed, the page says so separately. That part isn’t taken off your pumping; if your dam has an outlet or a bypass, letting that water through helps.\n\nThis is the model’s estimate. Only a notice from your WUA is a restriction.',
		category: 'farmer',
		aliases: ['pomp minder'],
		related: ['farm-reserve', 'farm-model-band'],
		source: 'docs/design/farmer-view.md §5.2'
	},
	{
		id: 'farm-modelled',
		term: 'Modelled (worked out by the model)',
		short: 'Worked out by a computer model of the catchment from rain, river flow and crops, not read from a meter or gauge.',
		long: 'Nobody measures your dam or your pump for this page. The model works out every day how much rain fell, how much water flowed down the river to your farm, what your crops needed and what your dam held.\n\nIt can be wrong. If your meter or gauge plate reads very differently, tell your WUA: it helps them correct the model.',
		category: 'farmer',
		aliases: ['deur die model bereken', 'estimate'],
		related: ['farm-needed', 'farm-stop-level'],
		source: 'docs/design/farmer-view.md §5.1'
	},
	{
		id: 'farm-needed',
		term: 'Water you needed',
		short: 'What your farm would have to pump for its crops: what the crops use, allowing for the water lost on the way.',
		long: 'Crops need a certain amount of water each day, less what the rain gives them. Not all the water you pump reaches the crop: some is lost to wind, evaporation and run-off. The model allows for that with your irrigation system’s efficiency (drip about 90 %, micro or centre pivot 85 %, sprinklers 75 %, flood 65 %).\n\nSo "needed" is what you would have to pump, the quantity your meter shows. If the page names the wrong irrigation system for your farm, tell your WUA.',
		category: 'farmer',
		related: ['farm-modelled'],
		source: 'docs/design/farmer-view.md §3 Q1; docs/model.md §2.6'
	},
	{
		id: 'farm-stop-level',
		term: 'Stop level',
		short: 'The dam level where irrigation stops: your pump intake, or water you keep back. The model won’t irrigate below it.',
		long: '"You can still use" is the water in your dam above this level. The days-left line divides it by what you used over the last 14 days, as a rough guide if nothing flows in.\n\nIf the page says the model assumes your pump can empty the dam, no stop level is set for your farm yet: tell your WUA the level your pump stops at.',
		category: 'farmer',
		related: ['farm-modelled'],
		source: 'docs/design/farmer-view.md §3 Q3; docs/model.md §2.7'
	},
	{
		id: 'farm-model-band',
		term: 'Model: OK, watch or short',
		short: 'The model’s own rating of your season so far. Not a restriction: only a notice from your WUA is one.',
		long: 'OK: you would have had at least 90 % of the water you needed after pumping less for the river. Watch: 70 to 90 %, or your dam held back water the river needed. Short: under 70 %.\n\nThese thresholds are a proposal the WUA may change.',
		category: 'farmer',
		related: ['farm-pump-less'],
		source: 'docs/design/farmer-view.md §6.2 (FV-D1)'
	},
	{
		id: 'farm-saved-copy',
		term: 'The copy kept on your phone',
		short: 'Your farm’s last figures, kept on this phone so they show at once and when there is no signal.',
		long: 'It holds only your own farm’s figures, which you may see anyway. It is removed when you sign out, when someone else signs in on this phone, when you no longer have access to the farm, and when it hasn’t been opened for 30 days.\n\nOn a phone you share, choose "Don’t keep a copy on this phone" in the Menu.',
		category: 'farmer',
		source: 'docs/design/farmer-view.md §9'
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
