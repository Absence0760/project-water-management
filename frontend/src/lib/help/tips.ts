// The help tips: each glossary entry's term, one-sentence short text, units
// and the field keys that place a <HelpTip> next to a form field or column.
// The rest of each entry (the fuller text, other names, related entries and
// the source) is in articles.ts under the same id; content.ts joins the two
// for the glossary and search. The farm view's words are in farmer.ts.
//
// Split so a HelpTip loads only this (~22 KB gzip, 2026-10-08) and not the glossary's
// long text (~110 KB in six modules): lib/help/content.test.ts keeps HelpTip.svelte off
// content.ts and articles.ts, and keeps this file free of run-time imports.
// Adding an entry: add it here and in articles.ts (the tests fail until
// both have it); the order here is the glossary's order within a topic.
//
// Written for hydrologists, in our own words, following docs/model.md.
// `source` (articles.ts) names where each idea comes from so a maintainer can
// check it (the glossary doesn't show it).
//
// `fields` are the keys a form uses to place a HelpTip next to a field:
//   node.<NetworkNode field>        settings.<ProjectSettings field>
//   calibration.<CalibrationParams field>
//   crop.<CropDef field>            cropArea.<CropArea field>
//   transfer.<Transfer field>       series.<SeriesKind>
//   demandObject.<DemandObject field>
//   summary.<FarmSummary field>     catchment.<RunSummary.catchment field>
//   stats.<CalibrationStats field>  run.<run series key>
//   preview.<column>                the Data tab's daily preview (series/preview.ts):
//                                   date, flowM3Day, rainUsed, chirpsFactor,
//                                   chirpsCorrected, excluded. Its raw series
//                                   columns use series.<SeriesKind>.
// A key belongs to exactly one entry (guarded by content.test.ts).

import type { HelpTipText } from './types';

