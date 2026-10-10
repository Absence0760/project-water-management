// The glossary's articles for the "Input data" topic (category 'data' in
// tips.ts): the fuller text articles.ts holds for every other topic, same
// shape, same rules, in the tips' order. A module of its own so the /help
// pages load the glossary's long text as two chunks, each under the bundle
// guard's per-chunk ceiling (vite.config.ts helpArticlesChunk, issue #66);
// content.ts joins them.

import type { HelpArticle } from './types';

export const DATA_ARTICLES: Record<string, HelpArticle> = {
	// ---- Input data -----------------------------------------------------------
	'rain-catchment': {
		long: 'Each day the model uses the first available of catchment, CHIRPS and forecast rainfall. Missing days are left empty, not zero.',
		aliases: ['rain', 'rainfall', 'precipitation'],
		related: ['chirps', 'rain-threshold', 'rain-final'],
		source: 'b023 Flow data'
	},
	'rain-final': {
		long: 'One value per day from the first source that has one. CHIRPS is the corrected value when the CHIRPS bias correction is on. Rain used is the same rain, with blanks as 0; the rain threshold only applies to irrigation demand. A day with no value from any source is left empty; the model treats it as dry.\n\nIn the daily CSV export it sits beside CHIRPS as uploaded and bias-corrected CHIRPS, so the filled days can be checked against both.',
		aliases: ['rain after gap filling', 'patched rainfall', 'infilled rainfall'],
		related: ['rain-catchment', 'chirps', 'chirps-bias', 'rain-threshold'],
		source: 'docs/model.md §2.4, §2.4b'
	},
	'chirps': {
		long: 'Useful to fill gaps or extend a short gauge record. At catchment scale CHIRPS can read well below (or above) a local gauge, so by default the model scales it by a factor per calendar month, fitted where both records have a reading, on the days it fills in (see CHIRPS bias correction).',
		aliases: ['satellite rainfall'],
		related: ['rain-catchment', 'chirps-bias'],
		source: 'b023 Flow data; docs/model.md §7'
	},
	'chirps-bias': {
		long: 'For each calendar month the factor is the catchment rain divided by the CHIRPS rain, summed over the days both have a reading. Suspect catchment rain is left out: a water year far below CHIRPS as a whole, and one by one the days of flagged zero runs, of periods listed as missing (see Zero-rain runs) and of multi-day accumulation windows (see Multi-day rain accumulations). Zero runs you keep dry stay in, as confirmed readings, unless CHIRPS reads a lot of rain over them; then that water year stays out and the run warns. A month with fewer than 90 shared days, or less than 50 mm of CHIRPS on them, uses the factor pooled over all months; with too little overlap for even that, CHIRPS is used as it is and the run says so. Factors are kept between 0.25 and 4.\n\nOnly CHIRPS that is actually used is scaled. Catchment rain and forecast rain are never changed. Each run lists the factors and the number of days corrected in its warnings, and outputs the corrected CHIRPS (CHIRPS × its month\'s factor, on every day, not only the days it filled in) as a daily series beside CHIRPS as uploaded, with the day\'s monthly factor in the next column, in the series explorer and the daily CSV export. The run\'s summary CSV lists the 12 factors with their source (own month, pooled, or none) and the shared days behind each, then the water years and days left out of the fit and why. Comparing runs notes when the factors differ. Rain used shows which value the model took each day.\n\nChoose "Raw CHIRPS" only if the CHIRPS series you loaded is already corrected to the catchment; otherwise it would be corrected twice. Not in the workbook, which used raw CHIRPS.',
		aliases: ['bias correction', 'CHIRPS factor', 'rain scaling'],
		related: ['chirps', 'rain-catchment', 'chirps-fit-period', 'chirps-quantile-map'],
		source: 'Not in the workbook; docs/model.md §2.4b; engine-audit.md B1'
	},
	'chirps-fit-period': {
		long: 'When the double-mass check finds that the catchment / CHIRPS ratio changed part-way through the record, one set of factors fitted over every year is a blend of the eras, so a gap in one era is filled at the wrong ratio. The fit period decides which years the factors come from.\n\n**Whole record** (the default) fits one set over every year, as before. **Listed water years** fits one set per range you list, each only on its own years and each with a reason; years outside every range are left out of every fit, and a gap there takes the nearest range (the later one on a tie). Put each break where the station records or the CHIRPS version say it is.\n\n**Propose from the double-mass breaks** fills the list with one range per segment the check finds. It is only a proposal: the check\'s break years are estimates that can be a year or two off (the five-year minimum segment and dry years move them), and a break that is partly CHIRPS\'s (a product change, or drift against other products) moves them too. Check each range against the station history and rewrite its reason before saving. Split only when the step is large against the standard error of each era\'s ratio (its year-to-year scatter over the square root of the number of years), or a Pettitt or Buishand test calls it, not merely against the year-to-year scatter.\n\nWithin each range the usual rules hold: a month needs 90 shared days and 50 mm of CHIRPS, else it takes its range\'s pooled factor, else the factor over all the listed ranges together; factors stay between 0.25 and 4. Periods listed as missing under Zero-rain runs, and flagged zero runs that CHIRPS fills, stay out of every fit. Each run names the range whose factors filled each gap and the years each set was fitted on; the summary CSV lists every range\'s factors; comparing runs notes a changed fit period, range or reference window; and a fit record flags "Forcing changed since fit" when the fit period changes. Not in the workbook.',
		aliases: ['per-segment factors', 'fit period', 'CHIRPS fit ranges', 'rain homogenisation'],
		related: ['chirps-bias', 'double-mass'],
		source: 'Not in the workbook; docs/model.md §2.4b, §2.10a; calibration-research.md § Rain forcing; issue #40'
	},
	'chirps-quantile-map': {
		long: 'A monthly factor fixes the level of CHIRPS but not its shape: a 0.05° cell is wet on more days than a gauge, with fewer heavy falls, and a runoff model turns heavy days into flow. With the quantile map on, the CHIRPS that fills a gap is reshaped too. It is fitted per calendar month on the same shared days as the factors (the fit period). Where CHIRPS × factor is wet (at or above the wet-day threshold, 1 mm by default) more often than the catchment rain, its own threshold is raised until the two wet-day rates agree; its wet days are then mapped, quantile by quantile, onto the catchment\'s wet days, its days below the threshold go dry, and every calendar month is scaled back to its factor-corrected total. So the frequency and the spread of the falls change, and the volume doesn\'t, month by month.\n\nA month with fewer than 30 wet days on either side uses its three-month season; a season too thin keeps the factor alone, and the run warns and names the months. A CHIRPS series drier than the catchment keeps the wet-day threshold: the map can\'t make wet days. It applies only with bias correction on, and it is off by default, so a run without it is unchanged. Each run lists what it mapped in its warnings and its summary CSV, outputs CHIRPS after the map as a daily series, and pins the fit with the factors; comparing runs and a fit record both flag a change. Not in the workbook.',
		aliases: ['quantile mapping', 'distribution mapping', 'wet-day frequency', 'local intensity scaling', 'LOCI'],
		related: ['chirps-bias', 'chirps-fit-period', 'chirps'],
		source: 'Not in the workbook; Schmidli et al. (2006); Teutschbein & Seibert (2012); docs/model.md §2.4b; calibration-research.md CR-23'
	},
	'double-mass': {
		long: 'Two records of the same rain should keep a steady ratio, so cumulative catchment rain plotted against cumulative CHIRPS is a straight line. A kink means one of them changed: a rain gauge opened, closed or moved, the catchment average was built differently, or CHIRPS changed. The check adds up each water year on the days both have a reading (leaving out zero runs treated as missing and periods listed as missing), and needs 10 years with at least 300 such days and 100 mm of CHIRPS. It fits up to two breaks, each segment at least 5 years long, and reports a break only when the slope changes by 20 % or more and a statistical test (Pettitt, or the gain in fit) says it is more than one odd year.\n\nThe chart shows the curve, the whole-record line (dashed) and the segments (solid), with each segment\'s slope, and below it how far the curve departs from the whole-record line each year. The check alone changes nothing: a break doesn\'t say which record is wrong, so the CHIRPS factors are fitted over the whole record unless Settings → CHIRPS fit period lists water-year ranges to fit them on (it can propose ranges from these breaks for you to check). A run warns when CHIRPS fills gaps in a segment whose ratio differs by 20 % or more from the ratio of the factors that filled them, because those days may then run too wet or too dry; with listed ranges it names the range whose factors filled each gap. The run\'s summary CSV has the table.',
		aliases: ['double mass curve', 'homogeneity', 'rain gauge change', 'station change', 'CHIRPS ratio drift'],
		related: ['chirps-bias', 'chirps', 'rain-catchment', 'chirps-fit-period'],
		source: 'Not in the workbook; Searcy & Hardison 1960; docs/model.md §2.10a; calibration-research.md CR-20'
	},
	'zero-rain-runs': {
		long: 'A zero is a reading, so a gap in the rain record exported as zeros stops CHIRPS filling it, and the catchment runs dry for weeks in its wettest months. The Data tab flags these runs: 60 or more zero days in the series\' six wettest months. By default a run treats the days of every flagged run as blank, so bias-corrected CHIRPS, then forecast rain, stand in, exactly as on any blank day. The rain series you uploaded is never changed.\n\nIf the hydrologist confirms a flagged run was a real dry spell, add it under **Keep dry**: its days stay 0 mm, and they count in the CHIRPS factor fit as readings (a flagged run that is filled is left out of the fit day by day). If bias-corrected CHIRPS reads more than the larger of 50 mm and a quarter of the catchment\'s usual annual rain over a kept-dry run, the keep-dry looks doubtful: each run warns and leaves that water year out of the fit. **Run as recorded** keeps every flagged run dry, as the workbook does. **Also treat as missing** covers other bad periods whatever they read, such as the gap days inside a year that reads far below CHIRPS. Those days are also left out of the CHIRPS factor fit.\n\nEach run lists every period it filled, the rain that replaced it and any days with nothing to fill them, in its warnings and in the summary CSV. The daily column "Catchment rain treated as missing" is 1 on each day filled. Comparing runs lists any change to these settings. Not in the workbook.',
		aliases: ['missing rainfall', 'zero rain', 'rain gaps', 'keep dry', 'infilled rainfall days'],
		related: ['rain-catchment', 'chirps-bias', 'rain-final', 'rain-accumulations'],
		source: 'Not in the workbook; docs/model.md §2.4c; engine-audit.md B2'
	},
	'flow-gap-filling': {
		long: 'A gauge or logger record has gaps: a flood took the logger, a download was missed. Settings → Calibration record → Flow gaps can fill them, in a run only: the record you uploaded is never changed, and nothing is filled until you turn it on for a record.\n\n**Interpolation** fills a gap of up to a few days (5 by default) between the readings either side, on a log scale: a recession falls by a steady fraction a day, so a log-scale line follows it where a straight one would overstate the flow. A longer gap is never interpolated, because a flood inside it would be missed.\n\n**From another record** fills a longer gap (up to 60 days by default) from the other record on the same river (the logger for the gauge, or the reverse) or from the reference gauge on a neighbouring river, scaled by the ratio of the two records\' totals on the days both have a reading. The donor is refused when they share fewer days than the minimum (365 by default) or their daily flows don\'t rise and fall together (a correlation below 0.5). A filled day is never higher than the highest the record itself ever measured.\n\nBy default no statistic reads a filled day: the calibration scores, the fit, the EWR test on the observed record and the plausibility checks use measured days only, and the filled days are shown on the Data tab\'s chart, in the run\'s warnings, and in the daily columns "Observed flow gap fill" (1 = interpolated, 2 = from another record) and "Observed flow: filled gap days only". Each filled day is flagged infilled; to score them, set Infilled days to "Score as recorded" under the quality flags (one control for the fit and the run). A fit that scored filled days is flagged when the filling changes. Not in the workbook.',
		aliases: ['infill', 'infilling', 'missing flow', 'patch flow record', 'donor gauge', 'interpolate gaps'],
		related: ['zero-rain-runs', 'series-source'],
		source: 'Not in the workbook; docs/model.md §2.10i; issue #66'
	},
	'series-source': {
		long: 'Each series can say where its values came from: a DWS station number, the agency, the file, or the data feed that wrote it. The Upload form asks for it, and an editor can change it on the Data tab. The unit a file was given in (l/s, ML/day, cm …) and the factor that converted it to the unit the app stores (m³/s for flow, mm for rain) are recorded by the upload itself: a series stored in m³/s that was uploaded in l/s says so, which is how a thousandfold unit mistake is found. Days merged into a series that already has values keep the series\' own source and unit.\n\nThe model never reads either. A run records them with its inputs, so comparing runs says when a series now comes from somewhere else, and a fit records its calibration record\'s, so a fit is flagged when that record\'s source or unit changes.',
		aliases: ['provenance', 'station number', 'where the data came from', 'unit conversion', 'original unit'],
		related: ['flow-gap-filling'],
		source: 'docs/data-model.md § Series source and unit (107_series_source.sql)'
	},
	'rain-accumulations': {
		long: 'When nobody reads the rain gauge for a few days, the unread days are often entered as 0 (or left blank) and the whole total on the day it was read. The total is right; the days are wrong: a dry spell, then one day far wetter than it was. Viney & Bates (2004) found these untagged accumulations throughout long daily records.\n\nA run flags a reading as an accumulation when it is at least 20 mm, follows at least 3 days of 0 or blank catchment rain (a stretch of blank days counts only up to 7 days, from engine 1.70.0), bias-corrected CHIRPS reads less than a quarter of it on that day and the days either side (CHIRPS can be a day early or late), and CHIRPS over the days before (leaving out the day just before) reads at least half of it. The window is those days, at most the last 92, plus the reading day. A storm after a real dry spell is left alone: CHIRPS is dry over the days before it.\n\nMore than 7 blank days in a row is an outage (a logger down, or a gauge nobody read for weeks), and days listed as missing count as blank here: it ends the window, so a window never reaches back across it. A reading of 20 mm or more straight after an outage, on a day CHIRPS was nearly dry after CHIRPS rained over the outage, could be the outage\'s rain or one day\'s, and the record can\'t say which. From engine 1.70.0 the run sets such a reading aside: CHIRPS fills its day as it fills the outage, it is left out of the CHIRPS factor fit, and the run warns, naming it. Spreading it would put weeks of CHIRPS rain under one reading; keeping it on its day would count an unread gauge\'s rain twice. Before 1.70.0 blank days counted like zeros however many there were, and such a reading was spread over the outage\'s last 92 days.\n\nBy default the run keeps the recorded total and spreads it over the window in proportion to bias-corrected CHIRPS. Those days are not also filled from CHIRPS as a zero run (which would count the rain twice), and they are left out of the CHIRPS factor fit. If CHIRPS reads no rain over a window at all, its total stays on the reading day. The rain series you uploaded is never changed.\n\nIn Settings → Rain gaps and CHIRPS, **Accumulated readings** chooses between spreading (the default) and **Run as recorded (one day)**, as the workbook does. **Keep as recorded** lists readings you know were one day\'s rain (a thunderstorm CHIRPS missed, or a logger back from a fault on a stormy day): a detection or a set-aside reading whose day falls in one stays as recorded, and counts in the CHIRPS fit. **Also spread** lists windows by hand, ending on the reading day: list the days an unread gauge’s total covers to spread a set-aside reading over them. A period listed as missing, or a keep-dry period, wins over a detection that touches it; listing an outage as missing doesn\'t stop the reading after it being set aside. Each run lists every window in its warnings and its summary CSV, and the daily column "Catchment rain from a multi-day accumulation" is 1 on each day spread. Comparing runs lists any change to these settings. Not in the workbook.',
		aliases: ['accumulated rainfall', 'untagged accumulation', 'multi-day total', 'weekend rain', 'gauge not read', 'disaggregation'],
		related: ['zero-rain-runs', 'chirps-bias', 'rain-catchment', 'rain-final'],
		source: 'Not in the workbook; Viney & Bates 2004; docs/model.md §2.4d; engine-audit.md B4'
	},
	'rain-source': {
		long: 'Use a rain-source period when the catchment series stops describing the catchment for a stretch of years (a gauge moved or closed, the average was rebuilt) and another gauge covers it, such as an in-catchment automatic station. Within the period, each day\'s rain is that gauge\'s reading × its month\'s factor; the catchment series is not used there and stays out of every factor fit.\n\n**Factors.** Normally 12 fixed values (Oct … Sep, 0.25–4) with where they came from: who fitted them, over which dates, and how. Or **Fit**: the gauge is scaled to the catchment series\' level in a reference era you name, measured against a reference series that doesn\'t contain the gauge: factor = (catchment ÷ reference in the reference era) ÷ (gauge ÷ reference in the period). Use a gauge-free reanalysis such as ERA5 as the reference. CHIRPS is refused once you tick "CHIRPS ingests this gauge", because the fit would then be circular.\n\n**Gaps.** A day the gauge has no reading takes CHIRPS × the CHIRPS factors by default, or a named reanalysis × factors fitted on the catchment series over its own era; then forecast rain. With "CHIRPS ingests this gauge" ticked, name a reanalysis fallback.\n\n**Daily intensity.** A factor fixes the monthly volume, not how the rain falls: one automatic gauge has more intense days than an average of several gauges, and GR4J turns heavier days into more flow. Every run reports the share of the period\'s rain on heavy days (20 mm or more) against the catchment series\' share in a reference era, and warns when they are more than 5 points apart. Tick "Quantile-map its wet days" to map the gauge\'s wet days (at or above the wet-day threshold, 1 mm by default) onto the catchment series\' wet days over the water years you name, month by month (a month with fewer than 30 wet days on either side uses its three-month season; a season still that thin keeps the factor alone). Each month\'s total stays exactly what the factor gives, so the map changes the spread of the falls, not the volume, and not how many days are wet.\n\nEach run warns once per period with the day counts and factors, adds a daily "Rain source" column (0 catchment, 1 alternative gauge, 2 CHIRPS, 3 reanalysis, 4 forecast) and a block in its summary CSV, and comparing runs sets the periods side by side. A saved calibration is flagged "forcing changed since fit" when the periods change. Not in the workbook.',
		aliases: ['rainSource', 'replacement gauge', 'alternative gauge', 'automatic station', 'splice rain records', 'era replacement', 'quantile mapping', 'heavy days', 'daily intensity'],
		related: ['rain-catchment-alt', 'rain-reanalysis', 'chirps-bias', 'zero-rain-runs'],
		source: 'Not in the workbook; docs/model.md §2.4e; docs/calibration-research.md § Rain forcing'
	},
	'rain-catchment-alt': {
		long: 'Upload it as its own series kind. Outside every rain-source period (Settings → Rain source) the model never reads it. An automatic station often logs hourly: upload the hourly file and pick how to add it up into days. Manual gauges are read at 08:00 and the reading booked to the day before, so choose 08:00 to 08:00 to line it up with a manual record; the series records the choice. Its product and version (e.g. the station network) can be recorded with it.',
		aliases: ['automatic weather station', 'AWS', 'replacement gauge', 'second gauge'],
		related: ['rain-source', 'rain-catchment'],
		source: 'docs/model.md §2.4e'
	},
	'rain-reanalysis': {
		long: 'ERA5\'s precipitation is a model forecast that assimilates no rain gauges outside the United States, so a local gauge change can\'t enter it: a good yardstick for scaling a replacement gauge to the catchment record\'s level. The model reads it only when a rain-source period names it. Free without an account from the Open-Meteo archive API.',
		aliases: ['ERA5', 'reanalysis', 'gauge-free reference'],
		related: ['rain-source', 'chirps-bias'],
		source: 'docs/calibration-research.md § Rain forcing'
	},
	'evap-apan-daily': {
		long: 'Upload it on the Data tab as its own series kind (mm, cm or inches, stored in mm). Where it has a value it is that day\'s A-pan for crop demand (A-pan × crop factor), dam evaporation (A-pan × lake factor) and, when GR4J\'s PE is pan coefficient × A-pan, the runoff model. Days without a value, with a negative value or outside the record use the monthly A-pan means (Settings → Demand), and each run says how many days did. A monthly PE row for GR4J replaces both for the runoff model only.',
		aliases: ['daily pan evaporation', 'station evaporation', 'Class A pan record', 'daily evaporation'],
		related: ['apan', 'pan-coefficient', 'dam-evaporation'],
		source: 'Not in the workbook; docs/model.md §2.3a'
	},
	'rain-forecast': {
		long: 'Used on days neither catchment rain nor CHIRPS has a value. An ordinary run stops where the observed record ends, so forecast rain past it only reaches a forecast run, whose summaries leave those days out. Treat results on forecast days as indicative only.',
		related: ['rain-catchment'],
		source: 'b023 Flow data'
	},
	'observed-flow': {
		long: 'Converted to m³/day and compared with the simulated outflow on days both exist. The calibration record (Settings & calibration, “Compare with”) picks which one; left on the default, the gauge record is used, else the logger, and a run with both says so in its warnings.\n\nWith both records, the hydrograph shows both (engine 0.39.0): the calibration record as a solid line, labelled “calibration record”, and the other dashed. Only the calibration record is scored.',
		aliases: ['gauge flow', 'logger flow', 'measured flow', 'DWS gauge'],
		related: ['calibration', 'nse'],
		source: 'b023 Flow data'
	},
	'reference-gauge': {
		long: 'A workbook’s gauge column may hold a record measured elsewhere, or one rescaled for part of its span. Such a record is not observed flow for the modelled river, so it is kept as its own series kind: runs never calibrate or validate against it, never compare it with the logger and never use it in the EWR comparison. Use it to rank wet and dry years: Fit automatically ranks the dry → wet test’s water years by it when it covers them. The importer stores it this way with --gauge-as-reference, and its scaling options undo a known rescaling.',
		aliases: ['regional gauge', 'neighbouring gauge', 'proxy gauge'],
		related: ['observed-flow', 'calibration'],
		source: 'docs/model.md §2.10'
	},
	// The Data tab's daily preview ("Input time series — daily preview"): one
	// entry per column it derives. Its raw series columns use series.<kind>.
	'preview-date': {
		long: 'The rows come from the input series themselves, not from the simulation period: the table starts on the first day any loaded series has and ends on the last. Each series column shows its value for that day exactly as uploaded; a blank means that series has no reading that day, or the day is outside its period. A shaded value carries a data-check flag (negative, outlier or flat-line), found with the same rules as the Data checks, and screen readers read the flag with the value.\n\nThe search box narrows the rows by date prefix (2015, 2015-03) or by a value in the visible series (> 20, = 0); Missing only and Flagged only keep the days where a visible series is blank or flagged. Lining every input up by day is the quickest way to see a gap in one record that another fills, or a spike only one instrument recorded.',
		aliases: ['daily preview', 'preview data', 'series preview'],
		related: ['gauge-logger-agreement', 'rain-catchment', 'observed-flow'],
		source: 'Not in the workbook; docs/ui.md § Data tab (Preview)'
	},
	'preview-flow-m3day': {
		long: 'Flow records are uploaded in m³/s. The model converts them to m³/day (1 m³/s = 86 400 m³/day) before comparing them with the simulated outflow, which is in m³/day like every flow and volume inside the model. This column is that conversion, day by day, blank where the record has no reading. Use it to read an observed day against the daily results or the daily CSV export without converting by hand.\n\nFor gauge or logger flow this is the value calibration and the EWR comparison score against, when that record is the one chosen under “Compare with”. A reference gauge on another river is converted the same way, but the model never reads it.',
		related: ['observed-flow', 'units', 'reference-gauge'],
		source: 'docs/model.md §2.1, §7'
	},
	'preview-rain-used': {
		long: 'It is worked out with the same code a run uses, so it is the rain that drives runoff and reduces irrigation demand. Catchment rain comes first, after the rain-gap settings: days of a zero run treated as missing count as blank, so CHIRPS fills them, and a multi-day accumulation is spread back over the days it covers. That is why this column can differ from the catchment rain column on a day that has a reading. Where catchment rain is blank, CHIRPS stands in (scaled by its month’s factor when the bias correction is on), then forecast rain.\n\nIt is blank outside the simulation period (Settings, simulation start and end) and on days no source has a value, which the model treats as dry. It is the rain before the rain threshold for irrigation demand. Compare it with the uploaded columns to see which days were filled and from where; screen readers also read the source with each value.',
		aliases: ['rain used', 'gap-filled rain'],
		related: ['rain-final', 'chirps-bias', 'zero-rain-runs', 'rain-accumulations'],
		source: 'docs/model.md §2.4, §2.4b–d'
	},
	'preview-chirps-factor': {
		long: 'Fitted from the loaded records for each calendar month: catchment rain divided by CHIRPS rain, summed over the days both have a reading, leaving out suspect catchment rain (see CHIRPS bias correction). A month with fewer than 90 shared days, or less than 50 mm of CHIRPS on them, takes the factor pooled over all months, and factors are kept between 0.25 and 4. A dash means no factor could be fitted, so CHIRPS is used as it is.\n\nThe same factor shows on every day of that month in the simulation period, but it only changes a day where CHIRPS fills in for blank catchment rain, and not at all when Settings → CHIRPS bias correction is set to Raw CHIRPS (it is then shown for reference only). A factor well away from 1 says CHIRPS reads consistently wetter or drier than the catchment record in that month.',
		related: ['chirps-bias', 'chirps', 'double-mass'],
		source: 'Not in the workbook; docs/model.md §2.4b; engine-audit.md B1'
	},
	'preview-chirps-corrected': {
		long: 'Only CHIRPS the model actually uses is corrected. On a day with no catchment rain value (including the days of a zero run treated as missing) it is CHIRPS × that month’s factor; on a day catchment rain has a reading CHIRPS isn’t used, so it shows as uploaded. With Raw CHIRPS chosen, or no factor fitted, it is the uploaded value every day. Blank outside the simulation period.\n\nBeside the uploaded CHIRPS column it shows how much rain the correction added or took away on the filled days. It differs from a run’s corrected-CHIRPS output column, which applies the factor on every day.',
		related: ['chirps-bias', 'preview-chirps-factor', 'preview-rain-used'],
		source: 'Not in the workbook; docs/model.md §2.4b; engine-audit.md B1'
	},
	'preview-excluded': {
		long: 'Comes from Settings & calibration → Calibration exclusions: whole water years (1 October to 30 September) or date ranges, each with a reason. A day inside one reads Excluded, and screen readers also read the reason; every other day shows a dash. The model still simulates excluded days; only the scores leave them out, so Fit automatically and the run’s calibration statistics compare observed and simulated flow on the remaining days of the calibration window.\n\nUse it to check that an exclusion covers the days you meant, such as a gauge outage or a suspect rain year, and no more.',
		related: ['calibration-exclusions', 'calibration-window'],
		source: 'Not in the workbook; docs/model.md §2.10'
	},
	'wr90': {
		long: 'The standard national source for the monthly evaporation and naturalised-flow inputs.',
		aliases: ['WR2012', 'Water Resources of South Africa'],
		related: ['apan', 'quaternary'],
		source: 'docs/model.md §7',
		countries: ['ZA']
	},
	'quaternary': {
		long: 'A model catchment usually lies within one quaternary or spans a few.',
		related: ['wr90'],
		source: 'docs/model.md §7',
		countries: ['ZA']
	},
	'map': {
		long: 'MAP varies across a catchment, which is why b023 can split hydrological unit areas into high- and low-MAP zones.',
		aliases: ['MAP', 'MAR', 'mean annual precipitation', 'mean annual runoff'],
		related: ['hi-lo-map-area'],
		source: 'docs/model.md §7'
	},
	// The Map tab and the values it proposes, the data feeds and the uploads.
	'catchment-map': {
		long: 'The Map tab draws the catchment boundary, farm parcels, dams, gauges and rivers over a basemap of OpenStreetMap data served from the app’s own storage (without one, a plain background). The Network stays the model’s schematic of what drains into what; the map is the geography, and a model builds and runs without it.\n\nThe map proposes and you decide. A polygon’s area enters a hydrological unit only through **Use** and a confirmation; a quaternary’s values, a dam’s capacity or full-supply area, a unit’s cultivated area and the boundary’s evaporation each enter only through their own **Use**; a delineated catchment reaches the map only through **Accept**; a reach of the river network becomes a project river only through **Add to the map as a river**. Each accepted value is a model or settings revision naming where it came from, so History and the run comparison show it.\n\nEverything on the map is also in the feature list and table beside it: points can be placed by typing coordinates, shapes pasted as GeoJSON or WKT, and areas still typed on the Network. **Measure** (distance, or area and perimeter on the WGS84 ellipsoid) and **Download GeoJSON** (the features as one WGS84 file) are there for viewers too.',
		aliases: ['map tab', 'geography', 'GIS', 'basemap', 'features'],
		related: ['map-area', 'delineation', 'start-from-map', 'map-checks', 'map-results'],
		source: 'docs/maps.md (introduction, Basemap, Measure, Download GeoJSON)'
	},
	'map-geojson-upload': {
		long: 'The server reads and checks the file whatever the browser did, and refuses the whole file on any problem, listing them per feature. It takes WGS84 longitude/latitude only (EPSG:4326, as GeoJSON requires): a file naming another CRS, or with coordinates outside ±180 / ±90 (a projected Lo or UTM file), is refused with a request to reproject it; nothing is guessed. Coordinates are 2D; the types are Point, LineString, MultiLineString, Polygon and MultiPolygon. Rings must be closed, have an area, and not cross or touch themselves or each other; the parts of a MultiPolygon may share an edge but not overlap beyond slivers of 0.1 %, so no area counts twice. At most 5 MB, 500 features and 50 000 positions a feature.\n\nOnly a name (from name, Name, label or title), a description and a reference are kept; every other property is dropped, since attribute tables can carry owners’ names or ID numbers. The same file can’t be imported twice into a project.\n\nA file may mix kinds. The review proposes each feature’s kind from a kind, type or layer property, else from its shape (a line a river, a point a gauge, a polygon a farm parcel, the largest polygon holding every other feature the catchment boundary), and the node of the same name it stands for; check every row before importing. A file holds at most one boundary, and replacing the current one needs its own tick. Shapefiles aren’t read: export the layer as GeoJSON in EPSG:4326 (in QGIS, Export → Save Features As). **Paste a shape** takes the same GeoJSON, or WKT, for one shape while drawing.',
		aliases: ['upload GeoJSON', 'import shapes', 'shapefile', 'WKT', 'paste a shape', 'EPSG:4326', 'WGS84'],
		related: ['catchment-map', 'map-area'],
		source: 'docs/maps.md (Uploads; Drawing, Paste a shape)'
	},
	'map-area': {
		long: 'Every area is worked out on the server, never taken from the browser: the geodesic area on the WGS84 ellipsoid (an equal-area projection of the ellipsoid, where a ring’s area is exact), not a mean-radius sphere, which is up to about 0.5 % off at South African latitudes. Measuring a shape on the map gives the same figure.\n\n**Use … km²** on a farm parcel or an area (an “other” polygon) sets a hydrological unit’s area to it, after a confirmation, and saves it straight away as a model revision naming the feature, so the model must have no unsaved edits. The unit then shows its area as from the map, until you type over it or the feature is deleted (the area stays; the link goes). Reshaping or splitting the polygon doesn’t change the unit’s area until you press Use again. A dam’s water surface and the catchment boundary are never offered.\n\nThe area is the unit’s catchment area, the land whose runoff it receives, so the polygon to use is the unit’s sub-catchment, not its irrigated land. A polygon delineated from the elevation model stores the area of the cells it came from, which can differ slightly from its simplified outline’s.',
		aliases: ['Use area', 'area from polygon', 'geodesic area', 'area into the model', 'area source'],
		related: ['farm-area', 'area-basis', 'catchment-map', 'map-checks'],
		source: 'docs/maps.md (Areas)'
	},
	'area-basis': {
		long: 'Delineation fills every closed depression and routes it to the outlet, so in pan veld the catchment it proposes is the gross one. It also reports how much of it drains into pans: closed depressions at least 1 m deep and 0.1 km² in floor that hold at least 100 mm of their own catchment’s runoff. Storage behind a dam wall, a depression a mapped river flows out of over a wall, and one the register or the map has a dam in are not counted as pans.\n\n**Gross** (the default) is the whole area, pans’ catchments included, as WR2012’s quaternary areas and a gauge’s published catchment are, so it can be checked against them; and the pans come from the elevation model alone, so a false one taken out silently would remove real catchment. **Effective** is the area less what drains into pans, for a hydrologist who models the pans as non-contributing (WR2012’s endoreic areas).\n\nThe choice is never silent: the button and the confirmation name the area taken, the unit records which, and the revision says so. The polygon keeps its gross outline and area. For an off-channel dam, the proposed runoff-to-dam share follows the area taken, so the same water reaches the dam either way. A drawn, imported, split or reshaped polygon has no pans figure and offers no choice.',
		aliases: ['pans', 'endoreic', 'non-contributing area', 'effective drainage area', 'gross area'],
		related: ['map-area', 'delineation', 'runoff-to-dam'],
		source: 'docs/maps.md (Pans and the effective area; Delineation, Pans)'
	},
	'map-snap': {
		long: 'While drawing, placing a point, dragging a corner or adding one on an edge, a position within 12 px of another feature’s corner lands exactly on that corner; failing that, within 12 px of its edge, on the edge. A corner wins over a nearer edge, so a shared corner is met exactly. Every feature on the map is a target except the one being edited, and a ring marks where the pointer would snap. Enter at the keyboard crosshair snaps the same way.\n\n**Follow edges** (on with snapping, for a new shape or line): two corners in a row snapped to the same outline take that outline’s corners between them, the shorter way round. A parcel drawn against its neighbour or the boundary then shares their edge corner for corner, with no gap or overlap for the map’s checks to find. Turn it off, or hold Alt for one corner, to cut straight across.',
		aliases: ['snap', 'snapping', 'follow edges', 'shared edge'],
		related: ['catchment-map', 'map-checks'],
		source: 'docs/maps.md (Assisted drawing)'
	},
	'trace-dam': {
		long: 'Click inside a dam’s water (or enter coordinates) and choose the share of satellite observations a cell must be water in to count: 10, 25 (the default), 50 or 75 %. The server reads the water occurrence around the point (about 8 km, grown once), moves a click within 60 m of water onto it, takes the cells at or over the share that touch the clicked one by an edge (two dams meeting at a corner stay two), fills islands and outlines them. Water reaching the edge of the window, dry land and a point outside the data are refused with a reason.\n\nThe outline comes back as a drawing to adjust, nothing stored. Saved, it keeps how it was traced (the dataset, the share, the click, and whether you adjusted it) in its description and history; the server traces again to check an unadjusted outline.\n\nIt is the water’s edge as the satellite saw it over 1984–2024, not the full supply level: a dam that seldom fills traces smaller at a high share, so a lower share takes in the edge a full dam reaches now and then. The share is your call. The data is JRC Global Surface Water occurrence (about 30 m cells); credit “Source: EC JRC/Google”.',
		aliases: ['dam outline', 'water occurrence', 'JRC Global Surface Water', 'GSW', 'water edge'],
		related: ['dam-proposals', 'map-area', 'dam-evaporation'],
		source: 'docs/maps.md (Assisted drawing, Trace a dam; Water occurrence dataset)'
	},
	'map-checks': {
		long: 'Warnings only: none stops a save or a run. Each names its features as buttons that select them on the map. The checks: a hydrological unit no farm parcel is linked to; a parcel, dam, point or line with a vertex outside the boundary (within 10 m of the line counts as on it); two farm parcels whose insides overlap (shared edges and slivers within 5 m don’t count); the units’ areas added up more than 10 % off the boundary’s area; a unit whose typed area is more than 10 % off its linked parcels’ area; and, with river lines on the map, a gauge more than 100 m from every river line.\n\nThey read the project’s own features only: a reach of the river network counts once it is added to the map as a river. Distances are great-circle, areas the server’s.',
		aliases: ['checks', 'map warnings', 'outside the boundary', 'overlapping parcels'],
		related: ['catchment-map', 'map-area', 'map-snap'],
		source: 'docs/maps.md (Checks)'
	},
	'map-results': {
		long: 'Each farm parcel, and each dam polygon through its unit, is coloured by one run’s figure, using the app’s own bands: **Days short** (the default: demand days in the reporting window not fully met, banded at 95 % and 70 % of days met), **Curtailment** (the cut the curtailment table asks of the unit), **Dam level** (end of run: 60 % full or more, 30–60 %, under 30 % or at its minimum) and **Use against allocation** (above the registered volume in any whole water year is short). Gauges and EWR sites say whether the EWR was met. **Kind** goes back to the features’ own colours.\n\nThe run is the published one for everyone; an editor can pick any run, and sees the newest when none is published. A parcel not linked to a unit, or with no figure, takes the “no figure” colour, so a parcel’s own green never reads as OK. The colour is never the only cue: the legend, the card and the table say each figure in words.',
		aliases: ['colour areas by', 'days short', 'map colours', 'results colouring'],
		related: ['report-window', 'dam-storage', 'allocation-band', 'ewr'],
		source: 'docs/maps.md (Results on the map)'
	},
	'elevation-model': {
		long: 'Over South Africa the elevation model is Copernicus GLO-30, a 30 m global digital elevation model, served as map tiles (Mapterhorn’s build). The **Relief** layer shades hills from it, for the eye only. Delineation, the terrain channels, sub-catchments and Start or Divide from the map read the same model on the server; without one there, those tools are not offered.\n\nIt is a global satellite model, not a survey. In flat land a divide can be hundreds of metres out and a catchment can come out joined to, or cut from, its neighbour. Flats, dams and pans drain towards their outlet by construction; canals, pipelines, culverts and transfers between basins are invisible to it. Check a proposal against the relief, the mapped rivers and the quaternary outlines before accepting it. Every proposal names the dataset and its fingerprint, and a delineated polygon carries the Copernicus licence notice.',
		aliases: ['DEM', 'digital elevation model', 'Copernicus', 'GLO-30', 'relief', 'hillshade', 'terrain'],
		related: ['delineation', 'terrain-channels'],
		source: 'docs/maps.md (Relief; Delineation, The DEM; Sources)'
	},
	'delineation': {
		long: '**Delineate** proposes the catchment that drains to a point you click on a terrain channel (the elevation model’s own rivers): the catchment’s outlet, or just below a dam wall. The point goes on the terrain channel nearest it. The server reads the elevation model in a window around the point (about 34 km, grown to about 100 km while the catchment reaches its edge), fills depressions, routes each cell’s flow to its steepest neighbour (D8), collects every cell upstream of the outlet and outlines them as one polygon, simplified to about a cell. Mapped rivers play no part: the outlet sits on a terrain channel and the outline follows the terrain alone.\n\nA larger catchment goes to a background worker (windows up to about 200 km); one still cut off there, or one reaching missing data, is refused rather than cut off. A main stem too large for any window is refused with the advice to divide it with sub-catchments.\n\nThe proposal lists its area, how far the outlet moved, the cells, what drains into pans and the effective area, and the dataset and method. **Accept as the catchment boundary** (replacing a current one only with its tick), **Accept as an area** (to link to a unit and Use), or **Reject**. An accepted boundary is a map feature only: the model’s units don’t change until you Start or Divide the model from the map. Each delineation takes a few seconds; a project can make 30 an hour.',
		aliases: ['delineate', 'catchment from a click', 'watershed', 'D8', 'flow routing', 'upstream area'],
		related: ['elevation-model', 'outlet-placement', 'terrain-channels', 'area-basis', 'sub-catchments', 'start-from-map'],
		source: 'docs/maps.md (Delineation); docs/design/delineation.md'
	},
	'terrain-channels': {
		long: 'While Delineate or Sub-catchments is on (and dimmed behind a proposal waiting for a decision), the map draws the elevation model’s own channels, wider for a larger area upstream: every cell with at least 1 km² draining through it, routed the same way delineation routes. These are the lines to click: the outlet always goes on one of them.\n\nMapped rivers (the river network, the basemap’s waterways) can sit hundreds of metres off the channel the elevation model routes along; they are for reference only and never move the outlet. The outline of a delineated catchment follows the terrain channels. Zoom in to see them: they are drawn for a view at most about 0.35° across. A channel entering the view from far beyond carries less area here than it really drains.',
		aliases: ['red lines', 'DEM channels', 'stream network from the DEM'],
		related: ['delineation', 'outlet-placement', 'river-network'],
		source: 'docs/maps.md (The elevation model’s channels)'
	},
	'outlet-placement': {
		long: 'The outlet always sits on a terrain channel: the server puts the point on the nearest cell within 150 m that has at least 1 km² draining through it (the red lines). Nearest, not the most-drained, so a click on a tributary beside the main river stays on the tributary. With no terrain channel that close, the point is refused: click on one of the red lines. Mapped rivers (the river network, the basemap’s waterways) never move or choose the outlet, since the elevation model’s rivers often run somewhere else than the mapped ones.\n\nWhen a channel draining 100 times more runs within 1 km, you are asked (**Use that channel** or **Keep my point**); the point is never moved there by itself. The proposal says how far the point moved, and Start and Divide place every abstraction point and gauge by the same rule (one with no terrain channel near it is left out, with the reason). A dam polygon takes its most-drained cell, unless it is marked off-channel or only clips a much larger river.',
		aliases: ['snapping', 'snap to channel', 'pour point', 'outlet', 'confluence'],
		related: ['delineation', 'terrain-channels', 'dam-siting'],
		source: 'docs/maps.md (Delineation, Where you click; Start from the map, Placing the points)'
	},
	'sub-catchments': {
		long: '**Sub-catchments, one per click** divides the land by clicking the rivers, with no boundary and no roles to set first. Each click is an outlet, placed on the nearest terrain channel as delineation places one. Its piece is its incremental catchment: the cells whose water reaches it before any other click. A click upstream carves its piece out of the one below; the lowest click takes what lies between. Each piece drains into the first click its flow meets; a click on another river, or on the same cell as another, is dropped with the reason.\n\nA click whose catchment runs past the routed window (about 100 km across) is an inflow point: it gets no piece, and the water from above it enters the piece below, which is how a reach of a large river is modelled anyway. Click the main stem where the modelled reach starts and where it ends.\n\nNothing is stored while you click. **Save** routes the clicks again on the server and saves each piece as an area, named by its click, with its outlet, where it drains and the area upstream in its description; link each to its unit and Use its area. At most 50 clicks; inflow points aren’t saved.',
		aliases: ['incremental catchment', 'click to divide', 'inflow point'],
		related: ['delineation', 'outlet-placement', 'divide-model', 'map-area'],
		source: 'docs/maps.md (Sub-catchments from clicks)'
	},
	'start-from-map': {
		long: 'On a model with no hydrological units yet, editors get **Start the model from the map**: a sheet of four steps. Put the boundary on the map (delineate it, draw it or upload it); say what each point is (a unit with a dam, a unit at an abstraction point, another water user with no land, a gauge in the network, or not in the model) and which gauge is the outlet; then review the proposal; then add the data.\n\nWith an elevation model on the server, each point is placed on the channel and each unit gets the cells whose flow meets it before any other unit: its own piece. Every area is summed from the cells’ own areas on the ellipsoid, so the pieces and the rest add up to the catchment exactly. Each unit drains into the first unit its flow meets, and the rest of the catchment can be a unit of its own. A dam unit is offered its runoff-to-dam and upstream-to-dam shares from its siting. Without an elevation model, the units come from the points with no area, all draining into the outflow gauge.\n\nEach value is a tick: only what you tick is written, as one model revision, with each ticked area saved as its unit’s parcel. The last step links the data proposals in order: rain from the boundary, the nearest gauging stations, the dams from the register, land cover, then a run.',
		aliases: ['start from the map', 'new model from map', 'propose units'],
		related: ['divide-model', 'delineation', 'dam-siting', 'outlet-placement', 'network', 'outflow-gauge'],
		source: 'docs/maps.md (Start from the map); docs/design/start-from-map.md'
	},
	'divide-model': {
		long: 'For a model that already has hydrological units, with an elevation model on the server and exactly one outflow gauge. Say which unit each point on the map stands for (a gauge with no node can become a new gauge node). The same partition as Start from the map then proposes each unit’s own area (what drains to its point and to no point above it), what it drains into and a dam’s runoff share, each shown beside the unit’s value now, and the rest of the catchment to a unit, a new unit or nobody.\n\nOnly what you tick changes. A ticked value that changed in the model since the proposal is refused rather than overwritten unseen. Dividing again redraws the parcel an earlier division made. A unit no point stands for keeps its values.',
		aliases: ['divide the model', 'split model into units'],
		related: ['start-from-map', 'sub-catchments', 'map-area'],
		source: 'docs/maps.md (Start from the map, Divide the model)'
	},
	'dam-siting': {
		long: 'Set on a dam outline’s card. **Not said** (the default) lets the outline decide: the dam goes at its most-drained cell, the wall when the river runs through the reservoir, unless the outline only clips a much larger river. **On the river** puts the dam on the river’s channel and proposes all upstream inflow and all of its unit’s runoff into the dam. **Off-channel (filled by a pump or a furrow)** finds the dam’s own outflow, ignoring the river however much of the outline it runs along, and places the unit where that outflow joins the river: upstream inflow to the dam 0 %, and runoff to the dam only from the dam’s own catchment as a share of the unit’s area.\n\nThat is how the model represents an off-channel farm dam, filled by its river abstraction. The terms follow DWS practice: a dam registration distinguishes off-channel storage, which is filled from a river it doesn’t sit on. Only Start and Divide read the siting.',
		aliases: ['off-channel dam', 'on-channel dam', 'siting', 'OCS'],
		related: ['upstream-to-dam', 'runoff-to-dam', 'start-from-map', 'divide-model'],
		source: 'docs/maps.md (Start from the map, Placing the points)'
	},
	'river-network': {
		long: 'The **River network** layer draws mapped river reaches around the catchment (or the view, before there is a boundary), dashed, wider for a higher Strahler order. The list beside the map gives each reach’s order and area upstream; a picked reach adds its length, a modelled mean flow (a WaterGAP long-term mean, never a gauged one) and its source.\n\nThe real data is HydroRIVERS v1.0 (WWF HydroSHEDS), which holds rivers with at least 10 km² upstream or 0.1 m³/s mean flow at about 500 m resolution: it misses the smallest farm streams, and its lines can sit a few hundred metres off the real channel, so check a reach against the relief and the basemap. At most 1 000 reaches are drawn, the smallest dropped first.\n\n**Add to the map as a river** copies one reach into the project’s rivers, named after the reach (rename it on its card) with its source; then the map’s checks measure gauges against it and drawing snaps to it. Mapped rivers also help place a delineation’s outlet, but never shape its outline.',
		aliases: ['HydroRIVERS', 'HydroSHEDS', 'Strahler order', 'river reaches', 'rivers layer'],
		related: ['terrain-channels', 'outlet-placement', 'map-checks'],
		source: 'docs/maps.md (River network; River network dataset; Sources)'
	},
	'quaternary-lookup': {
		long: 'Settings → WR2012 check → **Propose from the map** finds the quaternary catchment that contains a point (the boundary’s centre, a gauge on the map, or coordinates you type) and lists its reference values (code, area, MAP, naturalised MAR, reference period and monthly means, with the dataset’s source) beside what the form holds. Each **Use** puts one value into the form only; **Save** keeps it. Check each against the study before you rely on it.\n\nThe Map tab’s **Quaternary catchments** layer draws the loaded outlines around the project and lists their codes; click one to pick it out. A catchment spanning several quaternaries needs the values combined by hand.\n\nThe operator loads the dataset: the DWS quaternary outlines with the WR2012 values from their own download, since the WR2012 redistribution terms are not published. The app ships only invented quaternaries, and a proposal from them is marked as synthetic.',
		aliases: ['propose from the map', 'quaternary values', 'quaternary outlines', 'quaternary layer'],
		related: ['quaternary', 'wr90', 'wr2012-check', 'synthetic-data'],
		source: 'docs/maps.md (Quaternary lookup; Quaternary outlines; Quaternary dataset)',
		countries: ['ZA']
	},
	'synthetic-data': {
		long: 'The reference datasets behind the map’s proposals (quaternaries, gauging stations, the register of dams, the river network, land cover, the evaporation grid, the water occurrence and the elevation model) are loaded by the operator from their own downloads, because their licences or the repository’s public nature keep real data out of the app’s code. What ships instead is invented: a handful of quaternaries and gauges in a drainage region that doesn’t exist (Z), invented dams, reaches, cropland, evaporation, water and terrain around the example catchment, each with a source saying SYNTHETIC.\n\nAnything proposed from them carries a warning (“Synthetic test data … never use them for a real catchment”), and data feeds reading the sample files instead of CHIRPS or DWS show a **Sample data** badge. Seeing either on a real project means the real dataset isn’t loaded on this server.',
		aliases: ['sample data', 'fixtures', 'test data', 'invented data'],
		related: ['quaternary-lookup', 'dam-proposals', 'data-feeds'],
		source: 'docs/maps.md (each dataset’s “Committed: synthetic only”); docs/ui.md (Data feeds)'
	},
	'dam-proposals': {
		long: 'On the Dams page, for a unit whose dam is on the map (a polygon first, else a point):\n\n**Capacity, from the register of dams.** The registered dams within 1 km of the dam’s place on the map, nearest first (at most five), each with its register number, distance, capacity, wall height, completion year, river and farm. Matching is by distance only, because names on the register rarely match a farm’s dam name; wall height and year are for reference. The register is the DWS Dam Safety Office’s list of registered dams, loaded by the operator.\n\n**Full-supply area, from the dam polygon.** The polygon’s area on the ellipsoid as the dam’s area when full, which the run then uses for the dam’s evaporation instead of the estimate from its capacity. A point has no area to propose.\n\n**Use** asks first, then saves that one value as a model revision naming its source; the server derives it again, so a register entry further than 1 km, or a dam linked to another unit, is refused. Draw the polygon at the full supply level, not the water’s edge on the day of the imagery.',
		aliases: ['register of dams', 'DSO', 'dam safety office', 'dam capacity from register', 'full supply area'],
		related: ['dam-capacity', 'dam-evaporation', 'trace-dam', 'synthetic-data'],
		source: 'docs/maps.md (Dams from the register and the map; The register of dams)',
		countries: ['ZA']
	},
	'cultivated-area': {
		long: 'In a unit’s planted-areas drawer, **From land cover** sums the area a land-cover map shows as cropland inside each farm parcel linked to that unit, the parcels together, and the boundary for reference. Pick an area (all the parcels or one) and a crop; **Use** sets that crop’s planted area on the unit, as a model revision citing the dataset.\n\nThe data is ESA WorldCover 10 m (2021 v200), class 40 Cropland, pre-summarised by the operator into a grid of 0.0025° cells (about 250 × 230 m) holding each cell’s cropland share. A parcel’s figure is, over the cells it covers, each cell’s area × the share of it inside the parcel × its cropland share, so cropland is taken as spread evenly within a cell and a small parcel can be off by up to a cell’s cropland along its edge. Overlapping parcels count twice.\n\nLand cover says where land is cultivated, not what grows there, nor whether it is irrigated: WorldCover’s cropland includes rain-fed and fallow land. So the crop is always yours to choose, and a parcel with several crops is split by typing afterwards. The drawer says when the crop’s area has been typed over since.',
		aliases: ['land cover', 'WorldCover', 'cropland', 'planted area from map', 'from land cover'],
		related: ['crop-area', 'map-area', 'synthetic-data'],
		source: 'docs/maps.md (Cultivated area from land cover; The land-cover grid)'
	},
	'evaporation-from-map': {
		long: 'In Settings → Flow calibration, under GR4J’s potential evaporation. Each month is the mean of the grid cells the catchment boundary covers, each weighted by its area × the share of it inside, rounded to 0.1 mm. Cells without a value (the sea) are left out and the share of the boundary they leave is shown as coverage; below 50 % nothing is proposed.\n\nWhat a grid holds decides where it goes, and nothing is converted. A reference evapotranspiration grid (FAO-56 Penman-Monteith ET₀) is proposed as GR4J’s monthly PE as it stands; the pan coefficient is then unused, and crop demand and dam evaporation keep reading the A-pan row. An A-pan grid is proposed as the A-pan row. ET₀ is a reference grass surface’s loss, not a pan’s; the pan coefficient between them depends on the pan’s siting, humidity and wind, so it stays your call. For an ET₀ grid the panel shows ET₀ ÷ saved A-pan per month as a cross-check only, flagged outside FAO-56’s typical Class A range of 0.6–0.85.\n\nThe real grid is dPET (University of Bristol), daily FAO-56 PET at 0.1°, averaged by the operator into monthly means over a period such as 1991–2020. **Use** saves the 12 values as one settings revision citing the dataset; a GR4J fit made before is then marked “Forcing changed since fit”.',
		aliases: ['ET0 from map', 'dPET', 'reference evapotranspiration grid', 'evaporation grid'],
		related: ['gr4j-pe', 'apan', 'pan-coefficient', 'evap-apan-daily', 'synthetic-data'],
		source: 'docs/maps.md (Evaporation from the map; The evaporation grid)'
	},
	'data-feeds': {
		long: 'Settings → **Data feeds**. Each feed reads one source and merges its new days into one series once a day: **CHIRPS daily rainfall** (for listed grid cells, a bounding box, or the cells of the catchment boundary, area weighted), the **CHIRPS-GEFS** 16-day forecast, or a **DWS gauge**’s verified daily flow. A day the source has no value for never erases what is there, and a feed attached to a series that already holds data keeps those values and fills only the empty days (the form asks first, and suggests a separate series instead).\n\nEach card says its state in words: **OK**; **Stale** when its newest day is older than the source’s usual lag allows (12 days for CHIRPS; a forecast reaching fewer than 12 days ahead; 240 days for DWS); **Failing** when the last fetch failed, with the reason; **Waiting** before its first fetch; **Off**. A fetch that meets a changed page, a corrupt file or a sea cell fails loudly and writes nothing. **Run now** fetches at once, between the daily runs.\n\nOwners attach, switch off and remove feeds; editors can run them; viewers see their health. A **Sample data** badge means this server reads invented sample files, not the real sources. Feeds change the series only: a run reads them like any uploaded series.',
		aliases: ['feeds', 'automatic data', 'attach a feed', 'stale feed', 'failing feed'],
		related: ['boundary-rain', 'chirps', 'chirps-gefs', 'chirps-version', 'dws-flow', 'data-freshness'],
		source: 'docs/ui.md (Data feeds); docs/architecture.md (Data feeds)'
	},
	'boundary-rain': {
		long: 'Settings → Data feeds → **Use the catchment boundary** proposes a CHIRPS feed for the boundary on the map: the CHIRPS v3 cells (0.05°, about 5.5 km) it covers, each weighted by the share of it inside the boundary (clipped exactly, holes taken out) × the cosine of its latitude, with a table of the cells. A cell less than 0.1 % inside is left out. At most 100 cells in 25 rows, about 2 500 km²; a larger boundary needs feeds for its parts.\n\nApply attaches a CHIRPS feed into the CHIRPS series, or gives the cells to a CHIRPS feed that holds no days yet. A feed whose series already has a record never gets new cells, since its days were averaged over the old ones: the proposal attaches a new feed into a separate series to compare, and you switch the old one off once satisfied. A boundary redrawn since you looked is refused rather than applied unseen; the Map says when the boundary has changed since its feed read it.',
		aliases: ['CHIRPS from boundary', 'area-weighted rain', 'boundary cells'],
		related: ['data-feeds', 'chirps', 'chirps-bias'],
		source: 'docs/maps.md (Rain from the boundary)'
	},
	'unit-rain-feeds': {
		long: 'Under Settings, Data feeds, **Rain for each unit** proposes one CHIRPS feed for each hydrological unit with land and a parcel on the map (its delineated or drawn area, linked to the unit). Each feed averages the 0.05° CHIRPS cells the parcel covers, each weighted by the share of it inside and by its area, and writes into that unit’s own rain series.\n\nOne daily product serves every unit, end to end: **rnl** (from 1981, final days only) by default, or **sat** (from 1998, with preliminary days); a feed never splices one onto the other. Without a start date the feeds read from the product’s first day, so the MAP period has its years. Units without a parcel are listed, with a link to the map.\n\nNeighbouring small units often share cells, so their raw CHIRPS is nearly the same: what tells them apart is each unit’s MAP, which levels its CHIRPS. The series are read only while Rain for each unit is on in Settings, Flow generation.',
		aliases: ['per-unit CHIRPS', 'unit CHIRPS', 'CHIRPS per unit', 'from-units'],
		related: ['unit-rain', 'unit-map', 'boundary-rain', 'chirps-version'],
		source: 'docs/maps.md § Rain for each unit; issue #482'
	},
	'chirps-gefs': {
		long: 'CHIRPS-GEFS v3 is a rainfall forecast from the Climate Hazards Center: the GEFS weather forecast bias-corrected to CHIRPS, on the same 0.05° grid, one issue a day of 16 daily values. A feed reads the newest complete issue for its cells or box and writes all 16 days into the forecast rainfall series, each issue replacing the last from its issue date on.\n\nAn ordinary run stops where the observed record ends, so forecast days reach only a forecast run, where results on those days are indicative. Forecast rain also fills a day neither catchment rain nor CHIRPS has.',
		aliases: ['GEFS', 'rain forecast feed', '16-day forecast'],
		related: ['rain-forecast', 'data-feeds', 'chirps'],
		source: 'docs/architecture.md (Data feeds); docs/maps.md (Sources)'
	},
	'chirps-version': {
		long: 'CHIRPS v2.0 and v3.0 differ by an amount that changes over the years, so one series holds one of them and two are never spliced together. b023 workbooks were built on v2.0; the CHIRPS data feed writes v3.0, which comes as two daily products with the same pentad totals but different daily timing: **sat** (from 1998, with preliminary days two days after each pentad, replaced by finals about three weeks after the month) and **rnl** (from 1981, final days only, out with the sat finals about three weeks after each month, so its newest day is weeks old). Choose rnl for a record that starts before 1998.\n\nThe workbook import and an upload ask which a CHIRPS series holds. A feed whose series holds another product or version, or an unrecorded one, refuses every fetch until an owner chooses **Replace the series**: it backfills the new record separately and swaps it in whole when caught up, and History keeps the old values. A fit then needs redoing, since the CHIRPS factors move.',
		aliases: ['CHIRPS v2', 'CHIRPS v3', 'sat', 'rnl', 'preliminary CHIRPS', 'provenance'],
		related: ['chirps', 'chirps-bias', 'data-feeds', 'workbook-import'],
		source: 'docs/ui.md (Data feeds; Import b023 workbook); docs/architecture.md (Data feeds)'
	},
	'dws-flow': {
		long: 'The Department of Water and Sanitation publishes verified daily mean flow for its river gauges (codes like A2H012, H in the third place for a river gauge; reservoir stations are not read, since their daily table is spillway discharge from the dam level). Verified data is revised in arrears and lags by months, so use it to calibrate, not to run the catchment day to day. A feed re-reads a year before its newest day each time, and ten years on its first fetch; it counts as stale after 240 days without a newer day.\n\nWhen attaching a DWS feed, **Nearest gauging stations** lists the river gauges within 50 km of the catchment’s outlet (the outflow gauge on the map, else the boundary’s centre), nearest first, with river, distance and the years their record spans; **Use** fills the station code, and nothing is attached until you say so. Check the record covers the years you calibrate on.\n\nA daily table exported from the DWS hydrology site also uploads as it is. In both, a row whose quality code marks it missing, and a blank or negative placeholder such as −999, is a gap, never a zero; the upload lists the quality codes it saw.',
		aliases: ['DWS', 'Department of Water and Sanitation', 'gauging station', 'nearest gauges', 'HyData', 'quality codes', 'verified flow'],
		related: ['observed-flow', 'reference-gauge', 'data-feeds', 'flow-gap-filling'],
		source: 'docs/architecture.md (Data feeds); docs/maps.md (Gauging stations); docs/ui.md (Data feeds)',
		countries: ['ZA']
	},
	'data-freshness': {
		long: '**Data up to** is the last day a series has a value, not the last day it stores: blank days after it (a dead logger’s) are no data. The series a run is driven by (recorded rainfall and daily A-pan evaporation) are **Behind** once that day is more than 7 days before today; they are listed first, and their count is the number beside Data in the workspace. A forecast runs ahead, and observed flow only scores a run, so neither is ever Behind.\n\n**Missing** is the share of days in the series’ own span with no value, and **Coverage by year** shows where the gaps fall. When a driver series has changed since the latest run, or reaches past its end, the Data and Runs tabs say the results are older than the data.',
		aliases: ['behind', 'stale data', 'data up to', 'coverage', 'missing days'],
		related: ['data-feeds', 'rain-catchment', 'evap-apan-daily'],
		source: 'Not in the workbook; docs/ui.md (Data tab)'
	},
	'day-boundary': {
		long: 'A logger file with several readings a day is added up into daily totals before it is stored. **08:00 to 08:00** is the manual rain gauge’s day: the total read at 08:00 is booked to the day the interval starts. **Midnight to midnight** is the calendar day. Each timestamp is taken as the end of its interval, so a reading at 08:00 closes the day before.\n\nThe series records the choice, and a rain-source period compares like with like, since a one-day shift between a manual gauge and an automatic station wrecks a daily fit while leaving monthly totals unchanged. The summary says how many readings a day it found and how many days have fewer, whose totals may be short.',
		aliases: ['08:00 day', 'rain day', 'sub-daily', 'logger readings', 'aggregation'],
		related: ['rain-source', 'rain-catchment-alt', 'series-source'],
		source: 'Not in the workbook; docs/ui.md (Data tab, upload)'
	},
	'series-update-mode': {
		long: 'Uploading into a series that exists: **Append / update** adds the file’s new days and corrects the days both have, leaving the rest; **Replace** overwrites the whole series with the file. Before you upload, the form counts new, changed and unchanged days and the series’ span afterwards, and a file that changes stored days asks first, naming how many and between which dates (**Show the changes** lists each). The values it overwrites are kept: History’s **Restore the earlier values** brings them back.\n\nA new series of a kind that already has one is a second series: runs read the first by name, and the form says which one runs will read.',
		aliases: ['append', 'update series', 'replace series', 'merge upload', 'overwrite'],
		related: ['series-source', 'data-freshness'],
		source: 'Not in the workbook; docs/ui.md (Data tab, upload)'
	},
	'workbook-import': {
		long: '**Import b023 workbook** reads a Water Balance Tool b023 .xlsm or .xlsx in your browser (only the extracted project is sent) and makes it a new project: its network, hydrological units, crops, transfers, settings and Flow data series. Formulas and macros are never run, and the per-farm result sheets aren’t imported; the first run is the app’s own.\n\nThe review asks what the workbook can’t say. **Gauge column**: whether the gauge measures another river (import it as a reference gauge, optionally undoing a scaling from a date). **River pumping units**: units the importer thinks pump from the river (b023 can’t, so they were entered as a tiny dummy dam or none), converted to run-of-river supply if you tick it, with the pump capacities left for you to enter. **CHIRPS column**: which CHIRPS product and version it holds.\n\n**Importer notes** (notes and warnings, with sheet and cell) and the **Unmapped report** (what couldn’t be carried across as the workbook meant, such as a hand-written transfer formula) never change a value on their own: read them before relying on a run. They stay with the project as its import record on the Summary. A .json project file imports the same way.',
		aliases: ['import workbook', 'b023', 'WBT', 'xlsm', 'unmapped report', 'importer notes', 'project file'],
		related: ['project', 'reference-gauge', 'supply-rule', 'chirps-version'],
		source: 'docs/ui.md (Import b023 workbook)'
	}
};
