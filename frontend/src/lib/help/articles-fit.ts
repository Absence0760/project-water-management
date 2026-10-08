// The glossary's articles for the "Goodness of fit" topic (category 'fit' in tips.ts).
// Same shape and rules as articles.ts, in the tips' order. A module of its
// own, like articles-data.ts, so the /help pages load the glossary's long
// text in chunks each under the bundle guard's per-chunk ceiling
// (vite.config.ts helpArticlesChunk); content.ts joins them.

import type { HelpArticle } from './types';

export const FIT_ARTICLES: Record<string, HelpArticle> = {
	'calibration-window': {
		long: 'Hydrologists usually calibrate on a period with reliable observations rather than the whole record; a b023 workbook has its own calibration date range and flow choice. Choose which observed series to compare against (gauge or logger); left empty, the gauge record is used if there is one, else the logger. A fit is scored at the outlet unless you pick a gauge inside the network that has a record attached (Scored at): the fit then compares the simulated flow at that gauge with its record, and so do the run’s calibration statistics; the outlet’s EWR test stays the outlet’s. The fit statistics and the annual volume table only count days inside this window.',
		aliases: ['calibration period', 'observed flow record'],
		related: ['calibration', 'nse'],
		source: 'b023 [Flow Calibration Cfg] date range and flow choice; docs/model.md §2.10, §2.10k'
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
	'auto-calibration': {
		long: 'The search is DDS (Tolson & Shoemaker 2007): it tries a set number of model runs, perturbing all parameters at first and fewer as it homes in, and never leaves each parameter’s allowed range. It runs several separate searches (Starts, default 5), each from its own seed, and keeps the best; nearly equal scores with scattered parameters mean the record can’t pin them down. Every run scores the whole model, hydrological units and dams included, against the observed record over the calibration window.\n\nPick what to optimise (the objective) by what the fit will feed, before seeing any score: KGE′ (the default) for the overall water balance, peaks and events; a year-balanced KGE′ when a few wet years would dominate; for EWR, low-flow and assurance decisions the mean of KGE′ on Q and on 1/Q when the low flows are well rated, or the non-parametric KGE when the rating at the extremes is uncertain; NSE on √Q or log Q mainly to compare with older studies. Don’t fit several objectives and keep the best-looking score: scores of different objectives don’t compare, and choosing after seeing them overfits. Check a low-flow fit for volume too, with the WR2012 fit statistics and KGE′ beside it.\n\nThe fit alone says little. Validation fits again on the first half of the record and scores the second half, then fits on the driest water years and scores the wettest (listed by water year, since they interleave). When the project has a reference gauge on another river covering those years, the years are ranked dry → wet by it, a regional index that is never scored; otherwise by the record’s own flow. The result also says how representative the record is: how many water years it covers and where their rain sits among the run’s long-term rain. With both a gauge and a logger record you can also score the fit against the record it wasn’t fitted to, a second instrument. Those columns are the honest measure. The main scores show a 90 % range in brackets, from resampling whole water years: a wide range means the record can’t pin the score down. A second table sets the model beside two simple benchmarks on the same days, the mean flow every day and each calendar day’s average flow; a model that can’t beat the second adds little beyond the seasonal cycle. With a short record that is mostly drought, the result says so: wet-year behaviour is then weakly constrained. Nothing is saved until you apply the result and save the form.',
		aliases: ['auto-calibration', 'optimiser', 'DDS', 'split-sample', 'differential split-sample', 'validation', 'KGE′'],
		related: ['calibration', 'gr4j', 'nse', 'calibration-objective', 'validation-tests', 'calibration-search'],
		source: 'Tolson & Shoemaker (2007); Klemeš (1986); Kling et al. (2012); docs/model.md §2.10b'
	},
	'calibration-objective': {
		long: 'The optimiser searches for the parameters that score best on one objective. Each weighs the record differently, so the same data can give different parameters:\n\nKGE′ (Kling et al. 2012, the default) combines correlation, bias and variability. It keeps the overall water balance and follows peaks and events. Simulating the mean flow every day scores about −0.41.\n\nYear-balanced KGE′ is the mean KGE′ over the water years with at least 30 scored days, so each year counts once and a few wet years can’t dominate the score.\n\nNon-parametric KGE (Pool et al. 2018) uses the Spearman rank correlation, the shape of the flow-duration curve and the bias. It reads the order and the distribution of the flows rather than their exact values, so it is less sensitive to rating error at the extremes.\n\nNSE on √Q weights medium flows; NSE on log Q (with 1 % of the mean observed flow added, so zero flows are allowed) weights low flows.\n\nThe mean of KGE′(Q) and KGE′(1/Q) scores half on the flows and half on their inverses, so recessions and low flows count as much as the peaks and the water balance, and neither end is traded away.\n\nHow to choose: by what the fit will feed, before you see any score. For the overall water balance, peaks and events, KGE′. When a few wet years would dominate the record, year-balanced KGE′. When the fit feeds an EWR, low-flow or assurance-of-supply decision, a low-flow-sensitive objective: the mean of KGE′(Q) and KGE′(1/Q) when the gauge’s low flows are well rated, or the non-parametric KGE when the rating at the extremes is uncertain. NSE on √Q or log Q mainly to compare with older studies that used them.\n\nNever run several objectives and keep the one whose score looks best. Scores of different objectives aren’t comparable (a KGE′ of 0.7 and an NSE on log Q of 0.7 say different things), and picking after seeing them is the overfitting the calibration rules exist to stop. To try several objectives honestly, list them in the calibration rules: every fit is then judged on the same selection score on a held-out test, chosen in advance.\n\nA low-flow fit should still be checked for volume: read the WR2012 fit statistics and KGE′, reported beside every fit, before trusting its annual flows.',
		aliases: ['objective function', 'KGE′', 'KGE prime', 'non-parametric KGE', 'year-balanced KGE', 'inverse flow', '1/Q', 'low-flow objective', 'which objective'],
		related: ['auto-calibration', 'kge', 'log-nse', 'calibration-selection-score', 'calibration-rules', 'wr2012-fit-statistics'],
		source: 'docs/model.md §2.10b (Objectives); packages/engine/src/calibrate/objective.ts; Kling et al. (2012); Pool et al. (2018); Fowler et al. (2018); Pushpalatha et al. (2012); Garcia et al. (2017); calibration research CR-3'
	},
	'validation-tests': {
		long: 'A score on the days the parameters were fitted to shows how well they fit, not how well they predict. Each validation test fits on one part of the record and scores another part it never saw:\n\nSplit-sample (Klemeš 1986): fit on the first half of the scored days, score the second half.\n\nDry → wet (differential split-sample): with at least 4 water years of 180 or more observed days, fit on the driest half of those years and score the wettest. It is the hardest test for a catchment modelled through drought. The years interleave, so the test is listed by water year, not as a date range. When the project has a reference gauge on another river, the years are ranked dry → wet by it, as a regional index that is never scored; otherwise by the record’s own flow.\n\nOther observed record (independent record): the parameters fitted to one record, scored against the other, for example the logger when the fit used the gauge. It costs no extra fit and tests the fit against a second instrument rather than a second period.\n\nExpect validation to score below the fit. A validation score more than 0.2 below its calibration score, too few years to test wet years, or wet years barely wetter than the dry ones each get a note. These columns, shaded in the results, are the honest measure of a fit.',
		aliases: ['split-sample', 'differential split-sample', 'DSST', 'dry → wet', 'held-out test', 'independent record', 'out-of-sample', 'validation'],
		related: ['auto-calibration', 'in-sample', 'calibration-selection-score', 'reference-gauge'],
		source: 'Klemeš (1986); docs/model.md §2.10b (Validation, always)'
	},
	'calibration-search': {
		long: 'Model runs per fit (default 1 500, from 50 to 10 000) is the budget of one DDS search: how many candidate parameter sets it runs the whole model with. Starts (default 5, at most 10) are separate searches of the whole record, each from its own seed; the best is kept. When two or more starts score within 0.01 of the best but a parameter spreads over more than 10 % of its range across them, the result says the record can’t pin that parameter down. The seed makes the search repeatable: the same data, engine version and seed give the same fit.\n\nMore runs or starts rarely rescue a poor fit. The record, not the search, usually limits it, and a flat ridge between X1 and X3 only gives an arbitrary point on the ridge more precisely. Under the calibration rules the seed, starts and model runs are rules too, so re-running with seed after seed until one scores well is a rule change, with its own revision.',
		aliases: ['budget', 'model runs', 'starts', 'multi-start', 'seed', 'evaluations'],
		related: ['auto-calibration', 'calibration-rules', 'fit-record'],
		source: 'docs/model.md §2.10b (Optimiser, Multi-start), §2.10j (Search); calibration research CR-2'
	},
	'fit-benchmarks': {
		long: 'A score means little without something to beat. The table scores two naive simulations on the same days as the model. The mean flow repeats the period’s mean observed flow every day (KGE′ about −0.41, NSE 0). The climatology gives each day the average observed flow on that calendar day, smoothed over a centred 15-day window so it keeps the seasonal cycle but not single storms.\n\nOn a split-sample or dry → wet validation period both benchmarks are built from that test’s calibration period and applied to the validation days, as a forecast made without the validation flows would be. In a strongly seasonal catchment the climatology is hard to beat, and a model that doesn’t beat it adds little beyond the seasonal cycle.',
		aliases: ['naive benchmark', 'climatology', 'day-of-year mean', 'mean-flow benchmark'],
		related: ['kge', 'nse', 'validation-tests'],
		source: 'Knoben et al. (2019); Schaefli & Gupta (2007); Gründemann et al. (2026); docs/model.md §2.10b (Score intervals and benchmarks)'
	},
	'score-interval': {
		long: 'Daily scores carry a large sampling error, mostly from a few wet spells. The range in brackets beside KGE′, NSE and the low/high-flow KGE′ comes from a block bootstrap: whole water years are drawn with replacement (days within a year aren’t independent), the resample is scored, 1 000 times, and the range is the 5th to 95th percentile. The draw is fixed, so the range is reproducible.\n\nIt needs at least 3 water years with 30 or more scored days each; with fewer there is no range. Three years is a floor, not a recommendation: a short record gives a wide range, which is the point. Two fits whose ranges overlap widely can’t be told apart by the record.',
		aliases: ['bootstrap', 'confidence interval', '90 % range', 'sampling uncertainty'],
		related: ['kge', 'validation-tests', 'record-representativeness'],
		source: 'Clark et al. (2021); docs/model.md §2.10b (Score intervals and benchmarks); calibration research CR-5'
	},
	'record-representativeness': {
		long: 'A few years from one climate state can’t support the flow’s variability, its seasonal pattern or a high-flow calibration, however good the scores look. So every fit states the record’s length and where its years sit in the long-term rain: the run’s own rain over the whole run, complete water years only (rain on at least 95 % of the days).\n\nEach scored water year shows its scored days, its rain and its percentile among the long-term years. Below the 33rd percentile it is dry, above the 67th wet, otherwise near normal; with fewer than 10 complete long-term years no year is classed. The summary gives the scored years’ mean rain against the long-term mean, and the notes say what the record can’t show, for example “every classed year dry: it can’t show how the model behaves in wet years”.',
		aliases: ['record length', 'dry years', 'wet years', 'rain percentile', 'terciles'],
		related: ['validation-tests', 'auto-calibration', 'score-interval'],
		source: 'docs/model.md §2.10b (How representative is the record); calibration research CR-34'
	},
	'uncertainty-bands': {
		long: 'One calibrated run gives one number for EWR days not met, curtailment and the annual volumes, but many parameter sets fit the record nearly as well, and the pan coefficient, the rain and the observed record are uncertain too. The ensemble samples them all: a Latin hypercube across the parameter bounds (never the optimiser’s own path), a shift of the pan coefficient (GR4J), station rain with CHIRPS infill or CHIRPS alone, and the gauge or the logger to judge against, where the project has both.\n\nA set is kept only if it passes the rule printed next to the bands: a skill score (KGE′ by default) on the first half of its record, the WR2012 flag on its natural flow, and the low-flow bias. The bands are the 5th to 95th percentiles of the kept sets; with fewer than 30 kept none are shown. The second half of the record is held out: the share of its observations inside the daily band is the coverage, and below 70 % the band is too narrow to trust.\n\nThe server fixes the rule and draws the seed before anything runs, keeps every ensemble started, and re-runs members to check a result before storing it, so a band can’t be picked after the fact. Run comparison bands the difference between two runs member by member: the extra impact of an application, with its own uncertainty.',
		aliases: ['GLUE', 'uncertainty', 'ensemble', 'Latin hypercube', 'behavioural', 'confidence band', 'coverage'],
		related: ['auto-calibration', 'wr2012-check', 'calibration-bounds'],
		source: 'Beven & Binley (1992); McKay et al. (1979); docs/model.md §2.10e; issue #4 phase 9'
	},
	'evidence-uncertainty-rule': {
		long: 'An ensemble’s bands depend on its rule: how many parameter sets it samples, how far it may roam, how far it shifts the pan coefficient, and the skill score, WR2012 flag and low-flow bias a set must pass to be kept. Tried after the bands are seen, those choices could be tuned until a band looks kind to an application. So the project declares the rule first, under Settings › Evidence. An evidence report then cites the first complete ensemble whose options match the rule exactly, and names it; with no rule declared it cites none. The History tab records who declared or changed the rule and when, and a change means a new ensemble must be run to it before a report can cite one. The rule starts from the ensemble’s own defaults: 300 members, typical bounds, pan ±0.1, KGE′ at least 0.5, WR2012 flags up to “query”, low-flow bias within ±50 %.',
		aliases: ['evidence rule', 'declared rule', 'pre-declared thresholds', 'acceptance thresholds'],
		related: ['uncertainty-bands', 'calibration-rules', 'calibration-bounds'],
		source: 'docs/design/evidence-report.md ER3, G4; issue #71'
	},
	'calibration-bounds': {
		long: 'A short or drought-heavy record often can’t pin down X1 (production store) and X3 (routing store): the fit lands outside where GR4J parameters usually sit, because too little of the record constrains them. "Typical" restricts the search to Perrin et al.’s (2003) 80 % range over 429 catchments (X1 100–1200 mm, X3 20–300 mm, X4 1.1–2.9 days), which can make an under-constrained fit land somewhere plausible instead of at an extreme of the wide range. It is a constraint on the search, not evidence the catchment truly falls inside it: read the fit and validation scores either way, and prefer the wide range when the record constrains the parameters well. Recorded with the fit record.',
		aliases: ['typical range', 'Perrin range', 'wide bounds', 'X1 range', 'X3 range'],
		related: ['auto-calibration', 'gr4j', 'fit-record'],
		source: 'Perrin, Michel & Andréassian (2003); issue #4 phase 6'
	},
	'wr2012-penalty': {
		long: 'When it is on, Fit automatically adds weight × |ln(simulated natural MAR ÷ scaled WR2012 MAR)| to the loss it minimises, so a wetter and a drier MAR by the same factor cost the same. It only touches the annual volume, not the daily pattern. When two published natural-MAR estimates disagree, tick “Use a MAR band instead of one target”: the penalty is then 0 inside the band (already at the modelled catchment’s scale) and weight × |ln(simulated MAR ÷ the nearer bound)| outside it.\n\nThe result shows the fit with the penalty and the same fit without it, with the weight, so you can see what matching WR2012 costs the fit to the observed record. A short or impacted observed record can disagree with WR2012 for good reasons; the penalty is a nudge, not a constraint.',
		aliases: ['soft penalty', 'MAR penalty', 'regularisation'],
		related: ['wr2012-check', 'auto-calibration'],
		source: 'docs/model.md § WR2012 check; issue #4 phase 8',
		countries: ['ZA']
	},
	'wr2012-fit-statistics': {
		long: 'South African practice with the WRSM/Pitman model judges a calibration on five statistics of observed and simulated flow, beside the hydrograph and the flow-duration curve. The app reports them for the fit, each validation test and every run’s calibration, on the same scored days as the other statistics.\n\nThe scored days are summed per calendar month; a month counts when at least 90 % of its days are scored, and a hydrological year (October to September) only when all 12 months count. Over those complete years: MAR (mean annual runoff), the mean of log10 annual runoff, the standard deviation and the log standard deviation of annual runoff, and a seasonal index (how unevenly the flow falls across the months: 0 is even, 183 all in one month). Each has a % difference, simulated against observed (+ = simulated higher), and is within its band when the difference is smaller than it: MAR 4 %, mean of logs 4 %, SD 6 %, log SD 6 %, seasonal index 8 %.\n\nThose bands, and the seasonal index’s exact form, are yet to be confirmed against the WR2012 manuals, so the table calls them indicative bands until they are. The table never changes a result and no fit optimises it; it is the volume check to read beside a fit to low flows.',
		aliases: ['five statistics', 'WRSM statistics', 'Pitman statistics', 'seasonal index', 'good fit band', 'mean of logs'],
		related: ['wr2012-check', 'calibration-objective', 'kge'],
		source: 'Bailey & Pitman (2016); Ndiritu (2009); Dabrowski (2025) Table 4; docs/model.md § The WR2012 five-statistic table; calibration research CR-28',
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
		long: 'Each pass of calibrate → review → refit normally needs a person, who chooses the years to leave out, the forcing and the fit to keep after seeing the scores. Chasing the score that way overfits, and an assessor can’t tell a principled choice from a convenient one. Calibration rules make those choices in advance. A water year is left out when more than a set share of its observed days carry a quality flag, and each such exclusion names the rule as its reason. Each listed pan coefficient is fitted with each set of bounds and objective, every fit with the split-sample and dry → wet tests, by a search (seed, starts, model runs) that is part of the rules too. The fit kept is the one with the best score on a held-out test, never the in-sample score, among those whose natural MAR is inside the WR2012 band (when there is a reference) and whose parameters are in the typical range. If none passes, none is kept, and the reasons are listed. Choose the objectives and the selection score by what the fit will feed, as for any fit: KGE′ for the overall water balance, a low-flow-sensitive score for EWR and licensing decisions.\n\nThe server runs the saved rules, one background job per fit, and computes every score itself. Applying the kept fit is the server’s too: it saves the parameters with a record of the rules and every fit tried, runs the model and, when the rules say so, the uncertainty ensemble around the fit. Each change to the rules raises their revision, and a fit made under an older revision can’t be applied, so a rule can’t be adjusted once its result is seen. The rules can also run by themselves when new data arrives, and apply their fit while signed off. The default rules are drafts until the hydrologist signs them off: they type their name as a signature, and saving dates it and records their account in the History tab. A fit picked under draft rules is marked as not evidence.',
		aliases: ['automated calibration', 'pre-declared rules', 'rule set', 'selection rule', 'sign-off'],
		related: ['auto-calibration', 'calibration-objective', 'calibration-selection-score', 'flagged-year-rule', 'calibration-rule-filters', 'rules-on-new-data', 'quality-flags', 'fit-record', 'calibration-bounds'],
		source: 'docs/model.md §2.10j; issue #153; calibration research, “Automated calibration with pre-declared rules”'
	},
	'calibration-selection-score': {
		long: '“Keep the fit with the best … on the held-out test” is what picks the kept fit. Every fit the rules try (each pan coefficient × bounds × objective) is scored on this one score, on this one test, so fits made with different objectives are compared on common ground; the best that passes the filters is kept, the first on a tie. It is never an in-sample score: a fit whose record doesn’t allow the chosen test isn’t kept, rather than falling back to its score on the fitted days.\n\nThe tests are those every fit runs. Dry → wet (the default) fits on the driest half of the water years and scores the wettest half. Split-sample fits on the first half of the scored days and scores the second. The other observed record scores the fit against the second instrument (the logger when the fit used the gauge), so it needs both records.\n\nMatch the score to the use, as you would the objective: the default, KGE′ on the dry → wet test, for the overall water balance; for EWR or licensing decisions a low-flow-sensitive score (the mean of KGE′(Q) and KGE′(1/Q), or the non-parametric KGE when the low-flow rating is uncertain) on the dry → wet test. Decide it with the rules, before any fit is seen; changing it afterwards is a rule change, with a new revision.',
		aliases: ['keep the fit with the best', 'held-out test', 'selection rule', 'selection test'],
		related: ['calibration-rules', 'calibration-objective', 'validation-tests', 'calibration-rule-filters'],
		source: 'docs/model.md §2.10j (Selection), §2.10b (Validation, always); packages/engine/src/calibrate/rules.ts'
	},
	'flagged-year-rule': {
		long: 'Over the calibration window and outside the stored exclusions, each water year’s share of its observed days that carry a quality flag (above or below the gauged range, suspect or infilled) is counted. A year above the share is left out of every fit the rules make, on top of the project’s own calibration exclusions, with a reason that names the rule and the count, for example “200 of 365 observed days flagged (54.8 %), more than 20 %”. Inside the years kept, the quality flags’ own treatments still decide which days are scored. Untick it to leave no year out by rule.',
		aliases: ['maximum flagged share', 'exclusion rule', 'leave out a water year'],
		related: ['calibration-rules', 'quality-flags', 'calibration-exclusions'],
		source: 'docs/model.md §2.10j (Exclusions), §2.10h'
	},
	'calibration-rule-filters': {
		long: 'Natural MAR inside the WR2012 band: the simulated natural MAR with the fitted parameters must sit inside the calibration penalty’s MAR band when both ends are set, otherwise within the WR2012 check’s query threshold. Without a WR2012 reference the filter can’t be applied, and the report says so rather than failing every fit.\n\nParameters in the typical range: every fitted parameter inside Perrin et al.’s (2003) 80 % range, the typical bounds.\n\nBoth are on by default. A fit that fails either isn’t kept, whatever its score, and the report lists why. If no fit passes, none is kept: change the rules, not the result.',
		aliases: ['MAR filter', 'typical range filter'],
		related: ['calibration-rules', 'wr2012-check', 'calibration-bounds', 'calibration-selection-score'],
		source: 'docs/model.md §2.10j (Filters)'
	},
	'rules-on-new-data': {
		long: 'When new days of observed flow or rain arrive (an upload, a feed or an ingest), the server can run the saved calibration rules by itself, at most once per debounce. “Run the rules and keep the report” leaves the result for an editor to apply. “Run the rules and apply the kept fit” also saves the kept fit and runs the model, but only while the rules are signed off; under draft rules it only reports.\n\nThe tick box beside it decides what applying a kept fit does next: run the model with it and the uncertainty ensemble around it, centred on the fit’s bounds and objective, so the range of results from parameter sets that fit nearly as well comes with every new fit.',
		aliases: ['on new data', 'automatic recalibration', 'after a kept fit'],
		related: ['calibration-rules', 'uncertainty-bands'],
		source: 'docs/model.md §2.10j (After, New data)'
	},
	'fit-record': {
		long: 'The record keeps the runoff model, objective, bounds, seed, starts, model runs per fit, calibration window, exclusions, the record fitted to, the forcing (pan coefficient, A-pan, CHIRPS bias correction and the rain-gap settings), the engine version and the time, with every score: the in-sample fit and the split-sample, dry → wet and independent-record validation. The same inputs, engine version and seed give the same fit, so anyone can reproduce it. Each run keeps the record in effect, so its results show which fit produced their parameters. Change a fitted parameter by hand and the record is marked “Parameters edited since fit”: it no longer describes them. Change the forcing and it is marked “Forcing changed since fit”: GR4J’s parameters are only valid for the evaporation and rain they were fitted under. The in-sample score is the fit to the calibration period; judge the parameters by the validation scores.',
		aliases: ['fit provenance', 'seed', 'parameters edited since fit'],
		related: ['auto-calibration', 'calibration-exclusions'],
		source: 'docs/model.md §2.10b'
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
	'fdc-signatures': {
		long: 'Reported with every fit beside the efficiency scores, after Yilmaz et al. (2008). Each compares the simulated flow-duration curve with the observed one on the same days. High flows: the volume of the top 2 % of flows. Mid-slope: the slope of the curve between 20 % and 70 % exceedance, in log space, which says whether the model’s flows are as flashy or as steady as the river’s. Low flows: the bottom 30 % of the curve, in log flows above its minimum.\n\nThey score the shape of the flow distribution, not the timing, so a fit can match them with the days in the wrong order. Read them as a check on whichever end of the curve the decision depends on: the low-flow signature for an EWR or low-flow question, the high-flow one for floods and dam spills.',
		aliases: ['%BiasFHV', '%BiasFMS', '%BiasFLV', 'flow duration curve', 'FDC', 'signature'],
		related: ['calibration-objective', 'volume-error', 'plausibility-low-flow'],
		source: 'Yilmaz, Gupta & Wagener (2008); docs/model.md §2.10b (Reported with every fit)'
	},
	'annual-volumes': {
		long: 'Each water year (1 October to 30 September) adds up the observed and the simulated flow over the same days: those with an observation inside the calibration window and outside the exclusions. A year with observations on less than 90 % of its days in the window is marked part year: it still compares like with like, but it is not that year’s runoff.\n\nThe last column is the simulated volume against the observed, as a %; the foot of the table is the whole window, the volume error. A model that is right on average can still be too wet in dry years and too dry in wet ones, which this table shows and the scores hide.',
		aliases: ['annual volumes', 'yearly volumes', 'part year', 'water year volumes'],
		related: ['volume-error', 'pbias', 'water-year'],
		source: 'docs/model.md §2.10; packages/engine/src/project.ts AnnualVolume'
	},
	'in-sample': {
		long: 'Scores on the days a model was fitted on show how well it fits, not how well it predicts: judge fitted parameters by the fit’s validation scores. A run’s calibration scores are labelled in-sample only when its parameters came from Fit automatically for its runoff model, unchanged since, with the same calibration window, exclusions and flow record (engine 0.39.0).\n\nOtherwise the label says why not: “parameters not fitted” (set by hand, imported or left at their defaults), “parameters edited since the fit”, or “not the period fitted” (another window, other exclusions or the other record). Parameters tuned by hand against the record flatter the model as much as a fit does, so read hand-calibrated scores the same way. A run made before engine 0.39.0 says only “calibration period”.',
		aliases: ['in sample', 'calibration period', 'parameters not fitted', 'out-of-sample'],
		related: ['calibration', 'nse', 'pbias'],
		source: 'docs/model.md §2.10; docs/calibration-research.md'
	}
};