export const TIPS: HelpTipText[] = [
	// ---- Basics -------------------------------------------------------------
	{
		id: 'water-balance',
		term: 'Water balance',
		short: 'A day-by-day account of where the catchment’s water goes: runoff, dams, irrigation, transfers and what reaches the outlet.',
		category: 'basics'
	},
	{
		id: 'project',
		term: 'Project (catchment)',
		short: 'One catchment model: its network, crops, settings, input series and runs. One b023 workbook becomes one project.',
		category: 'basics'
	},
	{
		id: 'run',
		term: 'Run',
		short: 'One execution of the model on the project as it was at that moment. Results are kept, with a snapshot of the inputs used.',
		category: 'basics'
	},
	{
		id: 'evidence-run',
		term: 'Evidence run (nomination)',
		short: 'The one run a project stands behind, nominated by an editor with a reason. Nominations are never edited or removed.',
		category: 'basics'
	},
	{
		id: 'roles',
		term: 'Roles: owner, editor, viewer',
		short: 'Viewers read everything; editors also change the model, upload data and run it; owners also manage members.',
		category: 'basics'
	},
	{
		id: 'team',
		term: 'Team',
		short: 'A group that owns catchments together: each member has the same role on every team project as they hold in the team.',
		category: 'basics'
	},
	{
		id: 'invitation',
		term: 'Invitation',
		short: 'Adding someone by email sends an invitation: they join, with the role named, only once they accept it. It lapses after 7 days.',
		category: 'basics'
	},
	{
		id: 'farmer-link',
		term: 'Farmer and their linked units',
		short: 'A farmer reads only the hydrological units an owner links to them, from the published run: never another unit, nor the model.',
		category: 'basics'
	},
	{
		id: 'applying-party',
		term: 'Applying party and specialist',
		short: 'Applicants in one applying party share their licence applications; the party’s specialist signs their evidence packs.',
		category: 'basics'
	},
	{
		id: 'registration-check',
		term: 'Registration check',
		short: 'A record that someone looked a specialist signer up on the public professional register. The app itself checks nothing.',
		category: 'basics'
	},
	{
		id: 'licence-record',
		term: 'Licence record (how long names are kept)',
		short: 'Issued evidence packs and signed-off runs keep their signers’ names until three years after the licence ends or is refused.',
		category: 'basics'
	},
	{
		id: 'share-link',
		term: 'Share link',
		short: 'A read-only link for someone outside the project, opened without signing in, to the published baseline, an application or a pack.',
		category: 'basics'
	},
	{
		id: 'project-copy',
		term: 'Copy of a project',
		short: 'A new, separate project with the model, settings and input series of another. Runs, notes and members are not copied.',
		category: 'basics'
	},
	{
		id: 'project-file',
		term: 'Project file (JSON)',
		short: 'The whole project in one JSON file: model, settings and input series, without runs. Importing it makes a new project.',
		category: 'basics'
	},
	{
		id: 'project-time-zone',
		term: 'Project time zone',
		short: 'The time zone the project’s downloads, alerts and farm pages count days in. Africa/Johannesburg unless changed.',
		category: 'basics'
	},
	{
		id: 'import-record',
		term: 'Import record',
		short: 'What the importer noted, and what it couldn’t map, when the project was imported from a file, kept as it was shown then.',
		category: 'basics'
	},
	{
		id: 'change-history',
		term: 'Change history and restoring',
		short: 'Every saved change to the model, settings, data, members and publications, with who, when and why. Restoring adds a new change.',
		category: 'basics'
	},
	{
		id: 'notes',
		term: 'Notes',
		short: 'Plain-text notes kept on a hydrological unit, a run, a settings group or the project, read by the project team.',
		category: 'basics'
	},
	{
		id: 'api-key',
		term: 'API key',
		short: 'A secret a logger gateway or a script uses to push daily readings into this project’s series without signing in. It writes series only.',
		category: 'basics'
	},
	{
		id: 'alert-rules',
		term: 'Alert rules',
		short: 'Which alert emails a catchment sends, and at what level. Nothing is sent until an editor switches a kind on.',
		category: 'basics'
	},
	{
		id: 'ewr-traffic-light',
		term: 'EWR status (traffic light)',
		short: 'Green, amber or red by the share of the last 30 days the outlet’s EWR was not met: by default green under 5 %, amber under 20 %.',
		category: 'basics'
	},
	{
		id: 'needs-attention',
		term: 'Needs attention',
		short: 'The catchments in view to look at first, most urgent first: a red EWR, units short, alerts firing, failing feeds or old figures.',
		category: 'basics'
	},
	{
		id: 'privacy-contact',
		term: 'Privacy contact',
		short: 'Whom people ask about the personal information in a team’s projects. Team owners set it; members and farmers can read it.',
		category: 'basics'
	},
	{
		id: 'published-baseline',
		term: 'Published baseline',
		short: 'The run an editor publishes for the people outside the model: farmers read their figures from it, and licence applications start from it.',
		category: 'licensing'
	},
	{
		id: 'scenario',
		term: 'Scenario',
		short: 'A named list of changes to a run (a bigger dam, a new crop, less rain) that runs and compares against that run without copying the project.',
		category: 'licensing'
	},
	// ---- Scenario changes, their classes and cumulative impact (scenarios, Assess together)
	{
		id: 'base-run',
		term: 'Base run',
		short: 'The saved run a scenario starts from: its changes apply to that run’s stored inputs, never to the live model.',
		category: 'licensing'
	},
	{
		id: 'scenario-change',
		term: 'Scenario change (override)',
		short: 'One edit in a scenario’s list: set a field, add or remove an element, scale rain or demand. Each applies to what the ones before it left.',
		category: 'licensing'
	},
	{
		id: 'change-class',
		term: 'Proposal or baseline assumption',
		short: 'Each change is a Proposal (the change being assessed) or a Baseline assumption (it changes what the river is taken to be today).',
		category: 'licensing'
	},
	{
		id: 'override-mode',
		term: 'Edit in the model tables (override mode)',
		short: 'Edit a scenario in the Network, Crops and Transfers tables; Record turns your edits into scenario changes. The live model is untouched.',
		category: 'licensing'
	},
	{
		id: 'scale-demand',
		term: 'Scale demand',
		short: 'A change that multiplies irrigation or other users’ demand (0–200 %) for chosen units and months. Crop areas stay as they are.',
		units: '% of what they’d take',
		category: 'licensing'
	},
	{
		id: 'scale-series',
		term: 'Scale rainfall or daily A-pan',
		short: 'A change that multiplies one rain series or the daily A-pan series by a % change, over the whole record or between two dates.',
		units: '%',
		category: 'licensing'
	},
	{
		id: 'cumulative-assessment',
		term: 'Assess together (cumulative impact)',
		short: 'Several applications on one baseline, each alone and all together, so their combined effect on the river and existing users shows.',
		category: 'licensing'
	},
	{
		id: 'cumulative-interaction',
		term: 'Interaction (cumulative impact)',
		short: 'The change with every application together, less the changes each makes alone added up. Zero means their effects simply add.',
		category: 'licensing'
	},
	{
		id: 'application',
		term: 'Licence application',
		short: 'A licence applicant’s proposed change (a new dam, more abstraction), modelled on the published baseline for the assessors to decide.',
		category: 'licensing'
	},
	{
		id: 'evidence-pack',
		term: 'Evidence pack',
		short: 'An application’s evidence report frozen as a signed, versioned document with a short code anyone can check against the app.',
		category: 'licensing'
	},
	// ---- Evidence, packs and registered volumes (evidence reports, packs, sign-off, allocations)
	{
		id: 'evidence-report',
		term: 'Evidence report',
		short: 'The licensing report of one run: the nominated baseline alone, or an application against it. A draft until it is issued as a pack.',
		category: 'licensing'
	},
	{
		id: 'pack-issue-checks',
		term: 'Checks that stop issue',
		short: 'What an evidence report must pass before it can become a pack and be issued. A failing check names its units and the way out.',
		category: 'licensing'
	},
	{
		id: 'pack-lifecycle',
		term: 'Evidence pack lifecycle',
		short: 'Draft, signed, issued, then superseded by a new version or withdrawn with a public reason. An issued pack is never edited or deleted.',
		category: 'licensing'
	},
	{
		id: 'manifest-hash',
		term: 'Manifest and manifest SHA-256',
		short: 'The pack’s frozen content and its fingerprint: any change to the evidence changes the hash; its status and sign-offs don’t.',
		category: 'licensing'
	},
	{
		id: 'pack-short-code',
		term: 'Short code and verify page',
		short: 'The first 12 digits of the manifest hash. Anyone can enter it on the public verify page to see if the pack still stands.',
		category: 'licensing'
	},
	{
		id: 'pack-pdf',
		term: 'Evidence pack PDF',
		short: 'The issued pack printed once by the server and stored under its own SHA-256, which the verify page shows.',
		category: 'licensing'
	},
	{
		id: 'reproduction-bundle',
		term: 'Reproduction bundle',
		short: 'A ZIP of both runs’ inputs, results and the manifest, built at issue, that anyone can re-run offline to get the same results.',
		category: 'licensing'
	},
	{
		id: 'errata-since',
		term: 'Errata found since',
		short: 'Known engine bugs recorded after a pack was drafted or issued that apply to its runs. Listed apart; never added to the pack.',
		category: 'licensing'
	},
	{
		id: 'signoff-statement',
		term: 'Professional sign-off',
		short: 'A registered professional’s permanent statement about one run or pack: ten confirmations, bound by a hash to the exact words shown.',
		category: 'licensing'
	},
	{
		id: 'pack-signoff',
		term: 'Signing an evidence pack',
		short: 'The applicant’s specialist signs the draft (an assessor may add a review); issue then waits for a current registration check.',
		category: 'licensing'
	},
	{
		id: 'report-disclaimer',
		term: 'Report disclaimer',
		short: 'Model estimates, not an authorisation to use water, and the operator accepts no responsibility: printed on every report and export.',
		category: 'licensing'
	},
	{
		id: 'responsible-authority',
		term: 'Responsible authority and endorsement',
		short: 'Who decides the licence (DWS or a CMA), and whether a member acting for it endorsed the published baseline. The report says both.',
		category: 'licensing'
	},
	{
		id: 'full-authorised-use',
		term: 'Impact against full authorised use',
		short: 'The application judged with every holder taking their full registered volume, beside the impact against today’s modelled use.',
		category: 'licensing'
	},
	{
		id: 'licence-impact-year-class',
		term: 'Impact by year class',
		short: 'The change in dry, middle and wet years: an annual waterfall at the outlet and the months below the Reserve, baseline vs application.',
		category: 'licensing'
	},
	{
		id: 'pack-share-link',
		term: 'Share link to an evidence pack',
		short: 'A read-only link for people without an account: the pack’s standing and river figures, never a farm, a name or the full report.',
		category: 'licensing'
	},
	{
		id: 'send-to-authority',
		term: 'Send to the authority',
		short: 'Emails the members acting for the responsible authority a link to the issued pack. The email carries no file and no download link.',
		category: 'licensing'
	},
	{
		id: 'applicant-copy',
		term: 'Applicant’s printable copy',
		short: 'A PDF of the applicant’s own view of an issued pack, other users’ figures withheld. Not the pack: it has its own hash.',
		category: 'licensing'
	},
	{
		id: 'restriction-notice',
		term: 'Restriction notice',
		short: 'The WUA’s own notice (level, cut and words), published with the baseline for farmers. The app never writes restriction wording.',
		category: 'licensing'
	},
	{
		id: 'registered-volume',
		term: 'Registered volume (allocation)',
		short: 'One volume a year from one water source under one authorisation, for a hydrological unit or other water user. Not an entitlement.',
		units: 'm³ a year',
		category: 'licensing'
	},
	{
		id: 'authorisation-type',
		term: 'Authorisation',
		short: 'How a volume is held: a WARMS registration, a licence, a general authorisation, Schedule 1, or existing lawful use, claimed or verified.',
		category: 'licensing'
	},
	{
		id: 's21-water-use',
		term: 'Water use: taking (s21a) or storing (s21b)',
		short: 'A take is a volume a year; a dam’s storage is a row of its own, compared only with the dam’s capacity, never counted as a take.',
		category: 'licensing'
	},
	{
		id: 'licence-conditions',
		term: 'Licence conditions',
		short: 'Months of use, a maximum rate and conditions in words. Only a cap run keeps to the months and the rate; the words are only shown.',
		units: 'm³/s',
		category: 'licensing'
	},
	{
		id: 'warms-import',
		term: 'Importing registered volumes (WARMS)',
		short: 'A CSV of a WARMS extract or the template, matched to units by registration number, property or name. Removable as one import.',
		category: 'licensing'
	},
	{
		id: 'registered-vs-modelled',
		term: 'Modelled use vs registered volume',
		short: 'Each unit’s modelled use per water year beside its registered volume: above, within or below the band. Modelled, not metered.',
		units: 'm³ a water year',
		category: 'licensing'
	},
	{
		id: 'registered-storage',
		term: 'Registered storage vs dam capacity',
		short: 'A unit’s registered dam storage (s21b) beside the capacity the run modelled: over, under or unregistered. Arithmetic only.',
		units: 'm³',
		category: 'licensing'
	},
	{
		id: 'cap-held-back',
		term: 'What the cap held back',
		short: 'In a cap run, the days a unit went short because its year’s volume was used up, it hit the maximum rate, or the month was closed.',
		units: 'days',
		category: 'licensing'
	},
	{
		id: 'allocation-viewer-access',
		term: 'Who sees registered volumes',
		short: 'Owners and editors see every volume and name; viewers only totals held by 5 or more users, unless an owner allows more. Names never.',
		category: 'licensing'
	},
	{
		id: 'water-year',
		term: 'Water year',
		short: 'October to September, the South African hydrological year. Monthly tables in this app run Oct … Sep.',
		category: 'basics'
	},
	{
		id: 'units',
		term: 'Units: m³/day, m³/s, M.m³',
		short: 'Flows and volumes are m³/day inside the model. 1 m³/s = 86 400 m³/day; 1 M.m³ = one million m³.',
		units: 'm³/day, m³/s, m³, M.m³',
		category: 'basics'
	},
	{
		id: 'february-days',
		term: 'Days in February',
		short: 'Days used for February when a monthly volume is turned into a daily rate. 28.25 gives a 365.25-day year.',
		units: 'days',
		category: 'basics',
		fields: ['settings.februaryDays']
	},
	{
		id: 'simulation-window',
		term: 'Simulation window',
		short: 'Optional first and last day to simulate. Leave empty to run from the first to the last day with rain.',
		category: 'basics',
		fields: ['settings.simulationStart', 'settings.simulationEnd']
	},
	{
		id: 'calibration-window',
		term: 'Calibration window',
		short: 'The period, observed flow record and site (the outlet or an inner gauge) that score the fit. Empty = every day with an observation.',
		category: 'fit',
		fields: ['settings.calibrationStart', 'settings.calibrationEnd', 'settings.calibrationFlowKind', 'settings.calibrationSiteNodeId']
	},
	{
		id: 'gauge-logger-agreement',
		term: 'Gauge vs logger agreement',
		short: 'Flags water years where the observed gauge and the logger disagree by more than the set ratio, on enough shared days.',
		category: 'fit'
	},
	{
		id: 'data-quality-limits',
		term: 'Data quality limits',
		short: 'The checks Data and runs report: negative values, outliers, flat stretches, rain read as 0 that looks missing, breaks against CHIRPS.',
		category: 'fit',
		fields: ['settings.dataQuality']
	},
	{
		id: 'report-window',
		term: 'Reporting window',
		short: 'The period the curtailment report (equitable shares and EWR cuts per hydrological unit) averages over. Empty = the whole run.',
		category: 'basics',
		fields: ['settings.reportStart', 'settings.reportEnd']
	},

	{
		id: 'assurance-of-supply',
		term: 'Assurance of supply',
		short: 'How reliably each hydrological unit’s irrigation demand was met over the reporting window: by days, by volume and by water years.',
		units: '% ; days; m³',
		category: 'results',
		fields: ['settings.assuranceAnnualThreshold']
	},
	{
		id: 'allocation-mode',
		term: 'Allocation mode',
		short: 'What registered volumes do to a run. The baseline only compares use with them; a scenario may cap use at them or scale demand to them.',
		category: 'results',
		fields: ['settings.allocationMode']
	},
	{
		id: 'allocation-band',
		term: 'Allocation comparison band',
		short: 'How far modelled use may sit from a registered volume and still count as within it: ±10 % by default.',
		units: '%',
		category: 'results',
		fields: ['settings.allocationTolerance']
	},
	{
		id: 'stress-class',
		term: 'Stress class',
		short: 'A month’s supply as a class: Low (≥ 95 % of demand supplied), Moderate (≥ 85 %), High (≥ 70 %), Severe (≥ 50 %) or Critical.',
		category: 'results'
	},
	{
		id: 'water-account',
		term: 'Water account',
		short: 'Per water year: what entered the river network, where it went, what the dams kept, and a residual that should be 0.',
		units: 'm³',
		category: 'results'
	},

	// ---- Network ------------------------------------------------------------
	{
		id: 'network',
		term: 'Network',
		short: 'How the hydrological units connect: each drains into exactly one hydrological unit downstream, ending at the outflow gauge.',
		category: 'network',
		fields: ['node.downstreamNodeId']
	},
	{
		id: 'element-farm',
		term: 'Hydrological unit',
		short: 'Any point of the network: a unit with land (runoff, an optional dam, demands), a gauge or an other water user. Exports call it a node.',
		category: 'network',
		fields: ['node.kind', 'node.name']
	},
	{
		id: 'element-gauge',
		term: 'Gauge',
		short: 'A measuring point that only passes flow through and reports it, with its EWR check unless it isn’t an EWR site. No runoff, dam or demand.',
		category: 'network',
		fields: ['node.ewrSite']
	},
	{
		id: 'element-user',
		term: 'Other water user',
		short: 'A town, industry or unlisted irrigator that takes water from the river at its place in the network, with no land or dam of its own.',
		category: 'network',
		fields: ['node.userDemandM3Day', 'run.senior_requirement']
	},
	{
		id: 'user-priority',
		term: 'User priority (Priority / Non-priority)',
		short: 'Priority (the default): units and non-priority users upstream pass its demand first. Non-priority: it takes what reaches it after them.',
		category: 'network',
		fields: ['node.userPriority', 'run.passed_for_senior']
	},
	{
		id: 'user-return',
		term: 'Share returned (other user)',
		short: 'Share of what an other water user takes that comes back to the river below it the same day, such as treated wastewater.',
		units: '%',
		category: 'network',
		fields: ['node.userReturnPct']
	},
	{
		id: 'user-pump',
		term: 'Pump capacity (other user)',
		short: 'The most an other water user takes from the river in a day. Blank is no limit; a priority user’s claim upstream is capped to it too.',
		units: 'm³/day',
		category: 'network',
		fields: ['run.pump_limited']
	},
	{
		id: 'borehole',
		term: 'Boreholes (groundwater)',
		short: 'Groundwater a hydrological unit or other user pumps up to a daily capacity and annual cap, by mode: supplemental, primary or drought.',
		units: 'm³/day',
		category: 'network',
		fields: ['node.boreholeCapacityM3Day', 'node.boreholeRule', 'node.boreholeTriggerPct', 'run.groundwater_used', 'run.groundwater_to_dam', 'summary.avgGroundwaterM3Day', 'summary.avgGroundwaterToDamM3Day']
	},
	{
		id: 'ga538',
		term: 'GN 538 general authorisation (groundwater)',
		short: 'Groundwater a property may take unlicensed: its area × its quaternary’s Table 2 rate, at most 40 000 m³ in any 12 months.',
		units: 'm³/a',
		category: 'network',
		fields: ['node.gaPropertyAreaHa', 'node.gaRateM3HaYear']
	},
	{
		id: 'demand-object',
		term: 'Demand object',
		short: 'A demand on a hydrological unit that isn’t a crop (a town, households, livestock, water piped out), from its dam or its own river pump.',
		units: 'm³/day',
		category: 'network',
		fields: ['demandObject.category', 'demandObject.priority', 'demandObject.returnPct', 'summary.demandObjects']
	},
	{
		id: 'demand-schedule',
		term: 'Demand schedule',
		short: 'Windows that scale a demand object’s daily demand on chosen weekdays or dates (weekends off, a season, Easter); 0 switches it off.',
		category: 'network',
		fields: ['demandObject.schedule']
	},
	{
		id: 'basic-needs-floor',
		term: 'Basic-needs floor',
		short: 'The 25 litres a person a day a restriction never cuts a domestic or municipal demand object below: people served × 25 l.',
		units: 'm³/day',
		category: 'network',
		fields: ['demandObject.population']
	},
	{
		id: 'demand-source',
		term: 'Demand source',
		short: 'Where a demand object’s number comes from, by rule: meter records where they exist, else a strategy’s AADD, else population × litres a day.',
		category: 'network',
		fields: ['demandObject.source']
	},
	{
		id: 'water-source',
		term: 'Water source of a demand',
		short: 'Whether a demand draws on its hydrological unit’s dam, under the supply rule, or on a river abstraction of its own beside it.',
		units: 'm³/day',
		category: 'network',
		fields: ['node.cropWaterSource', 'node.cropRiverPumpM3Day', 'node.cropRiverPoolM3', 'demandObject.waterSource', 'demandObject.riverPumpM3Day', 'demandObject.riverPoolM3', 'summary.riverTakes']
	},
	{
		id: 'crop-supply-table',
		term: 'Crop supply table',
		short: 'A hydrological unit’s crop demand split in fixed shares between its own dam, the river at the unit and the dam of another unit.',
		units: '% of the crop demand',
		category: 'network',
		fields: ['node.cropShareDam', 'node.cropShareRiver', 'node.cropShareRemote', 'node.cropRemoteNodeId', 'node.cropRemoteCapM3Day', 'run.remote_dam_in', 'run.remote_dam_out']
	},
	{
		id: 'supply-rule',
		term: 'Supply rule and river pump',
		short: 'Where a hydrological unit’s irrigation comes from: its dam (the default), a river pump first, the dam until it runs low, or the river alone.',
		units: 'm³/day',
		category: 'network',
		fields: ['node.supplyRule', 'node.pumpCapacityM3Day', 'node.supplyTriggerPct', 'node.supplyStopPct', 'run.river_abstraction', 'summary.avgRiverAbstractionM3Day']
	},
	{
		id: 'drought-restriction',
		term: 'Drought restrictions',
		short: 'A model rule: on each review date a level is chosen from the farm dams’ storage; it cuts each part of demand until the next review.',
		units: '% of capacity; % cut',
		category: 'network',
		fields: ['settings.droughtRestriction', 'run.restriction_level', 'run.restricted_demand']
	},
	{
		id: 'hands-off-flow',
		term: 'Hands-off flow',
		short: 'Flow a hydrological unit leaves in the river before its river pump or River to dam takes anything: an amount by month, and/or the EWR.',
		units: 'm³/day',
		category: 'network',
		fields: ['node.handsOffM3Day', 'node.handsOffEwr']
	},
	{
		id: 'stream-depletion',
		term: 'Stream depletion',
		short: 'The river flow a borehole’s pumping captures: a share of the pumped volume, taken from the river below after a lag.',
		category: 'network',
		fields: ['node.streamDepletionFrac', 'node.streamDepletionLagDays', 'run.baseflow_depletion', 'run.depletion_unmet', 'run.depletion_deficit', 'run.depletion_store', 'summary.avgBaseflowDepletionM3Day']
	},
	{
		id: 'land-cover',
		term: 'Land cover (invasive plants, forestry)',
		short: 'Invasive alien trees and plantations on a hydrological unit use more water than natural vegetation, so it passes on less runoff.',
		category: 'network',
		fields: ['run.landcover_reduction']
	},
	{
		id: 'bed-losses',
		term: 'Bed losses (channel transmission losses)',
		short: 'Flow lost into the river bed and banks between a hydrological unit and the next one downstream; it leaves the catchment.',
		units: 'share of the flow (shown as %); cap m³/day',
		category: 'network',
		fields: ['node.reachLossFrac', 'node.reachLossMaxM3Day', 'run.reach_loss']
	},
	{
		id: 'outflow-gauge',
		term: 'Outflow gauge',
		short: 'The single element at the bottom of the network. Its simulated flow is compared with the EWR and with observed flow.',
		category: 'network',
		fields: ['run.simulated_outflow', 'catchment.meanSimulatedOutflowM3Day']
	},

	// ---- Units and dams -----------------------------------------------------
	{
		id: 'farm-area',
		term: 'Hydrological unit area',
		short: 'Land area of the hydrological unit, in km². Drives its share of catchment runoff under the Area method.',
		units: 'km²',
		category: 'farm',
		fields: ['node.areaKm2']
	},
	{
		id: 'hi-lo-map-area',
		term: 'High-MAP and low-MAP area',
		short: 'The hydrological unit’s land in the wetter (high mean annual precipitation) and drier parts of the catchment, in km².',
		units: 'km²',
		category: 'farm',
		fields: ['node.areaHiKm2', 'node.areaLoKm2']
	},
	{
		id: 'unit-map',
		term: 'Unit rainfall level',
		short: 'The unit’s own MAP in mm and its source: with rain for each unit, it sets the level of the unit’s CHIRPS rain.',
		units: 'mm/year',
		category: 'farm',
		fields: ['node.mapMm', 'node.mapSource']
	},
	{
		id: 'flow-share',
		term: 'Flow share (fragmentation)',
		short: 'The fixed fraction of catchment natural flow (and EWR) assigned to each hydrological unit. Shares should add up to 100 %.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		fields: ['settings.flowShareMethod', 'node.flowShareManual', 'summary.flowShare']
	},
	{
		id: 'hi-lo-split',
		term: 'Hi/Lo split',
		short: 'How much runoff comes from the high-rainfall zone versus the low one (defaults to 50 % / 50 %; set per project). For the Hi/Lo method.',
		units: 'fraction 0–1',
		category: 'farm',
		fields: ['settings.hiLoSplit']
	},
	{
		id: 'upstream-to-dam',
		term: 'Upstream inflow share (dam)',
		short: 'Fraction of the water arriving from upstream that enters the dam: 100 % for a dam on the river, 0 % for an off-channel dam.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		fields: ['node.pctUpstreamToDam']
	},
	{
		id: 'runoff-to-dam',
		term: 'Incremental runoff to dam',
		short: 'Share of the unit’s incremental catchment runoff (its own, not upstream’s) that drains into its dam. The rest joins the river below it.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		fields: ['node.pctRunoffToDam']
	},
	{
		id: 'dam-capacity',
		term: 'Dam capacity',
		short: 'Combined full-supply volume of the hydrological unit’s dams, in m³. 0 means no storage: water not used the same day flows on.',
		units: 'm³',
		category: 'farm',
		fields: ['node.damCapacityM3']
	},
	{
		id: 'dam-initial',
		term: 'Initial dam storage',
		short: 'How full the dam is on the first simulated day, as a fraction of capacity.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		fields: ['node.damInitialPct']
	},
	{
		id: 'dam-min',
		term: 'Minimum operating level',
		short: 'Dead storage, as a fraction of capacity: irrigation draws only the water above it, and transfers leave at least this much.',
		units: 'fraction 0–1 (shown as %)',
		category: 'farm',
		fields: ['node.damMinPct']
	},
	{
		id: 'dam-evaporation',
		term: 'Dam evaporation and rain on the dam',
		short: 'A dam loses open-water evaporation from its surface and catches the rain falling on it, every day before irrigation, in m³/day.',
		units: 'm³/day; area m²; factor × A-pan',
		category: 'farm',
		fields: ['settings.lakeEvapFactor', 'settings.lakeEvapFactorMonthly', 'settings.lakeEvapFactorSource', 'node.damAreaFullM2', 'node.damAreaExponent', 'run.dam_area', 'run.dam_evaporation', 'run.rain_on_dam']
	},
	{
		id: 'dam-seepage',
		term: 'Dam seepage',
		short: 'The share of a dam’s storage that seeps out each day; by default it reaches the river below the dam the same day.',
		units: 'fraction of storage per day (shown as %)',
		category: 'farm',
		fields: ['node.damSeepagePerDay', 'node.damSeepageReturnPct', 'run.dam_seepage', 'run.dam_seepage_lost']
	},
	{
		id: 'dam-survey-curve',
		term: 'Dam survey curve (area–volume)',
		short: 'Level, area and volume rows from a dam survey; the dam’s surface is read off them instead of the power law.',
		units: 'level m; area m²; volume m³',
		category: 'farm',
		fields: ['node.damCurve']
	},
	{
		id: 'dam-release',
		term: 'Dam release (compensation flow)',
		short: 'Water a dam lets through its outlet before irrigation: its inflow up to what the river below needs, or a fixed monthly amount.',
		units: 'm³/day',
		category: 'farm',
		fields: ['node.damReleaseRule', 'node.damReleaseM3Day', 'node.damOutletCapacityM3Day', 'run.dam_release']
	},
	{
		id: 'dam-survey-date',
		term: 'Dam survey date',
		short: 'The day the capacity above was measured. With a sediment rate, the dam holds more before this date and less after it.',
		units: 'date (YYYY-MM-DD)',
		category: 'farm',
		fields: ['node.damSurveyDate']
	},
	{
		id: 'dam-sediment',
		term: 'Dam sediment rate (siltation)',
		short: 'Share of the surveyed capacity a dam loses to silt each year. Its capacity shrinks steadily through the run, never below empty.',
		units: 'fraction of capacity per year, 0–0.2 (shown as %)',
		category: 'farm',
		fields: ['node.damSedimentPctPerYear', 'run.dam_capacity']
	},
	{
		id: 'dam-in-service',
		term: 'Dam in service from',
		short: 'The first day the dam holds water. Before it the unit has no dam, and what would flow into it passes on down the river.',
		units: 'date (YYYY-MM-DD)',
		category: 'farm',
		fields: ['node.damInServiceFrom']
	},
	{
		id: 'abstraction-start',
		term: 'Abstraction starts',
		short: 'The first day this unit takes water. Before it its crops, demand objects and own demand take nothing, as before it was developed.',
		units: 'date (YYYY-MM-DD)',
		category: 'farm',
		fields: ['node.abstractionFrom']
	},
	{
		id: 'diversion',
		term: 'River to dam (diversion)',
		short: 'Most water pumped or channelled from the river into an off-channel dam, in m³/s. Separate from the river pump that irrigates.',
		units: 'm³/s (stored as m³/day)',
		category: 'farm',
		fields: ['node.divertCapacityM3Day', 'node.divertMonthlyM3Day']
	},
	{
		id: 'irrigation-efficiency',
		term: 'Irrigation efficiency',
		short: 'Share of the water abstracted for irrigation that reaches the crop. The hydrological unit abstracts crop requirement ÷ efficiency.',
		units: 'fraction 0–1 (shown as %), above 0',
		category: 'farm',
		fields: ['node.irrigationEfficiency', 'crop.irrigationEfficiency']
	},
	{
		id: 'irrigation-system',
		term: 'Irrigation system',
		short: 'How a crop is watered on a unit (drip, pivot, flood…): its efficiency comes from the project’s table on Crops & demand.',
		units: 'a row of the project’s table',
		category: 'farm',
		fields: ['crop.irrigationSystemId', 'cropArea.irrigationSystemId']
	},
	{
		id: 'demand-factor',
		term: 'Demand factor',
		short: 'A scenario’s multiplier on what a unit or water user would take, per month (0.85 = 85 %); on a unit also per part (crops, a category).',
		units: 'multiplier ≥ 0 per month (a scenario op takes 0–2)',
		category: 'farm',
		fields: ['node.demandFactor', 'node.partDemandFactor']
	},
	{
		id: 'return-flow',
		term: 'Irrigation return flow',
		short: 'The share of the irrigation water supplied that infiltrates and returns to the river the same day; at most 100 % − efficiency.',
		units: 'fraction 0–1 of the water supplied (shown as %)',
		category: 'farm',
		fields: ['node.returnFlowFraction']
	},
	{
		id: 'spill',
		term: 'Spill',
		short: 'Water that overflows a full dam and continues downstream, in m³/day.',
		units: 'm³/day',
		category: 'farm',
		fields: ['run.spill']
	},
	{
		id: 'dam-storage',
		term: 'Dam storage',
		short: 'Volume in the dam at the end of each day, in m³.',
		units: 'm³',
		category: 'farm',
		fields: ['run.dam_storage']
	},
	{
		id: 'working-columns',
		term: 'Working columns',
		short: "A hydrological unit's intermediate daily numbers (K … T), so any day can be redone by hand from the daily CSV.",
		units: 'm³/day (interim storage m³)',
		category: 'results',
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
		]
	},
	{
		id: 'balance-check',
		term: 'Self-checks and the balance check',
		short: 'Every run checks its own output: each hydrological unit’s day must balance, and the reports must add up to the daily series.',
		units: 'm³/day',
		category: 'results',
		fields: ['run.balance_residual']
	},

	// ---- Crops and irrigation demand -----------------------------------------
	{
		id: 'apan',
		term: 'A-pan evaporation',
		short: 'Monthly evaporation from a Class-A pan, in mm. Times a crop factor it estimates the crop’s water need.',
		units: 'mm per month',
		category: 'crops',
		fields: ['settings.apanMm']
	},
	{
		id: 'crop-factor',
		term: 'Crop factor (× A-pan)',
		short: 'Monthly multiplier from A-pan to a crop’s water use, Oct … Sep. Not an FAO Kc: multiply a Kc by the pan coefficient (0.6–0.85) first.',
		units: 'dimensionless',
		category: 'crops',
		fields: ['crop.cropFactor', 'crop.name']
	},
	{
		id: 'crop-area',
		term: 'Crop area',
		short: 'Area of each crop on each hydrological unit, entered in hectares. Leave a crop blank on hydrological units that don’t grow it.',
		units: 'ha (stored as m²; 1 ha = 10 000 m²)',
		category: 'crops',
		fields: ['cropArea.areaM2']
	},
	{
		id: 'effective-rainfall',
		term: 'Effective rainfall fraction',
		short: 'Share of rain on cropped land that counts towards the crop’s need and so reduces irrigation (b023 default 0.65).',
		units: 'fraction 0–1',
		category: 'crops',
		fields: ['settings.effectiveRainFraction', 'settings.effectiveRainFractionMonthly']
	},
	{
		id: 'soil-water-store',
		term: 'Soil-water store',
		short: 'Effective rain the crop can’t use on the day it falls is kept in the soil, up to this depth (mm), for the next days.',
		units: 'mm over the cropped area',
		category: 'crops',
		fields: ['settings.effectiveRainStoreMm', 'run.soil_water']
	},
	{
		id: 'crop-requirement',
		term: 'Crop water requirement',
		short: 'Water the hydrological unit’s crops need from irrigation each day, after effective rain, in m³/day (the workbook’s net irrigation demand).',
		units: 'm³/day',
		category: 'crops',
		fields: ['run.crop_requirement', 'summary.avgCropRequirementM3Day']
	},
	{
		id: 'irrigation-demand',
		term: 'Irrigation demand (abstraction)',
		short: 'What the hydrological unit has to abstract: crop requirement ÷ irrigation efficiency, plus any demand objects’ demand, in m³/day.',
		units: 'm³/day',
		category: 'crops',
		fields: ['run.demand', 'summary.avgDemandM3Day']
	},
	{
		id: 'irrigation-supplied',
		term: 'Irrigation supplied',
		short: 'Water abstracted for the hydrological unit that day (dam, river, borehole): the demand, or less when water runs short. The crop gets e × it.',
		units: 'm³/day',
		category: 'crops',
		fields: ['run.supplied', 'summary.avgSuppliedM3Day']
	},
	{
		id: 'irrigation-deficit',
		term: 'Irrigation deficit',
		short: 'Abstraction demand that could not be met: demand minus supplied, in m³/day.',
		units: 'm³/day',
		category: 'crops',
		fields: ['run.deficit', 'summary.avgDeficitM3Day']
	},

	// ---- Transfers ------------------------------------------------------------
	{
		id: 'transfer',
		term: 'Transfer',
		short: 'Water moved from one hydrological unit’s dam to another hydrological unit (pipeline or canal), in chosen months and up to a maximum rate.',
		category: 'transfers',
		fields: ['transfer.fromNodeId', 'transfer.toNodeId', 'transfer.enabled', 'run.transfer']
	},
	{
		id: 'transfer-months',
		term: 'Transfer rate by month',
		short: 'A maximum rate for each month (Oct … Sep), in m³/s. A blank month is off: nothing moves in it.',
		units: 'm³/s per month',
		category: 'transfers',
		fields: ['transfer.months', 'transfer.monthlyRateM3s']
	},
	{
		id: 'transfer-rate',
		term: 'Maximum transfer rate',
		short: 'The pipe or canal capacity, in m³/s (× 86 400 per day), the largest monthly rate. An optional daily cap in m³ limits it further.',
		units: 'm³/s; daily cap in m³',
		category: 'transfers',
		fields: ['transfer.maxRateM3s', 'transfer.dailyCapM3']
	},
	{
		id: 'transfer-offtake',
		term: 'River off-take',
		short: 'A transfer that takes from the river leaving its source hydrological unit, not from a dam: a canal or pipe fed from a weir.',
		units: 'hands-off m³/day; losses %; share of the losses seeping back %',
		category: 'transfers',
		fields: ['transfer.source', 'transfer.handsOffM3Day', 'transfer.handsOffEwr', 'transfer.lossPct', 'transfer.sizing', 'transfer.topUpDam', 'transfer.lossReturnPct', 'transfer.lossReturnNodeId']
	},
	{
		id: 'transfer-min-storage',
		term: 'Transfer minimum storage',
		short: 'The source dam is not drawn below this fraction of its capacity by this transfer, nor below the dam’s own minimum operating level.',
		units: 'fraction 0–1 (shown as %)',
		category: 'transfers',
		fields: ['transfer.minStoragePct']
	},
	{
		id: 'transfer-priority',
		term: 'Transfer priority and the receiver’s room',
		short: 'Rules with a lower priority move first; rules of equal priority from one dam share it in proportion to their limits.',
		units: 'whole number',
		category: 'transfers',
		fields: ['transfer.priority']
	},

	// ---- Natural flow and calibration -----------------------------------------
	{
		id: 'natural-flow',
		term: 'Natural flow',
		short: 'The flow the catchment would produce with no hydrological units, dams or abstraction, in m³/day. Generated from rain.',
		units: 'm³/day',
		category: 'flow',
		fields: ['run.natural_flow', 'catchment.meanNaturalFlowM3Day', 'run.resultant_flow']
	},
	{
		id: 'farm-runoff',
		term: 'Hydrological unit runoff',
		short: 'The hydrological unit’s share of catchment natural flow on the day, in m³/day.',
		units: 'm³/day',
		category: 'flow',
		fields: ['run.runoff']
	},
	{
		id: 'upstream-inflow',
		term: 'Inflow from upstream',
		short: 'The same-day outflow of the elements that drain into this one, in m³/day.',
		units: 'm³/day',
		category: 'flow',
		fields: ['run.inflow_upstream']
	},
	{
		id: 'farm-outflow',
		term: 'Outflow',
		short: 'What leaves the element each day: spill, flow bypassing the dam, dam release, seepage and return flow, less river pumping, in m³/day.',
		units: 'm³/day',
		category: 'flow',
		fields: ['run.outflow']
	},
	{
		id: 'calibration',
		term: 'Calibration',
		short: 'Tuning the rain-to-flow parameters so simulated outflow matches the observed record at the outlet.',
		category: 'flow'
	},
	{
		id: 'runoff-model',
		term: 'Runoff model',
		short: 'The model that turns rain into natural flow: GR4J, the only one since engine 1.0.0 removed the legacy b023 model.',
		category: 'flow',
		fields: ['settings.runoffModel']
	},
	{
		id: 'gr4j',
		term: 'GR4J',
		short: 'A published daily rain-to-flow model with four parameters. It conserves water: rain leaves as evaporation or flow, or stays stored.',
		units: 'X1, X3 mm; X2 mm/day; X4 days',
		category: 'flow',
		fields: ['settings.gr4j', 'run.production_store', 'run.routing_store', 'run.uh_store', 'run.exchange']
	},
	{
		id: 'pan-coefficient',
		term: 'Pan coefficient',
		short: 'Potential evaporation = pan coefficient × A-pan evaporation, per month. Drives GR4J; default 0.7.',
		category: 'flow',
		fields: ['settings.panCoefficient', 'settings.panCoefficientSource', 'run.pet']
	},
	{
		id: 'gr4j-pe',
		term: 'GR4J potential evaporation (source)',
		short: 'Where GR4J’s potential evaporation comes from: pan coefficient × A-pan (default), or a monthly PE row entered directly.',
		units: 'mm per month',
		category: 'flow',
		fields: ['settings.pe']
	},
	{
		id: 'areal-rain',
		term: 'Areal rainfall correction',
		short: 'Scales the rain GR4J runs on to the catchment’s areal rain (e.g. from an independent MAP). Runoff only; demand keeps the recorded rain.',
		units: '× per month',
		category: 'flow',
		fields: ['settings.arealRain', 'run.rain_areal']
	},
	{
		id: 'unit-rain',
		term: 'Runoff from each unit’s own rain',
		short: 'GR4J runs once per unit with land on that unit’s own rain (its gauge, the catchment gauge × MAP ratio, or its CHIRPS) and sums the flow.',
		units: 'mm/day',
		category: 'flow',
		fields: ['settings.unitRain']
	},
	{
		id: 'actual-evaporation',
		term: 'Actual evaporation (AET)',
		short: 'Water the catchment actually evaporates each day in GR4J, in mm: never more than the potential evaporation.',
		units: 'mm',
		category: 'flow',
		fields: ['run.aet']
	},
	{
		id: 'auto-calibration',
		term: 'Automatic calibration (Fit automatically)',
		short: 'Searches the runoff model’s parameters for the best fit to the observed record, then tests the fit on days it never saw.',
		category: 'fit'
	},
	{
		id: 'calibration-objective',
		term: 'Objective (what a fit optimises)',
		short: 'The score the search maximises. Choose it by what the fit will feed, before seeing any score: KGE′ by default, a low-flow one for EWR.',
		category: 'fit'
	},
	{
		id: 'validation-tests',
		term: 'Validation tests (held-out scores)',
		short: 'Scores on days a fit never saw: the record’s second half, the wettest years after fitting the driest, or a second instrument.',
		category: 'fit'
	},
	{
		id: 'calibration-search',
		term: 'Search: model runs, starts and seed',
		short: 'How hard the optimiser looks: model runs per search (1 500), separate searches from their own seeds (5), and a seed that makes it repeat.',
		category: 'fit'
	},
	{
		id: 'fit-benchmarks',
		term: 'Benchmarks (mean flow and climatology)',
		short: 'Two naive simulations scored on the same days: the mean flow every day, and each calendar day’s smoothed average. A model should beat both.',
		category: 'fit'
	},
	{
		id: 'score-interval',
		term: 'Score range (90 %, by water year)',
		short: 'The bracketed range beside a score: its 5th–95th percentile with whole water years resampled 1 000 times. Wide = the record can’t pin it.',
		category: 'fit'
	},
	{
		id: 'record-representativeness',
		term: 'How representative the record is',
		short: 'How many water years a fit scored and where each year’s rain sits in the long-term record: dry, near normal or wet.',
		category: 'fit'
	},
	{
		id: 'uncertainty-bands',
		term: 'Uncertainty bands (behavioural ensemble)',
		short: 'How far a run’s results move across every parameter set and forcing the data can’t rule out: 5–95 % bands, never below 30 kept sets.',
		category: 'fit'
	},
	{
		id: 'evidence-uncertainty-rule',
		term: 'Declared uncertainty rule (evidence)',
		short: 'The ensemble an evidence report may cite: its size, bounds, pan shift and the tests a set must pass, declared before any band is seen.',
		category: 'fit',
		fields: ['settings.evidenceUncertaintyRule']
	},
	{
		id: 'calibration-bounds',
		term: 'Bounds (automatic calibration)',
		short: 'How far the search may roam per parameter: wide (each parameter’s full calibration range) or typical (Perrin et al.’s published 80 % range).',
		category: 'fit'
	},
	{
		id: 'wr2012-check',
		term: 'WR2012 check',
		short: 'Compares simulated natural flow with the naturalised flow WR2012 publishes for the quaternary, scaled to the modelled catchment.',
		units: 'MAR Mm³/a; monthly means Mm³ per month; area km²; MAP mm',
		category: 'flow',
		fields: ['settings.wr2012']
	},
	{
		id: 'wr2012-penalty',
		term: 'WR2012 MAR penalty (calibration)',
		short: 'Optional: automatic calibration also pulls the simulated natural MAR towards the scaled WR2012 MAR. Off by default.',
		category: 'fit'
	},
	{
		id: 'wr2012-fit-statistics',
		term: 'WR2012 fit statistics',
		short: 'Five statistics of annual and monthly flow, observed against simulated, each with its % difference and a good-fit band. Never optimised.',
		units: 'Mm³ ; %',
		category: 'fit',
		fields: ['stats.wr2012Fit']
	},
	{
		id: 'calibration-exclusions',
		term: 'Calibration exclusions',
		short: 'Water years or date ranges left out of every calibration score, each with a reason that runs keep on record.',
		category: 'fit',
		fields: ['settings.calibrationExclusions', 'stats.exclusions', 'stats.excludedDays']
	},
	{
		id: 'quality-flags',
		term: 'Quality flags (per-day)',
		short: 'Each observed day is in the gauged range, above or below it, suspect, infilled or missing. Fit automatically sets flagged days aside.',
		category: 'fit',
		fields: ['settings.qualityFlags', 'run.observed_flow_quality']
	},
	{
		id: 'calibration-rules',
		term: 'Calibration rules (automated calibration)',
		short: 'Rules saved before any fit is seen: which years to leave out, which fits to try and which one to keep. The fit then picks itself.',
		category: 'fit',
		fields: ['settings.calibrationRules']
	},
	{
		id: 'calibration-selection-score',
		term: 'Selection score (which fit the rules keep)',
		short: 'The one score, on one held-out test, that every fit the rules try is compared on. The best passing fit is kept. Match it to the use.',
		category: 'fit'
	},
	{
		id: 'flagged-year-rule',
		term: 'Flagged-year exclusion rule',
		short: 'Leaves a whole water year out of every fit when more than this share of its observed days carry a quality flag. Default 20 %.',
		units: '%',
		category: 'fit'
	},
	{
		id: 'calibration-rule-filters',
		term: 'Filters a kept fit must pass',
		short: 'A fit is only kept if its natural MAR is inside the WR2012 band and its parameters are in the typical range. If none passes, none is kept.',
		category: 'fit'
	},
	{
		id: 'rules-on-new-data',
		term: 'Calibration rules on new data',
		short: 'What happens when new observed or rain data arrives: nothing (default), run the rules and keep the report, or also apply the kept fit.',
		category: 'fit'
	},
	{
		id: 'fit-record',
		term: 'Fit record',
		short: 'What “Apply to form” stores with fitted parameters: how the fit was made and how it scored on days it never saw.',
		category: 'fit',
		fields: ['settings.fitRecord']
	},
	{
		id: 'catchment-area',
		term: 'Catchment area (rain)',
		short: 'Area, in km², that rain falls on when converting mm to m³. Empty = the sum of the hydrological unit areas.',
		units: 'km²',
		category: 'flow',
		fields: ['calibration.catchmentAreaKm2']
	},
	{
		id: 'rain-threshold',
		term: 'Rain threshold',
		short: 'Daily rain at or below this (mm) doesn’t reduce irrigation demand. GR4J uses all the rain. b023 default 2 mm.',
		units: 'mm',
		category: 'flow',
		fields: ['calibration.rainThresholdMm']
	},
	{
		id: 'base-flow',
		term: 'Base flow',
		short: 'The slow, groundwater-fed part of river flow that recedes gradually between storms, in m³/day.',
		units: 'm³/day',
		category: 'flow',
		fields: ['run.base_flow']
	},
	{
		id: 'legacy-runoff-model',
		term: 'Legacy runoff model',
		short: 'The b023 workbook’s rain → peak → recession routine, removed in engine 1.0.0. Runs made with it still open, labelled, but can’t be re-run.',
		category: 'flow',
		fields: ['run.is_summer', 'run.rain_flow', 'run.response_flow']
	},

	// ---- EWR ----------------------------------------------------------------
	{
		id: 'ewr',
		term: 'EWR (Environmental Water Requirement)',
		short: 'The flow that must stay in the river to keep the ecosystem in its target condition.',
		units: 'm³/day',
		category: 'ewr'
	},
	{
		id: 'pragmatic-ewr',
		term: 'Pragmatic EWR',
		short: 'b023’s simplification: one fixed m³/day per month at the outlet, instead of a requirement that varies with wetness.',
		units: 'm³/day per month',
		category: 'ewr',
		fields: ['settings.ewrPragmaticM3PerDay', 'run.ewr']
	},
	{
		id: 'ewr-share',
		term: 'Hydrological unit EWR share',
		short: 'The hydrological unit’s part of the pragmatic EWR (EWR × its flow share), added up down the river to give the EWR each point must pass.',
		units: 'm³/day',
		category: 'ewr',
		fields: ['run.ewr_cumulative']
	},
	{
		id: 'ewr-shortfall',
		term: 'EWR shortfall',
		short: 'How far flow falls below the EWR on a day (negative = not met), in m³/day. Zero when the EWR is met.',
		units: 'm³/day',
		category: 'ewr',
		fields: ['run.ewr_shortfall']
	},
	{
		id: 'ewr-charge',
		term: 'EWR charge',
		short: 'A hydrological unit’s share of the EWR shortfall at the EWR sites below it, pro rata to its net impact that day.',
		units: 'm³/day, shown as a positive volume charged (negative in the daily series)',
		category: 'ewr',
		fields: ['run.ewr_charge', 'run.ewr_charged', 'run.ewr_natural', 'run.ewr_binding_site', 'summary.avgEwrShortfallM3Day']
	},
	{
		id: 'ewr-charge-split',
		term: 'Irrigate less / store less',
		short: 'The EWR charge split by what the hydrological unit can change: its irrigation, or its storage and pass-through.',
		units: 'm³/day; l/s',
		category: 'ewr',
		fields: ['run.ewr_charge_irrigation']
	},
	{
		id: 'equitable-share',
		term: 'Equitable share of supply (fairness benchmark)',
		short: 'Σ supplied ÷ Σ demand: the share of its demand each hydrological unit would get if supply were shared in proportion. Not an allocation.',
		units: '% of demand; m³/day',
		category: 'results'
	},
	{
		id: 'demand-left',
		term: 'Demand left',
		short: 'Share of a hydrological unit’s demand left to irrigate once supply is shared fairly and the EWR supply cut is made.',
		units: '% of demand',
		category: 'results'
	},
	{
		id: 'curtailment-targets',
		term: 'Curtailment targets (total change)',
		short: 'How much each hydrological unit’s supply would change to share water fairly and meet the EWR. Negative = reduce. Not a restriction.',
		units: 'm³/day; l/s',
		category: 'results'
	},
	{
		id: 'share-the-pain',
		term: 'Share the pain',
		short: 'Each group’s supply as a share of its own demand in two steps: what it got, and what is left once its EWR charge is met.',
		units: '% of demand',
		category: 'results'
	},
	{
		id: 'report-pdf',
		term: 'Report PDF',
		short: 'Download PDF prints the page in your browser; Generate PDF has the server print the same pages, to download or by email.',
		category: 'results'
	},
	{
		id: 'reach-shortfall',
		term: 'Reach shortfall (workbook AB)',
		short: 'The workbook’s incremental shortfall: a hydrological unit’s shortfall minus those directly upstream. A diagnostic only.',
		units: 'm³/day',
		category: 'ewr',
		fields: ['run.ewr_shortfall_incremental']
	},
	{
		id: 'ewr-days-not-met',
		term: 'Days EWR not met',
		short: 'Outlet: days flow was below the EWR. A hydrological unit: days it was charged for a shortfall at an EWR site below it. Also as a share.',
		units: 'days; fraction 0–1',
		category: 'ewr',
		fields: ['summary.daysEwrNotMet', 'catchment.ewrDaysNotMet', 'catchment.ewrFractionDaysNotMet']
	},
	{
		id: 'reserve-rules',
		term: 'EWR rule table (the Reserve’s assurance rules)',
		short: 'The Reserve’s EWR as a table: per month, the flow required at each assurance level, read at the natural flow’s percentile.',
		units: 'Mm³ per month or m³/s; % points 0–100',
		category: 'ewr',
		fields: ['settings.ewrRules']
	},
	{
		id: 'reserve-compliance',
		term: 'Monthly compliance with the Reserve rules',
		short: 'Share of months whose simulated flow met the Reserve rule table’s requirement for that month’s natural condition.',
		units: 'share of months; Mm³; months',
		category: 'ewr',
		fields: ['run.ewr_rule']
	},
	{
		id: 'reserve-low-flows',
		term: 'Maintenance and drought low flows',
		short: 'The low-flow part of the Reserve: the base flow a river needs in normal years (maintenance) down to the least it needs in a drought.',
		units: 'Mm³ per month or m³/s',
		category: 'ewr'
	},
	{
		id: 'reserve-high-flows',
		term: 'High flows: freshets and floods',
		short: 'Reserve high-flow events: a peak flow held for some days, a number of times each water year, in given months.',
		units: 'm³/s; days; events per water year',
		category: 'ewr'
	},
	{
		id: 'ewr-charge-source',
		term: 'What the EWR charge follows',
		short: 'The daily pragmatic EWR (default; provisional, not hydrologist-confirmed), or at a site with a rule table the month’s requirement.',
		units: 'm³/day',
		category: 'ewr',
		fields: ['settings.ewrChargeSource', 'run.ewr_charge_shortfall']
	},
	{
		id: 'ewr-daily-source',
		term: 'The daily EWR at the outlet',
		short: 'Where the outlet’s daily EWR comes from: the pragmatic EWR, the DRM TAB file, or the DRM percentile tables, scaled to the model.',
		units: 'm³/s in the tables; m³/day in the run',
		category: 'ewr',
		fields: ['settings.ewrDailySource', 'catchment.outletEwr']
	},
	{
		id: 'low-flow-measure',
		term: 'Low flows judged on',
		short: 'The month’s total flow (default, the hydrologist’s choice), or its base flow (filter settings unconfirmed), so a flood can’t hide low flows.',
		units: 'Mm³ per month or m³/s',
		category: 'ewr',
		fields: ['settings.lowFlowMeasure']
	},
	{
		id: 'plausibility-checks',
		term: 'Plausibility checks',
		short: 'Six checks a reviewing hydrologist makes on a run (fewer on older runs): they only warn, and never change a result.',
		category: 'results'
	},
	{
		id: 'plausibility-naturalised',
		term: 'Natural flow ≥ observed + abstraction',
		short: 'Observed flow plus what the network took out upstream is the natural flow the record implies; it can’t exceed the simulated natural flow.',
		units: 'Mm³ per water year',
		category: 'results'
	},
	{
		id: 'plausibility-rain-source',
		term: 'Good-rain and fallback-rain years',
		short: 'EWR days not met, split by whether the water year’s rain came mostly from the catchment station or from fallback rain.',
		category: 'results'
	},
	{
		id: 'plausibility-flow-double-mass',
		term: 'Double mass: observed flow vs rain',
		short: 'Cumulative observed flow against cumulative rain: a kink means the catchment’s use or the gauge changed.',
		category: 'results'
	},
	{
		id: 'plausibility-low-flow',
		term: 'Dry-season low-flow duration curve',
		short: 'The flow duration curve of dry-season days only, for the gauge, the logger and each model’s simulated flow.',
		units: 'm³/s',
		category: 'results'
	},
	{
		id: 'plausibility-recession',
		term: 'Recession diagnostics',
		short: 'How fast flow falls in rain-free spells (−dQ/dt against Q), in the record and in the model on the same days.',
		units: 'm³/s; m³/s per day',
		category: 'results'
	},
	{
		id: 'plausibility-signatures',
		term: 'Validation signatures',
		short: 'Base-flow index by two filters, the low-flow duration curve’s slope and bias, and skill on held-out recessions.',
		units: 'ratio; %',
		category: 'results'
	},
	{
		id: 'ewr-agreement',
		term: 'EWR test against observed flow',
		short: "Does the model fall below the EWR on the days the observed river did? A 2×2 table of observed days, with scores.",
		units: 'days; ratios',
		category: 'ewr',
		fields: ['catchment.ewrAgreement']
	},
	{
		id: 'desktop-reserve-model',
		term: 'Desktop Reserve Model',
		short: 'Software (“Desktop Version 2”) that produces monthly Reserve flow tables by percentile for a river’s ecological category.',
		category: 'ewr'
	},
	{
		id: 'ecological-category',
		term: 'Ecological category',
		short: 'The A–F class of river condition; the Reserve is set for a target category of A–D (A = natural, F = critically modified).',
		category: 'ewr'
	},

	// ---- Input data -----------------------------------------------------------
	{
		id: 'rain-catchment',
		term: 'Catchment rainfall',
		short: 'Daily catchment-average rainfall in mm. The first choice for driving natural flow and effective rain.',
		units: 'mm/day',
		category: 'data',
		fields: ['series.rain_catchment_mm']
	},
	{
		id: 'rain-final',
		term: 'Final catchment rainfall',
		short: 'The daily rainfall a run works from after filling gaps: catchment rain, else bias-corrected CHIRPS, else forecast rain, in mm.',
		units: 'mm/day',
		category: 'data',
		fields: ['run.rain_final', 'run.rain_used']
	},
	{
		id: 'chirps',
		term: 'CHIRPS rainfall',
		short: 'Satellite-and-station daily rainfall (Climate Hazards Group). Used on days without catchment rainfall.',
		units: 'mm/day',
		category: 'data',
		fields: ['series.rain_chirps_mm', 'run.rain_chirps']
	},
	{
		id: 'chirps-bias',
		term: 'CHIRPS bias correction',
		short: 'Scales CHIRPS rain, on days it fills in for blank catchment rain, by a catchment ÷ CHIRPS factor for the calendar month.',
		category: 'data',
		fields: ['settings.chirpsBiasCorrection', 'run.rain_chirps_corrected', 'run.chirps_factor']
	},
	{
		id: 'chirps-fit-period',
		term: 'CHIRPS fit period',
		short: 'Which years the CHIRPS factors are fitted on: the whole record, or water-year ranges you list, each with a reason.',
		category: 'data',
		fields: ['settings.chirpsFitPeriod']
	},
	{
		id: 'chirps-quantile-map',
		term: 'CHIRPS quantile map',
		short: 'Opt-in: gives the CHIRPS that fills gaps the catchment rain’s wet-day frequency and intensity, keeping each month’s total.',
		category: 'data',
		fields: ['settings.chirpsQuantileMap', 'run.rain_chirps_mapped']
	},
	{
		id: 'double-mass',
		term: 'Double mass: catchment rain vs CHIRPS',
		short: 'Cumulative catchment rain against cumulative CHIRPS: a kink means one record changed, e.g. a station opened, closed or moved.',
		category: 'data'
	},
	{
		id: 'zero-rain-runs',
		term: 'Zero-rain runs treated as missing',
		short: 'Long wet-season runs of zero catchment rain count as missing, so bias-corrected CHIRPS fills them instead of running them dry.',
		category: 'data',
		fields: ['settings.zeroRainRuns', 'run.rain_catchment_missing']
	},
	{
		id: 'flow-gap-filling',
		term: 'Gap filling of observed flow',
		short: 'Short gaps in a gauge or logger record interpolated, longer ones filled from another record × a fitted ratio; in a run only.',
		category: 'data',
		fields: ['settings.flowGapFill', 'run.observed_flow_fill', 'run.observed_flow_filled', 'run.observed_flow_other_fill', 'run.observed_flow_other_filled']
	},
	{
		id: 'series-source',
		term: 'Series source and unit',
		short: 'Where a series\' values came from (a station, agency, file or feed) and the unit they were given in before the app converted them.',
		category: 'data'
	},
	{
		id: 'rain-accumulations',
		term: 'Multi-day rain accumulations',
		short: 'Several days of rain read on one day after days entered as 0: the total is spread back over those days in proportion to CHIRPS.',
		category: 'data',
		fields: ['run.rain_catchment_spread']
	},
	{
		id: 'rain-source',
		term: 'Rain source periods',
		short: 'Dates when catchment rain comes from another gauge × monthly factors instead of the catchment series; its gaps take a named fallback.',
		category: 'data',
		fields: ['settings.rainSource', 'run.rain_source']
	},
	{
		id: 'rain-catchment-alt',
		term: 'Alternative catchment gauge',
		short: 'A second catchment rain record (mm/day), e.g. an in-catchment automatic station. Read only inside a rain-source period.',
		units: 'mm/day',
		category: 'data',
		fields: ['series.rain_catchment_alt_mm']
	},
	{
		id: 'rain-reanalysis',
		term: 'Reanalysis rainfall',
		short: 'A gauge-free gridded rain product such as ERA5 (mm/day): a reference for a rain-source fit, or the fallback for its gaps.',
		units: 'mm/day',
		category: 'data',
		fields: ['series.rain_reanalysis_mm']
	},
	{
		id: 'evap-apan-daily',
		term: 'Daily A-pan evaporation',
		short: 'A daily Class-A pan record (mm/day), e.g. a nearby station: replaces the monthly A-pan means on the days it has a value.',
		units: 'mm/day',
		category: 'data',
		fields: ['series.evap_apan_mm']
	},
	{
		id: 'rain-forecast',
		term: 'Forecast rainfall',
		short: 'Forecast daily rain in mm: fills gaps in the record, and runs past its end only in a forecast run, to look ahead a few days.',
		units: 'mm/day',
		category: 'data',
		fields: ['series.rain_forecast_mm']
	},
	{
		id: 'observed-flow',
		term: 'Observed flow',
		short: 'Measured flow at the outlet (gauge record, or a logger), in m³/s. Scores the calibration and the EWR test; it never drives the model.',
		units: 'm³/s',
		category: 'data',
		fields: ['series.flow_observed_m3s', 'series.flow_logger_m3s', 'run.observed_flow', 'run.observed_flow_other']
	},
	{
		id: 'reference-gauge',
		term: 'Reference gauge (other catchment)',
		short: 'A gauge on another river: a regional wet/dry index. Runs never read it; Fit automatically ranks water years by it, never fits to it.',
		units: 'm³/s',
		category: 'data',
		fields: ['series.flow_reference_m3s']
	},
	// The Data tab's daily preview ("Input time series — daily preview"): one
	// entry per column it derives. Its raw series columns use series.<kind>.
	{
		id: 'preview-date',
		term: 'Date (daily preview)',
		short: 'One row per day, from the first day of the earliest loaded series to the last day of the latest. A blank cell means no reading.',
		category: 'data',
		fields: ['preview.date']
	},
	{
		id: 'preview-flow-m3day',
		term: 'Flow in m³/day (daily preview)',
		short: 'The flow series’ m³/s value × 86 400: the unit the model works in, so the day reads directly against simulated flows.',
		units: 'm³/day',
		category: 'data',
		fields: ['preview.flowM3Day']
	},
	{
		id: 'preview-rain-used',
		term: 'Rain used (daily preview)',
		short: 'The rain the model runs on each day: catchment rain if it has a reading, else bias-corrected CHIRPS, else forecast rain.',
		units: 'mm/day',
		category: 'data',
		fields: ['preview.rainUsed']
	},
	{
		id: 'preview-chirps-factor',
		term: 'CHIRPS bias factor (daily preview)',
		short: 'The catchment ÷ CHIRPS rain factor for the day’s calendar month: what CHIRPS is multiplied by on days it fills a catchment gap.',
		units: '× (ratio)',
		category: 'data',
		fields: ['preview.chirpsFactor']
	},
	{
		id: 'preview-chirps-corrected',
		term: 'CHIRPS corrected (daily preview)',
		short: 'CHIRPS as the model reads it: × the month’s bias factor on days it fills blank catchment rain, as uploaded on every other day.',
		units: 'mm/day',
		category: 'data',
		fields: ['preview.chirpsCorrected']
	},
	{
		id: 'preview-excluded',
		term: 'Excluded from calibration (daily preview)',
		short: 'Marks days inside a calibration exclusion from Settings: they don’t count in Fit automatically or in a run’s calibration scores.',
		category: 'data',
		fields: ['preview.excluded']
	},
	{
		id: 'wr90',
		term: 'WR90 / WR2012',
		short: 'The Water Resources of South Africa studies (1990, 2012): S-pan evaporation, MAP and naturalised flow per quaternary catchment.',
		category: 'data'
	},
	{
		id: 'quaternary',
		term: 'Quaternary catchment',
		short: 'The smallest standard South African catchment unit (e.g. A21A), used to look up WR90/WR2012 data.',
		category: 'data'
	},
	{
		id: 'map',
		term: 'MAP and MAR',
		short: 'Mean annual precipitation (mm/yr) and mean annual runoff (M.m³/yr): the long-term averages of rain and river flow.',
		units: 'mm/yr; M.m³/yr',
		category: 'data'
	},
	// The Map tab and the values it proposes, the data feeds and the uploads.
	{
		id: 'catchment-map',
		term: 'Catchment map',
		short: 'The project’s geography: boundary, parcels, dams, gauges and rivers. It proposes values; none reaches the model until you accept it.',
		category: 'data'
	},
	{
		id: 'map-geojson-upload',
		term: 'GeoJSON upload',
		short: 'Map features from a GeoJSON file in WGS84 longitude/latitude, checked on the server; any problem refuses the whole file.',
		category: 'data'
	},
	{
		id: 'map-area',
		term: 'Area from the map',
		short: 'A polygon’s area on the WGS84 ellipsoid, worked out by the server. Use sets a hydrological unit’s area to it, as a model revision.',
		units: 'km²',
		category: 'data'
	},
	{
		id: 'area-basis',
		term: 'Gross or effective area (pans)',
		short: 'Gross: the whole delineated area. Effective: less what drains into pans (closed depressions), if you model them as not contributing.',
		units: 'km²',
		category: 'data'
	},
	{
		id: 'map-snap',
		term: 'Snap to features',
		short: 'A corner placed within 12 px of another feature’s corner or edge lands exactly on it; Follow edges also takes the corners between.',
		category: 'data'
	},
	{
		id: 'trace-dam',
		term: 'Trace a dam',
		short: 'Proposes a dam’s outline from satellite water occurrence (JRC Global Surface Water, 1984–2024) around a click inside its water.',
		category: 'data'
	},
	{
		id: 'map-checks',
		term: 'Map checks',
		short: 'Warnings where the map and the model disagree: units with no parcel, features outside the boundary, overlaps, areas 10 % apart.',
		category: 'data'
	},
	{
		id: 'map-results',
		term: 'Results on the map',
		short: 'Colours each parcel and dam polygon by one run’s figure: days short, curtailment, dam level or use against allocation, in words too.',
		category: 'data'
	},
	{
		id: 'elevation-model',
		term: 'Elevation model (DEM)',
		short: 'Copernicus GLO-30, a 30 m global elevation model: it shades the Relief layer, and delineation routes water over it.',
		category: 'data'
	},
	{
		id: 'delineation',
		term: 'Delineation',
		short: 'The catchment draining to a point on a river, from the elevation model: depressions filled, flow routed cell to cell (D8), outlined.',
		units: 'km²',
		category: 'data'
	},
	{
		id: 'terrain-channels',
		term: 'Terrain channels',
		short: 'The rivers as the elevation model routes them, drawn while delineating: the lines to click. Mapped rivers can sit hundreds of metres off.',
		category: 'data'
	},
	{
		id: 'outlet-placement',
		term: 'Outlet placement on the channel',
		short: 'A clicked outlet goes on the nearest terrain channel (the red lines) within 150 m; mapped rivers never move it.',
		category: 'data'
	},
	{
		id: 'sub-catchments',
		term: 'Sub-catchments, one per click',
		short: 'Each click on a river gets the land that drains to it before reaching any other click: its incremental catchment, from the terrain.',
		category: 'data'
	},
	{
		id: 'start-from-map',
		term: 'Start the model from the map',
		short: 'On an empty model: proposes the units, their areas and their order from the boundary and the dams, abstraction points and gauges.',
		category: 'data'
	},
	{
		id: 'divide-model',
		term: 'Divide the model from the map',
		short: 'For a model with units: proposes each unit’s own area, what it drains into and its dam’s runoff share, beside its value now.',
		category: 'data'
	},
	{
		id: 'dam-siting',
		term: 'Dam siting: on the river or off-channel',
		short: 'Whether a dam sits on the river or is filled by a pump or furrow. Start and Divide place its unit and propose its dam shares by it.',
		category: 'data'
	},
	{
		id: 'river-network',
		term: 'River network (HydroRIVERS)',
		short: 'Mapped river reaches with Strahler order and area upstream, for reference; add a reach to the project’s rivers one at a time.',
		category: 'data'
	},
	{
		id: 'quaternary-lookup',
		term: 'Quaternary lookup (propose from the map)',
		short: 'Finds the quaternary catchment holding a point and proposes its area, MAP, MAR and monthly flows for the WR2012 check, value by value.',
		category: 'data'
	},
	{
		id: 'synthetic-data',
		term: 'Synthetic test data',
		short: 'Invented reference data the app ships for development and tests. Anything proposed from it is marked; never use it for a real catchment.',
		category: 'data'
	},
	{
		id: 'dam-proposals',
		term: 'Dam values from the register and the map',
		short: 'A dam’s capacity from the register of dams (registered dams within 1 km) and its full-supply area from its polygon on the map.',
		category: 'data'
	},
	{
		id: 'cultivated-area',
		term: 'Cultivated area from land cover',
		short: 'The cropland ESA WorldCover maps in a unit’s parcels, proposed as one crop’s planted area. It never says which crop, or if irrigated.',
		units: 'ha',
		category: 'data'
	},
	{
		id: 'evaporation-from-map',
		term: 'Evaporation from the map',
		short: 'An evaporation grid’s 12 monthly means averaged over the boundary: ET₀ goes to GR4J’s monthly PE, A-pan to the A-pan row, unconverted.',
		units: 'mm/month',
		category: 'data'
	},
	{
		id: 'data-feeds',
		term: 'Data feeds',
		short: 'Rain and gauge flow fetched daily into a series: CHIRPS, the CHIRPS-GEFS forecast or a DWS gauge. A missing day never erases data.',
		category: 'data'
	},
	{
		id: 'boundary-rain',
		term: 'Rain from the catchment boundary',
		short: 'A CHIRPS feed averaging the 0.05° cells the boundary covers, each weighted by the share of it inside, rather than a box around it.',
		units: 'mm/day',
		category: 'data'
	},
	{
		id: 'unit-rain-feeds',
		term: 'Rain for each unit (CHIRPS feeds)',
		short: 'One CHIRPS feed per unit with land, averaging the 0.05° cells its parcel covers, area weighted, into that unit’s own rain series.',
		units: 'mm/day',
		category: 'data'
	},
	{
		id: 'chirps-gefs',
		term: 'CHIRPS-GEFS forecast',
		short: 'A 16-day daily rain forecast on the CHIRPS grid, issued daily; each issue replaces the last in the forecast rainfall series.',
		units: 'mm/day',
		category: 'data'
	},
	{
		id: 'chirps-version',
		term: 'CHIRPS product and version',
		short: 'Which CHIRPS a series holds: v2.0 (usual in b023) or v3.0, sat or rnl. One series holds one; two are never spliced together.',
		category: 'data'
	},
	{
		id: 'dws-flow',
		term: 'DWS gauge flow',
		short: 'A DWS river gauge’s verified daily mean flow in m³/s, from a data feed or an exported table. Verified data lags by months.',
		units: 'm³/s',
		category: 'data'
	},
	{
		id: 'data-freshness',
		term: 'Data up to, and Behind',
		short: 'A series’ last day with a value. Rain or A-pan a run is driven by is Behind once that day is more than 7 days ago.',
		category: 'data'
	},
	{
		id: 'day-boundary',
		term: 'Day boundary of sub-daily readings',
		short: 'How several readings a day add up into days: 08:00 to 08:00, booked to the day it starts (the manual-gauge day), or midnight to midnight.',
		category: 'data'
	},
	{
		id: 'series-update-mode',
		term: 'Append / update or replace',
		short: 'Append / update adds new days and corrects overlapping ones; Replace overwrites the whole series. Overwritten values stay in History.',
		category: 'data'
	},
	{
		id: 'series-edit-day',
		term: 'Edit a day, or paste rows',
		short: 'Set or clear one day of a series by hand, or paste date and value rows from a spreadsheet. Days typed in are marked as edited by hand.',
		category: 'data'
	},
	{
		id: 'workbook-import',
		term: 'b023 workbook import',
		short: 'Turns a b023 workbook into a new project, read in your browser: network, units, crops, transfers, settings and Flow data series.',
		category: 'data'
	},

	// ---- Run results ------------------------------------------------------------
	{
		id: 'fraction-supplied',
		term: 'Fraction of demand supplied',
		short: 'Average supplied ÷ average demand over the run (1 = every drop of demand met).',
		units: 'fraction 0–1',
		category: 'results',
		fields: ['summary.fractionSupplied']
	},
	{
		id: 'flow-duration-curve',
		term: 'Flow-duration curve (Q10–Q95)',
		short: 'Flow against the share of days it is equalled or exceeded. Q95 is the flow exceeded on 95 % of days: a low flow; Q10 a high one.',
		units: 'm³/s or m³/day',
		category: 'results'
	},
	// ---- Comparing runs, uncertainty, planning outputs, yield and forecasts
	{
		id: 'run-comparison',
		term: 'Run comparison (baseline and what-if)',
		short: 'A baseline beside up to two what-if runs. Every change is the what-if minus the baseline (B − A): green better, red worse.',
		category: 'results'
	},
	{
		id: 'run-matching',
		term: 'How runs are matched',
		short: 'Runs line up by id first, then by name: a unit renamed between runs is still the same unit; across a copy the same name is the same unit.',
		category: 'results'
	},
	{
		id: 'input-diff',
		term: 'Inputs that differ',
		short: 'Every difference between two runs’ inputs, in words: network, crops, transfers, settings and series, with who saved each change.',
		category: 'results'
	},
	{
		id: 'one-run-feature',
		term: 'Read as 0: a feature only one run has',
		short: 'A river pump, boreholes, a release rule or land cover in one run only reads as 0 in the other: that run moved none of that water.',
		category: 'results'
	},
	{
		id: 'compare-takeaways',
		term: 'Takeaways (material changes)',
		short: 'Plain sentences under What the change does, only for material changes: a day a year below the EWR, 1 pp of demand supplied, 5 % of outflow.',
		category: 'results'
	},
	{
		id: 'paired-band',
		term: 'Paired uncertainty band (B − A)',
		short: 'The change between two runs under each parameter set of run A’s ensemble: the change’s own uncertainty, with what both share cancelled.',
		category: 'results'
	},
	{
		id: 'ensemble-acceptance',
		term: 'Ensemble rule: sample and acceptance tests',
		short: 'How an uncertainty ensemble is drawn and which parameter sets it keeps (skill, WR2012 flag, low-flow bias), fixed before it runs.',
		category: 'results'
	},
	{
		id: 'sensitivity-runs',
		term: 'Sensitivity runs',
		short: 'EWR compliance re-run with one uncertain input changed at a time: rain, pan coefficient, dam evaporation, abstraction, starting storage.',
		category: 'results'
	},
	{
		id: 'sensitivity-verdict',
		term: 'Sensitivity verdict and threshold',
		short: 'Meets, or below, the threshold when every sensitivity run agrees; not determinable when their range crosses it. 80 % by default.',
		units: '% of days or months',
		category: 'results'
	},
	{
		id: 'demand-level',
		term: 'Demand levels',
		short: 'Percentages of today’s demand to run side by side (100, 85, 70 by default); each scales every hydrological unit’s irrigation demand.',
		units: '% of today’s demand',
		category: 'results'
	},
	{
		id: 'year-class',
		term: 'Water-year class',
		short: 'Complete water years ranked by natural flow at the outlet and split into terciles (dry, normal, wet) or, with 25 years or more, quintiles.',
		category: 'results'
	},
	{
		id: 'outcome-matrix',
		term: 'Outcome matrix',
		short: 'For each demand level and water-year class, how the river fared in those years of the record: a historical tally, not a forecast.',
		category: 'results'
	},
	{
		id: 'outcome-risk',
		term: 'Outcome risk cut-offs',
		short: 'Where a cell turns from lower to increasing to high risk: months met ≥ 90 % / ≥ 75 %, or days below the EWR ≤ 5 % / ≤ 20 %.',
		units: '%',
		category: 'results'
	},
	{
		id: 'seasonal-outlook',
		term: 'Seasonal outlook',
		short: 'The season run from the catchment’s state on the decision date with each past year’s weather, at a few demand levels.',
		category: 'results'
	},
	{
		id: 'analogue-years',
		term: 'Analogue years',
		short: 'The past water years whose weather a seasonal outlook replays: each one the record holds whole, except the season’s own.',
		category: 'results'
	},
	{
		id: 'outlook-season',
		term: 'Decision date and season end',
		short: 'The first and last days a seasonal outlook covers; it starts from the state the day before. 1 October to 30 April by default.',
		category: 'results'
	},
	{
		id: 'planning-figure',
		term: 'Planning figure and planning share',
		short: 'The highest demand level that met the requirement in full in at least the planning share of analogue years (80 % by default).',
		category: 'results'
	},
	{
		id: 'review-triggers',
		term: 'Review triggers',
		short: 'For each band of total dam storage on the review date, the highest demand level the past years supported for the rest of the season.',
		category: 'results'
	},
	{
		id: 'outlook-publish',
		term: 'Publishing an outlook level to farmers',
		short: 'The level the WUA has set, published from an outlook: each linked farmer sees what it gave their own unit, until the season ends.',
		category: 'results'
	},
	{
		id: 'firm-yield',
		term: 'Historical firm yield',
		short: 'The largest steady draft a dam meets on every day of the record, with the rest of the network running as modelled.',
		units: 'm³/day',
		category: 'results'
	},
	{
		id: 'yield-assurance',
		term: 'Yield at an assurance',
		short: 'The largest draft that fails in at most a set share of water years: 98 % fails in at most 1 year in 50. Firm allows no failure day.',
		category: 'results'
	},
	{
		id: 'draft-pattern',
		term: 'Draft pattern',
		short: 'How a yield’s draft is spread over the year: the same every day, or shaped like the unit’s own irrigation demand by month.',
		category: 'results'
	},
	{
		id: 'storage-yield-curve',
		term: 'Storage–yield curve',
		short: 'The yield at 11 dam capacities from 0 to twice the dam’s own, at the chosen pattern and assurance: what a raise would add.',
		units: 'm³ → m³/day',
		category: 'results'
	},
	{
		id: 'forecast-run',
		term: 'Forecast run',
		short: 'A run that carries on past the record on forecast rain. Its forecast days stay out of every total; the Forecast panel reads them alone.',
		category: 'results'
	},
	{
		id: 'unsaved-preview',
		term: 'Preview of unsaved edits',
		short: 'The last run worked out again with your unsaved edits laid over it, in your browser, and compared with it. Nothing is saved or stored.',
		category: 'results'
	},

	// ---- Goodness of fit ---------------------------------------------------------
	{
		id: 'nse',
		term: 'NSE (Nash–Sutcliffe efficiency)',
		short: '1 − Σ(obs − sim)² / Σ(obs − mean obs)². 1 is a perfect fit; 0 or below is no better than the observed mean.',
		units: 'dimensionless, −∞ … 1',
		category: 'fit',
		fields: ['stats.nse']
	},
	{
		id: 'pbias',
		term: 'PBIAS (percent bias)',
		short: '100 × Σ(obs − sim) / Σobs. Positive = the model is too dry; 0 is unbiased. The calibration panel says it in words.',
		units: '%',
		category: 'fit',
		fields: ['stats.pbias']
	},
	{
		id: 'rmse',
		term: 'RMSE',
		short: 'Root-mean-square error between simulated and observed daily flow, in m³/s. Smaller is better.',
		units: 'm³/s',
		category: 'fit',
		fields: ['stats.rmseM3s', 'stats.meanObservedM3s', 'stats.meanSimulatedM3s', 'stats.days']
	},
	{
		id: 'kge',
		term: 'KGE (Kling–Gupta efficiency)',
		short: 'Combines correlation, bias and variability into one score; 1 is perfect. Less peak-dominated than NSE.',
		units: 'dimensionless, −∞ … 1',
		category: 'fit',
		fields: ['stats.kge', 'stats.kgeR', 'stats.kgeAlpha', 'stats.kgeBeta']
	},
	{
		id: 'r-squared',
		term: 'R² (coefficient of determination)',
		short: 'Share of the day-to-day variation in observed flow that the simulation follows (0–1). Ignores volume errors.',
		units: 'dimensionless, 0 … 1',
		category: 'fit',
		fields: ['stats.r2']
	},
	{
		id: 'log-nse',
		term: 'log-NSE (low-flow fit)',
		short: 'NSE computed on the logarithm of flow, so it rewards a good fit in low flows rather than in floods.',
		units: 'dimensionless, −∞ … 1',
		category: 'fit',
		fields: ['stats.logNse']
	},
	{
		id: 'volume-error',
		term: 'Volume error',
		short: 'Simulated minus observed volume over the window, as a % of observed: PBIAS with the opposite sign (+ = too wet).',
		units: '%',
		category: 'fit',
		fields: ['stats.volumeErrorPct']
	},
	{
		id: 'fdc-signatures',
		term: 'Flow-duration signatures (high, mid-slope, low)',
		short: 'Bias of the top 2 % of flows, of the flow-duration curve’s slope from 20 to 70 % exceedance, and of the low 30 %. 0 is ideal.',
		units: '%',
		category: 'fit'
	},
	{
		id: 'annual-volumes',
		term: 'Annual water balance (calibration)',
		short: 'Observed and simulated volume per water year, over the days with an observation only, and how far apart they are.',
		units: 'Mm³ ; %',
		category: 'fit',
		fields: ['stats.annualVolumes']
	},
	{
		id: 'in-sample',
		term: 'In-sample (calibration period)',
		short: 'Scores on the same days the parameters were fitted on. Only then are they in-sample; otherwise the label says why not.',
		units: 'label',
		category: 'fit',
		fields: ['stats.fitStatus']
	}
];

const byId = new Map(TIPS.map((e) => [e.id, e]));
const byField = new Map(TIPS.flatMap((e) => (e.fields ?? []).map((f) => [f, e] as const)));

/** The tip for a field key (`node.damCapacityM3`) or an entry id (`ewr`). */
export function tipFor(key: string): HelpTipText | undefined {
	return byField.get(key) ?? byId.get(key);
}

/** Every field key that has help, sorted — the list to place HelpTips from. */
export function helpFieldKeys(): string[] {
	return [...byField.keys()].sort();
}
