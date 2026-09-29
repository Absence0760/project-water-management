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
		long: 'For each calendar month the factor is the catchment rain divided by the CHIRPS rain, summed over the days both have a reading. Suspect catchment rain is left out: a water year far below CHIRPS as a whole, and one by one the days of flagged zero runs, of periods listed as missing (see Zero-rain runs) and of multi-day accumulation windows (see Multi-day rain accumulations). Zero runs you keep dry stay in, as confirmed readings, unless CHIRPS reads a lot of rain over them; then that water year stays out and the run warns. A month with fewer than 90 shared days, or less than 50 mm of CHIRPS on them, uses the factor pooled over all months; with too little overlap for even that, CHIRPS is used as it is and the run says so. Factors are kept between 0.25 and 4.\n\nOnly CHIRPS that is actually used is scaled. Catchment rain and forecast rain are never changed. Each run lists the factors and the number of days corrected in its warnings, and outputs the corrected CHIRPS (CHIRPS × its month\'s factor, on every day, not only the days it filled in) as a daily series beside CHIRPS as uploaded, with the day\'s monthly factor in the next column, in the series explorer and the daily CSV export. The run\'s summary CSV lists the 12 factors with their source (own month, pooled, or none) and the shared days behind each, then the water years and days left out of the fit and why. Comparing runs notes when the factors differ. Rain used shows which value the model took each day.\n\nChoose "Raw CHIRPS" only if the CHIRPS series you loaded is already corrected to the catchment; otherwise it would be corrected twice. Not in the workbook, which used raw CHIRPS (docs/engine-audit.md B1).',
		aliases: ['bias correction', 'CHIRPS factor', 'rain scaling'],
		related: ['chirps', 'rain-catchment', 'chirps-fit-period'],
		source: 'Not in the workbook; docs/model.md §2.4b; engine-audit.md B1'
	},
	'chirps-fit-period': {
		long: 'When the double-mass check finds that the catchment / CHIRPS ratio changed part-way through the record, one set of factors fitted over every year is a blend of the eras, so a gap in one era is filled at the wrong ratio. The fit period decides which years the factors come from.\n\n**Whole record** (the default) fits one set over every year, as before. **Listed water years** fits one set per range you list, each only on its own years and each with a reason; years outside every range are left out of every fit, and a gap there takes the nearest range (the later one on a tie). Put each break where the station records or the CHIRPS version say it is.\n\n**Propose from the double-mass breaks** fills the list with one range per segment the check finds. It is only a proposal: the check\'s break years are estimates that can be a year or two off (the five-year minimum segment and dry years move them), and a break that is partly CHIRPS\'s (a product change, or drift against other products) moves them too. Check each range against the station history and rewrite its reason before saving. Split only when the step is large against the standard error of each era\'s ratio (its year-to-year scatter over the square root of the number of years), or a Pettitt or Buishand test calls it, not merely against the year-to-year scatter.\n\nWithin each range the usual rules hold: a month needs 90 shared days and 50 mm of CHIRPS, else it takes its range\'s pooled factor, else the factor over all the listed ranges together; factors stay between 0.25 and 4. Periods listed as missing under Zero-rain runs, and flagged zero runs that CHIRPS fills, stay out of every fit. Each run names the range whose factors filled each gap and the years each set was fitted on; the summary CSV lists every range\'s factors; comparing runs notes a changed fit period, range or reference window; and a fit record flags "Forcing changed since fit" when the fit period changes. Not in the workbook.',
		aliases: ['per-segment factors', 'fit period', 'CHIRPS fit ranges', 'rain homogenisation'],
		related: ['chirps-bias', 'double-mass'],
		source: 'Not in the workbook; docs/model.md §2.4b, §2.10a; calibration-research.md § Rain forcing; issue #40'
	},
	'double-mass': {
		long: 'Two records of the same rain should keep a steady ratio, so cumulative catchment rain plotted against cumulative CHIRPS is a straight line. A kink means one of them changed: a rain gauge opened, closed or moved, the catchment average was built differently, or CHIRPS changed. The check adds up each water year on the days both have a reading (leaving out zero runs treated as missing and periods listed as missing), and needs 10 years with at least 300 such days and 100 mm of CHIRPS. It fits up to two breaks, each segment at least 5 years long, and reports a break only when the slope changes by 20 % or more and a statistical test (Pettitt, or the gain in fit) says it is more than one odd year.\n\nThe chart shows the curve, the whole-record line (dashed) and the segments (solid), with each segment\'s slope, and below it how far the curve departs from the whole-record line each year. The check alone changes nothing: a break doesn\'t say which record is wrong, so the CHIRPS factors are fitted over the whole record unless Settings → CHIRPS fit period lists water-year ranges to fit them on (it can propose ranges from these breaks for you to check). A run warns when CHIRPS fills gaps in a segment whose ratio differs by 20 % or more from the ratio of the factors that filled them, because those days may then run too wet or too dry; with listed ranges it names the range whose factors filled each gap. The run\'s summary CSV has the table.',
		aliases: ['double mass curve', 'homogeneity', 'rain gauge change', 'station change', 'CHIRPS ratio drift'],
		related: ['chirps-bias', 'chirps', 'rain-catchment', 'chirps-fit-period'],
		source: 'Not in the workbook; Searcy & Hardison 1960; docs/model.md §2.10a; calibration-research.md CR-20'
	},
	'zero-rain-runs': {
		long: 'A zero is a reading, so a gap in the rain record exported as zeros stops CHIRPS filling it, and the catchment runs dry for weeks in its wettest months. The Data tab flags these runs: 60 or more zero days in the series\' six wettest months. By default a run treats the days of every flagged run as blank, so bias-corrected CHIRPS, then forecast rain, stand in, exactly as on any blank day. The rain series you uploaded is never changed.\n\nIf the hydrologist confirms a flagged run was a real dry spell, add it under **Keep dry**: its days stay 0 mm, and they count in the CHIRPS factor fit as readings (a flagged run that is filled is left out of the fit day by day). If bias-corrected CHIRPS reads more than the larger of 50 mm and a quarter of the catchment\'s usual annual rain over a kept-dry run, the keep-dry looks doubtful: each run warns and leaves that water year out of the fit. **Run as recorded** keeps every flagged run dry, as the workbook does. **Also treat as missing** covers other bad periods whatever they read, such as the gap days inside a year that reads far below CHIRPS. Those days are also left out of the CHIRPS factor fit.\n\nEach run lists every period it filled, the rain that replaced it and any days with nothing to fill them, in its warnings and in the summary CSV. The daily column "Catchment rain treated as missing" is 1 on each day filled. Comparing runs lists any change to these settings. Not in the workbook (docs/engine-audit.md B2).',
		aliases: ['missing rainfall', 'zero rain', 'rain gaps', 'keep dry', 'infilled rainfall days'],
		related: ['rain-catchment', 'chirps-bias', 'rain-final', 'rain-accumulations'],
		source: 'Not in the workbook; docs/model.md §2.4c; engine-audit.md B2'
	},
	'flow-gap-filling': {
		long: 'A gauge or logger record has gaps: a flood took the logger, a download was missed. Settings → Calibration record → Flow gaps can fill them, in a run only: the record you uploaded is never changed, and nothing is filled until you turn it on for a record.\n\n**Interpolation** fills a gap of up to a few days (5 by default) between the readings either side, on a log scale: a recession falls by a steady fraction a day, so a log-scale line follows it where a straight one would overstate the flow. A longer gap is never interpolated, because a flood inside it would be missed.\n\n**From another record** fills a longer gap (up to 60 days by default) from the other record on the same river (the logger for the gauge, or the reverse) or from the reference gauge on a neighbouring river, scaled by the ratio of the two records\' totals on the days both have a reading. The donor is refused when they share fewer days than the minimum (365 by default) or their daily flows don\'t rise and fall together (a correlation below 0.5). A filled day is never higher than the highest the record itself ever measured.\n\nBy default no statistic reads a filled day: the calibration scores, the fit, the EWR test on the observed record and the plausibility checks use measured days only, and the filled days are shown on the Data tab\'s chart, in the run\'s warnings, and in the daily columns "Observed flow gap fill" (1 = interpolated, 2 = from another record) and "Observed flow: filled gap days only". Each filled day is flagged infilled; to score them, set Infilled days to "Score as recorded" under the quality flags (one control for the fit and the run). A fit that scored filled days is flagged when the filling changes. Not in the workbook (docs/model.md §2.10i).',
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
		long: 'When nobody reads the rain gauge for a few days, the unread days are often entered as 0 (or left blank) and the whole total on the day it was read. The total is right; the days are wrong: a dry spell, then one day far wetter than it was. Viney & Bates (2004) found these untagged accumulations throughout long daily records.\n\nA run flags a reading as an accumulation when it is at least 20 mm, follows at least 3 days of 0 or blank catchment rain, bias-corrected CHIRPS reads less than a quarter of it on that day and the days either side (CHIRPS can be a day early or late), and CHIRPS over the days before (leaving out the day just before) reads at least half of it. The window is those days, at most the last 92, plus the reading day. A storm after a real dry spell is left alone: CHIRPS is dry over the days before it.\n\nBy default the run keeps the recorded total and spreads it over the window in proportion to bias-corrected CHIRPS. Those days are not also filled from CHIRPS as a zero run (which would count the rain twice), and they are left out of the CHIRPS factor fit. If CHIRPS reads no rain over a window at all, its total stays on the reading day. The rain series you uploaded is never changed.\n\nIn Settings → Rain gaps and CHIRPS, **Accumulated readings** chooses between spreading (the default) and **Run as recorded (one day)**, as the workbook does. **Keep as recorded** lists readings you know were one day\'s rain (a thunderstorm CHIRPS missed): a detection whose reading day falls in one stays as recorded, and counts in the CHIRPS fit. **Also spread** lists windows by hand, ending on the reading day. A period listed as missing, or a keep-dry period, wins over a detection. Each run lists every window in its warnings and its summary CSV, and the daily column "Catchment rain from a multi-day accumulation" is 1 on each day spread. Comparing runs lists any change to these settings. Not in the workbook (docs/engine-audit.md B4).',
		aliases: ['accumulated rainfall', 'untagged accumulation', 'multi-day total', 'weekend rain', 'gauge not read', 'disaggregation'],
		related: ['zero-rain-runs', 'chirps-bias', 'rain-catchment', 'rain-final'],
		source: 'Not in the workbook; Viney & Bates 2004; docs/model.md §2.4d; engine-audit.md B4'
	},
	'rain-source': {
		long: 'Use a rain-source period when the catchment series stops describing the catchment for a stretch of years (a gauge moved or closed, the average was rebuilt) and another gauge covers it, such as an in-catchment automatic station. Within the period, each day\'s rain is that gauge\'s reading × its month\'s factor; the catchment series is not used there and stays out of every factor fit.\n\n**Factors.** Normally 12 fixed values (Oct … Sep, 0.25–4) with where they came from: who fitted them, over which dates, and how. Or **Fit**: the gauge is scaled to the catchment series\' level in a reference era you name, measured against a reference series that doesn\'t contain the gauge: factor = (catchment ÷ reference in the reference era) ÷ (gauge ÷ reference in the period). Use a gauge-free reanalysis such as ERA5 as the reference. CHIRPS is refused once you tick "CHIRPS ingests this gauge", because the fit would then be circular.\n\n**Gaps.** A day the gauge has no reading takes CHIRPS × the CHIRPS factors by default, or a named reanalysis × factors fitted on the catchment series over its own era; then forecast rain. With "CHIRPS ingests this gauge" ticked, name a reanalysis fallback.\n\n**Daily intensity.** A factor fixes the monthly volume, not how the rain falls: one automatic gauge has more intense days than an average of several gauges, and GR4J turns heavier days into more flow. Every run reports the share of the period\'s rain on heavy days (20 mm or more) against the catchment series\' share in a reference era, and warns when they are more than 5 points apart. Tick "Quantile-map its wet days" to map the gauge\'s wet days (at or above the wet-day threshold, 1 mm by default) onto the catchment series\' wet days over the water years you name, month by month (a month with fewer than 30 wet days on either side uses its three-month season; a season still that thin keeps the factor alone). Each month\'s total stays exactly what the factor gives, so the map changes the spread of the falls, not the volume, and not how many days are wet.\n\nEach run warns once per period with the day counts and factors, adds a daily "Rain source" column (0 catchment, 1 alternative gauge, 2 CHIRPS, 3 reanalysis, 4 forecast) and a block in its summary CSV, and comparing runs sets the periods side by side. A saved calibration is flagged "forcing changed since fit" when the periods change. Not in the workbook (docs/model.md §2.4e, issue #40).',
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
		long: 'ERA5\'s precipitation is a model forecast that assimilates no rain gauges outside the United States, so a local gauge change can\'t enter it: a good yardstick for scaling a replacement gauge to the catchment record\'s level. The model reads it only when a rain-source period names it. Free without an account from the Open-Meteo archive API (docs/calibration-research.md § Rain forcing).',
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
	}
};
