// The glossary's articles: for each tip in tips.ts (same id, same order),
// the fuller explanation (`long`, paragraphs separated by a blank line), the
// other names people search for, related entry ids and the source of the
// idea. Only the glossary, help search and the other /help pages load this,
// through content.ts; a HelpTip never does (tips.ts says why). The "Input
// data" topic's articles are in articles-data.ts, a chunk of their own
// (issue #66); content.ts joins the two.

import type { HelpArticle } from './types';

export const ARTICLES: Record<string, HelpArticle> = {
	// ---- Basics -------------------------------------------------------------
	'water-balance': {
		long: 'The model tracks every cubic metre each day. Rain becomes natural flow, natural flow is shared out to the hydrological units, each hydrological unit fills its dam, irrigates, spills and passes water downstream, and the outlet gauge receives what is left.\n\nEach hydrological unit’s daily balance closes to the cubic metre: inflow (with rain on the dam and groundwater pumped) minus consumptive use, dam evaporation and seepage lost from the catchment, minus the change in storage, equals outflow. A catchment answers three questions: how much water is there, can each hydrological unit’s irrigation be met, and is enough left in the river for the environment?',
		related: ['natural-flow', 'network', 'ewr'],
		source: 'b023 Help (workbook purpose); docs/model.md §1'
	},
	'project': {
		long: 'A project holds everything for one river catchment. Copy a project to try a what-if without touching the original; runs inside a project record exactly which inputs they used.',
		aliases: ['catchment', 'workbook'],
		related: ['run', 'roles'],
		source: 'docs/model.md §1'
	},
	'run': {
		long: 'Pressing Run model computes every day of the simulation window and stores the daily series and the summary. Later edits to the model don’t change an existing run, so results can always be explained. Each run records the engine version it was computed with.',
		aliases: ['model run', 'engine version'],
		related: ['simulation-window', 'project', 'evidence-run'],
		source: 'docs/model.md §6'
	},
	'evidence-run': {
		long: 'On Runs & results, Notes & evidence, an editor can nominate the run shown with Nominate as evidence and a required reason. Nominating another run later replaces it; both stay in the nomination history, with who nominated each, when and why. In the runs list the current one carries an Evidence badge and a replaced one Former evidence, and comparing runs says when either side is or was the evidence.\n\nA run of the legacy runoff model (removed in engine 1.0.0) can’t be nominated: it is workbook comparison only. When the nominated run is such a legacy run and a later run uses GR4J, the results say so: the nomination still stands until another run is nominated, with a reason.',
		aliases: ['nominate', 'nominated run', 'nomination history', 'former evidence'],
		related: ['run', 'runoff-model', 'roles'],
		source: 'docs/ui.md § Evidence nomination; docs/data-model.md'
	},
	'roles': {
		long: 'Each person has a role on each project. A viewer sees every input and result, can fit the runoff model to explore and download results, but can’t save or run; the workspace says “View only”. An editor changes settings and model data, uploads series, runs the model, writes run notes and nominates the evidence run. An owner also adds and removes members, changes roles and deletes the project.\n\nA project can belong to a team. Team roles use the same names: a team’s owners own every team project, its editors edit them and its viewers view them, and a team owner also manages the team. Someone who is both a direct member and a team member gets the higher of the two roles.',
		aliases: ['permissions', 'members', 'team', 'view only', 'owner', 'editor', 'viewer', 'team admin'],
		related: ['project', 'evidence-run'],
		source: 'docs/data-model.md § Access control; docs/security.md'
	},
	'water-year': {
		long: 'Monthly inputs (A-pan evaporation, crop factors, pragmatic EWR) are entered in water-year order, starting with October. Month pickers (transfer months, dry-season months) show one toggle per month in the same Oct … Sep order.',
		aliases: ['hydrological year'],
		source: 'docs/model.md §2.1'
	},
	'units': {
		long: 'Gauge and logger flow series are usually supplied in m³/s and converted to m³/day on the way in. Dam capacities and storage are in m³. Mean annual runoff is often quoted in M.m³ per year.\n\nA quick check: 1 l/s ≈ 86 m³/day, and 1 000 m³/day ≈ 11.6 l/s.',
		aliases: ['m3/day', 'm3/s', 'cumecs', 'l/s', 'million cubic metres', 'Mm3'],
		source: 'docs/model.md §2.1, §7'
	},
	'february-days': {
		long: 'Monthly crop requirements are divided by the days in the month to get a daily demand. Use 28.25 to average over leap years (the b023 default) or 28 for a strict 365-day year.',
		related: ['irrigation-demand'],
		source: 'b023 Help (AppSettings, month and day labels)'
	},
	'simulation-window': {
		long: 'Narrow the window to study a drought or to match a calibration period. Dams start from their initial storage on the first simulated day, so allow a warm-up period before the dates you care about.',
		aliases: ['start date', 'end date', 'period'],
		related: ['dam-initial', 'calibration'],
		source: 'b023 Help (Calc. Model date window)'
	},
	'calibration-window': {
		long: 'Hydrologists usually calibrate on a period with reliable observations rather than the whole record; a b023 workbook has its own calibration date range and flow choice. Choose which observed series to compare against (gauge or logger); left empty, the gauge record is used if there is one, else the logger. The fit statistics and the annual volume table only count days inside this window.',
		aliases: ['calibration period', 'observed flow record'],
		related: ['calibration', 'nse'],
		source: 'b023 [Flow Calibration Cfg] date range and flow choice; docs/model.md §2.10'
	},
	'gauge-logger-agreement': {
		long: 'Two instruments on the same river should roughly agree. Each water year, the gauge volume is compared with the logger volume on the days both have a reading. A year is flagged when the ratio is below the lowest ratio or above the highest ratio (defaults 67 % and 150 %), and only when the year has at least the minimum number of shared days (default 90). A flagged year usually means a problem at one instrument, so choose the record you trust as the calibration flow series. The thresholds only change which years are flagged, never the model results. The Data tab’s Data checks also list negative values, outliers and flat stretches in each series, catchment rain that reads 0 where it looks missing (a zero blocks the CHIRPS fallback a blank day gets), and water years whose catchment rain reads far below CHIRPS.',
		aliases: ['data quality', 'observed flow agreement', 'logger check'],
		related: ['calibration-window', 'data-quality-limits'],
		source: 'Not in the workbook; docs/model.md §2.10a'
	},
	'data-quality-limits': {
		long: 'Settings → Data quality holds the limits of the checks the Data tab and every run report. The gauge-vs-logger ratios, the outlier factors (a value this many times the 99th percentile of a series’ positive values, 5 for rain and A-pan, 10 for flow) and the flat-stretch lengths (5 days of one rain value, 7 of A-pan, 14 to 90 of flow depending on the flow and the record’s resolution) only decide what is flagged.\n\nThe zero-rain and low-vs-CHIRPS limits change results, because a run treats a flagged zero run as missing (CHIRPS fills it) and leaves a flagged water year out of the CHIRPS factor fit. By default a zero run is flagged with 60 or more days in the series’ six wettest months, and a water year when its catchment / CHIRPS ratio is below half the record’s usual one. The alternatives come from a hydrologist review for semi-arid catchments: judge a run by the share of the usual annual rain it missed, check it against CHIRPS (a run CHIRPS reads as dry too may be a real dry spell and is not flagged), compare each year with the years around it instead of the whole record, and ask more CHIRPS rain of a year in a wet catchment before judging it. They are off until tested on a semi-arid record with a known drought. A fit made under other limits says its forcing changed.',
		aliases: ['data checks', 'outlier limit', 'flat-line limit', 'zero-rain rule', 'low vs CHIRPS'],
		related: ['gauge-logger-agreement', 'rain-catchment'],
		source: 'Not in the workbook; a simulated hydrologist review (docs/followups.md); docs/model.md §2.10a'
	},
	'report-window': {
		long: 'Pick a critical period — a dry season or a drought year — to see how much each hydrological unit would need to reduce for irrigation to balance and the EWR to be met in that period. A window partly outside the run is clipped to it.\n\nOn Hydrological units, the Reporting window picker above the curtailment table shows the same tables over another period (the last 7, 14 or 30 days, the whole record or a custom range) without changing this setting or re-running: anyone who can see the run can use it.',
		aliases: ['reporting period', 'shortfall period'],
		related: ['ewr'],
		source: 'b023 [Shortfalls] "Set reporting period"; docs/model.md §2.11'
	},

	'assurance-of-supply': {
		long: 'Two measures per hydrological unit and other water user (engine 0.32.0). Days met: the share of days with demand when the whole demand was supplied (days without demand don’t count). Water years met: the share of complete water years (1 October to 30 September inside the reporting window; a part year at either end is left out, engine 1.11.0) whose supply reached the annual threshold (Settings, default 90 %, a project choice rather than a standard).\n\nAfter Hashimoto et al. (1982), a failure is a run of consecutive demand days not fully met: the table gives the number of failures, their mean and longest length (resilience) and the mean and largest deficit per failure (vulnerability).\n\nThe definitions are pending review by the project hydrologist.',
		aliases: ['reliability', 'assurance', 'resilience', 'vulnerability', 'Hashimoto'],
		related: ['report-window', 'stress-class', 'water-account'],
		source: 'docs/model.md §2.11a; Hashimoto, Stedinger & Loucks 1982'
	},
	'allocation-mode': {
		long: 'The Allocations tab stores the volumes registered or licensed per unit and water source. By default they only sit beside a run: the tab compares each water year’s modelled use with them, for the unit you pick beside the list, and for every unit at once under **Show all units’ water years** at the foot of the page. Two modes (engine 1.18.0) make them part of the run.\n\nCap: each unit’s surface-water use (from its dam, its river pump and off-take water) and groundwater use (pumped to the crop and into the dam) per water year (October–September) stays within its registered volumes. The budget is the whole year’s volume, so a unit may take it early and then goes without; its boreholes cover what a capped surface can’t, within the groundwater volume. A source with no registered volume isn’t capped.\n\nFull allocation: each unit’s demand (crops and other demands together) is scaled, year by year, so it asks for exactly its registered volume (both sources), keeping its own seasonal pattern. It shows the river if every registered user took their entitlement, the background for a cumulative assessment. A unit without a volume keeps its modelled demand.\n\nLicence conditions (months, a maximum rate) are recorded but not applied yet. How the cap counts water drawn from a dam that boreholes filled is pending the hydrologist.',
		aliases: ['cap', 'full allocation', 'entitlement', 'registered volume', 'WARMS', 'allocationMode'],
		related: ['allocation-band', 'assurance-of-supply'],
		source: 'docs/model.md §2.12a; docs/allocations.md'
	},
	'allocation-band': {
		long: 'A water year whose modelled use is more than the registered volume × (1 + band) reads “above registered”, less than × (1 − band) “below registered”, anything between “within band”. It changes only how the comparison reads, never the run’s water. The ±10 % default is a placeholder pending the hydrologist.',
		aliases: ['tolerance', 'allocation tolerance', 'within band'],
		related: ['allocation-mode'],
		source: 'docs/allocations.md § The comparison'
	},
	'stress-class': {
		long: 'The classes and thresholds come from an experimental node-based workbook, which reported them per hydrological unit and per month. The app grids them per hydrological unit, per other water user and for all of them together, water year by month, over the whole run. A month without demand has no class.',
		aliases: ['stress', 'supply ratio', 'Low', 'Moderate', 'High', 'Severe', 'Critical'],
		related: ['assurance-of-supply'],
		source: 'docs/model.md §4 and §2.11a'
	},
	'water-account': {
		long: 'In: natural flow, rain on the dams, groundwater pumped and net transfers. Out: runoff removed by land cover, natural flow no hydrological unit received (flow shares not summing to 1), consumptive irrigation (supplied − return flow), other users’ net take, dam evaporation, dam seepage lost from the catchment, stream depletion from boreholes and the outflow at the outlet. A dam storage reset, when one is set, counts on the In side. In − out − change in dam storage is the residual, float noise. Seepage that rejoins the river below the dam is shown as a memo. The EWR required and met at each site, per water year, is under the EWR by month grid on River & reserve.',
		aliases: ['water balance', 'account', 'closure'],
		related: ['assurance-of-supply', 'dam-evaporation', 'dam-seepage'],
		source: 'docs/model.md §2.11b'
	},

	// ---- Network ------------------------------------------------------------
	'network': {
		long: 'The network is a tree. An element can receive water from several upstream elements but sends all of its outflow to one downstream element; a river that splits (bifurcation) is not modelled directly — use a transfer, or merge the hydrological units.\n\nThe model works out the calculation order itself, upstream first, so each element sees its upstream neighbours’ outflow on the same day.',
		aliases: ['tree', 'topology', 'calculation order', 'bifurcation'],
		related: ['element-farm', 'element-gauge', 'outflow-gauge', 'transfer'],
		source: 'b023 Help (Network sheet)'
	},
	'element-farm': {
		long: 'A hydrological unit is a piece of the catchment that has demands: usually a farm, but it can also be a sub-catchment or a town with land of its own. The workspace, the farmer view, the farmer emails and the shared view call it a hydrological unit; the exports (CSV and workbook) and the API call it a farm. It is not a unit of measurement (m³, l/s). A town that only draws water from the river, with no land of its own, is an other water user instead.\n\nModel each hydrological unit as the land it occupies. The same element type covers three cases, set by its parameters:\n\n• Farm (or sub-catchment) — crops, a dam if it has one, return flow.\n• Stand-alone dam — no crop areas (so no irrigation or return flow), all of its runoff (and upstream inflow, if the dam sits on the main stem) captured by the dam, no diversion.\n• Natural (unused) area — no crops, no dam capture, no diversion: it simply passes its runoff downstream.',
		aliases: ['farm', 'farm element', 'sub-catchment', 'node', 'stand-alone dam', 'natural area', 'element'],
		related: ['network', 'dam-capacity', 'flow-share'],
		source: 'b023 Models sheet'
	},
	'element-gauge': {
		long: 'Use gauges where you want to read the simulated flow, for example at a weir with a record. A gauge is also an EWR site unless you untick “EWR site” (engine 1.5.0): its flow is checked against the EWR of everything upstream of it, and a shortfall there is charged to the hydrological units above it. Add gauges at the Reserve determination’s EWR sites to protect upstream reaches; untick one that only records flow (a weir that is no Reserve site), so it charges nobody and a Reserve rule table there is skipped. It still shows its flow and EWR shortfall. The last gauge in the network is the outflow gauge, always an EWR site.',
		aliases: ['gauge', 'weir', 'EWR site', 'measuring point only'],
		related: ['outflow-gauge'],
		source: 'b023 Network sheet'
	},
	'element-user': {
		long: 'Water taken by users that are not modelled hydrological units would otherwise be handed to the hydrological units and the EWR, over-stating both. An other user has a monthly demand (m³/day), a share of what it takes that comes back below it the same day (treated wastewater) and a priority.\n\nIt takes only from the river where it sits: what reaches it from upstream, after anything upstream has taken its share. It is charged for EWR shortfalls below it like a hydrological unit, by its net impact (what it takes less what it returns).\n\nOther users are outside the irrigation equitable-share benchmark. A senior user is not curtailed for the EWR; a junior one is (Curtailment tab, "Other water users").',
		aliases: ['town', 'municipal', 'industry', 'unlisted user', 'abstraction'],
		related: ['user-priority', 'user-return', 'element-farm', 'ewr'],
		source: 'docs/model.md §2.7c; roadmap WP-1.33'
	},
	'user-priority': {
		long: 'A senior user’s demand is a requirement every hydrological unit upstream of it passes before it fills its dam or irrigates, shared between those hydrological units by flow share the way the EWR is (the hydrological unit diverts less, then lets inflow and its own runoff pass below the dam). A junior user upstream of a senior one leaves the senior demand in the river too.\n\nA junior user takes only what reaches it. Hydrological units have no protected claim, so a junior user upstream of a hydrological unit still takes first: position in the river decides.\n\nA municipal allocation is usually senior, which is the default. Senior users are not curtailed for the EWR; their charge is reported and left standing.',
		aliases: ['seniority', 'senior', 'junior', 'priority'],
		related: ['element-user'],
		source: 'docs/model.md §2.7c'
	},
	'user-return': {
		long: 'A town returns part of what it abstracts through its wastewater works. That share joins the river directly below the user on the same day; the rest is consumed. 0 % means nothing comes back.',
		aliases: ['wastewater', 'return flow', 'effluent'],
		related: ['element-user', 'return-flow'],
		source: 'docs/model.md §2.7c'
	},
	'borehole': {
		long: 'Groundwater is a separate resource with its own licences, so it counts as supply without coming out of the dam or river. A hydrological unit or user can have a combined borehole capacity and any number of individual boreholes, each with its own capacity, annual cap, mode, target and depletion share.\n\n• Supplemental — only for the demand the dam and river leave unmet.\n• Primary — pumped first; the dam and river cover the rest.\n• Emergency (drought) — supplemental, but only while the dam holds less than its trigger level at the start of the day (a hydrological unit with a dam only).\n• None — kept on record, never pumps.\n\nA borehole can pump straight to the crop or into the hydrological unit’s dam (primary keeps the dam topped up, supplemental adds what the dam lacks for the day, emergency refills it while it is low; primary and emergency pump only on a day there is demand to irrigate from the dam); water pumped into the dam never makes it spill. An annual cap stops a borehole once it has pumped that much in a water year (October to September); it starts again on 1 October.\n\nThe results show each hydrological unit’s use per water year against its caps and, for context, the GN 538 general authorisation’s volume for the property: its area × the Table 2 rate, at most 40 000 m³/a (see GN 538 general authorisation). The app never decides whether a use is lawful.\n\nPart of the pumped water that is lost in irrigation returns to the river like any other return flow.',
		aliases: ['groundwater', 'borehole', 'well', 'aquifer', 'pumping', 'annual cap', 'GN 538', 'general authorisation', 'sustainable yield'],
		related: ['stream-depletion', 'ga538', 'element-farm', 'element-user'],
		source: 'docs/model.md §2.7d; roadmap WP-1.34, WP-3.9; GN 538 (2016)'
	},
	'ga538': {
		long: 'GN 538 of 2 September 2016 (Government Gazette 40243) lets a person with lawful access to a property take groundwater without a licence, up to a volume set by the property’s size: its area in hectares × the rate Table 2 (Appendix B) lists for its quaternary catchment, one of 0, 45, 75, 150, 275 or 400 m³/ha a year, and never more than 40 000 m³ a year on a property. A property is land registered separately in a Deeds Office. In a zero-rate quaternary no groundwater may be taken under the GA at all.\n\nEnter the property area and the rate on the hydrological unit or user with boreholes. The app doesn’t carry the gazette’s table: look the rate up in Appendix B for the quaternary. Without both, the results show the 40 000 m³/a ceiling only, and the run warns.\n\nThe gazette’s year is any 12 consecutive months, so the results show the most pumped in any 12 months beside each water year: a use split across 1 October can pass both water years and still exceed the volume.\n\nThe GA doesn’t cover an alluvial aquifer directly connected to a stream (the gazette counts that as surface water; the run warns on a borehole with a stream depletion share of 80 % or more), or groundwater taken within 100 m of a watercourse’s riparian edge, 500 m of a wetland or estuary, or near a state dam. The app has no borehole locations, so it can’t check the distances. It shows the volume for context and never decides whether a use is lawful.',
		aliases: ['GN 538', 'general authorisation', 'GA', 'Table 2', 'schedule 1', 'groundwater licence', 'property area', 'quaternary rate'],
		related: ['borehole', 'stream-depletion'],
		source: 'docs/model.md §2.7d; GN 538 (2016), Government Gazette 40243, §1, §2.2, §4 and Appendix B',
		countries: ['ZA']
	},
	'demand-object': {
		long: 'A hydrological unit can carry demand objects beside its crops: a town, households, livestock, industry or a bulk supply piped out of the catchment. Each gives its demand either as m³/day for each month (a meter record, a reconciliation strategy’s average daily demand, or a workbook’s typed-over figure) or as a count × litres per unit a day (people or head of stock), grossed up for distribution losses and shaped by a monthly profile. The Red Book’s 230 l per person a day for a house connection and about 45 l per head of cattle are starting points, not defaults the model applies for you.\n\nIts demand adds to the hydrological unit’s, and the hydrological unit’s dam, river pump and boreholes supply the total. On a short day the priority decides who gets water first: first (before the crops, as basic needs are), shared (pro rata with the crops) or last. What an object gets, times its return share, flows back to the river below the hydrological unit the same day, like treated wastewater; water piped out of the catchment returns nothing.\n\nThe results show each object’s demand, supply, shortfall and return. A demand that takes from the river by itself, at its own place in the network, is an other water user instead.',
		aliases: ['demand object', 'municipal demand', 'town', 'domestic demand', 'livestock', 'potable', 'non-crop demand', 'unit'],
		related: ['element-farm', 'element-user', 'supply-rule'],
		source: 'docs/model.md §2.7f; issue #54 item 2b; CSIR Red Book §J (2005); KZN DARD livestock water requirements'
	},
	'demand-schedule': {
		long: 'A demand object’s schedule is a list of windows, each a set of days and a factor on the object’s demand on those days. A window covers every day, a span of dates each year (1 December to 15 January wraps the year end), a one-off date range, or days around Easter (−2 is Good Friday, +1 Family Day), and can be narrowed to some weekdays: every day on Saturday and Sunday is a weekend pattern. A factor of 0 switches the object off, 0.5 halves it, 1.8 is a peak.\n\nWhere two windows cover a day, the later one in the list sets it, so the list reads “then, on these days, instead”; a day no window covers runs at the month’s demand. A day switched off has no demand, so no supply and nothing returned, and the results count it apart from days short. The switch is set by date only, not by the river’s flow.',
		aliases: ['on/off pattern', 'weekends off', 'holiday', 'shutdown', 'Easter', 'daily pattern', 'schedule'],
		related: ['demand-object'],
		source: 'docs/model.md §2.7f; issue #90 Q4 and Q12'
	},
	'supply-rule': {
		long: 'Dam only (the default) is what the model always did: irrigation draws on the hydrological unit’s dam alone. River first pumps from the river below the dam, up to the pump’s capacity, and the dam covers the rest. Trigger uses the dam until it holds less than the trigger level at the start of a day, then pumps from the river first until the dam is back at the stop level. Run of river has no dam: the pump takes what the river gives, up to its capacity, and the rest is a deficit.\n\nThe pump only takes the flow below the dam that the hydrological unit need not pass: the senior water users’ demand below it, and a pass-inflow release’s target, stay in the river. The capacity is m³/day: pumps × m³/h per pump × 24. With no capacity set, only the river’s flow limits the pumping, and the run says so.',
		aliases: ['pump capacity', 'river abstraction', 'pump scenario', 'river first', 'run of river', 'dam first'],
		related: ['element-farm', 'borehole'],
		source: 'docs/model.md §2.7e; roadmap WP-3.8; issue #54 item 2c'
	},
	'stream-depletion': {
		long: 'Pumping near a river lowers the dry-season base flow the EWR depends on. The model takes a share d of each day’s pumping from the flow leaving the node, delayed through a single linear store with time constant k days, so the river keeps losing water for a while after the pumps stop and, over a long run, loses d × the pumped volume in all.\n\nThe river never goes below 0: depletion due on a day with nothing left to take is owed (the depletion deficit) and comes off the first flow that returns, and the run warns about any still owed at its end. Runs before engine 1.10.0 dropped it instead (reported as unmet). A first estimate of k is the stream depletion factor, distance² × storativity ÷ transmissivity (Jenkins 1968).\n\nA gauge or logger record measured while the boreholes pumped already carries their depletion: keep them in the model when calibrating, so the fitted natural flow isn’t reduced twice.',
		aliases: ['base flow reduction', 'baseflow depletion', 'Glover', 'Jenkins', 'SDF'],
		related: ['borehole', 'ewr'],
		source: 'docs/model.md §2.7d; Jenkins (1968); Glover & Balmer (1954)'
	},
	'land-cover': {
		long: 'Each patch has a cover class, an area and a condensed (canopy) cover: its share of the hydrological unit is area × cover ÷ the hydrological unit’s area. Each class removes a share of the runoff at full cover: one share of the low flows (the part of each day’s flow up to the flow exceeded 75 % of the days) and another of the rest, because trees take proportionally more of the dry-season flow.\n\nThe class values are indicative (after the South African afforestation reduction curves of Scott & Smith 1997, and Le Maitre et al. 2016 for invasive plants, who put the national loss to invasives at about 2.9 % of the mean annual runoff); confirm them for the catchment or enter a patch’s own.\n\nThe reduction is its own run series, never hidden in the calibration. To see what clearing a class gives back, copy the project, remove the patches and compare the two runs.',
		aliases: ['invasive alien plants', 'IAP', 'forestry', 'afforestation', 'plantation', 'streamflow reduction activity', 'wattle', 'eucalyptus', 'pine'],
		related: ['element-farm', 'natural-flow'],
		source: 'docs/model.md §2.5a; Scott & Smith (1997); Le Maitre et al. (2016); roadmap WP-1.35'
	},
	'outflow-gauge': {
		long: 'Exactly one element has nothing downstream of it. Its flow is the catchment’s simulated outflow: the series checked against the pragmatic EWR and, when an observed record exists, used for the calibration statistics.',
		aliases: ['outlet', 'catchment outlet'],
		related: ['ewr', 'nse'],
		source: 'b023 Network sheet (Network Outflow Gauge)'
	},

	// ---- Units and dams -----------------------------------------------------
	'farm-area': {
		long: 'The total area is used by the Area flow-share method and, summed over all hydrological units, as the default catchment area that rain falls on. Hi/Lo areas split the same land by rainfall zone.',
		aliases: ['total area', 'catchment area of hydrological unit', 'catchment area of farm'],
		related: ['flow-share', 'catchment-area'],
		source: 'b023 Farm spec'
	},
	'hi-lo-map-area': {
		long: 'Used by the Hi/Lo flow-share method: wetter land produces more runoff per km², so the hydrological unit’s share is weighted by where its land lies rather than by area alone.',
		aliases: ['area hi', 'area lo', 'high MAP', 'low MAP'],
		related: ['flow-share', 'hi-lo-split', 'map'],
		source: 'b023 Farm spec'
	},
	'flow-share': {
		long: 'Catchment natural flow is split into the runoff of each hydrological unit by a fixed share per hydrological unit. Three methods:\n\n• Area — the hydrological unit’s area over the total area.\n• Hi/Lo — area-weighted separately in the high- and low-rainfall zones, then combined with the Hi/Lo split.\n• Manual — a share you enter per hydrological unit, typically computed in a separate study.\n\nThe same shares divide the pragmatic EWR into per-unit EWR shares. A warning appears when the shares don’t sum to 1 (tolerance 0.0002).',
		aliases: ['fragmentation', 'fragmented flow', 'share'],
		related: ['hi-lo-split', 'farm-area', 'natural-flow'],
		source: 'b023 Farm spec; docs/model.md §2.5'
	},
	'hi-lo-split': {
		long: 'Typically taken from a Pitman study of the catchment. The two numbers should add up to 1.',
		aliases: ['Pitman split', 'hi MAP flow %', 'lo MAP flow %'],
		related: ['flow-share'],
		source: 'b023 Farm spec'
	},
	'upstream-to-dam': {
		long: 'The b023 column is labelled “upstream inflow above dam”: the share of the upstream inflow that enters the dam, above the dam wall. The rest passes below the dam, where the diversion capacity can still take some back. 100 % suits a dam on the river; 0 % an off-channel dam filled only by the diversion.\n\nThe workbook’s formula applied the fraction the other way round (to the water passing below), against its own label and its [Models] sheet. The client confirmed the label’s meaning, and the app follows it from engine 0.9.0. This is also the South African convention: the Pitman/WRSM model describes farm dams by the share of the catchment that drains into them.',
		aliases: ['upstream inflow above dam', 'upstream to dam'],
		related: ['runoff-to-dam', 'diversion'],
		source: 'b023 Farm spec; docs/model.md §3 Q1 (resolved)'
	},
	'runoff-to-dam': {
		long: 'Set 100 % for a dam that captures the hydrological unit’s whole area, 0 % for a natural area or a hydrological unit whose dam doesn’t intercept its land.',
		aliases: ['farm runoff above dam', 'runoff to dam'],
		related: ['upstream-to-dam', 'dam-capacity'],
		source: 'b023 Farm spec'
	},
	'dam-capacity': {
		long: 'b023 treats a hydrological unit’s dams as one composite dam. Water above capacity spills downstream the same day. The dam also loses open-water evaporation and any seepage, and catches the rain on its surface (see dam evaporation).',
		aliases: ['composite dam', 'storage capacity', 'full supply'],
		related: ['dam-initial', 'dam-min', 'spill', 'dam-storage', 'dam-evaporation', 'dam-seepage'],
		source: 'b023 Farm spec'
	},
	'dam-initial': {
		long: 'The first weeks of a run depend on this guess. New hydrological units start at 0 % (empty); an imported workbook keeps its own values. Whatever you choose, begin the simulation before the period you study so the dams settle.',
		related: ['dam-capacity', 'simulation-window'],
		source: 'b023 Farm spec'
	},
	'dam-min': {
		long: 'The level below which a farmer stops irrigating from the dam (a pump intake, a reserve for stock water or the dam wall). Each day irrigation can take only yesterday’s storage plus today’s inflows above capacity × this level. A transfer out of the dam keeps the higher of its own minimum storage and this level.\n\n0 % means irrigation may empty the dam, which is how the b023 workbook works; the network editor flags such dams as a hint. The workbook’s “min %” column was the minimum for transfers, which each transfer rule carries, so imported dams start at 0 %.\n\nDecided on the recommendation of a simulated hydrologist review (engine 0.16.0), pending confirmation by the project hydrologist.',
		aliases: ['min dam volume', 'dead storage', 'minimum storage'],
		related: ['transfer', 'transfer-min-storage', 'irrigation-supplied'],
		source: 'docs/engine-audit.md Q5; docs/model.md §2.7'
	},
	'dam-evaporation': {
		long: 'The surface shrinks as the dam empties: area = area when full × (yesterday’s storage ÷ capacity)^exponent, with exponent 0.7 for small reservoirs (Liebe et al. 2005), or, when the dam has a survey curve, the area read off the curve (engine 0.35.0). Evaporation = dam evaporation factor × the month’s A-pan ÷ days in the month × area; the factor (Settings, default 0.75) is an A-pan factor: the WR90 / WR2012 lake factors are ratios to S-pan evaporation and must not be entered unchanged. Rain on the dam = the day’s rain (before the rain threshold) × area. Evaporation never takes more than the dam holds. The runoff model’s area still includes the dam surfaces, so rain on a dam is partly counted twice (small for farm dams; engine-audit N2, pending the hydrologist).\n\nOpen water lags the pan through the seasons, so Settings can take a factor per month instead of one (engine 0.35.0); left off, the one factor applies every month. Monthly values are pending the hydrologist.\n\nWhen a dam’s area isn’t known the run estimates it as capacity ÷ 3 m (about the median mean depth of South African farm dams, Mantel & Hughes 2023) and its warnings say how many dams used the estimate. A 100 000 m³ dam of 3 ha loses about 180 m³/day at 6 mm/day of evaporation.\n\nDecided on the recommendation of a simulated hydrologist review (engine 0.16.0), pending confirmation by the project hydrologist.',
		aliases: ['evaporation', 'lake evaporation', 'open-water evaporation', 'surface area', 'area–volume', 'lake factor'],
		related: ['dam-capacity', 'dam-seepage', 'dam-storage', 'dam-survey-curve'],
		source: 'docs/engine-audit.md N2; Linsley et al. 1982; Liebe et al. 2005; Mantel & Hughes 2023'
	},
	'dam-seepage': {
		long: 'Seepage = seepage per day × yesterday’s storage, taken after evaporation and never more than is left. 0 % (the default) for a sealed dam.\n\nWhere it goes (engine 0.35.0): the share set as “seepage returning” joins the hydrological unit’s outflow the same day and stays in the catchment; the rest is lost from it (to deep groundwater) and shows as its own column and water-balance line. 100 % returning, the default, is how every earlier engine ran.',
		aliases: ['leakage', 'leak'],
		related: ['dam-evaporation', 'dam-storage'],
		source: 'docs/engine-audit.md N2'
	},
	'dam-survey-curve': {
		long: 'The rows a dam survey gives, as on the DWS dam technical data form (DW789): the water level, the surface area and the volume stored at that level. With two or more rows the run interpolates the area linearly in volume from yesterday’s storage (from 0 m³ and 0 m² below the lowest row, holding the top row’s area above it), and uses it for evaporation and rain on the dam. Without a curve the power law (area when full × (storage ÷ capacity)^exponent) is used.\n\nVolumes must rise from row to row, and neither level nor area may fall as the volume rises; a save refuses a curve that breaks this. When the top row’s volume sits more than 1 % from the dam’s capacity the run warns: check one against the other. Paste the rows in the network editor’s one-node form, or, for a what-if, as a change on a scenario (Dam survey curve; add it after a capacity change so a raised dam uses its own survey).',
		aliases: ['area–volume curve', 'area-capacity curve', 'stage–storage', 'DW789', 'basin survey', 'elevation–area–volume'],
		related: ['dam-evaporation', 'dam-capacity'],
		source: 'docs/model.md §2.7a; roadmap WP-3.5'
	},
	'dam-release': {
		long: 'A low-flow or compensation release is a common licence condition. Each day, before irrigation takes its share.\n\n**Pass inflow**: the dam passes today’s inflow to it (upstream inflow and own runoff entering it, plus any diversion), up to the flow the river below the wall still needs after what bypasses the dam: either the monthly amounts entered, or, when none are, the EWR required at this hydrological unit (its own share and the shares upstream). Inflow is passed whatever the dam’s level.\n\n**Fixed**: the dam releases the month’s amount from the water above its minimum operating level.\n\nEither is capped by the outlet capacity (empty = no limit). The release joins the hydrological unit’s outflow and shows as the dam_release column. Pending the hydrologist.',
		aliases: ['compensation flow', 'low-flow release', 'EWR release', 'outlet', 'release rule', 'pass inflow'],
		related: ['dam-min', 'dam-storage'],
		source: 'docs/model.md §2.7a; roadmap WP-3.5'
	},
	'dam-survey-date': {
		long: 'The day the dam’s capacity (and its survey curve, if it has one) was measured, from a basin survey or the DWS dam technical data form. On its own it changes nothing. With a sediment rate it is the day the dam holds exactly the capacity entered: before it the dam held more, after it less.\n\nEmpty = not recorded; a sediment rate needs it, and a save refuses a rate without one.',
		aliases: ['survey date', 'basin survey date', 'capacity date'],
		related: ['dam-sediment', 'dam-survey-curve', 'dam-capacity'],
		source: 'docs/model.md §2.7g; issue #67'
	},
	'dam-sediment': {
		long: 'Dams fill with silt, so the water they can store falls over the years. The run takes the loss as steady: the capacity on a day is the capacity entered × (1 − rate × years since the survey date), more before the survey and less after it, never below empty. Dead storage, the survey curve’s volumes and the dam-level triggers (the supply rule’s, a drought borehole’s, a transfer’s reserve) are shares of the capacity and shrink with it; the area when full doesn’t.\n\nEnter the rate as a share of the surveyed capacity lost a year, 0 to 20 %; a re-survey of the same dam gives it (the capacity lost ÷ the surveyed capacity ÷ the years between). Empty or 0 = no loss. The run carries the day’s capacity as the dam_capacity column when it changes.',
		aliases: ['siltation', 'sedimentation', 'capacity loss', 'silting'],
		related: ['dam-survey-date', 'dam-capacity', 'dam-in-service'],
		source: 'docs/model.md §2.7g; issue #67'
	},
	'dam-in-service': {
		long: 'For a dam built during the record: before this day the hydrological unit has no dam, so what is routed to it passes below as on a unit without one, and irrigation draws on the river alone. From this day the dam starts empty, fills from what reaches it and works as entered.\n\nEmpty = the dam is there for the whole run.',
		aliases: ['dam built', 'commissioned', 'dam completion date'],
		related: ['dam-capacity', 'dam-sediment', 'abstraction-start'],
		source: 'docs/model.md §2.7g; issue #67'
	},
	'abstraction-start': {
		long: 'For land developed, or a user connected, during the record: before this day the unit takes no water. A hydrological unit’s crops and demand objects, and an other water user’s own demand, are 0 until then; from this day they run as entered. Its runoff and dam (if any) are unaffected.\n\nEmpty = it abstracts for the whole run. A gauge takes no water, so it can’t have one.',
		aliases: ['development date', 'abstraction from', 'start of use', 'new development'],
		related: ['dam-in-service', 'irrigation-efficiency'],
		source: 'docs/model.md §2.7g; issue #67'
	},
	'diversion': {
		long: 'Each day up to this volume is taken from the water passing below the dam (upstream inflow and runoff that bypass it) and put into storage. b023 enters it in m³/s; the app stores m³/day.',
		aliases: ['downstream diversion', 'divert capacity', 'pump back'],
		related: ['upstream-to-dam', 'runoff-to-dam'],
		source: 'b023 Farm spec'
	},
	'irrigation-efficiency': {
		long: 'Application losses (evaporation from sprays, wind drift, runoff at the end of the field, deep percolation and leaks) mean a hydrological unit has to abstract more than its crops use. With efficiency e, abstraction demand = crop requirement ÷ e, and a fully supplied crop gets exactly its requirement. Indicative values by system: drip 90 %, micro-sprinkler 85 %, centre pivot 85 %, sprinkler 75 %, flood or furrow 65 %; a scheme’s own measurement is better. The one-node form offers these as a helper.\n\nA crop can carry its own efficiency, for the system it is under (engine 0.43.0); a crop without one uses the hydrological unit’s. The hydrological unit then runs on its crops’ efficiencies combined, each weighted by the crop’s yearly water requirement, so over a year of gross requirement the hydrological unit abstracts the sum of each crop’s requirement ÷ its own efficiency; each day it uses the one combined efficiency.\n\nSet 100 % for a stand-alone dam or natural area (no irrigation), or to leave losses out. New hydrological units start at 80 %. Hydrological units from before engine 0.16.0 were converted from their return flow % r as e = 1 − r with every loss returning, so their water balance per hydrological unit supplied is unchanged.\n\nDecided on the recommendation of a simulated hydrologist review (engine 0.16.0), pending confirmation by the project hydrologist.',
		aliases: ['application efficiency', 'irrigation system', 'drip', 'pivot', 'sprinkler', 'flood'],
		related: ['return-flow', 'irrigation-demand', 'crop-requirement'],
		source: 'docs/engine-audit.md N1; Allen et al. 1998 (FAO-56); Keller & Bliesner 1990'
	},
	'demand-factor': {
		long: 'Set only by a scenario’s “Scale demand” change (demand.scale), never in the model itself. For a hydrological unit it multiplies the crop water requirement after effective rain, so the abstraction demand (requirement ÷ efficiency) scales with it while the crop area, the irrigation efficiency and the share of losses returning stay as they are: 85 % means the hydrological unit takes 85 % of what it otherwise would. For an other water user it multiplies the monthly demand. Two scaling changes multiply (0.9 twice is 0.81). The gross demand and the effective rain used are not scaled.',
		aliases: ['demand scaling', 'scale demand', 'demand.scale', 'restriction'],
		related: ['irrigation-demand', 'crop-requirement', 'irrigation-efficiency'],
		source: 'docs/scenarios.md (demand.scale); docs/design/planning-outputs.md §3.1'
	},
	'return-flow': {
		long: 'Of the water lost in application, some drains back to the river below the hydrological unit (tail-water, shallow drainage, leaks) and some leaves the catchment (evaporation, deep percolation). The loss return fraction is the share that returns; it adds to the hydrological unit’s outflow the same day. Consumptive use (what leaves the river) is supplied − return flow.\n\nNew hydrological units start at 50 %. A hydrological unit upstream of a starved neighbour can pass it some water this way: that is real (the return is bounded by what the upstream hydrological unit abstracts) and attribution by net consumptive use accounts for it.',
		aliases: ['loss return', 'return flow %', 'drainage return'],
		related: ['irrigation-efficiency', 'irrigation-supplied'],
		source: 'docs/engine-audit.md N1; docs/model.md §2.7'
	},
	'spill': {
		long: 'Anything left above capacity after the day’s inflow, transfers, rain on the dam, groundwater pumped into the dam, evaporation, seepage, a dam release and irrigation. It is part of the hydrological unit’s outflow.',
		related: ['dam-capacity'],
		source: 'b023 farm element sheet'
	},
	'dam-storage': {
		long: 'Yesterday’s storage plus rain on the dam, today’s captured runoff, captured upstream inflow, diversion, transfers and groundwater pumped into the dam, minus dam evaporation, seepage, a dam release and irrigation, capped at capacity.',
		related: ['dam-capacity', 'spill'],
		source: 'b023 farm element sheet'
	},
	'working-columns': {
		long: 'Next to demand, supply, storage and outflow, each hydrological unit records the steps in between, in the order of the workbook’s farm sheet: gross demand, the effective rain used against it and the soil-water store left at the end of the day (mm, engine 0.14.0); upstream inflow into the dam (K) and below it (L); hydrological unit runoff into the dam (M) and below it (N); water diverted back to the dam (O); interim storage before spill (P); below-dam flow not diverted (S); and irrigation return flow (T).\n\nThe hydrological unit’s daily CSV has them in letter order, each header carrying its letter, and the run summary CSV lists every letter’s formula. The results’ “Trace a day” shows them worked out for one hydrological unit and one day. Runs made before engine 0.12.0 don’t have them.',
		aliases: ['intermediate columns', 'workings', 'FarmTemplate columns'],
		related: ['balance-check', 'dam-storage', 'return-flow'],
		source: 'b023 FarmTemplate columns F–AB; docs/model.md §2.7'
	},
	'balance-check': {
		long: 'The balance check (column V) is, for each hydrological unit and day: water in (upstream inflow + runoff + transfers + rain on the dam + groundwater pumped) − water used (supplied − return flow) − dam evaporation − the change in dam storage − outflow (which includes the seepage that returns below the dam) − stream depletion from boreholes − dam seepage lost from the catchment. It must be 0; in practice it is float noise, many orders of magnitude below the flows.\n\nEvery run also runs the checks the test suite runs on thousands of random networks: storage stays between 0 and the dam capacity, supply never exceeds demand, transfers keep to their months, rates, caps and minimum storage, the runoff model’s stores balance, and the EWR grid, hydrological unit summaries and curtailment report add up to the daily series. The results show which passed and, for a failure, the first hydrological unit and date where it broke. A failed check means a bug in the model, not in your data: report it.\n\nThe water account per water year shows where the catchment’s water went, term by term, with a residual that should be 0 (see Water account).',
		aliases: ['verification', 'invariants', 'mass balance', 'water balance', 'residual'],
		related: ['working-columns', 'dam-storage'],
		source: 'docs/model.md §6 Verification'
	},

	// ---- Crops and irrigation demand -----------------------------------------
	'apan': {
		long: 'Enter the 12 monthly values for the catchment, Oct … Sep, from an A-pan station, or from the WR90 or WR2012 quaternary data converted to A-pan: those studies publish Symons-pan (S-pan) evaporation, which reads lower than an A-pan beside it (Bosman 1990 gives the conversion). Entering S-pan unchanged understates crop demand and dam evaporation.',
		aliases: ['A pan', 'Apan', 'evaporation', 'WR90'],
		related: ['crop-factor', 'irrigation-demand', 'wr90'],
		source: 'b023 Crop demand; docs/model.md §7'
	},
	'crop-factor': {
		long: 'Gross requirement (mm) = A-pan × crop factor for that month. Factors vary with the growth stage; deciduous fruit, for example, needs little in winter.\n\nThe factor multiplies Class-A pan evaporation, not FAO reference evapotranspiration (ET₀). ET₀ is about 0.7–0.85 × pan, so a published FAO-56 Kc entered here overstates demand by roughly a quarter: multiply it by the pan coefficient first. A factor above 1.0 is possible but unusual against a pan, so the Crops tab points it out.\n\nLoad crop factors, under the crop table (Crops & demand › Grids › Crop factors), fills the factors from a reference library or a b023 workbook. The library holds the A-pan design factors of the ARC/SABI Irrigation Design Manual (winter rainfall area, Tables 4.13–4.15; pecan from Table 4.10), each with its table and page; vegetables, staged by portion of the season, need a planting date and season length. Map each crop to a source crop, optionally multiply by a pan coefficient (about 0.75 for an FAO-56 Kc set) and pick an irrigation system for its efficiency; the dialog shows each crop’s change month by month and the demand difference per hydrological unit before you apply. Applying edits the table only: save it with a reason. Which set a catchment uses is the hydrologist’s call.',
		aliases: ['Kc', 'crop coefficient', 'pan factor', 'crop library', 'load crop factors', 'ARC', 'SABI', 'design manual'],
		related: ['apan', 'crop-area', 'irrigation-efficiency', 'pan-coefficient'],
		source: 'b023 Crop demand; ARC/SABI Irrigation Design Manual ch. 4; docs/model.md §2.3'
	},
	'crop-area': {
		long: 'The hydrological unit’s demand is the sum over its crops of area × requirement. Stand-alone dams and natural areas have no crop area.',
		aliases: ['cropped area', 'hectares', 'farm demand'],
		related: ['crop-factor', 'irrigation-demand'],
		source: 'b023 Farm demand'
	},
	'effective-rainfall': {
		long: 'Rain above the rain threshold gives cropped area × rain × this fraction of effective rain. It covers the day’s demand first; what the crop can’t use that day goes into the soil-water store and covers the following days. Light rain at or below the threshold never counts.\n\nThe fraction can instead be set for each month (engine 0.43.0), where a wetter or drier season changes how much of the rain the crop can use. The run warns when every month is 0, since rain would then never reduce irrigation.',
		aliases: ['effective rain'],
		related: ['irrigation-demand', 'rain-threshold', 'soil-water-store'],
		source: 'b023 Crop demand; docs/model.md §2.3'
	},
	'soil-water-store': {
		long: 'Each hydrological unit has one store over its cropped area, a one-bucket form of the FAO-56 root-zone balance. Each day: effective rain is added; the day’s gross demand is met from the store plus that rain first; what is left stays, up to this depth, and the excess drains or runs off (the runoff model already counts it). The store starts empty.\n\nThe default 25 mm is the readily available water of 0.5 m of roots in a soil holding 100 mm/m, half of which the crop can take without stress (FAO-56 Tables 19 and 22). Deeper roots or a heavier soil hold more. 0 mm turns carry-over off: each day’s rain then only offsets that day, as the b023 workbook does.\n\nThis was decided on a simulated hydrologist’s recommendation and is pending the real hydrologist’s review. The daily hydrological unit CSV and “Trace a day” show the store at the end of each day.',
		aliases: ['soil moisture', 'carry-over', 'root zone', 'readily available water', 'RAW'],
		related: ['effective-rainfall', 'irrigation-demand', 'working-columns'],
		source: 'Allen et al. 1998 (FAO-56) ch. 8; docs/engine-audit.md N3; docs/model.md §2.3'
	},
	'crop-requirement': {
		long: 'Gross demand comes from crop areas × A-pan × crop factor, spread over the days of the month. The requirement subtracts the effective rain used that day, from the day’s rain or from the soil-water store it filled on earlier days, and never goes below zero. The hydrological unit abstracts more than this to cover application losses: see irrigation demand.',
		aliases: ['crop water requirement', 'net irrigation need', 'net demand'],
		related: ['irrigation-demand', 'irrigation-efficiency', 'effective-rainfall'],
		source: 'b023 Irrigation Demand; docs/model.md §2.3'
	},
	'irrigation-demand': {
		long: 'Supply, deficit, the fraction supplied and the curtailment report are all measured against this abstraction demand, so 100 % supplied means the crop got its full requirement. With 100 % efficiency it equals the crop water requirement, as in the b023 workbook.',
		aliases: ['demand', 'abstraction'],
		related: ['crop-requirement', 'irrigation-efficiency', 'irrigation-supplied', 'irrigation-deficit'],
		source: 'docs/engine-audit.md N1; docs/model.md §2.7'
	},
	'irrigation-supplied': {
		long: 'Irrigation draws on yesterday’s storage above the dam’s minimum operating level plus today’s captured inflows and transfers, up to the abstraction demand. Average supplied ÷ average demand is the fraction of demand supplied; the crop gets efficiency × supplied, so the same fraction of its requirement.',
		aliases: ['supply'],
		related: ['irrigation-demand', 'irrigation-deficit'],
		source: 'b023 farm element sheet; Shortfalls sheet'
	},
	'irrigation-deficit': {
		long: 'A hydrological unit with a persistent deficit is over-allocated for the water it can capture. The b023 Shortfalls sheet reports it per hydrological unit over a reporting window.',
		aliases: ['shortfall', 'unmet demand'],
		related: ['irrigation-demand'],
		source: 'b023 Shortfalls sheet'
	},

	// ---- Transfers ------------------------------------------------------------
	'transfer': {
		long: 'Each day in an active month the transfer takes what the source dam held at the end of yesterday above its minimum level, up to the room at the destination (its free space plus that day’s irrigation demand) and the maximum rate (and daily cap, if set). Transfers move before any hydrological unit irrigates. The same volume leaves the source and enters the destination, so it always balances.\n\nb023 writes transfers as free-form formulas; the app uses these structured rules instead. Anything a workbook does that doesn’t fit them needs discussing with the hydrologist.',
		aliases: ['pipeline', 'canal', 'from', 'to'],
		related: ['transfer-months', 'transfer-rate', 'transfer-min-storage'],
		source: 'b023 Help (Transfers sheet); docs/model.md §2.6'
	},
	'transfer-months': {
		long: 'Often a winter-filling scheme: move water while the source dam spills, not in the irrigation season. Each month has its own maximum rate, so a pipe that runs at half capacity in spring and full in winter is one rule. A blank (0) month is off. A b023 workbook gives one rate and the months it runs in; that reads as the same rate in each of those months and runs exactly as before until you change a month (engine 1.14.0).',
		related: ['transfer'],
		source: 'b023 Transfers configuration'
	},
	'transfer-rate': {
		long: 'The day’s transfer is the smallest of the available water in the source dam, the room at the destination, the month’s rate × 86 400 s, and the daily cap when one is set.',
		aliases: ['max rate', 'daily cap'],
		related: ['transfer'],
		source: 'b023 Transfers configuration'
	},
	'transfer-offtake': {
		long: 'Pick **The river (an off-take)** under **Takes from**. Each day, once the source hydrological unit has taken its own water, the off-take takes from the flow leaving it, up to the month’s rate (× 86 400) and the daily cap, but never the flow it must leave: the senior users’ requirement, its **hands-off flow** and, with **Leaves the EWR in the river**, the EWR there. Without those it doesn’t protect the EWR, like any other abstraction.\n\n**Takes** says how much: **What the destination needs** (its demand today, and its dam’s room when it **tops up the destination’s dam**) or **Up to capacity**, like a canal that runs full whatever is drawn from it. A share of what it takes, the **losses on the way**, never arrives (seepage and evaporation from the canal). At the destination the water meets the demand first, before the hydrological unit’s own dam, pump and boreholes; what is left fills the dam when the rule says so, and otherwise flows on down the destination’s river, where hydrological units below it (a town on the canal) can pump it.\n\nThe destination is worked out after its source each day, so an off-take whose destination drains back into its source can’t run; the model refuses it.',
		aliases: ['off-take', 'offtake', 'canal', 'weir', 'diversion', 'hands-off flow', 'conveyance losses', 'furrow'],
		related: ['transfer', 'transfer-rate', 'transfer-months'],
		source: 'docs/model.md §2.6a'
	},
	'transfer-min-storage': {
		long: 'Checked against yesterday’s end-of-day storage. The reserve kept is the higher of this value and the source dam’s minimum operating level.',
		related: ['dam-min', 'transfer'],
		source: 'b023 Transfers configuration; docs/model.md §3 Q3'
	},
	'transfer-priority': {
		long: 'Each day, before any hydrological unit irrigates, each rule moves the smallest of: what its source dam holds above its minimum (yesterday’s storage, less what earlier rules took), the room at its destination (free space in the destination’s dam once that day’s rain on it, evaporation and seepage are counted, plus that day’s irrigation demand, less what other rules already sent it), and its rate or daily cap. A transfer to a hydrological unit with no dam still serves the hydrological unit’s demand; water is never pumped into a full dam only to spill.\n\nRules run by priority, lowest first. Rules with the same priority share: two rules from one dam split its water in proportion to their own limits, and two rules into one hydrological unit split its room the same way, so the order of the list never changes a result. New rules start after the existing ones. The source’s own irrigation comes after the day’s transfers (the source doesn’t irrigate first).\n\nDecided on the recommendation of simulated hydrologist and licensing reviews (engine 0.16.0), pending confirmation by the project hydrologist.',
		aliases: ['priority', 'order', 'pro rata', 'free space', 'receiving dam'],
		related: ['transfer', 'transfer-min-storage', 'transfer-rate'],
		source: 'docs/engine-audit.md N4, Q18; docs/model.md §2.6'
	},

	// ---- Natural flow and calibration -----------------------------------------
	'natural-flow': {
		long: 'The runoff model, GR4J, turns daily rain into natural flow. The workbook fell back to a Pitman flow column on days the rain model gave nothing (quirk Q7); the app does not, so natural flow always comes from the runoff model.\n\nNatural flow is then split into hydrological unit runoff by the flow shares.',
		aliases: ['naturalised flow', 'virgin flow'],
		related: ['calibration', 'flow-share', 'runoff-model'],
		source: 'b023 Flow data sheet; docs/model.md §2.4'
	},
	'farm-runoff': {
		long: 'Natural flow × the hydrological unit’s flow share.',
		related: ['natural-flow', 'flow-share'],
		source: 'b023 Fragmented flow'
	},
	'upstream-inflow': {
		long: 'Upstream elements are always computed first, so a hydrological unit sees today’s outflow of its upstream neighbours.',
		related: ['network', 'farm-outflow'],
		source: 'b023 farm element sheet'
	},
	'farm-outflow': {
		long: 'It becomes the next element’s upstream inflow. At the outflow gauge it is the catchment’s simulated outflow.',
		related: ['upstream-inflow', 'spill', 'return-flow'],
		source: 'b023 farm element sheet'
	},
	'calibration': {
		long: 'Tune by hand (change a parameter, run, and compare simulated with observed flow: hydrograph and statistics such as NSE and PBIAS), or let Fit automatically search for the parameters. Calibrate over a period with a good observed record; the workbook uses its own calibration date window, separate from the main run.',
		aliases: ['flow calibration', 'tuning'],
		related: ['gr4j', 'nse', 'pbias', 'observed-flow'],
		source: 'b023 Help (Calibration function; Flow Calibration Cfg)'
	},
	'runoff-model': {
		long: 'GR4J is the only runoff model since engine 1.0.0, so there is nothing to choose. The workbook’s own model, the legacy runoff model, did not conserve water and was removed; runs made with it before then still open, labelled “Workbook comparison”, but can’t be re-run.\n\nThe runoff model only changes how rain becomes natural flow. Flow shares, hydrological units, dams, transfers and the EWR are the same whichever model made the flow, so an old legacy run and a GR4J run compare directly.',
		aliases: ['rain-runoff model', 'rainfall-runoff'],
		related: ['calibration', 'natural-flow', 'gr4j', 'legacy-runoff-model'],
		source: 'docs/model.md §2.4; issues #4, #16'
	},
	'gr4j': {
		long: 'GR4J (Perrin, Michel & Andréassian 2003) is used worldwide. Rain first meets evaporation; what is left partly fills a soil-moisture (production) store of capacity X1. The rest, plus what percolates out of that store, is spread in time by two unit hydrographs of time base X4 days. 90 % goes through a routing store (reference capacity X3), and 10 % goes straight to the outlet.\n\nX2 exchanges water with groundwater outside the catchment. It is fixed at 0 by default, so the catchment is closed and the balance rain − evaporation − flow = change in storage holds every day. The model first runs a warm-up (a year by default) over the start of the record, so the stores begin at a realistic level; warm-up days are never shown or scored.\n\nTypical values: X1 100–1 200 mm, X3 20–300 mm, X4 1.1–2.9 days.',
		aliases: ['X1', 'X2', 'X3', 'X4', 'production store', 'routing store', 'unit hydrograph', 'warm-up', 'Perrin'],
		related: ['runoff-model', 'pan-coefficient', 'actual-evaporation'],
		source: 'Perrin et al. (2003), J. Hydrol. 279; docs/model.md § Rain to flow: GR4J'
	},
	'pan-coefficient': {
		long: 'A Class-A pan evaporates more than a catchment’s soils and plants could, so conceptual runoff models scale it down. 0.7 is a common flat value. Monthly values (for example the WR90 or Midgley factors) can be entered instead. The coefficient does not affect irrigation demand, which uses crop factors on the A-pan directly. It is used only while GR4J’s potential evaporation is set to pan coefficient × A-pan; with a monthly PE row entered directly GR4J ignores it.\n\nThree presets fill the row as a starting point (still editable; picking one writes its name into the optional “Pan coefficient source” note): Generic (flat 0.70), Winter rainfall (e.g. Western Cape) and Summer rainfall. They are indicative, from FAO-56 Table 5 climate classes (Allen et al. 1998) — confirm against local humidity and wind. A run warns, and Settings hints, when a month sits outside FAO-56’s usual 0.6–0.85 range for a Class A pan; that is a plausibility check, not a hard limit, so a value further out still saves and runs.\n\nThe FAO-56 Table 5 helper fills the row from monthly humidity and wind, the pan’s siting and its fetch, and writes the table cells and your note on where the humidity and wind came from into the same source note. The note is provenance only: fits and runs record it, and editing it never marks a fit’s forcing as changed.\n\nBecause GR4J’s parameters trade off against evaporation, the coefficient is held fixed and never calibrated: a fit records the coefficient it ran under, and changing it afterwards marks the fit record “Forcing changed since fit”.',
		aliases: ['PET', 'potential evaporation', 'k pan', 'pan coefficient preset', 'FAO-56'],
		related: ['gr4j', 'apan', 'auto-calibration'],
		source: 'Issue #4 §1 (forcing); FAO-56 Table 5 (Allen et al. 1998); docs/model.md §2.4a'
	},
	'gr4j-pe': {
		long: 'One A-pan row drives three things: GR4J’s potential evaporation (× the pan coefficient), irrigation demand (× the crop factors) and dam evaporation (× the dam evaporation factor). With **Pan coefficient × A-pan**, the default and what every earlier run did, changing the A-pan row moves all three.\n\n**Monthly PE, entered directly** gives GR4J its own 12 values in mm (Oct … Sep), for example a station’s FAO-56 reference evapotranspiration (ET₀) × a stated factor, with a required note of the source. GR4J then runs on that row alone; the pan coefficient is not used, and irrigation demand and dam evaporation still read the A-pan row, so a PE change moves the runoff model and nothing else. A row of zeros is refused, as a zero A-pan row is.\n\nSettings shows the annual PE GR4J runs on under either choice. A fit records the PE input it ran under, so changing it marks the fit record “Forcing changed since fit”.',
		aliases: ['PE', 'PET', 'ET0', 'ET₀', 'reference evapotranspiration', 'monthly PE', 'evaporation source'],
		related: ['pan-coefficient', 'apan', 'gr4j'],
		source: 'Issue #39; FAO-56 (Allen et al. 1998); docs/model.md §2.4a'
	},
	'areal-rain': {
		long: 'A valley rain gauge or a 0.05° satellite product such as CHIRPS can read well below the rain that falls on a mountain catchment as a whole: orographic rain on the ridges is what they miss most. GR4J conserves water, so on such rain it cannot make the flow the gauge records without importing water through X2, which would hide the rain error in a parameter.\n\nThe correction multiplies the rain GR4J runs on (catchment rain, else corrected CHIRPS, else forecast) by a factor per month (Oct … Sep, each 0.25–4), with the method and a required note of the source. The preferred basis is an **independent MAP**: the catchment’s mean annual precipitation from WR2012, an isohyetal map or a gridded MAP averaged over the catchment, divided by the forcing’s own mean annual rain over its complete water years (one flat factor, since an annual MAP says nothing about the seasons). **Rain gauges** in or near the catchment are the other independent basis. A factor **fitted** to the flow record is allowed but makes the rain level a calibrated multiplier that trades off against X1 and the evaporation, and every run says so.\n\nOnly the runoff model reads it. Irrigation demand’s effective rain and rain on the dams keep the recorded rain, because the fields and dams sit in the valley where the gauge is. The runoff coefficient, the WR2012 rain scaling, the water account and the plausibility checks read the corrected rain, which runs show as the daily “Areal catchment rainfall” column. A fit records the factors it ran under, so changing them marks the fit record “Forcing changed since fit”.',
		aliases: ['areal rain', 'areal rainfall', 'rain factor', 'MAP correction', 'orographic rain', 'rain scaling', 'arealRain'],
		related: ['gr4j', 'chirps-bias', 'rain-final', 'gr4j-pe'],
		source: 'Engine 1.13.0; docs/model.md §2.4g; docs/calibration-research.md § Rain forcing'
	},
	'actual-evaporation': {
		long: 'The part of potential evaporation that rain meets directly, plus what the soil-moisture store can give up. On dry days with a dry store it falls well below PET.',
		related: ['gr4j', 'pan-coefficient'],
		source: 'Perrin et al. (2003)'
	},
	'auto-calibration': {
		long: 'The search is DDS (Tolson & Shoemaker 2007): it tries a set number of model runs, perturbing all parameters at first and fewer as it homes in, and never leaves each parameter’s allowed range. It runs several separate searches (Starts, default 5), each from its own seed, and keeps the best; nearly equal scores with scattered parameters mean the record can’t pin them down. Every run scores the whole model, hydrological units and dams included, against the observed record over the calibration window.\n\nPick what to optimise: KGE′ (the default), a year-balanced KGE′ that stops a few wet years dominating, a non-parametric KGE, NSE on √Q or log Q for medium and low flows, or the mean of KGE′ on Q and on 1/Q, which weighs low and high flows together (suggested for EWR, low-flow, decisions).\n\nThe fit alone says little. Validation fits again on the first half of the record and scores the second half, then fits on the driest water years and scores the wettest (listed by water year, since they interleave). When the project has a reference gauge on another river covering those years, the years are ranked dry → wet by it, a regional index that is never scored; otherwise by the record’s own flow. The result also says how representative the record is: how many water years it covers and where their rain sits among the run’s long-term rain. With both a gauge and a logger record you can also score the fit against the record it wasn’t fitted to, a second instrument. Those columns are the honest measure. The main scores show a 90 % range in brackets, from resampling whole water years: a wide range means the record can’t pin the score down. A second table sets the model beside two simple benchmarks on the same days, the mean flow every day and each calendar day’s average flow; a model that can’t beat the second adds little beyond the seasonal cycle. With a short record that is mostly drought, the result says so: wet-year behaviour is then weakly constrained. Nothing is saved until you apply the result and save the form.',
		aliases: ['auto-calibration', 'optimiser', 'DDS', 'split-sample', 'differential split-sample', 'validation', 'KGE′'],
		related: ['calibration', 'gr4j', 'nse'],
		source: 'Tolson & Shoemaker (2007); Klemeš (1986); Kling et al. (2012); docs/model.md §2.10b'
	},
	'uncertainty-bands': {
		long: 'One calibrated run gives one number for EWR days not met, curtailment and the annual volumes, but many parameter sets fit the record nearly as well, and the pan coefficient, the rain and the observed record are uncertain too. The ensemble samples them all: a Latin hypercube across the parameter bounds (never the optimiser’s own path), a shift of the pan coefficient (GR4J), station rain with CHIRPS infill or CHIRPS alone, and the gauge or the logger to judge against, where the project has both.\n\nA set is kept only if it passes the rule printed next to the bands: a skill score (KGE′ by default) on the first half of its record, the WR2012 flag on its natural flow, and the low-flow bias. The bands are the 5th to 95th percentiles of the kept sets; with fewer than 30 kept none are shown. The second half of the record is held out: the share of its observations inside the daily band is the coverage, and below 70 % the band is too narrow to trust.\n\nThe server fixes the rule and draws the seed before anything runs, keeps every ensemble started, and re-runs members to check a result before storing it, so a band can’t be picked after the fact. Run comparison bands the difference between two runs member by member: the extra impact of an application, with its own uncertainty.',
		aliases: ['GLUE', 'uncertainty', 'ensemble', 'Latin hypercube', 'behavioural', 'confidence band', 'coverage'],
		related: ['auto-calibration', 'wr2012-check', 'calibration-bounds'],
		source: 'Beven & Binley (1992); McKay et al. (1979); docs/model.md §2.10e; issue #4 phase 9'
	},
	'calibration-bounds': {
		long: 'A short or drought-heavy record often can’t pin down X1 (production store) and X3 (routing store): the fit lands outside where GR4J parameters usually sit, because too little of the record constrains them. "Typical" restricts the search to Perrin et al.’s (2003) 80 % range over 429 catchments (X1 100–1200 mm, X3 20–300 mm, X4 1.1–2.9 days), which can make an under-constrained fit land somewhere plausible instead of at an extreme of the wide range. It is a constraint on the search, not evidence the catchment truly falls inside it: read the fit and validation scores either way, and prefer the wide range when the record constrains the parameters well. Recorded with the fit record.',
		aliases: ['typical range', 'Perrin range', 'wide bounds', 'X1 range', 'X3 range'],
		related: ['auto-calibration', 'gr4j', 'fit-record'],
		source: 'Perrin, Michel & Andréassian (2003); issue #4 phase 6'
	},
	'wr2012-check': {
		long: 'WR2012 (Water Resources of South Africa 2012) gives each quaternary catchment a naturalised mean annual runoff (MAR) and mean monthly flows: the river as it would be with no hydrological units, dams or abstraction. Enter them from the study for the quaternary this project lies in, with the period they cover and where they come from. The app doesn’t ship WR2012 data.\n\nEach run then compares its simulated natural flow, never the outflow, with the reference. The reference is scaled to the modelled catchment by the area ratio (the default), or, if you choose it and the quaternary MAP is entered, by the area and the rainfall ratio (the run’s mean annual rain ÷ the quaternary MAP). Runoff doesn’t scale in proportion to rain, so treat the rainfall scaling as a first estimate.\n\nThe report gives the MAR ratio over the complete water years both cover and over the whole run, the 12 monthly ratios with the dry-season months marked, and the correlation of the monthly pattern. A MAR that differs by 10 % is noted, by 25 % (or 15 % wetter) is queried, and by 50 % makes the run unusable for EWR findings until it is explained. The thresholds are editable.\n\nMonthly means are in million m³ per month (not m³/s) and should add up to the MAR within 5 %. A MAR larger than the rain on the quaternary (MAP × area) is rejected.',
		aliases: ['WR2012', 'naturalised flow', 'naturalized flow', 'MAR', 'quaternary', 'Water Resources of South Africa'],
		related: ['natural-flow', 'wr2012-penalty', 'gr4j'],
		source: 'Bailey & Pitman, Water Resources of South Africa 2012 Study (WRC); docs/model.md § WR2012 check',
		countries: ['ZA']
	},
	'wr2012-penalty': {
		long: 'When it is on, Fit automatically adds weight × |ln(simulated natural MAR ÷ scaled WR2012 MAR)| to the loss it minimises, so a wetter and a drier MAR by the same factor cost the same. It only touches the annual volume, not the daily pattern. When two published natural-MAR estimates disagree, tick “Use a MAR band instead of one target”: the penalty is then 0 inside the band (already at the modelled catchment’s scale) and weight × |ln(simulated MAR ÷ the nearer bound)| outside it.\n\nThe result shows the fit with the penalty and the same fit without it, with the weight, so you can see what matching WR2012 costs the fit to the observed record. A short or impacted observed record can disagree with WR2012 for good reasons; the penalty is a nudge, not a constraint.',
		aliases: ['soft penalty', 'MAR penalty', 'regularisation'],
		related: ['wr2012-check', 'auto-calibration'],
		source: 'docs/model.md § WR2012 check; issue #4 phase 8',
		countries: ['ZA']
	},
	'calibration-exclusions': {
		long: 'Use one for a period whose data you can’t trust: a suspect rain year, the gauge after a known break, an outage. Excluded days are left out of Fit automatically and of the run’s calibration statistics alike; the model still simulates them. A water year runs from 1 October to 30 September. A reason is required, every run stores the exclusions it applied, and comparing two runs lists any exclusion added, removed or re-reasoned, so dropping an awkward period always leaves a record.',
		aliases: ['excluded periods', 'exclude water year', 'bad years'],
		related: ['calibration-window', 'auto-calibration'],
		source: 'Not in the workbook; docs/model.md §2.10'
	},
	'quality-flags': {
		long: 'A gauge measures water level; a rating curve turns it into flow, and the curve is only checked against field gaugings over the range they cover. Above the highest gauging the flow is the curve extended by judgement, often out by 40 % or more on South African weirs, so a fit that chases those peaks chases the extrapolation. Enter the highest and lowest gauging of each record, with where they come from, under Calibration record. Each observed day then gets one flag: in the gauged range, above the highest gauging, below the lowest (above zero; a dry weir reads zero reliably), suspect (an outlier or flat stretch by the Data checks, under the limits in Settings → Data quality), infilled (a gap-filled value) or missing. Fit automatically censors days above the highest gauging by default: the model only has to reach the highest gauging on them, however high the record reads. Below-rating, suspect and infilled days are left out. The fit shows its scores on all days beside the fit on the clean days, and a data-quality panel with the share of days by flag, the rain on the scored days (gauge reading or infilled) and what the record can’t support, with how wet the scored years were under it. The run’s own calibration statistics still score every observed day. Changing a gauged range or a treatment marks the fit record “Quality flags changed since fit”. A river that really stops trips the flat-stretch check after 90 days of zero flow (by default): if so, score suspect days as recorded. The human-use class is defined but not yet derived.',
		aliases: ['gauged range', 'highest gauging', 'rating extrapolation', 'censored days', 'suspect days', 'data-quality panel'],
		related: ['auto-calibration', 'calibration-exclusions', 'fit-record'],
		source: 'docs/model.md §2.10h; calibration research CR-18, CR-19, CR-22 (Coxon et al. 2015; Kiang et al. 2018; Beven & Westerberg 2011)'
	},
	'calibration-rules': {
		long: 'Each pass of calibrate → review → refit normally needs a person, who chooses the years to leave out, the forcing and the fit to keep after seeing the scores. Chasing the score that way overfits, and an assessor can’t tell a principled choice from a convenient one. Calibration rules make those choices in advance. A water year is left out when more than a set share of its observed days carry a quality flag, and each such exclusion names the rule as its reason. Each listed pan coefficient is fitted with each set of bounds and objective, every fit with the split-sample and dry → wet tests, by a search (seed, starts, model runs) that is part of the rules too. The fit kept is the one with the best score on a held-out test, never the in-sample score, among those whose natural MAR is inside the WR2012 band (when there is a reference) and whose parameters are in the typical range. If none passes, none is kept, and the reasons are listed.\n\nThe server runs the saved rules, one background job per fit, and computes every score itself. Applying the kept fit is the server’s too: it saves the parameters with a record of the rules and every fit tried, runs the model and, when the rules say so, the uncertainty ensemble around the fit. Each change to the rules raises their revision, and a fit made under an older revision can’t be applied, so a rule can’t be adjusted once its result is seen. The rules can also run by themselves when new data arrives, and apply their fit while signed off. The default rules are drafts until the hydrologist signs them off: they type their name as a signature, and saving dates it and records their account in the History tab. A fit picked under draft rules is marked as not evidence.',
		aliases: ['automated calibration', 'pre-declared rules', 'rule set', 'selection rule', 'sign-off'],
		related: ['auto-calibration', 'quality-flags', 'fit-record', 'calibration-bounds'],
		source: 'docs/model.md §2.10j; issue #153; calibration research, “Automated calibration with pre-declared rules”'
	},
	'fit-record': {
		long: 'The record keeps the runoff model, objective, bounds, seed, starts, model runs per fit, calibration window, exclusions, the record fitted to, the forcing (pan coefficient, A-pan, CHIRPS bias correction and the rain-gap settings), the engine version and the time, with every score: the in-sample fit and the split-sample, dry → wet and independent-record validation. The same inputs, engine version and seed give the same fit, so anyone can reproduce it. Each run keeps the record in effect, so its results show which fit produced their parameters. Change a fitted parameter by hand and the record is marked “Parameters edited since fit”: it no longer describes them. Change the forcing and it is marked “Forcing changed since fit”: GR4J’s parameters are only valid for the evaporation and rain they were fitted under. The in-sample score is the fit to the calibration period; judge the parameters by the validation scores.',
		aliases: ['fit provenance', 'seed', 'parameters edited since fit'],
		related: ['auto-calibration', 'calibration-exclusions'],
		source: 'docs/model.md §2.10b'
	},
	'catchment-area': {
		long: 'Set it only when the modelled hydrological units don’t cover the whole catchment and you want rain over the full area. 1 mm over 1 km² = 1 000 m³.',
		related: ['farm-area', 'gr4j'],
		source: 'b023 Farm spec (total area)'
	},
	'rain-threshold': {
		long: 'Filters out drizzle that the soil absorbs, so it doesn’t reduce irrigation demand (“Rain threshold for demand”). GR4J uses all the rain. In the legacy runoff model (removed in engine 1.0.0) the same thresholded rain also drove runoff (quirk Q6).',
		related: ['effective-rainfall', 'legacy-runoff-model'],
		source: 'b023 Flow Calibration Cfg; docs/model.md §3 Q6'
	},
	'base-flow': {
		long: 'GR4J has no separate base-flow store: its routing store carries most of the storm flow too. Where the app needs base flow (Low flows judged on) it separates it from the flow with the Lyne–Hollick filter. The Base flow column of a daily table belongs to a legacy run (engine < 1.0.0): there base flow receded day by day along the recession curve, and a big enough rain pulse reset it to the pulse size.',
		aliases: ['baseflow', 'low flow', 'quickflow'],
		related: ['gr4j', 'legacy-runoff-model'],
		source: 'b023 Flow data; docs/model.md §2.4'
	},
	'legacy-runoff-model': {
		long: 'The workbook’s empirical model: rain above the threshold made a peak a · rain^b × catchment area × a summer or winter factor (a summer month, or a winter month before a big storm switched it to winter response), which then receded along a recession curve, next to a slowly receding base flow. The engine audit found that it does not conserve water: one small storm could return several times its own volume as flow, so it was never evidence and engine 1.0.0 removed it.\n\nRuns made with it before then still open read-only, badged “Workbook comparison”: they can be compared and exported, but not re-run, nominated as evidence, signed or published. Their daily table keeps the model’s own columns (summer flag, rain flow, response flow, base flow). A project still set to it runs GR4J, with a warning to check the GR4J parameters.',
		aliases: ['legacy model', 'b023 recession', 'peak coefficient', 'summer factor', 'winter factor', 'summer months', 'recession curve', 'workbook comparison'],
		related: ['runoff-model', 'gr4j', 'base-flow'],
		source: 'docs/model.md §2.4 (retired); docs/engine-audit.md H1; issue #16'
	},

	// ---- EWR ----------------------------------------------------------------
	'ewr': {
		long: 'In South Africa the legal term is the ecological Reserve; older studies call it the IFR (instream flow requirement). It is derived per river for an ecological category, typically with the Desktop Reserve Model. This model checks every day whether the simulated flow meets it.',
		aliases: ['Reserve', 'ecological reserve', 'IFR', 'instream flow requirement', 'environmental flow'],
		related: ['pragmatic-ewr', 'ewr-shortfall', 'ecological-category', 'desktop-reserve-model'],
		source: 'b023 EWR Cfg; docs/model.md §7'
	},
	'pragmatic-ewr': {
		long: 'Reserve tables vary the requirement with how wet the month is, which is hard to plan for on a farm. b023 instead picks one value per month — typically a percentile of the Reserve flows without high flows, converted to m³/day — so farmers know in advance how much to leave in the river.\n\nEnter the 12 monthly values, Oct … Sep. The catchment value is checked at the outflow gauge and split into per-unit shares by the flow shares; each gauge is checked against the shares of everything upstream of it.',
		related: ['ewr', 'desktop-reserve-model', 'flow-share'],
		source: 'b023 Help (EWR configuration); EWR Cfg; docs/model.md §3 Q10'
	},
	'ewr-share': {
		long: 'The daily series is the cumulative EWR: the hydrological unit’s own share plus the cumulative EWR of the elements directly upstream, as the b023 Element sheets compute it (quirk Q4). A gauge is checked against the same sum, and the outflow gauge against the full EWR. Who is charged for a shortfall is the EWR charge, not a hydrological unit’s own share.',
		related: ['pragmatic-ewr', 'ewr-shortfall'],
		source: 'b023 Fragmented EWR; docs/model.md §3 Q4'
	},
	'ewr-shortfall': {
		long: 'At the outflow gauge it is simulated outflow minus the pragmatic EWR on days it falls short; at a gauge, the flow there minus the EWR of everything upstream. Who is charged for it is the EWR charge.',
		aliases: ['EWR not met', 'deficit to the river'],
		related: ['ewr-days-not-met', 'pragmatic-ewr', 'ewr-charge'],
		source: 'b023 EWR shortfalls sheet'
	},
	'ewr-charge': {
		long: 'The EWR is assessed at EWR sites: the outlet and every gauge marked as an EWR site (the default). On a day a site is short by D, each hydrological unit upstream of it has a net impact e = inflow + runoff + transfers − outflow (its consumptive use, storage gain and exports; a transfer counts only when it leaves the site’s catchment). The hydrological units are charged D in proportion to the positive impacts, but never more than the sum of those impacts: the rest is natural, because natural flow was already below the EWR. A hydrological unit that added water that day (a dam release, return flow) is neither charged nor credited. A hydrological unit above several sites carries the largest of its charges, not the sum, because a cut upstream raises the flow at every site below it; the site that sets it is its binding site, stored with the run each day (engine 1.5.0).\n\nA hydrological unit short on its own reach is not charged while every EWR site is met. Add gauges at the Reserve determination’s EWR sites to protect upstream reaches. A cut can be taken up by a dam between two nested sites; only a re-run with the cuts applied shows that.\n\nThe curtailment report uses the charge (engine 0.17.0). Before, it used the reach shortfall, which could charge a hydrological unit more than it took or for low flow nobody caused. Decided on a simulated CMA-assessor recommendation (2026-09-24), pending the real assessor and hydrologist.\n\nEvery table and export shows the charge as a positive volume charged (m³/day), and its irrigate-less and store-less parts the same way; the changes it asks for (supply cut, total change) are negative, a reduction. Only the daily series (ewr_charge, ewr_charge_irrigation) keep the workbook’s sign, negative on a day with a charge.',
		aliases: ['EWR attribution', 'charged to hydrological units', 'charged to farms', 'natural shortfall', 'binding site', 'net impact'],
		related: ['ewr-shortfall', 'ewr-charge-split', 'reach-shortfall'],
		source: 'docs/model.md §2.7b; docs/engine-audit.md Q17'
	},
	'ewr-charge-split': {
		long: 'For a hydrological unit charged A on a day, c = supplied − return flow is its consumptive irrigation and o = e − c the rest of its impact (storage gain and net export). The irrigation part is A × c ÷ (c + max(o, 0)); the rest is “store less / pass inflow”. A hydrological unit with no irrigation therefore gets no irrigation cut: its charge is a storage or release condition.\n\nThe supply cut that removes the irrigation part is irrigation part ÷ (1 − β(1 − e)), with e the irrigation efficiency and β the loss return fraction: cutting supply by ΔG removes ΔG × (1 − β(1 − e)) of consumptive use, since the returned losses come back to the river.',
		aliases: ['supply cut', 'pass inflow', 'store less'],
		related: ['ewr-charge', 'irrigation-efficiency'],
		source: 'docs/model.md §2.7b and §2.11; docs/engine-audit.md Q13, Q17'
	},
	'equitable-share': {
		long: 'Over the reporting window, the catchment supplied this share of the total demand. A hydrological unit’s equitable share volume is that same share of its own demand, and “above (−) / below (+) equitable share” is that volume minus what it was supplied. The differences cancel across the hydrological units.\n\nIt is a fairness benchmark only: it assumes water can move freely between hydrological units, and ignores where a hydrological unit sits in the network, its storage, licensed or registered volumes and existing lawful use. A positive value is not water the hydrological unit can get: a surplus downstream can’t reach a hydrological unit upstream. Not an allocation or licence condition.\n\nUnder the National Water Act, sharing in a shortage runs through authorisations (s43 compulsory licensing; Schedule 3 item 6 restrictions, which DWS gazettes as % limits on authorised use per sector). A network-aware allocation based on licensed or registered volumes is future work; model demand is not an entitlement, and raising crop factors or areas raises a hydrological unit’s benchmark.',
		aliases: ['equitable supply fraction', 'target volume', 'fair share', 'reduce / gain'],
		related: ['demand-left', 'ewr-charge', 'report-window'],
		source: 'b023 Shortfalls columns K total, M, N; docs/model.md §2.11; docs/engine-audit.md Q11'
	},
	'demand-left': {
		long: 'Volume left ÷ demand, where the volume left is the equitable share minus the EWR supply cut, and never below 0. Shown as a whole %: “no demand” for a hydrological unit without demand, “—” when demand is under 1 m³/day (a % of almost nothing isn’t meaningful), and “<1%” or “>99%” at the ends so neither rounds to 0 or 100. The summary CSV keeps the exact value and a demand_pct_note column.\n\nWhen the EWR supply cut is larger than the hydrological unit’s equitable share, the volume left is 0 and the table flags “EWR cut exceeds this hydrological unit’s equitable share”. The workbook labels this column “reduction of demand required”, but it is the share left.',
		aliases: ['volume left', 'reduction of demand required', 'demand_pct_note'],
		related: ['ewr-charge-split', 'report-window'],
		source: 'b023 Shortfalls columns U, V; docs/model.md §2.11; docs/engine-audit.md Q12, Q13'
	},
	'reach-shortfall': {
		long: 'MIN(AA − Σ AA of the elements directly upstream, 0), as the b023 Element sheets compute it. It shows where along the river the flow falls below the accumulated EWR, but it does not add up to the outlet shortfall, never credits a hydrological unit that adds water, and can charge a hydrological unit for a reach the next hydrological unit makes good. From engine 0.17.0 it no longer drives curtailment: the EWR charge does.',
		aliases: ['incremental shortfall', 'AB'],
		related: ['ewr-charge'],
		source: 'b023 Element sheets column AB; docs/model.md §3 Q17'
	},
	'ewr-days-not-met': {
		long: 'The headline measure of how often the river fails. Look at when the failures happen, too: a few summer weeks every year differ from a multi-year drought.\n\nFor a hydrological unit it counts the days the hydrological unit was charged for a shortfall at an EWR site below it (engine 0.17.0; before, the days its reach shortfall was below 0).',
		related: ['ewr-shortfall'],
		source: 'b023 EWR analysis'
	},
	'reserve-rules': {
		long: 'A South African Reserve determination (the Desktop Reserve Model and its revised form) gives the ecological water requirement as a table: for each month, the flow required at each assurance level, or “% point” (10 %, 20 % … 90 %, 99 %). Assurance is the share of time the flow should be equalled or exceeded, so 10 % is the requirement in wet conditions and 99 % the drought flow. The gazette pairs it with the natural flow at the same points.\n\nEnter one table per EWR site: the outlet, or a gauge placed at the determination’s EWR site. Say where it comes from, the hydrological unit (Mm³ per month, or the month’s mean m³/s), whether it is the total flow or low flows only, and where the natural-flow percentile comes from: the run’s own natural flow at the site (ranked among the same month in every year of the run), or the table’s natural flows. The scale multiplies every value, for a table given for a larger or smaller catchment than the site.\n\nPaste the 12 month rows from a spreadsheet or a PDF, with the heading row of % points if you have it; month names in the first column put rows in order. The table adds a monthly compliance report. The pragmatic EWR drives the daily EWR charge and curtailment unless the Settings choice “EWR charge follows” is set to the rule tables.',
		aliases: ['assurance rules', 'assurance table', 'rule curve', 'Reserve rule table', 'Reserve determination', 'maintenance low flows', 'drought flows'],
		related: ['reserve-compliance', 'ewr', 'desktop-reserve-model', 'ewr-days-not-met'],
		source: 'Hughes & Hannart (2003); Hughes et al. (2014); Pollard et al. (2011) WRC K8/881/2; docs/model.md §2.9c'
	},
	'reserve-compliance': {
		long: 'For each complete calendar month, the month’s natural flow at the EWR site (the upstream hydrological units’ runoff, before any dam or abstraction) is placed on that month’s natural flow duration curve. The EWR is read from the rule table at the same % point, interpolated between points, and the month is met when the simulated flow at the site is at least that. A naturally dry month is held to the drought flow; a wet one to more. The requirement depends only on natural flow, so more abstraction can only lose months.\n\nThe report gives the share of months met (the headline), per month of the year, the deficit volume, the longest run of consecutive months not met and the FDC check: whether the simulated flow duration curve of each month lies on or above the EWR curve at each % point. Days below the pragmatic EWR stay alongside as a second measure. With fewer than 10 years of a month the percentiles are coarse, and the run says so. The daily series ewr_rule is each month’s requirement per day.',
		aliases: ['Reserve compliance', 'assurance compliance', 'months met', 'contiguity', 'FDC check'],
		related: ['reserve-rules', 'ewr-days-not-met', 'ewr-agreement', 'reserve-low-flows', 'reserve-high-flows'],
		source: 'Hughes & Münster (2000); Sawunyama & Hughes (2010); Pollard et al. (2011); Riddell et al. (2014); docs/model.md §2.9c'
	},
	'reserve-low-flows': {
		long: 'The Desktop Reserve Model gives two assurance tables for a site: the total flow (low flows plus high flows) and the low flows alone, each per month at the 10 % … 99 % points. The low flows fall from the maintenance low flow at the wetter points to the drought low flow at 99 %.\n\nEnter the low-flow table beside a total-flow table and each month is judged twice at the same natural percentile: against the total and against the low flows. A month that meets its low flows but not the total failed only its high flows (the heat map shows ◐); one below its low flows (●) is the more serious failure. The difference between the two requirements is the month’s high-flow part. Pending the hydrologist: both are judged on the month’s total flow volume, unless the Settings choice “Low flows judged on” is set to base flow.',
		aliases: ['maintenance low flow', 'drought low flow', 'low-flow table', 'low flows', 'base flow requirement'],
		related: ['reserve-rules', 'reserve-compliance', 'reserve-high-flows', 'desktop-reserve-model'],
		source: 'Hughes & Hannart (2003); Hughes et al. (2014); docs/model.md §2.9d'
	},
	'reserve-high-flows': {
		long: 'Reserve determinations ask for high flows as well as low flows: small freshets that reset the riverbed and cue fish to spawn, and larger floods that scour pools and reach the floodplain. Each component here is a name, the months it may peak in, a peak (m³/s, daily mean), the event’s duration in days from the rise to the end of the recession (not days held at the peak), and how many such events a water year needs.\n\nThe check runs on every complete water year at the site. An event is a run of days at or above half the peak that reaches the peak, first in one of the months, and lasts at least half the duration: what a flood hydrograph of that peak and duration, drawn as a triangle, spends above half its peak. Two peaks count as two events only if the flow falls below half the peak between them. A year is asked for no more events than the site’s natural flow had that year: a dry year that would have had no flood is not failed for it, while a dam that holds back a flood the river would have had is. The table’s scale multiplies the peak too.',
		aliases: ['freshet', 'flood', 'high flow', 'flood pulse', 'maintenance high flows'],
		related: ['reserve-rules', 'reserve-compliance', 'reserve-low-flows'],
		source: 'Hughes & Hannart (2003); Pollard et al. (2011); docs/model.md §2.9d'
	},
	'ewr-charge-source': {
		long: 'The EWR charge (each hydrological unit’s share of the shortfall at the EWR sites below it) and the curtailment it sets follow a daily requirement at each site. By default that is the pragmatic EWR, as in the b023 workbook. Set it to the Reserve rule tables and, at a site with a rule table, each complete calendar month’s requirement from the table (the one the monthly compliance report judges, the daily series ewr_rule) becomes the daily requirement for that month’s days. A site without a table, and a part month at either end of the run, keep the pragmatic EWR, and the run says how many days that was.\n\nThe EWR required and met at each site (under the EWR by month grid on River & reserve) follow the same choice. The shortfall the charge followed at such a site is the daily series ewr_charge_shortfall; the pragmatic EWR, its days not met and the observed-record agreement stay as they are. Which the charge should follow is a question for the hydrologist and the assessor, so the pragmatic EWR stays the default.',
		aliases: ['charge from the rule table', 'EWR charge basis', 'rule-table charge', 'ewrChargeSource'],
		related: ['ewr-charge', 'reserve-rules', 'reserve-compliance', 'water-account'],
		source: 'Pending the hydrologist (plan.md question 17); docs/model.md §2.9c'
	},
	'low-flow-measure': {
		long: 'A low-flow requirement (a table that covers low flows only, or the low-flow part of a total-flow table) is judged against one figure for the month. By default that is the month’s total flow volume, so a month with a flood can pass its low flows even though the river ran short the rest of the month.\n\nSet it to base flow and the month is judged on its base flow instead: the simulated flow at the site with the quick flow taken out by the Lyne–Hollick digital filter (three passes, α = 0.995, the value found for daily flows in most South African catchments). The total-flow requirement is still judged on the month’s total flow, and the natural-flow percentile still comes from the natural flow. Which measure a Reserve monitoring report uses is a question for the hydrologist, so the total flow stays the default.',
		aliases: ['base flow', 'baseflow filter', 'Lyne–Hollick', 'digital filter', 'lowFlowMeasure'],
		related: ['reserve-low-flows', 'reserve-compliance', 'reserve-rules'],
		source: 'Lyne & Hollick (1979); Nathan & McMahon (1990); Smakhtin & Watkins (1997) WRC 494/1/97; Hughes et al. (2003) Water SA 29(1); docs/model.md §2.9d'
	},
	'plausibility-checks': {
		long: 'Every run makes five checks and shows them in the Plausibility checks panel on Runs & results, in its warnings and in the summary CSV:\n\n1. natural flow is at least the observed flow plus the modelled net abstraction, in every water year;\n2. EWR days not met, split between good-rain years (rain mostly from the catchment station) and fallback-rain years (mostly CHIRPS, forecast, spread or blank days);\n3. the double-mass curve of observed flow against rain, to tell new use upstream from a failing gauge;\n4. dry-season low-flow duration curves of the gauge, the logger and the model, overlaid with the latest run of each other runoff model;\n5. recession diagnostics: how fast the record and the model fall in rain-free spells (runs from engine 1.19.0).\n\nThe dry season is the six calendar months in a row with the lowest mean flow: from the calibration record, else the other observed record, else the simulated natural flow. The thresholds are fixed in the engine, for the hydrologist to confirm.',
		aliases: ['sanity checks', 'hydrologist checks', 'dry season', 'plausibility'],
		related: ['plausibility-naturalised', 'plausibility-rain-source', 'plausibility-flow-double-mass', 'plausibility-low-flow', 'plausibility-recession'],
		source: 'Not in the workbook; issue #4 phase 6 review; docs/model.md §2.10d'
	},
	'plausibility-naturalised': {
		long: 'On each water year of the calibration record (300 or more observed days, calibration exclusions left out), the observed volume O plus the modelled net abstraction A rebuilds the natural flow the record implies. A is natural flow less the simulated outflow, from the network’s own water balance, split into use net of return flows (irrigation, other users, boreholes), dams (storage gained plus evaporation less rain on the dam) and land cover.\n\nA year fails when O + A exceeds the simulated natural flow by more than 10 % of the observed volume, the annual error of a well-rated gauging weir (at least 1 % of the record’s mean volume, so a near-dry year doesn’t fail on noise). Since A is natural less simulated outflow, that is the same as the simulated outflow falling short of the observed by that much. A failing year points to natural flow simulated too low (rain, parameters), abstraction over-estimated, or a problem in the record that year.',
		aliases: ['naturalised flow', 'naturalisation check', 'observed plus abstraction'],
		related: ['plausibility-checks'],
		source: 'Not in the workbook; Wessels & Rooseboom (2009); McMillan, Krueger & Freer (2012); docs/model.md §2.10d'
	},
	'plausibility-rain-source': {
		long: 'A day’s rain is a station reading when the catchment rain series has a value the run used as recorded. It is fallback rain when bias-corrected CHIRPS or forecast rain filled it (a blank day, a zero run treated as missing, a listed missing period), when a multi-day accumulation was spread onto it, or when nothing filled it and it ran dry.\n\nA water year is a fallback-rain year when more than half its rain, or more than half its days, were fallback; every other year is a good-rain year. The panel gives the share of days the outlet EWR was not met in each group and, with a Reserve rule table, the share of months met. The run warns when the groups differ by 10 percentage points or more: part of the EWR result may then come from the rain source rather than the river. It can also be real climate, such as a station out of action through a drought.',
		aliases: ['fallback years', 'CHIRPS years', 'rain source', 'infilled rainfall years'],
		related: ['plausibility-checks', 'zero-rain-runs', 'rain-accumulations', 'chirps-bias', 'reserve-compliance'],
		source: 'Not in the workbook; docs/model.md §2.10d'
	},
	'plausibility-flow-double-mass': {
		long: 'While the catchment, its development and the gauge stay the same, cumulative observed flow plotted against cumulative catchment rain is a straight line; its slope is the runoff ratio. The check uses the calibration record’s water years with 300 or more days having both flow and rain and at least 100 mm of rain (10 such years or no result), and finds breaks as the rain-vs-CHIRPS double-mass check does.\n\nThe runoff ratio falls in a run of dry years on its own, so each break is compared with the simulated outflow over the same days, which has the same rain and fixed development. A change the model shows too is the rain’s. A fall the dry season takes more of points to new use upstream (abstraction and filling dams take a larger share of low flows); a fall the wet season takes more of, or a rise, points to the gauge (a rating change, or floods bypassing or drowning the weir). It is a hint: check the gauge’s records and the development history.',
		aliases: ['double mass curve flow', 'runoff ratio break', 'gauge failure', 'new upstream use', 'homogeneity of flow'],
		related: ['plausibility-checks', 'double-mass'],
		source: 'Not in the workbook; Searcy & Hardison 1960; docs/model.md §2.10d'
	},
	'plausibility-low-flow': {
		long: 'Each curve gives the flow equalled or exceeded on a share of the dry-season days (Q90: 90 % of them). The gauge and the logger are drawn dashed, each on its own days; the simulated outflow and natural flow cover every dry-season day of the run, and the latest run of each other runoff model is drawn beside them when it used the same dry season. "Simulated outflow over" switches the model’s curve to one record’s days only, for a like-for-like comparison.\n\nThe run warns when, on the calibration record’s dry-season days, the simulated Q90 is more than twice or less than half the observed. Low flows are where a gauge is least certain (±50–100 %), so a factor of 2 is beyond gauging error. Flows under 0.001 m³/s count as 0.001.',
		aliases: ['low flow FDC', 'dry season FDC', 'Q90', 'Q95', 'low-flow duration'],
		related: ['plausibility-checks', 'plausibility-recession'],
		source: 'Not in the workbook; McMillan, Krueger & Freer (2012); calibration-research.md CR-16; docs/model.md §2.10d'
	},
	'plausibility-recession': {
		long: 'After rain stops, a river falls at a pace set by how its catchment drains. The check picks those spells out of the calibration record: flow falling day after day for at least 5 days, with at most 1 mm of catchment rain on each day and the day before, starting the second day after the peak, and no missing, zero or excluded day. On each day it takes the rate of fall, −dQ/dt, and plots it against the flow Q on log–log axes, for the record and for the simulated outflow on the very same days, and fits a straight line to each: −dQ/dt = a·Q^b. b = 1 is a single linear store (an exponential recession); a larger b a store that drains faster when full.\n\nThe run warns, as an indicative check, when the model recedes more than twice as fast or slow as the river at the observed points’ median flow, or when b differs by more than 0.5, which points to the routing and groundwater parameters (GR4J X2 and X3) or to abstraction in dry spells. With fewer than 8 spells the fit is too thin to judge, and the run says so instead. The segment rules and the rate estimate (exponential time stepping) follow the TOSSH toolbox’s defaults.',
		aliases: ['recession analysis', 'recession curve', '-dQ/dt', 'dQ/dt vs Q', 'Brutsaert Nieber', 'recession constant', 'baseflow recession'],
		related: ['plausibility-checks', 'plausibility-low-flow'],
		source: 'Not in the workbook; Brutsaert & Nieber (1977); Tallaksen (1995); Stoelzle et al. (2013); Roques et al. (2017); Gnann et al. (2021, TOSSH); calibration-research.md CR-13; docs/model.md §2.10d'
	},
	'ewr-agreement': {
		long: 'A gauge or logger measures the same river the outlet EWR test uses, so on each observed day the observed flow takes the test too. Hit rate: share of the river’s failures the model also has (1 ideal). False-alarm ratio: share of the model’s failures the river didn’t have (0 ideal). Frequency bias: the model’s share of days below the EWR ÷ the observed share (1 ideal). Use it to judge which runoff model’s EWR count to trust.',
		aliases: ['EWR agreement', 'frequency bias', 'hit rate', 'false-alarm ratio', 'contingency table'],
		related: ['ewr-days-not-met'],
		source: 'docs/model.md §2.9b'
	},
	'desktop-reserve-model': {
		long: 'Its tables — with and without high flows, in M.m³ per month at the 10 %–99 % points — are the usual starting point for the pragmatic EWR.',
		aliases: ['Desktop Version 2', 'DRM', 'Reserve tables'],
		related: ['pragmatic-ewr', 'ecological-category'],
		source: 'b023 EWR Cfg',
		countries: ['ZA']
	},
	'ecological-category': {
		long: 'The higher the target category, the more flow the Reserve keeps in the river.',
		aliases: ['EC', 'present ecological state', 'category B'],
		related: ['ewr'],
		source: 'docs/model.md §7'
	},

	// ---- Run results ------------------------------------------------------------
	'fraction-supplied': {
		long: 'A quick reliability measure per hydrological unit. It averages over wet and dry years; check the daily deficit to see when the shortfalls happen.',
		aliases: ['assurance', '% supplied'],
		related: ['irrigation-supplied', 'irrigation-deficit'],
		source: 'b023 Shortfalls sheet'
	},

	// ---- Goodness of fit ---------------------------------------------------------
	'nse': {
		long: 'Squared errors make NSE dominated by flood peaks, so a good NSE can hide poor low flows. Look at it alongside PBIAS and the hydrograph.',
		aliases: ['Nash-Sutcliffe', 'efficiency'],
		related: ['pbias', 'rmse', 'kge', 'calibration'],
		source: 'docs/model.md §7'
	},
	'pbias': {
		long: 'Measures volume error regardless of timing — the fit that matters most for allocation questions.',
		aliases: ['bias', 'volume error'],
		related: ['nse'],
		source: 'docs/model.md §7'
	},
	'rmse': {
		long: 'Has the units of flow, so compare it with the mean observed flow to judge its size.',
		aliases: ['root mean square error'],
		related: ['nse'],
		source: 'docs/model.md §7'
	},
	'kge': {
		long: 'Often preferred to NSE because it separates timing, volume and variability errors.',
		aliases: ['Kling-Gupta'],
		related: ['nse'],
		source: 'docs/model.md §7'
	},
	'r-squared': {
		long: 'R² is the square of the correlation between simulated and observed flow. A high R² with a poor NSE usually means the timing is right but the volumes are off — check PBIAS.',
		aliases: ['R2', 'correlation'],
		related: ['nse', 'pbias'],
		source: 'docs/model.md §2.10'
	},
	'log-nse': {
		long: 'Ordinary NSE is dominated by a few big floods. For irrigation and EWR questions the dry-season low flows matter most; log-NSE weights them evenly. A small constant (1 % of mean observed flow) is added before taking logs so zero flows are allowed.',
		aliases: ['logNSE', 'low flow'],
		related: ['nse'],
		source: 'docs/model.md §2.10'
	},
	'volume-error': {
		long: 'The same information as PBIAS with the opposite sign: +10 % means the simulation is 10 % too wet. The annual volume table shows it per water year, which reveals whether an error comes from a few years or is systematic.',
		aliases: ['volume bias', 'water balance error'],
		related: ['pbias'],
		source: 'docs/model.md §2.10'
	},
	'in-sample': {
		long: 'Scores on the days a model was fitted on show how well it fits, not how well it predicts: judge fitted parameters by the fit’s validation scores. A run’s calibration scores are labelled in-sample only when its parameters came from Fit automatically for its runoff model, unchanged since, with the same calibration window, exclusions and flow record (engine 0.39.0).\n\nOtherwise the label says why not: “parameters not fitted” (set by hand, imported or left at their defaults), “parameters edited since the fit”, or “not the period fitted” (another window, other exclusions or the other record). Parameters tuned by hand against the record flatter the model as much as a fit does, so read hand-calibrated scores the same way. A run made before engine 0.39.0 says only “calibration period”.',
		aliases: ['in sample', 'calibration period', 'parameters not fitted', 'out-of-sample'],
		related: ['calibration', 'nse', 'pbias'],
		source: 'docs/model.md §2.10; docs/calibration-research.md'
	}
};
